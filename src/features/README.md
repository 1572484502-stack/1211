# 功能模块模板

每个新增功能建立独立目录：

```text
features/<feature-id>/
  feature.js       # 注册生命周期，只负责本功能
  engine.js        # 算法或业务逻辑
  view.js          # 界面交互
  styles.css       # 使用本功能专属前缀
```

模块只允许依赖 `core/` 中公开的服务，不得引用其他 `features/*` 目录。

```js
window.VistaCore.registerFeature({
  id: 'example',
  activate() {},
  deactivate() {
    window.VistaMedia.pauseScope('example');
  }
});
```

本地数据使用：

```js
window.VistaStore.write('example', 'settings.v1', settings);
const settings = window.VistaStore.read('example', 'settings.v1', {});
```
