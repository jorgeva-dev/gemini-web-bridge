/**
 * content/work_panel.js
 * Panel flotante en la PESTAÑA DE TRABAJO (no en la de Gemini).
 *
 * El flujo real es: numeras, mandas la captura, Gemini contesta "pulsa el 7",
 * vuelves aquí y ejecutas. A partir de ese momento los números estorban, y
 * quitarlos obligaba a abrir el widget o recordar un atajo. Este panel deja esa
 * acción a un clic, y de paso recuerda con qué conversación estás enlazado.
 *
 * Translúcido en reposo para no molestar mientras trabajas; opaco al pasar por
 * encima.
 */
(function () {
  const PANEL_ID = 'gwb-work-panel';
  const LAYER_ID = 'gwb-badge-layer';

  // Relevo por generación, igual que el puente: al recargar la extensión el
  // panel viejo se queda huérfano y hay que apartarlo.
  const myGeneration = (window.__gwbPanelGeneration || 0) + 1;
  window.__gwbPanelGeneration = myGeneration;

  const anterior = document.getElementById(PANEL_ID);
  if (anterior) anterior.remove();

  let geminiTitle = '';
  let standDown = false;

  const isCurrent = () => window.__gwbPanelGeneration === myGeneration;
  const badgesOn = () => Boolean(document.getElementById(LAYER_ID));

  function build() {
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed',
      'bottom:14px',
      'right:14px',
      'z-index:2147483000',
      'display:flex',
      'align-items:center',
      'gap:8px',
      'padding:6px 10px',
      'background:rgba(17,24,39,.82)',
      'color:#cbd5e1',
      'font:500 11.5px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif',
      'border:1px solid rgba(255,255,255,.10)',
      'border-radius:10px',
      'box-shadow:0 4px 16px rgba(0,0,0,.3)',
      'backdrop-filter:blur(8px)',
      'user-select:none',
      'opacity:.55',
      'transition:opacity .15s ease'
    ].join(';');

    panel.addEventListener('mouseenter', () => { panel.style.opacity = '1'; });
    panel.addEventListener('mouseleave', () => { panel.style.opacity = '.55'; });

    const label = document.createElement('span');
    label.id = 'gwb-work-label';
    label.style.cssText = 'max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    const btn = document.createElement('button');
    btn.id = 'gwb-work-toggle';
    btn.type = 'button';
    btn.style.cssText = [
      'all:unset',
      'cursor:pointer',
      'padding:3px 9px',
      'border-radius:6px',
      'font:600 11px/1.4 ui-sans-serif,system-ui,sans-serif'
    ].join(';');
    btn.addEventListener('click', onToggle);

    panel.appendChild(label);
    panel.appendChild(btn);
    document.body.appendChild(panel);
    return panel;
  }

  function ensurePanel() {
    return document.getElementById(PANEL_ID) || build();
  }

  function render() {
    if (standDown || !isCurrent()) return;
    const panel = ensurePanel();

    panel.querySelector('#gwb-work-label').textContent = geminiTitle
      ? `🔗 ${geminiTitle}`
      : '🔗 Gemini Bridge';
    panel.querySelector('#gwb-work-label').title = geminiTitle
      ? `Enlazado a la conversación "${geminiTitle}"`
      : 'Pestaña enlazada con una conversación de Gemini';

    const btn = panel.querySelector('#gwb-work-toggle');
    const on = badgesOn();
    btn.textContent = on ? '✕ QUITAR NÚMEROS' : '① PONER NÚMEROS';
    btn.title = on
      ? 'Quita las insignias para seguir trabajando sin estorbos'
      : 'Vuelve a numerar los elementos de la página';
    btn.style.background = on ? 'rgba(255,45,85,.16)' : 'rgba(78,140,255,.16)';
    btn.style.color = on ? '#ff7a96' : '#7dabff';
  }

  async function onToggle() {
    const btn = document.getElementById('gwb-work-toggle');
    if (btn) btn.textContent = '…';
    try {
      await chrome.runtime.sendMessage({ action: 'toggle_badges' });
    } catch (e) {
      console.warn('[Gemini Bridge] No se pudo cambiar las insignias:', e.message);
    }
    render();
  }

  // Las insignias también se ponen y quitan desde el widget y por atajo de
  // teclado, así que el botón debe reflejar la realidad de la página, no lo
  // último que se pulsó aquí.
  const observer = new MutationObserver(() => {
    if (!standDown && isCurrent()) render();
  });
  observer.observe(document.documentElement, { childList: true });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'work_panel_status') {
      geminiTitle = message.geminiTitle || '';
      render();
    }
    if (message.action === 'work_panel_remove') {
      standDown = true;
      observer.disconnect();
      const panel = document.getElementById(PANEL_ID);
      if (panel) panel.remove();
      window.__gwbPanelGeneration = (window.__gwbPanelGeneration || 0) + 1;
    }
  });

  render();
})();
