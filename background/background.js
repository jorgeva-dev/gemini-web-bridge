/**
 * Service Worker: background.js
 * Orquestador principal de capturas de pantalla y puente con Gemini
 */

// Listener para mensajes desde popup y content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'capture_full') {
    handleFullCapture();
    sendResponse({ status: 'ok' });
  } else if (message.action === 'capture_scroll') {
    handleScrollCapture();
    sendResponse({ status: 'ok' });
  } else if (message.action === 'capture_crop') {
    handleCropCapture();
    sendResponse({ status: 'ok' });
  } else if (message.action === 'capture_visible_for_crop') {
    // Tomar captura para que el content script la recorte en canvas
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    captureVisibleThrottled(windowId, { format: 'png' })
      .then((dataUrl) => sendResponse({ dataUrl }))
      .catch((err) => {
        console.error('Error al capturar pestaña para recorte:', err);
        sendResponse({ dataUrl: null, error: err.message });
      });
    return true; // Respuesta asíncrona
  } else if (message.action === 'crop_completed') {
    if (message.dataUrl) {
      sendToGemini(message.dataUrl, sender.tab);
    }
    sendResponse({ status: 'ok' });
  } else if (message.action === 'clear_badges') {
    clearBadgesInActiveTab();
    sendResponse({ status: 'ok' });
  } else if (message.action === 'repaint_badges') {
    repaintBadgesInActiveTab()
      .then((count) => sendResponse({ count }))
      .catch(() => sendResponse({ count: 0 }));
    return true;
  } else if (message.action === 'link_tabs') {
    linkTabs({ mode: message.mode, geminiTabId: message.geminiTabId })
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  } else if (message.action === 'list_gemini_tabs') {
    listGeminiTabs()
      .then((tabs) => sendResponse({ tabs }))
      .catch(() => sendResponse({ tabs: [] }));
    return true;
  } else if (message.action === 'unlink_tabs') {
    unlinkTabs()
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  } else if (message.action === 'get_link_status') {
    getLinkStatus()
      .then((res) => sendResponse(res))
      .catch(() => sendResponse({ linked: false }));
    return true;
  } else if (message.action === 'request_capture') {
    captureLinkedWorkTab()
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});

// ===========================================================================
// LÍMITE DE CAPTURA DE CHROME
// ===========================================================================

// chrome.tabs.captureVisibleTab está limitada a unas 2 llamadas por segundo
// (MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND). El bucle de la captura con scroll
// pedía una por sección con sólo 200 ms de separación, se pasaba de cuota y
// Chrome abortaba la captura entera. En páginas cortas no se notaba porque hay
// pocas secciones; en páginas largas fallaba siempre.
const MIN_CAPTURE_INTERVAL_MS = 600;
let lastCaptureAt = 0;

/**
 * Captura la pestaña visible respetando la cuota, y reintentando si aun así
 * Chrome se queja.
 * @param {number} windowId
 * @param {object} options
 * @returns {Promise<string>} dataURL
 */
async function captureVisibleThrottled(windowId, options = { format: 'png' }) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const waitFor = MIN_CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
    if (waitFor > 0) await new Promise((r) => setTimeout(r, waitFor));

    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, options);
      lastCaptureAt = Date.now();
      return dataUrl;
    } catch (err) {
      lastCaptureAt = Date.now();
      const esCuota = /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(err.message || '');
      if (!esCuota || attempt === 3) throw err;
      console.warn(`[Gemini Bridge] Cuota de captura alcanzada. Reintento ${attempt + 1}/3.`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('No se pudo capturar tras varios reintentos por cuota.');
}

// ===========================================================================
// VÍNCULO ENTRE LA PESTAÑA DE TRABAJO Y LA DE GEMINI
// ===========================================================================

const GEMINI_URL = 'https://gemini.google.com/app';

// Por defecto chrome.storage.session sólo es legible desde contextos de
// confianza, así que el puente inyectado en la página no podía guardar el
// estado del interruptor AUTO: fallaba en silencio y volvía a ON en cada carga.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch((err) => console.warn('[Gemini Bridge] No se pudo abrir storage.session al puente:', err.message));

/**
 * Devuelve las pestañas de Gemini abiertas, para que el usuario elija con cuál
 * vincularse en vez de que la extensión decida por él.
 * @returns {Promise<Array<{id:number, title:string, active:boolean}>>}
 */
async function listGeminiTabs() {
  const tabs = await chrome.tabs.query({ url: '*://gemini.google.com/*' });
  return tabs.map((t) => ({
    id: t.id,
    title: t.title || 'Gemini',
    active: Boolean(t.active)
  }));
}

/**
 * Vincula la pestaña activa (trabajo) con una pestaña de Gemini.
 * @param {{mode?: 'new'|'existing', geminiTabId?: number|null}} opciones
 *   mode 'new' abre una conversación nueva; 'existing' se engancha a la
 *   pestaña que indique geminiTabId. Sustituye a la heurística anterior de "la
 *   pestaña de al lado", que dependía del orden en que estuvieran colocadas.
 */
async function linkTabs({ mode = 'new', geminiTabId = null } = {}) {
  const [workTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!workTab || !workTab.id) return { ok: false, error: 'No hay pestaña activa.' };

  if (workTab.url && /^(chrome|edge|brave|about):/.test(workTab.url)) {
    return { ok: false, error: 'No se puede vincular una página interna del navegador.' };
  }

  if (workTab.url && workTab.url.includes('gemini.google.com')) {
    return { ok: false, error: 'Vincula la pestaña de trabajo, no la de Gemini.' };
  }

  // La pestaña de Gemini la elige el usuario de forma explícita. Reutilizar en
  // silencio una conversación ya abierta secuestraba un chat en curso sin que
  // se notara nada.
  let geminiTab = null;

  if (mode === 'existing') {
    if (!geminiTabId) return { ok: false, error: 'No se indicó qué pestaña de Gemini usar.' };
    try {
      geminiTab = await chrome.tabs.get(geminiTabId);
    } catch (e) {
      return { ok: false, error: 'Esa pestaña de Gemini ya no existe.' };
    }
    if (!geminiTab.url || !geminiTab.url.includes('gemini.google.com')) {
      return { ok: false, error: 'Esa pestaña ya no es de Gemini.' };
    }
  } else {
    geminiTab = await chrome.tabs.create({
      url: GEMINI_URL,
      index: workTab.index + 1,
      windowId: workTab.windowId,
      active: false
    });
    // Esperar a que cargue antes de inyectar el puente
    await waitForTabComplete(geminiTab.id, 15000);
  }

  await chrome.storage.session.set({
    gwb_work_tab_id: workTab.id,
    gwb_gemini_tab_id: geminiTab.id,
    gwb_work_tab_title: workTab.title || 'pestaña de trabajo',
    gwb_gemini_tab_title: geminiTab.title || 'Gemini',
    gwb_last_error: null,
    gwb_last_captured_url: null,
    gwb_auto_enabled: true
  });

  await injectBridge(geminiTab.id, workTab.title || '');

  // Llevar al usuario a Gemini: es donde va a escribir, y además hace visible
  // qué pestaña ha quedado vinculada. Crearla en segundo plano daba la
  // sensación de que el botón no había hecho nada.
  await chrome.tabs.update(geminiTab.id, { active: true });
  await chrome.windows.update(geminiTab.windowId, { focused: true }).catch(() => {});

  return {
    ok: true,
    workTitle: workTab.title || '',
    geminiTabId: geminiTab.id
  };
}

async function waitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') return true;
    } catch (e) {
      return false;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function injectBridge(geminiTabId, workTabTitle) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: geminiTabId },
      files: ['content/gemini_bridge.js']
    });
    await chrome.tabs.sendMessage(geminiTabId, {
      action: 'bridge_status',
      workTabTitle
    }).catch(() => {});
  } catch (err) {
    console.warn('[Gemini Bridge] No se pudo inyectar el puente:', err.message);
  }
}

// Si la pestaña de Gemini se recarga, el puente inyectado desaparece con ella.
// Hay que volver a ponerlo o el envío automático deja de funcionar en silencio.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const s = await chrome.storage.session.get(['gwb_gemini_tab_id', 'gwb_work_tab_title']);
  if (s.gwb_gemini_tab_id === tabId) {
    await injectBridge(tabId, s.gwb_work_tab_title || '');
  }
});

// Si se cierra cualquiera de las dos pestañas, el vínculo deja de tener sentido.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await chrome.storage.session.get(['gwb_work_tab_id', 'gwb_gemini_tab_id']);
  if (s.gwb_work_tab_id === tabId || s.gwb_gemini_tab_id === tabId) {
    await unlinkTabs();
  }
});

async function unlinkTabs() {
  const { gwb_gemini_tab_id } = await chrome.storage.session.get(['gwb_gemini_tab_id']);
  if (gwb_gemini_tab_id) {
    chrome.tabs.sendMessage(gwb_gemini_tab_id, { action: 'bridge_unlink' }).catch(() => {});
  }
  await chrome.storage.session.remove([
    'gwb_work_tab_id',
    'gwb_gemini_tab_id',
    'gwb_work_tab_title',
    'gwb_last_captured_url'
  ]);
}

async function getLinkStatus() {
  const s = await chrome.storage.session.get([
    'gwb_work_tab_id', 'gwb_gemini_tab_id', 'gwb_work_tab_title', 'gwb_last_error'
  ]);
  if (!s.gwb_work_tab_id || !s.gwb_gemini_tab_id) return { linked: false };

  // Leer los títulos en vivo: si el usuario navega, el guardado se queda viejo
  let workTab, geminiTab;
  try {
    workTab = await chrome.tabs.get(s.gwb_work_tab_id);
    geminiTab = await chrome.tabs.get(s.gwb_gemini_tab_id);
  } catch (e) {
    await unlinkTabs();
    return { linked: false };
  }

  return {
    linked: true,
    workTitle: workTab.title || s.gwb_work_tab_title || 'pestaña de trabajo',
    geminiTitle: geminiTab.title || 'Gemini',
    lastError: s.gwb_last_error || null
  };
}

/**
 * Captura la pestaña de trabajo vinculada aplicando la política acordada:
 * la primera consulta sobre una URL manda la página completa con scroll, y las
 * siguientes solo lo visible, que es instantáneo. Si cambia la URL, vuelve a
 * mandarse la completa.
 * @returns {Promise<{dataUrl: string|null, mode: string, error?: string}>}
 */
async function captureLinkedWorkTab() {
  const s = await chrome.storage.session.get(['gwb_work_tab_id', 'gwb_last_captured_url']);
  if (!s.gwb_work_tab_id) return { error: 'No hay ninguna pestaña vinculada.' };

  let workTab;
  try {
    workTab = await chrome.tabs.get(s.gwb_work_tab_id);
  } catch (e) {
    await unlinkTabs();
    return { error: 'La pestaña vinculada ya no existe.' };
  }

  const urlChanged = workTab.url !== s.gwb_last_captured_url;
  const mode = urlChanged ? 'scroll' : 'visible';

  // captureVisibleTab sólo puede fotografiar la pestaña ACTIVA de la ventana.
  // Como el usuario está escribiendo en Gemini, hay que traer al frente la
  // pestaña de trabajo, capturarla y devolver el foco. De ahí el parpadeo.
  const [tabToRestore] = await chrome.tabs.query({ active: true, windowId: workTab.windowId });
  const mustSwitch = !workTab.active;

  let result = { dataUrl: null, error: null };
  try {
    if (mustSwitch) {
      try {
        await chrome.tabs.update(workTab.id, { active: true });
      } catch (err) {
        return { error: `no se pudo activar la pestaña de trabajo: ${err.message}` };
      }
      await new Promise((r) => setTimeout(r, 250)); // margen para el repintado
    }

    result = mode === 'scroll'
      ? await captureScrollOfTab(workTab)
      : await captureVisibleOfTab(workTab);
  } catch (err) {
    result = { dataUrl: null, error: `excepción en la captura: ${err.message}` };
  } finally {
    if (mustSwitch && tabToRestore && tabToRestore.id) {
      await chrome.tabs.update(tabToRestore.id, { active: true }).catch(() => {});
    }
  }

  if (!result || !result.dataUrl) {
    const detalle = (result && result.error) || 'motivo desconocido';
    console.error(`[Gemini Bridge] Captura fallida (modo ${mode}) en "${workTab.title}": ${detalle}`);
    await chrome.storage.session.set({ gwb_last_error: `modo ${mode}: ${detalle}` });
    return { error: `modo ${mode} — ${detalle}` };
  }

  const dataUrl = result.dataUrl;

  await chrome.storage.session.set({ gwb_last_captured_url: workTab.url, gwb_last_error: null });
  return { dataUrl, mode };
}

/**
 * Captura sólo el área visible de una pestaña concreta, numerándola antes.
 */
async function captureVisibleOfTab(tab) {
  try {
    await paintBadgesInTab(tab.id);
    const dataUrl = await captureVisibleThrottled(tab.windowId, { format: 'png' });
    if (!dataUrl) return { dataUrl: null, error: 'captureVisibleTab no devolvió imagen' };
    return { dataUrl, error: null };
  } catch (err) {
    console.error('[Gemini Bridge] Error en captura visible de la pestaña vinculada:', err);
    return { dataUrl: null, error: `captureVisibleTab: ${err.message}` };
  }
}

/**
 * Numera los elementos interactivos de la pestaña antes de capturar.
 * Las insignias quedan grabadas en la imagen y permanecen en la página, de modo
 * que cuando Gemini responde "pulsa el 7" el usuario ve el 7 en su pantalla.
 * @param {number} tabId
 * @returns {Promise<number>} número de insignias pintadas
 */
async function paintBadgesInTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/badges.js']
    });
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (typeof window.__gwbPaintBadges === 'function' ? window.__gwbPaintBadges() : 0)
    });
    const count = results?.[0]?.result || 0;
    console.log(`[Gemini Bridge] ${count} elementos numerados.`);
    return count;
  } catch (err) {
    // Páginas internas del navegador o restringidas: seguimos sin numerar.
    console.warn('[Gemini Bridge] No se pudieron pintar las insignias:', err.message);
    return 0;
  }
}

/**
 * Vuelve a numerar la pestaña activa. Las insignias se colocan en coordenadas
 * fijas del documento, así que al desplegar un menú o mover algo se quedan
 * donde estaban. Se repintan solas en cada captura, pero entre consulta y
 * consulta hace falta poder realinearlas a mano.
 * @returns {Promise<number>} insignias pintadas
 */
async function repaintBadgesInActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return 0;
  return await paintBadgesInTab(tab.id);
}

/**
 * Quita las insignias de la pestaña activa.
 */
async function clearBadgesInActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/badges.js']
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => { if (typeof window.__gwbClearBadges === 'function') window.__gwbClearBadges(); }
    });
  } catch (err) {
    console.warn('[Gemini Bridge] No se pudieron quitar las insignias:', err.message);
  }
}

/**
 * Flujo de captura visible de la pestaña activa
 */
async function handleFullCapture() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    await paintBadgesInTab(tab.id);

    const dataUrl = await captureVisibleThrottled(tab.windowId, { format: 'png' });
    if (dataUrl) {
      await sendToGemini(dataUrl, tab);
    }
  } catch (err) {
    console.error('Error en captura visible:', err);
  }
}

/**
 * Flujo de captura de página completa con scroll y ensamblado
 */
async function handleScrollCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  const { dataUrl, error } = await captureScrollOfTab(tab);
  if (dataUrl) {
    await sendToGemini(dataUrl, tab);
  } else {
    console.error('[Gemini Bridge] Captura de página completa fallida:', error);
  }
}

/**
 * Captura de página completa con scroll y ensamblado sobre una pestaña dada.
 * Devuelve la imagen en vez de enviarla, para poder reutilizarla desde el
 * puente automático además de desde el popup.
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<string|null>}
 */
async function captureScrollOfTab(tab) {
  let activeTab = null;
  try {
    if (!tab || !tab.id) return { dataUrl: null, error: 'pestaña inválida' };
    activeTab = tab;

    // Verificar si la URL es accesible para inyección de scripts
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:'))) {
      console.warn('No se pueden inyectar scripts en páginas internas del navegador.');
      return { dataUrl: null, error: 'es una página interna del navegador' };
    }

    // 0. Numerar una sola vez, antes de empezar a hacer scroll. Las insignias se
    // posicionan en coordenadas de documento, así que acompañan al contenido en
    // cada rebanada sin que los números se repitan entre ellas.
    await paintBadgesInTab(tab.id);

    // 1. Preparar la página, calcular altura real y posiciones de scroll
    const initResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: preparePageForScrollCapture
    });

    if (!initResults || !initResults[0] || !initResults[0].result) {
      console.error('No se pudo inicializar la captura de scroll.');
      return { dataUrl: null, error: 'no se pudo medir la página para el scroll' };
    }

    const {
      totalHeight,
      viewportWidth,
      viewportHeight,
      dpr,
      yPositions
    } = initResults[0].result;

    console.log(`[Gemini Bridge] Iniciando captura de ${yPositions.length} secciones. Altura total: ${totalHeight}px`);

    const slices = [];

    // 2. Iterar por cada sección de la página haciendo scroll
    for (let i = 0; i < yPositions.length; i++) {
      const y = yPositions[i];

      // Desplazar a la posición Y y esperar repaint del DOM
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: scrollToPositionInTab,
        args: [y, i, yPositions.length]
      });

      // Pausa adicional para estabilizar imágenes diferidas y renderizado
      await new Promise((r) => setTimeout(r, 200));

      // Ocultar banner indicador antes de tomar la captura
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const banner = document.getElementById('gemini-bridge-progress-banner');
          if (banner) banner.style.display = 'none';
        }
      });

      // Capturar la porción visible actual
      const dataUrl = await captureVisibleThrottled(tab.windowId, { format: 'png' });

      // Mostrar banner nuevamente para feedback visual
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const banner = document.getElementById('gemini-bridge-progress-banner');
          if (banner) banner.style.display = 'flex';
        }
      });

      if (dataUrl) {
        slices.push({ y, dataUrl });
      }
    }

    // 3. Restaurar estado original de la página y quitar banners/estilos
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: cleanupPageAfterScrollCapture
    });

    if (slices.length === 0) return { dataUrl: null, error: 'no se capturó ninguna sección' };

    // 4. Ensamblar las capturas usando OffscreenCanvas
    const stitched = await stitchSlices(slices, totalHeight, viewportWidth, viewportHeight, dpr);
    if (!stitched) return { dataUrl: null, error: 'falló el ensamblado de las secciones' };
    return { dataUrl: stitched, error: null };
  } catch (err) {
    console.error('Error en captura con scroll:', err);
    if (activeTab && activeTab.id) {
      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: cleanupPageAfterScrollCapture
      }).catch(() => {});
    }
    return { dataUrl: null, error: `scroll: ${err.message}` };
  }
}

/**
 * Función inyectada en la página para preparar la captura con scroll
 */
function preparePageForScrollCapture() {
  // Inyectar estilo para ocultar barras de scroll SIN deshabilitar el scroll
  let styleEl = document.getElementById('gemini-bridge-scrollbar-style');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'gemini-bridge-scrollbar-style';
    styleEl.textContent = `
      html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar {
        width: 0px !important;
        height: 0px !important;
        background: transparent !important;
        display: none !important;
      }
      html, body, * {
        scrollbar-width: none !important;
        -ms-overflow-style: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  // Guardar posición original de scroll
  window.__geminiBridgeOriginalState = {
    scrollX: window.scrollX || window.pageXOffset || 0,
    scrollY: window.scrollY || window.pageYOffset || 0
  };

  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const dpr = window.devicePixelRatio || 1;

  const docEl = document.documentElement;
  const body = document.body;

  let docScrollHeight = Math.max(
    docEl ? docEl.scrollHeight : 0,
    docEl ? docEl.offsetHeight : 0,
    docEl ? docEl.clientHeight : 0,
    body ? body.scrollHeight : 0,
    body ? body.offsetHeight : 0,
    body ? body.clientHeight : 0,
    viewportHeight
  );

  // Si la página utiliza un contenedor principal scrolleable en lugar de window
  let scrollContainer = null;
  if (docScrollHeight <= viewportHeight + 20) {
    const candidates = document.querySelectorAll('main, div, section, article, [role="main"]');
    let maxH = 0;
    for (const el of candidates) {
      if (el.scrollHeight > el.clientHeight && el.scrollHeight > maxH && el.clientHeight > 200) {
        const style = window.getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflow === 'auto' || style.overflow === 'scroll') {
          maxH = el.scrollHeight;
          scrollContainer = el;
        }
      }
    }
    if (scrollContainer) {
      docScrollHeight = maxH;
      window.__geminiBridgeScrollContainer = scrollContainer;
      window.__geminiBridgeOriginalContainerScroll = scrollContainer.scrollTop;
    }
  }

  // Límite de seguridad para páginas de scroll infinito
  const MAX_HEIGHT = 20000;
  const totalHeight = Math.min(docScrollHeight, MAX_HEIGHT);

  // Calcular posiciones Y de desplazamiento
  const yPositions = [];
  let curY = 0;
  const step = viewportHeight;

  while (curY < totalHeight) {
    yPositions.push(curY);
    if (curY + step >= totalHeight) {
      break;
    }
    curY += step;
    if (curY + step > totalHeight) {
      const finalY = Math.max(0, totalHeight - step);
      if (!yPositions.includes(finalY)) {
        yPositions.push(finalY);
      }
      break;
    }
  }

  if (yPositions.length === 0) {
    yPositions.push(0);
  }

  // Banner indicador flotante
  let banner = document.getElementById('gemini-bridge-progress-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'gemini-bridge-progress-banner';
    banner.style.cssText = `
      position: fixed !important;
      bottom: 24px !important;
      right: 24px !important;
      z-index: 2147483647 !important;
      background: rgba(15, 19, 30, 0.95) !important;
      color: #ffffff !important;
      padding: 10px 18px !important;
      border-radius: 12px !important;
      font-family: system-ui, -apple-system, sans-serif !important;
      font-size: 13px !important;
      font-weight: 500 !important;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5) !important;
      border: 1px solid rgba(255,255,255,0.15) !important;
      backdrop-filter: blur(10px) !important;
      display: flex !important;
      align-items: center !important;
      gap: 8px !important;
      pointer-events: none !important;
    `;
    banner.innerHTML = '<span>📸</span> <span id="gemini-bridge-banner-text">Iniciando captura con scroll...</span>';
    (document.body || document.documentElement).appendChild(banner);
  }

  return {
    totalHeight,
    viewportWidth,
    viewportHeight,
    dpr,
    yPositions
  };
}

/**
 * Función inyectada para realizar el scroll y sincronizar con el renderizado
 */
function scrollToPositionInTab(targetY, index, total) {
  const text = document.getElementById('gemini-bridge-banner-text');
  if (text) {
    text.textContent = `Capturando sección ${index + 1} de ${total}...`;
  }

  // Desplazar window y scrollingElement
  window.scrollTo({ left: 0, top: targetY, behavior: 'instant' });
  if (document.documentElement) document.documentElement.scrollTop = targetY;
  if (document.body) document.body.scrollTop = targetY;

  // Desplazar contenedor específico si existe
  if (window.__geminiBridgeScrollContainer) {
    window.__geminiBridgeScrollContainer.scrollTop = targetY;
  }
}

/**
 * Función inyectada para restaurar el estado original tras la captura
 */
function cleanupPageAfterScrollCapture() {
  const styleEl = document.getElementById('gemini-bridge-scrollbar-style');
  if (styleEl) styleEl.remove();

  const orig = window.__geminiBridgeOriginalState;
  if (orig) {
    window.scrollTo({ left: orig.scrollX, top: orig.scrollY, behavior: 'instant' });
    if (document.documentElement) document.documentElement.scrollTop = orig.scrollY;
    if (document.body) document.body.scrollTop = orig.scrollY;
    delete window.__geminiBridgeOriginalState;
  }

  if (window.__geminiBridgeScrollContainer && typeof window.__geminiBridgeOriginalContainerScroll === 'number') {
    window.__geminiBridgeScrollContainer.scrollTop = window.__geminiBridgeOriginalContainerScroll;
    delete window.__geminiBridgeScrollContainer;
    delete window.__geminiBridgeOriginalContainerScroll;
  }

  const banner = document.getElementById('gemini-bridge-progress-banner');
  if (banner) {
    banner.remove();
  }
}

/**
 * Ensambla los recortes en un OffscreenCanvas y devuelve el DataURL
 */
// Tope de altura del montaje. Sin él, una página larga en una pantalla Retina
// produce un lienzo de decenas de miles de píxeles: el PNG resultante pesa
// decenas de megas en base64, revienta el paso de mensajes y Gemini lo
// rechazaría igualmente. Para leer una pantalla no hace falta esa resolución.
const MAX_STITCH_HEIGHT = 10000;

async function stitchSlices(slices, totalHeight, viewportWidth, viewportHeight, dpr) {
  // Montar en píxeles CSS, no en píxeles físicos: en Retina eso ya divide por
  // cuatro el número de píxeles sin perder nada legible.
  let scale = 1 / dpr;
  if (totalHeight > MAX_STITCH_HEIGHT) {
    scale = Math.min(scale, MAX_STITCH_HEIGHT / totalHeight);
    console.warn(`[Gemini Bridge] Página de ${Math.round(totalHeight)}px: reduciendo el montaje para no pasar de ${MAX_STITCH_HEIGHT}px.`);
  }

  const canvasWidth = Math.max(1, Math.round(viewportWidth * dpr * scale));
  const canvasHeight = Math.max(1, Math.round(totalHeight * dpr * scale));

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error(`no se pudo crear el lienzo de ${canvasWidth}x${canvasHeight}`);

  // Fondo blanco: el JPEG no tiene transparencia y los huecos saldrían negros.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  for (const slice of slices) {
    const response = await fetch(slice.dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    const destY = Math.round(slice.y * dpr * scale);
    ctx.drawImage(
      bitmap,
      0, destY,
      Math.round(bitmap.width * scale),
      Math.round(bitmap.height * scale)
    );
    bitmap.close();
  }

  // JPEG en vez de PNG: para una captura de pantalla pesa varias veces menos y
  // la diferencia visual es irrelevante para leer texto y localizar botones.
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.82 });
  const arrayBuffer = await blob.arrayBuffer();

  console.log(`[Gemini Bridge] Montaje ${canvasWidth}x${canvasHeight}px, ${(arrayBuffer.byteLength / 1048576).toFixed(1)} MB.`);

  return bufferToDataUrl(arrayBuffer, 'image/jpeg');
}

/**
 * Convierte un ArrayBuffer a DataURL base64 de forma eficiente y segura
 */
function bufferToDataUrl(arrayBuffer, mimeType = 'image/png') {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  const chunkSize = 8192;
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunkSize, len)));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * Flujo de captura parcial: inyecta el overlay de recorte en la pestaña activa
 */
async function handleCropCapture() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    await paintBadgesInTab(tab.id);

    // Inyectar estilos del overlay
    await chrome.scripting.insertCSS({
      target: { tabId: tab.id },
      files: ['content/crop_overlay.css']
    });

    // Inyectar script del overlay
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/crop_overlay.js']
    });
  } catch (err) {
    console.error('Error inyectando herramienta de recorte:', err);
  }
}

/**
 * Envía la captura a la pestaña inmediatamente a la derecha de la pestaña origen
 * @param {string} dataUrl - Imagen en formato base64
 * @param {chrome.tabs.Tab} [sourceTab] - Pestaña origen desde la que se inició la captura
 */
async function sendToGemini(dataUrl, sourceTab) {
  try {
    // 1. Obtener la pestaña activa actual (la que estamos capturando) si no viene dada
    let currentTab = sourceTab;
    if (!currentTab || typeof currentTab.index === 'undefined') {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTab = activeTab;
    }

    if (!currentTab) {
      console.error("No se pudo identificar la pestaña activa.");
      return;
    }

    // 2. Calcular el índice de la pestaña inmediatamente a la derecha
    const targetIndex = currentTab.index + 1;

    // 3. Buscar la pestaña en esa posición exacta en la misma ventana
    const [targetTab] = await chrome.tabs.query({ index: targetIndex, windowId: currentTab.windowId });

    if (!targetTab) {
      console.error("No hay ninguna pestaña a la derecha.");
      // Avisar al usuario en la pestaña actual
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: () => alert("Gemini Web Bridge:\nNo se encontró ninguna pestaña abierta inmediatamente a la derecha.")
      }).catch(() => {});
      return;
    }

    // 4. Activar la pestaña de la derecha y darle el foco a la ventana
    await chrome.tabs.update(targetTab.id, { active: true });
    await chrome.windows.update(targetTab.windowId, { focused: true });

    // 5. Inyectar script en la pestaña de destino (targetTab.id)
    await injectInjectorScript(targetTab.id, dataUrl);
  } catch (err) {
    console.error('Error transmitiendo datos a la pestaña derecha:', err);
  }
}

/**
 * Inyecta la función de pegado en la pestaña de Gemini con el argumento dataUrl
 */
async function injectInjectorScript(tabId, dataUrl) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: executeGeminiInjection,
      args: [dataUrl]
    });
  } catch (err) {
    console.error('Error al ejecutar inyección en Gemini:', err);
  }
}

/**
 * Función que se ejecuta dentro del contexto de la página de Gemini
 */
async function executeGeminiInjection(dataUrl) {
  const PREDEFINED_TEXT = "Revisa la captura de pantalla adjunta. Los elementos con los que se puede interactuar (campos, botones, enlaces, desplegables) están numerados en la imagen con una insignia roja en su esquina superior izquierda. IMPORTANTE: cuando tu respuesta implique que yo deba hacer clic, escribir o fijarme en algo concreto, refiérete SIEMPRE al número de su insignia. Por ejemplo: \"escribe tu nombre en el 4, el correo en el 7 y luego pulsa el 12\". No describas la posición con palabras (nada de \"arriba a la derecha\" o \"el botón azul\"): usa el número, que yo lo estoy viendo en mi pantalla. Si tengo que rellenar un campo, dime su número y el texto exacto que debo poner. Aquí va mi pregunta: ";

  function dataURLtoFile(dataUrlString, filename = 'screenshot.png') {
    const parts = dataUrlString.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
  }

  function waitForGeminiInput(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      const selectors = [
        'div.ql-editor[contenteditable="true"]',
        'rich-textarea div[contenteditable="true"]',
        'div[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea[aria-label]'
      ];

      const findElement = () => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el && el.offsetParent !== null) {
            return el;
          }
        }
        return null;
      };

      const existingEl = findElement();
      if (existingEl) return resolve(existingEl);

      const observer = new MutationObserver(() => {
        const el = findElement();
        if (el) {
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true
      });

      setTimeout(() => {
        observer.disconnect();
        const fallbackEl = findElement();
        if (fallbackEl) {
          resolve(fallbackEl);
        } else {
          reject(new Error('No se encontró la caja de texto de Gemini.'));
        }
      }, timeoutMs);
    });
  }

  function placeCursorAtEnd(element) {
    element.focus();
    if (typeof window.getSelection !== 'undefined' && typeof document.createRange !== 'undefined') {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  try {
    const inputElement = await waitForGeminiInput();
    inputElement.focus();

    // Crear File y DataTransfer
    const file = dataURLtoFile(dataUrl, 'screenshot.png');
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    dataTransfer.setData('text/plain', PREDEFINED_TEXT);

    // Despachar evento Paste nativo
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clipboardData: dataTransfer
    });

    inputElement.dispatchEvent(pasteEvent);

    // Esperar para verificar si el texto se insertó o si requiere inserción explícita
    await new Promise((r) => setTimeout(r, 250));

    const currentText = inputElement.innerText || inputElement.textContent || '';
    if (!currentText.includes("Revisa la captura de pantalla adjunta")) {
      document.execCommand('insertText', false, PREDEFINED_TEXT);
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Colocar el cursor al final para que el usuario pueda escribir su pregunta
    placeCursorAtEnd(inputElement);
  } catch (err) {
    console.error('Gemini Web Bridge Injection Error:', err);
  }
}
