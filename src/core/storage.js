(() => {
  const prefix = 'vistaStudio';
  const keyFor = (featureId, key) => `${prefix}.${featureId}.${key}`;

  function read(featureId, key, fallback = null) {
    try {
      const value = localStorage.getItem(keyFor(featureId, key));
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  }

  function write(featureId, key, value) {
    localStorage.setItem(keyFor(featureId, key), JSON.stringify(value));
  }

  function remove(featureId, key) {
    localStorage.removeItem(keyFor(featureId, key));
  }

  const api = Object.freeze({ read, write, remove });
  window.VistaStore = api;
  window.VistaCore.registerService('storage', api);
})();
