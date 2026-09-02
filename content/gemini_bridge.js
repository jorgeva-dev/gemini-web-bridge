/**
 * content/gemini_bridge.js
 * Se inyecta en la pestaña de Gemini cuando hay un vínculo activo.
 *
 * Invierte la dinámica original: en vez de capturar primero y preguntar
 * después, el usuario escribe su consulta en Gemini y al pulsar Enter la
 * extensión captura sola la pestaña de trabajo vinculada, adjunta la imagen y
 * deja que el mensaje salga.
 *
 * Si la captura falla, el mensaje NO se envía: enviarlo sin imagen dejaba a
 * Gemini contestando a ciegas sobre una pantalla que nunca vio, y el usuario no
 * se enteraba. En su lugar se avisa en la píldora y el siguiente Enter envía sin
 * interceptar. Interceptar el envío nunca debe impedir que el usuario pueda
 * escribir a Gemini: de ahí esa salida, el interruptor AUTO OFF y el Escape.
 */
(function () {
  // Al recargar la extensión, el puente ya inyectado en la página sobrevive
  // pero se queda huérfano: su contexto muere y toda llamada a chrome.* lanza
  // "Extension context invalidated". Una guarda booleana impedía además que un
  // puente nuevo relevara al viejo. Con un contador de generación, el último
  // inyectado manda y los anteriores se apartan solos.
  const myGeneration = (window.__gwbGeneration || 0) + 1;
  window.__gwbGeneration = myGeneration;
  window.__gwbBridgeLoaded = true;

  // Al relevar a un puente anterior hay que tirar su píldora: ensureBar reutiliza
  // la que encuentre, así que una barra construida por una versión vieja se daba
  // por buena y nunca llegaba a mostrar los controles añadidos después.
  const staleBar = document.getElementById('gwb-bridge-bar');
  if (staleBar) staleBar.remove();

  /** ¿Sigue vivo el contexto de la extensión que inyectó ESTE script? */
  function contextAlive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  /** ¿Sigue siendo este el puente vigente de la página? */
  function isCurrent() {
    return window.__gwbGeneration === myGeneration;
  }

  // La captura de página completa recorre la página en trozos y Chrome limita
  // captureVisibleTab a unas dos llamadas por segundo, así que una página larga
  // se va a 10-20 segundos con facilidad. Este tope es una red para cuelgues
  // reales, no un plazo normal de trabajo.
  const TIMEOUT_MS = 90000;
  const BAR_ID = 'gwb-bridge-bar';

  let autoEnabled = true;
  let busy = false;
  let passThrough = false;
  let skipNext = false;
  let workTabTitle = '';
  let captureMode = 'visible'; // 'visible' | 'full'
  let primed = false;

  // Al desvincular no basta con borrar la píldora: los interceptores de teclado
  // y ratón siguen registrados, vuelven a disparar, la captura falla porque ya
  // no hay vínculo y renderBar reconstruye la barra. El resultado es una Gemini
  // con un panel zombi quejándose. Esta bandera retira el puente del todo.
  let standDown = false;

  // En el flujo automático el usuario escribe su propia pregunta, así que Gemini
  // no recibía ninguna explicación de qué son las insignias ni cómo referirse a
  // ellas: de ahí que respondiera narrando el nombre del archivo. Se le explica
  // una sola vez por conversación, para no ensuciar todos los mensajes.
  const PRIMER = '\n\n[Contexto para ti: la imagen adjunta es una captura de mi pantalla. Sus elementos interactivos (campos, botones, enlaces) llevan una insignia roja numerada. Cuando me digas dónde pulsar o qué rellenar, cita SIEMPRE ese número, nunca la posición ("arriba a la derecha") ni el nombre del archivo adjunto, que no debes mencionar. Mantén esta pauta durante toda la conversación.]';

  // ---------------------------------------------------------------- utilidades

  const COMPOSER_SELECTORS = [
    'div.ql-editor[contenteditable="true"]',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ];

  function findComposer() {
    for (const sel of COMPOSER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) return el;
    }
    return null;
  }

  function findSendButton() {
    const candidates = [
      'button[aria-label*="Enviar" i]',
      'button[aria-label*="Send" i]',
      'button.send-button',
      'button[mattooltip*="Enviar" i]',
      'button[mattooltip*="Send" i]'
    ];
    for (const sel of candidates) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled && btn.offsetParent !== null) return btn;
    }
    return null;
  }

  /**
   * Acota la búsqueda de adjuntos a la caja de escritura. Buscar en todo el
   * documento contaba como adjunto cualquier imagen del historial de la
   * conversación, lo que hacía creer que la subida había terminado antes de
   * empezar.
   * @returns {Element|null}
   */
  function findComposerScope() {
    const composer = findComposer();
    if (!composer) return null;
    return composer.closest('form') ||
           composer.closest('[class*="input-area"], [class*="composer"], [class*="bottom-container"]') ||
           composer.parentElement?.parentElement?.parentElement ||
           composer;
  }

  /**
   * ¿Hay ya un adjunto puesto a la espera de enviarse?
   * @returns {boolean}
   */
  function hasPendingAttachment() {
    const scope = findComposerScope();
    if (!scope) return false;
    return Boolean(scope.querySelector(
      'img[src^="blob:"], [data-test-id*="file"], [class*="attachment"], [class*="uploader"] img'
    ));
  }

  function dataURLtoFile(dataUrlString, filename = 'screenshot.png') {
    const parts = dataUrlString.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) u8arr[n] = bstr.charCodeAt(n);
    return new File([u8arr], filename, { type: mime });
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // ------------------------------------------------------------- barra de estado

  function ensureBar() {
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;

    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText = [
      'position:fixed',
      'bottom:14px',
      'right:14px',
      'z-index:2147483000',
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:8px 12px',
      'background:rgba(17,24,39,.94)',
      'color:#e5e7eb',
      'font:500 12px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif',
      'border:1px solid rgba(255,255,255,.12)',
      'border-radius:10px',
      'box-shadow:0 6px 24px rgba(0,0,0,.4)',
      'backdrop-filter:blur(8px)',
      'user-select:none'
    ].join(';');

    const label = document.createElement('span');
    label.id = 'gwb-bridge-label';

    const toggle = document.createElement('button');
    toggle.id = 'gwb-bridge-toggle';
    toggle.type = 'button';
    toggle.style.cssText = [
      'all:unset',
      'cursor:pointer',
      'padding:3px 9px',
      'border-radius:6px',
      'font:600 11px/1.4 ui-sans-serif,system-ui,sans-serif'
    ].join(';');
    toggle.addEventListener('click', () => {
      autoEnabled = !autoEnabled;
      chrome.storage.session.set({ gwb_auto_enabled: autoEnabled }).catch(() => {});
      renderBar();
    });

    // Selector de alcance de la captura. La mayoría de las consultas se
    // responden con lo que hay en pantalla, que además es instantáneo; la
    // página entera sólo hace falta cuando Gemini pide ver más.
    const modeBtn = document.createElement('button');
    modeBtn.id = 'gwb-bridge-mode';
    modeBtn.type = 'button';
    modeBtn.style.cssText = [
      'all:unset',
      'cursor:pointer',
      'padding:3px 9px',
      'border-radius:6px',
      'background:rgba(255,255,255,.08)',
      'color:#cbd5e1',
      'font:600 11px/1.4 ui-sans-serif,system-ui,sans-serif'
    ].join(';');
    modeBtn.addEventListener('click', () => {
      captureMode = captureMode === 'visible' ? 'full' : 'visible';
      chrome.storage.session.set({ gwb_capture_mode: captureMode }).catch(() => {});
      renderBar();
    });

    const copyBtn = document.createElement('button');
    copyBtn.id = 'gwb-bridge-copy';
    copyBtn.type = 'button';
    copyBtn.textContent = '⧉ COPIAR';
    copyBtn.title = 'Copia toda la conversación al portapapeles, en texto con los turnos marcados.';
    copyBtn.style.cssText = [
      'all:unset',
      'cursor:pointer',
      'padding:3px 9px',
      'border-radius:6px',
      'background:rgba(255,255,255,.08)',
      'color:#cbd5e1',
      'font:600 11px/1.4 ui-sans-serif,system-ui,sans-serif'
    ].join(';');
    copyBtn.addEventListener('click', copyTranscript);

    bar.appendChild(label);
    bar.appendChild(modeBtn);
    bar.appendChild(copyBtn);
    bar.appendChild(toggle);
    document.body.appendChild(bar);
    return bar;
  }

  function renderBar(statusText) {
    if (standDown || !isCurrent()) return;
    const bar = ensureBar();
    const label = bar.querySelector('#gwb-bridge-label');
    const toggle = bar.querySelector('#gwb-bridge-toggle');

    label.textContent = statusText || (workTabTitle ? `🔗 ${workTabTitle}` : '🔗 Pestaña vinculada');
    label.title = workTabTitle
      ? `Vinculado a "${workTabTitle}". Sus capturas se adjuntan a esta conversación.`
      : 'Pestaña de trabajo vinculada a esta conversación.';

    const modeBtn = bar.querySelector('#gwb-bridge-mode');
    if (modeBtn) {
      const esCompleta = captureMode === 'full';
      modeBtn.textContent = esCompleta ? '📜 PÁGINA' : '🖥 VISIBLE';
      modeBtn.title = esCompleta
        ? 'Envía la página entera haciendo scroll. Más contexto, tarda unos segundos. Pulsa para cambiar.'
        : 'Envía sólo lo que se ve. Instantáneo. Pulsa para cambiar.';
      modeBtn.style.background = esCompleta ? 'rgba(78,140,255,.18)' : 'rgba(255,255,255,.08)';
      modeBtn.style.color = esCompleta ? '#7dabff' : '#cbd5e1';
    }

    // "AUTO ON/OFF" decía el estado pero no qué controlaba ni qué pasaba al
    // pulsarlo, y no se entendía que aquí se pausan las capturas sin romper el
    // vínculo. El nombre y el tooltip ahora lo dicen.
    toggle.textContent = autoEnabled ? '📷 ENVIANDO' : '⏸ EN PAUSA';
    toggle.title = autoEnabled
      ? 'Cada mensaje adjunta una captura. Pulsa para PAUSAR y seguir conversando sin enviar imágenes, sin perder el vínculo.'
      : 'Capturas en pausa: tus mensajes salen sin imagen. Pulsa para volver a adjuntarlas.';
    toggle.style.background = autoEnabled ? 'rgba(46,213,115,.18)' : 'rgba(250,204,21,.18)';
    toggle.style.color = autoEnabled ? '#2ed573' : '#facc15';

    // Con las capturas en pausa, el selector de alcance no pinta nada
    if (modeBtn) modeBtn.style.opacity = autoEnabled ? '1' : '.4';
  }

  // ------------------------------------------------------------ transcripción

  // Gemini marca cada turno con elementos propios. Como todo lo que depende de
  // su DOM, esto puede romperse si Google lo cambia; por eso hay varias vías y
  // una última de reserva por texto plano.
  const TURN_SELECTORS = 'user-query, model-response';

  /**
   * Extrae la conversación visible como texto plano con los turnos marcados.
   * @returns {string}
   */
  function extractTranscript() {
    const turns = Array.from(document.querySelectorAll(TURN_SELECTORS));

    if (turns.length > 0) {
      const partes = turns.map((el) => {
        const esUsuario = el.tagName.toLowerCase() === 'user-query';
        const texto = (el.innerText || '').trim();
        if (!texto) return null;
        return `${esUsuario ? '## Yo' : '## Gemini'}\n\n${texto}`;
      }).filter(Boolean);

      if (partes.length > 0) return partes.join('\n\n---\n\n');
    }

    // Reserva: si los elementos con nombre han cambiado, al menos devolver el
    // texto del contenedor de la conversación en vez de no dar nada.
    const contenedor = document.querySelector('main, [role="main"], .conversation-container');
    return contenedor ? (contenedor.innerText || '').trim() : '';
  }

  async function copyTranscript() {
    const texto = extractTranscript();

    if (!texto) {
      renderBar('⚠️ No se encontró la conversación');
      setTimeout(() => renderBar(), 3000);
      return;
    }

    const cabecera = workTabTitle
      ? `# Conversación con Gemini sobre "${workTabTitle}"\n\n`
      : '# Conversación con Gemini\n\n';
    const salida = cabecera + texto;

    try {
      await navigator.clipboard.writeText(salida);
    } catch (err) {
      // Sin permiso de portapapeles: vía antigua con un textarea temporal
      const ta = document.createElement('textarea');
      ta.value = salida;
      ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
      } catch (e2) {
        console.error('[Gemini Bridge] No se pudo copiar la transcripción:', e2);
        renderBar('⚠️ No se pudo copiar');
        setTimeout(() => renderBar(), 3000);
        ta.remove();
        return;
      }
      ta.remove();
    }

    const turnos = (salida.match(/^## /gm) || []).length;
    renderBar(`✅ Copiado (${turnos} turnos, ${salida.length.toLocaleString('es')} caracteres)`);
    setTimeout(() => renderBar(), 3500);
  }

  // --------------------------------------------------------------- adjuntar

  /**
   * Pega la imagen en el compositor de Gemini y espera a que quede adjuntada.
   * @param {string} dataUrl
   * @returns {Promise<boolean>}
   */
  async function attachImage(dataUrl) {
    const composer = findComposer();
    if (!composer) return false;

    composer.focus();

    // El nombre debe corresponder al tipo real: el montaje sale en JPEG y
    // llamarlo .png confundía tanto a Gemini como a quien lea la conversación.
    const esJpeg = /^data:image\/jpe?g/i.test(dataUrl);
    const dt = new DataTransfer();
    dt.items.add(dataURLtoFile(dataUrl, esJpeg ? 'pantalla.jpg' : 'pantalla.png'));

    composer.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clipboardData: dt
    }));

    // Gemini sube la imagen de forma asíncrona. Enviar antes de que termine
    // mandaría el mensaje sin adjunto, así que esperamos a ver rastro del
    // fichero, con tope de tiempo.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await sleep(200);
      if (hasPendingAttachment()) {
        await sleep(400); // margen para que la subida se consolide
        return true;
      }
    }
    return false;
  }

  function triggerSend() {
    const btn = findSendButton();
    if (btn) {
      passThrough = true;
      btn.click();
      passThrough = false;
      return true;
    }
    // Reserva: Enter sintético, dejándolo pasar por nuestro propio interceptor
    const composer = findComposer();
    if (!composer) return false;
    passThrough = true;
    composer.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    }));
    passThrough = false;
    return true;
  }

  // ------------------------------------------------------------ interceptor

  async function handleIntercept() {
    busy = true;
    renderBar('📸 Capturando la pestaña…');

    // La primera captura sobre una URL recorre la página entera y tarda. Sin
    // este aviso parece que la extensión se ha colgado.
    const slowNotice = captureMode === 'full'
      ? setTimeout(() => { if (busy) renderBar('📜 Recorriendo la página completa…'); }, 2000)
      : null;

    let dataUrl = null;
    let failReason = null;

    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({ action: 'request_capture', mode: captureMode }),
        sleep(TIMEOUT_MS).then(() => ({ timeout: true }))
      ]);

      if (response && response.timeout) {
        failReason = 'la captura tardó demasiado';
      } else if (response && response.dataUrl) {
        dataUrl = response.dataUrl;
      } else if (response && response.error) {
        failReason = response.error;
      } else {
        failReason = 'respuesta vacía del servicio de captura';
      }
    } catch (err) {
      failReason = err.message;
    }

    if (slowNotice) clearTimeout(slowNotice);

    // Si no hay imagen NO enviamos. Mandar el mensaje igualmente dejaba a Gemini
    // contestando a ciegas sobre una pantalla que nunca vio, y el usuario no se
    // enteraba de que había fallado nada.
    if (!dataUrl) {
      console.warn('[Gemini Bridge] Captura fallida:', failReason);
      if (/context invalidated/i.test(failReason || '')) {
        renderBar('♻️ La extensión se recargó — pulsa F5 en esta pestaña');
        skipNext = true;
        busy = false;
        return;
      }
      renderBar(`⚠️ Sin captura (${failReason}). Enter otra vez para enviar igual`);
      skipNext = true;
      busy = false;
      return;
    }

    if (!primed) {
      const composer = findComposer();
      if (composer) {
        composer.focus();
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('insertText', false, PRIMER);
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      }
      primed = true;
      chrome.storage.session.set({ gwb_primed: true }).catch(() => {});
    }

    renderBar('📎 Adjuntando…');
    const attached = await attachImage(dataUrl);

    if (!attached) {
      // El pegado puede haber funcionado aunque no hayamos sabido detectarlo;
      // damos un margen extra antes de enviar.
      console.warn('[Gemini Bridge] No se detectó el adjunto. Enviando tras margen extra.');
      renderBar('⏳ Esperando a que suba…');
      await sleep(1500);
    }

    renderBar('✅ Captura adjuntada');
    triggerSend();
    busy = false;
    setTimeout(() => renderBar(), 2000);
  }

  // Escape aborta una captura en curso: sin esto, una captura lenta o colgada
  // bloquea el envío hasta agotar TIMEOUT_MS sin que el usuario pueda hacer nada.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && busy) {
      busy = false;
      skipNext = true;
      renderBar('✋ Captura cancelada. Enter para enviar sin imagen');
      setTimeout(() => renderBar(), 3000);
    }
  }, true);

  /**
   * ¿Debe este puente interceptar el envío que se está produciendo?
   * Centralizado porque hay dos formas de enviar —Enter y clic en la flecha— y
   * tener la decisión duplicada es cómo se coló el agujero del ratón.
   * @returns {boolean}
   */
  function shouldIntercept() {
    if (standDown) return false; // desvinculado: Gemini vuelve a ser Gemini
    if (!isCurrent()) return false; // relevado por un puente más nuevo
    if (passThrough || busy || !autoEnabled) return false;

    // Si la extensión se ha recargado, este script ya no puede capturar nada.
    // Dejamos salir el mensaje en vez de bloquearlo, y decimos qué hacer.
    if (!contextAlive()) {
      renderBar('♻️ Extensión recargada — pulsa F5 en esta pestaña');
      return false;
    }

    // Tras un fallo de captura, el siguiente envío va sin interceptar: es la
    // salida del usuario para mandar el mensaje igualmente si así lo decide.
    if (skipNext) {
      skipNext = false;
      renderBar();
      return false;
    }

    const composer = findComposer();
    if (!composer) return false;
    if (!(composer.innerText || '').trim()) return false;

    // Si ya hay una imagen puesta —por ejemplo la que acabas de mandar a mano
    // desde el widget— no se añade otra. Antes acababan dos capturas idénticas
    // en la misma pregunta.
    if (hasPendingAttachment()) {
      renderBar('📎 Ya hay una captura adjunta — no añado otra');
      setTimeout(() => renderBar(), 2500);
      return false;
    }

    return true;
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;

    const composer = findComposer();
    if (!composer) return;
    if (!composer.contains(e.target) && e.target !== composer) return;

    if (!shouldIntercept()) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    handleIntercept();
  }, true);

  // Enviar con el ratón es tan válido como con el teclado. Sin esto, pulsar la
  // flecha azul mandaba el mensaje sin captura y sin decir nada: de ahí la
  // sensación de que a veces adjuntaba y a veces no.
  document.addEventListener('click', (e) => {
    const btn = findSendButton();
    if (!btn) return;
    if (e.target !== btn && !btn.contains(e.target)) return;

    if (!shouldIntercept()) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    handleIntercept();
  }, true);

  // ------------------------------------------------------------------ arranque

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'bridge_status') {
      workTabTitle = message.workTabTitle || '';
      renderBar();
    }
    if (message.action === 'bridge_unlink') {
      standDown = true;
      busy = false;
      const bar = document.getElementById(BAR_ID);
      if (bar) bar.remove();
      window.__gwbBridgeLoaded = false;
      // Ceder la generación para que este script no vuelva a considerarse
      // vigente ni aunque algo lo llame más tarde.
      window.__gwbGeneration = (window.__gwbGeneration || 0) + 1;
      console.log('[Gemini Bridge] Desvinculado: puente retirado de esta pestaña.');
    }
  });

  (async () => {
    try {
      const stored = await chrome.storage.session.get(['gwb_auto_enabled', 'gwb_work_tab_title', 'gwb_capture_mode', 'gwb_primed']);
      autoEnabled = stored.gwb_auto_enabled !== false;
      workTabTitle = stored.gwb_work_tab_title || '';
      captureMode = stored.gwb_capture_mode === 'full' ? 'full' : 'visible';
      primed = stored.gwb_primed === true;
    } catch (e) { /* valores por defecto */ }
    renderBar();
  })();
})();
