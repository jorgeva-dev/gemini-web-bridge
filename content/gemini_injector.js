/**
 * Inyector de captura y prompt para Google Gemini (gemini.google.com)
 */
(async function injectGeminiContent(dataUrl) {
  const PREDEFINED_TEXT = "Revisa la captura de pantalla adjunta. A continuación te haré una pregunta sobre ella. Si tu respuesta implica que debo hacer clic, interactuar o fijarme en un elemento concreto de la interfaz, dime exactamente dónde está usando referencias visuales precisas (arriba, abajo, colores, elementos cercanos). Aquí va mi pregunta: ";

  // Helper para convertir base64 dataURL a objeto File
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

  // Esperar a que el elemento de entrada de Gemini esté disponible
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
          if (el && el.offsetParent !== null) { // visible
            return el;
          }
        }
        return null;
      };

      const existingEl = findElement();
      if (existingEl) {
        return resolve(existingEl);
      }

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
          reject(new Error('No se encontró la caja de entrada de Gemini tras esperar.'));
        }
      }, timeoutMs);
    });
  }

  // Colocar el cursor al final del contenido en un elemento contenteditable
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

    // Crear File y DataTransfer para la imagen y el texto
    const file = dataURLtoFile(dataUrl, 'screenshot.png');
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    dataTransfer.setData('text/plain', PREDEFINED_TEXT);

    // Despachar evento Paste con DataTransfer
    const pasteEvent = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clipboardData: dataTransfer
    });

    inputElement.dispatchEvent(pasteEvent);

    // Dar un breve tiempo para verificar si Gemini insertó el texto junto con la imagen
    await new Promise(r => setTimeout(r, 200));

    // Si el texto predefinido no se introdujo directamente por el paste (o Gemini solo tomó el archivo),
    // aseguramos la inserción del texto de forma nativa sin sobrescribir la imagen
    const currentText = inputElement.innerText || inputElement.textContent || '';
    if (!currentText.includes("Revisa la captura de pantalla adjunta")) {
      // Usar execCommand para simular tipeo compatible con el editor enriquecido
      document.execCommand('insertText', false, PREDEFINED_TEXT);

      // Despachar eventos de input para sincronizar estado de React/Angular
      inputElement.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Asegurar foco y posición del cursor al final para que el usuario continúe escribiendo
    placeCursorAtEnd(inputElement);
    console.log('Gemini Web Bridge: Captura y texto inyectados exitosamente.');
  } catch (err) {
    console.error('Gemini Web Bridge Error:', err);
  }
})(typeof args !== 'undefined' && args && args[0] ? args[0] : (window.__GEMINI_BRIDGE_DATA_URL__ || ''));
