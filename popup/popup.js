document.addEventListener('DOMContentLoaded', () => {
  const btnFull = document.getElementById('btn-full');
  const btnScroll = document.getElementById('btn-scroll');
  const btnCrop = document.getElementById('btn-crop');

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
});
