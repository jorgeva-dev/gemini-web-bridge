/**
 * content/badges.js
 * Numera los elementos interactivos de la página con insignias visibles.
 *
 * Las insignias se pintan ANTES de capturar, de modo que quedan grabadas en la
 * imagen que ve Gemini. Así Gemini puede responder "pulsa el 7" en vez de
 * describir la posición con prosa, y el usuario mira el 7 directamente en su
 * pantalla porque las insignias siguen ahí después de capturar.
 *
 * La numeración se asigna en orden de documento y en una sola pasada, lo que la
 * hace válida tanto para la captura visible como para la de página completa con
 * scroll (donde una numeración por trozos repetiría números entre rebanadas).
 */
(function () {
  if (window.__gwbBadgesLoaded) return;
  window.__gwbBadgesLoaded = true;

  const CONTAINER_ID = 'gwb-badge-layer';
  const Z = 2147483600;

  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="switch"]',
    '[role="radio"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  function isVisible(el, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    if (el.getAttribute('aria-hidden') === 'true' && !el.getAttribute('role')) return false;
    return true;
  }

  function removeLayer() {
    const existing = document.getElementById(CONTAINER_ID);
    if (existing) existing.remove();
  }

  /**
   * Pinta las insignias numeradas. Devuelve cuántas ha puesto.
   * @returns {number}
   */
  let paintBadges = function paintBadges() {
    removeLayer();

    const layer = document.createElement('div');
    layer.id = CONTAINER_ID;
    layer.style.cssText = [
      'position:absolute',
      'top:0',
      'left:0',
      'width:0',
      'height:0',
      'margin:0',
      'padding:0',
      'border:0',
      'pointer-events:none',
      `z-index:${Z}`
    ].join(';');

    // Coordenadas de documento: sobreviven al scroll, imprescindible para la
    // captura de página completa.
    const scrollX = window.scrollX || window.pageXOffset || 0;
    const scrollY = window.scrollY || window.pageYOffset || 0;

    const map = {};
    let n = 0;

    for (const el of document.querySelectorAll(INTERACTIVE_SELECTOR)) {
      if (el.closest(`#${CONTAINER_ID}`)) continue;

      const rect = el.getBoundingClientRect();
      if (!isVisible(el, rect)) continue;

      n++;
      map[n] = el;
      el.setAttribute('data-gwb-id', String(n));

      const top = rect.top + scrollY;
      const left = rect.left + scrollX;

      // Contorno del elemento, para que se vea su extensión real
      const outline = document.createElement('div');
      outline.style.cssText = [
        'position:absolute',
        `top:${top}px`,
        `left:${left}px`,
        `width:${rect.width}px`,
        `height:${rect.height}px`,
        'border:1.5px solid rgba(255,45,85,.55)',
        'border-radius:3px',
        'box-sizing:border-box',
        'pointer-events:none'
      ].join(';');

      // Insignia numerada. En controles pequeños (radios, checkboxes) se coloca
      // fuera, a la izquierda: si se superpusiera taparía justo lo que hay que
      // pulsar. En el resto va montada en la esquina superior izquierda.
      const isSmall = rect.width < 26 || rect.height < 26;
      const badgeTop = isSmall ? top + (rect.height - 19) / 2 : top - 9;
      const badgeLeft = isSmall ? left - 25 : left - 6;

      const badge = document.createElement('div');
      badge.textContent = String(n);
      badge.style.cssText = [
        'position:absolute',
        `top:${Math.max(0, badgeTop)}px`,
        `left:${Math.max(0, badgeLeft)}px`,
        'min-width:19px',
        'height:19px',
        'padding:0 4px',
        'background:#FF2D55',
        'color:#fff',
        'font:700 12px/19px ui-sans-serif,system-ui,-apple-system,sans-serif',
        'text-align:center',
        'border-radius:4px',
        'box-shadow:0 1px 3px rgba(0,0,0,.45)',
        'pointer-events:none',
        'white-space:nowrap'
      ].join(';');

      layer.appendChild(outline);
      layer.appendChild(badge);
    }

    document.documentElement.appendChild(layer);
    window.__gwbBadgeMap = map;
    return n;
  };

  /**
   * Quita las insignias y los atributos que dejaron.
   */
  function clearBadges() {
    removeLayer();
    document.querySelectorAll('[data-gwb-id]').forEach((el) => el.removeAttribute('data-gwb-id'));
    window.__gwbBadgeMap = null;
  }

  // -------------------------------------------------------- realineado automático

  // Un temporizador fijo (cada 2s) repintaría constantemente aunque no cambie
  // nada, y cada repintado pide getBoundingClientRect de todos los elementos, lo
  // que fuerza recálculo de layout. En una página pesada se nota. Observar los
  // cambios reales es casi gratis cuando la página está quieta y reacciona al
  // instante cuando despliegas un menú o se carga contenido.
  const REALIGN_DEBOUNCE_MS = 400;

  let mutationObserver = null;
  let resizeObserver = null;
  let realignTimer = null;

  function scheduleRealign() {
    clearTimeout(realignTimer);
    realignTimer = setTimeout(() => {
      if (!document.getElementById(CONTAINER_ID)) return; // las han quitado
      paintBadges();
    }, REALIGN_DEBOUNCE_MS);
  }

  function startAutoRealign() {
    stopAutoRealign();

    mutationObserver = new MutationObserver((records) => {
      // Ignorar lo que provocamos nosotros al pintar, o sería un bucle infinito
      for (const r of records) {
        const t = r.target;
        if (t && t.nodeType === 1 && t.closest && t.closest(`#${CONTAINER_ID}`)) continue;
        scheduleRealign();
        return;
      }
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style', 'class', 'hidden', 'open']
    });

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(scheduleRealign);
      resizeObserver.observe(document.documentElement);
    }

    window.addEventListener('resize', scheduleRealign, { passive: true });
  }

  function stopAutoRealign() {
    clearTimeout(realignTimer);
    if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
    if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
    window.removeEventListener('resize', scheduleRealign);
  }

  // Envolver el pintado para que el observador no se oiga a sí mismo
  const rawPaint = paintBadges;
  paintBadges = function () {
    if (mutationObserver) mutationObserver.disconnect();
    const n = rawPaint();
    if (mutationObserver) {
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden', 'open']
      });
    }
    return n;
  };

  window.__gwbPaintBadges = function () {
    const n = paintBadges();
    startAutoRealign();
    return n;
  };

  window.__gwbClearBadges = function () {
    stopAutoRealign();
    clearBadges();
  };
})();
