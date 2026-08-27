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

    bar.appendChild(label);
    bar.appendChild(toggle);
    document.body.appendChild(bar);
    return bar;
  }

  function renderBar(statusText) {
    const bar = ensureBar();
    const label = bar.querySelector('#gwb-bridge-label');
    const toggle = bar.querySelector('#gwb-bridge-toggle');

    label.textContent = statusText || (workTabTitle ? `🔗 ${workTabTitle}` : '🔗 Pestaña vinculada');

    toggle.textContent = autoEnabled ? 'AUTO ON' : 'AUTO OFF';
    toggle.style.background = autoEnabled ? 'rgba(46,213,115,.18)' : 'rgba(255,255,255,.08)';
    toggle.style.color = autoEnabled ? '#2ed573' : '#9ca3af';
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

    const dt = new DataTransfer();
    dt.items.add(dataURLtoFile(dataUrl, 'captura.png'));

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
      const hasAttachment = document.querySelector(
        'img[src^="blob:"], [data-test-id*="file"], [class*="attachment"], [class*="uploader"] img'
      );
      if (hasAttachment) {
        await sleep(400); // margen para que la subida se consolide
        return true;
      }
    }
    return false;
  }

  function triggerSend() {
    const btn = findSendButton();
    if (btn) {
      btn.click();
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
    const slowNotice = setTimeout(() => {
      if (busy) renderBar('📜 Recorriendo la página completa…');
    }, 2500);

    let dataUrl = null;
    let failReason = null;

    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({ action: 'request_capture' }),
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

    clearTimeout(slowNotice);

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

  document.addEventListener('keydown', (e) => {
    if (!isCurrent()) return; // relevado por un puente más nuevo
    if (passThrough || busy || !autoEnabled) return;
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;

    // Si la extensión se ha recargado, este script ya no puede capturar nada.
    // Dejamos pasar el Enter en vez de bloquear el envío, y decimos qué hacer.
    if (!contextAlive()) {
      renderBar('♻️ Extensión recargada — pulsa F5 en esta pestaña');
      return;
    }

    // Tras un fallo de captura, el siguiente Enter envía sin interceptar: es la
    // salida del usuario para mandar el mensaje igualmente si así lo decide.
    if (skipNext) {
      skipNext = false;
      renderBar();
      return;
    }

    const composer = findComposer();
    if (!composer) return;
    if (!composer.contains(e.target) && e.target !== composer) return;

    const text = (composer.innerText || '').trim();
    if (!text) return;

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
      const bar = document.getElementById(BAR_ID);
      if (bar) bar.remove();
      window.__gwbBridgeLoaded = false;
    }
  });

  (async () => {
    try {
      const stored = await chrome.storage.session.get(['gwb_auto_enabled', 'gwb_work_tab_title']);
      autoEnabled = stored.gwb_auto_enabled !== false;
      workTabTitle = stored.gwb_work_tab_title || '';
    } catch (e) { /* valores por defecto */ }
    renderBar();
  })();
})();
