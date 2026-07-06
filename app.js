// Boot commun à toutes les pages : enregistrement du service worker et
// bannière "nouvelle version disponible" (visible seulement quand le
// réseau est là pour télécharger la mise à jour — le fonctionnement hors
// ligne avec l'ancienne version n'est jamais interrompu).
(function () {
  if (!('serviceWorker' in navigator)) return;

  function showUpdateBanner(reg) {
    const banner = document.getElementById('update-banner');
    if (!banner) return;
    banner.classList.add('active');
    const btn = banner.querySelector('button');
    if (btn) {
      btn.addEventListener('click', () => {
        if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }, { once: true });
    }
  }

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      if (reg.waiting) showUpdateBanner(reg);
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateBanner(reg);
          }
        });
      });
    }).catch((e) => console.warn('Échec enregistrement service worker', e));
  });
})();
