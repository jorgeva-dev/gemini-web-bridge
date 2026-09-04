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
  } else if (message.action === 'get_pair_pref') {
    // El puente sólo necesita saber a qué pestaña está enlazado, para el cartel.
    getPairByGeminiTab(sender.tab && sender.tab.id)
      .then((pair) => sendResponse(pair ? { workTitle: pair.workTitle || '' } : { missing: true }))
      .catch(() => sendResponse({ missing: true }));
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

// Por defecto chrome.storage.session sólo es legible desde contextos de
// confianza, así que el puente inyectado en la página no podía guardar el
// estado del interruptor AUTO: fallaba en silencio y volvía a ON en cada carga.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch((err) => console.warn('[Gemini Bridge] No se pudo abrir storage.session al puente:', err.message));

/**
 * ===========================================================================
 * REGISTRO DE PAREJAS
 * ===========================================================================
 *
 * Antes existía UN vínculo global, así que al intentar vincular una segunda
 * pestaña la extensión respondía que ya había una vinculación hecha, y no había
 * forma de trabajar con dos temas a la vez ni en dos ventanas.
 *
 * Ahora se guarda un registro de parejas indexado por el id de la pestaña de
 * Gemini. Esa clave no es arbitraria: los mensajes que llegan desde una pestaña
 * traen `sender.tab.id`, así que cada conversación se identifica sola sin
 * consultar ningún estado compartido.
 *
 * Forma de cada pareja:
 *   { workTabId, workTitle, geminiTabId, groupId, lastError }
 */

const GEMINI_URL = 'https://gemini.google.com/app';
const LINKS_KEY = 'gwb_links';

async function readLinks() {
  const s = await chrome.storage.session.get([LINKS_KEY]);
  return (s && s[LINKS_KEY]) || {};
}

async function writeLinks(links) {
  await chrome.storage.session.set({ [LINKS_KEY]: links });
}

/** Pareja cuya pestaña de Gemini es la indicada. */
async function getPairByGeminiTab(geminiTabId) {
  const links = await readLinks();
  return links[String(geminiTabId)] || null;
}

/** Pareja a la que pertenece una pestaña, sea el lado de trabajo o el de Gemini. */
async function getPairForTab(tabId) {
  const links = await readLinks();
  if (links[String(tabId)]) return links[String(tabId)];
  return Object.values(links).find((p) => p.workTabId === tabId) || null;
}

async function savePair(pair) {
  const links = await readLinks();
  links[String(pair.geminiTabId)] = pair;
  await writeLinks(links);
}

async function deletePair(geminiTabId) {
  const links = await readLinks();
  delete links[String(geminiTabId)];
  await writeLinks(links);
}

/**
 * Pestañas de Gemini abiertas, marcando las que ya están ocupadas por otra
 * pareja para que el usuario no se las lleve por delante sin darse cuenta.
 */
async function listGeminiTabs() {
  const [tabs, links] = await Promise.all([
    chrome.tabs.query({ url: '*://gemini.google.com/*' }),
    readLinks()
  ]);

  // El título de la pestaña es "Google Gemini" en todas, así que no distingue
  // nada: con tres conversaciones abiertas el selector mostraba tres opciones
  // idénticas. La etiqueta útil hay que sacarla de dentro de la página.
  const etiquetas = await Promise.all(tabs.map((t) => describeGeminiTab(t.id)));

  return tabs.map((t, i) => ({
    id: t.id,
    title: etiquetas[i] || t.title || 'Gemini',
    hint: chatIdFromUrl(t.url),
    active: Boolean(t.active),
    linked: Boolean(links[String(t.id)])
  }));
}

/** Últimos caracteres del id de conversación, como desempate visible. */
function chatIdFromUrl(url) {
  const m = (url || '').match(/\/app\/([A-Za-z0-9_-]+)/);
  return m ? m[1].slice(-6) : '';
}

/**
 * Extrae una etiqueta legible de una pestaña de Gemini: el nombre de la
 * conversación si lo tiene, y si no su primer mensaje. Los selectores son de
 * Gemini y pueden cambiar, así que hay varios candidatos y varios respaldos:
 * fallar aquí sólo debe costar una etiqueta peor, nunca romper el listado.
 * @param {number} tabId
 * @returns {Promise<string|null>}
 */
async function describeGeminiTab(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const limpiar = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const recortar = (s) => (s.length > 48 ? s.slice(0, 45) + '…' : s);

        // 1. Conversación seleccionada en la barra lateral
        const seleccionada = document.querySelector(
          '.conversation.selected .conversation-title, [class*="conversation"][class*="selected"] [class*="title"]'
        );
        const nombre = limpiar(seleccionada && seleccionada.textContent);
        if (nombre) return recortar(nombre);

        // 2. Primer mensaje del usuario en el hilo
        const primero = document.querySelector(
          'user-query .query-text, [data-test-id="user-query"], user-query'
        );
        const texto = limpiar(primero && primero.textContent);
        if (texto) return recortar(texto);

        // 3. Sin mensajes todavía
        return null;
      }
    });
    return (res && res[0] && res[0].result) || null;
  } catch (err) {
    // Pestaña descartada, aún cargando o restringida: no es un error grave.
    return null;
  }
}

/**
 * Vincula la pestaña activa con una de Gemini. Cada pareja es independiente:
 * puede haber tantas como quiera el usuario, incluso en ventanas distintas.
 * @param {{mode?: 'new'|'existing', geminiTabId?: number|null}} opciones
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

  const existente = await getPairForTab(workTab.id);
  if (existente) {
    return { ok: false, error: 'Esta pestaña ya está vinculada. Desvincúlala antes.' };
  }

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
    if (await getPairByGeminiTab(geminiTab.id)) {
      return { ok: false, error: 'Esa conversación ya está vinculada a otra pestaña.' };
    }
  } else {
    geminiTab = await chrome.tabs.create({
      url: GEMINI_URL,
      index: workTab.index + 1,
      windowId: workTab.windowId,
      active: false
    });
    await waitForTabComplete(geminiTab.id, 15000);
  }

  const groupId = await groupLinkedTabs(workTab.id, geminiTab.id);

  await savePair({
    workTabId: workTab.id,
    workTitle: workTab.title || 'pestaña de trabajo',
    geminiTabId: geminiTab.id,
    groupId,
    lastError: null
  });

  await injectBridge(geminiTab.id, workTab.title || '');

  await chrome.tabs.update(geminiTab.id, { active: true });
  await chrome.windows.update(geminiTab.windowId, { focused: true }).catch(() => {});

  return { ok: true, workTitle: workTab.title || '', geminiTabId: geminiTab.id };
}

/**
 * Agrupa las dos pestañas para que el vínculo se vea en la barra. Cada pareja
 * tiene su propio grupo. Es cosmético: si falla, el vínculo sigue valiendo.
 * @returns {Promise<number|null>} id del grupo
 */
async function groupLinkedTabs(workTabId, geminiTabId) {
  if (!chrome.tabGroups || !chrome.tabs.group) return null;
  try {
    const groupId = await chrome.tabs.group({ tabIds: [workTabId, geminiTabId] });
    await chrome.tabGroups.update(groupId, {
      title: 'Gemini Bridge',
      color: 'blue',
      collapsed: false
    });
    return groupId;
  } catch (err) {
    console.warn('[Gemini Bridge] No se pudieron agrupar las pestañas:', err.message);
    return null;
  }
}

async function ungroupPair(pair) {
  if (!pair || !pair.groupId || !chrome.tabs.ungroup) return;
  const ids = [pair.workTabId, pair.geminiTabId].filter((id) => typeof id === 'number');
  if (ids.length === 0) return;
  try {
    await chrome.tabs.ungroup(ids);
  } catch (err) {
    console.warn('[Gemini Bridge] No se pudieron desagrupar las pestañas:', err.message);
  }
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

// Si una pestaña de Gemini vinculada se recarga, su puente desaparece con ella.
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const pair = await getPairByGeminiTab(tabId);
  if (pair) await injectBridge(tabId, pair.workTitle || '');
});

// Al cerrarse cualquiera de los dos lados, sólo cae ESA pareja. Las demás siguen.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const links = await readLinks();
  for (const [key, pair] of Object.entries(links)) {
    if (pair.workTabId === tabId || pair.geminiTabId === tabId) {
      delete links[key];
    }
  }
  await writeLinks(links);
});

/**
 * Deshace la pareja a la que pertenece la pestaña indicada (o la activa).
 */
async function unlinkTabs(tabId = null) {
  let pair;
  if (tabId) {
    pair = await getPairForTab(tabId);
  } else {
    const [activa] = await chrome.tabs.query({ active: true, currentWindow: true });
    pair = activa ? await getPairForTab(activa.id) : null;
  }
  if (!pair) return;

  await ungroupPair(pair);

  // Dejarlo todo como estaba: sin insignias en la página de trabajo...
  try {
    await chrome.scripting.executeScript({
      target: { tabId: pair.workTabId },
      func: () => { if (typeof window.__gwbClearBadges === 'function') window.__gwbClearBadges(); }
    });
  } catch (err) {
    console.warn('[Gemini Bridge] No se pudieron quitar las insignias al desvincular:', err.message);
  }

  // ...y sin píldora en la de Gemini.
  chrome.tabs.sendMessage(pair.geminiTabId, { action: 'bridge_unlink' }).catch(() => {});

  await deletePair(pair.geminiTabId);
}


/**
 * Estado del vínculo DE LA PESTAÑA ACTIVA. Con varias parejas abiertas, el
 * popup tiene que hablar de la que tienes delante, no de una global.
 */
async function getLinkStatus() {
  const [activa] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activa) return { linked: false, total: 0 };

  const links = await readLinks();
  const total = Object.keys(links).length;
  const pair = links[String(activa.id)] ||
               Object.values(links).find((p) => p.workTabId === activa.id) || null;

  if (!pair) return { linked: false, total };

  let workTab, geminiTab;
  try {
    workTab = await chrome.tabs.get(pair.workTabId);
    geminiTab = await chrome.tabs.get(pair.geminiTabId);
  } catch (e) {
    await deletePair(pair.geminiTabId);
    return { linked: false, total: total - 1 };
  }

  return {
    linked: true,
    total,
    workTitle: workTab.title || pair.workTitle || 'pestaña de trabajo',
    geminiTitle: geminiTab.title || 'Gemini',
    lastError: pair.lastError || null,
    side: activa.id === pair.workTabId ? 'work' : 'gemini'
  };
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
      func: async () => {
        const n = typeof window.__gwbPaintBadges === 'function' ? window.__gwbPaintBadges() : 0;
        // Insertar los nodos no basta: hay que dejar que el navegador los pinte
        // de verdad antes de fotografiar, o la primera captura sale sin números.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        await new Promise((r) => setTimeout(r, 120));
        return n;
      }
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

// Atajos de teclado: renumerar se necesita justo cuando estás mirando la
// página y acabas de desplegar algo, no cuando te apetece abrir el popup.
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'repaint_badges') {
    const n = await repaintBadgesInActiveTab();
    console.log(`[Gemini Bridge] Renumerado por atajo: ${n} elementos.`);
  } else if (command === 'clear_badges') {
    await clearBadgesInActiveTab();
  }
});

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

    // 2. Destino: la conversación VINCULADA a esta pestaña. Antes se mandaba
    // siempre a "la pestaña de la derecha", heurística que ignoraba el vínculo
    // y que con varios vínculos abiertos acertaba de casualidad.
    let targetTab = null;
    const pair = await getPairForTab(currentTab.id);

    if (pair) {
      try {
        targetTab = await chrome.tabs.get(pair.geminiTabId);
      } catch (e) {
        targetTab = null;
      }
    }

    // 3. Sin vínculo, se conserva el comportamiento antiguo como respaldo.
    if (!targetTab) {
      const [vecina] = await chrome.tabs.query({
        index: currentTab.index + 1,
        windowId: currentTab.windowId
      });
      targetTab = vecina || null;
    }

    if (!targetTab) {
      console.error('[Gemini Bridge] Sin destino: ni vínculo ni pestaña a la derecha.');
      await chrome.scripting.executeScript({
        target: { tabId: currentTab.id },
        func: () => alert('Gemini Web Bridge:\n\nEsta pestaña no está vinculada a ninguna conversación de Gemini, y no hay ninguna pestaña a su derecha.\n\nVincúlala desde el widget.')
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
