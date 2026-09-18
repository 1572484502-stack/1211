(() => {
  const features = new Map();
  const services = new Map();
  const listeners = new Map();
  let activeFeatureId = null;

  function registerFeature(feature) {
    if (!feature || !feature.id) throw new Error('功能模块必须提供唯一 id。');
    if (features.has(feature.id)) throw new Error(`功能模块重复注册：${feature.id}`);
    features.set(feature.id, Object.freeze({ ...feature }));
    return feature;
  }

  function registerService(name, service) {
    if (!name || !service) throw new Error('公共服务必须提供名称和实例。');
    if (services.has(name)) throw new Error(`公共服务重复注册：${name}`);
    services.set(name, service);
    return service;
  }

  function service(name) {
    if (!services.has(name)) throw new Error(`公共服务尚未注册：${name}`);
    return services.get(name);
  }

  function emit(eventName, detail) {
    (listeners.get(eventName) || []).forEach(listener => listener(detail));
  }

  function on(eventName, listener) {
    const group = listeners.get(eventName) || [];
    group.push(listener);
    listeners.set(eventName, group);
    return () => listeners.set(eventName, group.filter(item => item !== listener));
  }

  function activateFeature(id) {
    const next = features.get(id);
    if (!next) throw new Error(`找不到功能模块：${id}`);
    if (activeFeatureId === id) return;

    const previous = features.get(activeFeatureId);
    previous?.deactivate?.();
    document.querySelectorAll('[data-feature-view]').forEach(view => {
      view.classList.toggle('hidden', view.dataset.featureView !== id);
    });
    document.querySelectorAll('[data-feature-action]').forEach(action => {
      action.classList.toggle('active', action.dataset.featureAction === id);
    });
    activeFeatureId = id;
    next.activate?.();
    emit('feature:changed', { id, previousId: previous?.id || null });
  }

  window.VistaCore = Object.freeze({
    registerFeature,
    registerService,
    service,
    activateFeature,
    on,
    emit,
    get activeFeatureId() { return activeFeatureId; }
  });

  document.addEventListener('click', event => {
    const action = event.target.closest('[data-feature-action]');
    if (!action || action.classList.contains('disabled')) return;
    const id = action.dataset.featureAction;
    if (features.has(id)) activateFeature(id);
  });
})();
