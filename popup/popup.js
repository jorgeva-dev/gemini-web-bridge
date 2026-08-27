document.addEventListener('DOMContentLoaded', () => {
  const btnFull = document.getElementById('btn-full');
  const btnScroll = document.getElementById('btn-scroll');
  const btnCrop = document.getElementById('btn-crop');
  const btnClear = document.getElementById('btn-clear');
  const btnLink = document.getElementById('btn-link');
  const linkDot = document.getElementById('link-dot');
  const linkText = document.getElementById('link-text');

  let isLinked = false;

  function renderLinkState(status) {
    isLinked = Boolean(status && status.linked);
    if (isLinked) {
      linkDot.classList.add('on');
      linkText.textContent = status.workTitle || 'Pestaña vinculada';
      linkText.title = status.workTitle || '';
      btnLink.textContent = 'Desvincular';
      btnLink.classList.add('unlink');
    } else {
      linkDot.classList.remove('on');
      linkText.textContent = 'Sin vincular';
      linkText.title = '';
      btnLink.textContent = 'Vincular con Gemini';
      btnLink.classList.remove('unlink');
    }
  }

  (async () => {
    try {
      renderLinkState(await chrome.runtime.sendMessage({ action: 'get_link_status' }));
    } catch (err) {
      renderLinkState({ linked: false });
    }
  })();

  btnLink.addEventListener('click', async () => {
    try {
      if (isLinked) {
        await chrome.runtime.sendMessage({ action: 'unlink_tabs' });
        renderLinkState({ linked: false });
        return;
      }

      btnLink.textContent = 'Vinculando…';
      const res = await chrome.runtime.sendMessage({ action: 'link_tabs' });

      if (res && res.ok) {
        renderLinkState({ linked: true, workTitle: res.workTitle });
        window.close();
      } else {
        linkText.textContent = (res && res.error) || 'No se pudo vincular';
        btnLink.textContent = 'Reintentar';
      }
    } catch (err) {
      console.error('Error vinculando pestañas:', err);
      btnLink.textContent = 'Reintentar';
    }
  });

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
