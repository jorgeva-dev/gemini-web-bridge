document.addEventListener('DOMContentLoaded', () => {
  const btnFull = document.getElementById('btn-full');
  const btnScroll = document.getElementById('btn-scroll');
  const btnCrop = document.getElementById('btn-crop');
  const btnClear = document.getElementById('btn-clear');
  const btnRepaint = document.getElementById('btn-repaint');
  const btnLink = document.getElementById('btn-link');
  const linkDot = document.getElementById('link-dot');
  const linkText = document.getElementById('link-text');
  const linkGemini = document.getElementById('link-gemini');
  const linkError = document.getElementById('link-error');

  const linkChooser = document.getElementById('link-chooser');
  const existingList = document.getElementById('existing-list');
  const btnLinkNew = document.getElementById('btn-link-new');
  const btnChooserCancel = document.getElementById('btn-chooser-cancel');

  let isLinked = false;

  function renderLinkState(status) {
    isLinked = Boolean(status && status.linked);

    if (isLinked) {
      // Mostrar los dos extremos del vínculo: enseñar sólo uno no dejaba claro
      // con qué conversación de Gemini se había emparejado la página.
      linkDot.classList.add('on');
      const lado = status.side === 'gemini' ? '✦' : '📄';
      linkText.textContent = `${lado} ${status.workTitle || 'Pestaña de trabajo'}`;
      linkText.title = status.workTitle || '';
      linkGemini.textContent = `✦ ${status.geminiTitle || 'Gemini'}`;
      linkGemini.title = status.geminiTitle || '';
      btnLink.textContent = 'Desvincular';
      btnLink.classList.add('unlink');
    } else {
      linkDot.classList.remove('on');
      linkText.textContent = 'Sin vincular';
      linkText.title = 'Esta pestaña no está vinculada. Puedes crear un vínculo nuevo sin tocar los que ya tengas.';
      // Con varias parejas abiertas conviene saber que las otras siguen vivas,
      // o parece que vincular una haya deshecho las demás.
      linkGemini.textContent = status && status.total
        ? `${status.total} vínculo${status.total === 1 ? '' : 's'} activo${status.total === 1 ? '' : 's'} en otras pestañas`
        : '';
      linkGemini.title = '';
      btnLink.textContent = 'Vincular con Gemini';
      btnLink.classList.remove('unlink');
    }

    if (status && status.lastError) {
      linkError.textContent = `Último fallo de captura — ${status.lastError}`;
      linkError.classList.remove('hidden');
    } else {
      linkError.classList.add('hidden');
    }
  }

  (async () => {
    try {
      renderLinkState(await chrome.runtime.sendMessage({ action: 'get_link_status' }));
    } catch (err) {
      renderLinkState({ linked: false });
    }
  })();

  /**
   * Ejecuta el vínculo. La pestaña de Gemini la elige el usuario: antes se
   * reutilizaba en silencio la primera que hubiera abierta, lo que secuestraba
   * una conversación en curso sin avisar.
   */
  async function doLink(mode, geminiTabId) {
    try {
      linkChooser.classList.add('hidden');
      linkText.textContent = 'Vinculando…';

      const res = await chrome.runtime.sendMessage({ action: 'link_tabs', mode, geminiTabId });

      if (res && res.ok) {
        renderLinkState({ linked: true, workTitle: res.workTitle });
        window.close();
      } else {
        linkText.textContent = (res && res.error) || 'No se pudo vincular';
        btnLink.textContent = 'Reintentar';
      }
    } catch (err) {
      console.error('Error vinculando pestañas:', err);
      linkText.textContent = 'Error al vincular';
      btnLink.textContent = 'Reintentar';
    }
  }

  async function openChooser() {
    existingList.innerHTML = '';

    let tabs = [];
    try {
      const res = await chrome.runtime.sendMessage({ action: 'list_gemini_tabs' });
      tabs = (res && res.tabs) || [];
    } catch (err) {
      console.error('Error listando pestañas de Gemini:', err);
    }

    tabs.forEach((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chooser-option';
      btn.title = t.title;

      const icon = document.createElement('span');
      icon.className = 'chooser-icon';
      icon.textContent = '↳';

      const label = document.createElement('span');
      label.className = 'chooser-label';
      label.textContent = t.linked ? `${t.title} (ya vinculada)` : t.title;

      btn.appendChild(icon);
      btn.appendChild(label);

      if (t.linked) {
        // Ocupada por otra pareja: dejar elegirla robaría el vínculo ajeno.
        btn.disabled = true;
        btn.style.opacity = '.45';
        btn.style.cursor = 'not-allowed';
        btn.title = 'Ya vinculada a otra pestaña de trabajo';
      } else {
        btn.addEventListener('click', () => doLink('existing', t.id));
      }

      existingList.appendChild(btn);
    });

    linkChooser.classList.remove('hidden');
  }

  btnLink.addEventListener('click', async () => {
    if (isLinked) {
      try {
        await chrome.runtime.sendMessage({ action: 'unlink_tabs' });
      } catch (err) {
        console.error('Error desvinculando:', err);
      }
      renderLinkState({ linked: false });
      return;
    }
    await openChooser();
  });

  btnLinkNew.addEventListener('click', () => doLink('new', null));
  btnChooserCancel.addEventListener('click', () => linkChooser.classList.add('hidden'));

  btnFull.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'capture_full' });
    } catch (err) {
      console.error('Error enviando mensaje capture_full:', err);
    } finally {
      window.close();
    }
  });

  btnScroll.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'capture_scroll' });
    } catch (err) {
      console.error('Error enviando mensaje capture_scroll:', err);
    } finally {
      window.close();
    }
  });

  btnCrop.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'capture_crop' });
    } catch (err) {
      console.error('Error enviando mensaje capture_crop:', err);
    } finally {
      window.close();
    }
  });

  btnRepaint.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'repaint_badges' });
    } catch (err) {
      console.error('Error enviando mensaje repaint_badges:', err);
    } finally {
      window.close();
    }
  });

  btnClear.addEventListener('click', async () => {
    try {
      await chrome.runtime.sendMessage({ action: 'clear_badges' });
    } catch (err) {
      console.error('Error enviando mensaje clear_badges:', err);
    } finally {
      window.close();
    }
  });
});
