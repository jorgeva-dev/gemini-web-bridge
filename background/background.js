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
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
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
  }
});

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

    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
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
  let activeTab = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    activeTab = tab;

    // Verificar si la URL es accesible para inyección de scripts
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:'))) {
      console.warn('No se pueden inyectar scripts en páginas internas del navegador.');
      return;
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
      return;
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
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

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

    if (slices.length === 0) return;

    // 4. Ensamblar las capturas usando OffscreenCanvas
    const stitchedDataUrl = await stitchSlices(slices, totalHeight, viewportWidth, viewportHeight, dpr);

    if (stitchedDataUrl) {
      await sendToGemini(stitchedDataUrl, tab);
    }
  } catch (err) {
    console.error('Error en captura con scroll:', err);
    if (activeTab && activeTab.id) {
      chrome.scripting.executeScript({
        target: { tabId: activeTab.id },
        func: cleanupPageAfterScrollCapture
      }).catch(() => {});
    }
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
async function stitchSlices(slices, totalHeight, viewportWidth, viewportHeight, dpr) {
  const canvasWidth = Math.round(viewportWidth * dpr);
  const canvasHeight = Math.round(totalHeight * dpr);

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');

  for (const slice of slices) {
    const response = await fetch(slice.dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    const destY = Math.round(slice.y * dpr);
    ctx.drawImage(bitmap, 0, destY);
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const arrayBuffer = await blob.arrayBuffer();

  return bufferToDataUrl(arrayBuffer, 'image/png');
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
