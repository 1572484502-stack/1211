(() => {
  const entries = new Map();

  function register(element, featureId) {
    if (!(element instanceof HTMLMediaElement)) throw new Error('媒体会话只能注册音频或视频元素。');
    entries.set(element, featureId);
    return element;
  }

  function unregister(element) {
    if (!element) return;
    element.pause();
    entries.delete(element);
  }

  function playExclusive(activeElement) {
    entries.forEach((_, element) => {
      if (element !== activeElement && !element.paused) element.pause();
    });
  }

  function pauseScope(featureId) {
    entries.forEach((owner, element) => {
      if (owner === featureId && !element.paused) element.pause();
    });
  }

  function pauseAll() {
    entries.forEach((_, element) => { if (!element.paused) element.pause(); });
  }

  const api = Object.freeze({ register, unregister, playExclusive, pauseScope, pauseAll });
  window.VistaMedia = api;
  window.VistaCore.registerService('media', api);
})();
