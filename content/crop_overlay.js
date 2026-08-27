(() => {
  // Evitar inyecciones duplicadas
  const existingOverlay = document.getElementById('gemini-bridge-crop-overlay');
  if (existingOverlay) {
    existingOverlay.remove();
  }

  // Crear elementos del Overlay
  const overlay = document.createElement('div');
  overlay.id = 'gemini-bridge-crop-overlay';

  const hint = document.createElement('div');
  hint.className = 'gemini-bridge-hint';
  hint.innerHTML = '<span>Haz clic y arrastra para recortar el área</span> • <span>Presiona <kbd>ESC</kbd> para cancelar</span>';
  overlay.appendChild(hint);

  const selectionBox = document.createElement('div');
  selectionBox.className = 'gemini-bridge-selection';

  const badge = document.createElement('div');
  badge.className = 'gemini-bridge-badge';
  selectionBox.appendChild(badge);

  overlay.appendChild(selectionBox);
  document.body.appendChild(overlay);

  let isSelecting = false;
  let startX = 0;
  let startY = 0;
  let currentRect = { x: 0, y: 0, width: 0, height: 0 };

  const cleanup = () => {
    window.removeEventListener('keydown', onKeyDown);
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      cleanup();
    }
  };

  window.addEventListener('keydown', onKeyDown);

  overlay.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // Solo botón principal (izquierdo)
    isSelecting = true;
    startX = e.clientX;
    startY = e.clientY;

    currentRect = { x: startX, y: startY, width: 0, height: 0 };
    selectionBox.style.left = `${startX}px`;
    selectionBox.style.top = `${startY}px`;
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
    selectionBox.style.display = 'block';
  });

  overlay.addEventListener('mousemove', (e) => {
    if (!isSelecting) return;

    const currentX = e.clientX;
    const currentY = e.clientY;

    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    currentRect = { x, y, width, height };

    selectionBox.style.left = `${x}px`;
    selectionBox.style.top = `${y}px`;
    selectionBox.style.width = `${width}px`;
    selectionBox.style.height = `${height}px`;

    badge.textContent = `${Math.round(width)} × ${Math.round(height)} px`;
  });

  overlay.addEventListener('mouseup', async (e) => {
    if (!isSelecting) return;
    isSelecting = false;

    // Si la selección es demasiado pequeña, consideramos que fue un clic accidental
    if (currentRect.width < 10 || currentRect.height < 10) {
      selectionBox.style.display = 'none';
      return;
    }

    // Ocultar overlay temporalmente para que no salga en la captura si no se había tomado antes
    overlay.style.display = 'none';

    try {
      // Solicitar captura al background
      const response = await chrome.runtime.sendMessage({ action: 'capture_visible_for_crop' });
      
      if (!response || !response.dataUrl) {
        throw new Error('No se pudo obtener la captura de pantalla.');
      }

      // Procesar recorte con Canvas
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');

        // Calcular relación de píxeles (considerando Device Pixel Ratio y dimensiones del viewport)
        const scaleX = img.naturalWidth / window.innerWidth;
        const scaleY = img.naturalHeight / window.innerHeight;

        const cropX = currentRect.x * scaleX;
        const cropY = currentRect.y * scaleY;
        const cropWidth = currentRect.width * scaleX;
        const cropHeight = currentRect.height * scaleY;

        canvas.width = cropWidth;
        canvas.height = cropHeight;

        ctx.drawImage(
          img,
          cropX, cropY, cropWidth, cropHeight,
          0, 0, cropWidth, cropHeight
        );

        const croppedDataUrl = canvas.toDataURL('image/png');

        cleanup();

        // Enviar imagen recortada al background
        chrome.runtime.sendMessage({
          action: 'crop_completed',
          dataUrl: croppedDataUrl
        });
      };

      img.onerror = () => {
        cleanup();
        console.error('Error cargando la imagen para recortar');
      };

      img.src = response.dataUrl;
    } catch (err) {
      console.error('Error procesando captura parcial:', err);
      cleanup();
    }
  });
})();
