(() => {
  if (window.vistaDesktop) {
    document.querySelector('#minimizeBtn').addEventListener('click', () => window.vistaDesktop.minimize());
    document.querySelector('#maximizeBtn').addEventListener('click', () => window.vistaDesktop.maximize());
    document.querySelector('#closeBtn').addEventListener('click', () => window.vistaDesktop.close());
  } else {
    document.body.classList.add('browser-mode');
  }
})();
