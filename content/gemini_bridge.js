/**
 * content/gemini_bridge.js
 * Se inyecta en la pestaña de Gemini cuando hay un vínculo activo.
 *
 * Su único cometido es DECIR con qué pestaña está enlazada esta conversación.
 * No intercepta el envío, no captura y no toca lo que escribes: las capturas se
 * mandan cuando tú lo pides desde el widget, nunca solas.
 *
 * Antes este script interceptaba Enter y el clic de enviar para adjuntar una
 * captura automáticamente. Se quitó a petición del usuario: adjuntar en cada
 * mensaje mandaba imágenes que a menudo no aportaban nada, y obligaba a
 * pelearse con el DOM de Gemini para enviar en su nombre. Un cartel no puede
 * romper nada.
 */
(function () {
  const BAR_ID = 'gwb-bridge-bar';

  // Al recargar la extensión, el puente ya inyectado sobrevive pero se queda
  // huérfano. Con un contador de generación, el último inyectado manda y los
  // anteriores se apartan solos.
  const myGeneration = (window.__gwbGeneration || 0) + 1;
  window.__gwbGeneration = myGeneration;
  window.__gwbBridgeLoaded = true;

  // ensureBar reutiliza la barra que encuentre, así que una construida por una
  // versión anterior se daría por buena y nunca mostraría los cambios.
  const staleBar = document.getElementById(BAR_ID);
  if (staleBar) staleBar.remove();

  let workTabTitle = '';
  let standDown = false;

  function isCurrent() {
    return window.__gwbGeneration === myGeneration;
  }

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
      'gap:7px',
      'padding:7px 12px',
      'background:rgba(17,24,39,.92)',
      'color:#cbd5e1',
      'font:500 12px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif',
      'border:1px solid rgba(255,255,255,.10)',
      'border-radius:10px',
      'box-shadow:0 4px 18px rgba(0,0,0,.35)',
      'backdrop-filter:blur(8px)',
      'user-select:none',
      'pointer-events:none'
    ].join(';');

    const marca = document.createElement('span');
    marca.textContent = '🔗 Gemini Bridge';
    marca.style.cssText = 'color:#7dabff;font-weight:600';

    const sep = document.createElement('span');
    sep.textContent = '·';
    sep.style.cssText = 'opacity:.4';

    const label = document.createElement('span');
    label.id = 'gwb-bridge-label';

    bar.appendChild(marca);
    bar.appendChild(sep);
    bar.appendChild(label);
    document.body.appendChild(bar);
    return bar;
  }

  function renderBar() {
    if (standDown || !isCurrent()) return;
    const bar = ensureBar();
    const label = bar.querySelector('#gwb-bridge-label');
    label.textContent = workTabTitle
      ? `enlazado a: ${workTabTitle}`
      : 'enlazado';
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'bridge_status') {
      workTabTitle = message.workTabTitle || '';
      renderBar();
    }

    if (message.action === 'bridge_unlink') {
      standDown = true;
      const bar = document.getElementById(BAR_ID);
      if (bar) bar.remove();
      window.__gwbBridgeLoaded = false;
      // Ceder la generación para que este script no vuelva a considerarse vigente
      window.__gwbGeneration = (window.__gwbGeneration || 0) + 1;
    }
  });

  (async () => {
    try {
      const pref = await chrome.runtime.sendMessage({ action: 'get_pair_pref' });
      if (pref && !pref.missing) workTabTitle = pref.workTitle || '';
    } catch (e) { /* la etiqueta llegará por bridge_status */ }
    renderBar();
  })();
})();
