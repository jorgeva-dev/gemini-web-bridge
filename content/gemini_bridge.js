/**
 * content/gemini_bridge.js
 * Se inyecta en la pestaña de Gemini cuando hay un vínculo activo.
 *
 * Invierte la dinámica original: en vez de capturar primero y preguntar
 * después, el usuario escribe su consulta en Gemini y al pulsar Enter la
 * extensión captura sola la pestaña de trabajo vinculada, adjunta la imagen y
 * deja que el mensaje salga.
 *
 * Red de seguridad: si la captura falla o tarda más de TIMEOUT_MS, el mensaje
 * se envía igualmente sin imagen. Interceptar el envío nunca debe impedir que
 * el usuario pueda escribir a Gemini.
 */
(function () {
  if (window.__gwbBridgeLoaded) return;
  window.__gwbBridgeLoaded = true;

  const TIMEOUT_MS = 5000;
  const BAR_ID = 'gwb-bridge-bar';

  let autoEnabled = true;
  let busy = false;
  let passThrough = false;
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

  function flash(text, ms = 2500) {
    renderBar(text);
    setTimeout(() => renderBar(), ms);
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

    let dataUrl = null;
    try {
      const response = await Promise.race([
        chrome.runtime.sendMessage({ action: 'request_capture' }),
        sleep(TIMEOUT_MS).then(() => ({ timeout: true }))
      ]);

      if (response && response.timeout) {
        console.warn('[Gemini Bridge] Captura agotó el tiempo. Enviando sin imagen.');
      } else if (response && response.dataUrl) {
        dataUrl = response.dataUrl;
      } else if (response && response.error) {
        console.warn('[Gemini Bridge] Captura fallida:', response.error);
      }
    } catch (err) {
      console.warn('[Gemini Bridge] Error pidiendo la captura:', err.message);
    }

    if (dataUrl) {
      const ok = await attachImage(dataUrl);
      renderBar(ok ? '✅ Captura adjuntada' : '⚠️ Enviando sin imagen');
    } else {
      renderBar('⚠️ Enviando sin imagen');
    }

    triggerSend();
    busy = false;
    setTimeout(() => renderBar(), 2000);
  }

  document.addEventListener('keydown', (e) => {
    if (passThrough || busy || !autoEnabled) return;
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;

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
