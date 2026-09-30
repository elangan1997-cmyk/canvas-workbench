/**
 * @local/canvas-workbench — Client half (browser bundle)
 *
 * 通过 web 加载器 window.__ModuleLoader__.load 装载；require('react') 取应用
 * React。所有数据走同源 HTTP（/dsh-canvas/image、/dsh-canvas/state）。
 */
window.__ModuleLoader__.load({
  // The client module id must match the package id used by DSH's client
  // registry.  Using a different legacy id makes Desktop reject the bundle
  // during renderer boot and fall back to Recovery Mode.
  id: '@local/canvas-workbench',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    // ---- React (single instance from the loader) ----
    var _react = require('react');
    var React = _react && _react.default ? _react.default : _react;

    // ---- constants ----
    const MODE_KEY = 'dsh-canvas-design-mode';
    const PROJECT_CHOICES_KEY = 'dsh-canvas-project-choices-v2';
    const LEGACY_PROJECT_CHOICES_KEY = 'dsh-canvas-project-choices';
    const PROJECT_CHOICES_BY_CWD_KEY = 'dsh-canvas-project-last-by-cwd-v1';
    const PANEL_WIDTH_KEY = 'dsh-canvas-panel-width';
    const MATERIAL_LIBRARY_KEY = 'dsh-canvas-material-library-v1';
    const MATERIAL_SORT_KEY = 'dsh-canvas-material-sort-v1';
    const AUTO_ADD_KEY = 'dsh-canvas-auto-add-chat-image';
    // ---- 内联自 src/shared/registry/feature-registry.js（构建期去 import/export；请改源文件） ----
    // Feature Registry（执行文档 §4）+ Capability 判定（§5）。共享模块：无 DOM / Node 依赖，Host 与 Client 都可用。
    // Feature 定义：{ id, name, capabilities: string[], commands?, toolbarItems?, panels?, initialize?(ctx), dispose?() }
    function createFeatureRegistry() {
      const features = new Map();
      const enabledIds = new Set();
      return {
        register(feature) {
          if (!feature || typeof feature.id !== 'string' || !feature.id) throw new Error('feature 缺少 id');
          if (features.has(feature.id)) throw new Error('feature 重复注册：' + feature.id);
          features.set(feature.id, { capabilities: [], commands: [], toolbarItems: [], panels: [], inspectors: [], contextMenuItems: [], ...feature });
          return features.get(feature.id);
        },
        unregister(id) {
          const f = features.get(id);
          if (f && enabledIds.has(id)) { try { if (typeof f.dispose === 'function') f.dispose(); } catch {} enabledIds.delete(id); }
          return features.delete(id);
        },
        get(id) { return features.get(id) || null; },
        list() { return [...features.values()]; },
        /** 给定 capability 集合（Set / 数组 / {name:boolean}），返回可启用的 feature：其所需 capabilities 全部为真。 */
        enabled(capabilities) {
          const has = capabilityPredicate(capabilities);
          return this.list().filter((f) => f.capabilities.every(has));
        },
        /** 按 capability 集合启用/停用，调用 initialize/dispose；返回 { enabled, disabled }。 */
        apply(capabilities, ctx) {
          const has = capabilityPredicate(capabilities);
          const enabled = [], disabled = [];
          for (const f of this.list()) {
            const ok = f.capabilities.every(has);
            if (ok && !enabledIds.has(f.id)) { try { if (typeof f.initialize === 'function') f.initialize(ctx); } catch {} enabledIds.add(f.id); enabled.push(f.id); }
            else if (!ok && enabledIds.has(f.id)) { try { if (typeof f.dispose === 'function') f.dispose(); } catch {} enabledIds.delete(f.id); disabled.push(f.id); }
          }
          return { enabled, disabled };
        },
        isEnabled(id) { return enabledIds.has(id); }
      };
    }

    function capabilityPredicate(capabilities) {
      if (capabilities instanceof Set) return (c) => capabilities.has(c);
      if (Array.isArray(capabilities)) { const s = new Set(capabilities); return (c) => s.has(c); }
      if (capabilities && typeof capabilities === 'object') return (c) => Boolean(capabilities[c]);
      return () => false;
    }

    /** 1.8.0 已有能力的 Feature 声明（数据层清单：谁需要什么能力）。 */
    const BUILTIN_FEATURES = Object.freeze([
      { id: 'canvas-core', name: '无限画布', capabilities: ['canvas.basic'] },
      { id: 'project-browser', name: '项目管理', capabilities: ['canvas.basic', 'project.store'] },
      { id: 'material-library', name: '素材库', capabilities: ['canvas.basic', 'materials.list'] },
      { id: 'chat-image-output', name: '聊天图片输出', capabilities: ['chat.turnTail'] },
      { id: 'image-generation', name: '图片生成', capabilities: ['image.generate'] },
      { id: 'image-edit', name: '编辑图片 / 智能擦除', capabilities: ['image.edit'] },
      { id: 'background-remove', name: '去除背景', capabilities: ['python.available'] },
      { id: 'vectorize', name: '转矢量', capabilities: ['python.available'] },
      { id: 'text-edit', name: '文字识别与重建', capabilities: ['text.recognition'] },
      { id: 'psd-export', name: 'PSD 导出', capabilities: ['text.psd-export', 'python.available'] },
      { id: 'export', name: 'PNG 导出', capabilities: ['canvas.basic'] },
      { id: 'video-generation', name: '视频生成（预留）', capabilities: ['video.generate'] }
    ]);

    /** 由 /dsh-canvas/health 的返回推导 capability 集合（Client 侧用；Host 侧可直接构造）。 */
    function capabilitiesFromHealth(health = {}) {
      const caps = { 'canvas.basic': true };
      const c = health.capabilities || {};
      caps['project.store'] = c.webServer !== false;
      caps['materials.list'] = c.webServer !== false;
      caps['image.generate'] = Boolean(health.imageEngine && ((health.imageEngine.dshCodex && health.imageEngine.dshCodex.ready) || (health.imageEngine.api && health.imageEngine.api.ready)));
      caps['image.edit'] = caps['image.generate'];
      caps['text.recognition'] = Boolean(c.llm && c.attachments);
      caps['python.available'] = health.platform ? health.platform.localPythonFeatures !== 'unavailable' : false;
      caps['text.psd-export'] = caps['python.available'];
      caps['video.generate'] = false;
      return caps;
    }

    // ---- 内联自 src/shared/commands/history.js（构建期去 import/export；请改源文件） ----
    // History Manager（执行文档 §8.1）：undo/redo 双栈。新命令入栈时清空 redo 栈；超过上限丢弃最早记录。
    function createHistoryManager({ limit = 100 } = {}) {
      const undoStack = [];
      const redoStack = [];
      return {
        push(entry) {
          undoStack.push(entry);
          redoStack.length = 0;
          while (undoStack.length > limit) undoStack.shift();
          return entry;
        },
        async undo() {
          const entry = undoStack.pop();
          if (!entry) return false;
          try { await entry.command.undo(entry.ctx); }
          catch (err) { undoStack.push(entry); throw err; }
          redoStack.push(entry);
          return true;
        },
        async redo() {
          const entry = redoStack.pop();
          if (!entry) return false;
          try { await entry.command.redo(entry.ctx); }
          catch (err) { redoStack.push(entry); throw err; }
          undoStack.push(entry);
          return true;
        },
        canUndo() { return undoStack.length > 0; },
        canRedo() { return redoStack.length > 0; },
        size() { return { undo: undoStack.length, redo: redoStack.length }; },
        peek() { return undoStack[undoStack.length - 1] || null; },
        clear() { undoStack.length = 0; redoStack.length = 0; }
      };
    }

    // ---- 内联自 src/shared/commands/command-bus.js（构建期去 import/export；请改源文件） ----
    // Command Bus（执行文档 §8）：所有用户级操作尽可能走 Command；Provider/Feature 不直接改全局状态。
    // Command 约定：execute(ctx) → 业务结果；undo(ctx) 可选；redo(ctx) 缺省重放 execute。
    class Command {
      constructor(fields = {}) { Object.assign(this, fields); }
      get name() { return this.constructor.name; }
      async execute() { throw new Error('Command 未实现 execute()'); }
      async undo() {}
      async redo(ctx) { return this.execute(ctx); }
    }

    function createCommandBus({ history = null, onError = null } = {}) {
      return {
        history,
        /** 执行命令并登记历史；execute 抛错时不入栈并原样抛出。 */
        async execute(command, ctx) {
          const result = await command.execute(ctx);
          if (history) history.push({ command, ctx });
          return result;
        },
        async undo() { return history ? history.undo() : false; },
        async redo() { return history ? history.redo() : false; },
        canUndo() { return history ? history.canUndo() : false; },
        canRedo() { return history ? history.canRedo() : false; }
      };
    }

    // ---- 内联自 src/shared/contracts/canvas-object.js（构建期去 import/export；请改源文件） ----
    // CanvasObject 契约（执行文档 §6）：业务层对象，不再把 Excalidraw element 当唯一数据结构。
    // 第一阶段通过 adapter 与旧 element 双向转换，不删除旧 element 数据（Phase 7 要求）。
    const CANVAS_OBJECT_TYPES = ['image', 'text', 'video', 'shape', 'group'];

    function createCanvasObject(input = {}) {
      const type = CANVAS_OBJECT_TYPES.includes(input.type) ? input.type : 'shape';
      const t = input.transform || {};
      return {
        id: String(input.id || ''),
        type,
        transform: {
          x: Number(t.x) || 0,
          y: Number(t.y) || 0,
          width: Number(t.width) || 0,
          height: Number(t.height) || 0,
          rotation: Number(t.rotation) || 0,
          scaleX: t.scaleX === undefined ? 1 : Number(t.scaleX) || 1,
          scaleY: t.scaleY === undefined ? 1 : Number(t.scaleY) || 1
        },
        locked: Boolean(input.locked),
        visible: input.visible === undefined ? true : Boolean(input.visible),
        metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {}
      };
    }

    /** Excalidraw image element → ImageObject（保留 customData 于 metadata；assetId 暂以来源路径承载）。 */
    function fromExcalidrawElement(el) {
      if (!el || typeof el !== 'object') return null;
      const custom = el.customData && typeof el.customData === 'object' ? el.customData : {};
      const base = createCanvasObject({
        id: el.id,
        type: el.type === 'image' ? 'image' : el.type === 'text' ? 'text' : 'shape',
        transform: { x: el.x, y: el.y, width: el.width, height: el.height, rotation: el.angle, scaleX: Array.isArray(el.scale) ? el.scale[0] : 1, scaleY: Array.isArray(el.scale) ? el.scale[1] : 1 },
        locked: el.locked,
        visible: !el.isDeleted,
        metadata: { excalidraw: { fileId: el.fileId || null, version: el.version || 1, opacity: el.opacity }, customData: custom }
      });
      if (base.type === 'image') {
        return {
          ...base,
          assetId: custom.dshAssetId || (custom.dshSourcePath ? 'path:' + custom.dshSourcePath : null),
          fileName: custom.dshFileName || null,
          tagColor: custom.dshTagColor || null,
          crop: null,
          opacity: el.opacity === undefined ? 1 : Number(el.opacity) / 100
        };
      }
      if (base.type === 'text') {
        return { ...base, content: String(el.text || ''), style: { fontFamily: el.fontFamily, fontSize: el.fontSize, color: el.strokeColor, textAlign: el.textAlign || 'left', opacity: el.opacity === undefined ? 1 : Number(el.opacity) / 100 } };
      }
      return base;
    }

    /** 把 ImageObject 的可变字段写回 Excalidraw element（只写业务层允许改的字段，其余原样）。 */
    function applyToExcalidrawElement(el, obj) {
      if (!el || !obj) return el;
      const next = { ...el, x: obj.transform.x, y: obj.transform.y, width: obj.transform.width, height: obj.transform.height, angle: obj.transform.rotation, locked: Boolean(obj.locked), isDeleted: !obj.visible };
      if (obj.type === 'image') {
        const custom = { ...(el.customData || {}) };
        if (obj.tagColor) custom.dshTagColor = obj.tagColor; else delete custom.dshTagColor;
        if (obj.fileName) custom.dshFileName = obj.fileName;
        next.customData = custom;
      }
      return next;
    }

    // ---- v1.8 内核对象：Feature Registry / Command Bus / History ----
    // 仅创建并挂到 window.__dshCanvas 供诊断与后续 Feature 接入；不改变现有 UI 行为。
    const dshFeatureRegistry = createFeatureRegistry();
    for (const feature of BUILTIN_FEATURES) dshFeatureRegistry.register(feature);
    const dshHistory = createHistoryManager({ limit: 100 });
    const dshCommandBus = createCommandBus({ history: dshHistory });
    try {
      window.__dshCanvas = Object.assign(window.__dshCanvas || {}, {
        features: dshFeatureRegistry,
        commands: dshCommandBus,
        history: dshHistory,
        Command,
        capabilitiesFromHealth,
        fromExcalidrawElement
      });
    } catch (e) {}
    // Mac 式七色标记；hex 与 macOS Finder 标签色一致。
    const MATERIAL_TAG_COLORS = [
      { id: 'red', label: '红', hex: '#ff5f57' },
      { id: 'orange', label: '橙', hex: '#ff9f0a' },
      { id: 'yellow', label: '黄', hex: '#ffd60a' },
      { id: 'green', label: '绿', hex: '#28c840' },
      { id: 'blue', label: '蓝', hex: '#0a84ff' },
      { id: 'purple', label: '紫', hex: '#bf5af2' },
      { id: 'gray', label: '灰', hex: '#8e8e93' }
    ];
    // 文字识别/重建的字体清单：苹方等系统字体版权不可商用，默认与首选都用
    // 可免费商用的阿里巴巴普惠体 3.0 与思源黑体（PostScript 名与 Photoshop
    // textItem.font 对齐，且需本机安装对应字体）。
    const TEXT_REBUILD_FONTS = [
      { group: '阿里巴巴普惠体 3.0（免费商用）', items: [
        { ps: 'AlibabaPuHuiTi_3_35_Thin', label: '普惠体 35 Thin 细体' },
        { ps: 'AlibabaPuHuiTi_3_45_Light', label: '普惠体 45 Light 纤细' },
        { ps: 'AlibabaPuHuiTi_3_55_Regular', label: '普惠体 55 Regular 常规' },
        { ps: 'AlibabaPuHuiTi_3_65_Medium', label: '普惠体 65 Medium 中黑' },
        { ps: 'AlibabaPuHuiTi_3_85_Bold', label: '普惠体 85 Bold 粗体' },
        { ps: 'AlibabaPuHuiTi_3_95_ExtraBold', label: '普惠体 95 ExtraBold 特粗' },
        { ps: 'AlibabaPuHuiTi_3_105_Heavy', label: '普惠体 105 Heavy 重磅' },
        { ps: 'AlibabaPuHuiTi_3_115_Black', label: '普惠体 115 Black 玄黑' }
      ] },
      { group: '思源黑体（免费商用）', items: [
        { ps: 'SourceHanSansSC-ExtraLight', label: '思源黑体 ExtraLight 极细' },
        { ps: 'SourceHanSansSC-Light', label: '思源黑体 Light 细体' },
        { ps: 'SourceHanSansSC-Normal', label: '思源黑体 Normal' },
        { ps: 'SourceHanSansSC-Regular', label: '思源黑体 Regular 常规' },
        { ps: 'SourceHanSansSC-Medium', label: '思源黑体 Medium 中黑' },
        { ps: 'SourceHanSansSC-Bold', label: '思源黑体 Bold 粗体' },
        { ps: 'SourceHanSansSC-Heavy', label: '思源黑体 Heavy 重磅' }
      ] },
      { group: 'Inter（免费商用·现代无衬线）', items: [
        { ps: 'Inter-Thin', label: 'Inter Thin' },
        { ps: 'Inter-ExtraLight', label: 'Inter ExtraLight' },
        { ps: 'Inter-Light', label: 'Inter Light' },
        { ps: 'Inter-Regular', label: 'Inter Regular' },
        { ps: 'Inter-Medium', label: 'Inter Medium' },
        { ps: 'Inter-SemiBold', label: 'Inter SemiBold' },
        { ps: 'Inter-Bold', label: 'Inter Bold' },
        { ps: 'Inter-ExtraBold', label: 'Inter ExtraBold' },
        { ps: 'Inter-Black', label: 'Inter Black' }
      ] },
      { group: 'Montserrat（免费商用·几何无衬线）', items: [
        { ps: 'Montserrat-Thin', label: 'Montserrat Thin' },
        { ps: 'Montserrat-ExtraLight', label: 'Montserrat ExtraLight' },
        { ps: 'Montserrat-Light', label: 'Montserrat Light' },
        { ps: 'Montserrat-Regular', label: 'Montserrat Regular' },
        { ps: 'Montserrat-Medium', label: 'Montserrat Medium' },
        { ps: 'Montserrat-SemiBold', label: 'Montserrat SemiBold' },
        { ps: 'Montserrat-Bold', label: 'Montserrat Bold' },
        { ps: 'Montserrat-ExtraBold', label: 'Montserrat ExtraBold' },
        { ps: 'Montserrat-Black', label: 'Montserrat Black' }
      ] },
      { group: 'Poppins（免费商用·圆润几何）', items: [
        { ps: 'Poppins-Thin', label: 'Poppins Thin' },
        { ps: 'Poppins-ExtraLight', label: 'Poppins ExtraLight' },
        { ps: 'Poppins-Light', label: 'Poppins Light' },
        { ps: 'Poppins-Regular', label: 'Poppins Regular' },
        { ps: 'Poppins-Medium', label: 'Poppins Medium' },
        { ps: 'Poppins-SemiBold', label: 'Poppins SemiBold' },
        { ps: 'Poppins-Bold', label: 'Poppins Bold' },
        { ps: 'Poppins-ExtraBold', label: 'Poppins ExtraBold' },
        { ps: 'Poppins-Black', label: 'Poppins Black' }
      ] },
      { group: 'Source Sans Pro（免费商用·人文无衬线）', items: [
        { ps: 'SourceSansPro-ExtraLight', label: 'Source Sans Pro ExtraLight' },
        { ps: 'SourceSansPro-Light', label: 'Source Sans Pro Light' },
        { ps: 'SourceSansPro-Regular', label: 'Source Sans Pro Regular' },
        { ps: 'SourceSansPro-Semibold', label: 'Source Sans Pro Semibold' },
        { ps: 'SourceSansPro-Bold', label: 'Source Sans Pro Bold' },
        { ps: 'SourceSansPro-Black', label: 'Source Sans Pro Black' }
      ] },
      { group: '西文/系统（注意授权）', items: [
        { ps: 'ArialMT', label: 'Arial' },
        { ps: 'Arial-BoldMT', label: 'Arial Bold' },
        { ps: 'HelveticaNeue', label: 'Helvetica Neue' },
        { ps: 'SongtiSC-Regular', label: '宋体（macOS 系统字体，慎商用）' }
      ] }
    ];
    const TEXT_REBUILD_DEFAULT_FONT = 'AlibabaPuHuiTi_3_55_Regular';
    function textRebuildFontValue(item) {
      const current = item && (item.fontPostScript || item.fontFamily) || '';
      return TEXT_REBUILD_FONTS.some((group) => group.items.some((font) => font.ps === current))
        ? current
        : TEXT_REBUILD_DEFAULT_FONT;
    }
    function canvasDefaultBackground() {
      try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? '#15171c' : '#f7f8fa'; } catch (e) { return '#f7f8fa'; }
    }
    // 目录同步不需要高频轮询：可见时保持较快反馈，窗口隐藏时完全暂停，
    // 重新显示后会立即补做一次同步。这样可以显著减少 Finder/外置盘的 I/O。
    const PROJECT_SYNC_INTERVAL = 8000;

    // ---- design-mode state (module-level) ----
    function readStorageValue(storage, key) {
      try {
        const value = storage && storage.getItem(key);
        return value == null ? null : value;
      } catch (e) {
        return null;
      }
    }
    function writeStorageValue(storage, key, value) {
      try {
        if (storage) storage.setItem(key, value);
        return true;
      } catch (e) {
        return false;
      }
    }
    function removeStorageValue(storage, key) {
      try { if (storage) storage.removeItem(key); } catch (e) {}
    }
    let mode = false;
    // 设计模式原先只写 sessionStorage，导致重启后右侧画布又关闭。
    // localStorage 是主存储；保留 sessionStorage 作为旧版本迁移来源。
    const storedMode = readStorageValue(window.localStorage, MODE_KEY);
    const legacyMode = readStorageValue(window.sessionStorage, MODE_KEY);
    mode = storedMode === '1' || (storedMode == null && legacyMode === '1');
    if (storedMode == null && legacyMode === '1') writeStorageValue(window.localStorage, MODE_KEY, '1');
    const modeListeners = new Set();
    function getMode() { return mode; }
    function setMode(v) {
      mode = !!v;
      if (mode) {
        writeStorageValue(window.localStorage, MODE_KEY, '1');
        // 兼容同一页面内仍在运行的旧 client 副本。
        writeStorageValue(window.sessionStorage, MODE_KEY, '1');
      } else {
        removeStorageValue(window.localStorage, MODE_KEY);
        removeStorageValue(window.sessionStorage, MODE_KEY);
      }
      for (const fn of [...modeListeners]) fn(mode);
    }
    function toggleMode() { setMode(!mode); }
    function subscribeMode(fn) { modeListeners.add(fn); return () => { modeListeners.delete(fn); }; }
    // 项目选择必须跨聊天切换、页面刷新和 DSH 重启保留。
    // v2 使用 { exact, lastByCwd }，同时读取旧版 sessionStorage 平面对象，
    // 因此升级不会让现有项目绑定丢失。
    let projectChoices = {};
    let projectChoicesByCwd = {};
    const loadProjectChoices = () => {
      const exact = {};
      const byCwd = {};
      const merge = (value) => {
        if (!value || typeof value !== 'object') return;
        if (value.exact && typeof value.exact === 'object') {
          Object.assign(exact, value.exact);
        } else {
          // 旧版本直接把 sessionId::cwd 映射放在根对象。
          for (const [key, project] of Object.entries(value)) {
            if (typeof project !== 'string') continue;
            if (key.indexOf('cwd::') === 0) byCwd[key] = project;
            else exact[key] = project;
          }
        }
        if (value.lastByCwd && typeof value.lastByCwd === 'object') {
          Object.assign(byCwd, value.lastByCwd);
        }
      };
      const parse = (raw, asCwdOnly) => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw);
          if (asCwdOnly && parsed && typeof parsed === 'object') {
            for (const [key, project] of Object.entries(parsed)) {
              if (typeof project === 'string') byCwd[key] = project;
            }
          } else merge(parsed);
        } catch (e) {}
      };
      // localStorage 优先；旧 sessionStorage 仅用于迁移/兼容。
      parse(readStorageValue(window.localStorage, PROJECT_CHOICES_KEY));
      parse(readStorageValue(window.localStorage, LEGACY_PROJECT_CHOICES_KEY));
      parse(readStorageValue(window.sessionStorage, PROJECT_CHOICES_KEY));
      parse(readStorageValue(window.sessionStorage, LEGACY_PROJECT_CHOICES_KEY));
      parse(readStorageValue(window.localStorage, PROJECT_CHOICES_BY_CWD_KEY), true);
      parse(readStorageValue(window.sessionStorage, PROJECT_CHOICES_BY_CWD_KEY), true);
      return { exact, byCwd };
    };
    const loadedProjectChoices = loadProjectChoices();
    ({ exact: projectChoices, byCwd: projectChoicesByCwd } = loadedProjectChoices);
    // 首次升级时立即把旧 sessionStorage 绑定迁移到持久存储，
    // 不要求用户再手动打开/切换一次项目才完成迁移。
    if (Object.keys(projectChoices).length || Object.keys(projectChoicesByCwd).length) {
      writeStorageValue(window.localStorage, PROJECT_CHOICES_KEY, JSON.stringify({ exact: projectChoices, lastByCwd: projectChoicesByCwd }));
      writeStorageValue(window.localStorage, PROJECT_CHOICES_BY_CWD_KEY, JSON.stringify(projectChoicesByCwd));
    }
    function projectCwdKey(cwd) {
      return 'cwd::' + String(cwd || '');
    }
    function projectChoiceKey(cwd, sessionId) {
      return String(sessionId || '') + '::' + String(cwd || '');
    }
    function chosenProject(cwd, sessionId, allowCwdFallback = true) {
      const exactKey = projectChoiceKey(cwd, sessionId);
      if (Object.prototype.hasOwnProperty.call(projectChoices, exactKey)) {
        return projectChoices[exactKey] || '';
      }
      // 工作目录兜底只用于首次启动或旧版 DSH 没有会话 ID 的场景；
      // 已在运行中的聊天切换不得把另一个聊天的项目串过来。
      return allowCwdFallback ? (projectChoicesByCwd[projectCwdKey(cwd)] || '') : '';
    }
    function rememberProject(cwd, project, sessionId) {
      if (!cwd) return;
      const value = project || '';
      if (sessionId) projectChoices[projectChoiceKey(cwd, sessionId)] = value;
      projectChoicesByCwd[projectCwdKey(cwd)] = value;
      const serialized = JSON.stringify({ exact: projectChoices, lastByCwd: projectChoicesByCwd });
      const flatLegacy = JSON.stringify(projectChoices);
      writeStorageValue(window.localStorage, PROJECT_CHOICES_KEY, serialized);
      writeStorageValue(window.localStorage, PROJECT_CHOICES_BY_CWD_KEY, JSON.stringify(projectChoicesByCwd));
      // 保留旧键，便于尚未热更新的同页副本读取到最新绑定。
      writeStorageValue(window.sessionStorage, LEGACY_PROJECT_CHOICES_KEY, flatLegacy);
      writeStorageValue(window.sessionStorage, PROJECT_CHOICES_KEY, serialized);
    }

    // ---- HTTP helpers ----
    function isLocalAbsolutePath(path) {
      return /^(?:~[\\/]|[A-Za-z]:[\\/]|\\\\|\/)/.test(String(path || ''));
    }
    function imageUrl(path) {
      if (typeof path === 'string' && /^(?:data:image\/|https?:\/\/|blob:)/i.test(path)) return path;
      // 绝对 URL：iframe 与主页面都按同一 origin 解析，避免任何 base URL 歧义。
      // 本地相对路径要按当前会话 cwd 解析；事件回放可能早于设计模式 dock 挂载。
      const resolved = resolveImagePath(path);
      if (!resolved || !isLocalAbsolutePath(resolved)) return '';
      try {
        return new URL('/dsh-canvas/image?path=' + encodeURIComponent(resolved), window.location.href).href;
      } catch (e) {
        return '/dsh-canvas/image?path=' + encodeURIComponent(resolved);
      }
    }
    function previewUrl(path) {
      if (typeof path === 'string' && /^(?:data:image\/|https?:\/\/|blob:)/i.test(path)) return path;
      const resolved = resolveImagePath(path);
      if (!resolved || !isLocalAbsolutePath(resolved)) return '';
      try {
        return new URL('/dsh-canvas/preview?path=' + encodeURIComponent(resolved), window.location.href).href;
      } catch (e) {
        return '/dsh-canvas/preview?path=' + encodeURIComponent(resolved);
      }
    }
    function displaySourceUrl(path) {
      if (typeof path === 'string' && /^(?:data:image\/|https?:\/\/|blob:)/i.test(path)) return path;
      if (attachmentFromPath(path)) return '';
      const resolved = resolveImagePath(path);
      if (!resolved || !isLocalAbsolutePath(resolved)) return '';
      return /\.(?:psd|svg|pdf|ai)$/i.test(String(resolved || '')) ? previewUrl(resolved) : imageUrl(resolved);
    }

    // DSH 原生 Markdown 会把 `/Volumes/...png` 当成站内 URL，浏览器因此只显示 alt 文字。
    // 在 DOM 层将这类本地图片地址改写为插件的同源图片接口，同时覆盖历史消息。
    function localPathFromMarkdownImage(img) {
      if (!img || img.dataset.dshCanvasLocalImage === '1') return '';
      const raw = String(img.getAttribute('src') || '').trim();
      if (!raw || raw.indexOf('/dsh-canvas/') >= 0) return '';
      if (/^(?:[A-Za-z]:[\\/]|\\\\|\/Volumes\/|\/Users\/|\/private\/|\/var\/|~\/)/.test(raw)) return raw;
      try {
        const parsed = new URL(raw, window.location.href);
        if (parsed.origin === window.location.origin && /^(?:\/Volumes\/|\/Users\/|\/private\/|\/var\/)/.test(parsed.pathname)) {
          return decodeURIComponent(parsed.pathname);
        }
      } catch (e) {}
      return '';
    }
    function installLocalMarkdownImageFallback() {
      const rewrite = (img) => {
        const path = localPathFromMarkdownImage(img);
        if (!path || !IMAGE_EXT_RE.test(path)) return;
        const src = displaySourceUrl(path);
        if (!src) return;
        img.dataset.dshCanvasLocalImage = '1';
        img.src = src;
      };
      const scan = (root) => {
        if (!root || root.nodeType !== 1) return;
        if (root.tagName === 'IMG') rewrite(root);
        if (root.querySelectorAll) root.querySelectorAll('img').forEach(rewrite);
      };
      document.querySelectorAll('img').forEach(rewrite);
      const observer = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes || []) scan(node);
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      const onError = (event) => {
        const target = event.target;
        if (target && target.tagName === 'IMG') rewrite(target);
      };
      window.addEventListener('error', onError, true);
      return () => {
        observer.disconnect();
        window.removeEventListener('error', onError, true);
      };
    }
    function stateEndpoint(cwd, project) {
      const q = project ? 'project=' + encodeURIComponent(project) : (cwd ? 'cwd=' + encodeURIComponent(cwd) : '');
      return '/dsh-canvas/state' + (q ? '?' + q : '');
    }
    // 每次完整快照写入都带单调递增的时间戳。不同聊天/旧版插件同时
    // 写入同一 canvas.json 时，host 可据此拒绝迟到的旧快照，避免删除内容
    // 被另一个聊天的旧状态“复活”。
    const CANVAS_CLIENT_ID = Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
    let lastCanvasSaveAt = 0;
    let lastCanvasChangeAt = 0;
    function markCanvasChanged(snapshot, previous) {
      if (!snapshot || typeof snapshot !== 'object') return snapshot;
      const previousMeta = previous && previous.dshMeta && typeof previous.dshMeta === 'object' ? previous.dshMeta : {};
      const changedAt = Math.max(Date.now(), lastCanvasChangeAt + 1);
      lastCanvasChangeAt = changedAt;
      const previousRevision = Number(previousMeta.revision || previousMeta.savedAt || 0);
      return {
        ...snapshot,
        dshMeta: {
          ...previousMeta,
          ...(snapshot.dshMeta && typeof snapshot.dshMeta === 'object' ? snapshot.dshMeta : {}),
          // 保存时携带“我基于哪个服务器版本修改”。另一个聊天若仍停留在
          // 旧版本，即使它稍后才触发 onChange，也不能把旧元素重新写回项目。
          baseRevision: previousRevision > 0 ? previousRevision : Number(previousMeta.baseRevision || 0),
          revision: changedAt,
          savedAt: changedAt,
          clientId: CANVAS_CLIENT_ID
        }
      };
    }
    function versionedCanvasState(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') return snapshot;
      const existingMeta = snapshot.dshMeta && typeof snapshot.dshMeta === 'object' ? snapshot.dshMeta : {};
      const existingRevision = Number(existingMeta.revision || existingMeta.savedAt || 0);
      const savedAt = existingRevision > 0 ? existingRevision : Math.max(Date.now(), lastCanvasSaveAt + 1);
      lastCanvasSaveAt = savedAt;
      return {
        ...snapshot,
        // 性能 v3（治本）：磁盘快照不再内嵌图片 base64。凡 fileId 能映射到
        // 元素 customData.dshSourcePath 的文件，落盘时只存 dshPath 引用；
        // 运行时快照（latestSnapshot）保持完整 dataURL，行为与归档/发送
        // 到聊天等管线无关。iframe 在 load 时按需还原（见 load 分支）。
        // 无磁盘路径的文件（如刚粘贴、尚未归档）继续内嵌，后续保存自愈。
        files: stripInlineFileData(snapshot),
        dshMeta: {
          ...existingMeta,
          revision: existingRevision > 0 ? existingRevision : savedAt,
          savedAt,
          clientId: CANVAS_CLIENT_ID
        }
      };
    }
    // 与服务端 IMAGE_MIME 白名单一致：只有 /dsh-canvas/image 能取回的
    // 扩展名才允许剥离（pdf/ai 文档源的预览路径不在其中，保持内嵌）。
    function restorablePathExt(path) {
      const m = /\.([a-z0-9]+)$/i.exec(String(path || ''));
      return m && ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp', 'svg'].indexOf(m[1].toLowerCase()) >= 0;
    }
    function stripInlineFileData(snapshot) {
      const files = snapshot.files && typeof snapshot.files === 'object' ? snapshot.files : null;
      if (!files) return snapshot.files;
      const pathByFileId = {};
      (snapshot.elements || []).forEach((item) => {
        if (!item || item.type !== 'image' || item.isDeleted || !item.fileId) return;
        const p = item.customData && item.customData.dshSourcePath;
        if (p && !pathByFileId[item.fileId] && restorablePathExt(p)) pathByFileId[item.fileId] = String(p);
      });
      let changed = false;
      const next = {};
      Object.keys(files).forEach((id) => {
        const f = files[id];
        const path = pathByFileId[id];
        if (f && typeof f.dataURL === 'string' && f.dataURL.startsWith('data:') && path) {
          next[id] = { id: f.id || id, mimeType: f.mimeType, dshPath: path, created: f.created, lastRetrieved: f.lastRetrieved };
          changed = true;
        } else {
          next[id] = f;
        }
      });
      return changed ? next : files;
    }
    function loadState(cwd, project) {
      return fetch(stateEndpoint(cwd, project), { method: 'GET', cache: 'no-store' })
        .then((r) => r.text())
        .then((t) => { try { return t && t !== 'null' ? JSON.parse(t) : null; } catch (e) { return null; } })
        .catch(() => null);
    }
    function saveState(json, cwd, project) {
      if (!json) return Promise.resolve();
      const body = typeof json === 'string' ? json : JSON.stringify(versionedCanvasState(json));
      return fetch(stateEndpoint(cwd, project), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        .catch(() => {});
    }
    function listProjects(cwd) {
      return fetch('/dsh-canvas/projects?cwd=' + encodeURIComponent(cwd), { cache: 'no-store' }).then((r) => r.json());
    }

    function basename(p) {
      const at = Math.max(String(p).lastIndexOf('/'), String(p).lastIndexOf('\\'));
      return at === -1 ? String(p) : String(p).slice(at + 1);
    }

    // DSH 历史图片有时只携带 attachmentId，没有本地文件路径。
    // 用稳定的内部标记暂存引用，渲染时通过 conversation.resolveImage() 换成 Blob URL。
    function attachmentMarker(ref) {
      if (!ref || !ref.attachmentId) return '';
      return 'dsh-attachment:' + [ref.attachmentId, ref.mediaType || 'image/png', ref.name || '']
        .map((value) => encodeURIComponent(String(value))).join(':');
    }
    function attachmentFromPath(value) {
      const match = /^dsh-attachment:([^:]*):([^:]*):(.*)$/.exec(String(value || ''));
      if (!match) return null;
      try {
        return {
          attachmentId: decodeURIComponent(match[1]),
          mediaType: decodeURIComponent(match[2]) || 'image/png',
          name: decodeURIComponent(match[3]) || ''
        };
      } catch (e) {
        return null;
      }
    }
    function imageName(path) {
      const ref = attachmentFromPath(path);
      return ref ? (ref.name || '生成图片') : basename(path);
    }

    function dataURLToFile(dataURL, name) {
      const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(String(dataURL || ''));
      if (!match) throw new Error('画布图片数据无效');
      const raw = atob(match[2]);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      const ext = match[1] === 'image/jpeg' ? 'jpg' : (match[1].split('/')[1] || 'png').replace('svg+xml', 'svg');
      return new File([bytes], String(name || 'canvas-selection').replace(/\.[a-zA-Z0-9]+$/, '') + '.' + ext, { type: match[1] });
    }

    function rasterizeSVGForChat(item, index) {
      const dataURL = String(item && item.dataURL || '');
      const sourceName = String(item && item.name || ('canvas-selection-' + (index + 1) + '.svg'));
      const mime = ((/^data:([^;,]+)/i.exec(dataURL) || [])[1] || '').toLowerCase();
      if (mime !== 'image/svg+xml') return Promise.resolve(dataURLToFile(dataURL, sourceName));
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          try {
            const sourceWidth = Math.max(1, Number(image.naturalWidth || item.width || 1600));
            const sourceHeight = Math.max(1, Number(image.naturalHeight || item.height || 1200));
            const preferredSide = 2048;
            const maxSide = 4096;
            const maxPixels = 16000000;
            const sourceMaxSide = Math.max(sourceWidth, sourceHeight);
            const scale = Math.min(
              Math.max(1, preferredSide / sourceMaxSide),
              maxSide / sourceMaxSide,
              Math.sqrt(maxPixels / (sourceWidth * sourceHeight))
            );
            const width = Math.max(1, Math.round(sourceWidth * scale));
            const height = Math.max(1, Math.round(sourceHeight * scale));
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            if (!context) throw new Error('当前窗口无法创建 SVG 预览图');
            // SVG、AI 与 PDF 在画布中使用透明 SVG 预览。聊天模型不接受
            // image/svg+xml，因此只在附件边界转成 PNG，源文件与画布数据不变。
            context.clearRect(0, 0, width, height);
            context.drawImage(image, 0, 0, width, height);
            canvas.toBlob((blob) => {
              if (!blob) { reject(new Error('SVG 转 PNG 失败')); return; }
              const pngName = sourceName.replace(/\.(?:svg|ai|pdf)$/i, '') + '.png';
              resolve(new File([blob], pngName, { type: 'image/png' }));
            }, 'image/png');
          } catch (err) { reject(err); }
        };
        image.onerror = () => reject(new Error('SVG 预览无法转换为聊天图片'));
        image.src = dataURL;
      });
    }

    // ---- image path extraction ----
    function resolveImagePath(value, cwdOverride) {
      let p = String(value || '').trim().replace(/^file:\/\//i, '');
      if (/^\/[A-Za-z]:[\\/]/.test(p)) p = p.slice(1);
      if (!p || p.indexOf('data:image/') === 0) return p;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return '';
      if (isLocalAbsolutePath(p)) return p;
      // 工具输出常带 ./ 前缀；先去掉再判断是否是被截掉首斜杠的 macOS 绝对路径。
      p = p.replace(/^\.\//, '');
      // 某些工具/模型在 XML 或富文本中会丢掉 macOS 绝对路径的首个 `/`，
      // 例如把 `/private/tmp/a.png` 输出成 `private/tmp/a.png`；不能再拼到项目 cwd 下。
      if (/^(?:private|tmp|Users|Volumes|Applications|Library|System|var|opt|usr|home|dev|etc|mnt|run)\//i.test(p)) return '/' + p;
      // 事件回放可能早于设计模式 dock 挂载。没有 cwd 时先保留原始相对路径，
      // 等会话上下文到达后在渲染阶段再次解析，避免“模型只显示路径”的丢图。
      // 聊天图像引擎的固定归档目录在画布项目内；模型最终回复常只写
      // 文件名。有当前画布项目时，裸文件名应优先指向该归档目录。
      if (p.indexOf('/') < 0 && p.indexOf('\\') < 0 && activeCanvasProjectPath) {
        return String(activeCanvasProjectPath).replace(/[\\/]+$/, '') + '/DSH聊天生成图片/' + p;
      }
      const cwd = String(cwdOverride || activeChatCwd || '').trim();
      if (!cwd) return p;
      const cwdNormalized = cwd.replace(/\\/g, '/');
      const drive = /^([A-Za-z]:)\//.exec(cwdNormalized);
      const parts = (cwdNormalized.replace(/[\\/]+$/, '') + '/' + p.replace(/^\.\//, '')).split('/');
      const normalized = [];
      for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') normalized.pop();
        else normalized.push(part);
      }
      if (drive) return drive[1] + '/' + normalized.slice(normalized[0] === drive[1] ? 1 : 0).join('/');
      return '/' + normalized.join('/');
    }
    const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#].*)?$/i;
    const IMAGE_MIME_RE = /^image\/(?:png|jpe?g|jpeg|webp|gif|avif|bmp|svg\+xml)(?:[;]|$)/i;
    function isDirectImageSource(value) {
      return typeof value === 'string' && /^(?:data:image\/|https?:\/\/|blob:)/i.test(value.trim());
    }
    function compactBase64(value) {
      return String(value || '').replace(/[\r\n\t\s]+/g, '');
    }
    function looksLikeBase64(value) {
      const compact = compactBase64(value);
      return compact.length >= 256 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact);
    }
    function pushImageCandidate(value, out, cwdOverride) {
      if (value == null) return;
      if (typeof value !== 'string') {
        if (typeof value === 'object') walkImagePayload(value, out, 0, cwdOverride);
        return;
      }
      const candidate = value.trim();
      if (!candidate) return;
      if (isDirectImageSource(candidate)) { out.push(candidate); return; }
      // Codex image_generation_call.result 常直接返回无 MIME 的 Base64；补成可直接预览的 PNG data URL。
      if (looksLikeBase64(candidate)) { out.push('data:image/png;base64,' + compactBase64(candidate)); return; }
      pushIfImage(candidate, out, cwdOverride);
    }
    function pushIfImage(p, out, cwdOverride) {
      if (!p || typeof p !== 'string') return;
      const candidate = p.trim();
      if (isDirectImageSource(candidate)) { out.push(candidate); return; }
      // 部分模型把本地沙箱文件写成 sandbox:/...，转换为当前主机可读的绝对路径。
      if (/^sandbox:(?:\/\/)?/i.test(candidate)) {
        const sandboxPath = candidate.replace(/^sandbox:(?:\/\/)?/i, '');
        pushIfImage(sandboxPath.charAt(0) === '/' ? sandboxPath : '/' + sandboxPath, out, cwdOverride);
        return;
      }
      if (/^file:\/\//i.test(candidate)) {
        const resolvedFile = resolveImagePath(candidate, cwdOverride);
        if (resolvedFile) out.push(resolvedFile);
        return;
      }
      // 远程图片只在明显带图片扩展名时接受，避免把普通网页链接当成图片输出。
      if (/^https?:\/\//i.test(candidate)) {
        if (IMAGE_EXT_RE.test(candidate)) out.push(candidate);
        return;
      }
      // Shell 回复常用 `*.png` 表示一批产物。通配符不是可读文件，
      // 若将它当成“最终图片”，会覆盖工具结果里已经可显示的真实附件。
      if (/[*\[\]{}]/.test(candidate.split(/[?#]/, 1)[0])) return;
      if (!IMAGE_EXT_RE.test(candidate)) return;
      const resolved = resolveImagePath(candidate, cwdOverride);
      if (resolved) out.push(resolved);
    }
    function collectImagePaths(text, out, cwdOverride) {
      if (!text) return;
      const source = String(text);
      let m;
      // 某些模型返回 JSON/结构化文本，先尝试解析完整 JSON，兼容 image_url、result 等字段。
      try {
        const trimmed = source.trim();
        if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') walkImagePayload(JSON.parse(trimmed), out, 0, cwdOverride);
      } catch (e) {}
      // 画布 imagegen 路由的归档路径写在 <output_path> 标签里；不提取它，
      // 附件就找不到同名源文件，新旧判定（mtime 过滤）会失效。
      const outputPathRe = /<output_path[^>]*>([^<]+)<\/output_path>/gi;
      while ((m = outputPathRe.exec(source))) pushIfImage(m[1].trim(), out, cwdOverride);
      const jsonRe = /"(?:image|image_url|imageUrl|file|file_path|filePath|path|url|result|b64_json|base64)"\s*:\s*(?:"([^"]+)"|\{[^}]*\})/gi;
      while ((m = jsonRe.exec(source))) pushImageCandidate(m[1], out, cwdOverride);
      const codePathRe = /`([^`\r\n]+\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#][^`\r\n]*)?)`/gi;
      while ((m = codePathRe.exec(source))) pushIfImage(m[1], out, cwdOverride);
      const plainText = source.replace(/`[^`\r\n]*`/g, ' ');
      // Markdown 图片路径经常是 macOS 绝对路径，中间包含空格。
      // 旧正则用 `[^)\s]+` 会在第一个空格处截断，导致消息最终只剩 alt 文字。
      // 同时支持 CommonMark 推荐的 `<...>` 包裹路径。
      const mdRe = /!\[[^\]]*\]\(\s*(?:<([^>\r\n]+)>|([^)\r\n]+?))\s*\)/g;
      while ((m = mdRe.exec(plainText))) {
        const markdownTarget = String(m[1] || m[2] || '').trim();
        if (!markdownTarget) continue;
        // 原生 DSH 图片组件允许没有扩展名的 http(s) 签名 URL。
        if (isDirectImageSource(markdownTarget)) out.push(markdownTarget);
        else pushIfImage(markdownTarget, out, cwdOverride);
      }
      // read_image 等工具会以 <path>/tmp/a.png</path> 返回，允许 XML 标签后的路径。
      const tagPathRe = /<(?:path|file|image-path|output)\s*>\s*([^<\r\n]+?\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#][^<\r\n]*)?)\s*<\//gi;
      while ((m = tagPathRe.exec(source))) pushIfImage(m[1], out, cwdOverride);
      const absRe = /(?:^|[\s"'`=(\[>])((?:\/|~\/)[^\s"'`<>()\[\]]+?\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#][^\s"'`<>()\[\]]*)?)(?=[\s"'`=)\],.;:]|$)/gi;
      while ((m = absRe.exec(plainText))) pushIfImage(m[1], out, cwdOverride);
      const relativeRe = /(?:^|[\s"'`=(\[>])((?![a-z][a-z0-9+.-]*:\/\/)(?:\.?\.?\/)?[^\s"'`<>()\[\]]*\/[^\s"'`<>()\[\]]+?\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#][^\s"'`<>()\[\]]*)?)(?=[\s"'`=)\],.;:，。]|$)/gi;
      while ((m = relativeRe.exec(plainText))) pushIfImage(m[1], out, cwdOverride);
      const bareFileRe = /(?:^|[\s"'`=(\[>：])([^\s\/"'`<>()\[\]：]+?\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai)(?:[?#][^\s"'`<>()\[\]]*)?)(?=[\s"'`=)\],.;:，。<]|$)/gi;
      while ((m = bareFileRe.exec(plainText))) pushIfImage(m[1], out, cwdOverride);
      // 修复旧正则没有捕获组导致 m[1] 为 undefined；同时支持 avif/bmp 与换行空白。
      const dataRe = /data:image\/(?:png|jpe?g|webp|gif|avif|bmp|svg\+xml);base64,[A-Za-z0-9+/=\s]+/gi;
      while ((m = dataRe.exec(plainText))) out.push(m[0].replace(/\s+/g, ''));
    }
    function walkImagePayload(value, out, depth, cwdOverride) {
      if (value == null || depth > 7) return;
      if (typeof value === 'string') { pushImageCandidate(value, out, cwdOverride); return; }
      if (Array.isArray(value)) {
        for (const item of value) walkImagePayload(item, out, depth + 1, cwdOverride);
        return;
      }
      if (typeof value !== 'object') return;
      if (value.attachmentId) {
        const marker = attachmentMarker(value);
        if (marker) out.push(marker);
        return;
      }
      const type = String(value.type || '').toLowerCase();
      for (const key of Object.keys(value)) {
        const child = value[key];
        const k = String(key).toLowerCase();
        if (k === 'text' && typeof child === 'string') {
          // 工具结果通常把图片路径放在 content[] -> text 中，不能只看第一层 block.text。
          collectImagePaths(child, out, cwdOverride);
          continue;
        }
        if ((k === 'attachment' || k === 'ref') && child && typeof child === 'object' && child.attachmentId) {
          const marker = attachmentMarker(child);
          if (marker) out.push(marker);
          continue;
        }
        const imageKey = k === 'image' || k === 'image_url' || k === 'imageurl' || k === 'file' || k === 'file_path' || k === 'filepath' || k === 'path' || k === 'url' || k === 'result' || k === 'partial_image_b64' || k === 'b64_json' || k === 'base64' || k === 'data_url' || /image|attachment|asset/.test(k);
        const containerKey = k === 'content' || k === 'message' || k === 'output' || k === 'response' || k === 'data' || k === 'body' || k === 'choices' || k === 'delta' || k === 'chunk' || k === 'block' || k === 'blocks' || k === 'tool' || k === 'tool_result' || k === 'items' || k === 'source' || k === 'meta';
        if (imageKey || containerKey || type.indexOf('image') >= 0 || type.indexOf('attachment') >= 0) {
          if (typeof child === 'string') pushImageCandidate(child, out, cwdOverride);
          else walkImagePayload(child, out, depth + 1, cwdOverride);
        }
      }
    }
    function dedupeImagePaths(paths) {
      const unique = [...new Set(paths)];
      const result = [];
      const byName = new Map();
      for (const path of unique) {
        const ref = attachmentFromPath(path);
        const direct = isDirectImageSource(path);
        if (ref || direct) {
          result.push(path);
          continue;
        }
        const name = imageName(path).toLowerCase();
        const previous = byName.get(name);
        if (!previous) {
          byName.set(name, path);
          result.push(path);
          continue;
        }
        // Markdown 常同时包含绝对图片链接和旁边的相对文件名；优先绝对路径，避免同图显示两次。
        const previousAbsolute = /^(?:\/|~\/)/.test(previous);
        const currentAbsolute = /^(?:\/|~\/)/.test(path);
        if (currentAbsolute && !previousAbsolute) {
          const index = result.indexOf(previous);
          if (index >= 0) result[index] = path;
          byName.set(name, path);
        }
      }
      return result;
    }
    function eventCwd(event) {
      const data = event && event.data;
      if (!data || typeof data !== 'object') return activeChatCwd;
      const candidates = [
        data.cwd,
        data.session && data.session.cwd,
        data.conversation && data.conversation.cwd,
        data.message && data.message.cwd,
        data.step && data.step.cwd,
        data.context && data.context.cwd
      ];
      return candidates.find((value) => typeof value === 'string' && value.trim()) || activeChatCwd;
    }
    function extractImagePaths(event) {
      const out = [];
      const data = event && event.data;
      if (!data) return [];
      // 兼容旧版 message.content.text，以及切换模型后常见的结构化 image_url / image_generation_call.result。
      const cwd = eventCwd(event);
      walkImagePayload(data, out, 0, cwd);
      const blocks = data.message && data.message.content;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block && typeof block.text === 'string') collectImagePaths(block.text, out, cwd);
        }
      }
      const unique = dedupeImagePaths(out);
      // 同一个工具结果可能同时返回路径和持久化附件。附件是会话授权的稳定字节，
      // 当两者同名时优先附件，避免临时路径失效后出现“图片加载失败”。
      const attachmentNames = new Set(unique
        .filter((path) => !!attachmentFromPath(path))
        .map((path) => imageName(path).toLowerCase()));
      // 返回条目而非裸路径：附件条目携带被去掉的同名文件路径（sourcePath），
      // 图片输出卡片靠它对源文件做 mtime 判定——本轮 read_image 的旧图附件
      // 才能被识别为“旧图引用”并从本轮卡片中过滤掉。
      return unique
        .filter((path) => {
          const ref = attachmentFromPath(path);
          return !!ref || !attachmentNames.has(imageName(path).toLowerCase());
        })
        .map((path) => {
          const ref = attachmentFromPath(path);
          if (!ref) return { path, sourcePath: '' };
          const wantedName = imageName(path).toLowerCase();
          const sourcePath = unique.find((p) => p !== path && !attachmentFromPath(p) && imageName(p).toLowerCase() === wantedName) || '';
          return { path, sourcePath };
        });
    }

    // “图片输出”不是通用的图片扫描器。新版 DSH 会把模型读过的参考图、
    // 裁剪检查图和工具中间附件都放进同一个 turn；只有 canvas imagegen
    // 路由明确标为 final 的产物才属于这里。
    function extractGeneratedImagePaths(event) {
      const data = event && event.data;
      if (!data) return [];
      let serialized = '';
      try { serialized = JSON.stringify(data); } catch (error) { return []; }
      if (serialized.indexOf('<canvas_image_output producer=\\"imagegen\\">final</canvas_image_output>') < 0
        && serialized.indexOf('<canvas_image_output producer="imagegen">final</canvas_image_output>') < 0) return [];
      return extractImagePaths(event).map((item) => ({ ...item, producer: 'imagegen' }));
    }

    // 最终助手回复里的图片名用来做“名字校准”（裸名映射回工具结果里的稳定
    // 附件引用），不再用来整体取舍。中间 tool/result 里的扫描/预览参考图
    // 由图片输出卡片的文件修改时间过滤负责隐藏。
    // 这里只读取可见 text block，不读取 reasoning、tool-call 参数。
    function extractAssistantVisibleImages(event) {
      const out = [];
      const data = event && event.data;
      if (!data) return out;
      const cwd = eventCwd(event);
      if (event.type === 'assistant/message') {
        const blocks = data.message && data.message.content;
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (!block || typeof block.text !== 'string') continue;
            const type = String(block.type || '').toLowerCase();
            if (type === 'text' || type === 'output_text' || type === 'markdown') {
              collectImagePaths(block.text, out, cwd);
            }
          }
        } else if (typeof blocks === 'string') {
          collectImagePaths(blocks, out, cwd);
        }
      } else if (event.type === 'assistant/chunk') {
        const chunk = data.chunk;
        const block = chunk && chunk.block;
        const type = block && String(block.type || '').toLowerCase();
        if (chunk && chunk.type === 'block-end' && block && typeof block.text === 'string' && (type === 'text' || type === 'output_text' || type === 'markdown')) {
          collectImagePaths(block.text, out, cwd);
        }
      }
      return dedupeImagePaths(out);
    }

    function reconcileFinalImages(existingImages, visiblePaths, seq, startTime) {
      const existing = Array.isArray(existingImages) ? existingImages : [];
      // 归档撞名时画布路由会自动加 “-2/-3” 去重后缀，而模型最终回复常写原始
      // 文件名。按名字匹配时把后缀剥掉再比，否则裸名匹配不到真实附件，会退化
      // 成不存在的归档路径被逐个隐藏，最终回复整轮没有图片输出卡片。
      const baseKeyOf = (name) => String(name).toLowerCase().replace(/-\d+(\.[a-z0-9]+)$/i, '$1');
      return visiblePaths.map((path) => {
        const wantedName = imageName(path).toLowerCase();
        const wantedBase = baseKeyOf(wantedName);
        const exact = existing.filter((item) => imageName(item.path).toLowerCase() === wantedName);
        const byBase = existing.filter((item) => {
          const name = imageName(item.path).toLowerCase();
          return name !== wantedName && baseKeyOf(name) === wantedBase;
        });
        // 最终回复经常只写“xxx.png”，而工具结果已经提供了可持久
        // 解析的 attachmentId 或绝对路径。最终文字只用来筛选同名产物，
        // 不能把真实引用降级成相对于聊天 cwd 的不存在路径。
        const sameName = exact.concat(byBase);
        const stable = sameName.find((item) => attachmentFromPath(item.path))
          || sameName.find((item) => isDirectImageSource(item.path) || isLocalAbsolutePath(item.path));
        return stable || { path, seq, startTime: startTime || 0, sourcePath: '' };
      });
    }
    // ---- turn-scoped accumulation ----
    const canvasImagesDefinition = {
      kind: 'canvas-images',
      match(event) {
        if (!event || !event.data || event.data.turn == null) return null;
        if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' };
        // 与 DSH/Codex 原生会话视图一致：替换型 assistant 消息只供模型内部使用，
        // 不应再次出现在用户可见的图片输出里。旧版本没有 surfaceOp 时保持兼容。
        if (event.type === 'assistant/message' && event.surfaceOp !== undefined && event.surfaceOp !== 'append') return null;
        // 不同模型/流式适配器可能在工具结果、消息收尾或 turn/end 携带图片；统一纳入同一轮去重。
        // assistant/chunk 仅处理 block-end，避免高频流式片段增加渲染和解析开销。
        if (event.type === 'assistant/chunk') {
          const chunkType = event.data.chunk && event.data.chunk.type;
          if (chunkType !== 'block-end') return null;
        }
        if (event.type === 'tool/result' || event.type === 'assistant/message' || event.type === 'assistant/chunk' || event.type === 'turn/end' || event.type === 'tool/end') return { id: String(event.data.turn), role: 'update' };
        return null;
      },
      start(_context, match) {
        // turn/start 的 time 是本轮开始的墙钟时间；图片输出卡片用它区分
        // “本轮新生成的文件”与“本轮只是读取/提及的旧文件”（按文件 mtime 判定）。
        return { turn: match.event.data.turn, images: [], finalImagesSeen: false, startTime: match.event.time || 0 };
      },
      update(context, match) {
        const found = extractGeneratedImagePaths(match.event);
        if (!found.length) return context.state;
        const images = [...context.state.images];
        const seen = new Set(images.map((i) => i.path));
        const additions = [];
        for (const entry of found) {
          const p = entry.path;
          if (seen.has(p)) continue;
          const incomingRef = attachmentFromPath(p);
          const incomingName = imageName(p).toLowerCase();
          // Codex wrapper 可能先输出“/ private/tmp/…”的文本路径，随后 read_image
          // 再返回同一图片的持久化附件。附件更可靠，替换掉先到的临时路径。
          if (incomingRef && incomingRef.name) {
            const staleIndex = images.findIndex((item) => !attachmentFromPath(item.path) && imageName(item.path).toLowerCase() === incomingName);
            if (staleIndex >= 0) {
              seen.delete(images[staleIndex].path);
              images.splice(staleIndex, 1);
            }
          } else {
            const attachmentIndex = images.findIndex((item) => {
              const ref = attachmentFromPath(item.path);
              return !!(ref && ref.name && ref.name.toLowerCase() === incomingName);
            });
            if (attachmentIndex >= 0) continue;
          }
          seen.add(p);
          const item = { path: p, seq: match.event.seq, startTime: context.state.startTime || 0, sourcePath: entry.sourcePath || '', producer: 'imagegen' };
          images.push(item);
          additions.push(item);
        }
        if (!additions.length) return context.state;
        return { ...context.state, images };
      },
      buildLocationData(context, scope) {
        if (scope !== 'turn' || !context.state) return null;
        return { kind: 'turn', turn: context.state.turn, key: 'canvas-images', value: { images: context.state.images } };
      }
    };

    // 只有图片输出卡片的“加入画布”按钮能拿到这个闭包内令牌。
    // 其它扫描、工具结果、项目文件同步都不能伪造加入事件。
    const CANVAS_ADD_TOKEN = Math.random().toString(36).slice(2) + Date.now().toString(36);
    function dispatchAddImage(path, url) {
      window.dispatchEvent(new CustomEvent('dsh-canvas:add-image', {
        detail: { path, url: url || displaySourceUrl(path), explicit: true, token: CANVAS_ADD_TOKEN }
      }));
    }
    // ---- 聊天生图自动上画布(1.9)----
    // 开关默认开启;批量生图或大量抽卡重跑时建议关闭,改回卡片上的手动「加入画布」。
    // 自动上画布只认宿主 /dsh-canvas/generation-status 登记的本轮产出路径,
    // 复用与手动按钮完全相同的令牌通道,不新增任何旁路。
    const autoAddDispatched = new Set();
    function canvasAutoAddEnabled() {
      try { return window.localStorage.getItem(AUTO_ADD_KEY) !== 'off'; } catch (err) { return true; }
    }
    function setCanvasAutoAddEnabled(value) {
      try { window.localStorage.setItem(AUTO_ADD_KEY, value ? 'on' : 'off'); } catch (err) {}
    }
    function dispatchGeneratedToCanvas(path) {
      if (!path || autoAddDispatched.has(path)) return false;
      autoAddDispatched.add(path);
      // 宿主登记的产出路径本身就是绝对归档路径,与手动按钮点击时
      // dispatchResolvedImage 拿到的 actionPath 同构,直接派发即可。
      dispatchResolvedImage(path);
      return true;
    }
    function revealImageInFinder(path) {
      if (attachmentFromPath(path)) {
        window.alert('这张图片是聊天历史附件，无法直接在系统文件管理器中定位');
        return;
      }
      const resolved = resolveImagePath(path);
      if (!resolved || resolved.indexOf('data:image/') === 0) {
        window.alert('这张图片没有可定位的本地文件');
        return;
      }
      fetch('/dsh-canvas/reveal-file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: resolved })
      })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((result) => {
          if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '无法在文件夹中显示');
        })
        .catch((err) => window.alert('无法在文件夹中显示：' + String((err && err.message) || err)));
    }
    // ---- turn-tail inline images ----
    function ImageTail(props) {
      // 新版 DSH(官方桌面)不再调用插槽 select:turnTail 列表项组件直接收到
      // {turn, seq, openFile} 插槽载荷,数据要从 turn.data 里自取;
      // 旧版把 select 结果作为 props.matched 传入。两条路都保留。
      let matched = Array.isArray(props.matched) ? props.matched : null;
      if (!matched && props.turn && props.turn.data && typeof props.turn.data.get === 'function') {
        try {
          const data = props.turn.data.get('canvas-images');
          const scoped = data && Array.isArray(data.images) ? data.images.filter((i) => i && props.seq != null ? i.seq <= props.seq : true) : [];
          matched = scoped.length ? scoped : null;
        } catch (error) { matched = null; }
      }
      // 旧版本曾把 turn 里所有图片都持久化进 canvas-images。没有明确
      // imagegen provenance 的旧条目在新版直接隐藏，避免升级后继续显示
      // 参考图、检查图、裁剪中间图与失效附件。
      const images = (matched || []).filter((item) => item && item.producer === 'imagegen');
      // 本轮开始时间由聚合节点写进每个条目；旧会话条目没有该字段时为 0，跳过新旧过滤。
      const turnStart = (images.length && images[0] && images[0].startTime) || 0;
      const [preview, setPreview] = React.useState(null);
      const [failed, setFailed] = React.useState({});
      const [swapped, setSwapped] = React.useState({});
      // 回退候选链的进度（path → 已尝试到第几级）、主机按名找回的真实路径、全部候选耗尽
      const [fallbackStep, setFallbackStep] = React.useState({});
      const [remap, setRemap] = React.useState({});
      const [exhausted, setExhausted] = React.useState({});
      const resolveAttempts = React.useRef({});
      const [hidden, setHidden] = React.useState({});
      const [resolvedSources, setResolvedSources] = React.useState({});
      const [contextRevision, setContextRevision] = React.useState(activeChatContextRevision);
      const key = images.map((i) => i.path).join('|');
      const archivedOutputPath = (path) => activeCanvasProjectPath
        ? String(activeCanvasProjectPath).replace(/[\\/]+$/, '') + '/DSH聊天生成图片/' + imageName(path)
        : '';
      const canonicalOutputPath = (path) => {
        if (!path || attachmentFromPath(path) || isDirectImageSource(path) || !activeCanvasProjectPath) return path;
        const normalized = String(path).replace(/\\/g, '/');
        if (normalized.indexOf('/') < 0 || normalized.indexOf('/DSH聊天生成图片/') >= 0) {
          return String(activeCanvasProjectPath).replace(/[\\/]+$/, '') + '/DSH聊天生成图片/' + imageName(path);
        }
        return path;
      };
      // 最后一级回退：让主机按文件名在当前项目 / 工作区常见目录里找回同名图片。
      // 覆盖两类真实故障：AI 文字里写的“计划路径”从未落盘；附件记录的 sourcePath 事后被移走。
      // 同一条目只请求一次；找到后写入 remap，成为候选链首项。
      const resolveByName = (img) => {
        const path = img && img.path;
        if (!path) return Promise.resolve('');
        if (remap[path]) return Promise.resolve(remap[path]);
        if (resolveAttempts.current[path]) return Promise.resolve('');
        resolveAttempts.current[path] = true;
        const nameSource = img.sourcePath && !attachmentFromPath(img.sourcePath) ? img.sourcePath : path;
        const url = '/dsh-canvas/resolve-image?name=' + encodeURIComponent(imageName(nameSource))
          + '&cwd=' + encodeURIComponent(activeChatCwd || '') + '&project=' + encodeURIComponent(activeCanvasProjectPath || '');
        return fetch(url, { cache: 'no-store' })
          .then((response) => (response.ok ? response.json() : null))
          .then((data) => {
            const found = data && data.ok && data.data && data.data.path ? String(data.data.path) : '';
            if (found) setRemap((prev) => (prev[path] === found ? prev : { ...prev, [path]: found }));
            return found;
          })
          .catch(() => '');
      };
      React.useEffect(() => {
        const onContext = () => setContextRevision(activeChatContextRevision);
        window.addEventListener('dsh-canvas:project-context', onContext);
        return () => window.removeEventListener('dsh-canvas:project-context', onContext);
      }, []);
      React.useEffect(() => {
        // 原生 DSH 的 resolveImage 缓存键包含 sessionId；切换会话时也要清掉
        // 组件本地的 Blob URL，避免不同会话复用同名 attachmentId。
        setResolvedSources({});
        setFailed({});
        setSwapped({});
        setFallbackStep({});
        setRemap({});
        setExhausted({});
        resolveAttempts.current = {};
        setHidden({});
        setPreview(null);
      }, [key, activeChatSessionId, contextRevision]);
      React.useEffect(() => {
        // 只校验本地路径；会话附件和远程/data URL 由各自的加载逻辑处理。
        // 文件刚由模型写入时可能有短暂竞态，因此最多重试 4 次，再隐藏确实
        // 不存在的引用。这样不会把“模型提到但没有生成”的路径渲染成破图卡片。
        // 存在性通过后还做新旧判定：源文件 mtime 早于本轮开始时间（留 2 秒
        // 文件系统时间戳容差）说明只是本轮引用的旧图（read_image 对比、文字
        // 提及旧版本），不属于本轮图片输出，同样隐藏。
        let cancelled = false;
        const hide = (path) => setHidden((prev) => (prev[path] ? prev : { ...prev, [path]: true }));
        const isStale = (data) => !!turnStart && !!data && data.ok === true && typeof data.mtime === 'number' && data.mtime < turnStart - 2000;
        const localImages = images.filter((img) => img && !attachmentFromPath(img.path) && !isDirectImageSource(img.path));
        const check = (img, attempt = 0) => {
          if (cancelled || !img) return;
          const resolved = resolveImagePath(canonicalOutputPath(img.path));
          // 事件可能早于当前会话 cwd 到达；等 project-context 事件触发后再检查。
          if (!resolved || !isLocalAbsolutePath(resolved)) return;
          const url = '/dsh-canvas/image-status?path=' + encodeURIComponent(resolved);
          fetch(url, { cache: 'no-store' }).then((response) => {
            if (cancelled) return;
            if (!response.ok) {
              if (attempt < 3) {
                setTimeout(() => check(img, attempt + 1), 250 * (attempt + 1));
                return;
              }
              // 路径确实不存在：同名文件可能在项目归档/assets 里（AI 写了计划路径）；找不到才隐藏。
              resolveByName(img).then((found) => { if (!cancelled && !found) hide(img.path); });
              return;
            }
            response.json().then((data) => {
              if (cancelled || !data || !data.ok) return;
              if (isStale(data)) hide(img.path);
            }).catch(() => {});
          }).catch(() => {
            if (cancelled) return;
            if (attempt < 3) {
              setTimeout(() => check(img, attempt + 1), 250 * (attempt + 1));
            } else {
              resolveByName(img).then((found) => { if (!cancelled && !found) hide(img.path); });
            }
          });
        };
        // 附件条目（imagegen / read_image 结果）用同名 sourcePath 做同样的新旧判定；
        // 没有文件可查的纯附件（DSH 原生 imagegen）无法判定，保持显示。
        const checkAttachmentAge = (img) => {
          if (cancelled || !img || !img.sourcePath || attachmentFromPath(img.sourcePath) || !turnStart) return;
          const resolved = resolveImagePath(canonicalOutputPath(img.sourcePath));
          if (!resolved || !isLocalAbsolutePath(resolved)) return;
          fetch('/dsh-canvas/image-status?path=' + encodeURIComponent(resolved), { cache: 'no-store' })
            .then((response) => (response.ok ? response.json() : null))
            .then((data) => {
              if (cancelled || !data) return;
              if (isStale(data)) hide(img.path);
            })
            .catch(() => {});
        };
        localImages.forEach((img) => {
          if (!hidden[img.path]) check(img);
        });
        images.forEach((img) => {
          if (img && img.sourcePath && !hidden[img.path]) checkAttachmentAge(img);
        });
        return () => { cancelled = true; };
      }, [key, activeChatSessionId, contextRevision, turnStart]);
      const visibleImages = images.filter((img) => !hidden[img.path]);
      React.useEffect(() => {
        let cancelled = false;
        const pending = visibleImages.filter((img) => attachmentFromPath(img.path) && !resolvedSources[img.path] && !failed[img.path]);
        if (!pending.length) return () => { cancelled = true; };
        Promise.all(pending.map((img) => resolveAttachmentSource(img.path)
          .then((url) => ({ path: img.path, url }))
          .catch(() => ({ path: img.path, error: true }))))
          .then((results) => {
            if (cancelled) return;
            const next = {};
            const errors = {};
            for (const result of results) {
              if (result.url) next[result.path] = result.url;
              if (result.error) errors[result.path] = true;
            }
            if (Object.keys(next).length) setResolvedSources((prev) => ({ ...prev, ...next }));
            if (Object.keys(errors).length) setFailed((prev) => ({ ...prev, ...errors }));
          });
        return () => { cancelled = true; };
      }, [key, activeChatSessionId, contextRevision]);
      // 自动上画布开启且当前聊天已绑定项目：最终产物会自动进入画布，
      // 聊天尾部不再重复展示一套“加入画布”卡片。未绑定项目时仍保留，
      // 让用户能看到并手动处理生成结果。
      if (!visibleImages.length || (canvasAutoAddEnabled() && activeCanvasProjectPath)) return null;
      // 附件条目的可操作文件路径：优先条目自带 sourcePath（归档真实文件），
      // 其次当前画布项目拼接路径，最后退回附件引用本身（交给附件解析）。
      const actionPathOf = (img) => {
        if (!img) return '';
        if (remap[img.path]) return remap[img.path];
        if (!attachmentFromPath(img.path)) return canonicalOutputPath(img.path);
        return (img.sourcePath && !attachmentFromPath(img.sourcePath) && img.sourcePath) || archivedOutputPath(img.path) || img.path;
      };
      // 回退候选链：**逐级尝试**而不是取第一个非空，且本地文件优先（即时、可靠），
      // DSH 附件 blob 解析经常悬而不决，只作为附件条目的末级。
      //   附件条目：（主机找回的路径）→ 条目 sourcePath → 当前项目归档同名 → 附件 blob
      //   普通路径：（主机找回的路径）→ 原路径 → 条目 sourcePath → 当前项目归档同名；远程/data URL 直通
      // 链耗尽后再向主机按文件名找回一次；仍无则标记 exhausted，渲染整洁的失败卡。
      const sourceStateOf = (img) => {
        const isAttachment = attachmentFromPath(img.path);
        const canonicalPath = canonicalOutputPath(img.path);
        const chain = [];
        const pushLocal = (candidate) => {
          if (!candidate || attachmentFromPath(candidate) || isDirectImageSource(candidate)) return;
          const resolvedCandidate = resolveImagePath(candidate);
          if (!resolvedCandidate || !isLocalAbsolutePath(resolvedCandidate)) return;
          if (chain.some((entry) => entry.kind === 'local' && entry.path === candidate)) return;
          chain.push({ kind: 'local', path: candidate });
        };
        pushLocal(remap[img.path]);
        if (!isAttachment) pushLocal(canonicalPath);
        if (img.sourcePath) pushLocal(img.sourcePath);
        pushLocal(archivedOutputPath(img.path));
        if (isAttachment) chain.push({ kind: 'blob' });
        if (!isAttachment && !chain.length) {
          // 远程 / data URL：没有本地候选，直通显示
          const direct = displaySourceUrl(canonicalPath);
          return { isAttachment, chain, step: 0, entry: null, src: direct, actionPath: canonicalPath, loading: false, waitingBlob: false };
        }
        const step = Math.min(fallbackStep[img.path] || 0, Math.max(0, chain.length - 1));
        const entry = chain[step];
        const blobUrl = resolvedSources[img.path] || '';
        const src = entry.kind === 'local' ? displaySourceUrl(entry.path) : blobUrl;
        const waitingBlob = entry.kind === 'blob' && !blobUrl && !failed[img.path];
        const actionPath = entry.kind === 'local' ? entry.path : actionPathOf(img);
        return { isAttachment, chain, step, entry, src, actionPath, loading: !exhausted[img.path] && (!src || waitingBlob), waitingBlob };
      };
      const advanceFallback = (img, state) => {
        if (!state.chain.length) { setExhausted((prev) => (prev[img.path] ? prev : { ...prev, [img.path]: true })); return; }
        const next = state.step + 1;
        if (next < state.chain.length) {
          setFallbackStep((prev) => ({ ...prev, [img.path]: next }));
          return;
        }
        resolveByName(img).then((found) => {
          const alreadyTried = state.chain.some((entry) => entry.kind === 'local' && entry.path === found);
          if (found && !alreadyTried) {
            // remap 成为候选链首项：回到第 0 级重新加载
            setFallbackStep((prev) => ({ ...prev, [img.path]: 0 }));
            return;
          }
          setExhausted((prev) => (prev[img.path] ? prev : { ...prev, [img.path]: true }));
        });
      };
      // 附件 blob 解析报错（failed）或超过 6 秒仍未返回时，末级不再等待：
      // 降级到主机按名找回，仍无则渲染失败卡。DSH 旧会话的 resolveImage 可能永远不结算。
      React.useEffect(() => {
        const timers = [];
        visibleImages.forEach((img) => {
          if (!attachmentFromPath(img.path) || exhausted[img.path]) return;
          const state = sourceStateOf(img);
          if (!state.entry || state.entry.kind !== 'blob' || resolvedSources[img.path]) return;
          if (failed[img.path]) { advanceFallback(img, state); return; }
          timers.push(setTimeout(() => {
            const fresh = sourceStateOf(img);
            if (fresh.entry && fresh.entry.kind === 'blob' && !resolvedSources[img.path] && !exhausted[img.path]) advanceFallback(img, fresh);
          }, 6000));
        });
        return () => { timers.forEach((t) => clearTimeout(t)); };
      }, [failed, fallbackStep, remap, resolvedSources, key]);
      const send = (path) => dispatchResolvedImage(canonicalOutputPath(path));
      const rows = visibleImages.map((img) => {
        // 旧会话的 attachmentId 可能随 DSH 更新或会话回放失效，附件记录的 sourcePath 也可能事后被移走；
        // 画布路由已把原图归档到项目目录。sourceStateOf 给出当前应尝试的源与剩余候选。
        const state = sourceStateOf(img);
        const src = state.src;
        const actionPath = state.actionPath;
        const loading = state.loading;
        return React.createElement('div', { key: img.path, className: 'dsh-canvas-image' },
          React.createElement('button', {
            className: 'dsh-canvas-image-box dsh-canvas-image-send',
            title: '点击查看大图',
            onClick: () => setPreview(img)
          },
            exhausted[img.path]
              ? React.createElement('span', { className: 'dsh-canvas-image-loading' }, '图片加载失败')
              : loading
                ? React.createElement('span', { className: 'dsh-canvas-image-loading' }, '图片加载中…')
              : React.createElement('img', {
                src,
                alt: imageName(img.path),
                className: 'dsh-canvas-image-img',
                loading: 'lazy',
                decoding: 'async',
                referrerPolicy: 'no-referrer',
                onLoad: () => { if (exhausted[img.path]) setExhausted((prev) => ({ ...prev, [img.path]: false })); },
                onError: () => { advanceFallback(img, state); }
              })
          ),
          React.createElement('div', { className: 'dsh-canvas-image-meta' },
            React.createElement('span', { className: 'dsh-canvas-image-name', title: actionPath }, imageName(img.path)),
            React.createElement('div', { className: 'dsh-canvas-image-actions' },
              React.createElement('button', { className: 'dsh-canvas-add-btn', title: '在系统文件管理器中选中这个文件', onClick: () => revealImageInFinder(actionPath) }, '在文件夹中显示'),
              React.createElement('button', { className: 'dsh-canvas-add-btn', onClick: () => dispatchResolvedImage(actionPath) }, '加入画布')
            )
          )
        );
      });
      const columns = visibleImages.length === 1 ? 1 : (visibleImages.length <= 4 ? 2 : 3);
      return React.createElement(React.Fragment, null,
        React.createElement('div', { key, className: 'dsh-canvas-tool-output' },
          React.createElement('div', { className: 'dsh-canvas-tool-bar' },
            React.createElement('span', { className: 'dsh-canvas-tool-title' }, '图片输出'),
            React.createElement('span', { className: 'dsh-canvas-tool-count' }, visibleImages.length + ' 张'),
            React.createElement('button', { className: 'dsh-canvas-tool-btn', onClick: () => visibleImages.forEach((img) => send(actionPathOf(img))) }, '全部加入画布')
          ),
          React.createElement('div', { className: 'dsh-canvas-images dsh-canvas-images-cols-' + columns }, rows)
        ),
        preview ? React.createElement('div', { className: 'dsh-canvas-lightbox', role: 'dialog', 'aria-modal': 'true', onClick: () => setPreview(null) },
          React.createElement('div', { className: 'dsh-canvas-lightbox-inner', onClick: (event) => event.stopPropagation() },
            (() => {
              // 大图与缩略图同源：附件优先归档文件（sourcePath 回退），避免
              // 项目未绑定时大图永远“加载中”。
              const previewState = sourceStateOf(preview);
              const previewSrc = previewState.src;
              return previewSrc && !exhausted[preview.path]
                ? React.createElement('img', { src: previewSrc, alt: imageName(preview.path), className: 'dsh-canvas-lightbox-image', decoding: 'async', referrerPolicy: 'no-referrer', onError: () => advanceFallback(preview, previewState) })
                : React.createElement('span', { className: 'dsh-canvas-image-loading' }, exhausted[preview.path] ? '图片加载失败' : '图片加载中…');
            })(),
            React.createElement('div', { className: 'dsh-canvas-lightbox-bar' },
              React.createElement('span', { title: actionPathOf(preview) }, imageName(preview.path)),
              React.createElement('button', { onClick: () => revealImageInFinder(actionPathOf(preview)) }, '在文件夹中显示'),
              React.createElement('button', { onClick: () => send(actionPathOf(preview)) }, '加入画布'),
              React.createElement('button', { onClick: () => setPreview(null) }, '关闭')
            )
          )
        ) : null
      );
    }
    // ---- 原生图片展示带(0.2.0 桌面 imagegen 输出)注入「加入画布」----
    // 新版 DSH 用自己的横向缩略图带渲染 imagegen 工具输出;缩略图 src 走本插件
    // 的 /dsh-canvas/image 路由,据此识别并逐张挂按钮。与轮次尾图片输出卡片走
    // 同一 CANVAS_ADD_TOKEN 令牌通道(dispatchAddImage),不自建旁路;插件自有
    // 表面(类名 dsh-canvas- 前缀)不重复装饰。
    (function () {
      if (typeof MutationObserver !== 'function' || typeof document === 'undefined') return;
      const ROUTE_MARK = '/dsh-canvas/image?path=';
      const inPluginSurface = (node) => {
        for (let el = node; el && el !== document.body; el = el.parentElement) {
          const raw = el.className;
          const cls = String(raw && raw.baseVal !== undefined ? raw.baseVal : raw || '');
          if (cls.indexOf('dsh-canvas') >= 0) return true;
        }
        return false;
      };
      const pathOf = (img) => {
        try {
          const src = String(img.getAttribute('src') || '');
          const idx = src.indexOf(ROUTE_MARK);
          if (idx < 0) return '';
          return decodeURIComponent(src.slice(idx + ROUTE_MARK.length).split('&', 1)[0] || '');
        } catch (err) { return ''; }
      };
      const decorate = (img) => {
        if (!img || img.dataset.dshCanvasNativeBtn) return;
        const path = pathOf(img);
        if (!path || inPluginSurface(img)) return;
        img.dataset.dshCanvasNativeBtn = '1';
        const host = img.closest('a, figure, div') || img.parentElement;
        if (!host || host.dataset.dshCanvasNativeHost) return;
        host.dataset.dshCanvasNativeHost = '1';
        try {
          if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        } catch (err) {}
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = '加入画布';
        btn.setAttribute('style', [
          'position:absolute', 'right:6px', 'bottom:6px', 'z-index:5',
          'padding:3px 9px', 'border-radius:6px',
          'border:1px solid var(--dsh-border, rgba(148,163,184,.4))',
          'background:var(--dsh-surface, rgba(15,23,42,.82))',
          'color:var(--dsh-fg, #f8fafc)',
          'font-size:11px', 'line-height:1.5', 'cursor:pointer',
          'opacity:0', 'transition:opacity .15s ease'
        ].join(';') + ';backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)');
        const show = () => { btn.style.opacity = '1'; };
        const hide = () => { btn.style.opacity = '0'; };
        host.addEventListener('mouseenter', show, { passive: true });
        host.addEventListener('mouseleave', hide, { passive: true });
        btn.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          try { dispatchAddImage(path, '/dsh-canvas/image?path=' + encodeURIComponent(path)); } catch (err) {}
        });
        host.appendChild(btn);
      };
      let sweepScheduled = false;
      const sweep = () => {
        sweepScheduled = false;
        try { document.querySelectorAll('img[src*="' + ROUTE_MARK + '"]').forEach(decorate); } catch (err) {}
      };
      const scheduleSweep = () => {
        if (sweepScheduled) return;
        sweepScheduled = true;
        window.setTimeout(sweep, 120);
      };
      const start = () => {
        sweep();
        try {
          new MutationObserver(scheduleSweep).observe(document.body, { childList: true, subtree: true });
        } catch (err) {}
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
      else start();
    })();
    // ---- OCR text rebuild panel (multi-region, review-first) ----
    // OCR is deliberately review-first: the user can disable or correct every
    // candidate before a PSD is generated.  The source image is never changed.
    function TextRebuildPanel(props) {
      const data = props.data || {};
      const normalizeSelections = (value) => {
        const list = Array.isArray(value) ? value : (value ? [value] : []);
        return list.filter((item) => item && Number(item.width || 0) >= 6 && Number(item.height || 0) >= 6);
      };
      const [selections, setSelections] = React.useState(normalizeSelections(data.selections || data.selection));
      const rectsIntersect = (a, b) => {
        const ax = Number(a && a.x || 0), ay = Number(a && a.y || 0), aw = Number(a && a.width || 0), ah = Number(a && a.height || 0);
        const bx = Number(b && b.x || 0), by = Number(b && b.y || 0), bw = Number(b && b.width || 0), bh = Number(b && b.height || 0);
        const iw = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
        const ih = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
        if (iw <= 0 || ih <= 0) return false;
        const area = iw * ih;
        const blockArea = Math.max(1, aw * ah);
        const centerX = ax + aw / 2, centerY = ay + ah / 2;
        return area >= blockArea * 0.15 || (centerX >= bx && centerX <= bx + bw && centerY >= by && centerY <= by + bh);
      };
      const blockInSelections = (block, regions) => Array.isArray(regions) && regions.length > 0 && regions.some((region) => rectsIntersect(block, region));
      const normalizeBlocks = (value, regions) => (Array.isArray(value) ? value : []).map((item) => ({
        ...item,
        // Full-image OCR is only a candidate list.  A row becomes an actual
        // removal target after it intersects a user-drawn region.
        enabled: blockInSelections(item, regions) && item.enabled !== false
      }));
      const [blocks, setBlocks] = React.useState(normalizeBlocks(data.blocks, normalizeSelections(data.selections || data.selection)));
      const [draftSelection, setDraftSelection] = React.useState(null);
      const [imageSize, setImageSize] = React.useState({ width: Number(data.width || 0), height: Number(data.height || 0) });
      const [dragging, setDragging] = React.useState(false);
      const [zoomed, setZoomed] = React.useState(false);
      const [zoom, setZoom] = React.useState(1);
      const [pan, setPan] = React.useState({ x: 0, y: 0 });
      const [panning, setPanning] = React.useState(false);
      const imageRef = React.useRef(null);
      const naturalImageSizeRef = React.useRef({ width: 0, height: 0, source: '' });
      const zoomRef = React.useRef(1);
      const panRef = React.useRef({ x: 0, y: 0 });
      const panStartRef = React.useRef(null);
      const selectionStartRef = React.useRef(null);
      const draftSelectionRef = React.useRef(null);
      React.useEffect(() => {
        const regions = normalizeSelections(data.selections || data.selection);
        setBlocks(normalizeBlocks(data.blocks, regions));
      }, [data.blocks, data.selections, data.selection]);
      React.useEffect(() => {
        setSelections(normalizeSelections(data.selections || data.selection));
        setDraftSelection(null);
        // 接口回包里的 width/height 可能是预览尺寸或模型输入尺寸，
        // 不能在识别返回后覆盖浏览器已读到的图片真实像素尺寸。
        // 否则旧选区会突然按另一套比例重绘，表现为框选整体偏移。
        if (!naturalImageSizeRef.current.width && (data.width || data.height)) {
          setImageSize({ width: Number(data.width || 0), height: Number(data.height || 0) });
        }
      }, [data.selections, data.selection, data.width, data.height]);
      React.useEffect(() => {
        naturalImageSizeRef.current = { width: 0, height: 0, source: String(data.dataURL || '') };
        if (data.width || data.height) setImageSize({ width: Number(data.width || 0), height: Number(data.height || 0) });
      }, [data.dataURL]);
      React.useEffect(() => { zoomRef.current = zoom; }, [zoom]);
      React.useEffect(() => { panRef.current = pan; }, [pan]);
      const update = (index, patch) => setBlocks((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
      const enabledCount = blocks.filter((item) => item && item.enabled !== false && String(item.text || '').trim()).length;
      const addRow = () => setBlocks((current) => current.concat([{ id: 'manual-' + Date.now(), text: '', originalText: '', x: 24, y: 24, width: 320, height: 48, fontSize: 32, fontFamily: 'PingFang SC', fontPostScript: 'PingFangSC-Regular', fontWeight: 'normal', color: '#111827', confidence: null, enabled: selections.length > 0 }]));
      const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
      const clampZoom = (value) => clamp(Number(value) || 1, 0.25, 4);
      const setPreviewZoom = (value) => {
        const next = clampZoom(value);
        zoomRef.current = next;
        setZoom(next);
      };
      const resetPreviewView = () => {
        zoomRef.current = 1;
        panRef.current = { x: 0, y: 0 };
        setZoom(1);
        setPan({ x: 0, y: 0 });
      };
      const openZoomPreview = () => {
        resetPreviewView();
        setZoomed(true);
      };
      const wheelZoom = (event) => {
        if (!event || !event.deltaY) return;
        event.preventDefault();
        setPreviewZoom(zoomRef.current * (event.deltaY < 0 ? 1.15 : (1 / 1.15)));
      };
      const beginPan = (event) => {
        if (!event || (event.button !== 1 && !(event.button === 0 && event.target === event.currentTarget))) return;
        event.preventDefault();
        panStartRef.current = { clientX: event.clientX, clientY: event.clientY, x: panRef.current.x, y: panRef.current.y };
        setPanning(true);
        if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
      };
      const movePan = (event) => {
        const start = panStartRef.current;
        if (!panning || !start) return;
        event.preventDefault();
        const next = { x: start.x + event.clientX - start.clientX, y: start.y + event.clientY - start.clientY };
        panRef.current = next;
        setPan(next);
      };
      const endPan = (event) => {
        if (!panning) return;
        setPanning(false);
        panStartRef.current = null;
        if (event && event.currentTarget && event.currentTarget.releasePointerCapture && event.pointerId != null) {
          try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (e) {}
        }
      };
      const pointFromEvent = (event) => {
        // The overlay is the actual pointer coordinate space.  Do not use the
        // shared image ref here: the normal and zoom previews can coexist and
        // React will then point the ref at whichever image mounted last.
        const overlay = event && event.currentTarget;
        const wrapper = overlay && overlay.parentElement;
        const image = wrapper && wrapper.querySelector('img');
        if (!overlay || !image) return null;
        // 以真正可见的图片边界为坐标系，不以弹窗、留白容器或
        // object-fit 后的外层 overlay 为基准。缩放和平移已包含在该 rect 中。
        const rect = image.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const width = Number(image.naturalWidth || imageSize.width || rect.width);
        const height = Number(image.naturalHeight || imageSize.height || rect.height);
        return { x: clamp((event.clientX - rect.left) * width / rect.width, 0, width), y: clamp((event.clientY - rect.top) * height / rect.height, 0, height) };
      };
      const beginSelection = (event) => {
        if (data.busy || data.loading || event.button !== 0) return;
        const point = pointFromEvent(event);
        if (!point) return;
        event.preventDefault();
        if (event.currentTarget.setPointerCapture) event.currentTarget.setPointerCapture(event.pointerId);
        selectionStartRef.current = point;
        draftSelectionRef.current = { x: point.x, y: point.y, width: 0, height: 0 };
        setDragging(true);
        setDraftSelection(draftSelectionRef.current);
      };
      const moveSelection = (event) => {
        if (!dragging) return;
        const point = pointFromEvent(event);
        const start = selectionStartRef.current;
        if (!point || !start) return;
        event.preventDefault();
        const next = { x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) };
        draftSelectionRef.current = next;
        setDraftSelection(next);
      };
      const endSelection = (event) => {
        if (!dragging) return;
        setDragging(false);
        const point = pointFromEvent(event);
        const start = selectionStartRef.current;
        selectionStartRef.current = null;
        if (!point || !start) { draftSelectionRef.current = null; setDraftSelection(null); return; }
        const next = { x: Math.min(start.x, point.x), y: Math.min(start.y, point.y), width: Math.abs(point.x - start.x), height: Math.abs(point.y - start.y) };
        draftSelectionRef.current = null;
        setDraftSelection(null);
        if (next.width >= 6 && next.height >= 6) {
          const nextRegions = selections.concat([next]);
          setSelections(nextRegions);
          setBlocks((rows) => rows.map((item) => ({ ...item, enabled: blockInSelections(item, nextRegions) })));
          if (typeof props.onSelectionsChange === 'function') props.onSelectionsChange(nextRegions);
        }
      };
      const clearSelections = () => {
        setSelections([]);
        setDraftSelection(null);
        draftSelectionRef.current = null;
        selectionStartRef.current = null;
        setBlocks((rows) => rows.map((item) => ({ ...item, enabled: false })));
        if (typeof props.onSelectionsChange === 'function') props.onSelectionsChange([]);
      };
      const applySelections = () => {
        setBlocks((rows) => rows.map((item) => ({ ...item, enabled: blockInSelections(item, selections) })));
        if (typeof props.onSelectionsChange === 'function') props.onSelectionsChange(selections);
      };
      const visualSelectionStyle = (item) => item && imageSize.width > 0 && imageSize.height > 0 ? {
        left: (item.x / imageSize.width * 100) + '%',
        top: (item.y / imageSize.height * 100) + '%',
        width: (item.width / imageSize.width * 100) + '%',
        height: (item.height / imageSize.height * 100) + '%'
      } : null;
      const visualSelections = draftSelection ? selections.concat([draftSelection]) : selections;
      return React.createElement('div', { className: 'dsh-text-rebuild-overlay', onPointerDown: (event) => event.stopPropagation() },
        React.createElement('div', { className: 'dsh-text-rebuild-panel', role: 'dialog', 'aria-modal': 'true' },
          React.createElement('div', { className: 'dsh-text-rebuild-head' },
            React.createElement('div', null,
              React.createElement('div', { className: 'dsh-text-rebuild-title' }, '编辑图片文字'),
              React.createElement('div', { className: 'dsh-text-rebuild-subtitle' }, data.name || '当前选中图片', ' · 模型识别仅作候选，请逐条确认')
            ),
            React.createElement('button', { className: 'dsh-text-rebuild-close', disabled: !!data.busy, onClick: props.onClose }, '×')
          ),
          React.createElement('div', { className: 'dsh-text-rebuild-body' },
            React.createElement('div', { className: 'dsh-text-rebuild-preview' },
              data.dataURL ? React.createElement('div', { className: 'dsh-text-select-wrap' },
                React.createElement('img', { ref: imageRef, src: data.dataURL, alt: data.name || '图片预览', decoding: 'async', onLoad: (event) => { const next = { width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1, source: String(data.dataURL || '') }; naturalImageSizeRef.current = next; setImageSize({ width: next.width, height: next.height }); } }),
                React.createElement('div', { className: 'dsh-text-select-overlay', onPointerDown: beginSelection, onPointerMove: moveSelection, onPointerUp: endSelection, onPointerCancel: endSelection },
                  visualSelections.map((item, index) => React.createElement('div', { key: 'selection-' + index, className: 'dsh-text-select-box', style: visualSelectionStyle(item) })),
                  null
                )
              ) : null,
              data.dataURL && !data.loading ? React.createElement('button', { type: 'button', className: 'dsh-text-select-zoom', onClick: openZoomPreview }, '放大编辑 · 框选文字') : null,
              selections.length ? React.createElement('div', { className: 'dsh-text-select-actions' },
                React.createElement('span', { className: 'dsh-text-select-coords' }, '已框选 ' + selections.length + ' 个待移除区域'),
                React.createElement('button', { type: 'button', disabled: !!data.busy || !!data.loading, onClick: () => props.onDetect(selections) }, data.loading ? '理解中…' : '识别选区'),
                React.createElement('button', { type: 'button', disabled: !!data.busy || !!data.loading, onClick: clearSelections }, '清除选区')
              ) : React.createElement('div', { className: 'dsh-text-select-actions' },
                React.createElement('span', { className: 'dsh-text-select-coords' }, '请先框选需要移除并重建的文字区域'),
                React.createElement('button', { type: 'button', disabled: true }, '识别选区')
              )
            ),
            React.createElement('div', { className: 'dsh-text-rebuild-info' },
              data.loading ? React.createElement('div', { className: 'dsh-text-rebuild-empty' }, '当前聊天模型正在理解选区…') : null,
              !data.loading && !blocks.length ? React.createElement('div', { className: 'dsh-text-rebuild-empty' }, data.hasDetected ? '模型未在选区内找到可用文字，请调整选区后重试。' : '框选后点击“识别选区”，模型只理解选区内文字和背景。') : null,
              blocks.map((item, index) => React.createElement('div', { key: item.id || index, className: 'dsh-text-rebuild-row' },
                React.createElement('div', { className: 'dsh-text-rebuild-row-top' },
                  React.createElement('input', { type: 'checkbox', checked: item.enabled !== false, disabled: !!data.busy, onChange: (event) => update(index, { enabled: event.target.checked }) }),
                  React.createElement('span', { className: 'dsh-text-rebuild-confidence' }, item.confidence == null ? '手动' : '置信度 ' + item.confidence + '%'),
                  item.styleConfidence != null ? React.createElement('span', { className: 'dsh-text-rebuild-confidence' }, '样式推测 ' + Math.round(Number(item.styleConfidence) * 100) + '%') : null,
                  React.createElement('span', { className: 'dsh-text-rebuild-box' }, Math.round(Number(item.x || 0)) + ', ' + Math.round(Number(item.y || 0)) + ' · ' + Math.round(Number(item.width || 0)) + '×' + Math.round(Number(item.height || 0)))
                ),
                React.createElement('textarea', { value: item.text || '', disabled: !!data.busy, placeholder: '输入要保留或替换的文字', onChange: (event) => update(index, { text: event.target.value }) }),
                React.createElement('div', { className: 'dsh-text-rebuild-row-controls' },
                  React.createElement('label', null, '字号', React.createElement('input', { type: 'number', min: 8, max: 220, value: item.fontSize || 24, disabled: !!data.busy, onChange: (event) => update(index, { fontSize: Number(event.target.value) || 24 }) })),
                  React.createElement('label', null, '字体', React.createElement('select', { value: textRebuildFontValue(item), disabled: !!data.busy, onChange: (event) => update(index, { fontPostScript: event.target.value, fontFamily: event.target.value }) },
                    TEXT_REBUILD_FONTS.map((group) => React.createElement('optgroup', { key: group.group, label: group.group },
                      group.items.map((font) => React.createElement('option', { key: font.ps, value: font.ps }, font.label)))
                  ))),
                  React.createElement('label', null, '颜色', React.createElement('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(String(item.color || '')) ? item.color : '#111827', disabled: !!data.busy, onChange: (event) => update(index, { color: event.target.value }) })),
                  React.createElement('button', { type: 'button', disabled: !!data.busy, onClick: () => update(index, { enabled: false }) }, '排除')
                )
              )),
              !data.loading ? React.createElement('button', { className: 'dsh-text-rebuild-add', disabled: !!data.busy, onClick: addRow }, '+ 新增文字') : null
            )
          ),
          React.createElement('div', { className: 'dsh-text-rebuild-foot' },
            React.createElement('div', { className: 'dsh-text-rebuild-note' }, data.error ? data.error : (enabledCount ? ('模型已理解 ' + enabledCount + ' 个文字对象；框外文字与图像保持不变。') : '先框选，再让当前聊天模型理解选区，确认后由工具执行清理。')),
            React.createElement('div', { className: 'dsh-text-rebuild-actions' },
              React.createElement('button', { className: 'dsh-text-rebuild-cancel', disabled: !!data.busy, onClick: props.onClose }, '取消'),
              React.createElement('button', { className: 'dsh-text-rebuild-export', disabled: !!data.busy || data.loading || enabledCount === 0, onClick: () => props.onExport(blocks, true, selections) }, data.busy ? '正在清理并生成…' : '清理背景并生成 PSD'),
              React.createElement('button', { className: 'dsh-text-rebuild-export', disabled: !!data.busy || data.loading || enabledCount === 0, title: '与 PSD 同构：由 Illustrator 脚本生成原生点文字层并保存为 .ai；不可用时退回 SVG', onClick: () => props.onExport(blocks, true, selections, 'ai') }, data.busy ? '正在清理并生成…' : '生成 AI（Illustrator）')
            )
          ),
          zoomed && data.dataURL ? React.createElement('div', { className: 'dsh-text-zoom-overlay', role: 'dialog', 'aria-modal': 'true' },
            React.createElement('div', { className: 'dsh-text-zoom-dialog', onPointerDown: (event) => event.stopPropagation() },
              React.createElement('div', { className: 'dsh-text-zoom-head' },
                React.createElement('div', { className: 'dsh-text-zoom-head-main' },
                  React.createElement('strong', null, '放大预览'),
                  React.createElement('span', null, '框选需要编辑的文字区域 · 滚轮缩放 · 中键拖动')
                ),
                React.createElement('div', { className: 'dsh-text-zoom-tools' },
                  React.createElement('button', { type: 'button', title: '缩小', onClick: () => setPreviewZoom(zoomRef.current / 1.2) }, '−'),
                  React.createElement('span', { className: 'dsh-text-zoom-value' }, Math.round(zoom * 100) + '%'),
                  React.createElement('button', { type: 'button', title: '放大', onClick: () => setPreviewZoom(zoomRef.current * 1.2) }, '+'),
                  React.createElement('button', { type: 'button', className: 'dsh-text-zoom-fit', onClick: resetPreviewView }, '适应'),
                  React.createElement('button', { type: 'button', className: 'dsh-text-zoom-close', onClick: () => setZoomed(false) }, '×')
                ),
              ),
              React.createElement('div', { className: 'dsh-text-zoom-stage', onWheel: wheelZoom, onPointerDown: beginPan, onPointerMove: movePan, onPointerUp: endPan, onPointerCancel: endPan, onPointerLeave: endPan, style: { cursor: panning ? 'grabbing' : (zoom > 1 ? 'grab' : 'default') } },
                React.createElement('div', { className: 'dsh-text-select-wrap dsh-text-select-wrap-large', style: { transform: 'translate(' + pan.x + 'px,' + pan.y + 'px) scale(' + zoom + ')' } },
                  React.createElement('img', { ref: imageRef, src: data.dataURL, alt: data.name || '图片放大预览', decoding: 'async', onLoad: (event) => { const next = { width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1, source: String(data.dataURL || '') }; naturalImageSizeRef.current = next; setImageSize({ width: next.width, height: next.height }); } }),
                  React.createElement('div', { className: 'dsh-text-select-overlay', onPointerDown: beginSelection, onPointerMove: moveSelection, onPointerUp: endSelection, onPointerCancel: endSelection },
                    visualSelections.map((item, index) => React.createElement('div', { key: 'zoom-selection-' + index, className: 'dsh-text-select-box', style: visualSelectionStyle(item) }))
                  )
                )
              ),
              selections.length ? React.createElement('div', { className: 'dsh-text-zoom-actions' },
                React.createElement('span', { className: 'dsh-text-select-coords' }, '已框选 ' + selections.length + ' 个待移除区域'),
                React.createElement('button', { type: 'button', disabled: !!data.busy || !!data.loading, onClick: () => { props.onDetect(selections); setZoomed(false); } }, data.loading ? '理解中…' : '识别选区'),
                React.createElement('button', { type: 'button', disabled: !!data.busy || !!data.loading, onClick: clearSelections }, '清除选区')
              ) : React.createElement('div', { className: 'dsh-text-zoom-actions' },
                React.createElement('span', { className: 'dsh-text-select-coords' }, '请先框选需要移除的文字区域'),
                React.createElement('button', { type: 'button', disabled: true }, '识别选区')
              )
            )
          ) : null
        )
      );
    }

    // ---- design-mode toggle in the composer dock ----
    let conversationApi = null;
    let clientRootContext = null;
    let modelDirectoriesApi = null;
    let dshConfigurationHelper = null;
    let activeChatModelSelection = null;
    let activeChatCwd = '';
    let activeChatSessionId = '';
    let activeCanvasProjectPath = '';
    let activeChatContextRevision = 0;
    function conversationServiceUsable(service) {
      // 新版官方桌面把 createDraftImages(sessionId, files) 改名为 createDrafts;
      // 两条签名都认,旧版 DSH 不受影响。
      return Boolean(service) && (typeof service.createDrafts === 'function' || typeof service.createDraftImages === 'function');
    }
    function currentConversationService() {
      if (conversationApi && conversationServiceUsable(conversationApi)) return conversationApi;
      var root = clientRootContext;
      var candidate = null;
      try { candidate = root && typeof root.get === 'function' ? (root.get('conversation') || root.get('uiConversation')) : null; } catch (e) {}
      if (!candidate) {
        try { candidate = root && (root.conversation || root.uiConversation) || null; } catch (e) {}
      }
      if (candidate) conversationApi = candidate;
      return candidate;
    }
    async function waitForConversationService() {
      for (var attempt = 0; attempt < 12; attempt += 1) {
        var service = currentConversationService();
        if (service && conversationServiceUsable(service)) return service;
        await new Promise(function(resolve){setTimeout(resolve,100);});
      }
      return null;
    }
    function setActiveChatContext(cwd, sessionId) {
      const nextCwd = String(cwd || '').trim();
      const nextSessionId = String(sessionId || '');
      if (activeChatCwd === nextCwd && activeChatSessionId === nextSessionId) return;
      activeChatCwd = nextCwd;
      activeChatSessionId = nextSessionId;
      activeChatContextRevision += 1;
      window.dispatchEvent(new CustomEvent('dsh-canvas:project-context', {
        detail: { cwd: activeChatCwd, sessionId: activeChatSessionId }
      }));
    }
    async function resolveAttachmentSource(path) {
      const ref = attachmentFromPath(path);
      const service = await waitForConversationService();
      if (!ref || !service || !activeChatSessionId || typeof service.imageUrl !== 'function') {
        return Promise.reject(new Error('图片附件暂不可用'));
      }
      return Promise.resolve(service.imageUrl(activeChatSessionId, ref));
    }
    function dispatchResolvedImage(path) {
      if (attachmentFromPath(path)) {
        resolveAttachmentSource(path)
          .then((url) => dispatchAddImage(path, url))
          .catch(() => {});
        return;
      }
      dispatchAddImage(path, displaySourceUrl(path));
    }
    // 聊天输入区的生图比例选择：值域与宿主 image-engine-settings 白名单一一对应。
    // 编辑/擦除不经过这里（跟随原图尺寸）；生成数量仅 API 引擎生效。
    const IMAGE_RATIO_OPTIONS = [
      { value: '1024x1024', label: '1:1', px: '1024', icon: [15, 15] },
      { value: '1536x1024', label: '3:2', px: '1536×1024', icon: [18, 12] },
      { value: '1024x1536', label: '2:3', px: '1024×1536', icon: [12, 18] },
      { value: '1280x960', label: '4:3', px: '1280×960', icon: [18, 13.5] },
      { value: '960x1280', label: '3:4', px: '960×1280', icon: [13.5, 18] },
      { value: '1920x1080', label: '16:9', px: '1920×1080', icon: [20, 11.25] },
      { value: '1080x1920', label: '9:16', px: '1080×1920', icon: [11.25, 20] },
      { value: '2560x1080', label: '21:9', px: '2560×1080', icon: [21, 9] },
      { value: '1080x2560', label: '9:21', px: '1080×2560', icon: [9, 21] },
      { value: '2048x1024', label: '2:1', px: '2048×1024', icon: [20, 10] },
      { value: '1024x2048', label: '1:2', px: '1024×2048', icon: [10, 20] },
      { value: '1280x1024', label: '5:4', px: '1280×1024', icon: [17, 13.6] },
      { value: '1024x1280', label: '4:5', px: '1024×1280', icon: [13.6, 17] }
    ];
    const IMAGE_COUNT_OPTIONS = [1, 2, 4, 8];
    function ratioOptionLabel(option) {
      return option.label + (option.tag ? ' ' + option.tag : '');
    }

    function DesignModeToggle(props) {
      const [on, setOn] = React.useState(getMode());
      const [attachState, setAttachState] = React.useState('');
      const [genAsk, setGenAsk] = React.useState({ show: false, active: 0 });
      const [imageRatio, setImageRatio] = React.useState('auto');
      const [imageCount, setImageCount] = React.useState(1);
      const [ratioOpen, setRatioOpen] = React.useState(false);
      const [ratioAnchor, setRatioAnchor] = React.useState(null);
      const ratioWrapRef = React.useRef(null);
      const [modelCapabilityRevision, setModelCapabilityRevision] = React.useState(0);
      const sessionSummary = props.useSessions((state) => state && state.byId ? state.byId[props.sessionId] : undefined);
      React.useEffect(() => {
        const update = () => setModelCapabilityRevision((value) => value + 1);
        window.addEventListener('dsh-canvas:model-directories-ready', update);
        return () => window.removeEventListener('dsh-canvas:model-directories-ready', update);
      }, []);
      React.useEffect(() => {
        activeChatModelSelection = null;
        // 模型追踪诊断:分级上报断点(无 API/无会话/无目录/正常),与标题栏探针同通道。
        const reportModelStage = (stage, extra) => {
          fetch('/dsh-canvas/client-debug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelTracking: { stage, ...extra }, at: Date.now() })
          }).catch(() => {});
        };
        if (!modelDirectoriesApi) { reportModelStage('no-api'); return; }
        if (!props.sessionId) { reportModelStage('no-session'); return; }
        if (typeof modelDirectoriesApi.directoryFor !== 'function') { reportModelStage('api-shape'); return; }
        let directory;
        try { directory = modelDirectoriesApi.directoryFor(props.sessionId); } catch (e) { reportModelStage('directoryFor-threw', { error: String(e && e.message || e) }); return; }
        if (!directory) { reportModelStage('no-directory'); return; }
        const update = () => {
          try {
            const snapshot = directory.store.getSnapshot();
            if (snapshot && snapshot.current) activeChatModelSelection = { ...snapshot.current };
            // 模型追踪诊断:与标题栏探针同一通道,远程可读(Win 模型识别走不通排查用)。
            reportModelStage('ok', {
              snapshotKeys: snapshot ? Object.keys(snapshot) : null,
              current: snapshot && snapshot.current
                ? { provider: snapshot.current.provider || null, model: snapshot.current.model || snapshot.current.id || null }
                : null
            });
          } catch (e) {}
        };
        update();
        try { directory.load().then(update).catch(() => {}); } catch (e) {}
        return directory.store && typeof directory.store.subscribe === 'function' ? directory.store.subscribe(update) : undefined;
      }, [props.sessionId, modelCapabilityRevision]);
      React.useEffect(() => subscribeMode(setOn), []);
      React.useEffect(() => {
        fetch('/dsh-canvas/image-settings').then((r) => r.json()).then((d) => {
          if (d && d.ok) {
            if (d.imageSize) setImageRatio(String(d.imageSize));
            if (d.imageCount) setImageCount(Number(d.imageCount) || 1);
          }
        }).catch(() => {});
      }, []);
      React.useEffect(() => {
        if (!ratioOpen) return;
        const onDocDown = (e) => {
          if (ratioWrapRef.current && !ratioWrapRef.current.contains(e.target)) setRatioOpen(false);
        };
        const onKey = (e) => { if (e.key === 'Escape') setRatioOpen(false); };
        document.addEventListener('mousedown', onDocDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDocDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [ratioOpen]);
      const applyImageRatio = (value) => {
        setRatioOpen(false);
        if (value === imageRatio) return;
        setImageRatio(value);
        fetch('/dsh-canvas/image-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageSize: value })
        }).catch(() => {});
      };
      const applyImageCount = (value) => {
        if (value === imageCount) return;
        setImageCount(value);
        fetch('/dsh-canvas/image-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageCount: value })
        }).catch(() => {});
      };
      React.useEffect(() => {
        const onGenState = (event) => {
          const detail = event.detail || {};
          setGenAsk({ show: Boolean(detail.show), active: Number(detail.active) || 0 });
        };
        window.addEventListener('dsh-canvas:gen-state', onGenState);
        return () => window.removeEventListener('dsh-canvas:gen-state', onGenState);
      }, []);
      React.useEffect(() => {
        if (sessionSummary && sessionSummary.cwd) {
          setActiveChatContext(sessionSummary.cwd, props.sessionId || '');
        }
      }, [sessionSummary && sessionSummary.cwd, props.sessionId]);
      React.useEffect(() => {
        const receive = async (event) => {
          const images = event.detail && Array.isArray(event.detail.images) ? event.detail.images : [];
          const batchIndex = Number(event.detail && event.detail.index || 0);
          const batchTotal = Number(event.detail && event.detail.total || images.length);
          if (!images.length) { setAttachState('⚠ 没有取得所选图片数据'); return; }
          // 新版官方桌面把 addImages 改名为 addAttachments;旧版保留原名。
          const attachToInput = props.inputActions
            ? (props.inputActions.addAttachments || props.inputActions.addImages)
            : null;
          if (typeof attachToInput !== 'function') { setAttachState('⚠ 当前聊天输入框暂不可附加图片'); return; }
          const attachmentApi = await waitForConversationService();
          if (!attachmentApi) { setAttachState('⚠ DSH 会话附件服务尚未就绪，请稍后再点一次'); return; }
          try {
            const files = await Promise.all(images.map((item, index) => rasterizeSVGForChat(item, index)));
            // createDrafts(新) 需要 sessionId;createDraftImages(旧) 只收文件列表。
            const drafts = typeof attachmentApi.createDrafts === 'function'
              ? attachmentApi.createDrafts(props.sessionId || activeChatSessionId || '', files)
              : attachmentApi.createDraftImages(files);
            if (!attachToInput.call(props.inputActions, drafts.map((item) => item.id))) {
              const release = attachmentApi.releaseDraftAttachments || attachmentApi.releaseDraftImages;
              if (typeof release === 'function') release.call(attachmentApi, drafts);
              setAttachState('图片附件数量或大小超出限制');
              return;
            }
            setAttachState(batchTotal > 1
              ? '✓ 已附加 ' + Math.min(batchTotal, batchIndex || drafts.length) + '/' + batchTotal + ' 张画布图片'
              : '✓ 已附加 ' + drafts.length + ' 张画布图片，请输入修改要求');
          } catch (err) {
            setAttachState('⚠ ' + String((err && err.message) || err));
          }
        };
        window.addEventListener('dsh-canvas:attach-selection', receive);
        return () => window.removeEventListener('dsh-canvas:attach-selection', receive);
      }, [props.inputActions, props.sessionId]);
      const toggleRatioPopover = (e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const viewportWidth = window.innerWidth || 1024;
        setRatioAnchor({ left: Math.max(8, Math.min(rect.left, viewportWidth - 336)), top: rect.top });
        setRatioOpen((v) => !v);
      };
      const currentRatioOption = IMAGE_RATIO_OPTIONS.find((option) => option.value === imageRatio);
      const countSuffix = imageCount > 1 ? ' ×' + imageCount : '';
      const ratioPopover = ratioOpen && ratioAnchor ? React.createElement('div', {
        className: 'dsh-canvas-ratio-pop',
        style: { left: ratioAnchor.left + 'px', top: ratioAnchor.top + 'px' }
      },
        React.createElement('div', { className: 'dsh-canvas-ratio-pop-title' }, '生图比例'),
        React.createElement('div', { className: 'dsh-canvas-ratio-grid' },
          IMAGE_RATIO_OPTIONS.map((option) => React.createElement('button', {
            key: option.value,
            className: 'dsh-canvas-ratio-card' + (imageRatio === option.value ? ' is-selected' : ''),
            title: option.px,
            onClick: () => applyImageRatio(option.value)
          },
            React.createElement('span', {
              className: 'dsh-canvas-ratio-card-icon',
              style: { width: option.icon[0] + 'px', height: option.icon[1] + 'px' }
            }),
            React.createElement('span', { className: 'dsh-canvas-ratio-card-label' }, ratioOptionLabel(option)),
            React.createElement('span', { className: 'dsh-canvas-ratio-card-px' }, option.px)
          ))
        ),
        React.createElement('button', {
          className: 'dsh-canvas-ratio-auto' + (imageRatio === 'auto' ? ' is-selected' : ''),
          onClick: () => applyImageRatio('auto')
        }, '✦ 自动 · 由模型决定'),
        React.createElement('div', { className: 'dsh-canvas-ratio-pop-title' }, '生成数量'),
        React.createElement('div', { className: 'dsh-canvas-ratio-count-row' },
          IMAGE_COUNT_OPTIONS.map((count) => React.createElement('button', {
            key: count,
            className: 'dsh-canvas-ratio-count' + (imageCount === count ? ' is-selected' : ''),
            onClick: () => applyImageCount(count)
          }, '×' + count))
        ),
        React.createElement('div', { className: 'dsh-canvas-ratio-pop-note' }, '聊天生图与聊天编辑生效（dsh-codex 引擎按所选比例居中裁切）；画布编辑 / 智能擦除跟随原图尺寸，数量恒为 1')
      ) : null;
      return React.createElement('div', { className: 'dsh-canvas-dock' },
        React.createElement('button', {
          className: 'dsh-canvas-mode' + (on ? ' dsh-canvas-mode-on' : ''),
          title: on ? '关闭设计模式（隐藏右侧画布）' : '开启设计模式（右侧显示无限画布）',
          onClick: toggleMode
        },
          React.createElement('span', { className: 'dsh-canvas-mode-dot' }),
          React.createElement('span', null, '设计模式'),
          React.createElement('span', { className: 'dsh-canvas-mode-state' }, on ? '开' : '关')
        ),
        // 比例芯片跟随设计模式:关闭时整组隐藏(生图回到纯手动/原生行为)。
        on ? React.createElement('div', { className: 'dsh-canvas-ratio-wrap', ref: ratioWrapRef },
          React.createElement('button', {
            className: 'dsh-canvas-ratio-chip' + (imageRatio !== 'auto' ? ' dsh-canvas-ratio-chip-set' : ''),
            title: '生图比例与数量：选择后聊天生图优先使用',
            onClick: toggleRatioPopover
          },
            React.createElement('span', null, (currentRatioOption ? ratioOptionLabel(currentRatioOption) : '自动比例') + countSuffix),
            React.createElement('span', { className: 'dsh-canvas-ratio-chip-caret' }, '⌄')
          ),
          ratioPopover
        ) : null,
        attachState ? React.createElement('span', { className: 'dsh-canvas-attach-state' }, attachState) : null,
        on && genAsk.show ? React.createElement('span', { className: 'dsh-canvas-gen-ask' },
          React.createElement('span', { className: 'dsh-canvas-gen-ask-text' },
            genAsk.active > 0 ? '🎨 正在生成图片，本聊天还没绑定画布项目：' : '🎨 生成的图片还没上画布——本聊天未绑定画布项目：'),
          React.createElement('button', { onClick: () => window.dispatchEvent(new CustomEvent('dsh-canvas:project-pick')) }, '选择已有项目'),
          React.createElement('button', { onClick: () => window.dispatchEvent(new CustomEvent('dsh-canvas:project-new')) }, '新建画布'),
          React.createElement('button', { className: 'dsh-canvas-gen-ask-dismiss', onClick: () => window.dispatchEvent(new CustomEvent('dsh-canvas:project-dismiss')) }, '本次手动加入')
        ) : null
      );
    }

    // ---- 内联自 src/shared/utils/adobe-bridge.js（构建期去 import/export；请改源文件） ----
    // Adobe 桥接：纯函数共享模块（无 Node / DOM 依赖）。Host 直接 import；客户端由 build-manifest 内联。
    // 目录名、清单命名、序号、路径判定都集中在这里——改协议先改 adobe-bridge/PROTOCOL.md，再改这里。
    const ADOBE_BRIDGE_PROTOCOL = 1;
    const ADOBE_BRIDGE_DIR = 'ADOBE桥接';
    const ADOBE_BRIDGE_INBOX = Object.freeze({ photoshop: '来自Photoshop', illustrator: '来自Illustrator' });
    const ADOBE_BRIDGE_OUTBOX = '发件箱';
    const ADOBE_BRIDGE_APPS = Object.freeze(['photoshop', 'illustrator']);
    const ADOBE_BRIDGE_APP_LABELS = Object.freeze({ photoshop: 'Photoshop', illustrator: 'Illustrator' });
    // 画布可原样返回给 Adobe 的文件类型（图片按图片、分层按分层，不做转换）。
    const ADOBE_BRIDGE_RETURNABLE = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'psd', 'ai', 'svg', 'pdf']);

    /** 路径是否位于项目的 ADOBE桥接/ 目录下（通用自动上画布要跳过它，交给桥接轮询器）。 */
    function isAdobeBridgePath(path) {
      return /[\\/]ADOBE桥接[\\/]/.test(String(path || ''));
    }

    /** 是否为待处理清单：`*.json` 但不是 `*.done.json` / `*.failed.json`。 */
    function isPendingBridgeManifest(name) {
      const value = String(name || '');
      return /\.json$/i.test(value) && !/\.(done|failed)\.json$/i.test(value);
    }

    /** 文件名安全化：去掉路径分隔与非法字符，折叠空白，限长；空值用 fallback。 */
    function sanitizeBridgeName(value, fallback) {
      const cleaned = String(value || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
      const capped = cleaned.length > 60 ? cleaned.slice(0, 60).trim() : cleaned;
      return capped || String(fallback || '文件');
    }

    /** 发件箱序号：扫描现有文件名的 `NNNN-` 前缀取最大值 +1（永不覆盖历史）。 */
    function nextOutboxSeq(names) {
      let max = 0;
      for (const name of names || []) {
        const match = /^(\d{4,})[-.]/.exec(String(name || ''));
        if (match) max = Math.max(max, Number(match[1]) || 0);
      }
      return max + 1;
    }

    function padSeq(seq) {
      return String(Math.max(1, Number(seq) || 1)).padStart(4, '0');
    }

    /** 发件文件名：`0007-标题-画布.psd`。 */
    function outboxFileName(seq, name, fallbackExt) {
      const safe = sanitizeBridgeName(name, '画布图片' + (fallbackExt ? '.' + fallbackExt : ''));
      return padSeq(seq) + '-' + safe;
    }

    function bridgeExtOf(name) {
      const value = String(name || '');
      const dot = value.lastIndexOf('.');
      return dot > 0 ? value.slice(dot + 1).toLowerCase() : '';
    }

    function isReturnableBridgeFile(name) {
      return ADOBE_BRIDGE_RETURNABLE.includes(bridgeExtOf(name));
    }

    /** 校验收件清单结构（脚本写的 JSON）。返回 { ok, error, manifest }；不做磁盘检查。 */
    function validateInboundManifest(raw) {
      if (!raw || typeof raw !== 'object') return { ok: false, error: '清单不是对象' };
      if (Number(raw.protocol) !== ADOBE_BRIDGE_PROTOCOL) return { ok: false, error: '协议版本不匹配：' + raw.protocol };
      if (!ADOBE_BRIDGE_APPS.includes(raw.app)) return { ok: false, error: '未知 app：' + raw.app };
      if (!raw.jobId || typeof raw.jobId !== 'string') return { ok: false, error: '缺少 jobId' };
      if (!Array.isArray(raw.items) || !raw.items.length) return { ok: false, error: '清单 items 为空' };
      for (const item of raw.items) {
        if (!item || typeof item.file !== 'string' || !item.file) return { ok: false, error: '清单 item 缺少 file' };
        if (/[\\/]/.test(item.file)) return { ok: false, error: '清单 item.file 不能含路径：' + item.file };
      }
      return { ok: true, manifest: raw };
    }

    /** 生成发件清单对象（写盘前的最终结构；脚本按此读取）。 */
    function buildOutboundManifest({ seq, targetApp, files, origin, createdAt }) {
      const at = Number(createdAt) || Date.now();
      const stamp = new Date(at);
      const pad = (n) => String(n).padStart(2, '0');
      const jobId = 'out-' + stamp.getFullYear() + pad(stamp.getMonth() + 1) + pad(stamp.getDate()) + '-' + pad(stamp.getHours()) + pad(stamp.getMinutes()) + pad(stamp.getSeconds()) + '-' + padSeq(seq);
      return {
        protocol: ADOBE_BRIDGE_PROTOCOL,
        jobId,
        seq: Number(seq) || 1,
        targetApp: ADOBE_BRIDGE_APPS.includes(targetApp) ? targetApp : 'photoshop',
        createdAt: at,
        files: (files || []).map((f) => ({ file: String(f.file || ''), name: String(f.name || f.file || ''), kind: String(f.kind || bridgeExtOf(f.file) || 'png') })),
        origin: origin && typeof origin === 'object' ? origin : null,
        placement: 'auto'
      };
    }


    // Adobe 桥接（客户端半边）。协议契约：adobe-bridge/PROTOCOL.md；纯函数/常量来自内联的
    // shared/utils/adobe-bridge.js（ADOBE_BRIDGE_APP_LABELS / isAdobeBridgePath …）。
    //
    //   收件：createAdobeBridgePoller —— 画布可见且已绑项目时每 3s：心跳 activate → 拉取 inbound
    //         → 未在画布的文件 add-image（customData.dshBridge 打印出处）→ ack 清单。
    //   发件：requestAdobeBridgeReturn —— srcdoc「→Ps / →Ai」按钮的 request-bridge-return 消息 → host /return。
    //   安装：fetchAdobeBridgeInstallStatus + installAdobeBridgeScripts / installAdobeBridgeCepPanel ——
    //         「更多」菜单只在检测到缺失时显示对应安装按钮（详见函数注释）。
    //
    // 通用"项目新文件自动上画布"会跳过 ADOBE桥接/ 下的路径（isAdobeBridgePath），避免与这里重复添加。
    const ADOBE_BRIDGE_POLL_MS = 3000;
    const adobeBridgeQuery = (current) => 'cwd=' + encodeURIComponent(current.cwd || '') + '&project=' + encodeURIComponent(current.project || '');
    const adobeBridgeJson = (url, body) => fetch(url, body === undefined
      ? { cache: 'no-store' }
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    ).then((r) => r.json().then((data) => ({ ok: r.ok, data })));

    /**
     * @param {object} deps
     * @param {() => {cwd?:string, project?:string, sessionId?:string}} deps.getProject
     * @param {(path:string) => boolean} deps.isLinked 画布上是否已有该源文件
     * @param {(path:string) => boolean} deps.isQueued 是否已在加入队列
     * @param {(items: object[]) => void} deps.addImages 交给 pendingRef + flushPending
     * @param {(text:string) => void} deps.setFeedback
     */
    function createAdobeBridgePoller({ getProject, isLinked, isQueued, addImages, setFeedback }) {
      let timer = 0;
      let disposed = false;
      let busy = false;
      const schedule = () => {
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(tick, ADOBE_BRIDGE_POLL_MS);
      };
      const tick = async () => {
        if (disposed) return;
        const current = getProject() || {};
        if (busy || document.visibilityState !== 'visible' || !current.project) { schedule(); return; }
        busy = true;
        try {
          const heartbeat = { cwd: current.cwd || '', project: current.project || '', sessionId: current.sessionId || '' };
          await adobeBridgeJson('/dsh-canvas/adobe-bridge/activate', heartbeat).catch(() => null);
          const result = await adobeBridgeJson('/dsh-canvas/adobe-bridge/inbound?' + adobeBridgeQuery(current));
          if (disposed || !result.ok || !result.data || !result.data.ok || !Array.isArray(result.data.jobs)) return;
          for (const job of result.data.jobs) {
            const items = Array.isArray(job.items) ? job.items : [];
            const fresh = items.filter((item) => item && item.path && !isLinked(item.path) && !isQueued(item.path));
            if (fresh.length) {
              addImages(fresh.map((item) => ({
                path: item.path, name: item.name, mtime: item.mtime, size: item.size, kind: item.kind, url: item.url, managed: true, explicit: true,
                customData: { dshBridge: { jobId: job.jobId, app: job.app, layer: item.layer && item.layer.name || '', document: job.document && job.document.name || '' } }
              })));
            }
            await adobeBridgeJson('/dsh-canvas/adobe-bridge/ack', { ...heartbeat, manifest: job.manifestName }).catch(() => null);
            const label = ADOBE_BRIDGE_APP_LABELS[job.app] || job.app;
            const names = items.map((item) => (item.layer && item.layer.name) || item.name).join('、');
            setFeedback('✓ 已从 ' + label + ' 接收 ' + items.length + ' 张图片' + (fresh.length !== items.length ? '（' + (items.length - fresh.length) + ' 张已在画布）' : '') + '：' + names);
          }
        } catch (err) {
          // 轮询失败静默重试；host 不在线时 fetch 直接 reject，不打扰用户。
        } finally {
          busy = false;
          schedule();
        }
      };
      return {
        start() { disposed = false; clearTimeout(timer); void tick(); },
        stop() { disposed = true; clearTimeout(timer); }
      };
    }

    /** srcdoc「→Ps / →Ai」→ 写发件箱；host 会顺手远程置入运行中的 PS/AI（用户不必开面板）。detail: { app, items:[…] } */
    function requestAdobeBridgeReturn(current, detail, setFeedback) {
      const app = ADOBE_BRIDGE_APPS.includes(detail && detail.app) ? detail.app : 'photoshop';
      const label = ADOBE_BRIDGE_APP_LABELS[app];
      const items = Array.isArray(detail && detail.items) ? detail.items : [];
      setFeedback('正在把 ' + items.length + ' 张图片送回 ' + label + '…');
      return adobeBridgeJson('/dsh-canvas/adobe-bridge/return', { cwd: current.cwd || '', project: current.project || '', app, items })
        .then((result) => {
          if (!result.ok || !result.data || !result.data.ok) throw new Error((result.data && result.data.error) || '写入发件箱失败');
          const d = result.data;
          const remote = d.remote || {};
          const originName = d.origin ? ((d.origin.layer && d.origin.layer.name) || (d.origin.document && d.origin.document.name) || '') : '';
          let tail;
          if (Number(remote.placed) > 0) tail = '已直接置入 ' + label + (originName ? '并归位到「' + originName + '」' : '') + '（' + remote.placed + ' 项）';
          else if (remote.attempted && !remote.running) tail = label + ' 未运行——打开它后在「文件 → 脚本 → DSH画布桥接」面板点「置入」';
          else if (remote.error) tail = '自动置入失败：' + remote.error + '；可在 ' + label + ' 面板点「置入」';
          else tail = '在 ' + label + ' 面板点「置入」';
          setFeedback('✓ ' + tail + '（发件箱 #' + d.seq + '，' + (d.files || []).length + ' 个文件）');
        })
        .catch((err) => setFeedback('⚠ 返回 ' + label + ' 失败：' + String((err && err.message) || err)));
    }

    /** 顶栏「取 Ps 图层 / 取 Ai 对象」：远程让运行中的 PS/AI 把当前选区送进收件箱，轮询器随后自动上画布。 */
    function pullFromAdobe(current, app, setFeedback, opts) {
      const label = ADOBE_BRIDGE_APP_LABELS[app] || app;
      const what = app === 'photoshop' ? '图层' : '对象';
      setFeedback('正在从 ' + label + ' 取当前选中的' + what + '…');
      return adobeBridgeJson('/dsh-canvas/adobe-bridge/pull', { cwd: current.cwd || '', project: current.project || '', sessionId: current.sessionId || '', app, merged: !!(opts && opts.merged), dpi: opts && opts.dpi })
        .then((result) => {
          const d = result.data || {};
          if (!result.ok || !d.ok) throw new Error(d.error || '取回失败');
          setFeedback('✓ 已从 ' + label + ' 取到 ' + d.count + ' 项' + what + '，几秒内出现在画布上');
        })
        .catch((err) => setFeedback('⚠ 从 ' + label + ' 取' + what + '失败：' + String((err && err.message) || err)));
    }

    /** 「更多」菜单按需显示安装入口：查一次桥接状态，缺什么才显示对应按钮。
     *  查询失败按"已安装"处理（不让按钮闪现），装完后由调用方再查一次让按钮消失。 */
    function fetchAdobeBridgeInstallStatus() {
      return adobeBridgeJson('/dsh-canvas/adobe-bridge/status')
        .then((result) => {
          const d = (result.ok && result.data && result.data.ok) ? result.data : {};
          return { scriptsInstalled: d.scriptsInstalled !== false, cepInstalled: d.cepInstalled !== false };
        })
        .catch(() => ({ scriptsInstalled: true, cepInstalled: true }));
    }

    /** 安装入口（菜单里按需出现，见 fetchAdobeBridgeInstallStatus）。
     *  elevate=false：只刷新用户副本（远程驱动 / 「浏览…」用它；DSH 启动时也自动做，无 UI 入口）。
     *  elevate=true（macOS）：PS/AI 的应用脚本目录都是 root 权限，弹系统管理员密码框把脚本装进菜单——
     *  密码由 macOS 自己的对话框收集，插件接触不到。实测 PS 2025 不扫描用户级目录，菜单入口只有这条路。 */
    function installAdobeBridgeScripts(setFeedback, elevate) {
      setFeedback(elevate ? '请在系统弹出的对话框里输入 Mac 管理员密码…' : '正在刷新桥接脚本副本…');
      return adobeBridgeJson('/dsh-canvas/adobe-bridge/install-scripts', { elevate: !!elevate })
        .then((result) => {
          const d = result.data || {};
          if (!result.ok || !d.ok) throw new Error(d.error || '安装失败');
          const okNames = (d.installed || []).map((i) => i.name).join('、');
          if (!elevate) {
            setFeedback('✓ 脚本副本已刷新：' + (d.userCopyDir || '') + (okNames ? '；菜单目录也已更新（' + okNames + '）' : '；要进 PS/AI 菜单请点「🔐 安装 PS / AI 菜单面板」'));
            return;
          }
          const badText = (d.errors || []).map((e) => (e.name ? e.name + '：' : '') + e.error).join('；');
          setFeedback((okNames ? '✓ 已装进 ' + okNames + ' 的脚本菜单。重启 PS/AI 后在「文件 → 脚本」里就有「DSH画布桥接」' : '⚠ 没有装进任何 Adobe 菜单目录。' + (d.manualHint || '')) + (badText ? '。未成功：' + badText : ''));
        })
        .catch((err) => setFeedback('⚠ ' + (elevate ? '安装菜单面板' : '刷新脚本副本') + '失败：' + String((err && err.message) || err)));
    }

    /** 「更多 → 🧩 安装常驻面板」：CEP 扩展装进用户级目录（免管理员），重启 PS/AI 后
     *  「窗口 → 扩展(旧版) → DSH 画布桥接」出现——可停靠、不挡应用、自动轮询发件箱。DSH 启动时也会自动装。 */
    function installAdobeBridgeCepPanel(setFeedback) {
      setFeedback('正在安装 CEP 常驻面板（用户级目录，不需要密码）…');
      return adobeBridgeJson('/dsh-canvas/adobe-bridge/install-scripts', { cep: true })
        .then((result) => {
          const d = result.data || {};
          if (!result.ok || !d.ok) throw new Error(d.error || '安装失败');
          const debug = d.debugMode && d.debugMode.set ? '' : '；未能自动打开"允许未签名扩展"开关（' + ((d.debugMode && d.debugMode.failures || []).join('、') || '原因未知') + '），面板可能不显示';
          setFeedback('✓ 常驻面板已安装：' + d.dir + '。重启 Photoshop / Illustrator 后在「窗口 → 扩展（旧版）」里打开「DSH 画布桥接」' + debug);
        })
        .catch((err) => setFeedback('⚠ 安装常驻面板失败：' + String((err && err.message) || err)));
    }
// Excalidraw (MIT, 完全开源商用) 版 iframe：替代 tldraw，保留相同 postMessage 协议。
// 从 CDN 加载 React + Excalidraw UMD；离线/内网环境可能加载失败。
const EXCALIDRAW_SRCDOC = `<!doctype html><html><head><meta charset="utf-8"><style>
    .dsh-name-layer{position:absolute;inset:0;z-index:55;pointer-events:none;overflow:hidden}.dsh-pending{position:absolute;box-sizing:border-box;overflow:hidden;pointer-events:none;border-radius:4%/3%;background:var(--dsh-surface,rgba(248,250,252,.97));color:var(--dsh-fg,#1f2937);font-family:system-ui,-apple-system,'PingFang SC','Alibaba PuHuiTi 3.0',sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.45em;box-shadow:inset 0 0 0 2px rgba(59,130,246,.5)}.dsh-pending::before{content:'';position:absolute;left:0;right:0;top:-48px;bottom:0;background:repeating-linear-gradient(135deg,rgba(127,127,127,.07) 0 10px,transparent 10px 24px);animation:dshStripes 1.4s linear infinite}.dsh-pending>*{position:relative}.dsh-pending-ring{width:2.6em;height:2.6em;border-radius:50%;border:.32em solid rgba(127,127,127,.28);border-top-color:#3b82f6;animation:dshSpin .85s linear infinite}.dsh-pending-title{font-weight:700;font-size:1.05em;letter-spacing:.02em}.dsh-pending-sub{font-size:.68em;color:var(--dsh-fg-muted,#6b7280);max-width:88%;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-pending-time{font-size:.7em;color:var(--dsh-fg-muted,#9ca3af);font-variant-numeric:tabular-nums}.dsh-pending-percent{font-size:1.3em;font-weight:700;color:#2563eb;font-variant-numeric:tabular-nums}.dsh-pending-bar{position:absolute;left:0;right:0;bottom:0;height:4px;background:rgba(127,127,127,.14);overflow:hidden}.dsh-pending-bar>i{position:absolute;top:0;bottom:0;left:0;width:35%;background:linear-gradient(90deg,transparent,#3b82f6,transparent);animation:dshSweep 1.3s ease-in-out infinite}.dsh-pending-bar>b{position:absolute;top:0;bottom:0;left:0;background:#3b82f6;transition:width .4s ease}@keyframes dshSpin{to{transform:rotate(360deg)}}@keyframes dshStripes{to{transform:translateY(34px)}}@keyframes dshSweep{0%{left:-35%}100%{left:100%}}.dsh-image-name-plain{position:absolute;box-sizing:border-box;user-select:none}
    .dsh-image-name{position:absolute;box-sizing:border-box;min-width:64px;max-width:260px;height:22px;padding:3px 8px;border:1px solid rgba(148,163,184,.48);border-radius:6px;background:rgba(255,255,255,.94);box-shadow:0 2px 8px rgba(15,23,42,.12);color:#334155;font:500 11px/14px ui-rounded,"SF Pro Rounded",sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:auto;cursor:text;user-select:none;transform:translateY(-26px)}
    .dsh-image-name:hover{border-color:#60a5fa;background:#fff;color:#1d4ed8}
    .dsh-image-name-input{position:absolute;box-sizing:border-box;height:24px;padding:3px 7px;border:1px solid #3b82f6;border-radius:6px;background:#fff;box-shadow:0 0 0 3px rgba(59,130,246,.18);color:#1e293b;font:500 11px/16px ui-rounded,"SF Pro Rounded",sans-serif;outline:none;pointer-events:auto;transform:translateY(-27px)}
    .dsh-selection-toolbar{position:absolute;z-index:80;display:flex;align-items:center;gap:4px;box-sizing:border-box;padding:5px;border:1px solid var(--dsh-line,rgba(255,255,255,.14));border-radius:11px;background:var(--dsh-surface,rgba(15,18,24,.96));box-shadow:0 12px 30px rgba(15,23,42,.28),0 2px 8px rgba(15,23,42,.22);color:var(--dsh-fg,#f8fafc);pointer-events:auto;transform:translate(-50%,-100%);white-space:nowrap;backdrop-filter:blur(14px);animation:dsh-toolbar-in .13s ease-out}
    .dsh-selection-toolbar:after{content:"";position:absolute;left:50%;bottom:-5px;width:9px;height:9px;background:var(--dsh-surface,rgba(15,18,24,.96));border-right:1px solid var(--dsh-line,rgba(255,255,255,.12));border-bottom:1px solid var(--dsh-line,rgba(255,255,255,.12));transform:translateX(-50%) rotate(45deg)}
    .dsh-selection-count{position:relative;z-index:1;padding:0 7px;color:var(--dsh-fg-muted,#94a3b8);font:600 11px/28px ui-rounded,"SF Pro Rounded",sans-serif}
    .dsh-selection-divider{position:relative;z-index:1;width:1px;height:20px;margin:0 2px;background:var(--dsh-line,rgba(255,255,255,.14))}
    /* 选区工具条：更多下拉菜单 */
.dsh-selection-more{position:relative;display:flex}
.dsh-selection-menu{position:absolute;top:calc(100% + 6px);right:0;min-width:136px;display:flex;flex-direction:column;gap:2px;padding:6px;border:1px solid var(--dsh-line,rgba(255,255,255,.14));border-radius:10px;background:var(--dsh-surface,rgba(15,18,24,.97));box-shadow:0 14px 34px rgba(15,23,42,.4);z-index:90}
    .dsh-selection-menu .dsh-selection-action{white-space:nowrap;width:100%;text-align:left}
    .dsh-selection-menu .dsh-selection-action:hover{background:var(--dsh-hover,rgba(255,255,255,.08))}
    /* 画布图片颜色标记：更多菜单内的七色调色板与画布角标圆点 */
.dsh-tag-palette{display:flex;align-items:center;gap:6px;padding:6px 8px;border-bottom:1px solid rgba(255,255,255,.09);margin-bottom:3px;white-space:nowrap;flex-wrap:nowrap}
.dsh-tag-palette>span{flex:none}
.dsh-tag-palette .dsh-selection-action{width:auto;min-width:0;flex:none}
.dsh-tag-dot-btn{width:19px;height:19px;flex:none;padding:0;border:2px solid rgba(255,255,255,.34);border-radius:50%;cursor:pointer;transition:transform .12s ease}
.dsh-tag-dot-btn:hover{transform:scale(1.18)}
.dsh-image-tag-dot{display:inline-block;width:8px;height:8px;margin-right:5px;border-radius:50%;border:1.5px solid rgba(255,255,255,.65);vertical-align:baseline;flex:none}
.dsh-image-tag-corner{position:absolute;z-index:70;width:13px;height:13px;border:2px solid rgba(255,255,255,.7);border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.4);pointer-events:none}
.dsh-selection-action{position:relative;z-index:1;height:30px;padding:0 10px;border:0;border-radius:7px;background:transparent;color:var(--dsh-fg,#e2e8f0);font:600 12px/30px ui-rounded,"SF Pro Rounded",sans-serif;cursor:pointer;transition:background .12s ease,color .12s ease,transform .12s ease}
    .dsh-selection-action:hover{background:var(--dsh-hover,rgba(255,255,255,.1));color:var(--dsh-fg,#fff)}
    .dsh-selection-action:active{transform:translateY(1px)}
    .dsh-selection-action.dsh-material-drag-action{cursor:grab}.dsh-selection-action.dsh-material-drag-action:active{cursor:grabbing}
    .dsh-selection-action.dsh-primary{background:#2563eb;color:#fff}.dsh-selection-action.dsh-primary:hover{background:#3b82f6}
    .dsh-selection-action.dsh-photoshop{background:#001e36;color:#31a8ff}.dsh-selection-action.dsh-photoshop:hover{background:#0b2b46;color:#8dceff}
    .dsh-selection-action.dsh-illustrator{background:#3b1b08;color:#ff9a3d}.dsh-selection-action.dsh-illustrator:hover{background:#5a2608;color:#ffc078}
    /* Adobe 桥接「返回」：放入发件箱，由 PS/AI 里的 DSH画布桥接 面板置入（adobe-bridge/PROTOCOL.md） */
    .dsh-selection-action.dsh-bridge-ps{background:#001e36;color:#31a8ff;border:1px dashed rgba(49,168,255,.45)}.dsh-selection-action.dsh-bridge-ps:hover{background:#0b2b46;color:#8dceff}
    .dsh-selection-action.dsh-bridge-ai{background:#3b1b08;color:#ff9a3d;border:1px dashed rgba(255,154,61,.45)}.dsh-selection-action.dsh-bridge-ai:hover{background:#5a2608;color:#ffc078}
    .dsh-selection-action.dsh-danger:hover{background:rgba(239,68,68,.18);color:#fecaca}
    @keyframes dsh-toolbar-in{from{opacity:0;transform:translate(-50%,-92%) scale(.97)}to{opacity:1;transform:translate(-50%,-100%) scale(1)}}
    .dsh-image-editor{position:fixed;inset:0;z-index:220;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(5,7,11,.82);backdrop-filter:blur(12px);pointer-events:auto}
    .dsh-image-editor-panel{display:grid;grid-template-rows:auto minmax(180px,1fr) auto;width:min(980px,calc(100vw - 36px));height:min(820px,calc(100vh - 36px));overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:18px;background:#13161c;box-shadow:0 30px 90px rgba(0,0,0,.48);color:#f8fafc;font-family:ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif}
    .dsh-image-editor-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,.09);background:#181c23}
    .dsh-image-editor-title{font-size:14px;font-weight:750}.dsh-image-editor-sub{flex:1;min-width:0;color:#94a3b8;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .dsh-image-editor-tool{height:30px;padding:0 10px;border:1px solid rgba(255,255,255,.13);border-radius:8px;background:#252a33;color:#e2e8f0;font:600 12px ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;cursor:pointer}.dsh-image-editor-tool:hover{background:#313743}.dsh-image-editor-tool:disabled{opacity:.4;cursor:not-allowed}
    .dsh-image-editor-close{width:30px;padding:0;font-size:16px}
    .dsh-image-editor-stage{position:relative;display:flex;align-items:center;justify-content:center;min-height:0;padding:16px;overflow:hidden;background-color:#0c0f14;background-image:linear-gradient(45deg,#151922 25%,transparent 25%),linear-gradient(-45deg,#151922 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#151922 75%),linear-gradient(-45deg,transparent 75%,#151922 75%);background-size:22px 22px;background-position:0 0,0 11px,11px -11px,-11px 0;touch-action:none;cursor:default}
    .dsh-image-editor-media{position:relative;display:inline-flex;max-width:100%;max-height:100%;line-height:0;box-shadow:0 10px 36px rgba(0,0,0,.38);transform-origin:center center;will-change:transform;touch-action:none}
    .dsh-image-editor-image{display:block;max-width:100%;max-height:calc(100vh - 260px);object-fit:contain;user-select:none;-webkit-user-drag:none}
    .dsh-image-editor-mask{position:absolute;inset:0;width:100%;height:100%;opacity:.52;cursor:none;touch-action:none}
    .dsh-image-editor-mask.dsh-select-cursor{cursor:crosshair}
    .dsh-mask-cursor{position:absolute;z-index:3;border:1.5px solid #fff;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.78),0 0 12px rgba(0,0,0,.35);transform:translate(-50%,-50%);pointer-events:none;mix-blend-mode:difference}
    .dsh-mask-tools{display:flex;align-items:center;gap:3px;padding:3px;border:1px solid rgba(255,255,255,.11);border-radius:10px;background:#10141a}
    .dsh-mask-tool{height:26px;padding:0 9px;border:0;border-radius:7px;background:transparent;color:#94a3b8;font:650 11px ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;cursor:pointer}.dsh-mask-tool:hover{color:#fff;background:#252b35}.dsh-mask-tool.is-active{background:#f43f5e;color:#fff;box-shadow:0 2px 10px rgba(244,63,94,.24)}
    .dsh-image-editor-foot{display:grid;grid-template-columns:1fr auto;gap:10px;padding:12px 14px;border-top:1px solid rgba(255,255,255,.09);background:#181c23}
    .dsh-image-editor-input{box-sizing:border-box;width:100%;min-height:76px;max-height:150px;resize:vertical;padding:11px 13px;border:1px solid rgba(255,255,255,.14);border-radius:11px;background:#0f1217;color:#f8fafc;font:500 13px/1.5 ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;outline:none}.dsh-image-editor-input:focus{border-color:#4f8cff;box-shadow:0 0 0 3px rgba(79,140,255,.16)}
    .dsh-image-editor-send{align-self:stretch;min-width:126px;border:0;border-radius:11px;background:#2563eb;color:#fff;font:750 13px ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;cursor:pointer}.dsh-image-editor-send:hover{background:#3b82f6}.dsh-image-editor-send:disabled{background:#374151;color:#94a3b8;cursor:wait}
    .dsh-image-editor-note{grid-column:1/-1;color:#94a3b8;font-size:11px}.dsh-image-editor-note.dsh-error{color:#fca5a5}
    .dsh-brush-label{display:flex;align-items:center;gap:6px;color:#cbd5e1;font-size:11px}.dsh-brush-label input{width:92px;accent-color:#fb4165}
    .dsh-image-editor-zoom{display:flex;align-items:center;gap:2px;padding:2px;border:1px solid rgba(255,255,255,.11);border-radius:9px;background:#10141a}
    .dsh-image-editor-zoom button{height:26px;min-width:28px;padding:0 7px;border:0;border-radius:6px;background:transparent;color:#cbd5e1;font:650 11px ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;cursor:pointer}.dsh-image-editor-zoom button:hover{background:#252b35;color:#fff}.dsh-image-editor-zoom-value{min-width:42px;color:#f8fafc;font:650 11px/26px ui-rounded,"SF Pro Rounded","PingFang SC",sans-serif;text-align:center}
    .dsh-image-editor-busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(8,11,16,.68);color:#fff;font-weight:700;letter-spacing:.04em;backdrop-filter:blur(3px)}
    @media(max-width:720px){.dsh-image-editor{padding:8px}.dsh-image-editor-panel{width:calc(100vw - 16px);height:calc(100vh - 16px);border-radius:12px}.dsh-image-editor-foot{grid-template-columns:1fr}.dsh-image-editor-send{min-height:44px}.dsh-image-editor-head{flex-wrap:wrap}.dsh-image-editor-sub{flex-basis:40%}}
    .excalidraw [data-testid="toolbar-image"],#ex-root [data-testid="toolbar-image"],.excalidraw [aria-label="插入图像"],.excalidraw [aria-label="Insert image"],.excalidraw [title^="插入图像"]{display:none!important}
    .excalidraw .dsh-hidden-social-links{display:none!important}
    /* Excalidraw 暗色主题会把画布先反相绘制，再用 invert(.93) 还原。
       .93 会把黑位抬高约 7% 并压缩对比度，导致同一张图比聊天预览发白。
       仅在暗色主题下把还原系数校正为 1，不改图片字节、元素透明度或浅色主题。 */
    .excalidraw.theme--dark canvas.excalidraw__canvas{filter:invert(1) hue-rotate(180deg)!important}
    /* 设置菜单需要位于画布文件名标签和选中工具条之上；打开菜单时暂时收起标签，关闭后自动恢复。 */
    .dsh-excalidraw-menu-open .dsh-name-layer{display:none!important}
    .dsh-tip{display:none!important}

html,body,#ex-root,#ex-root>div,.excalidraw,.excalidraw-container{margin:0;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--dsh-bg,#f7f8fa)}.dsh-tip{position:fixed;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.65);color:#fff;font-size:12px;padding:6px 12px;border-radius:8px;pointer-events:none;z-index:5;max-width:80%;text-align:center}.dsh-err{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff3f3;border:1px solid #ecc;color:#a22;font-size:13px;padding:16px 20px;border-radius:10px;max-width:80%;white-space:pre-wrap}@media(prefers-color-scheme:dark){html,body,#ex-root,#ex-root>div,.excalidraw,.excalidraw-container{background:var(--dsh-bg,#15171c)}.dsh-err{background:#2a171b;border-color:#7f1d1d;color:#fecaca}}
/* 隐藏 Excalidraw 内置素材库入口（默认侧栏触发按钮），改用插件自有素材库 */
.excalidraw .default-sidebar-trigger{display:none!important}
.excalidraw .layer-ui__wrapper__footer-left .sidebar-trigger{display:none!important}
</style></head><body><div id="ex-root"></div><div class="dsh-tip">拖拽=移动 · 滚轮=缩放 · 图片可移动/缩放</div><script crossorigin src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script><script crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script><script src="https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.17.6/dist/excalidraw.production.min.js"></script><script>(function(){var lastRuntimeError="";var post=function(m){try{window.parent.postMessage(m,"*")}catch(e){}};window.addEventListener("error",function(ev){lastRuntimeError="画布运行错误: "+String(ev&&ev.message||ev&&ev.error||"未知错误");post({type:"error",message:lastRuntimeError})});window.addEventListener("unhandledrejection",function(ev){lastRuntimeError="画布异步错误: "+String(ev&&ev.reason&&ev.reason.message||"未知错误");post({type:"error",message:lastRuntimeError})});var root=window.ReactDOM.createRoot(document.getElementById("ex-root"));var api=null,ready=false,insertCount=0,insertChain=Promise.resolve(),requestSceneLoad=null,hydrating=false,expectedElements=0;var systemDark=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;var canvasDefaultBackground=systemDark?"#15171c":"#f7f8fa";var empty={viewBackgroundColor:canvasDefaultBackground};var themeMedia=window.matchMedia?window.matchMedia("(prefers-color-scheme: dark)"):null;var syncSystemTheme=function(ev){var nextDark=!!(ev&&ev.matches);if(nextDark===systemDark)return;var previous=canvasDefaultBackground;systemDark=nextDark;canvasDefaultBackground=systemDark?"#15171c":"#f7f8fa";if(api&&typeof api.getAppState==="function"&&typeof api.updateScene==="function"&&String(api.getAppState().viewBackgroundColor||"")===previous)api.updateScene({appState:Object.assign({},api.getAppState(),{viewBackgroundColor:canvasDefaultBackground}),commitToHistory:false});};if(themeMedia){if(typeof themeMedia.addEventListener==="function")themeMedia.addEventListener("change",syncSystemTheme);else if(typeof themeMedia.addListener==="function")themeMedia.addListener(syncSystemTheme);}function fileObject(fl){var f={};if(fl&&typeof fl.forEach==="function"){fl.forEach(function(v,k){f[k]=v})}else if(fl&&typeof fl==="object"){Object.keys(fl).forEach(function(k){f[k]=fl[k]})}return f}function serialize(el,st,fl){var elements=el||[],used={};elements.forEach(function(item){if(item&&item.type==="image"&&!item.isDeleted&&item.fileId)used[item.fileId]=true;});var f={},src=fileObject(fl);Object.keys(src).forEach(function(k){if(!used[k])return;var v=src[k];if(v&&v.dataURL)f[k]={id:v.id||k,dataURL:v.dataURL,mimeType:v.mimeType,created:v.created||Date.now(),lastRetrieved:v.lastRetrieved};});return {elements:elements,appState:Object.assign({},st||empty),files:f}};function App(){return window.React.createElement(window.ExcalidrawLib.Excalidraw,{excalidrawAPI:function(a){api=a;if(!ready){ready=true;post({type:"ready"})}},initialData:{elements:[],appState:empty,files:{}},onChange:(function(){/* 性能 v2：600ms 防抖 + files 增量——changed 只带 usedFileIds 与新增/变化文件，父层按 previous.files 合并；loaded/snapshot-request 仍发全量 */var t=0,la=null,sent={};function sig(f){return (f&&f.dataURL?f.dataURL.length:0)+':'+String(f&&f.mimeType||'')}function markSent(f){Object.keys(f||{}).forEach(function(k){sent[k]=sig(f[k])})}window.__dshSentFilesReset=function(f){sent={};markSent(f)};window.__dshCancelPendingChanged=function(){if(t){clearTimeout(t);t=0;}la=null};return function(el,st,fl){/* 水合守卫：requestSceneLoad 渐进恢复场景时 onChange 会以"部分场景"触发，若此时发 changed 会把父层完整文件表砍成部分——水合期间一律忽略并取消挂起 */if(hydrating){if(t){clearTimeout(t);t=0;}la=null;return;}la=[el,st,fl];if(!t){t=setTimeout(function(){t=0;var a=la;la=null;if(!a)return;try{var s=serialize(a[0],a[1],api&&api.getFiles?api.getFiles():a[2]);var ids=[],delta={};Object.keys(s.files||{}).forEach(function(k){var v=s.files[k];ids.push(k);if(sent[k]!==sig(v))delta[k]=v});s.usedFileIds=ids;s.files=delta;post({type:"changed",snapshot:s,token:window.__dshSceneToken||""});markSent(delta)}catch(e){}},600)}}})(),viewModeEnabled:false,zenModeEnabled:false,langCode:"zh-CN"})}  var useState=window.React.useState,useEffect=window.React.useEffect;
  var updateImageEditorState=null;
  // 模块级桥接：Main 挂载后回填。add-image 的捕获阶段监听器在 Main 之外，
  // 之前这个变量被 var 声明在 Main 内部，导致外面永远拿到 undefined，
  // 「加入画布后自动打开编辑器」（图层编辑）从来没生效过。
  var openImageEditorById=null;
  var ExcalidrawView=window.ExcalidrawLib.Excalidraw;
  window.ExcalidrawLib.Excalidraw=function(props){var input=props||{},options=input.UIOptions||{},tools=options.tools||{};return window.React.createElement(ExcalidrawView,Object.assign({},input,{UIOptions:Object.assign({},options,{tools:Object.assign({},tools,{image:false})})}));};
  function baseName2(path){var text=String(path||""),at=-1;for(var i=text.length-1;i>=0;i-=1){var code=text.charCodeAt(i);if(code===47||code===92){at=i;break;}}return at<0?text:text.slice(at+1);}
  function pathComparable2(value){var text=String(value||"").split("\\\\").join("/");while(text.indexOf("//")>=0)text=text.split("//").join("/");while(text.length>1&&text.endsWith("/"))text=text.slice(0,-1);return text;}
  function pathWithin2(parent,child){var base=pathComparable2(parent),target=pathComparable2(child);if(!base||!target)return false;var insensitive=/^[A-Za-z]:/.test(base)||/^[A-Za-z]:/.test(target),left=insensitive?base.toLowerCase():base,right=insensitive?target.toLowerCase():target;return right===left||right.indexOf(left+"/")===0;}
  function cleanImageName(value,dataURL,forcedExt){var raw=Array.from(baseName2(value)).map(function(ch){var code=ch.charCodeAt(0);return code<32||[34,42,47,58,60,62,63,92,124].indexOf(code)>=0?"-":ch;}).join("").trim().slice(0,120);var mime=(String(dataURL||"").match(/^data:([^;]+)/i)||[])[1]||"image/png";var fallback=forcedExt||(mime==="image/jpeg"?"jpg":((mime.split("/")[1]||"png").replace("svg+xml","svg")));var dot=raw.lastIndexOf("."),base=(dot>0?raw.slice(0,dot):raw).replace(/[. ]+$/g,"").trim()||"画布图片";return base+"."+fallback;}
  function uniqueImageName(value,dataURL,exceptId,forcedExt){var wanted=cleanImageName(value,dataURL,forcedExt),dot=wanted.lastIndexOf("."),base=dot>0?wanted.slice(0,dot):wanted,ext=dot>0?wanted.slice(dot):"";var used={};(api&&api.getSceneElements?api.getSceneElements():[]).forEach(function(item){if(item&&item.type==="image"&&!item.isDeleted&&item.id!==exceptId){var n=item.customData&&item.customData.dshFileName;if(n)used[String(n).toLowerCase()]=true;}});var out=wanted,index=2;while(used[out.toLowerCase()])out=base+"-"+(index++)+ext;return out;}
  // 元素真正进入场景后再打开编辑器：updateScene 之后 getSceneElements 可能还看不到它，
  // 固定 160ms 定时器不可靠（旧实现就是这么写的，而且因为作用域问题连执行机会都没有）。
  function openEditorWhenReady(id,mode){
    var tries=0;
    var timer=setInterval(function(){
      tries+=1;
      var scene=(api&&typeof api.getSceneElements==="function")?(api.getSceneElements()||[]):[];
      var present=scene.some(function(item){return item&&item.id===id&&!item.isDeleted;});
      if(typeof openImageEditorById==="function"&&present){clearInterval(timer);openImageEditorById(mode,id);return;}
      if(tries>25)clearInterval(timer);
    },120);
  }

function addImageDataURL(dataURL,dm,meta){if(!api)throw new Error("画布尚未就绪");if(typeof api.addFiles!=="function")throw new Error("当前 Excalidraw 不支持 addFiles");var now=Date.now();var token=now.toString(36)+"_"+Math.random().toString(36).slice(2,10);var fileId="f_"+token;var ratio=(dm&&dm.w&&dm.h&&dm.h>0)?dm.w/dm.h:1.6;var maxW=240,maxH=240,w,h;if(ratio>=1){w=maxW;h=Math.max(1,Math.round(maxW/ratio));}else{h=maxH;w=Math.max(1,Math.round(maxH*ratio));}var mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/png";var appState=api.getAppState()||empty;var zoom=appState.zoom&&appState.zoom.value?appState.zoom.value:1;var baseX=(-Number(appState.scrollX||0))+80/zoom,baseY=(-Number(appState.scrollY||0))+90/zoom;var total=Number(meta&&meta.batchTotal||1),index=Number(meta&&meta.batchIndex);if(!(index>=0)){index=insertCount++;total=1;}var columns=total>1?Number(meta&&meta.batchColumns||Math.min(5,Math.ceil(Math.sqrt(total*1.35)))):4;var slot=total>1?index:(index%12),col=slot%columns,row=Math.floor(slot/columns);var hasDrop=meta&&Number.isFinite(Number(meta.dropClientX))&&Number.isFinite(Number(meta.dropClientY));var x=hasDrop?((Number(meta.dropClientX)-Number(appState.offsetLeft||0))/zoom-Number(appState.scrollX||0)-w/2):(baseX+col*300+(maxW-w)/2),y=hasDrop?((Number(meta.dropClientY)-Number(appState.offsetTop||0))/zoom-Number(appState.scrollY||0)-h/2):(baseY+row*320);var hasPos=meta&&meta.atX!==undefined&&meta.atY!==undefined&&Number.isFinite(Number(meta.atX))&&Number.isFinite(Number(meta.atY));if(hasPos){x=Number(meta.atX);y=Number(meta.atY);}var sourceExt=meta&&["psd","svg","pdf","ai"].indexOf(meta.kind)>=0?meta.kind:"";var fileName=uniqueImageName(meta&&meta.name,dataURL,null,sourceExt);var el=Object.assign({type:"image",id:"e_"+token,fileId:fileId,x:x,y:y,width:w,height:h,angle:0,strokeColor:"transparent",backgroundColor:"transparent",fillStyle:"solid",strokeWidth:1,strokeStyle:"solid",roughness:0,opacity:100,seed:Math.floor(Math.random()*1e9),version:1,versionNonce:Math.floor(Math.random()*1e9),isDeleted:false,groupIds:[],frameId:null,boundElements:null,updated:now,link:null,locked:false,customData:Object.assign({dshFileName:fileName,dshSourcePath:String(meta&&meta.path||""),dshSourceMtime:Number(meta&&meta.mtime||0),dshSourceSize:Number(meta&&meta.size||0),dshSourceKind:String(meta&&meta.kind||"image"),dshManaged:!(meta&&meta.managed===false)},(meta&&meta.customData&&typeof meta.customData==="object")?meta.customData:null),roundness:null,status:"saved",scale:[1,1]});api.addFiles([{id:fileId,dataURL:dataURL,mimeType:mime,created:now,lastRetrieved:now}]);api.updateScene({elements:(api.getSceneElements()||[]).concat([el]),appState:Object.assign({},appState)});if(total>1&&index===total-1)insertCount+=total;post({type:"added",name:fileName});if(meta&&meta.openEditor===true){openEditorWhenReady(el.id,String(meta.editorMode||"edit"));}}

function dims2(d){return new Promise(function(res){var i=new Image();i.onload=function(){res({w:i.naturalWidth,h:i.naturalHeight})};i.onerror=function(){res({w:200,h:130})};i.src=d});}
  function aspectCorrectedSize(item,dm){var actual=dm&&dm.w&&dm.h?dm.w/dm.h:0,current=Number(item&&item.width||1)/Math.max(1,Number(item&&item.height||1));if(!actual||Math.abs(current/actual-1)<.01)return null;var edge=Math.max(1,Number(item.width||240),Number(item.height||240));return actual>=1?{width:edge,height:Math.max(1,Math.round(edge/actual))}:{width:Math.max(1,Math.round(edge*actual)),height:edge};}
  function repairPsdAspectRatios(){if(!api)return Promise.resolve(0);var elements=api.getSceneElements()||[],files=fileObject(api.getFiles?api.getFiles():{}),targets=elements.filter(function(item){return item&&item.type==="image"&&!item.isDeleted&&item.customData&&item.customData.dshSourceKind==="psd"&&files[item.fileId]&&files[item.fileId].dataURL;});return Promise.all(targets.map(function(item){return dims2(files[item.fileId].dataURL).then(function(dm){return {id:item.id,size:aspectCorrectedSize(item,dm)};});})).then(function(results){var fixes=new Map(results.filter(function(result){return result.size;}).map(function(result){return [result.id,result.size];}));if(!fixes.size)return 0;var now=Date.now(),updated=(api.getSceneElements()||[]).map(function(item){var size=item&&fixes.get(item.id);return size?Object.assign({},item,size,{version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now}):item;});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:false});post({type:"aspect-ratio-repaired",count:fixes.size});return fixes.size;});}
  function toDataURLBlob(b){return new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(fr.result)};fr.onerror=rej;fr.readAsDataURL(b)});}
  function displayImageName(value){var text=String(value||"");return text.replace(/\.(?:png|jpe?g|webp|gif|avif|bmp|svg|pdf|ai|psd)$/i,"")||text;}
  var pendingProgress={},bumpPending=null;
  function pendingOverlays(elements,appState){var state=appState||empty,zoom=state.zoom&&state.zoom.value?Number(state.zoom.value):1,scrollX=Number(state.scrollX||0),scrollY=Number(state.scrollY||0),offsetLeft=Number(state.offsetLeft||0),offsetTop=Number(state.offsetTop||0);return (elements||[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted&&item.customData&&item.customData.dshEditState==="processing";}).map(function(item){var c=item.customData;return {id:item.id,left:Math.round(((Number(item.x||0)+scrollX)*zoom+offsetLeft)*10)/10,top:Math.round(((Number(item.y||0)+scrollY)*zoom+offsetTop)*10)/10,width:Math.round(Number(item.width||160)*zoom*10)/10,height:Math.round(Number(item.height||160)*zoom*10)/10,title:String(c.dshEditTitle||"图片修改中…"),subtitle:String(c.dshEditSubtitle||""),startedAt:Number(c.dshEditStartedAt||0)};});}
  function imageNameLabels(elements,appState){var state=appState||empty,zoom=state.zoom&&state.zoom.value?Number(state.zoom.value):1,scrollX=Number(state.scrollX||0),scrollY=Number(state.scrollY||0),offsetLeft=Number(state.offsetLeft||0),offsetTop=Number(state.offsetTop||0),labelScale=Math.max(.25,Math.min(1.5,zoom)),selectedIds=state.selectedElementIds||{};return (elements||[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted;}).map(function(item){var name=item.customData&&item.customData.dshFileName||(\"画布图片-\"+String(item.id||\"\").slice(-6)+\".png\");return {id:item.id,fileId:item.fileId,name:name,displayName:displayImageName(name),tag:item.customData&&item.customData.dshTagColor||\"\",fmt:docFormatTagOfElement(item),dotSize:Math.max(2,Math.round(8*zoom*10)/10),dotBorder:Math.max(1,Math.round(1.5*zoom*10)/10),cornerSize:Math.max(3,Math.round(13*zoom*10)/10),cornerBorder:Math.max(1,Math.round(2*zoom*10)/10),selected:!!selectedIds[item.id],fontSize:Math.max(6,Math.round(9*labelScale*10)/10),height:Math.max(14,Math.round(16*labelScale)),paddingX:Math.max(3,Math.round(6*labelScale)),offsetY:Math.max(12,Math.round(20*labelScale)),minWidth:Math.max(36,Math.round(64*labelScale)),maxWidth:Math.max(96,Math.round(260*labelScale)),left:Math.round(((Number(item.x||0)+scrollX)*zoom+offsetLeft)*10)/10,top:Math.round(((Number(item.y||0)+scrollY)*zoom+offsetTop)*10)/10,width:Math.round(Math.max(48,Math.min(260*labelScale,Number(item.width||160)*zoom))*10)/10};});}
  function selectionToolbarData(elements,appState){var state=appState||empty,selected=state.selectedElementIds||{},zoom=state.zoom&&state.zoom.value?Number(state.zoom.value):1,scrollX=Number(state.scrollX||0),scrollY=Number(state.scrollY||0),offsetLeft=Number(state.offsetLeft||0),offsetTop=Number(state.offsetTop||0);var images=(elements||[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted&&selected[item.id];});if(!images.length)return null;var boxes=images.map(function(item){var left=(Number(item.x||0)+scrollX)*zoom+offsetLeft,top=(Number(item.y||0)+scrollY)*zoom+offsetTop;return {left:left,top:top,right:left+Number(item.width||0)*zoom};});var minLeft=Math.min.apply(null,boxes.map(function(box){return box.left;})),minTop=Math.min.apply(null,boxes.map(function(box){return box.top;})),maxRight=Math.max.apply(null,boxes.map(function(box){return box.right;})),viewportWidth=Math.max(360,Number(window.innerWidth||960)),center=Math.max(170,Math.min(viewportWidth-170,(minLeft+maxRight)/2));return {ids:images.map(function(item){return item.id;}),count:images.length,left:Math.round(center*10)/10,top:Math.round(Math.max(54,minTop-40)*10)/10,singleName:images.length===1?(images[0].customData&&images[0].customData.dshFileName||("画布图片-"+String(images[0].id||"").slice(-6)+".png")):"",singleKind:images.length===1?(images[0].customData&&images[0].customData.dshSourceKind||""):""};}
  function duplicateSelectedImages(ids){if(!api||!Array.isArray(ids)||!ids.length)return;var selected={};ids.forEach(function(id){selected[id]=true;});var all=api.getSceneElements()||[],files=fileObject(api.getFiles?api.getFiles():{}),now=Date.now(),nextSelected={},copies=[];all.forEach(function(item,index){if(!item||item.type!=="image"||item.isDeleted||!selected[item.id])return;var token=now.toString(36)+"_"+index+"_"+Math.random().toString(36).slice(2,8),nextId="e_copy_"+token,source=files[item.fileId],nextFileId=source?("f_copy_"+token):item.fileId;if(source&&typeof api.addFiles==="function")api.addFiles([{id:nextFileId,dataURL:source.dataURL,mimeType:source.mimeType||"image/png",created:now,lastRetrieved:now}]);copies.push(Object.assign({},item,{id:nextId,fileId:nextFileId,x:Number(item.x||0)+36,y:Number(item.y||0)+36,index:undefined,seed:Math.floor(Math.random()*1e9),version:1,versionNonce:Math.floor(Math.random()*1e9),updated:now,isDeleted:false,customData:Object.assign({},item.customData||{})}));nextSelected[nextId]=true;});if(!copies.length)return;api.updateScene({elements:all.concat(copies),appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:nextSelected}),commitToHistory:true});post({type:"duplicated",count:copies.length});}
  function deleteSelectedImages(ids){if(!api||!Array.isArray(ids)||!ids.length)return;var selected={};ids.forEach(function(id){selected[id]=true;});var now=Date.now(),updated=(api.getSceneElements()||[]).map(function(item){if(!item||!selected[item.id])return item;return Object.assign({},item,{isDeleted:true,version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:{}}),commitToHistory:true});post({type:"deleted-selection",count:ids.length,snapshot:serialize(updated,api.getAppState()||empty,api.getFiles()||{})});}
  function svgText(value){return String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/\"/g,"&quot;");}
  function editStatusDataURL(title,subtitle,state,ratio){var width=800,height=Math.max(360,Math.min(1200,Math.round(width/Math.max(.35,Math.min(2.4,Number(ratio)||1.6))))),failed=state==="failed",accent=failed?"#fb7185":"#60a5fa",safeTitle=svgText(title),safeSub=svgText(subtitle).slice(0,120),svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'" viewBox="0 0 '+width+' '+height+'"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111827"/><stop offset="1" stop-color="#1e293b"/></linearGradient><pattern id="p" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M0 28L28 0" stroke="#ffffff" stroke-opacity=".035" stroke-width="8"/></pattern></defs><rect width="100%" height="100%" rx="28" fill="url(#g)"/><rect width="100%" height="100%" rx="28" fill="url(#p)"/><rect x="3" y="3" width="794" height="'+(height-6)+'" rx="26" fill="none" stroke="'+accent+'" stroke-opacity=".65" stroke-width="6" stroke-dasharray="16 14"/>'+(failed?'<path d="M370 '+(height/2-70)+'l60 60m0-60l-60 60" stroke="'+accent+'" stroke-width="18" stroke-linecap="round"/>':'<circle cx="400" cy="'+(height/2-55)+'" r="42" fill="none" stroke="#334155" stroke-width="14"/><path d="M400 '+(height/2-97)+'a42 42 0 0 1 42 42" fill="none" stroke="'+accent+'" stroke-width="14" stroke-linecap="round"/>')+'<text x="400" y="'+(height/2+40)+'" fill="#f8fafc" font-family="PingFang SC, sans-serif" font-size="38" font-weight="700" text-anchor="middle">'+safeTitle+'</text><text x="400" y="'+(height/2+88)+'" fill="#94a3b8" font-family="PingFang SC, sans-serif" font-size="21" text-anchor="middle">'+safeSub+'</text></svg>';return "data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent(svg)));}
  function createEditPlaceholder(item,subtitle){if(!api||!item)throw new Error("画布尚未就绪");var source=(api.getSceneElements()||[]).find(function(el){return el&&el.id===item.id&&el.type==="image"&&!el.isDeleted;});if(!source)throw new Error("原图片已不在画布中");var now=Date.now(),token=now.toString(36)+"_"+Math.random().toString(36).slice(2,9),requestId="edit_"+token,id="e_edit_pending_"+token,fileId="f_edit_pending_"+token,ratio=Number(source.width||1)/Math.max(1,Number(source.height||1)),dataURL=editStatusDataURL("图片修改中…",subtitle||"处理中 · 完成后自动替换", "processing",ratio),selected={};selected[id]=true;api.addFiles([{id:fileId,dataURL:dataURL,mimeType:"image/svg+xml",created:now,lastRetrieved:now}]);var placeholder=Object.assign({},source,{id:id,fileId:fileId,x:Number(source.x||0)+Number(source.width||240)+70,y:Number(source.y||0),index:undefined,seed:Math.floor(Math.random()*1e9),version:1,versionNonce:Math.floor(Math.random()*1e9),updated:now,isDeleted:false,customData:Object.assign({},source.customData||{},{dshFileName:"图片修改中…",dshSourcePath:"",dshSourceMtime:0,dshSourceKind:"placeholder",dshManaged:false,dshEditTitle:"图片修改中…",dshEditSubtitle:subtitle||"处理中 · 完成后自动替换",dshEditStartedAt:now,dshEditState:"processing",dshEditRequestId:requestId})});api.updateScene({elements:(api.getSceneElements()||[]).concat([placeholder]),appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:selected}),commitToHistory:true});setTimeout(function(){if(api&&typeof api.scrollToContent==="function")api.scrollToContent([placeholder],{fitToContent:false,animate:true});},60);return {requestId:requestId,placeholderId:id};}
  function findEditPlaceholder(detail){return (api&&api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.type==="image"&&!item.isDeleted&&((detail.placeholderId&&item.id===detail.placeholderId)||(item.customData&&item.customData.dshEditRequestId===detail.requestId));});}
  function markEditPlaceholderFailed(detail){if(!api)return;var placeholder=findEditPlaceholder(detail);if(!placeholder)return;var now=Date.now(),fileId="f_edit_failed_"+now.toString(36)+"_"+Math.random().toString(36).slice(2,7),ratio=Number(placeholder.width||1)/Math.max(1,Number(placeholder.height||1)),message=String(detail.message||"请重新编辑"),dataURL=editStatusDataURL("图片修改失败",message,"failed",ratio);api.addFiles([{id:fileId,dataURL:dataURL,mimeType:"image/svg+xml",created:now,lastRetrieved:now}]);var selected={};selected[placeholder.id]=true;var updated=(api.getSceneElements()||[]).map(function(item){if(!item||item.id!==placeholder.id)return item;return Object.assign({},item,{fileId:fileId,version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,customData:Object.assign({},item.customData||{},{dshFileName:"图片修改失败",dshEditState:"failed",dshManaged:false})});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:selected}),commitToHistory:false});post({type:"image-edit-placeholder-failed",message:message});}
  function reopenFailedImageEdit(detail){if(!api||!detail||!detail.retryItem)return false;var placeholder=findEditPlaceholder(detail),retry=detail.retryItem,selected={};if(retry.id)selected[retry.id]=true;var now=Date.now(),updated=(api.getSceneElements()||[]).map(function(item){if(!placeholder||!item||item.id!==placeholder.id)return item;return Object.assign({},item,{isDeleted:true,version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:selected}),commitToHistory:false});if(typeof updateImageEditorState==="function")updateImageEditorState(Object.assign({},retry,{busy:false,error:String(detail.message||"生成失败，可直接重试")}));return true;}
  // 占位图超时自愈：请求若一直不返回（DSH 重启会把在途请求直接带走、网关也可能悬挂），
  // 「图片修改中…」就会永远转圈；而且占位图已经写进 canvas.json，重启后还会被恢复出来。
  // 这里把超过 25 分钟仍处于 processing 的占位图统一标成失败，用户删掉重来即可。
  // ---- 聊天生图占位(v1.9):与编辑占位同款视觉,完成原位替换 ----
  function chatPlaceholderAnchor(index){
    var els=(api&&api.getSceneElements?api.getSceneElements():[]),right=null;
    els.forEach(function(item){
      if(!item||item.type!=="image"||item.isDeleted)return;
      var c=item.customData||{};
      if(c.dshChatGenState==="failed")return;
      if(!right||Number(item.x||0)+Number(item.width||0)>Number(right.x||0)+Number(right.width||0))right=item;
    });
    var base=right?{x:Number(right.x||0)+Number(right.width||220)+70,y:Number(right.y||0)}:{x:150,y:150};
    var step=Number(index)||0;
    return {x:base.x+step*270,y:base.y+Math.floor(step/3)*180};
  }
  function createChatPlaceholder(detail){
    if(!api)throw new Error("画布尚未就绪");
    var now=Date.now(),id=String(detail.id||("e_chat_pending_"+now.toString(36))),fileId="f_"+id,ratio=1.6;
    var subtitle=String(detail.subtitle||"完成后自动加入画布");
    // 底图只做中性占位(视觉全部交给 dsh-pending 动画覆盖层,跟随应用主题)
    var dataURL="data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="100%" height="100%" fill="#ececf0"/><rect x="6" y="6" width="788" height="488" fill="none" stroke="#b9bfcc" stroke-width="4" stroke-dasharray="14 12" rx="18"/></svg>')));
    var pos=chatPlaceholderAnchor(detail.index||0),w=220,h=Math.round(w/ratio);
    api.addFiles([{id:fileId,dataURL:dataURL,mimeType:"image/svg+xml",created:now,lastRetrieved:now}]);
    var el={type:"image",id:id,fileId:fileId,x:pos.x,y:pos.y,width:w,height:h,angle:0,strokeColor:"transparent",backgroundColor:"transparent",fillStyle:"solid",strokeWidth:1,strokeStyle:"solid",roughness:0,opacity:100,seed:Math.floor(Math.random()*1e9),version:1,versionNonce:Math.floor(Math.random()*1e9),isDeleted:false,groupIds:[],frameId:null,boundElements:null,updated:now,created:now,link:null,locked:false,roundness:null,status:"saved",scale:[1,1],mimeType:"image/svg+xml",customData:{dshFileName:"聊天生图中…",dshSourceKind:"placeholder",dshManaged:false,dshChatGen:true,dshChatGenState:"processing",dshChatGenStartedAt:now,dshEditState:"processing",dshEditTitle:"聊天生图中…",dshEditSubtitle:subtitle,dshEditStartedAt:now}};
    api.updateScene({elements:(api.getSceneElements()||[]).concat([el]),appState:Object.assign({},api.getAppState()||empty)});
    setTimeout(function(){if(api&&typeof api.scrollToContent==="function")api.scrollToContent([el],{fitToContent:false,animate:true});},60);
  }
  function findChatPlaceholder(id){return (api&&api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.type==="image"&&!item.isDeleted&&item.id===id;});}
  function resolveChatPlaceholder(detail){
    if(!api||!detail||!detail.url)return Promise.reject(new Error("生成结果无效"));
    var placeholder=findChatPlaceholder(detail.id);
    if(!placeholder)return Promise.reject(new Error("占位图已不在画布中"));
    return fetch(detail.url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("读取生成结果失败 HTTP "+r.status);return r.blob();}).then(toDataURLBlob).then(function(dataURL){return dims2(dataURL).then(function(dm){
      var now=Date.now(),token=now.toString(36)+"_"+Math.random().toString(36).slice(2,8),fileId="f_chat_"+token,ratio=dm.w/Math.max(1,dm.h),pw=Number(placeholder.width||240),mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/png",w,h;
      // 与 addImageDataURL/扫描导入统一为 240 盒装(同一批生成图视觉尺寸一致);
      // 用户手动改过占位宽度(非默认 220/240)时尊重该宽度按比例出高。
      if(Math.abs(pw-220)<.5||Math.abs(pw-240)<.5){if(ratio>=1){w=240;h=Math.max(1,Math.round(240/ratio));}else{h=240;w=Math.max(1,Math.round(240*ratio));}}else{w=pw;h=Math.max(1,Math.round(w/ratio));}
      api.addFiles([{id:fileId,dataURL:dataURL,mimeType:mime,created:now,lastRetrieved:now}]);
      var el=Object.assign({},placeholder,{fileId:fileId,width:w,height:h,version:Number(placeholder.version||0)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,customData:Object.assign({},placeholder.customData||{},{dshFileName:detail.name||"聊天生成.png",dshSourcePath:detail.path||"",dshSourceMtime:Number(detail.mtime||0),dshSourceKind:"image",dshManaged:true,dshChatGenState:"complete",dshEditState:"complete"})});
      api.updateScene({elements:(api.getSceneElements()||[]).map(function(item){return item&&item.id===placeholder.id?el:item;}),appState:Object.assign({},api.getAppState()||empty)});
      post({type:"added"});
    });});
  }
  function failChatPlaceholder(detail){
    if(!api)return;
    var placeholder=findChatPlaceholder(detail.id);
    if(!placeholder)return;
    var now=Date.now(),fileId="f_chat_failed_"+now.toString(36)+"_"+Math.random().toString(36).slice(2,7),ratio=Number(placeholder.width||1)/Math.max(1,Number(placeholder.height||1));
    var msg=String(detail.message||"生成中断,请重试");var dataURL="data:image/svg+xml;base64,"+btoa(unescape(encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="100%" height="100%" fill="#f3f4f6"/><rect x="6" y="6" width="788" height="488" fill="none" stroke="#d1d5db" stroke-width="4" rx="18"/><text x="400" y="235" fill="#6b7280" font-family="PingFang SC,sans-serif" font-size="34" font-weight="700" text-anchor="middle">聊天生图失败</text><text x="400" y="285" fill="#9ca3af" font-family="PingFang SC,sans-serif" font-size="20" text-anchor="middle">'+msg.slice(0,60)+'</text></svg>')));
    api.addFiles([{id:fileId,dataURL:dataURL,mimeType:"image/svg+xml",created:now,lastRetrieved:now}]);
    api.updateScene({elements:(api.getSceneElements()||[]).map(function(item){return item&&item.id===placeholder.id?Object.assign({},item,{fileId:fileId,version:Number(item.version||0)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,customData:Object.assign({},item.customData||{},{dshFileName:"聊天生图失败",dshChatGenState:"failed",dshEditState:"failed",dshManaged:false})}):item;}),appState:Object.assign({},api.getAppState()||empty)});
  }
  var STALE_EDIT_MS = 25 * 60 * 1000;
  function failStaleEditPlaceholders(){
    if(!api||typeof api.getSceneElements!=="function")return;
    var now=Date.now(),stale=[];
    try{
      (api.getSceneElements()||[]).forEach(function(item){
        if(!item||item.type!=="image"||item.isDeleted)return;
        var c=item.customData||{};
        if(c.dshChatGen&&String(c.dshChatGenState||"")==="processing"){
          var chatStarted=Number(c.dshChatGenStartedAt||0);
          if(!chatStarted||now-chatStarted>STALE_EDIT_MS)failChatPlaceholder({id:item.id,message:"等待超过 "+Math.round(STALE_EDIT_MS/60000)+" 分钟没有响应，已标记失败——删除后重新生成即可"});
          return;
        }
        if(String(c.dshEditState||"")!=="processing")return;
        var started=Number(c.dshEditStartedAt||0);
        if(!started||now-started>STALE_EDIT_MS)stale.push(item.id);
      });
    }catch(eScan){return;}
    for(var i=0;i<stale.length;i++){
      try{ markEditPlaceholderFailed({placeholderId:stale[i],message:"等待超过 "+Math.round(STALE_EDIT_MS/60000)+" 分钟没有响应，已标记失败——删除这张后重新编辑即可"}); }catch(eMark){}
    }
  }
  setInterval(failStaleEditPlaceholders, 15000);
  function addEditedImage(detail){if(!api||!detail||!detail.image||!detail.image.url)return Promise.reject(new Error("图片编辑结果无效"));var placeholder=findEditPlaceholder(detail),source=(api.getSceneElements()||[]).find(function(item){return item&&item.id===detail.elementId&&item.type==="image"&&!item.isDeleted;});if(!placeholder&&!source)return Promise.reject(new Error("原图片和等待图片均已不在画布中"));return fetch(detail.image.url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("读取编辑结果失败 HTTP "+r.status);return r.blob();}).then(toDataURLBlob).then(function(dataURL){return dims2(dataURL).then(function(dm){var now=Date.now(),token=now.toString(36)+"_"+Math.random().toString(36).slice(2,8),fileId="f_edit_"+token,ratio=dm.w/Math.max(1,dm.h),base=placeholder||source,w=Number(base.width||240),h=Math.max(1,Math.round(w/ratio)),mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/png",id=placeholder?placeholder.id:("e_edit_"+token),selected={};selected[id]=true;api.addFiles([{id:fileId,dataURL:dataURL,mimeType:mime,created:now,lastRetrieved:now}]);var customSource=source&&source.customData||{},el=Object.assign({},base,{id:id,fileId:fileId,x:placeholder?Number(placeholder.x||0):Number(source.x||0)+Number(source.width||w)+70,y:placeholder?Number(placeholder.y||0):Number(source.y||0),width:w,height:h,index:placeholder?placeholder.index:undefined,seed:placeholder?placeholder.seed:Math.floor(Math.random()*1e9),version:Number(base.version||0)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,isDeleted:false,customData:Object.assign({},customSource,placeholder&&placeholder.customData||{},{dshFileName:detail.image.name||"编辑结果.png",dshSourcePath:detail.image.path||"",dshSourceMtime:Number(detail.image.mtime||0),dshSourceKind:detail.image.kind||"image",dshManaged:true,dshEditState:"complete",dshEditRootPath:detail.editRootPath||customSource.dshEditRootPath||customSource.dshSourcePath||"",dshEditHistory:Array.isArray(detail.editHistory)?detail.editHistory:[],dshEditDepth:Number(detail.editDepth||1),dshEditEngine:detail.engine||"codex"})}),all=api.getSceneElements()||[],next=placeholder?all.map(function(item){return item&&item.id===placeholder.id?el:item;}):all.concat([el]);api.updateScene({elements:next,appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:selected}),commitToHistory:false});post({type:"image-edit-added",name:detail.image.name||"编辑结果",engine:detail.engine||"codex"});});});}
  function addBackgroundRemovedImage(detail){
    if(!api||!detail||!detail.image||!detail.image.url)return Promise.reject(new Error("去背景结果无效"));
    var placeholder=findEditPlaceholder(detail),source=(api.getSceneElements()||[]).find(function(item){return item&&item.id===detail.elementId&&item.type==="image"&&!item.isDeleted;});
    if(!placeholder&&!source)return Promise.reject(new Error("原图片和等待图片均已不在画布中"));
    return fetch(detail.image.url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("读取去背景结果失败 HTTP "+r.status);return r.blob();}).then(toDataURLBlob).then(function(dataURL){return dims2(dataURL).then(function(dm){var now=Date.now(),token=now.toString(36)+"_"+Math.random().toString(36).slice(2,8),fileId="f_bg_"+token,ratio=dm.w/Math.max(1,dm.h),base=placeholder||source,w=Number(base.width||240),h=Math.max(1,Math.round(w/ratio)),mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/png",id=placeholder?placeholder.id:("e_bg_"+token),selected={};selected[id]=true;api.addFiles([{id:fileId,dataURL:dataURL,mimeType:mime,created:now,lastRetrieved:now}]);var sourceCustom=source&&source.customData||{},el=Object.assign({},base,{id:id,fileId:fileId,x:placeholder?Number(placeholder.x||0):Number(source.x||0)+Number(source.width||w)+70,y:placeholder?Number(placeholder.y||0):Number(source.y||0),width:w,height:h,index:placeholder?placeholder.index:undefined,seed:placeholder?placeholder.seed:Math.floor(Math.random()*1e9),version:Number(base.version||0)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,isDeleted:false,customData:Object.assign({},sourceCustom,placeholder&&placeholder.customData||{},{dshFileName:detail.image.name||"去背景.png",dshSourcePath:detail.image.path||"",dshSourceMtime:Number(detail.image.mtime||0),dshSourceKind:"image",dshManaged:true,dshBackgroundRemoved:true,dshBackgroundModel:detail.model||"birefnet-general-lite",dshEditState:"complete"})}),all=api.getSceneElements()||[],next=placeholder?all.map(function(item){return item&&item.id===placeholder.id?el:item;}):all.concat([el]);api.updateScene({elements:next,appState:Object.assign({},api.getAppState()||empty,{selectedElementIds:selected}),commitToHistory:false});post({type:"image-background-removed",name:detail.image.name||"去背景.png",model:detail.model||"birefnet-general-lite"});});});
  }
  function addVectorizedImage(detail){
    if(!api||!detail||!detail.image||!detail.image.url)return Promise.reject(new Error("矢量化结果无效"));
    return fetch(detail.image.url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("读取矢量化结果失败 HTTP "+r.status);return r.blob();}).then(toDataURLBlob).then(function(dataURL){return dims2(dataURL).then(function(dm){addImageDataURL(dataURL,dm,{name:detail.image.name||"矢量结果.svg",path:detail.image.path||"",mtime:detail.image.mtime||0,kind:"svg",managed:detail.image.managed!==false});post({type:"image-vectorized-added",name:detail.image.name||"矢量结果.svg",backend:detail.backend||""});});});
  }
  function ImageEditDialog(props){
    var p=useState(String(props.item.prompt||"")),prompt=p[0],setPrompt=p[1];
    var b=useState(38),brush=b[0],setBrush=b[1];
    var tl=useState("brush"),tool=tl[0],setTool=tl[1];
    var cu=useState({x:0,y:0,show:false}),cursor=cu[0],setCursor=cu[1];
    var mv=useState(0),maskVersion=mv[0],setMaskVersion=mv[1];
    var er=useState(""),error=er[0],setError=er[1];
    var vz=useState(1),zoom=vz[0],setZoom=vz[1];
    var vp=useState({x:0,y:0}),pan=vp[0],setPan=vp[1];
    var canvasRef=window.React.useRef(null),pathsRef=window.React.useRef([]),savedMaskRef=window.React.useRef(String(props.item.maskData||"")),activeRef=window.React.useRef(null),drawingRef=window.React.useRef(false),panGestureRef=window.React.useRef(null),spaceRef=window.React.useRef(false),zoomRef=window.React.useRef(1),panRef=window.React.useRef({x:0,y:0});
    zoomRef.current=zoom;panRef.current=pan;
    useEffect(function(){setPrompt(String(props.item.prompt||""));setError("");setTool("brush");setCursor({x:0,y:0,show:false});pathsRef.current=[];savedMaskRef.current=String(props.item.maskData||"");setMaskVersion(0);zoomRef.current=1;panRef.current={x:0,y:0};setZoom(1);setPan({x:0,y:0});panGestureRef.current=null;},[props.item.id,props.item.mode,props.item.retryToken]);
    useEffect(function(){var down=function(e){if(e.key===" ")spaceRef.current=true;};var up=function(e){if(e.key===" ")spaceRef.current=false;};window.addEventListener("keydown",down);window.addEventListener("keyup",up);return function(){window.removeEventListener("keydown",down);window.removeEventListener("keyup",up);spaceRef.current=false;};},[]);
    var drawSelection=function(ctx,path){if(!path||!path.length)return;ctx.beginPath();ctx.moveTo(path[0].x,path[0].y);if(path.kind==="rect"){var end=path[path.length-1]||path[0];ctx.rect(path[0].x,path[0].y,end.x-path[0].x,end.y-path[0].y);ctx.fill();return;}if(path.kind==="lasso"){path.slice(1).forEach(function(point){ctx.lineTo(point.x,point.y);});if(path.length>2){ctx.closePath();ctx.fill();}else{ctx.lineWidth=2;ctx.stroke();}return;}ctx.lineWidth=path[0].size;path.length===1?ctx.lineTo(path[0].x+.01,path[0].y+.01):path.slice(1).forEach(function(point){ctx.lineTo(point.x,point.y);});ctx.stroke();};
    var redraw=function(){var canvas=canvasRef.current;if(!canvas)return;var ctx=canvas.getContext("2d");ctx.clearRect(0,0,canvas.width,canvas.height);ctx.strokeStyle="#ff315d";ctx.fillStyle="#ff315d";ctx.lineCap="round";ctx.lineJoin="round";pathsRef.current.forEach(function(path){drawSelection(ctx,path);});};
    var prepareCanvas=function(e){var canvas=canvasRef.current,img=e.currentTarget;if(!canvas)return;canvas.width=img.naturalWidth||1;canvas.height=img.naturalHeight||1;redraw();};
    var pointOf=function(e){var canvas=canvasRef.current,rect=canvas.getBoundingClientRect(),sx=canvas.width/Math.max(1,rect.width),sy=canvas.height/Math.max(1,rect.height);return {x:(e.clientX-rect.left)*sx,y:(e.clientY-rect.top)*sy,size:brush*Math.max(sx,sy)};};
    var cursorPoint=function(e){var canvas=canvasRef.current,rect=canvas.getBoundingClientRect(),layoutW=canvas.offsetWidth||rect.width,layoutH=canvas.offsetHeight||rect.height,sx=rect.width/Math.max(1,layoutW),sy=rect.height/Math.max(1,layoutH);return {x:(e.clientX-rect.left)/Math.max(.001,sx),y:(e.clientY-rect.top)/Math.max(.001,sy),show:true};};
    var setViewport=function(nextZoom,center){var old=zoomRef.current||1,next=Math.max(.25,Math.min(4,Number(nextZoom)||1)),point=center||{x:0,y:0},current=panRef.current||{x:0,y:0},ratio=next/old,nextPan={x:point.x-(point.x-current.x)*ratio,y:point.y-(point.y-current.y)*ratio};zoomRef.current=next;panRef.current=nextPan;setZoom(next);setPan(nextPan);};
    var fitViewport=function(){zoomRef.current=1;panRef.current={x:0,y:0};setZoom(1);setPan({x:0,y:0});};
    var wheel=function(e){if(props.item.busy)return;e.preventDefault();e.stopPropagation();var rect=e.currentTarget.getBoundingClientRect(),center={x:e.clientX-(rect.left+rect.width/2),y:e.clientY-(rect.top+rect.height/2)},factor=e.deltaY>0?.9:1.1;setViewport(zoomRef.current*factor,center);};
    var beginPan=function(e){if(props.item.busy||!(spaceRef.current||e.button===1||e.button===2))return false;e.preventDefault();e.stopPropagation();panGestureRef.current={pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,startPan:Object.assign({},panRef.current||{x:0,y:0})};if(e.currentTarget.setPointerCapture)e.currentTarget.setPointerCapture(e.pointerId);return true;};
    var pointerDown=function(e){if(beginPan(e))return;if(props.item.busy)return;e.preventDefault();e.stopPropagation();if(e.currentTarget.setPointerCapture)e.currentTarget.setPointerCapture(e.pointerId);var path=[pointOf(e)];path.kind=tool;pathsRef.current.push(path);activeRef.current=path;drawingRef.current=true;setCursor(cursorPoint(e));redraw();setMaskVersion(function(v){return v+1;});};
    var pointerMove=function(e){if(e.currentTarget===canvasRef.current)e.stopPropagation();if(panGestureRef.current){e.preventDefault();var gesture=panGestureRef.current,nextPan={x:gesture.startPan.x+(e.clientX-gesture.startX),y:gesture.startPan.y+(e.clientY-gesture.startY)};panRef.current=nextPan;setPan(nextPan);return;}if(e.currentTarget===canvasRef.current)setCursor(cursorPoint(e));if(!drawingRef.current||!activeRef.current)return;e.preventDefault();var point=pointOf(e);if(activeRef.current.kind==="rect"){activeRef.current.length=1;activeRef.current.push(point);}else activeRef.current.push(point);redraw();};
    var pointerUp=function(e){if(e.currentTarget===canvasRef.current)e.stopPropagation();if(panGestureRef.current){e.preventDefault();panGestureRef.current=null;return;}if(!drawingRef.current)return;e.preventDefault();drawingRef.current=false;activeRef.current=null;setMaskVersion(function(v){return v+1;});};
    var undo=function(){if(props.item.busy||!pathsRef.current.length)return;pathsRef.current.pop();redraw();setMaskVersion(function(v){return v+1;});};
    var clearMask=function(){if(props.item.busy)return;pathsRef.current=[];savedMaskRef.current="";redraw();setMaskVersion(function(v){return v+1;});};
    var buildMask=function(){var source=canvasRef.current,mask=document.createElement("canvas");mask.width=source.width;mask.height=source.height;var ctx=mask.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,mask.width,mask.height);ctx.globalCompositeOperation="destination-out";ctx.strokeStyle="#000";ctx.fillStyle="#000";ctx.lineCap="round";ctx.lineJoin="round";pathsRef.current.forEach(function(path){drawSelection(ctx,path);});return mask.toDataURL("image/png");};
    var submit=function(){var text=prompt.trim(),hasMask=pathsRef.current.length||savedMaskRef.current;if(props.item.mode==="edit"&&!text){setError("请输入具体修改需求");return;}if(props.item.mode==="erase"&&!hasMask){setError("请先用画笔、套索或框选标出要擦除的区域");return;}setError("");props.onSubmit({prompt:text,maskData:pathsRef.current.length?buildMask():savedMaskRef.current});};
    var erase=props.item.mode==="erase",note=erase?"提示词可留空：擦除选区并智能补全背景；也可填写希望补成什么。滚轮缩放；按住空格或鼠标中键拖动视图。":"选区是可选的：有选区时只修改红色区域；不画选区时按提示词修改整张图。不会写入主聊天上下文。滚轮缩放；按住空格或鼠标中键拖动视图。";
    return window.React.createElement("div",{className:"dsh-image-editor",onPointerDown:function(e){e.stopPropagation();}},window.React.createElement("div",{className:"dsh-image-editor-panel"},
      window.React.createElement("div",{className:"dsh-image-editor-head"},window.React.createElement("div",{className:"dsh-image-editor-title"},erase?"智能擦除":"编辑图片"),window.React.createElement("div",{className:"dsh-image-editor-sub"},props.item.name),window.React.createElement("div",{className:"dsh-mask-tools",role:"group","aria-label":"遮罩选择工具"},[["brush","画笔"],["lasso","套索"],["rect","框选"]].map(function(item){return window.React.createElement("button",{key:item[0],type:"button",className:"dsh-mask-tool"+(tool===item[0]?" is-active":""),disabled:props.item.busy,onClick:function(){setTool(item[0]);setCursor({x:0,y:0,show:false});}},item[1]);})),tool==="brush"?window.React.createElement("label",{className:"dsh-brush-label",title:"画面上圆环显示当前画笔的屏幕直径"},"直径 ",window.React.createElement("input",{type:"range",min:8,max:120,value:brush,disabled:props.item.busy,onChange:function(e){setBrush(Number(e.target.value));}}),brush+"px"):null,window.React.createElement("div",{className:"dsh-image-editor-zoom",role:"group","aria-label":"画布缩放"},window.React.createElement("button",{type:"button",disabled:props.item.busy,onClick:function(){setViewport(zoomRef.current/1.2,null)},title:"缩小"},"−"),window.React.createElement("span",{className:"dsh-image-editor-zoom-value"},Math.round(zoom*100)+"%"),window.React.createElement("button",{type:"button",disabled:props.item.busy,onClick:function(){setViewport(zoomRef.current*1.2,null)},title:"放大"},"+"),window.React.createElement("button",{type:"button",disabled:props.item.busy,onClick:fitViewport,title:"适应视图"},"适应")),window.React.createElement("button",{className:"dsh-image-editor-tool",disabled:props.item.busy||!pathsRef.current.length,onClick:undo},"撤销选择"),window.React.createElement("button",{className:"dsh-image-editor-tool",disabled:props.item.busy||!pathsRef.current.length,onClick:clearMask},"清空遮罩"),window.React.createElement("button",{className:"dsh-image-editor-tool dsh-image-editor-close",disabled:props.item.busy,onClick:props.onClose,title:"关闭"},"×")),
      window.React.createElement("div",{className:"dsh-image-editor-stage",onWheel:wheel,onPointerDown:function(e){beginPan(e);},onPointerMove:pointerMove,onPointerUp:pointerUp,onPointerCancel:pointerUp,onContextMenu:function(e){e.preventDefault();}},window.React.createElement("div",{className:"dsh-image-editor-media",style:{transform:"translate("+pan.x+"px,"+pan.y+"px) scale("+zoom+")"}},window.React.createElement("img",{className:"dsh-image-editor-image",src:props.item.dataURL,draggable:false,onLoad:prepareCanvas}),window.React.createElement("canvas",{ref:canvasRef,className:"dsh-image-editor-mask"+(tool==="brush"?"":" dsh-select-cursor"),onPointerEnter:function(e){setCursor(cursorPoint(e));},onPointerLeave:function(){setCursor({x:0,y:0,show:false});},onPointerDown:pointerDown,onPointerMove:pointerMove,onPointerUp:pointerUp,onPointerCancel:pointerUp}),tool==="brush"&&cursor.show?window.React.createElement("div",{className:"dsh-mask-cursor",style:{left:cursor.x+"px",top:cursor.y+"px",width:(brush/Math.max(.001,zoom))+"px",height:(brush/Math.max(.001,zoom))+"px"}}):null),props.item.busy?window.React.createElement("div",{className:"dsh-image-editor-busy"},"Codex 正在编辑；失败时自动切换 image2 API…"):null),
      window.React.createElement("div",{className:"dsh-image-editor-foot"},window.React.createElement("textarea",{className:"dsh-image-editor-input",value:prompt,disabled:props.item.busy,autoFocus:true,placeholder:erase?"可选：留空 = 擦除所选区域并智能补全背景":"描述你想要的编辑，例如：删除底部小字，其他内容保持不变…",onChange:function(e){setPrompt(e.target.value);},onKeyDown:function(e){if((e.metaKey||e.ctrlKey)&&e.key==="Enter")submit();}}),window.React.createElement("button",{className:"dsh-image-editor-send",disabled:props.item.busy,onClick:submit},props.item.busy?"处理中…":(erase?"擦除并补全":"生成修改图")),window.React.createElement("div",{className:"dsh-image-editor-note"+(error||props.item.error?" dsh-error":"")},error||props.item.error||note))
    ));
  }
  function renameCanvasImage(id,value){if(!api)return "";var elements=api.getSceneElements()||[],target=elements.find(function(item){return item&&item.id===id&&item.type==="image";});if(!target)return "";var files=fileObject(api.getFiles?api.getFiles():{}),file=files[target.fileId]||{},oldName=target.customData&&target.customData.dshFileName||("画布图片-"+String(target.id).slice(-6)+".png"),sourceKind=target.customData&&target.customData.dshSourceKind||"",forcedExt=["psd","svg","pdf","ai"].indexOf(sourceKind)>=0?sourceKind:"",newName=uniqueImageName(value,file.dataURL||"",id,forcedExt);var now=Date.now();var updated=elements.map(function(item){if(!item||item.id!==id)return item;return Object.assign({},item,{customData:Object.assign({},item.customData||{},{dshFileName:newName}),version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:true});post({type:"rename-image",id:id,fileId:target.fileId,oldName:oldName,newName:newName,sourcePath:target.customData&&target.customData.dshSourcePath||""});return newName;}
  function refreshSourceImage(detail){if(!api||!detail||!detail.elementId||!detail.url)return Promise.resolve();var elements=api.getSceneElements()||[],target=elements.find(function(item){return item&&item.id===detail.elementId&&item.type==="image"&&!item.isDeleted;});if(!target)return Promise.resolve();var read=function(attempt){var separator=String(detail.url).indexOf("?")>=0?"&":"?";return toDataURL(detail.url+separator+"refreshAttempt="+attempt+"&t="+Date.now()).catch(function(err){if(attempt>=4)throw err;return new Promise(function(resolve){setTimeout(resolve,450*attempt);}).then(function(){return read(attempt+1);});});};return read(1).then(function(dataURL){return dims2(dataURL).then(function(dm){var mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/jpeg",now=Date.now(),nextFileId="f_refresh_"+now.toString(36)+"_"+Math.random().toString(36).slice(2,8),size=aspectCorrectedSize(target,dm);api.addFiles([{id:nextFileId,dataURL:dataURL,mimeType:mime,created:now,lastRetrieved:now}]);var updated=elements.map(function(item){if(!item||item.id!==target.id)return item;return Object.assign({},item,size||{},{fileId:nextFileId,customData:Object.assign({},item.customData||{},{dshFileName:detail.name||item.customData&&item.customData.dshFileName,dshSourcePath:detail.path||item.customData&&item.customData.dshSourcePath,dshSourceMtime:Number(detail.mtime||0),dshSourceSize:Number(detail.size||0),dshSourceKind:detail.kind||item.customData&&item.customData.dshSourceKind||"image"}),version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,status:"saved"});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:false});post({type:"source-refreshed",elementId:target.id,path:detail.path||"",mtime:Number(detail.mtime||0),size:Number(detail.size||0),name:detail.name||target.customData&&target.customData.dshFileName||"图片"});});});}
  function bindManagedImage(detail){if(!api||!detail||!detail.elementId)return;var elements=api.getSceneElements()||[],target=elements.find(function(item){return item&&item.id===detail.elementId&&item.type==="image"&&!item.isDeleted;});if(!target)return;var files=fileObject(api.getFiles?api.getFiles():{}),oldFile=files[target.fileId],nextFileId=detail.newFileId||target.fileId,now=Date.now();if(oldFile&&nextFileId!==target.fileId)api.addFiles([{id:nextFileId,dataURL:oldFile.dataURL,mimeType:oldFile.mimeType||"image/png",created:now,lastRetrieved:now}]);var updated=elements.map(function(item){if(!item||item.id!==target.id)return item;return Object.assign({},item,{fileId:nextFileId,customData:Object.assign({},item.customData||{},{dshFileName:detail.name,dshSourcePath:detail.path,dshSourceMtime:Number(detail.mtime||0),dshSourceSize:Number(detail.size||0),dshSourceKind:detail.kind||"image",dshManaged:detail.managed!==false}),version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now,status:"saved"});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:false});}
  function removeSourceElements(ids){if(!api||!Array.isArray(ids)||!ids.length)return;var selected={};ids.forEach(function(id){selected[id]=true;});var now=Date.now(),updated=(api.getSceneElements()||[]).map(function(item){if(!item||!selected[item.id])return item;return Object.assign({},item,{isDeleted:true,version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:false});}
  // Mac 式七色标记（与素材库/Finder 颜色一致），存放在元素 customData.dshTagColor。
  var DSH_TAG_HEX={red:"#ff5f57",orange:"#ff9f0a",yellow:"#ffd60a",green:"#28c840",blue:"#0a84ff",purple:"#bf5af2",gray:"#8e8e93"};
  /* 文档格式默认标记(品牌色,方点区分用户圆点):PS 蓝 / AI 橙 / PDF 红 / SVG 紫。
     存元素 customData.dshTagColor,渲染与用户标记同一套(屏幕空间,不随画布缩放)。 */
  var DSH_FORMAT_TAG_HEX={psd:"#31A8FF",ai:"#FF9A00",pdf:"#E5322D",svg:"#8B5CF6"};
  function docFormatTagOf(kind){var k=String(kind||"").toLowerCase();return DSH_FORMAT_TAG_HEX[k]?k:null;}
  /* 旧元素可能没存 dshSourceKind:按源路径/文件名扩展名推断格式(.psd/.ai/.pdf/.svg)。 */
  function docFormatTagOfElement(item){var cd=item&&item.customData||{};var path=String(cd.dshSourcePath||cd.dshFileName||"");var m=/\.(psd|ai|pdf|svg)\s*$/i.exec(path);if(m)return m[1].toLowerCase();return docFormatTagOf(cd.dshSourceKind);}
  function setCanvasImageTag(ids,color){if(!api||!Array.isArray(ids)||!ids.length)return 0;var all=api.getSceneElements()||[],wanted={};ids.forEach(function(id){wanted[id]=true;});var count=0,now=Date.now();var updated=all.map(function(item){if(!item||item.type!=="image"||!wanted[item.id]||item.isDeleted)return item;var custom=Object.assign({},item.customData||{});if(color)custom.dshTagColor=color;else delete custom.dshTagColor;count++;return Object.assign({},item,{customData:custom,version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});if(!count)return 0;api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:true});post({type:"tag-images",ids:ids,color:color||"",count:count});return count;}
  function arrangeCanvasImages(detail){if(!api)return;var order=String(detail&&detail.order||"name"),tag=detail&&detail.tag===undefined?"":String(detail.tag||"");
    var collect=(api.getSceneElements()||[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted;});
    var images=collect.filter(function(item){var c=item.customData&&item.customData.dshTagColor||"";return tag===""?true:(tag==="none"?!c:c===tag);});
    if(!images.length){post({type:"arranged",count:0,order:order,tag:tag});return;}
    var files=fileObject(api.getFiles?api.getFiles():{});
    var extOf=function(name){var m=/\.([a-z0-9]+)$/i.exec(String(name||""));return m?m[1].toLowerCase():"";};
    var nameOf=function(item){return item.customData&&item.customData.dshFileName||("画布图片-"+String(item.id||"").slice(-6)+".png");};
    var timeOf=function(item){return Number(item.customData&&item.customData.dshSourceMtime||0);};
    var bytesOf=function(item){return Number(item.customData&&item.customData.dshSourceSize||0);};
    var layout=function(pixelMap){
      var sorted=images.slice().sort(order==="time"?function(a,b){return timeOf(b)-timeOf(a);}
        :order==="bytes"?function(a,b){return bytesOf(b)-bytesOf(a)||timeOf(b)-timeOf(a);}
        :order==="type"?function(a,b){var ea=extOf(nameOf(a)),eb=extOf(nameOf(b));return ea===eb?(timeOf(b)-timeOf(a)):(ea<eb?-1:1);}
        :order==="pixels"?function(a,b){return (pixelMap[b.fileId]||0)-(pixelMap[a.fileId]||0)||timeOf(b)-timeOf(a);}
        :function(a,b){return String(nameOf(a)).localeCompare(String(nameOf(b)),"zh-CN",{numeric:true,sensitivity:"base"});});
      var minX=Math.min.apply(null,sorted.map(function(item){return Number(item.x||0);})),bandY=Math.min.apply(null,sorted.map(function(item){return Number(item.y||0);})),positions={};
      // 文件类型排序按扩展名分块：每种格式一个独立网格带，块间留大间隔
      //（约 1.5 行空白），避免不同格式混排在同一片网格里看不出来。
      var groups=[sorted];
      if(order==="type"){
        groups=[];var byExt={},extOrder=[];
        sorted.forEach(function(item){var ext=extOf(nameOf(item));if(!byExt[ext]){byExt[ext]=[];extOrder.push(ext);}byExt[ext].push(item);});
        extOrder.forEach(function(ext){groups.push(byExt[ext]);});
      }
      groups.forEach(function(group){
        var columns=Math.min(5,Math.max(2,Math.ceil(Math.sqrt(group.length*1.35)))),rows=Math.ceil(group.length/columns);
        group.forEach(function(item,index){var ratio=Number(item.width||1)/Math.max(1,Number(item.height||1)),w,h;if(ratio>=1){w=240;h=Math.max(1,Math.round(240/ratio));}else{h=240;w=Math.max(1,Math.round(240*ratio));}var col=index%columns,row=Math.floor(index/columns);positions[item.id]={x:minX+col*300+(240-w)/2,y:bandY+row*320,width:w,height:h};});
        bandY+=rows*320+460;
      });
      var now=Date.now(),updated=collect.map(function(item){var p=item&&positions[item.id];if(!p)return item;return Object.assign({},item,p,{version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:now});});
      api.updateScene({elements:updated,appState:Object.assign({},api.getAppState()||empty),commitToHistory:true});
      setTimeout(function(){if(api&&typeof api.scrollToContent==="function")api.scrollToContent(updated.filter(function(item){return item&&positions[item.id];}),{fitToContent:true,animate:true});},80);
      post({type:"arranged",count:sorted.length,order:order,tag:tag,groups:groups.length});
    };
    if(order!=="pixels"){layout(null);return;}
    // 图片尺寸排序需要真实像素：按 fileId 去重解码一次 dataURL（结果只进局部 map，不写回场景）。
    var unique={},pending=[];
    images.forEach(function(item){if(item.fileId&&!unique[item.fileId]){unique[item.fileId]=true;pending.push(item.fileId);}});
    var pixelMap={},done=0;
    if(!pending.length){layout(pixelMap);return;}
    pending.forEach(function(fid){
      var file=files[fid],apply=function(w,h){pixelMap[fid]=(w||0)*(h||0);if(++done===pending.length)layout(pixelMap);};
      if(!file||!file.dataURL){apply(0,0);return;}
      var probe=new Image();
      probe.onload=function(){apply(probe.naturalWidth,probe.naturalHeight);};
      probe.onerror=function(){apply(0,0);};
      probe.src=file.dataURL;
    });
  }

function Main(){
    var l=useState([]),labels=l[0],setLabels=l[1];
    var pd=useState([]),pending=pd[0],setPending=pd[1];var pr=window.React.useRef("");
    var tk=useState(0),tick=tk[0],setTick=tk[1];bumpPending=function(){setTick(Date.now());};
    window.React.useEffect(function(){if(!pending.length)return undefined;var t=setInterval(function(){setTick(Date.now());},1000);return function(){clearInterval(t);};},[pending.length]);
    var ed=useState(null),editing=ed[0],setEditing=ed[1];
    var tb=useState(null),toolbar=tb[0],setToolbar=tb[1];
    var ie=useState(null),imageEditor=ie[0],setImageEditor=ie[1];
    updateImageEditorState=setImageEditor;openImageEditorById=function(mode,id){openImageEditor(mode,id);};
    var mo=useState(false),moreOpen=mo[0],setMoreOpen=mo[1];
    /* 选区变化/移动时自动收起"更多"菜单 */
    window.React.useEffect(function(){setMoreOpen(false);},[toolbar]);
    var lr=window.React.useRef("");
    var tr=window.React.useRef("");
    var updateLabels=function(elements,appState){var next=imageNameLabels(elements,appState),signature=next.map(function(item){return [item.id,item.name,item.displayName,item.left,item.top,item.width,item.fontSize,item.height,item.selected].join(":");}).join("|");if(signature!==lr.current){lr.current=signature;setLabels(next);}var pn=pendingOverlays(elements,appState),ps=pn.map(function(p){return [p.id,p.left,p.top,p.width,p.height,p.title,p.subtitle].join(":");}).join("|");if(ps!==pr.current){pr.current=ps;setPending(pn);}};
    var updateToolbar=function(elements,appState){var next=selectionToolbarData(elements,appState),signature=next?[next.ids.join("|"),next.left,next.top,next.singleName].join(":"):"";if(signature!==tr.current){tr.current=signature;setToolbar(next);}};
    requestSceneLoad=function(saved){
      var elements=(saved.elements||[]).filter(function(item){return item&&item.id!=="dsh_theme_backdrop"&&!(item.customData&&item.customData.dshChatGen&&item.customData.dshChatGenState==="processing");}).map(function(item,itemIndex){var normalized=Object.assign({},item,{index:item.index||("a"+itemIndex)});if(item.type!=="image")return normalized;return Object.assign({strokeColor:"transparent",backgroundColor:"transparent",fillStyle:"solid",strokeWidth:1,strokeStyle:"solid",roughness:0,opacity:100,frameId:null,status:"saved",scale:[1,1]},normalized,{status:item.status||"saved",scale:Array.isArray(item.scale)?item.scale:[1,1],frameId:item.frameId||null});});
      var now=Date.now(),files={},usedFileIds={};
      elements.forEach(function(item){if(item&&item.type==="image"&&!item.isDeleted&&item.fileId)usedFileIds[item.fileId]=true;});
      if(saved.files)Object.keys(saved.files).forEach(function(k){if(!usedFileIds[k])return;var v=saved.files[k]||{};if(v.dataURL)files[k]={id:v.id||k,dataURL:v.dataURL,mimeType:v.mimeType||"image/png",created:v.created||now,lastRetrieved:now};});
      var targetAppState=Object.assign({},empty,saved.appState||{});
      if(window.ExcalidrawLib&&typeof window.ExcalidrawLib.convertToExcalidrawElements==="function")elements=window.ExcalidrawLib.convertToExcalidrawElements(elements,{regenerateIds:false});
      if(window.ExcalidrawLib&&typeof window.ExcalidrawLib.restore==="function"){
        var restored=window.ExcalidrawLib.restore({elements:elements,appState:targetAppState,files:files},api&&api.getAppState?api.getAppState():null,null);
        elements=restored.elements||elements;targetAppState=restored.appState||targetAppState;files=fileObject(restored.files||files);
      }
      if(!/^#[0-9a-f]{6}$/i.test(String(targetAppState.viewBackgroundColor||"")))targetAppState.viewBackgroundColor=canvasDefaultBackground;
      targetAppState.openMenu=null;
      targetAppState.openPopup=null;
      targetAppState.openSidebar=null;
      targetAppState.openDialog=null;
      targetAppState.contextMenu=null;
      targetAppState.showWelcomeScreen=false;
      targetAppState.collaborators=new Map();
      hydrating=true;expectedElements=elements.filter(function(item){return item&&!item.isDeleted;}).length;
      if(!api)throw new Error("画布尚未就绪");
      if(typeof api.resetScene==="function")api.resetScene();else api.updateScene({elements:[],appState:empty});
      setTimeout(function(){
        if(Object.keys(files).length&&typeof api.addFiles==="function")api.addFiles(Object.keys(files).map(function(k){return files[k];}));
        setTimeout(function(){
          api.updateScene({elements:elements,appState:targetAppState,commitToHistory:false});updateLabels(elements,targetAppState);updateToolbar(elements,targetAppState);setTimeout(function(){repairPsdAspectRatios().catch(function(err){post({type:"error",message:"PSD 比例修复失败: "+String(err&&err.message||err)});});},120);
          setTimeout(function(){
            var sceneElements=api&&api.getSceneElements?api.getSceneElements():[];var sceneFiles=api&&api.getFiles?fileObject(api.getFiles()):{};
            if(sceneElements.length===expectedElements&&sceneElements.length&&typeof api.scrollToContent==="function")api.scrollToContent(sceneElements,{fitToContent:true,animate:false});
            var diagRoot=document.getElementById("ex-root"),diagCanvas=diagRoot?diagRoot.querySelectorAll("canvas").length:0,diagButtons=diagRoot?diagRoot.querySelectorAll("button").length:0;
            if(sceneElements.length===expectedElements){hydrating=false;post({type:"loaded",snapshot:serialize(sceneElements,api.getAppState?api.getAppState():saved.appState,api.getFiles?api.getFiles():files)});if(window.__dshSentFilesReset)window.__dshSentFilesReset(fileObject(api.getFiles?api.getFiles():files));}
            if(lastRuntimeError||sceneElements.length!==expectedElements)post({type:"diagnostic",elements:sceneElements.length,files:Object.keys(sceneFiles).length,expected:expectedElements,dom:(diagRoot&&diagRoot.querySelectorAll("*").length||0),canvas:diagCanvas,buttons:diagButtons,error:lastRuntimeError});
          },250);
        },80);
      },0);
    };
    document.addEventListener('click',function(e){
      try{
        var node=e.target,hit=null;
        while(node&&node!==document){var t=(node.textContent||'').trim();if(t==='添加到素材库中'||t==='添加到素材库'){hit=node;break;}node=node.parentNode;}
        if(!hit)return;
        e.preventDefault();e.stopPropagation();if(typeof e.stopImmediatePropagation==='function')e.stopImmediatePropagation();
        var sel=(api&&api.getSceneElements?api.getSceneElements():[]).filter(function(x){return x&&x.type==='image'&&!x.isDeleted&&api.getAppState&&api.getAppState().selectedElementIds&&api.getAppState().selectedElementIds[x.id];});
        var files=fileObject(api.getFiles?api.getFiles():{});
        var payload=sel.map(function(x){var f=files[x.fileId];return f&&f.dataURL?{name:(x.customData&&x.customData.dshFileName)||('素材-'+String(x.id).slice(-6)+'.png'),dataURL:f.dataURL}:null;}).filter(Boolean);
        if(payload.length){post({type:'save-to-materials',items:payload,source:'context-menu'});if(api&&api.updateScene)api.updateScene({appState:Object.assign({},api.getAppState()||empty,{openMenu:null,contextMenu:null})});}
      }catch(err){}
    },true);
    var onCanvasChange=function(el,st,fl){
      var snapshot=serialize(el,st,api&&api.getFiles?api.getFiles():fl),live=(el||[]).filter(function(item){return item&&!item.isDeleted;}).length;updateLabels(el,st);updateToolbar(el,st);
      if(hydrating){if(live<expectedElements)return;hydrating=false;post({type:"loaded",snapshot:snapshot});if(window.__dshSentFilesReset)window.__dshSentFilesReset(snapshot.files||{});}
      post({type:"changed",snapshot:snapshot,token:window.__dshSceneToken||""});
    };
    var commitName=function(){if(!editing)return;var next=renameCanvasImage(editing.id,editing.value);setEditing(null);if(next)post({type:"name-edited",name:next});};
    var openImageEditor=function(mode,id){if(!api)return;var target=(api.getSceneElements()||[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),files=fileObject(api.getFiles?api.getFiles():{}),file=target&&files[target.fileId];if(!target||!file||!file.dataURL){post({type:"error",message:"当前图片数据不可用"});return;}var custom=target.customData||{},item={mode:mode,id:id,fileId:target.fileId,name:custom.dshFileName||("画布图片-"+String(id).slice(-6)+".png"),dataURL:file.dataURL,width:0,height:0,sourcePath:custom.dshSourcePath||"",editRootPath:custom.dshEditRootPath||"",editHistory:Array.isArray(custom.dshEditHistory)?custom.dshEditHistory:[],editDepth:Number(custom.dshEditDepth||0),busy:false,error:""};setImageEditor(item);var probe=new Image();probe.onload=function(){setImageEditor(function(current){return current&&current.id===id?Object.assign({},current,{width:probe.naturalWidth||1,height:probe.naturalHeight||1}):current;});};probe.src=file.dataURL;};

    var openInPhotoshop=function(id){if(!api)return;var target=(api.getSceneElements()||[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),files=fileObject(api.getFiles?api.getFiles():{}),file=target&&files[target.fileId];if(!target||!file||!file.dataURL){post({type:"error",message:"当前图片数据不可用"});return;}var custom=target.customData||{};post({type:"request-photoshop-edit",elementId:id,fileId:target.fileId,name:custom.dshFileName||("画布图片-"+String(id).slice(-6)+".png"),sourcePath:custom.dshSourcePath||"",sourceKind:custom.dshSourceKind||"image",dataURL:file.dataURL});};
    var openInIllustrator=function(id){if(!api)return;var target=(api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),custom=target&&target.customData||{},kind=String(custom.dshSourceKind||"");if(!target||!custom.dshSourcePath){post({type:"error",message:"Illustrator 编辑需要源文件（该图片没有关联的磁盘源，如为粘贴图请先归档）"});return;}post({type:"request-illustrator-edit",elementId:id,name:custom.dshFileName||("画布文件-"+String(id).slice(-6)),sourcePath:custom.dshSourcePath,sourceKind:kind});};
    /* Adobe 桥接「返回 Ps/Ai」：把所选图片交给父页面写入项目 ADOBE桥接/发件箱（有源文件传路径，无源文件传 dataURL 先落盘）。
       customData.dshBridge 是收件时打的印（jobId/app/layer），host 据此解析出处并让 PS/AI 面板原位置入。协议：adobe-bridge/PROTOCOL.md */
    var requestBridgeReturn=function(ids,app){if(!api||!Array.isArray(ids)||!ids.length)return;var wanted={};ids.forEach(function(id){wanted[id]=true;});var files=fileObject(api.getFiles?api.getFiles():{}),items=[];(api.getSceneElements()||[]).forEach(function(item){if(!item||item.type!=="image"||item.isDeleted||!wanted[item.id])return;var custom=item.customData||{},file=files[item.fileId],sourcePath=String(custom.dshSourcePath||"");if(!sourcePath&&!(file&&file.dataURL))return;items.push({elementId:item.id,fileId:item.fileId,name:custom.dshFileName||("画布图片-"+String(item.id).slice(-6)+".png"),sourcePath:sourcePath,sourceKind:custom.dshSourceKind||"image",dataURL:sourcePath?"":file.dataURL,bridge:custom.dshBridge||null});});if(!items.length){post({type:"error",message:"所选图片没有可返回的数据"});return;}post({type:"request-bridge-return",app:app,items:items});};
    var requestVectorize=function(id,vectorMode){if(!api)return;var target=(api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),files=fileObject(api.getFiles?api.getFiles():{}),file=target&&files[target.fileId],custom=target&&target.customData||{},kind=String(custom.dshSourceKind||"image"),mimeMatch=String(file&&file.dataURL||"").match(/^data:([^;]+);base64,/i),mime=mimeMatch?String(mimeMatch[1]).toLowerCase():"",rasterMime=["image/png","image/jpeg","image/jpg","image/webp","image/gif","image/avif","image/bmp"].indexOf(mime)>=0;if(!target||!file||!file.dataURL||["image","psd"].indexOf(kind)<0||!rasterMime){post({type:"error",message:"当前图片不适合转矢量，请选择 PNG/JPG/WebP 等栅格图片"});return;}post({type:"request-vectorize",elementId:id,fileId:target.fileId,name:custom.dshFileName||("画布图片-"+String(id).slice(-6)+".png"),sourcePath:custom.dshSourcePath||"",imageData:file.dataURL,vectorMode:vectorMode||"flat"});};
    var requestTextRebuild=function(id){if(!api)return;var target=(api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),files=fileObject(api.getFiles?api.getFiles():{}),file=target&&files[target.fileId];if(!target||!file||!file.dataURL){post({type:"error",message:"当前图片数据不可用"});return;}var custom=target.customData||{};post({type:"request-text-rebuild",elementId:id,fileId:target.fileId,name:custom.dshFileName||("画布图片-"+String(id).slice(-6)+".png"),sourcePath:custom.dshSourcePath||"",imageData:file.dataURL});};
    var materialPayloadForSelection=function(ids){if(!api)return[];var wanted=new Set(Array.isArray(ids)?ids:[]),files=fileObject(api.getFiles?api.getFiles():{});return (api.getSceneElements?api.getSceneElements():[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted&&wanted.has(item.id);}).map(function(item,index){var file=files[item.fileId],custom=item.customData||{};return file&&file.dataURL?{dataURL:file.dataURL,name:custom.dshFileName||("画布素材-"+(index+1)+"-"+String(item.id).slice(-6)+".png")}:null;}).filter(Boolean);};
    var saveSelectionToMaterials=function(ids){var items=materialPayloadForSelection(ids);if(items.length)post({type:"save-to-materials",items:items,source:"selection-toolbar"});else post({type:"error",message:"所选图片暂时无法读取"});};
    var beginMaterialDrag=function(ids,event){var items=materialPayloadForSelection(ids);if(!items.length)return;if(event&&event.dataTransfer){event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("application/x-dsh-canvas-image",JSON.stringify({count:items.length}));event.dataTransfer.setData("text/plain",items.length===1?items[0].name:(items.length+" 张画布图片"));}post({type:"material-drag-start",items:items});};
    var sendSelectionToChat=function(ids){if(!api)return;var wanted=new Set(Array.isArray(ids)?ids:[]),files=fileObject(api.getFiles?api.getFiles():{}),images=(api.getSceneElements?api.getSceneElements():[]).filter(function(item){return item&&item.type==="image"&&!item.isDeleted&&wanted.has(item.id);}).map(function(item,index){var file=files[item.fileId],custom=item.customData||{};return file&&file.dataURL?{dataURL:file.dataURL,name:custom.dshFileName||("canvas-selection-"+(index+1)+"-"+String(item.id).slice(-6)+".png"),width:Math.max(1,Number(item.width||0)),height:Math.max(1,Number(item.height||0)),sourceKind:String(custom.dshSourceKind||"image")} : null;}).filter(Boolean);if(!images.length){post({type:"error",message:"所选图片暂时无法读取，请稍后重试"});return;}var batchId="chat_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,7);images.forEach(function(image,index){setTimeout(function(){post({type:"request-send-selection-item",batchId:batchId,index:index+1,total:images.length,image:image});},index*90);});};
    var requestBackgroundRemoval=function(id){if(!api)return;var target=(api.getSceneElements()||[]).find(function(item){return item&&item.id===id&&item.type==="image"&&!item.isDeleted;}),files=fileObject(api.getFiles?api.getFiles():{}),file=target&&files[target.fileId];if(!target||!file||!file.dataURL){post({type:"error",message:"当前图片数据不可用"});return;}try{var custom=target.customData||{},job=createEditPlaceholder({id:id},"本地 rembg · birefnet-general-lite · 首次使用自动准备"),name=custom.dshFileName||("画布图片-"+String(id).slice(-6)+".png");post({type:"request-remove-background",requestId:job.requestId,placeholderId:job.placeholderId,elementId:id,fileId:target.fileId,name:name,imageData:file.dataURL,imagePath:custom.dshSourcePath||""});}catch(err){post({type:"error",message:String(err&&err.message||err)});}};
    var submitImageEdit=function(payload){if(!imageEditor||imageEditor.busy)return;try{var job=createEditPlaceholder(imageEditor),request=Object.assign({},imageEditor);setImageEditor(null);var posEl=(api&&api.getSceneElements?api.getSceneElements():[]).find(function(item){return item&&item.id===request.id;})||null;post({type:"request-image-edit",requestId:job.requestId,placeholderId:job.placeholderId,elementId:request.id,fileId:request.fileId,name:request.name,imageData:request.dataURL,imagePath:request.sourcePath,editRootPath:request.editRootPath,editHistory:request.editHistory,editDepth:request.editDepth,mode:request.mode,prompt:payload.prompt,maskData:payload.maskData,width:request.width,height:request.height,atX:posEl?posEl.x:undefined,atY:posEl?posEl.y:undefined});}catch(err){setImageEditor(Object.assign({},imageEditor,{busy:false,error:String(err&&err.message||err)}));}};
    return window.React.createElement('div',{style:{position:'absolute',inset:0}},
      window.React.createElement('div',{style:{position:'absolute',inset:0}},window.React.createElement(window.ExcalidrawLib.Excalidraw,{excalidrawAPI:function(a){api=a;if(!ready){ready=true;post({type:"ready"})}},initialData:{elements:[],appState:empty,files:{}},onChange:onCanvasChange,viewModeEnabled:false,zenModeEnabled:false,langCode:"zh-CN"})),
      window.React.createElement('div',{className:'dsh-name-layer'},pending.map(function(p){var fs=Math.max(9,Math.min(20,p.width/13)),compact=p.height<fs*7||p.width<fs*9,prog=pendingProgress[p.id]||null,pct=prog&&isFinite(Number(prog.percent))?Math.max(0,Math.min(100,Math.round(Number(prog.percent)))):null,elapsed=p.startedAt?Math.max(0,Math.round((Date.now()-p.startedAt)/1000)):0,mm=Math.floor(elapsed/60),ss=String(elapsed%60).padStart(2,'0'),sub=prog&&prog.message?String(prog.message):p.subtitle;return window.React.createElement('div',{key:'pend_'+p.id,className:'dsh-pending',style:{left:p.left+'px',top:p.top+'px',width:p.width+'px',height:p.height+'px',fontSize:fs+'px'}},compact?null:window.React.createElement('div',{className:'dsh-pending-ring'}),pct!==null&&!compact?window.React.createElement('div',{className:'dsh-pending-percent'},pct+'%'):null,window.React.createElement('div',{className:'dsh-pending-title'},p.title),compact||!sub?null:window.React.createElement('div',{className:'dsh-pending-sub'},sub),compact?null:window.React.createElement('div',{className:'dsh-pending-time'},'已用 '+mm+':'+ss),window.React.createElement('div',{className:'dsh-pending-bar'},pct!==null?window.React.createElement('b',{style:{width:pct+'%'}}):window.React.createElement('i',null)));}),labels.filter(function(item){return (editing&&editing.id===item.id)||item.selected||item.tag||item.fmt;}).map(function(item){var labelStyle={left:item.left+'px',top:item.top+'px',width:item.width+'px',minWidth:item.minWidth+'px',maxWidth:item.maxWidth+'px',height:item.height+'px',padding:'3px '+item.paddingX+'px',fontSize:item.fontSize+'px',lineHeight:Math.max(10,item.height-6)+'px',borderRadius:Math.max(4,Math.round(6*item.fontSize/11))+'px',transform:'translateY(-'+item.offsetY+'px)'};return editing&&editing.id===item.id
        ?window.React.createElement('input',{key:item.id,className:'dsh-image-name-input',style:labelStyle,autoFocus:true,value:editing.value,spellCheck:false,onPointerDown:function(e){e.stopPropagation()},onChange:function(e){setEditing({id:item.id,value:e.target.value})},onBlur:commitName,onKeyDown:function(e){e.stopPropagation();if(e.key==='Enter')commitName();else if(e.key==='Escape')setEditing(null)}})
        :item.selected
        ?window.React.createElement('div',{key:item.id,className:'dsh-image-name-plain',draggable:true,style:{left:item.left+'px',top:item.top+'px',transform:'translateY(-'+item.offsetY+'px)',fontSize:item.fontSize+'px',lineHeight:1.15,color:'#94a3b8',fontWeight:500,letterSpacing:'.2px',whiteSpace:'nowrap',pointerEvents:'auto',cursor:'grab',textShadow:'0 1px 2px rgba(255,255,255,.55)'},title:'拖到右侧素材库；双击修改文件名：'+item.name,onDragStart:function(e){e.stopPropagation();beginMaterialDrag((api&&api.getAppState&&Object.keys(api.getAppState().selectedElementIds||{}))||[item.id],e);},onDragEnd:function(){post({type:'material-drag-end'});},onDoubleClick:function(e){e.preventDefault();e.stopPropagation();setEditing({id:item.id,value:displayImageName(item.name)})}},(item.fmt?window.React.createElement('span',{className:'dsh-image-tag-dot',style:{background:DSH_FORMAT_TAG_HEX[item.fmt],borderRadius:'2px',width:item.dotSize+'px',height:item.dotSize+'px',borderWidth:item.dotBorder+'px'}}):null),
            (item.tag?window.React.createElement('span',{className:'dsh-image-tag-dot',style:{background:DSH_TAG_HEX[item.tag]||'#888',borderRadius:'50%',width:item.dotSize+'px',height:item.dotSize+'px',borderWidth:item.dotBorder+'px'}}):null),item.displayName)
        :(function(){var csz=item.cornerSize,cbd=item.cornerBorder,ctop=(item.top-Math.round(csz*1.4))+'px';return window.React.createElement(window.React.Fragment,{key:item.id},
            item.fmt?window.React.createElement('span',{className:'dsh-image-tag-corner',style:{left:item.left+'px',top:ctop,width:csz+'px',height:csz+'px',borderWidth:cbd+'px',borderRadius:'2px',background:DSH_FORMAT_TAG_HEX[item.fmt]}}):null,
            item.tag?window.React.createElement('span',{className:'dsh-image-tag-corner',style:{left:(item.left+(item.fmt?Math.round(csz*1.25):0))+'px',top:ctop,width:csz+'px',height:csz+'px',borderWidth:cbd+'px',borderRadius:'50%',background:DSH_TAG_HEX[item.tag]||'#888'}}):null);})();}),toolbar?window.React.createElement('div',{className:'dsh-selection-toolbar',style:{left:toolbar.left+'px',top:toolbar.top+'px'},onPointerDown:function(e){e.preventDefault();e.stopPropagation();},onClick:function(e){e.stopPropagation();}},
        toolbar.count>1?window.React.createElement('span',{className:'dsh-selection-count'},'已选 '+toolbar.count+' 张'):null,
        toolbar.count>1?window.React.createElement('span',{className:'dsh-selection-divider'}):null,
        window.React.createElement('button',{className:'dsh-selection-action dsh-primary',title:'把所选图片附加到聊天输入框',onClick:function(){sendSelectionToChat(toolbar.ids);}},'发送至聊天'),
        toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action',title:'本地 rembg birefnet-general-lite 去除背景；首次使用自动准备环境和模型',onClick:function(){requestBackgroundRemoval(toolbar.ids[0]);}},'去除背景'):null,
        toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action',title:'画笔涂抹后智能擦除',onClick:function(){openImageEditor('erase',toolbar.ids[0]);}},'智能擦除'):null,
        toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action',title:'不经过主聊天，直接输入图片修改需求',onClick:function(){openImageEditor('edit',toolbar.ids[0]);}},'编辑图片'):null,
        toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action dsh-photoshop',title:'在 Photoshop 中打开链接文件；保存后自动刷新画布',onClick:function(){openInPhotoshop(toolbar.ids[0]);}},'Ps 编辑'):null,
        toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action dsh-illustrator',title:'在 Illustrator 中打开原文件；保存后自动刷新画布',onClick:function(){openInIllustrator(toolbar.ids[0]);}},'AI 编辑'):null,
        window.React.createElement('button',{className:'dsh-selection-action dsh-bridge-ps',title:'返回 Photoshop：直接送回正在运行的 PS——PSD 按图层并入当前文档（文字层可编辑）、其它格式作为图片置入，来自 PS 的内容回到原位；PS 没开时先留在项目 ADOBE桥接/发件箱，打开后在「DSH画布桥接」面板点「并入图层」',onClick:function(){requestBridgeReturn(toolbar.ids,"photoshop");}},'→Ps'),
        window.React.createElement('button',{className:'dsh-selection-action dsh-bridge-ai',title:'返回 Illustrator：直接送回正在运行的 AI——.ai/.svg 按对象并入当前文档（文字可编辑）、其它格式作为图片置入，来自 AI 的内容回到原位；AI 没开时先留在项目 ADOBE桥接/发件箱',onClick:function(){requestBridgeReturn(toolbar.ids,"illustrator");}},'→Ai'),
        toolbar.count===1&&["image","psd"].indexOf(toolbar.singleKind||"image")>=0?window.React.createElement('button',{className:'dsh-selection-action dsh-text-rebuild-action',title:'框选后由当前聊天模型理解文字，并生成可在 Photoshop 中继续编辑的 PSD',onClick:function(){requestTextRebuild(toolbar.ids[0]);}},'编辑文字'):null,
        window.React.createElement('div',{className:'dsh-selection-more'},
          window.React.createElement('button',{className:'dsh-selection-action dsh-more-toggle',title:'更多操作',onClick:function(e){e.stopPropagation();setMoreOpen(!moreOpen);}},'更多 ▾'),
          moreOpen?window.React.createElement('div',{className:'dsh-selection-menu',onClick:function(e){e.stopPropagation();setMoreOpen(false);}},
            window.React.createElement('div',{className:'dsh-tag-palette',title:'Mac 式颜色标记：整理画布时可按颜色筛选',onClick:function(e){e.stopPropagation();}},
              window.React.createElement('span',{style:{color:'#94a3b8',font:'600 11px/1 ui-rounded,"SF Pro Rounded",sans-serif',whiteSpace:'nowrap'}},'标记'),
              Object.keys(DSH_TAG_HEX).map(function(color){return window.React.createElement('button',{key:color,className:'dsh-tag-dot-btn',style:{background:DSH_TAG_HEX[color]},title:'把选中的 '+toolbar.count+' 张图片标记为该颜色',onClick:function(e){e.stopPropagation();setCanvasImageTag(toolbar.ids,color);setMoreOpen(false);}});}),
              window.React.createElement('button',{className:'dsh-selection-action',style:{height:'22px',fontSize:'11px',lineHeight:'22px'},title:'清除选中图片的颜色标记',onClick:function(e){e.stopPropagation();setCanvasImageTag(toolbar.ids,'');setMoreOpen(false);}},'清除')
            ),
            window.React.createElement('button',{className:'dsh-selection-action dsh-material-drag-action',draggable:true,title:'点击保存；也可按住拖到右侧素材库',onDragStart:function(e){e.stopPropagation();beginMaterialDrag(toolbar.ids,e);},onDragEnd:function(){post({type:'material-drag-end'});},onClick:function(){saveSelectionToMaterials(toolbar.ids);}},'加入素材库'),
            toolbar.count===1&&["image","psd"].indexOf(toolbar.singleKind||"image")>=0?window.React.createElement('button',{className:'dsh-selection-action',title:'扁平稿专用：限色、去毛刺后生成结构化 SVG，原图不会被覆盖',onClick:function(){requestVectorize(toolbar.ids[0],"flat");}},'结构矢量'):null,
            window.React.createElement('button',{className:'dsh-selection-action',title:'在画布中创建副本',onClick:function(){duplicateSelectedImages(toolbar.ids);}},'复制'),
            toolbar.count===1?window.React.createElement('button',{className:'dsh-selection-action',title:'修改图片文件名（不显示扩展名）',onClick:function(){setEditing({id:toolbar.ids[0],value:displayImageName(toolbar.singleName)});}},'重命名'):null,
            window.React.createElement('button',{className:'dsh-selection-action dsh-danger',title:'移入画布回收站，可撤销',onClick:function(){deleteSelectedImages(toolbar.ids);}},'删除'),
          ):null
        ),
      ):null),
      imageEditor?window.React.createElement(ImageEditDialog,{item:imageEditor,onClose:function(){if(!imageEditor.busy)setImageEditor(null);},onSubmit:submitImageEdit}):null
    );
  }
  root.render(window.React.createElement(Main));
  function hideImageInsertionTool(){document.querySelectorAll('[data-testid="toolbar-image"],[aria-label="插入图像"],[aria-label="Insert image"],[title^="插入图像"]').forEach(function(node){node.style.display='none';node.setAttribute('aria-hidden','true');var parent=node.parentElement;if(parent&&parent.children.length<=2&&String(parent.textContent||'').indexOf('插入图像')>=0){parent.style.display='none';}});}
  hideImageInsertionTool();
  if(window.MutationObserver) new MutationObserver(hideImageInsertionTool).observe(document.body,{childList:true,subtree:true});
// 外部拖入是用户明确操作，允许加入；agent 扫描/目录轮询不会触发这里。
// 栅格图自动等比压缩后上板，SVG/PDF/AI 交给宿主复制到项目 assets。
function blobToDataURL(blob){return new Promise(function(resolve,reject){var reader=new FileReader();reader.onload=function(){resolve(reader.result)};reader.onerror=reject;reader.readAsDataURL(blob);});}
function canvasBlob(canvas,quality){return new Promise(function(resolve,reject){canvas.toBlob(function(blob){if(blob)resolve(blob);else reject(new Error("图片压缩失败"));},"image/webp",quality);});}
function prepareExternalImage(file){
  return new Promise(function(resolve,reject){
    var url=URL.createObjectURL(file),img=new Image();
    img.onload=async function(){
      try{
        var originalW=img.naturalWidth||1,originalH=img.naturalHeight||1,maxSide=3200;
        if(file.size<=1887436&&Math.max(originalW,originalH)<=maxSide){resolve({dataURL:await blobToDataURL(file),dm:{w:originalW,h:originalH},before:file.size,after:file.size});return;}
        var scale=Math.min(1,maxSide/Math.max(originalW,originalH)),w=Math.max(1,Math.round(originalW*scale)),h=Math.max(1,Math.round(originalH*scale));
        var blob=null,quality=.9;
        for(var attempt=0;attempt<8;attempt+=1){
          var canvas=document.createElement("canvas");canvas.width=w;canvas.height=h;
          var context=canvas.getContext("2d",{alpha:true});context.drawImage(img,0,0,w,h);
          blob=await canvasBlob(canvas,quality);
          if(blob.size<=1887436)break;
          if(quality>.58)quality-=.1;else{w=Math.max(1,Math.round(w*.82));h=Math.max(1,Math.round(h*.82));}
        }
        if(!blob||blob.size>2097152)throw new Error("图片压缩后仍超过 2MB，请先缩小像素尺寸");
        resolve({dataURL:await blobToDataURL(blob),dm:{w:w,h:h},before:file.size,after:blob.size});
      }catch(err){reject(err)}finally{URL.revokeObjectURL(url)}
    };
    img.onerror=function(){URL.revokeObjectURL(url);reject(new Error("无法读取拖入的图片"));};img.src=url;
  });
}
function uniqueExternalFiles(list){var seen=new Set();return list.filter(function(file){var key=[file.name||"",file.size||0,file.lastModified||0,file.type||""].join("|");if(seen.has(key))return false;seen.add(key);return true;});}
function externalFileKind(file){var name=String(file&&file.name||"");if(!name||name.charAt(0)==="."||name.slice(0,2)==="._")return"";var m=/\.([a-z0-9]+)$/i.exec(name),ext=m?m[1].toLowerCase():"",mime=String(file&&file.type||"").toLowerCase();if(ext==="psd"||mime==="image/vnd.adobe.photoshop")return"psd";if(ext==="svg")return"svg";if(ext==="pdf")return"pdf";if(ext==="ai")return"ai";if(["png","jpg","jpeg","webp","gif","avif","bmp"].indexOf(ext)>=0||(mime.indexOf("image/")===0&&mime!=="image/vnd.adobe.photoshop"))return"image";return"";}
function isSupportedExternalFile(file){return !!externalFileKind(file);}
function transferHas(dt,type){return Array.prototype.indexOf.call(dt&&dt.types||[],type)>=0;}
window.addEventListener("dragover",function(e){var files=e.dataTransfer&&e.dataTransfer.files;if((files&&Array.prototype.some.call(files,isSupportedExternalFile))||transferHas(e.dataTransfer,"application/x-dsh-material")){e.preventDefault();e.stopImmediatePropagation();e.dataTransfer.dropEffect="copy";}},true);
window.addEventListener("drop",function(e){
  var materialRaw=e.dataTransfer&&e.dataTransfer.getData("application/x-dsh-material");
  if(materialRaw){e.preventDefault();e.stopImmediatePropagation();try{var material=JSON.parse(materialRaw);if(!material||!material.url)throw new Error("素材数据无效");insertChain=insertChain.catch(function(){}).then(function(){return fetch(material.url,{cache:"no-store"}).then(function(r){if(!r.ok)throw new Error("读取素材失败 HTTP "+r.status);return r.blob();}).then(blobToDataURL).then(function(dataURL){return dims2(dataURL).then(function(dm){addImageDataURL(dataURL,dm,{name:material.name||"素材.png",path:material.path||"",size:Number(material.size||0),managed:false,dropClientX:e.clientX,dropClientY:e.clientY});});});}).catch(function(err){post({type:"error",message:"素材拖入画布失败: "+String(err&&err.message||err)});});}catch(err){post({type:"error",message:"素材拖入画布失败: "+String(err&&err.message||err)});}return;}
  var files=e.dataTransfer&&e.dataTransfer.files?uniqueExternalFiles(Array.from(e.dataTransfer.files).filter(isSupportedExternalFile)):[];
  if(!files.length)return;e.preventDefault();e.stopImmediatePropagation();
  insertChain=insertChain.catch(function(){}).then(async function(){
    for(var i=0;i<files.length;i+=1){var file=files[i],kind=externalFileKind(file);if(kind==="image"){var prepared=await prepareExternalImage(file);addImageDataURL(prepared.dataURL,prepared.dm,{name:file.name,path:"",externalDrop:true});}else{var sourcePath=typeof file.path==="string"?file.path:"",dataURL=sourcePath?"":await blobToDataURL(file);parent.postMessage({type:"import-external-file",explicit:true,sourcePath:sourcePath,name:file.name,kind:kind,dataURL:dataURL},"*");}}
  }).catch(function(err){post({type:"error",message:"拖入文件失败: "+String(err&&err.message||err)});});
},true);
window.addEventListener("paste",function(e){
  var items=e.clipboardData&&e.clipboardData.items?Array.from(e.clipboardData.items):[];
  var files=uniqueExternalFiles(items.map(function(item){return item&&typeof item.getAsFile==="function"?item.getAsFile():null;}).filter(function(file){return file&&String(file.type||"").indexOf("image/")===0;}));
  if(!files.length)return;e.preventDefault();e.stopImmediatePropagation();
  insertChain=insertChain.catch(function(){}).then(async function(){
    for(var i=0;i<files.length;i+=1){var file=files[i],prepared=await prepareExternalImage(file);addImageDataURL(prepared.dataURL,prepared.dm,{name:file.name||("剪贴板图片-"+(i+1)+".png"),path:"",externalDrop:true});}
  }).catch(function(err){post({type:"error",message:"粘贴图片失败: "+String(err&&err.message||err)});});
},true);
// 聊天/工具结果回板必须复用统一的 Excalidraw 0.17 图片创建逻辑。
// capture + stopImmediatePropagation 用于拦截下方遗留的旧 add-image 分支，
// 避免缺少 status/scale/created 等字段的元素进入场景后触发持续重绘。
window.addEventListener("message",function(e){
  if(e.source!==window.parent)return;
  var d=e.data||{};
  if(d.type==="snapshot-request"){
    e.stopImmediatePropagation();
    try{post({type:"snapshot-response",requestId:d.requestId,snapshot:api?serialize(api.getSceneElements()||[],api.getAppState()||empty,api.getFiles()||new Map()):null});}
    catch(err){post({type:"snapshot-response",requestId:d.requestId,snapshot:null});}
    return;
  }
  if(d.type==="load"){
    e.stopImmediatePropagation();
    var hydrateFromDisk=async function(){
      try{
        /* 场景令牌：换场景时先取消防抖中迟到 changed 并刷新令牌，
           上一个项目的挂起 changed 即使已触发也会因 token 不匹配被父层丢弃 */
        window.__dshSceneToken=(typeof d.token==="string"&&d.token)?d.token:("t"+Date.now()+"_"+Math.random().toString(36).slice(2,8));
        if(window.__dshCancelPendingChanged)window.__dshCancelPendingChanged();
        var saved=typeof d.snapshot==="string"?JSON.parse(d.snapshot):d.snapshot;
        if(!saved||!saved.elements||typeof requestSceneLoad!=="function")return;
        /* 性能 v3：磁盘快照的 files 只带 dshPath 引用（无 dataURL），这里
           并发还原为 dataURL 后再进 requestSceneLoad；单文件失败静默跳过，
           画布上表现为占位，不影响其余图片与场景结构。 */
        var jobs=[];
        if(saved.files)Object.keys(saved.files).forEach(function(k){
          var v=saved.files[k];
          if(v&&!v.dataURL&&v.dshPath){
            jobs.push(fetch("/dsh-canvas/image?path="+encodeURIComponent(v.dshPath)).then(function(r){
              if(!r.ok)throw new Error("fetch "+r.status);
              return r.blob();
            }).then(function(b){
              return new Promise(function(res){
                var fr=new FileReader();
                fr.onload=function(){res(fr.result)};
                fr.onerror=function(){res(null)};
                fr.readAsDataURL(b);
              });
            }).then(function(url){
              if(url){v.dataURL=url;var m=String(url).match(/^data:([^;]+)/i);if(m&&!v.mimeType)v.mimeType=m[1];}
            }).catch(function(err){post({type:"error",message:"画布图片还原失败("+String((err&&err.message)||err).slice(0,80)+")，已保留占位"});}));
          }
        });
        if(jobs.length)await Promise.all(jobs);
        requestSceneLoad(saved);
      }catch(err){post({type:"error",message:"恢复画布失败: "+String(err&&err.message||err)});}
    };
    hydrateFromDisk();
    return;
  }
  if(d.type==="refresh-source"){
    e.stopImmediatePropagation();
    refreshSourceImage(d).catch(function(err){post({type:"error",message:"源图片刷新失败: "+String(err&&err.message||err)});});
    return;
  }
  if(d.type==="rename-result"){
    e.stopImmediatePropagation();
    if(api&&d.id){var renamed=(api.getSceneElements()||[]).map(function(item){if(!item||item.id!==d.id)return item;return Object.assign({},item,{customData:Object.assign({},item.customData||{},{dshFileName:d.name||item.customData&&item.customData.dshFileName,dshSourcePath:d.sourcePath||item.customData&&item.customData.dshSourcePath}),version:Number(item.version||1)+1,versionNonce:Math.floor(Math.random()*1e9),updated:Date.now()});});api.updateScene({elements:renamed,appState:Object.assign({},api.getAppState()||empty),commitToHistory:false});}
    return;
  }
  if(d.type==="bind-managed"){
    e.stopImmediatePropagation();bindManagedImage(d);return;
  }
  if(d.type==="remove-sources"){
    e.stopImmediatePropagation();removeSourceElements(d.ids||[]);return;
  }
  if(d.type==="placeholder-progress"){
    e.stopImmediatePropagation();var pid=String(d.placeholderId||"");if(pid){pendingProgress[pid]={percent:d.percent,stage:d.stage,message:d.message};if(typeof bumpPending==="function")bumpPending();}return;
  }
  if(d.type==="arrange-images"){
    e.stopImmediatePropagation();arrangeCanvasImages(d);return;
  }
  if(d.type==="set-theme-background"){
    e.stopImmediatePropagation();
    // DSH 主题推送：画布背景与 Excalidraw 内部 UI 主题跟随 DSH（而非系统外观）。
    var nextColor=String(d.color||"");
    if(!/^(#[0-9a-f]{3,8}|rgb)/i.test(nextColor))return;
    systemDark=!!d.dark;canvasDefaultBackground=nextColor;
    // srcdoc 的 html/body/.excalidraw-container 链式背景用 --dsh-bg 变量渲染，
    // 只改 viewBackgroundColor 不够——那些 CSS 背景会把整个 iframe 涂黑。
    // fg/surface/line/hover 同时供给选区工具栏等 iframe 内 UI 跟随 DSH 主题；
    // 空值不设置，让 CSS 兜底值生效。
    try{
      var rootStyle=document.documentElement.style;
      rootStyle.setProperty("--dsh-bg",nextColor);
      var fgColor=String(d.fg||"");
      if(!fgColor)fgColor=d.dark?"#f8fafc":"#1f2937";
      rootStyle.setProperty("--dsh-fg",fgColor);
      rootStyle.setProperty("--dsh-fg-muted",fgColor);
      if(d.surface)rootStyle.setProperty("--dsh-surface",String(d.surface));
      if(d.line)rootStyle.setProperty("--dsh-line",String(d.line));
      if(d.hover)rootStyle.setProperty("--dsh-hover",String(d.hover));
      rootStyle.colorScheme=d.dark?"dark":"light";
    }catch(cssErr){}
    if(api&&typeof api.updateScene==="function"){
      try{api.updateScene({appState:Object.assign({},api.getAppState()||empty,{viewBackgroundColor:nextColor,theme:d.dark?"dark":"light"}),commitToHistory:false});}catch(themeErr){}
    }
    return;
  }
  if(d.type==="image-edit-result"){
    e.stopImmediatePropagation();addEditedImage(d).catch(function(err){markEditPlaceholderFailed({requestId:d.requestId,placeholderId:d.placeholderId,message:String(err&&err.message||err)});});return;
  }
  if(d.type==="image-remove-bg-result"){
    e.stopImmediatePropagation();addBackgroundRemovedImage(d).catch(function(err){markEditPlaceholderFailed({requestId:d.requestId,placeholderId:d.placeholderId,message:String(err&&err.message||err)});});return;
  }
  if(d.type==="image-vectorized-result"){
    e.stopImmediatePropagation();addVectorizedImage(d).catch(function(err){post({type:"error",message:"加入矢量结果失败: "+String(err&&err.message||err)});});return;
  }
  if(d.type==="image-edit-error"){
    e.stopImmediatePropagation();if(!reopenFailedImageEdit(d))markEditPlaceholderFailed(d);return;
  }
  if(d.type==="image-remove-bg-error"){
    e.stopImmediatePropagation();markEditPlaceholderFailed(d);return;
  }
  if(d.type!=="add-image"||!d.url)return;
  e.stopImmediatePropagation();
  if(d.explicit!==true){post({type:"error",message:"已忽略非用户发起的图片加入请求"});return;}
  if(!api){post({type:"error",message:"添加图片失败: 画布尚未就绪"});return;}
  insertChain=insertChain.catch(function(){}).then(function(){return toDataURL(d.url).then(function(dataURL){
    return dims2(dataURL).then(function(dm){addImageDataURL(dataURL,dm,{name:d.name||baseName2(d.path||""),path:d.path||"",mtime:d.mtime||0,size:d.size||0,kind:d.kind||"image",managed:d.managed,batchIndex:d.batchIndex,batchTotal:d.batchTotal,batchColumns:d.batchColumns,customData:d.customData||null,openEditor:d.openEditor===true,editorMode:"edit"});});
  });}).catch(function(err){post({type:"error",message:"添加图片失败: "+String(err&&err.message||err)});});
},true);
var toDataURL=function(u){return fetch(u).then(function(r){return r.blob()}).then(function(b){return new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(fr.result)};fr.onerror=rej;fr.readAsDataURL(b)})})};var dims=function(d){return new Promise(function(res){var i=new Image();i.onload=function(){res({w:i.naturalWidth,h:i.naturalHeight})};i.onerror=function(){res({w:200,h:130})};i.src=d})};window.addEventListener("message",function(e){if(e.source!==window.parent)return;var d=e.data||{};try{if(d.type==="chat-gen-placeholder"&&d.id){if(!api){post({type:"chat-gen-placeholder-deferred",id:d.id});return}try{createChatPlaceholder(d)}catch(err){post({type:"chat-gen-soft-error",message:"生成占位未创建: "+String(err&&err.message||err)})}return}if(d.type==="chat-gen-resolve"&&d.id&&d.url&&api){resolveChatPlaceholder(d).catch(function(err){post({type:"chat-gen-resolve-failed",id:d.id,url:d.url,path:d.path||"",name:d.name||"",message:String(err&&err.message||err)});post({type:"chat-gen-soft-error",message:"生成图未上画布: "+String(err&&err.message||err)})});return}if(d.type==="chat-gen-fail"&&d.id&&api){try{failChatPlaceholder(d)}catch(err){}return}if(d.type==="add-image"&&d.url&&api){toDataURL(d.url).then(function(dataURL){return dims(dataURL).then(function(dm){var fileId="f_"+Math.random().toString(36).slice(2,9);var ratio=(dm.w&&dm.h&&dm.h>0)?dm.w/dm.h:1.6;var w=220,h=Math.round(w/ratio);var mime=(String(dataURL).match(/^data:([^;]+)/i)||[])[1]||"image/png";var el={type:"image",id:"e_"+Math.random().toString(36).slice(2,9),fileId:fileId,x:150,y:150,width:w,height:h,angle:0,seed:Math.floor(Math.random()*1e9),version:1,versionNonce:Math.floor(Math.random()*1e9),isDeleted:false,groupIds:[],boundElements:null,updated:Date.now(),link:null,locked:false,customData:d.customData||null,roundness:null,mimeType:mime};var files=(function(){var m=new Map();var b=api.getFiles()||{};if(typeof b.forEach==="function"){b.forEach(function(v,k){m.set(k,v)});}else if(typeof b==="object"){Object.keys(b).forEach(function(k){m.set(k,b[k])});}return m;})();if(typeof api.addFiles==="function"){try{api.addFiles([{id:fileId,dataURL:dataURL,mimeType:mime}])}catch(e){}}api.updateScene({elements:(api.getSceneElements()||[]).concat([el]),appState:Object.assign({},api.getAppState()||empty)});post({type:"added"});if(d.openEditor&&d.customData&&d.customData.dshLayerEdit&&typeof openImageEditorById==="function"){setTimeout(function(){openImageEditorById("edit",el.id);},160);}})}).catch(function(err){post({type:"error",message:"添加图片失败: "+String(err&&err.message||err)})})}else if(d.type==="load"&&api){var s=typeof d.snapshot==="string"?JSON.parse(d.snapshot):d.snapshot;if(s&&s.elements){var files=new Map();if(s.files)Object.keys(s.files).forEach(function(k){var v=s.files[k];files.set(k,{id:k,dataURL:v.dataURL,mimeType:v.mimeType})});api.updateScene({elements:s.elements,appState:Object.assign({},s.appState||empty),files:files})}}else if(d.type==="export"&&api){var elements=(api.getSceneElements()||[]).filter(function(item){return item&&!item.isDeleted&&item.id!=="dsh_theme_backdrop";});if(!elements.length){post({type:"exported",error:"empty"});return;}var exporter=window.ExcalidrawLib&&window.ExcalidrawLib.exportToBlob;if(typeof exporter!=="function"){post({type:"error",message:"导出失败: 当前 Excalidraw 未提供 PNG 导出器"});return;}var state=Object.assign({},api.getAppState()||empty,{exportBackground:true,exportWithDarkMode:false,exportScale:1});Promise.resolve(exporter({elements:elements,appState:state,files:fileObject(api.getFiles?api.getFiles():{}),mimeType:"image/png"})).then(function(blob){var fr=new FileReader();fr.onloadend=function(){post({type:"exported",dataUrl:fr.result})};fr.onerror=function(){post({type:"error",message:"导出失败: 无法读取 PNG 数据"})};fr.readAsDataURL(blob)}).catch(function(err){post({type:"error",message:"导出失败: "+String(err&&err.message||err)})})}else if(d.type==="clear"&&api){api.updateScene({elements:[],appState:empty,files:new Map()});post({type:"changed",snapshot:serialize([],empty,new Map()),token:window.__dshSceneToken||""})}}catch(err){post({type:"error",message:String(err&&err.message||err)})}});})();</script></body></html>`;
    // Excalidraw/React are pinned vendor assets served by the plugin host.
    // Keeping these scripts off a public CDN prevents DSH srcdoc/CSP changes
    // or domestic-network failures from leaving the canvas at "loading".
    const EXCALIDRAW_VENDOR_BOOTSTRAP = '<script>(function(){var report=function(message){try{window.parent.postMessage({type:"error",message:message},"*")}catch(e){}try{var node=document.createElement("div");node.className="dsh-err";node.textContent=message;document.body.appendChild(node)}catch(e){}};window.__dshCanvasVendorError=function(name){report("画布本地资源加载失败："+name)};window.addEventListener("error",function(event){report("画布运行错误："+String(event&&event.message||event&&event.error||"未知错误"))});window.addEventListener("unhandledrejection",function(event){report("画布异步错误："+String(event&&event.reason&&event.reason.message||event&&event.reason||"未知错误"))});setTimeout(function(){if(!document.querySelector(".excalidraw"))report("画布初始化超时，请重新加载 DSH")},12000)})();<\/script><script src="/dsh-canvas/vendor/react.js" onerror="window.__dshCanvasVendorError(\'React\')"><\/script><script src="/dsh-canvas/vendor/react-dom.js" onerror="window.__dshCanvasVendorError(\'ReactDOM\')"><\/script><script src="/dsh-canvas/vendor/excalidraw.js" onerror="window.__dshCanvasVendorError(\'Excalidraw\')"><\/script>';
    const EXCALIDRAW_SRCDOC_LOCAL = EXCALIDRAW_SRCDOC.replace(
      '<script crossorigin src="https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js"></script><script crossorigin src="https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js"></script><script src="https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.17.6/dist/excalidraw.production.min.js"></script>',
      EXCALIDRAW_VENDOR_BOOTSTRAP
    );

    // Excalidraw 默认菜单包含社交链接分组；画布是 DSH 内嵌工具，不需要这些入口。
    // 文件名标签是画布自有的绝对定位层；菜单展开时暂时隐藏它，避免遮挡菜单内容。
    // 两项均通过插件自有的轻量 MutationObserver 实现，不改动上游 UMD 包。
    const EXCALIDRAW_SRCDOC_CLEAN = EXCALIDRAW_SRCDOC_LOCAL.replace(
      '</body></html>',
      '<script>(function(){var pending=false;function syncMenu(){pending=false;try{var menus=document.querySelectorAll(".dropdown-menu"),i,m,b,cs,open=false;for(i=0;i<menus.length;i+=1){m=menus[i];b=m.getBoundingClientRect();cs=window.getComputedStyle(m);if(cs.display!=="none"&&cs.visibility!=="hidden"&&b.width>0&&b.height>0){open=true;break}}if(document.body)document.body.classList.toggle("dsh-excalidraw-menu-open",open)}catch(e){}}function schedule(){if(pending)return;pending=true;if(window.requestAnimationFrame)window.requestAnimationFrame(syncMenu);else window.setTimeout(syncMenu,0)}function hide(){try{var groups=document.querySelectorAll(".dropdown-menu-group"),i,g,t,p,n;for(i=0;i<groups.length;i+=1){g=groups[i];t=g.querySelector(".dropdown-menu-group-title");if(!t||String(t.textContent||"").trim().toLowerCase()!=="excalidraw links")continue;g.classList.add("dsh-hidden-social-links");p=g.previousElementSibling;n=g.nextElementSibling;[p,n].forEach(function(el){if(el&&el.children&&el.children.length===0&&String(el.style&&el.style.height||"")==="1px")el.classList.add("dsh-hidden-social-links")})}}catch(e){}schedule()}if(window.MutationObserver){new MutationObserver(hide).observe(document.documentElement,{childList:true,subtree:true})}document.addEventListener("pointerdown",schedule,true);document.addEventListener("click",schedule,true);document.addEventListener("keydown",function(e){if(e&&e.key==="Escape")schedule()},true);hide()})();</script></body></html>'
    );

    // ---- right-docked overlay panel ----
    // ---- real split-pane: push the app content left by the panel width ----
    function findAppFrame() {
      const layer = document.querySelector('[data-shell-overlay]');
      return layer && layer.parentElement ? layer.parentElement : null;
    }
    let layoutPulseFrame = 0;
    let layoutPulseTimer = 0;
    let layoutPulseLateTimer = 0;
    let framePaddingToken = 0;
    function notifySplitLayout() {
      cancelAnimationFrame(layoutPulseFrame);
      clearTimeout(layoutPulseTimer);
      clearTimeout(layoutPulseLateTimer);
      layoutPulseFrame = requestAnimationFrame(() => {
        layoutPulseFrame = requestAnimationFrame(() => {
          // DSH 的聊天列表和输入框会缓存可用宽度；主动模拟一次窗口尺寸变化，
          // 等价于用户手动拖动分隔条，但不会移动实际窗口。
          window.dispatchEvent(new Event('resize'));
          if (window.visualViewport) window.visualViewport.dispatchEvent(new Event('resize'));
        });
      });
      // 字体、会话输入框等异步布局完成后再校正一次。
      layoutPulseTimer = setTimeout(() => window.dispatchEvent(new Event('resize')), 180);
      layoutPulseLateTimer = setTimeout(() => window.dispatchEvent(new Event('resize')), 720);
    }
    function applyFramePadding(px) {
      const frame = findAppFrame();
      const token = ++framePaddingToken;
      if (frame) {
        frame.style.boxSizing = px ? 'border-box' : '';
        frame.style.minWidth = px ? '0' : '';
        // 刷新恢复时用 1px 无感几何变化触发聊天区真实 ResizeObserver，
        // 再回到目标宽度；等价于用户轻拉一次分隔条。
        frame.style.paddingRight = px ? (px + 1) + 'px' : '';
        void frame.offsetWidth;
        if (px) requestAnimationFrame(() => {
          if (token !== framePaddingToken || findAppFrame() !== frame) return;
          frame.style.paddingRight = px + 'px';
          void frame.offsetWidth;
          notifySplitLayout();
        });
      }
      notifySplitLayout();
    }

    function canvasPathWithin(parent, child) {
      const base = String(parent || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/g, '');
      const target = String(child || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/g, '');
      if (!base || !target) return false;
      const insensitive = /^[A-Za-z]:\//.test(base) || /^[A-Za-z]:\//.test(target);
      const left = insensitive ? base.toLowerCase() : base;
      const right = insensitive ? target.toLowerCase() : target;
      return right === left || right.indexOf(left + '/') === 0;
    }

    class CanvasOverlayBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error };
      }
      componentDidCatch(error) {
        try { console.error('[canvas-workbench] CanvasOverlay render failed', error); } catch (_) {}
      }
      render() {
        if (!this.state.error) return React.createElement(CanvasOverlay, this.props);
        const message = String(this.state.error && this.state.error.message || this.state.error || 'unknown error');
        return React.createElement('div', {
          style: { position: 'fixed', top: 0, right: 0, bottom: 0, width: '420px', zIndex: 1000, background: '#15171c', color: '#fecaca', padding: '24px', boxSizing: 'border-box', font: '13px/1.5 sans-serif', whiteSpace: 'pre-wrap', overflow: 'auto', pointerEvents: 'auto' }
        }, 'Canvas overlay failed\\n' + message);
      }
    }

    // 引擎设置弹窗里的「本地工具链」状态卡:后台预置(python/rembg/模型/矢量/dsh-codex)
    // 的实时状态 + 手动「立即准备」。预置在插件启动时自动开始,这里只是可视化与兜底入口。
    const TOOLCHAIN_LABELS = {
      python: 'Python 运行时',
      rembg: '去背景引擎',
      vectorize: '转矢量引擎',
      rembgModel: '去背景模型(BiRefNet 约214MB)',
      ocr: 'OCR 文字识别',
      psdTools: 'PSD 导出引擎',
      dshCodex: 'dsh-codex 引擎'
    };

    function ToolchainCard(props) {
      const status = props.toolchain;
      const [busy, setBusy] = React.useState(false);
      const [logText, setLogText] = React.useState('');
      const [logOpen, setLogOpen] = React.useState(false);
      // 打开期间 3s 轮询刷新(有 downloading/preparing 时进度会动)
      React.useEffect(() => {
        if (!status) return undefined;
        const items = (status && status.items) || {};
        const active = Object.values(items).some((item) => item && (item.state === 'downloading' || item.state === 'preparing' || item.state === 'extracting'));
        if (!active) return undefined;
        const timer = window.setInterval(() => {
          if (typeof props.onRefresh === 'function') props.onRefresh();
        }, 3000);
        return () => window.clearInterval(timer);
      }, [status]);
      if (!status || !status.items) return null;
      const entries = Object.keys(TOOLCHAIN_LABELS)
        .map((key) => ({ key, label: TOOLCHAIN_LABELS[key], item: status.items[key] }))
        .filter((entry) => entry.item);
      if (!entries.length) return null;
      const stateText = (item) => {
        switch (item.state) {
          case 'ready': return '已就绪';
          case 'downloading': return item.percent ? '下载中 ' + item.percent + '%' : '下载中…';
          case 'extracting': return '解压中…';
          case 'preparing': return '安装依赖中…';
          case 'error': return '失败:' + String(item.error || '').slice(0, 40);
          case 'skipped': return '本机不可用:' + String(item.reason || '');
          default: return item.state || '…';
        }
      };
      const allReady = entries.every((entry) => entry.item.state === 'ready');
      const prepareNow = () => {
        setBusy(true);
        fetch('/dsh-canvas/toolchain-prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
          .catch(() => {})
          .finally(() => { setBusy(false); if (typeof props.onRefresh === 'function') props.onRefresh(); });
      };
      const toggleLog = () => {
        const next = !logOpen;
        setLogOpen(next);
        if (next) {
          fetch('/dsh-canvas/toolchain-log?lines=80').then((r) => r.text()).then(setLogText).catch(() => setLogText('(日志读取失败)'));
        }
      };
      return React.createElement('div', { className: 'dsh-canvas-toolchain' },
        React.createElement('div', { className: 'dsh-canvas-toolchain-head' },
          React.createElement('span', null, '本地工具链'),
          React.createElement('small', null, allReady ? '全部就绪，无需等待' : '后台自动准备，首次使用前无需手动操作'),
          allReady ? null : React.createElement('button', { className: 'dsh-canvas-tb', disabled: busy, onClick: prepareNow }, busy ? '准备中…' : '立即准备'),
          React.createElement('button', { className: 'dsh-canvas-tb', onClick: toggleLog }, logOpen ? '收起日志' : '运行日志')
        ),
        React.createElement('div', { className: 'dsh-canvas-toolchain-rows' },
          entries.map((entry) => React.createElement('div', { key: entry.key, className: 'dsh-canvas-toolchain-row' },
            React.createElement('span', { className: 'dsh-canvas-toolchain-name' }, entry.label),
            React.createElement('span', { className: 'dsh-canvas-toolchain-state is-' + entry.item.state }, stateText(entry.item))
          ))
        ),
        logOpen ? React.createElement('pre', { className: 'dsh-canvas-toolchain-log', style: { maxHeight: '180px', overflow: 'auto', margin: '6px 0 0', padding: '8px', fontSize: '11px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all', opacity: 0.9 } }, logText || '…') : null
      );
    }
    // Windows 官方桌面用自绘标题栏(顶部一条 -webkit-app-region:drag 拖拽区,
    // 右上是系统最小化/关闭按钮)。画布工具栏若与它同行,点击会被拖拽区吞掉
    // (实测:换行到第二行的按钮就能点)。检测到 Windows 时整体下移避开。
    const IS_WINDOWS_UI = /Windows/i.test(String(navigator.userAgent || ''));
    // 实测高度优先:应用的 [data-windows-titlebar] 标记元素 → 继承的 CSS 变量 → 经验值。
    // 不直接依赖 CSS var(某些装配下不继承到 overlay,1.9.2 在 Win 实机未生效)。
    const measureWindowsTitlebar = () => {
      let height = 0;
      let source = 'none';
      try {
        const marked = document.querySelector('[data-windows-titlebar]');
        if (marked) {
          const rect = marked.getBoundingClientRect();
          if (rect && rect.height > 0 && rect.height < 120) { height = Math.ceil(rect.height); source = 'attr-rect'; }
        }
        if (!height) {
          const probe = document.querySelector('[data-windows-titlebar] *') || document.body;
          const value = getComputedStyle(probe).getPropertyValue('--dsh-windows-titlebar-height').trim();
          const parsed = parseFloat(value);
          if (Number.isFinite(parsed) && parsed > 0) { height = Math.ceil(parsed); source = 'css-var'; }
        }
      } catch (err) {}
      if (!height) { height = 40; source += '+fallback'; }
      return { height, source };
    };

    function CanvasOverlay() {
      const [on, setOn] = React.useState(getMode());
      const minimumChatWidth = 520;
      const clampPanelWidth = React.useCallback((value) => {
        const viewport = Math.max(720, window.innerWidth || 0);
        const maxByChat = Math.max(320, viewport - minimumChatWidth);
        return Math.max(320, Math.min(Math.round(value), Math.round(viewport * 0.75), maxByChat));
      }, []);
      const [width, setWidth] = React.useState(() => {
        let saved = 0;
        try { saved = Number(window.localStorage.getItem(PANEL_WIDTH_KEY) || 0); } catch (err) {}
        return clampPanelWidth(saved > 0 ? saved : window.innerWidth * 0.5);
      });
      const [status, setStatus] = React.useState('loading');
      const [feedback, setFeedback] = React.useState('');
      const [removeProgress, setRemoveProgress] = React.useState(null);
      const [projectInfo, setProjectInfo] = React.useState({ cwd: activeChatCwd, sessionId: activeChatSessionId, project: chosenProject(activeChatCwd, activeChatSessionId) });
      activeCanvasProjectPath = String(projectInfo.project || '');
      React.useEffect(() => {
        activeCanvasProjectPath = String(projectInfo.project || '');
        activeChatContextRevision += 1;
        window.dispatchEvent(new CustomEvent('dsh-canvas:project-context', {
          detail: { cwd: activeChatCwd, sessionId: activeChatSessionId, project: activeCanvasProjectPath }
        }));
      }, [projectInfo.project]);
      // 聊天生图状态轮询:宿主是生成起止与产出路径的唯一权威来源。
      // 自动上画布开启时:active 增长 → 在画布里创建与「编辑图片」同款的
      // 生成中占位元素(斜纹+转圈 SVG,占据图片即将落地的位置);完成路径
      // → 原位替换为真实图片;active 归零后的孤儿占位 → 标记失败。
      // 没有占位可替换时(占位被用户删掉)回退到普通自动加入。
      const chatPendingRef = React.useRef([]);
      const chatHandledRef = React.useRef(new Set());
      const chatProjectAskedRef = React.useRef({ sessionId: '', asked: false });
      const openProjectListRefHolder = React.useRef(null);
      React.useEffect(() => {
        if (!on) { chatPendingRef.current = []; return; }
        let stopped = false;
        const tokenOf = () => Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
        // 判重用文件指纹:失败返回 ''(视为无法确认,不拦截,宁可多上不漏图)。
        const fileDigestOf = (p) => fetch('/dsh-canvas/file-digest?path=' + encodeURIComponent(p), { cache: 'no-store' })
          .then((r) => r.json())
          .then((d) => (d && d.ok && d.md5) ? String(d.md5) : '')
          .catch(() => '');
        const tick = async () => {
          try {
            const res = await fetch('/dsh-canvas/generation-status', { headers: { accept: 'application/json' } });
            if (!res.ok) return;
            const data = await res.json();
            if (stopped) return;
            const active = Number(data.active) || 0;
            const pending = chatPendingRef.current;
            const chatCtx = projectRef.current || {};
            const unbound = !chatCtx.project;
            const dismissedThisSession = chatProjectAskedRef.current.sessionId === chatCtx.sessionId && chatProjectAskedRef.current.dismissed;
            const unprocessed = Array.isArray(data.completed)
              ? data.completed.filter((item) => item && item.path && !chatHandledRef.current.has(String(item.path))).length
              : 0;
            // 未绑定画布项目:在聊天输入区(设计模式开关旁)显示询问横幅,不弹画布模态框
            // (模态会盖住画布阻断交互)。横幅期间占位与自动上画暂缓,绑定后自动补上;
            // 点「本次手动加入」后,本会话的完成路径标记为已处理,回纯手动模式。
            const askShow = canvasAutoAddEnabled() && unbound && !dismissedThisSession && (active > 0 || unprocessed > 0);
            const askState = JSON.stringify({ show: askShow, active });
            if (window.__dshCanvasGenAskState !== askState) {
              window.__dshCanvasGenAskState = askState;
              window.dispatchEvent(new CustomEvent('dsh-canvas:gen-state', { detail: { show: askShow, active } }));
            }
            if (canvasAutoAddEnabled() && unbound && !dismissedThisSession && (active > 0 || unprocessed > 0)) return;
            if (canvasAutoAddEnabled() && unbound && dismissedThisSession && Array.isArray(data.completed)) {
              for (const item of data.completed) {
                if (item && item.path) chatHandledRef.current.add(String(item.path));
              }
              return;
            }
            if (canvasAutoAddEnabled()) {
              // 占位数量对齐进行中数量(用户删掉的占位不重建,完成时走回退)
              while (pending.length < active) {
                const id = 'e_chat_pending_' + tokenOf();
                post({ type: 'chat-gen-placeholder', id, index: pending.length, subtitle: active > 1 ? '批量生成中 ×' + active + ',完成后自动加入画布' : '完成后自动加入画布' });
                pending.push(id);
              }
            }
            if (Array.isArray(data.completed) && canvasAutoAddEnabled()) {
              for (const item of data.completed) {
                if (!item || !item.path) continue;
                const path = String(item.path);
                // 宿主的完成记录是环形列表,每轮轮询都会重放:同一路径无论走
                // 占位原位替换还是兜底加入,只处理一次,否则会出现两张一样的图。
                if (chatHandledRef.current.has(path)) continue;
                chatHandledRef.current.add(path);
                // 整页重载后 chatHandledRef / autoAddDispatched 都会清零，而宿主的
                // 完成记录环形列表仍会重放近期路径：按画布已有元素兜底去重。
                // 注意物化副本会撞名改名（name-2.png）：元素指向 assets 缓存路径、
                // 文件名带 -N 后缀，与重放的归档原始路径/原始名都对不上——路径
                // 之外再按「剥掉末尾 -数字 后缀的归一化文件名」比对，两个维度
                // 任一命中即视为已在画布，阻断重放链路的重复加入。
                const dispatchName = String(imageName(path) || '').toLowerCase().replace(/(-\d+)+(?=\.[a-z]+$)/i, '').replace(/\.[a-z0-9]+$/i, '');
                // 主干同名只是「疑似重复」:重新生成的图(Z01-2.png)与已有(Z01.png)
                // 同主干但内容全新,只按名字跳过会漏图(实测误伤整轮重新生成)。
                // 路径相同 → 已在画布;主干相同时再按文件 md5 字节级确认——一致
                // (物化缓存副本)才跳过,不一致(重新生成)放行。md5 取不到时不拦。
                let alreadyOnCanvas = false;
                for (const item of (latestSnapshot.current || {}).elements || []) {
                  if (!item || item.type !== 'image' || item.isDeleted || !item.customData) continue;
                  const elPath = String(item.customData.dshSourcePath || '');
                  if (elPath === path) { alreadyOnCanvas = true; break; }
                  const elName = String(item.customData.dshFileName || '').toLowerCase().replace(/(-\d+)+(?=\.[a-z]+$)/i, '').replace(/\.[a-z0-9]+$/i, '');
                  if (dispatchName && elName === dispatchName) {
                    const digests = await Promise.all([fileDigestOf(path), elPath ? fileDigestOf(elPath) : Promise.resolve('')]);
                    if (digests[0] && digests[0] === digests[1]) { alreadyOnCanvas = true; break; }
                  }
                }
                if (alreadyOnCanvas) continue;
                const name = imageName(path) || '聊天生成.png';
                const slotId = pending.shift();
                if (slotId) {
                  post({ type: 'chat-gen-resolve', id: slotId, url: '/dsh-canvas/image?path=' + encodeURIComponent(path), path, name });
                } else {
                  dispatchGeneratedToCanvas(path);
                }
              }
              if (chatHandledRef.current.size > 500) {
                chatHandledRef.current = new Set([...chatHandledRef.current].slice(-500));
              }
            }
            // 生成全部结束但仍有占位:完成环里还有未处理路径说明结果正在归档/在途,
            // 不能判死;只有确实没有任何在途结果时才留观 10 秒后标记失败
            // (外置盘归档 + v4 会话写入可能超过旧 4 秒窗口,曾把好占位误判成失败)。
            if (active === 0 && pending.length) {
              if (unprocessed > 0) {
                if (tick.settleTimer) { window.clearTimeout(tick.settleTimer); tick.settleTimer = null; }
              } else if (!tick.settleTimer) {
                tick.settleTimer = window.setTimeout(() => {
                  tick.settleTimer = null;
                  const rest = chatPendingRef.current;
                  if (rest.length && !stopped) {
                    chatPendingRef.current = [];
                    for (const id of rest) post({ type: 'chat-gen-fail', id, message: '生成已结束但没有等到结果——删除后重新生成即可' });
                  }
                }, 10000);
              }
            } else if (tick.settleTimer) {
              window.clearTimeout(tick.settleTimer);
              tick.settleTimer = null;
            }
          } catch (err) {}
        };
        tick();
        const timer = window.setInterval(tick, 2000);
        return () => {
          stopped = true;
          window.clearInterval(timer);
          if (tick.settleTimer) window.clearTimeout(tick.settleTimer);
        };
      }, [on]);
      const [projectDialog, setProjectDialog] = React.useState(null);
      const [projectList, setProjectList] = React.useState({ loading: false, items: [], error: '' });
      const [moreMenuOpen, setMoreMenuOpen] = React.useState(false);
      const [updateInfo, setUpdateInfo] = React.useState(null);
      const [updating, setUpdating] = React.useState(false);
      const refreshUpdateInfo = (silent) => {
        fetch('/dsh-canvas/update-check', { cache: 'no-store' }).then((r) => r.json()).then((d) => {
          setUpdateInfo(d);
          if (!silent && d) {
            setFeedback(d.hasUpdate ? '🔄 发现新版本 ' + d.latest + '（更多菜单可一键更新）' : '✓ 已是最新版 ' + (d.current || ''));
          }
        }).catch(() => {});
      };
      React.useEffect(() => {
        let last = 0;
        try { last = Number(window.localStorage.getItem('dsh-canvas-update-checked-at') || 0); } catch (err) {}
        if (Date.now() - last < 24 * 60 * 60 * 1000) return undefined;
        try { window.localStorage.setItem('dsh-canvas-update-checked-at', String(Date.now())); } catch (err) {}
        const timer = window.setTimeout(() => refreshUpdateInfo(false), 6000);
        return () => window.clearTimeout(timer);
      }, []);
      // Adobe 桥接安装状态：默认按"已装"处理不显示安装按钮，打开「更多」菜单时查一次实际状态，
      // 缺菜单脚本 / CEP 面板才显示对应安装入口（装完按钮即消失，避免常驻三个一次性动作）。
      const [adobeInstall, setAdobeInstall] = React.useState({ scriptsInstalled: true, cepInstalled: true });
      const [imageSettings, setImageSettings] = React.useState(null);
      const [toolchain, setToolchain] = React.useState(null);
      React.useEffect(() => {
        fetch('/dsh-canvas/toolchain-status').then((r) => r.json()).then((d) => { if (d && d.ok) setToolchain(d.status); }).catch(() => {});
      }, []);
      const [imageSettingsBusy, setImageSettingsBusy] = React.useState(false);
      const [autoAddOn, setAutoAddOnState] = React.useState(canvasAutoAddEnabled());
      const [textRebuild, setTextRebuild] = React.useState(null);
      const projectRef = React.useRef({ cwd: activeChatCwd, sessionId: activeChatSessionId, project: chosenProject(activeChatCwd, activeChatSessionId) });
      const projectSwitchToken = React.useRef(0);
      // 场景令牌：每次向 iframe 发 load 都换新值；iframe 回传的 changed 必须携带
      // 当前令牌，否则视为上一个场景的迟到消息丢弃。防止 600ms 防抖的 changed
      // 跨项目切换后触发，把 A 项目场景合并进 B 项目（会清空 files、误触
      // scheduleRemovedImages 把图片移入画布回收站）。
      const canvasLoadToken = React.useRef('');
      const newLoadToken = () => 'lt' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const postSceneLoad = (snapshot) => {
        canvasLoadToken.current = newLoadToken();
        post({ type: 'load', snapshot: JSON.stringify(snapshot), token: canvasLoadToken.current });
      };
      const switchingProject = React.useRef(false);
      // —— 素材库：独立于画布项目的自定义目录，支持最近访问与双向拖拽 ——
      const [materials, setMaterials] = React.useState(null);
      const [materialLibrary, setMaterialLibrary] = React.useState(() => {
        try {
          const saved = JSON.parse(window.localStorage.getItem(MATERIAL_LIBRARY_KEY) || '{}');
          return { current: typeof saved.current === 'string' ? saved.current : '', recent: Array.isArray(saved.recent) ? saved.recent.filter((path) => typeof path === 'string' && path).slice(0, 8) : [] };
        } catch (err) { return { current: '', recent: [] }; }
      });
      // —— 画布整理：排序方式与颜色标记范围（发给 iframe 的 arrange-images 消息） ——
      const [canvasArrangeOpen, setCanvasArrangeOpen] = React.useState(false);
      // 画布背景模式：跟随 DSH 主题（默认）或跟随系统外观；ref 同步给定时器闭包。
      const [canvasBgFollowSystem, setCanvasBgFollowSystem] = React.useState(() => {
        try { return window.localStorage.getItem('dsh-canvas-bg-follow-system') === '1'; } catch (error) { return false; }
      });
      const bgFollowSystemRef = React.useRef(canvasBgFollowSystem);
      const [canvasArrangeOrder, setCanvasArrangeOrder] = React.useState('name');
      const [canvasArrangeTag, setCanvasArrangeTag] = React.useState('');
      const [materialQuery, setMaterialQuery] = React.useState('');
      const [materialSelection, setMaterialSelection] = React.useState([]);
      const [materialSelectMode, setMaterialSelectMode] = React.useState(false);
      const [materialPreview, setMaterialPreview] = React.useState(null);
      const [materialDropActive, setMaterialDropActive] = React.useState(false);
      const [materialControlsOpen, setMaterialControlsOpen] = React.useState(false);
      // —— 素材整理：排序方式（本地记忆）+ 颜色标记与按色筛选 ——
      const [materialSort, setMaterialSort] = React.useState(() => {
        try { return JSON.parse(window.localStorage.getItem(MATERIAL_SORT_KEY) || 'null') || 'time'; } catch (err) { return 'time'; }
      });
      const [materialTagFilter, setMaterialTagFilter] = React.useState('');
      const [materialTags, setMaterialTags] = React.useState({});
      const [materialTagMenu, setMaterialTagMenu] = React.useState(null);
      const canvasMaterialDrag = React.useRef([]);
      const rememberMaterialDirectory = (dir) => {
        const path = String(dir || '').trim();
        if (!path) return;
        setMaterialLibrary((prev) => {
          const next = { current: path, recent: [path].concat((prev.recent || []).filter((item) => item !== path)).slice(0, 8) };
          try { window.localStorage.setItem(MATERIAL_LIBRARY_KEY, JSON.stringify(next)); } catch (err) {}
          return next;
        });
      };
      const loadMaterialDirectory = async (dir, options) => {
        const current = projectRef.current;
        const params = new URLSearchParams();
        if (dir) params.set('dir', dir);
        else if (current.cwd) params.set('cwd', current.cwd);
        if (!params.toString()) throw new Error('请先选择素材库文件夹');
        const r = await fetch('/dsh-canvas/materials?' + params.toString());
        const data = await r.json();
        if (!r.ok || !data.ok) throw new Error(data.error || '读取失败');
        rememberMaterialDirectory(data.dir);
        setMaterialSelection([]);
        setMaterialPreview(null);
        setMaterials({ dir: data.dir, files: data.files || [], busy: false, error: '' });
        // 颜色标记按目录读取；读取失败不阻断列表，仅退化为无标记状态。
        try {
          const tr = await fetch('/dsh-canvas/materials/tags?dir=' + encodeURIComponent(data.dir));
          const td = await tr.json();
          setMaterialTags(tr.ok && td.ok && td.tags ? td.tags : {});
        } catch (err) { setMaterialTags({}); }
        if (!(options && options.silent)) setFeedback('✓ 已切换素材库：' + basename(data.dir));
        return data;
      };
      const openMaterials = async () => {
        const current = projectRef.current;
        if (!materialLibrary.current && !current.cwd) { setFeedback('⚠ 请先选择素材库文件夹'); return; }
        setMaterialQuery('');
        setMaterialSelection([]);
        setMaterialSelectMode(false);
        setMaterialPreview(null);
        setMaterialControlsOpen(false);
        setMaterialTagFilter('');
        setMaterialTagMenu(null);
        setMaterials({ dir: '', files: [], busy: true, error: '' });
        try {
          await loadMaterialDirectory(materialLibrary.current, { silent: true });
        } catch (err) { setMaterials({ dir: '', files: [], busy: false, error: String(err.message || err) }); }
      };
      const refreshMaterials = async (dirOverride) => {
        const current = projectRef.current;
        const dir = typeof dirOverride === 'string' ? dirOverride : (materials && materials.dir) || materialLibrary.current;
        if (!dir && !current.cwd) return;
        try {
          await loadMaterialDirectory(dir, { silent: true });
        } catch (err) {}
      };
      const chooseMaterialDirectory = async () => {
        try {
          const r = await fetch('/dsh-canvas/materials/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.error || '选择失败');
          setMaterials((prev) => prev ? { ...prev, busy: true, error: '' } : prev);
          await loadMaterialDirectory(data.dir);
        } catch (err) {
          if (!/取消选择文件夹/.test(String(err.message || err))) setFeedback('⚠ 选择素材库失败：' + String(err.message || err));
        }
      };
      const openMaterialsFolder = async () => {
        const current = projectRef.current;
        try {
          const r = await fetch('/dsh-canvas/materials/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: materials && materials.dir, cwd: current.cwd }) });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.error || '打开失败');
          setFeedback('✓ 已打开素材目录');
        } catch (err) { setFeedback('⚠ 无法打开素材目录：' + String(err.message || err)); }
      };
      const saveMaterialItems = async (items, sourceLabel) => {
        const current = projectRef.current;
        const dir = (materials && materials.dir) || materialLibrary.current;
        if (!dir && !current.cwd) throw new Error('请先选择素材库文件夹');
        const valid = (Array.isArray(items) ? items : []).filter((item) => item && item.dataURL);
        if (!valid.length) throw new Error('没有可保存的图片数据');
        let saved = 0;
        for (const item of valid) {
          const r = await fetch('/dsh-canvas/materials/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir, cwd: current.cwd, name: item.name, dataURL: item.dataURL }) });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.error || '保存失败');
          saved += 1;
        }
        setFeedback('✓ ' + (sourceLabel || '已存入当前素材库') + ' ' + saved + ' 项');
        if (materials) await refreshMaterials(dir);
        else await openMaterials();
        return saved;
      };
      const addSelectedToLibrary = async () => {
        const current = projectRef.current;
        if (!current.project) { setFeedback('⚠ 请先打开一个画布项目'); return; }
        setMaterials((prev) => prev ? { ...prev, busy: true, error: '' } : prev);
        try {
          const snapshot = await requestLiveSnapshot();
          const appState = snapshot && snapshot.appState ? snapshot.appState : {};
          const selectedIds = appState.selectedElementIds || {};
          const selected = (snapshot.elements || []).filter((x) => x && x.type === 'image' && !x.isDeleted && selectedIds[x.id]);
          if (!selected.length) throw new Error('请先在画布中选中图片');
          const items = [];
          for (const el of selected) {
            const file = (snapshot.files || {})[el.fileId];
            if (!file || !file.dataURL) continue;
            items.push({ name: (el.customData && el.customData.dshFileName) || ('素材-' + Date.now() + '-' + items.length + '.png'), dataURL: file.dataURL });
          }
          await saveMaterialItems(items, '已把画布选中图片存入当前素材库');
        } catch (err) { setMaterials((prev) => prev ? { ...prev, busy: false, error: String(err.message || err) } : prev); }
      };
      const sendMaterialToCanvas = (item) => {
        if (!item) return;
        const path = materials.dir + '/' + item.name;
        post({ type: 'add-image', explicit: true, url: '/dsh-canvas/image?path=' + encodeURIComponent(path), path, name: item.name });
        setFeedback('✓ 已发送到画布：' + item.name);
      };
      const selectedMaterials = materials ? materials.files.filter((item) => materialSelection.includes(item.name)) : [];
      // 应用标记颜色过滤与排序：默认按修改时间倒序（服务端顺序），
      // 可切换按类型（同类型内仍按时间）、像素数、文件大小、文件名整理。
      const materialPixels = (item) => (item.width && item.height ? item.width * item.height : 0);
      const materialExt = (item) => ((/\.[a-z0-9]+$/i.exec(item.name) || [''])[0] || '').toLowerCase();
      const filteredMaterials = materials ? materials.files
        .filter((item) => {
          const query = materialQuery.trim().toLocaleLowerCase();
          if (query && !item.name.toLocaleLowerCase().includes(query)) return false;
          if (materialTagFilter && (materialTags[item.name] || '') !== materialTagFilter) return false;
          return true;
        })
        .sort((materialSort === 'name'
          ? (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true })
          : materialSort === 'type'
            ? (a, b) => (materialExt(a) === materialExt(b) ? (b.mtime || 0) - (a.mtime || 0) : materialExt(a).localeCompare(materialExt(b)))
            : materialSort === 'pixels'
              ? (a, b) => (materialPixels(b) - materialPixels(a)) || ((b.mtime || 0) - (a.mtime || 0))
              : materialSort === 'bytes'
                ? (a, b) => ((b.size || 0) - (a.size || 0)) || ((b.mtime || 0) - (a.mtime || 0))
                : (a, b) => (b.mtime || 0) - (a.mtime || 0))
        ) : [];
      const applyMaterialTag = async (names, color) => {
        if (!materials || !materials.dir || !Array.isArray(names) || !names.length) return;
        try {
          const r = await fetch('/dsh-canvas/materials/tag', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: materials.dir, names, color })
          });
          const data = await r.json();
          if (!r.ok || !data.ok) throw new Error(data.error || '标记失败');
          setMaterialTags(data.tags || {});
          setFeedback('✓ 已' + (color ? '标记为 ' + ((MATERIAL_TAG_COLORS.find((c) => c.id === color) || {}).label || color) + '色 ' : '清除标记 ') + names.length + ' 项');
        } catch (err) { setFeedback('⚠ 更新颜色标记失败：' + String((err && err.message) || err)); }
      };
      const toggleMaterialSelection = (item) => {
        if (!item || !materialSelectMode) return;
        // “多选”本身就是显式模式：每次点击都追加或取消当前项，
        // 不再要求用户额外按住 Command/Ctrl/Shift。
        setMaterialSelection((prev) => prev.includes(item.name) ? prev.filter((name) => name !== item.name) : prev.concat(item.name));
      };
      const addSelectedMaterialsToCanvas = () => {
        if (!selectedMaterials.length) return;
        selectedMaterials.forEach(sendMaterialToCanvas);
        setFeedback('✓ 已加入画布 ' + selectedMaterials.length + ' 项');
      };
      const attachSelectedMaterialsToChat = async () => {
        if (!selectedMaterials.length) return;
        try {
          const images = [];
          for (const item of selectedMaterials) {
            const path = materials.dir + '/' + item.name;
            const response = await fetch('/dsh-canvas/image?path=' + encodeURIComponent(path));
            if (!response.ok) throw new Error(item.name + ' 读取失败');
            const blob = await response.blob();
            const dataURL = await new Promise((resolve, reject) => {
              const fr = new FileReader();
              fr.onload = () => resolve(fr.result);
              fr.onerror = () => reject(new Error(item.name + ' 读取失败'));
              fr.readAsDataURL(blob);
            });
            images.push({ dataURL, name: item.name });
          }
          window.dispatchEvent(new CustomEvent('dsh-canvas:attach-selection', { detail: { images } }));
          setFeedback('✓ 已附加到聊天输入框 ' + images.length + ' 项');
        } catch (err) { setFeedback('⚠ 发送到聊天失败：' + String(err.message || err)); }
      };
      const deleteSelectedMaterials = async () => {
        if (!selectedMaterials.length || !window.confirm('从素材库删除选中的 ' + selectedMaterials.length + ' 项？\n不会影响已经放入画布的图片。')) return;
        const current = projectRef.current;
        setMaterials((prev) => prev ? { ...prev, busy: true, error: '' } : prev);
        try {
          for (const item of selectedMaterials) {
            const r = await fetch('/dsh-canvas/materials/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: materials.dir, cwd: current.cwd, name: item.name }) });
            const data = await r.json();
            if (!data.ok) throw new Error(data.error || (item.name + ' 删除失败'));
          }
          setMaterialSelection([]);
          setFeedback('✓ 已从素材库删除 ' + selectedMaterials.length + ' 项');
          await refreshMaterials();
        } catch (err) { setMaterials((prev) => prev ? { ...prev, busy: false, error: String(err.message || err) } : prev); }
      };
      const materialTransferHas = (dataTransfer, type) => Array.from(dataTransfer && dataTransfer.types || []).includes(type);
      const readDroppedFile = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name || ('素材-' + Date.now() + '.png'), dataURL: reader.result });
        reader.onerror = () => reject(new Error((file.name || '图片') + ' 读取失败'));
        reader.readAsDataURL(file);
      });
      const onMaterialDragOver = (event) => {
        const transfer = event.dataTransfer;
        if (!materialTransferHas(transfer, 'application/x-dsh-canvas-image') && !materialTransferHas(transfer, 'Files')) return;
        event.preventDefault();
        event.stopPropagation();
        transfer.dropEffect = 'copy';
        setMaterialDropActive(true);
      };
      const onMaterialDrop = async (event) => {
        const transfer = event.dataTransfer;
        if (!materialTransferHas(transfer, 'application/x-dsh-canvas-image') && !materialTransferHas(transfer, 'Files')) return;
        event.preventDefault();
        event.stopPropagation();
        setMaterialDropActive(false);
        try {
          let items = canvasMaterialDrag.current.slice();
          const files = Array.from(transfer.files || []).filter((file) => /^image\//i.test(file.type || '') || /\.(?:png|jpe?g|webp|gif|avif|bmp|svg)$/i.test(file.name || ''));
          if (files.length) items = await Promise.all(files.map(readDroppedFile));
          // 高清 Base64 从 srcdoc iframe 传到父窗口可能比拖拽手势晚几十到数百毫秒。
          // 松手后短暂等待数据到达，避免快速拖放被误判为“没有可保存的图片”。
          if (!files.length && !items.length && materialTransferHas(transfer, 'application/x-dsh-canvas-image')) {
            for (let attempt = 0; attempt < 12 && !items.length; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 50));
              items = canvasMaterialDrag.current.slice();
            }
          }
          await saveMaterialItems(items, files.length ? '已导入本地图片到当前素材库' : '已把画布图片拖入当前素材库');
          canvasMaterialDrag.current = [];
        } catch (err) {
          setFeedback('⚠ 拖入素材库失败：' + String(err.message || err));
        }
      };
      const startMaterialDrag = (event, item) => {
        const path = materials.dir + '/' + item.name;
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData('application/x-dsh-material', JSON.stringify({ url: '/dsh-canvas/image?path=' + encodeURIComponent(path), path, name: item.name, size: item.size || 0 }));
        event.dataTransfer.setData('text/plain', item.name);
      };
      const frameRef = React.useRef(null);
      const frameReady = React.useRef(false);
      const stateLoaded = React.useRef(false);
      const pendingRef = React.useRef([]);
      const latestSnapshot = React.useRef(null);
      const saveTimer = React.useRef(null);
      const saveInFlight = React.useRef(null);
      const saveChain = React.useRef(Promise.resolve());
      const snapshotRequestSeq = React.useRef(0);
      const snapshotWaiters = React.useRef(new Map());
      const saveQueued = React.useRef(false);
      const projectSyncBusy = React.useRef(false);
      const missingSources = React.useRef(new Set());
      const knownDiskPaths = React.useRef(null);
      const queuedDiskPaths = React.useRef(new Set());
      const photoshopWatch = React.useRef(null);
      // 项目目录新文件的自动上画布基线：持久化到 localStorage（键含项目路径），
      // 重启不重拍——否则重启前刚生成/拷入的新文件会被当成历史、永远不再上画布。
      const autoAddBaseline = React.useRef(null);
      const materializingImages = React.useRef(new Set());
      const finderRemovingIds = React.useRef(new Set());
      const archivedImages = React.useRef(new Map());
      const restoringImages = React.useRef(new Set());
      const pendingArchiveTimers = React.useRef(new Map());
      // 重命名先更新画布快照、后更新磁盘文件；项目轮询期间不能把旧路径
      // 的短暂不存在误判成用户删除，尤其是 SVG/PDF/AI 这类源文件。
      const pendingRenames = React.useRef(new Map());
      const clearInProgress = React.useRef(false);
      const removeProgressTimer = React.useRef(null);

      React.useEffect(() => subscribeMode(setOn), []);
      // 首次挂载可能只能通过“工作目录最近项目”恢复；一旦当前会话 ID 已知，
      // 立即提升为精确绑定，后续切换到其它聊天再切回来仍能独立恢复。
      React.useEffect(() => {
        const current = projectRef.current;
        if (current.cwd && current.sessionId && current.project) {
          rememberProject(current.cwd, current.project, current.sessionId);
        }
      }, []);

      // 设计模式开：聊天内容让出右侧 width 像素（真实分栏，不遮挡）
      React.useEffect(() => {
        if (on) applyFramePadding(width);
        else applyFramePadding(0);
      }, [on, width]);
      // Host 端聊天 imagegen 代理据此决定是否接管请求，以及把生成原图
      // 归档到哪个画布项目。切换聊天、项目或设计模式后立即刷新上下文。
      React.useEffect(() => {
        if (!projectInfo.sessionId) return;
        fetch('/dsh-canvas/chat-context', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: projectInfo.sessionId, cwd: projectInfo.cwd || '', project: projectInfo.project || '', designMode: !!on })
        }).catch(() => {});
      }, [on, projectInfo.cwd, projectInfo.project, projectInfo.sessionId]);
      React.useEffect(() => {
        try { window.localStorage.setItem(PANEL_WIDTH_KEY, String(width)); } catch (err) {}
      }, [width]);
      React.useEffect(() => () => { applyFramePadding(0); }, []);
      React.useEffect(() => {
        const onViewportResize = () => setWidth((current) => clampPanelWidth(current));
        window.addEventListener('resize', onViewportResize);
        return () => window.removeEventListener('resize', onViewportResize);
      }, [clampPanelWidth]);

      // 所有 canvas.json 写入都串行化。特别是同一项目被两个聊天窗口
      // 先后打开时，不能让较早的旧快照在较新的快照之后完成写入。
      const queueStateSave = (snapshot, cwd, project) => {
        if (!snapshot || !project) return Promise.resolve();
        const task = saveChain.current.catch(() => {}).then(() => saveState(snapshot, cwd, project));
        saveChain.current = task.catch(() => {});
        return task;
      };
      const saveNow = () => {
        const current = projectRef.current;
        if (!latestSnapshot.current || !current.project) return;
        // 同一项目只允许一个完整 canvas.json 写入进行中；图片较多时，
        // 连续拖拽/缩放不会并发触发多次大文件序列化和磁盘写入。
        if (saveInFlight.current) {
          saveQueued.current = true;
          return;
        }
        const snapshot = latestSnapshot.current;
        const cwd = current.cwd;
        const project = current.project;
        let flight;
        flight = queueStateSave(snapshot, cwd, project).finally(() => {
          if (saveInFlight.current !== flight) return;
          saveInFlight.current = null;
          if (saveQueued.current) {
            saveQueued.current = false;
            scheduleSave();
          }
        });
        saveInFlight.current = flight;
        return flight;
      };
      const scheduleSave = () => {
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(saveNow, 1500);
      };
      // 切换项目/聊天前的同步保存：等待正在进行的写入完成，再把最新快照
      // 追加到同一串行队列。这样不会出现旧请求后完成、覆盖新请求的情况。
      const flushSave = () => {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const current = projectRef.current;
        if (!latestSnapshot.current || !current.project) return Promise.resolve();
        const liveSnapshot = requestLiveSnapshot();
        const waiting = saveInFlight.current || Promise.resolve();
        saveQueued.current = false;
        let flight;
        flight = Promise.resolve(liveSnapshot).then((snapshot) => {
          if (snapshot && typeof snapshot === 'object') {
            // iframe 返回的是纯实时快照，不带父层的版本元数据；保留父层
            // 当前版本，避免切换瞬间把版本信息抹掉并绕过并发冲突检查。
            const currentMeta = latestSnapshot.current && latestSnapshot.current.dshMeta;
            latestSnapshot.current = currentMeta && typeof currentMeta === 'object'
              ? { ...snapshot, dshMeta: currentMeta }
              : snapshot;
          }
          return waiting.catch(() => {});
        }).then(() => {
          const latest = latestSnapshot.current;
          const now = projectRef.current;
          if (!latest || now.project !== current.project || now.cwd !== current.cwd) return undefined;
          return queueStateSave(latest, current.cwd, current.project);
        }).finally(() => {
          if (saveInFlight.current !== flight) return;
          saveInFlight.current = null;
          if (saveQueued.current) {
            saveQueued.current = false;
            scheduleSave();
          }
        });
        saveInFlight.current = flight;
        return flight;
      };
      // DSH 切换会话时可能卸载整个 overlay；退出/重启时也尽量把最后快照落盘。
      // 离开时同样走实时快照屏障，不能只写父页面上一次 onChange 的缓存，
      // 否则刚删除的元素可能在切换聊天时重新出现。
      React.useEffect(() => {
        const persistOnLeave = () => { void flushSave(); };
        const persistOnHidden = () => { if (document.visibilityState === 'hidden') persistOnLeave(); };
        window.addEventListener('pagehide', persistOnLeave);
        window.addEventListener('beforeunload', persistOnLeave);
        document.addEventListener('visibilitychange', persistOnHidden);
        return () => {
          window.removeEventListener('pagehide', persistOnLeave);
          window.removeEventListener('beforeunload', persistOnLeave);
          document.removeEventListener('visibilitychange', persistOnHidden);
          persistOnLeave();
        };
      }, []);
      const post = (msg) => {
        const w = frameRef.current && frameRef.current.contentWindow;
        if (w) w.postMessage(msg, '*');
      };
      // —— DSH 主题同步到画布 ——
      // iframe 是独立文档，DSH 的 CSS 变量进不去；画布背景原跟 prefers-color-scheme，
      // DSH 切浅色而系统深色时整块画布仍是黑的。这里读取 DSH 令牌的实时值推给 iframe。
      const lastPushedTheme = React.useRef('');
      const realSystemDarkRef = React.useRef(null);
      // 令牌可能挂在 html/body 或更深的 DSH 容器上，逐层找；全找不到时退回
      // body 实际背景色。暗色判定优先主题标记，缺失时按颜色亮度推断。
      const isDarkColorValue = (value) => {
        const text = String(value || '').trim();
        let r; let g; let b;
        const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(text);
        const hex = /^#?([0-9a-f]{3,8})$/i.exec(text);
        if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
        else if (hex) {
          const digits = hex[1].length >= 6 ? hex[1].slice(0, 6) : hex[1].split('').map((c) => c + c).join('');
          r = parseInt(digits.slice(0, 2), 16); g = parseInt(digits.slice(2, 4), 16); b = parseInt(digits.slice(4, 6), 16);
        } else return false;
        return Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b) && (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
      };
      const dshThemeSnapshot = () => {
        try {
          let color = '';
          let fg = '';
          let surface = '';
          let line = '';
          let hover = '';
          const candidates = [document.documentElement, document.body, document.querySelector('#root')].filter(Boolean);
          for (const element of candidates) {
            const style = getComputedStyle(element);
            const read = (name) => String(style.getPropertyValue(name) || '').trim();
            if (!color) { const value = read('--dsw-alias-bg-base'); if (value && /^(#[0-9a-f]{3,8}|rgb|hsl)/i.test(value)) color = value; }
            if (!fg) { const value = read('--dsw-alias-label-primary'); if (value) fg = value; }
            if (!surface) { const value = read('--dsw-alias-bg-layer-3'); if (value && /^(#[0-9a-f]{3,8}|rgb|hsl)/i.test(value)) surface = value; }
            if (!line) { const value = read('--dsw-alias-border-l2'); if (value) line = value; }
            if (!hover) { const value = read('--dsw-alias-interactive-bg-hover'); if (value && /^(#[0-9a-f]{3,8}|rgb|hsl)/i.test(value)) hover = value; }
          }
          if (!color) {
            const bodyBg = String(getComputedStyle(document.body).backgroundColor || '').trim();
            if (/^rgba?\(/i.test(bodyBg) && !/rgba?\(0,\s*0,\s*0,\s*0\)/.test(bodyBg)) color = bodyBg;
          }
          if (!color) return '';
          const dark = document.documentElement.hasAttribute('data-ds-dark-theme')
            || document.body.hasAttribute('data-ds-dark-theme')
            || isDarkColorValue(color);
          return `${dark}\u0000${color}\u0000${fg}\u0000${surface}\u0000${line}\u0000${hover}`;
        } catch (error) { return ''; }
      };
      const pushDshTheme = () => {
        if (!frameReady.current) return;
        // 跟随系统模式：真实系统外观来自主机进程（Electron 会覆盖页面里的
        // prefers-color-scheme）；主机结果未到时先用页面媒体查询兜底。
        if (bgFollowSystemRef.current) {
          const mediaDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
          const dark = realSystemDarkRef.current !== null ? realSystemDarkRef.current : mediaDark;
          const snapshot = `sys\u0000${dark}`;
          if (snapshot === lastPushedTheme.current) return;
          lastPushedTheme.current = snapshot;
          post({
            type: 'set-theme-background',
            color: dark ? '#15171c' : '#f7f8fa',
            dark,
            fg: dark ? '#f8fafc' : '#1f2937',
            surface: dark ? '#1b2028' : '#ffffff',
            line: dark ? 'rgba(255,255,255,.14)' : 'rgba(15,23,42,.14)',
            hover: dark ? 'rgba(255,255,255,.1)' : 'rgba(15,23,42,.06)'
          });
          return;
        }
        const snapshot = dshThemeSnapshot();
        if (!snapshot || snapshot === lastPushedTheme.current) return;
        lastPushedTheme.current = snapshot;
        const [dark, color, fg, surface, line, hover] = snapshot.split('\u0000');
        post({ type: 'set-theme-background', color, dark: dark === 'true', fg: fg || '', surface: surface || '', line: line || '', hover: hover || '' });
      };
      React.useEffect(() => {
        const observer = new MutationObserver(pushDshTheme);
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] });
        const timer = window.setInterval(pushDshTheme, 4000);
        return () => { observer.disconnect(); window.clearInterval(timer); };
      }, []);
      // 系统外观切换与模式切换时立即重推；系统模式下另以 3 秒轮询主机进程
      // 获取真实系统外观（页面媒体查询会被 Electron 按应用主题覆盖）。
      React.useEffect(() => {
        pushDshTheme();
        if (!bgFollowSystemRef.current) return;
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => pushDshTheme();
        if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
        else if (typeof media.addListener === 'function') media.addListener(onChange);
        const timer = window.setInterval(() => {
          fetch('/dsh-canvas/system-appearance', { cache: 'no-store' })
            .then((response) => response.json())
            .then((data) => {
              if (data && data.ok && data.known && typeof data.dark === 'boolean' && realSystemDarkRef.current !== data.dark) {
                realSystemDarkRef.current = data.dark;
                pushDshTheme();
              }
            })
            .catch(() => {});
        }, 3000);
        return () => {
          if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onChange);
          else if (typeof media.removeListener === 'function') media.removeListener(onChange);
          window.clearInterval(timer);
        };
      }, [canvasBgFollowSystem]);
      // tldraw 的 onChange 经过短暂防抖，切换瞬间 latestSnapshot 可能还没收到
      // 最后一次删除/移动。切换前主动向 iframe 索取内存中的当前快照。
      // 大画布的 files 可能达到几十 MB；序列化并跨 iframe postMessage 需要
      // 留出时间，1.2 秒会把“正在删除后切换”误判成无响应并回退旧缓存。
      const requestLiveSnapshot = (timeoutMs = 5000) => {
        if (!frameReady.current || !frameRef.current) return Promise.resolve(null);
        const requestId = 'snapshot-' + (++snapshotRequestSeq.current);
        return new Promise((resolve) => {
          const timer = setTimeout(() => {
            snapshotWaiters.current.delete(requestId);
            resolve(null);
          }, Math.max(500, Number(timeoutMs) || 5000));
          snapshotWaiters.current.set(requestId, (value) => {
            clearTimeout(timer);
            resolve(value || null);
          });
          post({ type: 'snapshot-request', requestId });
        });
      };
      const flushPending = () => {
        if (!frameReady.current) return;
        // 切换/导入项目时，iframe 还在 resetScene + restore；此时加入的图片
        // 会被后续恢复动作覆盖。保留队列，等 iframe 发出 loaded 再统一加入。
        if (switchingProject.current) return;
        if (!projectRef.current.project) {
          pendingRef.current = [];
          setFeedback('请先新建或切换画布项目');
          return;
        }
        const queue = pendingRef.current.slice().sort((a, b) => String(a.name || basename(a.path || '')).localeCompare(String(b.name || basename(b.path || '')), 'zh-CN', { numeric: true, sensitivity: 'base' }));
        pendingRef.current = [];
        const total = queue.length;
        const columns = total > 1 ? Math.min(5, Math.ceil(Math.sqrt(total * 1.35))) : 1;
        queue.forEach((item, index) => post({ type: 'add-image', explicit: true, url: item.url, path: item.path || '', name: item.name || basename(item.path || ''), mtime: item.mtime || 0, kind: item.kind || 'image', managed: item.managed, batchIndex: total > 1 ? index : undefined, batchTotal: total, batchColumns: columns, atX: item.atX, atY: item.atY, customData: item.customData && typeof item.customData === 'object' ? item.customData : undefined }));
      };
      const loadProject = (next, requireExisting) => {
        next = { ...next, sessionId: next.sessionId || projectRef.current.sessionId || activeChatSessionId };
        const token = ++projectSwitchToken.current;
        clearTimeout(saveTimer.current);
        const previous = projectRef.current;
        const previousPath = previous.project || '';
        const nextPath = next.project || '';
        const sameProject = previousPath === nextPath;
        // 同一个项目被不同聊天打开时也必须先保存当前聊天的快照；
        // 仅比较路径会跳过保存，导致 B 聊天重新读到 A 删除前的旧内容。
        const sameBinding = sameProject && previous.cwd === next.cwd && previous.sessionId === next.sessionId;
        // 必须先完成保存再 GET 新快照；否则 GET 可能先读到磁盘旧内容，
        // 随后即使保存成功，界面仍会把旧 snap 恢复回去。
        const preserve = !sameBinding && latestSnapshot.current && previous.project
          ? flushSave()
          : Promise.resolve();
        return Promise.resolve(preserve).then(() => loadState(next.cwd, next.project)).then((snap) => {
          if (token !== projectSwitchToken.current) return;
          if (requireExisting && !snap) { setFeedback('⚠ 项目中没有可加载的 canvas.json，当前画布未改变'); return; }
          return Promise.resolve().finally(() => {
            if (token !== projectSwitchToken.current) return;
            for (const timer of pendingArchiveTimers.current.values()) clearTimeout(timer);
            pendingArchiveTimers.current.clear();
            archivedImages.current.clear();
            queuedDiskPaths.current.clear();
            knownDiskPaths.current = null;
            switchingProject.current = true;
            projectRef.current = next;
            rememberProject(next.cwd, next.project, next.sessionId);
            setProjectInfo(next);
            const targetSnapshot = snap || { elements: [], appState: { viewBackgroundColor: canvasDefaultBackground() }, files: {} };
            latestSnapshot.current = targetSnapshot;
            postSceneLoad(targetSnapshot);
            // 正常情况下由 iframe 的 loaded 信号尽快放行队列；若旧版/异常 iframe
            // 没有回传 loaded，也不能让导入文件永久滞留，超时后安全补刷一次。
            setTimeout(() => {
              if (token !== projectSwitchToken.current) return;
              switchingProject.current = false;
              flushPending();
            }, 5000);
            setFeedback(snap ? '✓ 已加载画布项目' : '新画布项目');
          });
        }).catch((err) => {
          setFeedback('⚠ 加载项目失败，当前画布未改变：' + String((err && err.message) || err));
        });
      };
      const openProjectList = () => {
        if (!projectInfo.cwd) { setFeedback('⚠ 当前聊天没有工作目录'); return; }
        setMoreMenuOpen(false);
        setProjectDialog({ mode: 'list' });
        setProjectList({ loading: true, items: [], error: '' });
        listProjects(projectInfo.cwd).then((result) => {
          setProjectList({ loading: false, items: Array.isArray(result.projects) ? result.projects : [], error: result.error || '' });
        }).catch((err) => setProjectList({ loading: false, items: [], error: String((err && err.message) || err) }));
      };
      openProjectListRefHolder.current = openProjectList;
      const browseDir = (path) => {
        setProjectDialog({ mode: 'browse', path, loading: true, entries: [], error: '' });
        fetch('/dsh-canvas/list-directories?path=' + encodeURIComponent(path)).then((r) => r.json()).then((result) => {
          const entries = ((result && result.entries) || []).filter((item) => item.type === 'directory' && !String(item.name || '').startsWith('.'));
          setProjectDialog({ mode: 'browse', path, loading: false, entries, error: result.error || '' });
        }).catch((err) => setProjectDialog({ mode: 'browse', path, loading: false, entries: [], error: String((err && err.message) || err) }));
      };
      const openProjectFolder = () => {
        const current = projectRef.current;
        setFeedback('正在系统文件管理器中打开项目目录…');
        fetch('/dsh-canvas/open-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '打开失败');
            setFeedback('✓ 已在系统文件管理器中打开项目目录');
          })
          .catch((err) => setFeedback('⚠ 无法打开项目目录：' + String((err && err.message) || err)));
      };
      const openImageSettings = () => {
        setMoreMenuOpen(false);
        setImageSettings({ loading: true, error: '' });
        fetch('/dsh-canvas/toolchain-status').then((r) => r.json()).then((d) => { if (d && d.ok) setToolchain(d.status); }).catch(() => {});
        fetch('/dsh-canvas/image-settings')
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '读取图像引擎设置失败');
            setImageSettings({ ...result.data, apiKey: '', loading: false, error: '', notice: '', test: null });
          })
          .catch((err) => setImageSettings({ loading: false, error: String((err && err.message) || err) }));
      };
      const saveImageSettings = () => {
        if (!imageSettings || imageSettings.loading || imageSettingsBusy) return;
        setImageSettingsBusy(true);
        fetch('/dsh-canvas/image-settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ engine: imageSettings.engine, apiBaseUrl: imageSettings.apiBaseUrl, apiModel: imageSettings.apiModel, apiKey: imageSettings.apiKey || '' })
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '保存图像引擎设置失败');
            setImageSettings({ ...result.data, apiKey: '', loading: false, error: '', notice: '', test: null });
            setFeedback('✓ 图像引擎设置已保存');
            setTimeout(() => setImageSettings(null), 500);
          })
          .catch((err) => setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err) } : prev))
          .finally(() => setImageSettingsBusy(false));
      };
      const refreshImageSettings = (notice) => {
        fetch('/dsh-canvas/image-settings')
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '刷新状态失败');
            setImageSettings((prev) => ({ ...result.data, apiKey: '', loading: false, error: '', notice: notice || (prev && prev.notice) || '', test: prev && prev.test || null }));
          })
          .catch((err) => setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err) } : prev));
      };
      const installDshCodex = () => {
        if (imageSettingsBusy) return;
        setImageSettingsBusy(true);
        setImageSettings((prev) => prev ? { ...prev, error: '', notice: '正在检查画布套件内的 dsh-codex 兼容版…' } : prev);
        fetch('/dsh-canvas/image-setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'install-dsh-codex' }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '安装失败');
            setImageSettings((prev) => prev ? { ...prev, health: result.data.health || prev.health, notice: result.data.message || '兼容版已就绪', error: '' } : prev);
          })
          .catch((err) => setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err), notice: '' } : prev))
          .finally(() => setImageSettingsBusy(false));
      };
      const startCodexLogin = () => {
        setImageSettingsBusy(true);
        setImageSettings((prev) => prev ? { ...prev, error: '', notice: '正在打开 ChatGPT 登录页…' } : prev);
        fetch('/plugins/dsh-openai-codex/auth/login', { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then((r) => r.json().catch(() => ({})).then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.url) throw new Error(result.data && result.data.error || 'dsh-codex 登录服务尚未加载，请重启 DSH 后重试');
            // 不先开空白窗再跳转(空白窗在 Electron 里会被弹窗拦截器拦)——直接开真实 URL;
            // 若仍被拦,退化为 <a> 标签模拟点击(用户手势上下文内不会被拦)。
            let popup = window.open(result.data.url, '_blank');
            if (!popup) {
              const link = document.createElement('a');
              link.href = result.data.url;
              link.target = '_blank';
              link.rel = 'noopener';
              document.body.appendChild(link);
              link.click();
              link.remove();
            }
            setImageSettings((prev) => prev ? { ...prev, notice: '请在新窗口完成 ChatGPT 授权；本页会自动刷新登录状态。', error: '' } : prev);
            let attempts = 0;
            const timer = window.setInterval(() => {
              attempts += 1;
              fetch('/dsh-canvas/image-settings').then((r) => r.json()).then((data) => {
                if (data && data.health && data.health.dshCodex && data.health.dshCodex.authenticated) {
                  window.clearInterval(timer);
                  setImageSettings({ ...data, apiKey: '', loading: false, error: '', notice: '✓ ChatGPT 登录完成，dsh-codex 图像能力已就绪。', test: null });
                } else if (attempts >= 120) {
                  window.clearInterval(timer);
                  setImageSettings((prev) => prev ? { ...prev, notice: '等待登录超时；完成授权后可点击“刷新状态”。' } : prev);
                }
              }).catch(() => {});
            }, 1500);
          })
          .catch((err) => { setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err), notice: '' } : prev); })
          .finally(() => setImageSettingsBusy(false));
      };
      const testApiSettings = () => {
        if (imageSettingsBusy || !imageSettings) return;
        setImageSettingsBusy(true);
        setImageSettings((prev) => prev ? { ...prev, error: '', notice: '正在保存凭据并检测连接…', test: null } : prev);
        fetch('/dsh-canvas/image-setup', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'test-api', apiBaseUrl: imageSettings.apiBaseUrl, apiModel: imageSettings.apiModel, apiKey: imageSettings.apiKey || '' })
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '连接检测失败');
            const test = result.data.test || {};
            const message = test.endpointSupported === false
              ? '✓ 地址可达且凭据未被拒绝；该网关未提供 models 检测端点，首次编辑时会继续校验模型。'
              : '✓ API 连接正常，密钥分组已提供 ' + test.model + '（HTTP ' + test.status + '，' + test.latencyMs + 'ms）';
            setImageSettings((prev) => prev ? { ...prev, health: result.data.health || prev.health, apiKey: '', notice: message, error: '', test } : prev);
          })
          .catch((err) => setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err), notice: '', test: null } : prev))
          .finally(() => setImageSettingsBusy(false));
      };
      const askDshToConfigure = (engine) => {
        const prompt = engine === 'api'
          ? '请帮我配置画布插件的图像 API。先向我确认 API 地址、模型名称和 API Key；不要在聊天中回显完整密钥。配置目标是“更多 → 图像引擎设置 → API”，完成后运行连接检测并说明结果。'
          : '请帮我检查并配置画布插件的 dsh-codex 图像引擎。请检查 dsh-codex 是否安装、ChatGPT OAuth 是否登录；未安装则指导或执行 `dsh plugin --profile web add dsh-codex`，需要重启时明确提醒，最后检查图像引擎健康状态。不要改动我现有的 DSH 模型配置。';
        try {
          if (!dshConfigurationHelper || dshConfigurationHelper(prompt) === false) throw new Error('当前聊天输入服务不可用');
          setImageSettings((prev) => prev ? { ...prev, notice: '✓ 配置请求已填入左侧聊天输入框，请检查后发送。', error: '' } : prev);
        } catch (err) {
          navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(prompt).then(() => {
            setImageSettings((prev) => prev ? { ...prev, notice: '配置请求已复制，请粘贴到 DSH 聊天框发送。', error: '' } : prev);
          }).catch(() => setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err) } : prev)) : setImageSettings((prev) => prev ? { ...prev, error: String((err && err.message) || err) } : prev);
        }
      };
      const importProject = () => {
        setProjectDialog(null);
        setFeedback('请选择要导入的项目文件夹…');
        fetch('/dsh-canvas/import-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '导入失败');
            const data = result.data;
            loadProject({ cwd: projectInfo.cwd, project: data.project }, false);
            setFeedback('✓ 项目已打开；请在聊天图片输出中点击“加入画布”添加图片');
          })
          .catch((err) => setFeedback('⚠ 导入项目失败：' + String((err && err.message) || err)));
      };
      const renameProject = (item, name) => {
        const clean = String(name || '').replace(/[\\/:*?"<>|]/g, '-').trim();
        if (!item || !item.path || !clean) return;
        setFeedback('正在重命名项目…');
        fetch('/dsh-canvas/rename-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: projectInfo.cwd, project: item.path, name: clean }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '重命名失败');
            if (projectRef.current.project === item.path) {
              const next = { ...projectRef.current, project: result.data.project };
              projectRef.current = next;
              setProjectInfo(next);
              rememberProject(next.cwd, next.project, next.sessionId);
            }
            setFeedback('✓ 项目已重命名为“' + result.data.name + '”');
            openProjectList();
          })
          .catch((err) => { setFeedback('⚠ 项目重命名失败：' + String((err && err.message) || err)); openProjectList(); });
      };
      const deleteProject = (item) => {
        if (!item || !item.path) return;
        const isCurrent = projectRef.current.project === item.path;
        const message = '删除项目“' + item.name + '”？\n\n项目文件夹不会永久删除，而会移动到同级的“已删除画布项目”文件夹。' + (isCurrent ? '\n当前画布会关闭并取消项目绑定。' : '');
        if (!window.confirm(message)) return;
        clearTimeout(saveTimer.current);
        const preserve = isCurrent && latestSnapshot.current ? flushSave() : Promise.resolve();
        setFeedback('正在移动项目到回收目录…');
        Promise.resolve(preserve).then(() => fetch('/dsh-canvas/delete-project', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: projectInfo.cwd, project: item.path }) }))
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '删除失败');
            if (isCurrent) {
              const next = { cwd: projectInfo.cwd, sessionId: projectInfo.sessionId, project: '' };
              projectRef.current = next;
              setProjectInfo(next);
              rememberProject(next.cwd, '', next.sessionId);
              latestSnapshot.current = { elements: [], appState: { viewBackgroundColor: canvasDefaultBackground() }, files: {} };
              postSceneLoad(latestSnapshot.current);
            }
            setFeedback('✓ 项目已移入“已删除画布项目”，需要时可从文件管理器恢复');
            openProjectList();
          })
          .catch((err) => { setFeedback('⚠ 删除项目失败：' + String((err && err.message) || err)); openProjectList(); });
      };
      const currentProjectPath = () => {
        const current = projectRef.current;
        return current.project || '';
      };
      const materializeElement = (element, file, duplicate) => {
        if (!element || !file || !file.dataURL || materializingImages.current.has(element.id)) return;
        materializingImages.current.add(element.id);
        const current = projectRef.current;
        const name = element.customData && element.customData.dshFileName || ('画布图片-' + String(element.id).slice(-6) + '.png');
        fetch('/dsh-canvas/materialize-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, name, dataURL: file.dataURL }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '项目图片写入失败');
            const image = result.data.image;
            if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
            post({ type: 'bind-managed', elementId: element.id, path: image.path, name: image.name, mtime: image.mtime, kind: image.kind, newFileId: duplicate ? ('f_copy_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7)) : '' });
            setFeedback('✓ 已同步到项目图片目录：' + image.name);
          })
          .catch((err) => setFeedback('⚠ 项目图片同步失败：' + String((err && err.message) || err)))
          .finally(() => materializingImages.current.delete(element.id));
      };
      const restoreArchivedElement = (element, record) => {
        if (!element || !record || restoringImages.current.has(element.id)) return;
        restoringImages.current.add(element.id);
        const current = projectRef.current;
        const custom = element.customData || {};
        fetch('/dsh-canvas/restore-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, ...record }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '恢复失败');
            archivedImages.current.delete(element.id);
            if (knownDiskPaths.current) knownDiskPaths.current.add(result.data.path);
            post({ type: 'refresh-source', elementId: element.id, path: result.data.path, name: custom.dshFileName || basename(result.data.path), mtime: result.data.mtime, url: result.data.url, kind: custom.dshSourceKind || 'image' });
            setFeedback('✓ 已从画布回收站恢复图片');
          })
          .catch((err) => setFeedback('⚠ 图片恢复失败：' + String((err && err.message) || err)))
          .finally(() => restoringImages.current.delete(element.id));
      };
      const archiveRemovedImages = (removed, nextLivePaths, skipRestore) => {
        const eligible = removed.filter((item) => {
          const path = item.customData && item.customData.dshSourcePath;
          // 图层编辑的临时提取图（dshScratch）不归档：它是过程中的中间产物，
          // 归档到画布回收站只会产生垃圾并弹出误导性的“已移入画布回收站”提示。
          if (item.customData && item.customData.dshScratch === true) return false;
          return path && !nextLivePaths.has(path) && !finderRemovingIds.current.has(item.id);
        });
        for (const item of removed) finderRemovingIds.current.delete(item.id);
        if (!eligible.length) return;
        const current = projectRef.current;
        const byPath = new Map(eligible.map((item) => [item.customData.dshSourcePath, item]));
        fetch('/dsh-canvas/archive-images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, paths: [...byPath.keys()] }) })
          .then((r) => r.json())
          .then((result) => {
            if (!result || !result.ok) return;
            for (const record of result.records || []) {
              const element = byPath.get(record.original);
              if (element && !skipRestore) {
                archivedImages.current.set(element.id, record);
                const currentLive = ((latestSnapshot.current && latestSnapshot.current.elements) || []).find((item) => item && item.id === element.id && item.type === 'image' && !item.isDeleted);
                if (currentLive) restoreArchivedElement(currentLive, record);
              }
              if (knownDiskPaths.current) knownDiskPaths.current.delete(record.original);
            }
            if ((result.records || []).length) setFeedback('✓ 已移入画布回收站，可随时恢复');
          })
          .catch((err) => setFeedback('⚠ 文件归档失败，磁盘原文件未删除：' + String((err && err.message) || err)));
      };
      const scheduleRemovedImages = (removed, nextLivePaths) => {
        for (const item of removed) {
          if (pendingArchiveTimers.current.has(item.id)) continue;
          const timer = setTimeout(() => {
            pendingArchiveTimers.current.delete(item.id);
            const currentSnapshot = latestSnapshot.current || {};
            const currentLive = (currentSnapshot.elements || []).filter((entry) => entry && entry.type === 'image' && !entry.isDeleted);
            if (currentLive.some((entry) => entry.id === item.id)) return;
            const currentPaths = new Set(currentLive.map((entry) => entry.customData && entry.customData.dshSourcePath).filter(Boolean));
            archiveRemovedImages([item], currentPaths, false);
          }, 1200);
          pendingArchiveTimers.current.set(item.id, timer);
        }
      };
      const backupAndClear = () => {
        const snapshot = latestSnapshot.current || {};
        const images = (snapshot.elements || []).filter((item) => item && item.type === 'image' && !item.isDeleted);
        const message = '将清空画布上的 ' + images.length + ' 张图片和其他元素。\n\n项目内图片不会永久删除，会移入“画布回收站”；当前 canvas.json 会先保存到“画布备份”。是否继续？';
        if (!window.confirm(message)) return;
        const current = projectRef.current;
        setFeedback('正在备份画布…');
        fetch('/dsh-canvas/backup-canvas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, snapshot }) })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '备份失败');
            const current = projectRef.current;
            const paths = [...new Set(images.map((item) => item.customData && item.customData.dshSourcePath).filter(Boolean))];
            clearInProgress.current = true;
            return fetch('/dsh-canvas/archive-images', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, paths }) });
          })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '图片归档失败');
            for (const timer of pendingArchiveTimers.current.values()) clearTimeout(timer);
            pendingArchiveTimers.current.clear();
            archivedImages.current.clear();
            post({ type: 'clear' });
            setFeedback('✓ 已备份；图片已移入画布回收站');
          })
          .catch((err) => { clearInProgress.current = false; setFeedback('⚠ 清空前保护失败，已取消清空：' + String((err && err.message) || err)); });
      };
      const exportTextRebuild = (blocks, openPhotoshop, selectedRegions, format) => {
        const current = projectRef.current;
        const active = textRebuild;
        if (!active || active.busy) return;
        const regions = Array.isArray(selectedRegions) ? selectedRegions : (Array.isArray(active.selections) ? active.selections : []);
        // 字体值在数据层归一：识别来源（OCR/模型/旧会话）可能仍带着 PingFang
        // 等不可商用默认值，下拉框只在显示层掩盖它；不归一会让 PSD 拿到与
        // 界面所见不一致的字体。
        const normalizedBlocks = (blocks || []).map((item) => {
          const font = textRebuildFontValue(item);
          return { ...item, fontPostScript: font, fontFamily: font };
        });
        setTextRebuild({ ...active, busy: true, error: '' });
        fetch('/dsh-canvas/export-text-psd', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...current, format: format || 'psd', openPhotoshop: format === 'psd' ? openPhotoshop : false, openIllustrator: (format === 'svg' || format === 'ai') ? openPhotoshop !== false : undefined, elementId: active.elementId, name: active.name, imageData: active.dataURL, width: Number(active.width || 0), height: Number(active.height || 0), selection: regions.length === 1 ? regions[0] : null, selections: regions, blocks: normalizedBlocks, erasePrompt: active.erasePrompt || '', cleanBackground: true, openPhotoshop: openPhotoshop !== false })
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || (format === 'psd' ? 'PSD 生成失败' : 'AI/SVG 生成失败'));
            const image = result.data.image;
            queuedDiskPaths.current.add(image.path);
            if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
            pendingRef.current.push({ ...image, explicit: true });
            flushPending();
            setTextRebuild(null);
            const cleanup = result.data.cleanedBackground ? ('；背景已由 ' + (result.data.cleanupEngine || 'image2') + ' 局部清理') : '；未完成背景清理，已保留原图';
            const suffix = format === 'svg' || format === 'ai'
              ? (result.data.ai
                  ? ('已生成原生 .ai（Illustrator 原生文字层，' + (result.data.texts || 0) + ' 个文字对象）')
                  : (result.data.illustrator ? ('已生成 SVG 并尝试用 Illustrator 打开（' + (result.data.texts || 0) + ' 个文字对象）') : ('已生成 SVG（' + (result.data.texts || 0) + ' 个文字对象，可在 Illustrator 中编辑文字）')))
              : (result.data.photoshop ? '已写入 Photoshop 文字层' : '已生成 PSD 草稿（文字层需在 Photoshop 中继续整理）');
            setFeedback('✓ ' + suffix + cleanup + '，文件已加入画布：' + image.name + (result.data.warning ? '；' + result.data.warning : ''));
          })
          .catch((err) => {
            const raw = String((err && err.message) || err);
            // 长任务（image2 清洁底 + Adobe 脚本）常超 2 分钟，客户端连接可能被中途
            // 切断（Failed to fetch）：服务端仍会完成并把成品落盘，文件扫描会自动
            // 上画布。这不是生成失败——关掉对话框并明确提示，避免重复点击产出多份。
            const interrupted = /Failed to fetch|LoadFailed|networkerror|aborted/i.test(raw);
            if (interrupted) {
              setTextRebuild(null);
              setFeedback('⏳ 连接等待被中断，但任务仍在后台执行：完成后成品会自动加入画布和项目文件夹，请勿重复点击以免生成多份');
            } else {
              setTextRebuild((prev) => prev ? { ...prev, busy: false, error: '⚠ ' + (format === 'psd' ? 'PSD' : 'AI/SVG') + ' 生成失败：' + raw } : prev);
            }
          });
      };
      const detectTextRebuild = (selectedRegions) => {
        const active = textRebuild;
        if (!active || active.busy || active.loading) return;
        const regions = (Array.isArray(selectedRegions) ? selectedRegions : (active.selections || [])).filter((item) => item && Number(item.width || 0) >= 6 && Number(item.height || 0) >= 6).slice(0, 24);
        if (!regions.length) {
          setTextRebuild((prev) => prev ? { ...prev, error: '请先框选需要识别和移除的文字区域' } : prev);
          return;
        }
        const current = projectRef.current;
        setTextRebuild((prev) => prev && prev.elementId === active.elementId
          ? { ...prev, loading: true, hasDetected: false, error: '', blocks: [], erasePrompt: '' }
          : prev);
        setFeedback('正在让当前聊天模型理解 ' + regions.length + ' 个文字选区…');
        const requestBody = { ...current, imageData: active.dataURL, name: active.name, crops: regions, ...(activeChatModelSelection || {}) };
        fetch('/dsh-canvas/ocr-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody)
        })
          .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
          .then((result) => {
            if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || 'OCR 识别失败');
            setTextRebuild((prev) => prev && prev.elementId === active.elementId
              ? { ...prev, loading: false, hasDetected: true, blocks: Array.isArray(result.data.blocks) ? result.data.blocks : [], erasePrompt: result.data.erasePrompt || '', engine: result.data.engine || 'tesseract', width: Number(result.data.width || prev.width || 0), height: Number(result.data.height || prev.height || 0) }
              : prev);
            const engineLabel = result.data.engine === 'current-chat-model' ? ('当前聊天模型 ' + (result.data.model || '')) : '本地 OCR 兜底';
            setFeedback('✓ ' + engineLabel + ' 已理解选区内 ' + Number((result.data.blocks || []).length) + ' 个文字对象，请确认后执行' + (result.data.warning ? '；' + result.data.warning : ''));
          })
          .catch((err) => setTextRebuild((prev) => prev && prev.elementId === active.elementId
            ? { ...prev, loading: false, error: '⚠ OCR 失败：' + String((err && err.message) || err) }
            : prev));
      };
      const updateTextRebuildSelections = (regions) => {
        const normalized = (Array.isArray(regions) ? regions : []).filter((item) => item && Number(item.width || 0) >= 6 && Number(item.height || 0) >= 6).slice(0, 24);
        setTextRebuild((prev) => prev ? { ...prev, selection: normalized.length === 1 ? normalized[0] : null, selections: normalized } : prev);
      };
      const onFrameMessage = (event) => {
        const frame = frameRef.current;
        if (!frame || event.source !== frame.contentWindow) return;
        const d = event.data || {};
        // 画布尚未就绪时创建占位被延后:移出待办,下一轮轮询(2s 后)自动重建,
        // 生成中的占位不会因为撞上画布冷启动窗口而丢失。
        if (d.type === 'chat-gen-placeholder-deferred' && d.id) {
          chatPendingRef.current = chatPendingRef.current.filter((id) => id !== d.id);
          return;
        }
        if (d.type === 'ready') {
          frameReady.current = true;
          setStatus('ready');
          pushDshTheme();
          if (!stateLoaded.current) {
            stateLoaded.current = true;
            const current = projectRef.current;
            if (current.project) {
              switchingProject.current = true;
              loadState(current.cwd, current.project).then((snap) => {
                if (snap) {
                  latestSnapshot.current = snap;
                  postSceneLoad(snap);
                } else {
                  switchingProject.current = false;
                  setFeedback('⚠ 已选择的项目没有 canvas.json');
                }
                setTimeout(() => { switchingProject.current = false; }, 5000);
              });
            } else {
              latestSnapshot.current = { elements: [], appState: { viewBackgroundColor: canvasDefaultBackground(), openMenu: null }, files: {} };
              setFeedback('请选择、新建或导入画布项目');
            }
          }
          flushPending();
        } else if (d.type === 'size') {
          if (d.w < 100 || d.h < 100) console.error('canvas too small — tldraw CSS likely missing');
        } else if (d.type === 'snapshot-response') {
          const key = String(d.requestId || '');
          const resolve = snapshotWaiters.current.get(key);
          if (resolve) {
            snapshotWaiters.current.delete(key);
            let snapshot = d.snapshot || null;
            if (typeof snapshot === 'string') {
              try { snapshot = JSON.parse(snapshot); } catch (err) { snapshot = null; }
            }
            resolve(snapshot);
          }
        } else if (d.type === 'loaded') {
          switchingProject.current = false;
          // 水合会用 canvas.json 保存的旧背景色覆盖此前的主题推送；
          // 清空快照让定时器在下一拍重新推送 DSH 主题。
          lastPushedTheme.current = '';
          pushDshTheme();
          if (d.snapshot) {
            // loaded 只是“已恢复”的确认，不是一次用户编辑；保留从
            // canvas.json 读出的版本标记，避免把旧加载快照重新盖回项目。
            const loadedMeta = latestSnapshot.current && latestSnapshot.current.dshMeta;
            latestSnapshot.current = loadedMeta && typeof loadedMeta === 'object'
              ? { ...d.snapshot, dshMeta: loadedMeta }
              : d.snapshot;
          }
          setFeedback(projectRef.current.project ? '✓ 画布内容已恢复' : '请选择、新建或导入画布项目');
          flushPending();
        } else if (d.type === 'diagnostic') {
          setFeedback(d.error || ('恢复检查：元素 ' + d.elements + '/' + d.expected + '，文件 ' + d.files + '，DOM ' + d.dom + '，canvas ' + d.canvas + '，按钮 ' + d.buttons));
        } else if (d.type === 'added') {
          setFeedback('✓ 已加入画布' + (d.name ? '：' + d.name : ''));
        } else if (d.type === 'rename-image') {
          const current = projectRef.current;
          pendingRenames.current.set(d.id, { oldPath: d.sourcePath || '', requestedName: d.newName || '' });
          fetch('/dsh-canvas/rename-image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...current, fileId: d.fileId, oldName: d.oldName, newName: d.newName, sourcePath: d.sourcePath || '' }) })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '重命名失败');
              const resultPath = result.data.sourcePath || result.data.path || d.sourcePath || '';
              // 先修补父页面缓存，再通知 iframe 更新 Excalidraw。这样
              // saveNow() 即使早于 iframe 的 changed 事件执行，也不会把旧源
              // 路径写回 canvas.json。
              if (latestSnapshot.current && Array.isArray(latestSnapshot.current.elements)) {
                latestSnapshot.current = {
                  ...latestSnapshot.current,
                  elements: latestSnapshot.current.elements.map((item) => item && item.id === d.id
                    ? { ...item, customData: { ...(item.customData || {}), dshFileName: result.data.name || d.newName, dshSourcePath: resultPath } }
                    : item)
                };
              }
              // 保留短暂保护窗口，覆盖“磁盘已改名、iframe 尚未收到
              // rename-result、项目轮询先返回”的最后一个竞态。
              pendingRenames.current.set(d.id, { oldPath: d.sourcePath || '', requestedName: d.newName || '', expiresAt: Date.now() + 5000 });
              setFeedback('✓ 图片已重命名：' + result.data.name);
              post({ type: 'rename-result', id: d.id, name: result.data.name, sourcePath: resultPath });
              saveNow();
            })
            .catch((err) => { pendingRenames.current.delete(d.id); setFeedback('⚠ 图片重命名失败：' + String((err && err.message) || err)); });
        } else if (d.type === 'source-refreshed') {
          setFeedback('✓ 已同步源文件更新：' + String(d.name || '图片'));
        } else if (d.type === 'aspect-ratio-repaired') {
          setFeedback('✓ 已自动修复 ' + Number(d.count || 0) + ' 张 PSD 的显示比例');
        } else if (d.type === 'arranged') {
          const orderLabels = { name: '文件名', type: '文件类型', time: '修改时间', pixels: '图片尺寸', bytes: '文件大小' };
          setFeedback(d.count ? ('✓ 已按' + (orderLabels[d.order] || '文件名') + '整理 ' + d.count + ' 张图片' + (d.groups > 1 ? '，分成 ' + d.groups + ' 个格式区块' : '') + (d.tag ? '（仅整理标记图片）' : '')) : '画布中没有符合条件的可整理图片');
        } else if (d.type === 'tag-images') {
          setFeedback('✓ 已' + (d.color ? '更新 ' : '清除 ') + Number(d.count || 0) + ' 张图片的颜色标记');
        } else if (d.type === 'duplicated') {
          setFeedback('✓ 已在画布中复制 ' + Number(d.count || 0) + ' 张图片');
        } else if (d.type === 'deleted-selection') {
          // 删除操作会先于 Excalidraw 的常规 onChange 通知到达；优先使用
          // 删除事件携带的即时快照，并立刻刷新到项目文件，避免切聊天时复活。
          let deletedSnapshot = d.snapshot || null;
          if (typeof deletedSnapshot === 'string') {
            try { deletedSnapshot = JSON.parse(deletedSnapshot); } catch (err) { deletedSnapshot = null; }
          }
          if (deletedSnapshot && typeof deletedSnapshot === 'object') latestSnapshot.current = markCanvasChanged(deletedSnapshot, latestSnapshot.current || {});
          void flushSave();
          setFeedback('✓ 已删除 ' + Number(d.count || 0) + ' 张图片，可用撤销恢复');
        } else if (d.type === 'request-photoshop-edit') {
          const current = projectRef.current;
          setFeedback('正在 Photoshop 中打开链接图片…');
          fetch('/dsh-canvas/open-in-photoshop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, elementId: d.elementId, fileId: d.fileId, name: d.name, sourcePath: d.sourcePath, sourceKind: d.sourceKind, dataURL: d.dataURL })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || 'Photoshop 打开失败');
              const image = result.data.image;
              queuedDiskPaths.current.add(image.path);
              if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
              post({ type: 'bind-managed', elementId: d.elementId, path: image.path, name: image.name, mtime: image.mtime, size: image.size, kind: image.kind, managed: image.managed });
              photoshopWatch.current = result.data.photoshopWatch || null;
              setFeedback('✓ 已在 Photoshop 打开' + (image.kind === 'psd' ? ' PSD 母版' : '链接图片') + '；保存后切回画布即自动检查更新');
            })
            .catch((err) => setFeedback('⚠ Photoshop 打开失败：' + String((err && err.message) || err)));
        } else if (d.type === 'request-illustrator-edit') {
          const current = projectRef.current;
          setFeedback('正在 Illustrator 中打开源文件…');
          fetch('/dsh-canvas/open-in-illustrator', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, elementId: d.elementId, name: d.name, sourcePath: d.sourcePath, sourceKind: d.sourceKind })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || 'Illustrator 打开失败');
              setFeedback('✓ 已在 Illustrator 中打开 ' + String(result.data.kind || d.sourceKind || '源文件') + '；保存后画布约 8 秒内更新');
            })
            .catch((err) => setFeedback('⚠ Illustrator 打开失败：' + String((err && err.message) || err)));
        } else if (d.type === 'request-bridge-return') {
          // 画布「→Ps / →Ai」：写入项目 ADOBE桥接/发件箱，由 PS/AI 的 DSH画布桥接 面板置入（adobe-bridge/PROTOCOL.md §4）。
          void requestAdobeBridgeReturn(projectRef.current, d, setFeedback);
        } else if (d.type === 'material-drag-start') {
          canvasMaterialDrag.current = Array.isArray(d.items) ? d.items.filter((item) => item && item.dataURL) : [];
          setMaterialDropActive(false);
        } else if (d.type === 'material-drag-end') {
          setTimeout(() => { canvasMaterialDrag.current = []; setMaterialDropActive(false); }, 1200);
        } else if (d.type === 'save-to-materials') {
          saveMaterialItems(d.items || [], d.source === 'context-menu' ? '右键所选图片已加入当前素材库' : '画布所选图片已加入当前素材库')
            .catch((err) => setFeedback('⚠ 加入当前素材库失败：' + String(err.message || err)));
        } else if (d.type === 'request-text-rebuild') {
          const base = { elementId: d.elementId, name: d.name || '当前图片', dataURL: d.imageData || '', loading: false, busy: false, hasDetected: false, blocks: [], erasePrompt: '', selection: null, selections: [], width: 0, height: 0, error: '' };
          setTextRebuild(base);
          setFeedback('请先框选需要移除并重建的文字区域，再点击“识别选区”');
        } else if (d.type === 'request-text-rebuild-export') {
          const current = projectRef.current;
          const active = textRebuild;
          if (!active || active.busy) return;
          setTextRebuild({ ...active, busy: true, error: '' });
          fetch('/dsh-canvas/export-text-psd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, elementId: active.elementId, name: active.name, imageData: active.dataURL, width: Number(active.width || 0), height: Number(active.height || 0), selection: active.selection || null, selections: Array.isArray(active.selections) ? active.selections : [], blocks: d.blocks || [], erasePrompt: active.erasePrompt || '', cleanBackground: true, openPhotoshop: d.openPhotoshop !== false })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || 'PSD 生成失败');
              const image = result.data.image;
              queuedDiskPaths.current.add(image.path);
              if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
              pendingRef.current.push({ ...image, explicit: true });
              flushPending();
              setTextRebuild(null);
              const cleanup = result.data.cleanedBackground ? ('；背景已由 ' + (result.data.cleanupEngine || 'image2') + ' 局部清理') : '；未完成背景清理，已保留原图';
              const suffix = result.data.photoshop ? '已写入 Photoshop 文字层' : '已生成 PSD 草稿（文字层需在 Photoshop 中继续整理）';
              setFeedback('✓ ' + suffix + cleanup + '，文件已加入画布：' + image.name + (result.data.warning ? '；' + result.data.warning : ''));
            })
            .catch((err) => {
              const raw = String((err && err.message) || err);
              // 同上：连接中断 ≠ 生成失败，服务端会完成并自动上画布。
              const interrupted = /Failed to fetch|LoadFailed|networkerror|aborted/i.test(raw);
              if (interrupted) {
                setTextRebuild(null);
                setFeedback('⏳ 连接等待被中断，但任务仍在后台执行：完成后成品会自动加入画布和项目文件夹，请勿重复点击以免生成多份');
              } else {
                setTextRebuild((prev) => prev ? { ...prev, busy: false, error: '⚠ PSD 生成失败：' + raw } : prev);
              }
            });
        } else if (d.type === 'request-remove-background') {
          const current = projectRef.current;
          if (removeProgressTimer.current) {
            setFeedback('已有去背景任务正在进行，请稍候…');
            return;
          }
          const jobId = 'bg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
          const progressUrl = '/dsh-canvas/remove-background-progress?cwd=' + encodeURIComponent(current.cwd || '') + '&project=' + encodeURIComponent(current.project || '') + '&jobId=' + encodeURIComponent(jobId);
          const updateProgress = (progress) => {
            if (!progress) return;
            setRemoveProgress(progress);
            post({ type: 'placeholder-progress', placeholderId: d.placeholderId, percent: progress.percent, stage: progress.stage, message: progress.message });
            const value = Number(progress.percent);
            const suffix = Number.isFinite(value) ? ' ' + Math.round(Math.max(0, Math.min(100, value))) + '%' : '';
            if (progress.stage !== 'complete' && progress.stage !== 'error') setFeedback(String(progress.message || '本地去背景处理中…') + suffix);
          };
          setRemoveProgress({ ok: true, jobId, stage: 'starting', message: '正在启动本地 rembg…', percent: 1 });
          setFeedback('正在准备本地 rembg… 1%');
          removeProgressTimer.current = window.setInterval(() => {
            fetch(progressUrl, { cache: 'no-store' })
              .then((r) => r.json())
              .then(updateProgress)
              .catch(() => {});
          }, 700);
          fetch('/dsh-canvas/remove-background', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, jobId, elementId: d.elementId, fileId: d.fileId, name: d.name, imageData: d.imageData, imagePath: d.imagePath })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '本地去背景失败');
              clearInterval(removeProgressTimer.current);
              removeProgressTimer.current = null;
              setRemoveProgress({ ok: true, jobId, stage: 'complete', message: '去背景完成', percent: 100 });
              if (result.data.image && result.data.image.path) {
                queuedDiskPaths.current.add(result.data.image.path);
                if (knownDiskPaths.current) knownDiskPaths.current.add(result.data.image.path);
              }
              post({ type: 'image-remove-bg-result', requestId: d.requestId, placeholderId: d.placeholderId, elementId: d.elementId, ...result.data });
              setFeedback('✓ 去背景完成（rembg ' + (result.data.model || 'birefnet-general-lite') + '），已生成透明 PNG');
              window.setTimeout(() => setRemoveProgress(null), 1600);
            })
            .catch((err) => {
              clearInterval(removeProgressTimer.current);
              removeProgressTimer.current = null;
              const message = String((err && err.message) || err);
              setRemoveProgress({ ok: false, jobId, stage: 'error', message, percent: null });
              post({ type: 'image-remove-bg-error', requestId: d.requestId, placeholderId: d.placeholderId, elementId: d.elementId, message });
              setFeedback('⚠ 去背景失败：' + message);
              window.setTimeout(() => setRemoveProgress(null), 5000);
            });
        } else if (d.type === 'request-vectorize') {
          const current = projectRef.current;
          setFeedback('正在分析图片复杂度并选择本地矢量化程序…');
          fetch('/dsh-canvas/vectorize-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, elementId: d.elementId, fileId: d.fileId, name: d.name, imageData: d.imageData, imagePath: d.imagePath, backend: d.backend || 'auto', vectorMode: d.vectorMode || 'flat' })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || '本地矢量化失败');
              const image = result.data.image;
              queuedDiskPaths.current.add(image.path);
              if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
              post({ type: 'image-vectorized-result', requestId: d.requestId, elementId: d.elementId, ...result.data });
              const complexity = result.data.complexity && result.data.complexity.class ? '（' + result.data.complexity.class + '）' : '';
              const modeLabel = result.data.vectorMode === 'flat' ? '结构化模式' : (result.data.vectorMode === 'silhouette' ? '轮廓模式' : '全量模式');
              const quality = result.data.quality || {};
              const qualityLabel = quality.pathCount ? '（' + quality.pathCount + ' 条路径）' : '';
              const qualityWarning = Array.isArray(quality.warnings) && quality.warnings.length ? '；' + quality.warnings[0] : '';
              setFeedback('✓ 已用 ' + modeLabel + ' + ' + String(result.data.backend || '本地程序') + ' 生成 SVG' + complexity + qualityLabel + '，已加入画布' + qualityWarning);
            })
            .catch((err) => setFeedback('⚠ 转矢量失败：' + String((err && err.message) || err)));
        } else if (d.type === 'import-external-file') {
          // 外部拖入是用户明确操作，允许导入；普通 agent 工具结果不会发送此消息。
          if (d.explicit !== true) {
            setFeedback('已忽略非用户发起的文件导入');
            return;
          }
          const current = projectRef.current;
          if (!current.project) {
            setFeedback('请先新建或切换画布项目，再导入 SVG/PDF/AI');
            return;
          }
          setFeedback('正在导入 ' + String(d.name || '文件') + ' 并生成预览…');
          fetch('/dsh-canvas/import-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...current, sourcePath: d.sourcePath || '', name: d.name || '', kind: d.kind || '', dataURL: d.dataURL || '' })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || '文件导入失败');
              const image = result.data.image;
              queuedDiskPaths.current.add(image.path);
              if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
              pendingRef.current.push({ ...image, explicit: true });
              flushPending();
              setFeedback('✓ 已导入 ' + image.name + '，画布会随文件修改自动刷新');
            })
            .catch((err) => setFeedback('⚠ 导入文件失败：' + String((err && err.message) || err)));
        } else if (d.type === 'request-image-edit') {
          const current = projectRef.current;
          // 引擎路由由画布图像引擎设置决定（dsh-codex 或 api），这里只如实显示当前选中的引擎。
          fetch('/dsh-canvas/image-settings').then((r) => r.json()).then((s) => (s && s.engine) || '').catch(() => '').then((engineName) => {
            const via = engineName === 'api' ? 'image2 API' : engineName === 'dsh-codex' ? 'Codex' : '图像引擎';
            setFeedback((d.mode === 'erase' ? '智能擦除' : '图片编辑') + '处理中：使用 ' + via + '（不占用聊天上下文）…');
          });
          fetch('/dsh-canvas/edit-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(20 * 60 * 1000),
            body: JSON.stringify({ ...current, elementId: d.elementId, fileId: d.fileId, name: d.name, imageData: d.imageData, imagePath: d.imagePath, editRootPath: d.editRootPath, editHistory: d.editHistory, editDepth: d.editDepth, mode: d.mode, prompt: d.prompt, maskData: d.maskData, width: d.width, height: d.height })
          })
            .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
            .then((result) => {
              if (!result.ok || !result.data || !result.data.ok) throw new Error(result.data && result.data.error || '图片编辑失败');
              if (result.data.image && result.data.image.path) {
                queuedDiskPaths.current.add(result.data.image.path);
                if (knownDiskPaths.current) knownDiskPaths.current.add(result.data.image.path);
              }
              post({ type: 'image-edit-result', requestId: d.requestId, placeholderId: d.placeholderId, elementId: d.elementId, ...result.data });
              const engineLabel = result.data.engine === 'api' ? 'image2 API' : result.data.engine === 'dsh-codex' ? 'Codex' : String(result.data.engine || '');
              setFeedback('✓ ' + (d.mode === 'erase' ? '智能擦除' : '图片编辑') + '完成（' + engineLabel + '），已生成新图');
            })
            .catch((err) => {
              const message = String((err && err.message) || err);
              post({ type: 'image-edit-error', requestId: d.requestId, placeholderId: d.placeholderId, elementId: d.elementId, message, retryItem: { mode: d.mode, id: d.elementId, fileId: d.fileId, name: d.name, dataURL: d.imageData, width: d.width, height: d.height, sourcePath: d.imagePath, editRootPath: d.editRootPath, editHistory: d.editHistory, editDepth: d.editDepth, prompt: d.prompt, maskData: d.maskData, retryToken: Date.now() } });
              setFeedback('⚠ 图片编辑失败：' + message);
            });
        } else if (d.type === 'image-edit-added') {
          setFeedback('✓ 新图片已加入画布：' + String(d.name || '编辑结果'));
        } else if (d.type === 'request-send-selection-item') {
          if (d.image && d.image.dataURL) {
            window.dispatchEvent(new CustomEvent('dsh-canvas:attach-selection', {
              detail: { images: [d.image], batchId: d.batchId || '', index: Number(d.index || 1), total: Number(d.total || 1) }
            }));
            setFeedback('✓ 正在发送图片到聊天输入框：' + Number(d.index || 1) + '/' + Number(d.total || 1));
          } else {
            setFeedback('⚠ 第 ' + Number(d.index || 1) + ' 张所选图片无法读取');
          }
        } else if (d.type === 'request-send-selection') {
          // 优先使用 iframe 从当前 Excalidraw 实例直接读取的数据。旧逻辑仅凭
          // element id 查询节流后的 latestSnapshot，刚导入、刚刷新 PSD 或切换
          // 项目时快照可能尚未带上 files，导致“发送至聊天”无响应。
          let images = Array.isArray(d.images) ? d.images.filter((item) => item && item.dataURL) : [];
          if (!images.length) {
            const ids = new Set(Array.isArray(d.ids) ? d.ids : []);
            const snap = latestSnapshot.current || {};
            const imageEls = (snap.elements || []).filter((item) => item && item.type === 'image' && !item.isDeleted && ids.has(item.id));
            images = imageEls.map((item, index) => {
              const selectedFile = snap.files && snap.files[item.fileId];
              const fileName = item.customData && item.customData.dshFileName;
              return selectedFile && selectedFile.dataURL ? { dataURL: selectedFile.dataURL, name: fileName || ('canvas-selection-' + (index + 1) + '-' + String(item.id).slice(-6)) } : null;
            }).filter(Boolean);
          }
          if (images.length) {
            window.dispatchEvent(new CustomEvent('dsh-canvas:attach-selection', { detail: { images } }));
            setFeedback('✓ 已发送 ' + images.length + ' 张到聊天输入框');
          } else {
            setFeedback('⚠ 所选图片暂时无法读取，请稍后重试');
          }
        } else if (d.type === 'chat-gen-resolve-failed' && d.path) {
          // 占位替换失败(占位被删/画布重载等):立即把成图按兜底路径放上画布
          // (视口锚点 + 240 盒装,与其它生成图同规格),不再等文件扫描慢半拍地救回。
          dispatchGeneratedToCanvas(String(d.path));
          setFeedback('⚠ ' + (d.message || '占位替换失败') + '，成图已放到画布当前视野');
        } else if (d.type === 'chat-gen-soft-error') {
          // 聊天生图占位/上画布的可恢复失败:只提示,不打成全局「加载失败」
          setFeedback('⚠ ' + (d.message || '聊天生图未能上画布'));
        } else if (d.type === 'error') {
          setStatus('error');
          setFeedback('⚠ ' + (d.message || 'iframe 错误'));
          console.error('canvas iframe error:', d.message);
        } else if (d.type === 'changed') {
          if (switchingProject.current) return;
          if (!d.token || d.token !== canvasLoadToken.current) { console.warn('[canvas] 丢弃跨场景迟到 changed，token 不匹配'); return; }
          const previous = latestSnapshot.current || {};
          // files 增量合并：iframe 的 changed 快照只带 usedFileIds 与新增/变化
          // 文件，与父层已有 files 按“在用集合”合并成完整文件表；旧版全量
          // 快照（无 usedFileIds 字段）保持原行为兼容。删除图片时 usedFileIds
          // 不再包含其 fileId，合并结果自动收缩，与旧全量语义一致。
          const incomingSnapshot = d.snapshot || {};
          if (!Array.isArray(incomingSnapshot.usedFileIds)) {
            // 旧版全量快照兼容 + 防清空守卫：任何"存活图片元素"的 fileId 若在
            // incoming.files 中缺失（如还原失败/部分场景），一律从 previous.files
            // 补齐——文件表只允许因元素被删除而收缩，不允许因数据缺失而收缩。
            const prevFiles = previous.files || {};
            const incFiles = incomingSnapshot.files || {};
            let filled = false;
            (incomingSnapshot.elements || []).forEach((item) => {
              if (!item || item.type !== 'image' || item.isDeleted || !item.fileId) return;
              if (!incFiles[item.fileId] && prevFiles[item.fileId]) { incFiles[item.fileId] = prevFiles[item.fileId]; filled = true; }
            });
            if (filled) incomingSnapshot.files = incFiles;
          }
          if (Array.isArray(incomingSnapshot.usedFileIds)) {
            const mergedFiles = {};
            const previousFiles = previous.files || {};
            for (const usedId of incomingSnapshot.usedFileIds) {
              if (previousFiles[usedId]) mergedFiles[usedId] = previousFiles[usedId];
            }
            Object.assign(mergedFiles, incomingSnapshot.files || {});
            incomingSnapshot.files = mergedFiles;
          }
          const snap = markCanvasChanged(incomingSnapshot, previous);
          const previousLive = (previous.elements || []).filter((item) => item && item.type === 'image' && !item.isDeleted);
          const liveImages = (snap.elements || []).filter((item) => item && item.type === 'image' && !item.isDeleted);
          const liveIds = new Set(liveImages.map((item) => item.id));
          const nextLivePaths = new Set(liveImages.map((item) => item.customData && item.customData.dshSourcePath).filter(Boolean));
          const removed = previousLive.filter((item) => !liveIds.has(item.id));
          if (removed.length && !clearInProgress.current) scheduleRemovedImages(removed, nextLivePaths);

          const projectPath = currentProjectPath();
          const assetsRoot = projectPath ? projectPath.replace(/[\\/]+$/, '') + '/assets' : '';
          const seenPaths = new Set();
          const seenFiles = new Set();
          for (const item of liveImages) {
            const pendingTimer = pendingArchiveTimers.current.get(item.id);
            if (pendingTimer) { clearTimeout(pendingTimer); pendingArchiveTimers.current.delete(item.id); }
            const custom = item.customData || {};
            const path = custom.dshSourcePath || '';
            const sourceKind = String(custom.dshSourceKind || '').toLowerCase();
            const sourceExtMatch = String(path).toLowerCase().match(/\.([a-z0-9]+)$/);
            const sourceExt = sourceExtMatch ? sourceExtMatch[1] : '';
            const isDocumentSource = ['svg', 'pdf', 'ai'].indexOf(sourceKind) >= 0 || ['svg', 'pdf', 'ai'].indexOf(sourceExt) >= 0;
            const fileDataURL = snap.files && snap.files[item.fileId] && snap.files[item.fileId].dataURL || '';
            const fileMimeMatch = String(fileDataURL).match(/^data:([^;]+)/i);
            const fileMime = fileMimeMatch ? String(fileMimeMatch[1]).toLowerCase() : '';
            const isRasterFile = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'].indexOf(fileMime) >= 0;
            const duplicate = (path && seenPaths.has(path)) || (item.fileId && seenFiles.has(item.fileId));
            const needsManagedFile = custom.dshManaged === true && (!path || !canvasPathWithin(assetsRoot, path));
            const archived = archivedImages.current.get(item.id);
            if (archived) {
              restoreArchivedElement(item, archived);
            } else if (!isDocumentSource && isRasterFile && (duplicate || needsManagedFile)) {
              // SVG/PDF/AI 的 file.dataURL 是预览或矢量内容，不是栅格图片；
              // 不能再送进 materialize-image 的栅格解码器，否则会报“图片数据无效”。
              // 这些源文件已经由导入/矢量化流程落在项目 assets 中，直接保留源路径。
              materializeElement(item, snap.files && snap.files[item.fileId], duplicate);
            }
            if (path) seenPaths.add(path);
            if (item.fileId) seenFiles.add(item.fileId);
          }
          latestSnapshot.current = snap;
          if (clearInProgress.current && !liveImages.length) clearInProgress.current = false;
          // 删除必须立即进入写入队列；仅靠 1.5 秒防抖会给切换聊天/卸载
          // 留出窗口，导致另一个聊天读到删除前的旧快照。
          if (removed.length) saveNow();
          else scheduleSave();
        } else if (d.type === 'exported') {
          if (d.dataUrl) {
            const a = document.createElement('a');
            a.href = d.dataUrl;
            a.download = 'canvas.png';
            document.body.appendChild(a);
            a.click();
            a.remove();
          } else if (d.error && d.error !== 'empty') {
            console.error('canvas export failed:', d.error);
          }
        }
      };

      React.useEffect(() => {
        const onAdd = (e) => {
          const detail = e.detail || {};
          if (!detail.url || detail.explicit !== true || detail.token !== CANVAS_ADD_TOKEN) return;
          setMode(true);
          if (!projectRef.current.project) {
            setFeedback('请先新建或切换画布项目，再加入图片');
            return;
          }
          pendingRef.current.push(detail);
          flushPending();
        };
        window.addEventListener('dsh-canvas:add-image', onAdd);
        const openProjectListRef = { current: null };
        const onProjectPick = () => { if (openProjectListRefHolder.current) openProjectListRefHolder.current(); };
        const onProjectNew = () => { setMoreMenuOpen(false); setProjectDialog({ mode: 'new', value: '新画布项目' }); };
        const onProjectDismiss = () => {
          const current = projectRef.current || {};
          chatProjectAskedRef.current = { sessionId: current.sessionId || '', dismissed: true };
          window.__dshCanvasGenAskState = '';
          window.dispatchEvent(new CustomEvent('dsh-canvas:gen-state', { detail: { show: false } }));
        };
        window.addEventListener('dsh-canvas:project-pick', onProjectPick);
        window.addEventListener('dsh-canvas:project-new', onProjectNew);
        window.addEventListener('dsh-canvas:project-dismiss', onProjectDismiss);
        const onProjectContext = (event) => {
          // 会话切换会重新挂载聊天输入区，即使 cwd 未变也必须重新测量分栏。
          notifySplitLayout();
          const cwd = event.detail && typeof event.detail.cwd === 'string' ? event.detail.cwd : '';
          const sessionId = event.detail && event.detail.sessionId ? String(event.detail.sessionId) : '';
          if (!cwd) return;
          const current = projectRef.current;
          if (current.cwd === cwd && current.sessionId === sessionId) return;
          const project = chosenProject(cwd, sessionId, !current.cwd && !current.sessionId);
          if (project) {
            loadProject({ cwd, sessionId, project }, true);
            return;
          }
          clearTimeout(saveTimer.current);
          const preserve = latestSnapshot.current && current.project ? flushSave() : Promise.resolve();
          // 即使目标聊天没有绑定项目，也必须等当前项目写入完成后再清空界面。
          // 否则用户马上切回原聊天时，loadState 可能先读到删除前的旧快照。
          Promise.resolve(preserve).then(() => {
            // 保存期间可能又切回了原聊天；过期的清空动作不能覆盖当前画布。
            if (activeChatCwd !== cwd || activeChatSessionId !== sessionId) return;
            const emptySnapshot = { elements: [], appState: { viewBackgroundColor: canvasDefaultBackground(), openMenu: null }, files: {} };
            projectRef.current = { cwd, sessionId, project: '' };
            setProjectInfo({ cwd, sessionId, project: '' });
            latestSnapshot.current = emptySnapshot;
            switchingProject.current = true;
            postSceneLoad(emptySnapshot);
            setTimeout(() => { switchingProject.current = false; }, 1000);
            setFeedback('已切换聊天；请选择、新建或导入画布项目');
          });
        };
        window.addEventListener('dsh-canvas:project-context', onProjectContext);
        window.addEventListener('message', onFrameMessage);
        // 不依赖两个独立 React 插槽的 effect 执行先后；画布晚挂载时主动补领当前会话上下文。
        if (activeChatCwd) onProjectContext({ detail: { cwd: activeChatCwd, sessionId: activeChatSessionId } });
        return () => {
          window.removeEventListener('dsh-canvas:add-image', onAdd);
          window.removeEventListener('dsh-canvas:project-pick', onProjectPick);
          window.removeEventListener('dsh-canvas:project-new', onProjectNew);
          window.removeEventListener('dsh-canvas:project-dismiss', onProjectDismiss);
          window.removeEventListener('dsh-canvas:project-context', onProjectContext);
          window.removeEventListener('message', onFrameMessage);
          clearTimeout(saveTimer.current);
          clearInterval(removeProgressTimer.current);
          removeProgressTimer.current = null;
          saveQueued.current = false;
          for (const timer of pendingArchiveTimers.current.values()) clearTimeout(timer);
          pendingArchiveTimers.current.clear();
        };
      }, []);

      React.useEffect(() => {
        if (!on) return undefined;
        let disposed = false;
        let pollTimer = 0;
        let activeController = null;
        knownDiskPaths.current = null;
        queuedDiskPaths.current.clear();
        const scheduleNext = () => {
          clearTimeout(pollTimer);
          pollTimer = 0;
          if (disposed || document.visibilityState !== 'visible' || !currentProjectPath()) return;
          pollTimer = setTimeout(() => {
            pollTimer = 0;
            syncProjectFiles();
          }, PROJECT_SYNC_INTERVAL);
        };
        const syncProjectFiles = () => {
          clearTimeout(pollTimer);
          pollTimer = 0;
          if (disposed || document.visibilityState !== 'visible') return;
          if (projectSyncBusy.current || clearInProgress.current) { scheduleNext(); return; }
          const current = projectRef.current;
          if (!currentProjectPath()) return;
          const snapshot = latestSnapshot.current || {};
          const liveImages = (snapshot.elements || []).filter((item) => item && item.type === 'image' && !item.isDeleted);
          const projectRoot = currentProjectPath();
          const sourceElements = liveImages.filter((item) => item.customData && canvasPathWithin(projectRoot, item.customData.dshSourcePath || ''));
          const externalSourceElements = liveImages.filter((item) => item.customData && item.customData.dshSourcePath && !canvasPathWithin(projectRoot, item.customData.dshSourcePath));
          const sourcePaths = new Set(sourceElements.map((item) => item.customData.dshSourcePath));
          for (const path of sourcePaths) queuedDiskPaths.current.delete(path);
          projectSyncBusy.current = true;
          activeController = new AbortController();
          const requestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current), signal: activeController.signal };
          const collectPhotoshopOutputs = () => {
            const watch = photoshopWatch.current;
            if (!watch || !watch.directory) return Promise.resolve();
            return fetch('/dsh-canvas/photoshop-outputs', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...current, directory: watch.directory, baseline: watch.baseline || [] }),
              signal: activeController && activeController.signal
            }).then((r) => r.json()).then((checked) => {
              if (disposed || !checked || !checked.ok || !Array.isArray(checked.outputs)) return;
              const projectRoot = currentProjectPath();
              const linkedPaths = new Set(((latestSnapshot.current && latestSnapshot.current.elements) || []).filter((item) => item && item.type === 'image' && !item.isDeleted).map((item) => item.customData && item.customData.dshSourcePath).filter(Boolean));
              checked.outputs.forEach((output) => {
                // Existing linked PSDs are refreshed by refresh-source above.
                // This watcher is only responsible for a new Photoshop Save As
                // result, otherwise saving an already-linked PSD would duplicate it.
                if (!output || !output.path || linkedPaths.has(output.path) || queuedDiskPaths.current.has(output.path)) return;
                queuedDiskPaths.current.add(output.path);
                // Update the baseline immediately so the same Save As result is
                // never enqueued twice while its preview is loading.
                const baseline = Array.isArray(watch.baseline) ? watch.baseline : [];
                const previous = baseline.find((item) => item && item.path === output.path);
                if (previous) { previous.mtime = output.mtime; previous.size = output.size; }
                else baseline.push({ path: output.path, mtime: output.mtime, size: output.size });
                watch.baseline = baseline;
                if (canvasPathWithin(projectRoot, output.path)) {
                  pendingRef.current.push({ ...output, explicit: true });
                  flushPending();
                  setFeedback('✓ Photoshop 新建/保存的 PSD 已加入画布：' + output.name);
                  return;
                }
                fetch('/dsh-canvas/import-file', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ ...current, sourcePath: output.path, name: output.name, kind: 'psd' })
                }).then((r) => r.json().then((data) => ({ ok: r.ok, data }))).then((result) => {
                  if (!result.ok || !result.data || !result.data.ok || !result.data.image) throw new Error(result.data && result.data.error || 'PSD 导入失败');
                  const image = result.data.image;
                  queuedDiskPaths.current.add(image.path);
                  if (knownDiskPaths.current) knownDiskPaths.current.add(image.path);
                  pendingRef.current.push({ ...image, explicit: true });
                  flushPending();
                  setFeedback('✓ Photoshop 新建/保存的 PSD 已加入画布：' + image.name);
                }).catch((err) => {
                  queuedDiskPaths.current.delete(output.path);
                  setFeedback('⚠ Photoshop PSD 同步失败：' + String((err && err.message) || err));
                });
              });
            });
          };
          fetch('/dsh-canvas/project-files', requestInit)
            .then((r) => r.json())
            .then(async (result) => {
              if (disposed || !result || !result.ok || !Array.isArray(result.images)) return;
              const filesByPath = new Map(result.images.map((item) => [item.path, item]));
              const diskPaths = new Set(filesByPath.keys());
              for (const path of [...queuedDiskPaths.current]) if (!diskPaths.has(path)) queuedDiskPaths.current.delete(path);
              const updates = new Map();
              const missingIds = [];
              for (const element of sourceElements) {
                const source = element.customData || {};
                // 图层编辑的临时提取图（dshScratch）落在 outputs/ 下，而项目素材扫描在 depth 0
                // 就跳过 outputs/，它永远不会出现在 project-files 列表里。若不跳过，这里的
                // “访达删除对账”会在加入画布约 2 秒后就把元素移除，提交编辑时报“原图已不在画布中”。
                // 图层编辑的两类残留自愈：占位图（dshEditState=processing）与临时提取图
                // （dshScratch）的源文件都在 outputs/.图片编辑临时/ 下、不在 project-files
                // 列表里（扫描跳过 outputs/）。写回成功的清理消息偶尔被时序吞掉——这里
                // 兜底：占位图存活超过 10 分钟直接移除；临时提取图超过 30 分钟也移除。
                const nowMs = Date.now();
                if (source.dshEditState === 'processing') {
                  const started = Number(source.dshEditStartedAt || 0);
                  if (!started || nowMs - started > 10 * 60 * 1000) { finderRemovingIds.current.add(element.id); missingIds.push(element.id); continue; }
                }
                if (source.dshScratch === true) {
                  const born = Number(source.dshSourceMtime || 0);
                  if (!born || nowMs - born > 30 * 60 * 1000) { finderRemovingIds.current.add(element.id); missingIds.push(element.id); continue; }
                  continue;
                }
                const disk = filesByPath.get(source.dshSourcePath);
                if (!disk) {
                  const pendingRename = pendingRenames.current.get(element.id);
                  if (pendingRename && (!pendingRename.expiresAt || pendingRename.expiresAt > Date.now())) continue;
                  if (pendingRename) pendingRenames.current.delete(element.id);
                  finderRemovingIds.current.add(element.id);
                  missingIds.push(element.id);
                  continue;
                }
                if (Math.abs(Number(disk.mtime || 0) - Number(source.dshSourceMtime || 0)) > 1 || (Number(source.dshSourceSize || 0) > 0 && Number(disk.size || 0) !== Number(source.dshSourceSize || 0))) {
                  updates.set(element.id, disk.mtime);
                  post({ type: 'refresh-source', elementId: element.id, ...disk });
                }
              }
              if (missingIds.length) {
                post({ type: 'remove-sources', ids: missingIds });
                setFeedback('✓ 已同步访达删除：画布移除 ' + missingIds.length + ' 张图片');
              }
              // 项目目录新增文件 → 自动加入画布（对齐「文件夹实时刷新」的心智模型：
              // Illustrator/Photoshop 另存、访达拷贝进项目的新图，画布自动长出来）。
              // 基线快照法：首轮只建立基线不加；之后仅“基线外 + mtime 近 15 分钟 + 画布未挂”的才加，
              // 避免把历史文件一次性全倒上画布，也避免复活用户刚从画布删掉的旧图。
              try {
                const linked = new Set();
                // 画布把元素图像缓存进 assets（materialize-image），文件名取自元素的
                // dshFileName；这些缓存副本的路径不等于元素源路径，仅按路径判会漏。
                // 按文件名一并排除，避免缓存副本被当成"项目新增文件"重复上画布。
                // 主干同名 → 元素源路径的映射:主干命中只算「疑似重复」,随后按
                // 文件 md5 字节级确认——重新生成的图(Z01-2.png)与已有(Z01.png)
                // 同主干但内容全新,必须放行;只有同字节的物化缓存副本才拦。
                const linkedStemPaths = new Map();
                for (const el of (latestSnapshot.current || {}).elements || []) {
                  if (el && el.type === 'image' && !el.isDeleted && el.customData && el.customData.dshSourcePath) linked.add(el.customData.dshSourcePath);
                  if (el && el.type === 'image' && !el.isDeleted && el.customData && el.customData.dshFileName && el.customData.dshSourcePath) {
                    const stem = String(el.customData.dshFileName).toLowerCase().replace(/(-\d+)+(?=\.[a-z]+$)/i, '').replace(/\.[a-z0-9]+$/i, '');
                    if (stem && !linkedStemPaths.has(stem)) linkedStemPaths.set(stem, String(el.customData.dshSourcePath));
                  }
                }
                if (!autoAddBaseline.current) {
                  try {
                    const stored = localStorage.getItem('dsh-canvas-autoadd-baseline:' + currentProjectPath());
                    autoAddBaseline.current = stored ? new Set(JSON.parse(stored)) : new Set(diskPaths);
                  } catch (errBase) { autoAddBaseline.current = new Set(diskPaths); }
                } else {
                  const fresh = [];
                  const verifyQueue = [];
                  for (const item of result.images || []) {
                    if (!item || !item.path) continue;
                    // ADOBE桥接/ 下的文件由桥接轮询器按清单上画布（要打出处印、要 ack），这里跳过以免重复添加。
                    if (isAdobeBridgePath(item.path)) continue;
                    if (autoAddBaseline.current.has(item.path) || linked.has(item.path) || queuedDiskPaths.current.has(item.path)) continue;
                    const stem = String(item.name || imageName(item.path)).toLowerCase().replace(/(-\d+)+(?=\.[a-z]+$)/i, '').replace(/\.[a-z0-9]+$/i, '');
                    const stemPath = linkedStemPaths.get(stem);
                    if (stemPath) { verifyQueue.push({ item, stemPath }); continue; }
                    autoAddBaseline.current.add(item.path);
                    if (Number(item.mtime || 0) > Date.now() - 15 * 60 * 1000) fresh.push(item);
                  }
                  for (const { item, stemPath } of verifyQueue) {
                    const digests = await Promise.all([fileDigestOf(item.path), fileDigestOf(stemPath)]);
                    autoAddBaseline.current.add(item.path);
                    if (digests[0] && digests[0] === digests[1]) continue; // 字节一致:物化缓存副本,真重复
                    if (Number(item.mtime || 0) > Date.now() - 15 * 60 * 1000) fresh.push(item); // 内容全新:重新生成的图,放行
                  }
                  try { localStorage.setItem('dsh-canvas-autoadd-baseline:' + currentProjectPath(), JSON.stringify([...autoAddBaseline.current])); } catch (errSave) {}
                  if (fresh.length) {
                    for (const item of fresh) {
                      queuedDiskPaths.current.add(item.path);
                      if (knownDiskPaths.current) knownDiskPaths.current.add(item.path);
                      pendingRef.current.push({ ...item, explicit: true });
                    }
                    flushPending();
                    setFeedback('✓ 检测到项目新增文件，已加入画布：' + fresh.map((f) => f.name || imageName(f.path)).join('、'));
                  }
                }
              } catch (errAuto) {}
              // 只有 iframe 成功读取新预览并更新场景后，changed 快照才会写入
              // 新 mtime。不能在这里乐观标记，否则 Photoshop 保存期间若预览
              // 暂时读取失败，后续轮询会误以为已经刷新而永不重试。
              knownDiskPaths.current = diskPaths;
            })
            .then(() => collectPhotoshopOutputs())
            .then(() => {
              if (disposed || !externalSourceElements.length) return undefined;
              const sources = externalSourceElements.map((item) => ({ elementId: item.id, path: item.customData.dshSourcePath, name: item.customData.dshFileName || '', mtime: Number(item.customData.dshSourceMtime || 0), size: Number(item.customData.dshSourceSize || 0) }));
              return fetch('/dsh-canvas/check-sources', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources }), signal: activeController && activeController.signal })
                .then((r) => r.json())
                .then((checked) => {
                  if (disposed || !checked || !checked.ok || !Array.isArray(checked.changed)) return;
                  const missingIds = [];
                  for (const changed of checked.changed) {
                    if (changed.missing) missingIds.push(changed.elementId);
                    else post({ type: 'refresh-source', ...changed });
                  }
                  if (missingIds.length) post({ type: 'remove-sources', ids: missingIds });
                });
            })
            .catch(() => {})
            .finally(() => {
              projectSyncBusy.current = false;
              activeController = null;
              scheduleNext();
            });
        };
        const onVisibilityChange = () => {
          if (document.visibilityState === 'visible') syncProjectFiles();
          else {
            clearTimeout(pollTimer);
            pollTimer = 0;
            if (activeController) activeController.abort();
          }
        };
        const onWindowFocus = () => syncProjectFiles();
        document.addEventListener('visibilitychange', onVisibilityChange);
        window.addEventListener('focus', onWindowFocus);
        syncProjectFiles();
        return () => {
          disposed = true;
          clearTimeout(pollTimer);
          document.removeEventListener('visibilitychange', onVisibilityChange);
          window.removeEventListener('focus', onWindowFocus);
          if (activeController) activeController.abort();
          activeController = null;
          projectSyncBusy.current = false;
          knownDiskPaths.current = null;
          queuedDiskPaths.current.clear();
        };
      }, [on, projectInfo.cwd, projectInfo.project]);

      // Adobe 桥接轮询：心跳握手 + 把 PS/AI 面板送来的图层放上画布（features/adobe-bridge/00-bridge.js）。
      // 与上面的项目轮询互不干扰：桥接文件由这里按清单添加，通用自动上画布已跳过 ADOBE桥接/。
      React.useEffect(() => {
        if (!on) return undefined;
        const poller = createAdobeBridgePoller({
          getProject: () => projectRef.current,
          isLinked: (path) => ((latestSnapshot.current && latestSnapshot.current.elements) || []).some((el) => el && el.type === 'image' && !el.isDeleted && el.customData && el.customData.dshSourcePath === path),
          isQueued: (path) => queuedDiskPaths.current.has(path),
          addImages: (items) => {
            for (const item of items) {
              queuedDiskPaths.current.add(item.path);
              if (knownDiskPaths.current) knownDiskPaths.current.add(item.path);
              pendingRef.current.push(item);
            }
            flushPending();
          },
          setFeedback
        });
        poller.start();
        return () => poller.stop();
      }, [on, projectInfo.cwd, projectInfo.project]);

      // 「更多」菜单打开时查桥接安装状态：缺什么才显示对应安装按钮（features/adobe-bridge/00-bridge.js）。
      React.useEffect(() => {
        if (!on || !moreMenuOpen) return undefined;
        let cancelled = false;
        fetchAdobeBridgeInstallStatus().then((state) => { if (!cancelled) setAdobeInstall(state); });
        return () => { cancelled = true; };
      }, [on, moreMenuOpen]);

      const startResize = (e) => {
        e.preventDefault();
        const target = e.currentTarget;
        // Pointer Capture：拖拽期间所有指针事件（含 pointerup）强制发给分隔条，
        // 不会被面板内的 iframe / 其它元素吞掉，松开必然结束拖拽。
        try { target.setPointerCapture(e.pointerId); } catch (err) {}
        const pointerId = e.pointerId;
        const onMove = (ev) => {
          if (ev.pointerId !== pointerId) return;
          const w = window.innerWidth - ev.clientX;
          setWidth(clampPanelWidth(w));
        };
        const onUp = (ev) => {
          if (ev.pointerId !== pointerId) return;
          try { target.releasePointerCapture(pointerId); } catch (err) {}
          target.removeEventListener('pointermove', onMove);
          target.removeEventListener('pointerup', onUp);
          target.removeEventListener('pointercancel', onUp);
        };
        target.addEventListener('pointermove', onMove);
        target.addEventListener('pointerup', onUp);
        target.addEventListener('pointercancel', onUp);
      };

      const progressPercent = removeProgress && Number.isFinite(Number(removeProgress.percent))
        ? Math.max(0, Math.min(100, Number(removeProgress.percent)))
        : null;
      const style = { width: width + 'px' };
      const iframe = React.createElement('iframe', {
        ref: frameRef,
        srcDoc: EXCALIDRAW_SRCDOC_CLEAN,
        className: 'dsh-canvas-frame',
        title: 'Infinite Canvas'
      });
      const hidden = !on ? ' dsh-canvas-overlay-hidden' : '';
      const titlebarSafe = IS_WINDOWS_UI ? ' dsh-canvas-overlay-below-titlebar' : '';
      // Windows:每 2 秒实测一次标题栏高度写进内联样式(应用布局稳定前可能量不到)。
      React.useEffect(() => {
        if (!IS_WINDOWS_UI) return undefined;
        let stopped = false;
        const apply = () => {
          const measured = measureWindowsTitlebar();
          const root = document.querySelector('.dsh-canvas-overlay');
          if (root && !stopped) root.style.top = measured.height + 'px';
          return measured;
        };
        const first = apply();
        fetch('/dsh-canvas/client-debug', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform: navigator.platform,
            ua: navigator.userAgent,
            isWindowsUI: IS_WINDOWS_UI,
            titlebar: first,
            at: Date.now()
          })
        }).catch(() => {});
        const timer = window.setInterval(apply, 2000);
        return () => { stopped = true; window.clearInterval(timer); };
      }, []);

      return React.createElement('div', { className: 'dsh-canvas-overlay' + titlebarSafe + hidden, style },
        React.createElement('div', {
          className: 'dsh-canvas-resizer',
          onPointerDown: startResize,
          title: '拖动调整宽度'
        }),
        React.createElement('div', { className: 'dsh-canvas-toolbar' },
          React.createElement('span', { className: 'dsh-canvas-title' }, '无限画布'),
          React.createElement('button', { className: 'dsh-canvas-project', title: '打开项目管理', onClick: openProjectList },
            React.createElement('span', { className: 'dsh-canvas-project-label' }, '项目：' + (projectInfo.project ? basename(projectInfo.project) : (projectInfo.cwd ? '未选择' : '未绑定'))),
            React.createElement('span', { className: 'dsh-canvas-project-chevron' }, '⌄')
          ),
          React.createElement('span', { className: 'dsh-canvas-status dsh-canvas-status-' + status },
            status === 'ready' ? '已就绪' : (status === 'error' ? '加载失败' : '加载中…')),

          removeProgress ? React.createElement('span', { className: 'dsh-canvas-operation-progress', title: String(removeProgress.message || '') },
            React.createElement('span', { className: 'dsh-canvas-operation-progress-track' },
              React.createElement('span', {
                className: 'dsh-canvas-operation-progress-fill' + (progressPercent === null ? ' is-indeterminate' : ''),
                style: progressPercent === null ? undefined : { width: progressPercent + '%' }
              })
            ),
            React.createElement('span', { className: 'dsh-canvas-operation-progress-label' }, progressPercent === null ? '处理中…' : Math.round(progressPercent) + '%')
          ) : null,
          feedback
            ? React.createElement('span', { className: 'dsh-canvas-feedback' }, feedback)
            : React.createElement('span', { className: 'dsh-canvas-hint' }, '图片可移动/缩放/旋转/裁剪 · 画笔标注'),
          React.createElement('div', { style: { position: 'relative', display: 'inline-flex' } },
            React.createElement('button', { className: 'dsh-canvas-tb', title: '按类型/时间/尺寸/大小/名称或颜色标记整理画布图片，可撤销', onClick: () => setCanvasArrangeOpen((value) => !value) }, '整理图片'),
            canvasArrangeOpen ? React.createElement('div', { className: 'dsh-arrange-pop' },
              React.createElement('label', { className: 'dsh-arrange-field' }, '排序',
                React.createElement('select', { value: canvasArrangeOrder, onChange: (event) => setCanvasArrangeOrder(event.target.value) },
                  React.createElement('option', { value: 'name' }, '文件名称'),
                  React.createElement('option', { value: 'type' }, '文件类型'),
                  React.createElement('option', { value: 'time' }, '修改时间'),
                  React.createElement('option', { value: 'pixels' }, '图片尺寸'),
                  React.createElement('option', { value: 'bytes' }, '文件大小')
                )
              ),
              React.createElement('label', { className: 'dsh-arrange-field' }, '范围',
                React.createElement('select', { value: canvasArrangeTag, onChange: (event) => setCanvasArrangeTag(event.target.value) },
                  React.createElement('option', { value: '' }, '全部图片'),
                  React.createElement('option', { value: 'none' }, '仅未标记'),
                  MATERIAL_TAG_COLORS.map((color) => React.createElement('option', { key: color.id, value: color.id }, '仅' + color.label + '色标记'))
                )
              ),
              React.createElement('button', { className: 'dsh-arrange-run', onClick: () => { setCanvasArrangeOpen(false); post({ type: 'arrange-images', order: canvasArrangeOrder, tag: canvasArrangeTag }); } }, '整理'),
              React.createElement('button', { onClick: () => setCanvasArrangeOpen(false) }, '取消')
            ) : null
          ),
          React.createElement('button', { className: 'dsh-canvas-tb', onClick: () => post({ type: 'export' }) }, '导出 PNG'),
          React.createElement('button', { className: 'dsh-canvas-tb', title: '本地素材库：常用图片发送到画布或聊天', onClick: () => openMaterials() }, '素材库'),
          React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-tb-adobe', title: '把 Photoshop 里当前选中的图层拉到画布（PS 需已打开文档并选中图层；不用在 PS 里点任何面板）', disabled: !projectInfo.project, onClick: () => { void pullFromAdobe(projectRef.current, 'photoshop', setFeedback); } }, '取 Ps 图层'),
          React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-tb-adobe', title: '把 Illustrator 里当前选中的对象拉到画布（AI 需已打开文档并选中对象；150 dpi 透明 PNG）', disabled: !projectInfo.project, onClick: () => { void pullFromAdobe(projectRef.current, 'illustrator', setFeedback, { dpi: 150 }); } }, '取 Ai 对象'),
          React.createElement('button', {
            className: 'dsh-canvas-tb dsh-canvas-more',
            title: '更多画布操作',
            onClick: () => setMoreMenuOpen((value) => !value)
          }, '更多 ···'),
          React.createElement('button', {
            className: 'dsh-canvas-tb dsh-canvas-tb-close',
            title: '收起画布面板，画布内容会保存',
            onClick: () => { saveNow(); clearTimeout(saveTimer.current); setMode(false); }
          }, '收起画布'),
          moreMenuOpen ? React.createElement('div', { className: 'dsh-canvas-more-menu' },
            updateInfo && updateInfo.supported === false ? null : React.createElement('button', {
              title: updateInfo && updateInfo.hasUpdate ? '一键更新到 ' + updateInfo.latest + '（应用自带安装器，完成后需重启 DSH）' : '检查 npm 上的最新版本（官方源/大陆镜像自动切换）',
              disabled: updating || (updateInfo && updateInfo.hasUpdate === false && updateInfo.latest),
              onClick: () => {
                if (!(updateInfo && updateInfo.hasUpdate)) { refreshUpdateInfo(false); return; }
                setUpdating(true);
                setFeedback('⏳ 正在更新到 ' + updateInfo.latest + '，完成后需重启 DSH…');
                fetch('/dsh-canvas/self-update', { method: 'POST', headers: { 'Content-Type': 'application/json' } })
                  .then((r) => r.json())
                  .then((result) => {
                    setUpdating(false);
                    if (result && result.ok && result.installed) {
                      setFeedback('✓ 已更新到 ' + result.installed + '，请完全退出并重启 DSH 生效');
                      setMoreMenuOpen(false);
                    } else if (result && result.upToDate) {
                      setFeedback('✓ 已是最新版');
                    } else {
                      setFeedback('⚠ ' + String((result && result.error) || '更新失败').slice(0, 220));
                    }
                  })
                  .catch((err) => { setUpdating(false); setFeedback('⚠ 更新请求失败:' + String((err && err.message) || err)); });
              }
            }, updating ? '⏳ 更新中…' : (updateInfo && updateInfo.hasUpdate ? '🔄 更新到 ' + updateInfo.latest + '（当前 ' + updateInfo.current + '）' : '🔄 检查更新')),
            React.createElement('button', {
              title: toolchain && toolchain.items && Object.values(toolchain.items).some((v) => v && v.state === 'error')
                ? '部分工具准备失败,点此重试'
                : '查看本地工具链(Python/去背景/矢量/OCR/dsh-codex)准备状态,未就绪时一键准备',
              onClick: () => {
                setMoreMenuOpen(false);
                fetch('/dsh-canvas/toolchain-status').then((r) => r.json()).then((d) => {
                  if (!(d && d.ok)) return;
                  setToolchain(d.status);
                  const items = d.status.items || {};
                  const errors = Object.entries(items).filter(([k, v]) => v && v.state === 'error');
                  const pending = Object.entries(items).filter(([k, v]) => v && ['downloading', 'preparing', 'extracting'].includes(v.state));
                  if (pending.length) {
                    setFeedback('⏳ 工具链准备中: ' + pending.map(([k]) => k).join('、') + '…');
                  } else if (errors.length) {
                    setFeedback('⚠ 部分工具失败: ' + errors.map(([k, v]) => k + '(' + String(v.error || '').slice(0, 30) + ')').join('、') + ' — 正在重试…');
                    fetch('/dsh-canvas/toolchain-prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).catch(() => {});
                  } else {
                    setFeedback('✓ 本地工具链全部就绪');
                  }
                }).catch(() => setFeedback('⚠ 工具链状态读取失败'));
              }
            }, toolchain && toolchain.items && Object.values(toolchain.items).some((v) => v && v.state === 'error')
              ? '🛠 本地工具链(有失败,点击重试)'
              : '🛠 本地工具链状态'),
            React.createElement('button', {
              title: '开启后画布背景跟随 macOS 系统外观，关闭则跟随 DSH 的主题设置',
              onClick: () => {
                const next = !canvasBgFollowSystem;
                bgFollowSystemRef.current = next;
                setCanvasBgFollowSystem(next);
                try { window.localStorage.setItem('dsh-canvas-bg-follow-system', next ? '1' : '0'); } catch (error) {}
                setFeedback(next ? '✓ 画布背景已改为跟随系统外观' : '✓ 画布背景已改为跟随 DSH 主题');
              }
            }, (canvasBgFollowSystem ? '☑' : '☐') + ' 画布背景跟随系统'),
            React.createElement('button', { onClick: () => { setMoreMenuOpen(false); openProjectFolder(); }, disabled: !projectInfo.project }, '📁 打开项目文件夹'),
            React.createElement('button', { onClick: openImageSettings }, '⚙ 图像引擎设置'),
            adobeInstall.scriptsInstalled ? null : React.createElement('button', { title: '检测到 Photoshop / Illustrator 的「文件 → 脚本」菜单里还没有 DSH 桥接入口。两款应用的脚本目录都属于系统管理员，会弹出 macOS 密码对话框（密码由系统收集，插件接触不到），只需一次；装完重启 PS/AI 生效，此按钮随之消失。不装也不影响画布里的「取 Ps 图层」「→Ps」', onClick: () => { setMoreMenuOpen(false); void installAdobeBridgeScripts(setFeedback, true).then(() => fetchAdobeBridgeInstallStatus()).then(setAdobeInstall); } }, '🔐 安装 PS / AI 菜单面板（需 Mac 密码）'),
            adobeInstall.cepInstalled ? null : React.createElement('button', { title: '检测到常驻桥接面板未安装。CEP 扩展装在用户级目录不需要管理员密码，可停靠、自动轮询发件箱；适用 Illustrator（各版本，入口「窗口 → 扩展功能」）与 Photoshop ≤2024（入口「窗口 → 扩展（旧版）」）。Photoshop 2025 起 Adobe 已移除旧扩展系统，PS 2025+ 请用画布上的「取 Ps 图层」「→Ps」或菜单里的一键脚本。装好后此按钮自动消失', onClick: () => { setMoreMenuOpen(false); void installAdobeBridgeCepPanel(setFeedback).then(() => fetchAdobeBridgeInstallStatus()).then(setAdobeInstall); } }, '🧩 安装常驻面板（Illustrator / PS≤2024）'),
            React.createElement('button', { onClick: () => { setMoreMenuOpen(false); saveNow(); setFeedback('✓ 已保存当前画布'); }, disabled: !projectInfo.project }, '保存当前画布'),
            React.createElement('button', { className: 'dsh-canvas-more-danger', title: '先备份画布，再把项目图片移入画布回收站', onClick: () => { setMoreMenuOpen(false); backupAndClear(); }, disabled: !projectInfo.project }, '清空当前画布')
          ) : null
        ),
        imageSettings ? React.createElement('div', { className: 'dsh-canvas-engine-dialog' },
          React.createElement('div', { className: 'dsh-canvas-engine-card' },
            React.createElement('div', { className: 'dsh-canvas-project-dialog-heading' },
              React.createElement('div', null,
                React.createElement('div', { className: 'dsh-canvas-project-dialog-title' }, '图像生成引擎'),
                React.createElement('div', { className: 'dsh-canvas-project-subtitle' }, '选择一种图片生成路线；状态、安装、登录、密钥与连接检测都可在这里完成。')
              ),
              React.createElement('button', { className: 'dsh-canvas-project-dialog-close', onClick: () => { if (!imageSettingsBusy) setImageSettings(null); } }, '×')
            ),
            imageSettings.loading ? React.createElement('div', { className: 'dsh-canvas-engine-loading' }, '正在读取本机引擎状态…') : React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'dsh-canvas-engine-options' },
                React.createElement('label', { className: 'dsh-canvas-engine-option' },
                  React.createElement('input', { type: 'radio', name: 'dsh-image-engine', checked: imageSettings.engine === 'dsh-codex', onChange: () => setImageSettings({ ...imageSettings, engine: 'dsh-codex' }) }),
                  React.createElement('span', null,
                    React.createElement('strong', null, 'Codex 统一路由 ', React.createElement('em', { className: 'dsh-canvas-engine-badge ' + (imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.ready ? 'is-ready' : '') }, imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.ready ? '可用' : '待配置')),
                    React.createElement('small', null, '与当前 DSH 的 dsh-codex 共用 ChatGPT OAuth、订阅额度和 gpt-image-2 图片能力。')
                  )
                ),
                React.createElement('label', { className: 'dsh-canvas-engine-option' },
                  React.createElement('input', { type: 'radio', name: 'dsh-image-engine', checked: imageSettings.engine === 'api', onChange: () => setImageSettings({ ...imageSettings, engine: 'api' }) }),
                  React.createElement('span', null,
                    React.createElement('strong', null, 'API ', React.createElement('em', { className: 'dsh-canvas-engine-badge ' + (imageSettings.health && imageSettings.health.api && imageSettings.health.api.ready ? 'is-ready' : '') }, imageSettings.health && imageSettings.health.api && imageSettings.health.api.ready ? '已配置' : '待配置')),
                    React.createElement('small', null, '连接 OpenAI 兼容图片接口，适合企业网关或独立 image2 服务。')
                  )
                )
              ),
              React.createElement('div', { className: 'dsh-canvas-engine-autoadd' },
                React.createElement('label', { className: 'dsh-canvas-engine-autoadd-row' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: autoAddOn,
                    onChange: (e) => {
                      const next = Boolean(e.target.checked);
                      setCanvasAutoAddEnabled(next);
                      setAutoAddOnState(next);
                    }
                  }),
                  React.createElement('span', null, '聊天生图完成后自动上画布',
                    React.createElement('small', null, '默认开启:生成中在画布显示占位提示,完成后自动加入,无需逐张点「加入画布」。批量生图或大量抽卡重跑时建议关闭,改回卡片手动加入,避免画布被占满。')
                  )
                )
              ),
              imageSettings.engine === 'dsh-codex' ? React.createElement('div', { className: 'dsh-canvas-engine-setup' },
                React.createElement('div', { className: 'dsh-canvas-engine-steps' },
                  React.createElement('div', { className: imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.installed ? 'is-done' : '' }, React.createElement('b', null, '1'), React.createElement('span', null, '兼容组件', React.createElement('small', null, imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.installed ? '当前 profile 已加载兼容版' : (imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.detail ? imageSettings.health.dshCodex.detail : '请运行画布套件安装/修复')))),
                  React.createElement('div', { className: imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.authenticated ? 'is-done' : '' }, React.createElement('b', null, '2'), React.createElement('span', null, '登录 ChatGPT', React.createElement('small', null, imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.authenticated ? 'OAuth 已登录，令牌会自动刷新' : '在浏览器完成独立 OAuth 授权'))),
                  React.createElement('div', { className: imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.ready ? 'is-done' : '' }, React.createElement('b', null, '3'), React.createElement('span', null, '开始使用', React.createElement('small', null, '保存后用于编辑、擦除与文字背景清理')))
                ),
                React.createElement('div', { className: 'dsh-canvas-engine-inline-actions' },
                  !(imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.installed) ? React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', disabled: imageSettingsBusy, onClick: installDshCodex }, imageSettingsBusy ? '检查中…' : '检查兼容组件') : null,
                  imageSettings.health && imageSettings.health.dshCodex && imageSettings.health.dshCodex.installed && !imageSettings.health.dshCodex.authenticated ? React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', disabled: imageSettingsBusy, onClick: startCodexLogin }, imageSettingsBusy ? '处理中…' : '使用 ChatGPT 登录') : null,
                  React.createElement('button', { className: 'dsh-canvas-tb', disabled: imageSettingsBusy, onClick: () => refreshImageSettings('状态已刷新') }, '刷新状态'),
                  React.createElement('button', { className: 'dsh-canvas-tb', disabled: imageSettingsBusy, onClick: () => askDshToConfigure('dsh-codex') }, '让 DSH 帮我配置')
                )
              ) : React.createElement('div', { className: 'dsh-canvas-engine-setup' },
                React.createElement('div', { className: 'dsh-canvas-engine-api-grid' },
                  React.createElement('label', { className: 'dsh-canvas-engine-field' }, React.createElement('span', null, 'API 地址', React.createElement('small', null, '须为 HTTPS；带或不带 /v1 均可')), React.createElement('input', { value: imageSettings.apiBaseUrl || '', onChange: (e) => setImageSettings({ ...imageSettings, apiBaseUrl: e.target.value }), placeholder: 'https://api.example.com' })),
                  React.createElement('label', { className: 'dsh-canvas-engine-field' }, React.createElement('span', null, '模型名称', React.createElement('small', null, '服务商提供的图片编辑模型 ID')), React.createElement('input', { value: imageSettings.apiModel || '', onChange: (e) => setImageSettings({ ...imageSettings, apiModel: e.target.value }), placeholder: 'gpt-image-2' })),
                  React.createElement('label', { className: 'dsh-canvas-engine-field dsh-canvas-engine-key' }, React.createElement('span', null, 'API Key', React.createElement('small', null, imageSettings.health && imageSettings.health.api && imageSettings.health.api.configured ? '已安全保存；留空保持原密钥' : '仅保存到本机用户目录，不进入项目')), React.createElement('input', { type: 'password', autoComplete: 'new-password', value: imageSettings.apiKey || '', onChange: (e) => setImageSettings({ ...imageSettings, apiKey: e.target.value }), placeholder: imageSettings.health && imageSettings.health.api && imageSettings.health.api.configured ? '••••••••（已配置）' : 'sk-…' }))
                ),
                React.createElement('div', { className: 'dsh-canvas-engine-inline-actions' },
                  React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', disabled: imageSettingsBusy || (!(imageSettings.health && imageSettings.health.api && imageSettings.health.api.configured) && !String(imageSettings.apiKey || '').trim()), onClick: testApiSettings }, imageSettingsBusy ? '检测中…' : '保存并检测连接'),
                  React.createElement('button', { className: 'dsh-canvas-tb', disabled: imageSettingsBusy, onClick: () => askDshToConfigure('api') }, '让 DSH 帮我配置')
                )
              ),
              imageSettings.error ? React.createElement('div', { className: 'dsh-canvas-engine-error' }, '⚠ ' + imageSettings.error) : null,
              imageSettings.notice ? React.createElement('div', { className: 'dsh-canvas-engine-notice' }, imageSettings.notice) : null,
              React.createElement(ToolchainCard, { toolchain, onRefresh: () => { fetch('/dsh-canvas/toolchain-status').then((r) => r.json()).then((d) => { if (d && d.ok) setToolchain(d.status); }).catch(() => {}); } }),
              React.createElement('div', { className: 'dsh-canvas-engine-note' }, '安全说明：OAuth 与 API Key 分开保存，前端永远读不到完整凭据；不会写入画布项目、聊天消息或 Git 仓库。'),
              React.createElement('div', { className: 'dsh-canvas-project-actions' },
                React.createElement('button', { className: 'dsh-canvas-tb', disabled: imageSettingsBusy, onClick: () => setImageSettings(null) }, '取消'),
                React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', disabled: imageSettingsBusy, onClick: saveImageSettings }, imageSettingsBusy ? '保存中…' : '保存设置')
              )
            )
          )
        ) : null,
        projectDialog ? React.createElement('div', { className: 'dsh-canvas-project-dialog' },
          projectDialog.mode === 'new' ? React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dsh-canvas-project-dialog-title' }, '新建画布项目'),
            React.createElement('div', { className: 'dsh-canvas-project-subtitle' }, '项目会创建在当前聊天工作目录中，不需要选择路径。'),
            React.createElement('input', { className: 'dsh-canvas-project-input', autoFocus: true, value: projectDialog.value, placeholder: '例如：橄榄球滤材主图', onChange: (e) => setProjectDialog({ ...projectDialog, value: e.target.value }), onKeyDown: (e) => { if (e.key === 'Escape') setProjectDialog(null); } }),
            React.createElement('div', { className: 'dsh-canvas-project-actions' },
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: () => setProjectDialog(null) }, '取消'),
              React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', onClick: () => { const clean = projectDialog.value.replace(/[\\/:*?"<>|]/g, '-').trim(); if (!clean) return; loadProject({ cwd: projectInfo.cwd, project: projectInfo.cwd.replace(/[\\/]+$/, '') + '/' + clean }, false); setProjectDialog(null); } }, '创建并打开')
            )
          ) : projectDialog.mode === 'rename' ? React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dsh-canvas-project-dialog-title' }, '重命名项目'),
            React.createElement('div', { className: 'dsh-canvas-project-subtitle' }, '项目文件夹会同步改名，画布内容和图片不会改变。'),
            React.createElement('input', { className: 'dsh-canvas-project-input', autoFocus: true, value: projectDialog.value, placeholder: '输入新的项目名称', onChange: (e) => setProjectDialog({ ...projectDialog, value: e.target.value }), onKeyDown: (e) => { if (e.key === 'Escape') openProjectList(); if (e.key === 'Enter') renameProject(projectDialog.item, projectDialog.value); } }),
            React.createElement('div', { className: 'dsh-canvas-project-actions' },
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: openProjectList }, '取消'),
              React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', onClick: () => renameProject(projectDialog.item, projectDialog.value) }, '保存名称')
            )
          ) : projectDialog.mode === 'list' ? React.createElement(React.Fragment, null,
            projectDialog.reason === 'auto-add' ? React.createElement('div', { className: 'dsh-canvas-project-reason' }, '🎨 本聊天还没绑定画布项目——选择已有项目或新建一个,生成的图片会自动上画布;直接关闭则本次改回手动加入。') : null,
            React.createElement('div', { className: 'dsh-canvas-project-dialog-heading' },
              React.createElement('div', null,
                React.createElement('div', { className: 'dsh-canvas-project-dialog-title' }, projectDialog.reason === 'auto-add' ? '选择画布项目' : '管理项目'),
                React.createElement('div', { className: 'dsh-canvas-project-subtitle' }, '项目独立保存，切换聊天后仍可重新打开。')
              ),
              React.createElement('button', { className: 'dsh-canvas-project-dialog-close', title: '关闭', onClick: () => setProjectDialog(null) }, '×')
            ),
            projectInfo.project ? React.createElement('div', { className: 'dsh-canvas-project-current' },
              React.createElement('span', { className: 'dsh-canvas-project-current-icon' }, '▣'),
              React.createElement('span', { className: 'dsh-canvas-project-current-main' },
                React.createElement('small', null, '当前项目 · 已自动保存'),
                React.createElement('strong', null, basename(projectInfo.project)),
                React.createElement('code', { title: projectInfo.project }, projectInfo.project)
              ),
            React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-open-folder', onClick: openProjectFolder }, '打开项目文件夹')
            ) : React.createElement('div', { className: 'dsh-canvas-project-current dsh-canvas-project-current-empty' }, '尚未选择项目，可新建或从文件夹导入。'),
            React.createElement('div', { className: 'dsh-canvas-project-section-title' }, '最近项目'),
            React.createElement('div', { className: 'dsh-canvas-project-list' },
              projectList.loading ? React.createElement('div', { className: 'dsh-canvas-project-empty' }, '正在查找项目…') : null,
              projectList.error ? React.createElement('div', { className: 'dsh-canvas-project-empty dsh-canvas-project-error' }, projectList.error) : null,
              !projectList.loading && !projectList.error && !projectList.items.length ? React.createElement('div', { className: 'dsh-canvas-project-empty' }, '当前目录还没有画布项目') : null,
              projectList.items.map((item) => React.createElement('div', { key: item.path, className: 'dsh-canvas-project-card' + (projectInfo.project === item.path ? ' dsh-canvas-project-card-current' : '') },
                React.createElement('button', { className: 'dsh-canvas-project-card-open', title: '打开“' + item.name + '”', onClick: () => { loadProject({ cwd: projectInfo.cwd, sessionId: projectInfo.sessionId, project: item.path }, true); setProjectDialog(null); } },
                  React.createElement('span', { className: 'dsh-canvas-project-card-icon' }, '▣'),
                  React.createElement('span', { className: 'dsh-canvas-project-card-main' }, React.createElement('strong', null, item.name), React.createElement('small', null, item.images + ' 张图片 · ' + item.elements + ' 个元素')),
                  React.createElement('time', null, new Date(item.updatedAt).toLocaleString())
                ),
                React.createElement('span', { className: 'dsh-canvas-project-card-actions' },
                  React.createElement('button', { title: '重命名项目', onClick: () => setProjectDialog({ mode: 'rename', item, value: item.name }) }, '重命名'),
                  React.createElement('button', { className: 'dsh-canvas-project-card-delete', title: '删除项目', onClick: () => deleteProject(item) }, '删除')
                )
              ))
            ),
            React.createElement('div', { className: 'dsh-canvas-project-actions' },
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: importProject }, '导入项目'),
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: () => browseDir(projectInfo.cwd) }, '浏览其他文件夹'),
              React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', onClick: () => setProjectDialog({ mode: 'new', value: '新画布项目' }) }, '新建项目')
            )
          ) : React.createElement(React.Fragment, null,
            React.createElement('div', { className: 'dsh-canvas-project-dialog-title' }, '选择项目文件夹'),
            React.createElement('div', { className: 'dsh-canvas-browser-path', title: projectDialog.path }, projectDialog.path),
            React.createElement('div', { className: 'dsh-canvas-project-list' },
              projectDialog.loading ? React.createElement('div', { className: 'dsh-canvas-project-empty' }, '加载文件夹…') : null,
              projectDialog.error ? React.createElement('div', { className: 'dsh-canvas-project-empty dsh-canvas-project-error' }, projectDialog.error) : null,
              (projectDialog.entries || []).map((item) => React.createElement('button', { key: item.path, className: 'dsh-canvas-folder-card', onClick: () => browseDir(item.path) }, React.createElement('span', null, '📁'), React.createElement('span', null, item.name), React.createElement('span', null, '›')))
            ),
            React.createElement('div', { className: 'dsh-canvas-project-actions' },
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: openProjectList }, '返回项目列表'),
              React.createElement('button', { className: 'dsh-canvas-tb', onClick: () => { const clean = projectDialog.path.replace(/[\\/]+$/, ''); const cut = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\')); const parent = cut > 2 ? clean.slice(0, cut) : clean.slice(0, 3); browseDir(parent || '/'); } }, '上一级'),
              React.createElement('button', { className: 'dsh-canvas-tb dsh-canvas-project-confirm', onClick: () => { loadProject({ cwd: projectInfo.cwd, project: projectDialog.path }, true); setProjectDialog(null); } }, '选择此文件夹')
            )
          )
        ) : null,
        materials ? React.createElement('div', { className: 'dsh-materials-overlay' },
          React.createElement('aside', {
            className: 'dsh-materials-panel' + (materialDropActive ? ' is-drop-active' : ''),
            onDragOver: onMaterialDragOver,
            onDragEnter: onMaterialDragOver,
            onDragLeave: (event) => { if (!event.currentTarget.contains(event.relatedTarget)) setMaterialDropActive(false); },
            onDrop: onMaterialDrop
          },
            React.createElement('div', { className: 'dsh-materials-head' },
              React.createElement('div', null,
                React.createElement('div', { className: 'dsh-materials-title' }, '素材库', React.createElement('span', { className: 'dsh-materials-count' }, materials.files.length + ' 项'))
              ),
              React.createElement('button', { className: 'dsh-materials-close', title: '关闭素材库', 'aria-label': '关闭素材库', onClick: () => setMaterials(null) }, '×')
            ),
            React.createElement('div', { className: 'dsh-materials-location' + (materialControlsOpen ? ' is-expanded' : '') },
              React.createElement('div', { className: 'dsh-materials-location-current', title: materials.dir || '' },
                React.createElement('span', { className: 'dsh-materials-location-icon', 'aria-hidden': true }, '⌂'),
                React.createElement('span', null,
                  React.createElement('strong', null, materials.dir ? basename(materials.dir) : '未选择目录'),
                  React.createElement('small', null, materials.dir || '选择一个独立文件夹作为素材库')
                )
              ),
              React.createElement('button', { onClick: chooseMaterialDirectory, disabled: !!materials.busy }, '切换'),
              React.createElement('button', { className: 'dsh-materials-location-toggle', title: materialControlsOpen ? '收起目录选项' : '展开目录选项', 'aria-expanded': materialControlsOpen ? 'true' : 'false', onClick: () => setMaterialControlsOpen((value) => !value) }, materialControlsOpen ? '⌃' : '⌄')
            ),
            materialControlsOpen || materialDropActive ? React.createElement('div', { className: 'dsh-materials-extra' },
              materialLibrary.recent.length ? React.createElement('label', { className: 'dsh-materials-recent' },
                React.createElement('span', null, '最近访问'),
                React.createElement('select', { value: materials.dir || '', disabled: !!materials.busy, onChange: (event) => { if (event.target.value && event.target.value !== materials.dir) { setMaterials((prev) => prev ? { ...prev, busy: true, error: '' } : prev); loadMaterialDirectory(event.target.value).catch((err) => setMaterials((prev) => prev ? { ...prev, busy: false, error: String(err.message || err) } : prev)); } } },
                  materialLibrary.recent.map((path) => React.createElement('option', { key: path, value: path }, basename(path) + ' — ' + path))
                )
              ) : null,
              React.createElement('div', { className: 'dsh-materials-dropzone' },
                React.createElement('strong', null, materialDropActive ? '松开即可存入当前素材库' : '拖入画布图片或本地图片'),
                React.createElement('span', null, '也可把下方素材拖到左侧画布')
              )
            ) : null,
            React.createElement('div', { className: 'dsh-materials-toolbar' },
              React.createElement('label', { className: 'dsh-materials-search' },
                React.createElement('span', null, '⌕'),
                React.createElement('input', { value: materialQuery, placeholder: '搜索文件名', onChange: (e) => setMaterialQuery(e.target.value), autoFocus: true })
              ),
              React.createElement('div', { className: 'dsh-materials-toolbar-actions' },
                React.createElement('button', { className: materialSelectMode ? 'is-active' : '', onClick: () => { setMaterialSelectMode((value) => !value); setMaterialSelection([]); }, title: materialSelectMode ? '退出多选' : '批量选择素材' }, materialSelectMode ? '完成' : '多选'),
                React.createElement('button', { onClick: addSelectedToLibrary, disabled: !!materials.busy || !projectInfo.project, title: '把当前画布中选中的一张或多张图片保存到当前素材库目录' }, '＋'),
                React.createElement('button', { onClick: refreshMaterials, disabled: !!materials.busy, title: '刷新素材' }, '↻'),
                React.createElement('button', { onClick: openMaterialsFolder, disabled: !materials.dir, title: '打开素材目录' }, '⌁')
              )
            ),
            React.createElement('div', { className: 'dsh-materials-organize' },
              React.createElement('label', { className: 'dsh-materials-sort' },
                React.createElement('span', null, '整理'),
                React.createElement('select', { value: materialSort, onChange: (event) => { const next = event.target.value; setMaterialSort(next); try { window.localStorage.setItem(MATERIAL_SORT_KEY, JSON.stringify(next)); } catch (err) {} } },
                  React.createElement('option', { value: 'time' }, '修改时间'),
                  React.createElement('option', { value: 'type' }, '文件类型'),
                  React.createElement('option', { value: 'pixels' }, '图片尺寸'),
                  React.createElement('option', { value: 'bytes' }, '文件大小'),
                  React.createElement('option', { value: 'name' }, '文件名称')
                )
              ),
              React.createElement('div', { className: 'dsh-materials-tagfilter' },
                React.createElement('span', { className: 'dsh-materials-tagfilter-label' }, '标记'),
                React.createElement('button', { className: 'dsh-materials-tagall' + (materialTagFilter ? '' : ' is-active'), title: '显示全部素材', onClick: () => setMaterialTagFilter('') }, '全部'),
                MATERIAL_TAG_COLORS.map((color) => React.createElement('button', {
                  key: color.id,
                  className: 'dsh-materials-tagdot' + (materialTagFilter === color.id ? ' is-active' : ''),
                  style: { background: color.hex },
                  title: (materialTagFilter === color.id ? '取消' : '只看') + color.label + '色标记',
                  'aria-label': (materialTagFilter === color.id ? '取消' : '只看') + color.label + '色标记',
                  onClick: () => setMaterialTagFilter(materialTagFilter === color.id ? '' : color.id)
                })),
                Object.values(materialTags).length
                  ? React.createElement('span', { className: 'dsh-materials-tagfilter-count' }, Object.values(materialTags).filter(Boolean).length + ' 项已标记')
                  : null
              )
            ),
            materials.error ? React.createElement('div', { className: 'dsh-materials-error' }, materials.error) : null,
            React.createElement('div', { className: 'dsh-materials-body' },
              materials.busy && !materials.files.length
                ? React.createElement('div', { className: 'dsh-materials-empty' }, React.createElement('strong', null, '正在读取素材…'))
                : !materials.files.length
                ? React.createElement('div', { className: 'dsh-materials-empty' }, React.createElement('strong', null, '还没有常用素材'), React.createElement('span', null, '在画布中选中图片，再点击“保存画布选中项”；也可以直接把图片放进素材目录。'))
                : !filteredMaterials.length
                ? React.createElement('div', { className: 'dsh-materials-empty' }, React.createElement('strong', null, '没有匹配的素材'), React.createElement('span', null, '换个关键词，或清空搜索条件。'))
                : React.createElement('div', { className: 'dsh-materials-grid' },
                    filteredMaterials.map((item) => {
                      const tagColor = MATERIAL_TAG_COLORS.find((c) => c.id === materialTags[item.name]) || null;
                      return React.createElement('div', {
                        key: item.name,
                        className: 'dsh-materials-item' + (materialSelection.includes(item.name) ? ' is-selected' : '') + (tagColor ? ' is-tagged is-tag-' + tagColor.id : ''),
                        role: 'button', tabIndex: 0, draggable: true,
                        onDragStart: (event) => startMaterialDrag(event, item),
                        onClick: () => materialSelectMode ? toggleMaterialSelection(item) : setMaterialPreview(item),
                        onDoubleClick: () => sendMaterialToCanvas(item),
                        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); materialSelectMode ? toggleMaterialSelection(item) : setMaterialPreview(item); } },
                        title: (materialSelectMode ? '点击勾选或取消，可连续选择多张' : '拖入画布；单击预览；双击加入画布') + '\n' + (item.width && item.height ? item.width + '×' + item.height + ' · ' : '') + Math.max(1, Math.round((item.size || 0) / 1024)) + ' KB · ' + (item.mtime ? new Date(item.mtime).toLocaleString() : '')
                      },
                        React.createElement('button', {
                          className: 'dsh-materials-tagset' + (tagColor ? ' is-set' : ''),
                          style: tagColor ? { background: tagColor.hex } : undefined,
                          title: tagColor ? '当前' + tagColor.label + '色标记，点击修改' : '设置颜色标记',
                          'aria-label': '设置颜色标记 ' + item.name,
                          onClick: (event) => { event.preventDefault(); event.stopPropagation(); setMaterialTagMenu(materialTagMenu && materialTagMenu.names.length === 1 && materialTagMenu.names[0] === item.name ? null : { names: [item.name] }); }
                        }, tagColor ? '' : '⌗'),
                        materialSelectMode
                          ? React.createElement('span', { className: 'dsh-materials-check', 'aria-hidden': true }, materialSelection.includes(item.name) ? '✓' : '')
                          : React.createElement('button', { className: 'dsh-materials-zoom', title: '放大查看', 'aria-label': '放大查看 ' + item.name, onClick: (event) => { event.preventDefault(); event.stopPropagation(); setMaterialPreview(item); } }, '↗'),
                        React.createElement('span', { className: 'dsh-materials-thumb' },
                          React.createElement('img', { src: '/dsh-canvas/image?path=' + encodeURIComponent(materials.dir + '/' + item.name), loading: 'lazy', alt: item.name })
                        ),
                        React.createElement('span', { className: 'dsh-materials-meta' },
                          React.createElement('span', { className: 'dsh-materials-item-name' }, item.name.replace(/\.[^.]+$/, '')),
                          React.createElement('span', { className: 'dsh-materials-item-info' }, (item.width && item.height ? item.width + '×' + item.height + ' · ' : '') + Math.max(1, Math.round((item.size || 0) / 1024)) + ' KB')
                        )
                      );
                    })
                  )
            ),
            materialSelectMode ? React.createElement('div', { className: 'dsh-materials-selectionbar is-visible' },
              React.createElement('div', { className: 'dsh-materials-selection-summary' },
                React.createElement('strong', null, '已选 ' + selectedMaterials.length + ' 项'),
                React.createElement('button', { onClick: () => setMaterialSelection([]), disabled: !selectedMaterials.length }, '取消选择')
              ),
              React.createElement('div', { className: 'dsh-materials-selection-actions' },
                React.createElement('button', { onClick: () => setMaterialTagMenu({ names: materialSelection.slice() }), disabled: !selectedMaterials.length, title: '为选中的素材设置 Mac 式颜色标记' }, '标记'),
                React.createElement('button', { className: 'is-primary', onClick: addSelectedMaterialsToCanvas, disabled: !selectedMaterials.length }, '加入画布'),
                React.createElement('button', { onClick: attachSelectedMaterialsToChat, disabled: !selectedMaterials.length }, '附加到聊天'),
                React.createElement('button', { className: 'is-danger', onClick: deleteSelectedMaterials, disabled: !selectedMaterials.length || !!materials.busy }, '删除')
              )
            ) : null,
            materialTagMenu ? React.createElement('div', { className: 'dsh-materials-tagmenu', role: 'dialog', 'aria-label': '颜色标记' },
              React.createElement('div', { className: 'dsh-materials-tagmenu-title' }, '标记 ' + materialTagMenu.names.length + ' 项'),
              React.createElement('div', { className: 'dsh-materials-tagmenu-row' },
                MATERIAL_TAG_COLORS.map((color) => React.createElement('button', {
                  key: color.id,
                  className: 'dsh-materials-tagdot',
                  style: { background: color.hex },
                  title: '标记为' + color.label + '色',
                  'aria-label': '标记为' + color.label + '色',
                  onClick: () => { const names = materialTagMenu.names.slice(); setMaterialTagMenu(null); applyMaterialTag(names, color.id); }
                }))
              ),
              React.createElement('div', { className: 'dsh-materials-tagmenu-actions' },
                React.createElement('button', { onClick: () => { const names = materialTagMenu.names.slice(); setMaterialTagMenu(null); applyMaterialTag(names, ''); } }, '清除标记'),
                React.createElement('button', { onClick: () => setMaterialTagMenu(null) }, '取消')
              )
            ) : null
          )
        ) : null,
        materialPreview && materials ? React.createElement('div', { className: 'dsh-materials-preview', role: 'dialog', 'aria-modal': 'true', onClick: () => setMaterialPreview(null) },
          React.createElement('div', { className: 'dsh-materials-preview-card', onClick: (event) => event.stopPropagation() },
            React.createElement('img', { src: '/dsh-canvas/image?path=' + encodeURIComponent(materials.dir + '/' + materialPreview.name), alt: materialPreview.name }),
            React.createElement('div', { className: 'dsh-materials-preview-bar' },
              React.createElement('strong', null, materialPreview.name.replace(/\.[^.]+$/, '')),
              React.createElement('span', { className: 'dsh-materials-preview-info' },
                (materialPreview.width && materialPreview.height ? materialPreview.width + '×' + materialPreview.height + ' · ' : '')
                + Math.max(1, Math.round((materialPreview.size || 0) / 1024)) + ' KB'
                + (materialPreview.mtime ? ' · ' + new Date(materialPreview.mtime).toLocaleString() : '')
              ),
              React.createElement('button', { onClick: () => { sendMaterialToCanvas(materialPreview); setMaterialPreview(null); } }, '加入画布'),
              React.createElement('button', { onClick: () => setMaterialPreview(null) }, '关闭')
            )
          )
        ) : null,
        textRebuild ? React.createElement(TextRebuildPanel, {
          data: textRebuild,
          onClose: () => { if (!textRebuild.busy) setTextRebuild(null); },
          onDetect: detectTextRebuild,
          onSelectionsChange: updateTextRebuildSelections,
          onExport: exportTextRebuild
        }) : null,
        React.createElement('div', { className: 'dsh-canvas-frame-wrap' }, iframe)
      );
    }

    // ---- styles ----
    const CSS = [
      '.dsh-materials-overlay{position:absolute;inset:58px 0 0;z-index:40;display:flex;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1,rgba(8,12,20,.58));backdrop-filter:blur(8px)}.dsh-materials-panel{--ml-bg:var(--dsw-alias-bg-layer-1,#151922);--ml-card:var(--dsw-alias-bg-layer-2,#1d2330);--ml-line:var(--dsw-alias-border-l2,rgba(255,255,255,.11));--ml-muted:var(--dsw-alias-label-tertiary,#97a2b4);--ml-accent:var(--dsw-alias-brand-primary,#76a8ff);display:flex;flex-direction:column;width:min(1120px,100%);height:min(780px,100%);overflow:hidden;border:1px solid var(--ml-line);border-radius:20px;background:var(--ml-bg);color:var(--dsw-alias-label-primary,#f5f7fb);box-shadow:none;font-family:"PingFang SC","Microsoft YaHei",sans-serif}.dsh-materials-head{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 22px 14px}.dsh-materials-title{display:flex;align-items:center;gap:9px;font-size:20px;font-weight:700;letter-spacing:-.02em}.dsh-materials-count{padding:3px 8px;border-radius:999px;background:rgba(118,168,255,.14);color:#a9c7ff;font-size:11px;font-weight:600;letter-spacing:0}.dsh-materials-sub{max-width:720px;margin-top:6px;color:var(--ml-muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-materials-close{width:38px;height:38px;flex:none;border:1px solid var(--ml-line);border-radius:11px;background:rgba(128,128,128,.08);color:var(--dsw-alias-label-secondary,#dbe2ee);font-size:24px;line-height:1;cursor:pointer}.dsh-materials-close:hover{background:rgba(255,255,255,.1)}.dsh-materials-toolbar{display:flex;align-items:center;gap:12px;padding:12px 22px;border-block:1px solid var(--ml-line);background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.025))}.dsh-materials-search{display:flex;align-items:center;gap:8px;min-width:220px;max-width:380px;flex:1;padding:0 12px;border:1px solid var(--ml-line);border-radius:11px;background:var(--dsw-alias-bg-base,rgba(5,8,14,.35));color:var(--ml-muted)}.dsh-materials-search:focus-within{border-color:var(--ml-accent);box-shadow:0 0 0 3px rgba(91,145,255,.14)}.dsh-materials-search input{width:100%;height:38px;border:0;outline:0;background:transparent;color:inherit;font:13px inherit}.dsh-materials-toolbar-actions{display:flex;gap:7px}.dsh-materials-toolbar button,.dsh-materials-selectionbar button{padding:9px 12px;border:1px solid var(--ml-line);border-radius:10px;background:var(--ml-card);color:var(--dsw-alias-label-primary,#dce3ee);font:12px inherit;white-space:nowrap;cursor:pointer}.dsh-materials-toolbar button:hover,.dsh-materials-selectionbar button:hover{background:rgba(255,255,255,.11)}.dsh-materials-toolbar button:disabled,.dsh-materials-selectionbar button:disabled{opacity:.38;cursor:not-allowed}.dsh-materials-error{margin:10px 22px 0;padding:9px 11px;border:1px solid rgba(248,113,113,.3);border-radius:9px;background:rgba(127,29,29,.28);color:#fecaca;font-size:12px}.dsh-materials-body{flex:1;min-height:0;overflow:auto;padding:18px 22px}.dsh-materials-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:14px}.dsh-materials-item{position:relative;display:flex;min-width:0;flex-direction:column;padding:0;overflow:hidden;border:1px solid var(--ml-line);border-radius:13px;background:var(--ml-card);color:inherit;text-align:left;cursor:pointer;transition:transform .14s ease,border-color .14s ease,box-shadow .14s ease}.dsh-materials-item:hover{transform:translateY(-2px);border-color:rgba(118,168,255,.5);box-shadow:0 12px 30px rgba(0,0,0,.22)}.dsh-materials-item.is-selected{border-color:var(--ml-accent);box-shadow:0 0 0 2px rgba(91,145,255,.25)}.dsh-materials-check{position:absolute;z-index:2;top:9px;right:9px;display:grid;width:23px;height:23px;place-items:center;border:1px solid rgba(255,255,255,.4);border-radius:8px;background:rgba(9,14,24,.58);color:white;font-size:13px;backdrop-filter:blur(6px)}.dsh-materials-item.is-selected .dsh-materials-check{border-color:#87b2ff;background:#397cf0}.dsh-materials-thumb{display:block;aspect-ratio:16/10;overflow:hidden;background:var(--dsw-alias-bg-base,#0b0f16)}.dsh-materials-thumb img{display:block;width:100%;height:100%;object-fit:cover;transition:transform .24s ease}.dsh-materials-item:hover img{transform:scale(1.025)}.dsh-materials-meta{display:flex;align-items:center;gap:8px;padding:10px 11px}.dsh-materials-item-name{min-width:0;flex:1;color:var(--dsw-alias-label-primary,#e7ebf2);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-materials-item-info{flex:none;color:var(--ml-muted);font-size:10px}.dsh-materials-empty{display:flex;min-height:240px;align-items:center;justify-content:center;flex-direction:column;gap:8px;border:1px dashed var(--ml-line);border-radius:14px;color:var(--ml-muted);font-size:12px;text-align:center}.dsh-materials-empty strong{color:var(--dsw-alias-label-primary,#dce3ee);font-size:15px}.dsh-materials-selectionbar{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:64px;padding:10px 22px;border-top:1px solid var(--ml-line);background:var(--dsw-alias-bg-layer-1,rgba(8,12,20,.42))}.dsh-materials-selection-summary,.dsh-materials-selection-actions{display:flex;align-items:center;gap:8px}.dsh-materials-selection-summary strong{min-width:66px;font-size:12px}.dsh-materials-selection-summary button{padding:6px 8px;border-color:transparent;background:transparent;color:var(--ml-muted)}.dsh-materials-selection-actions .is-primary{border-color:#4f8fff;background:#3b7bec;color:#fff}.dsh-materials-selection-actions .is-primary:hover{background:#4b89f5}.dsh-materials-selection-actions .is-danger{color:#fca5a5}.dsh-materials-selection-actions .is-danger:hover{border-color:rgba(248,113,113,.4);background:rgba(127,29,29,.32)}@media(max-width:760px){.dsh-materials-overlay{padding:8px}.dsh-materials-panel{height:100%;border-radius:14px}.dsh-materials-toolbar{align-items:stretch;flex-direction:column}.dsh-materials-search{max-width:none}.dsh-materials-toolbar-actions{display:grid;grid-template-columns:1fr 1fr}.dsh-materials-toolbar-actions button:first-child{grid-column:1/-1}.dsh-materials-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.dsh-materials-selectionbar{align-items:stretch;flex-direction:column}.dsh-materials-selection-actions{display:grid;grid-template-columns:1fr 1fr}.dsh-materials-selection-actions .is-primary{grid-column:1/-1}}@media(prefers-color-scheme:light){.dsh-materials-check{border-color:rgba(23,32,51,.25);background:rgba(255,255,255,.82);color:#fff}}',
      '.dsh-materials-overlay{align-items:stretch;justify-content:flex-end;padding:0;background:transparent;backdrop-filter:none;pointer-events:none}.dsh-materials-panel{width:min(390px,calc(100% - 28px));height:100%;max-height:none;border-width:0 0 0 1px;border-radius:18px 0 0 18px;pointer-events:auto;box-shadow:none;animation:dsh-materials-slide-in .2s cubic-bezier(.22,.8,.3,1)}@keyframes dsh-materials-slide-in{from{transform:translateX(28px);opacity:.3}to{transform:translateX(0);opacity:1}}.dsh-materials-head{padding:16px 16px 10px}.dsh-materials-title{font-size:18px}.dsh-materials-sub{max-width:290px}.dsh-materials-dropzone{display:flex;flex-direction:column;gap:2px;margin:0 16px 10px;padding:11px 12px;border:1px dashed var(--ml-line);border-radius:11px;background:rgba(118,168,255,.045);color:var(--ml-muted);font-size:10px;transition:.15s ease}.dsh-materials-dropzone strong{color:var(--dsw-alias-label-primary,#dce3ee);font-size:12px}.dsh-materials-panel.is-drop-active .dsh-materials-dropzone{border-color:var(--ml-accent);background:rgba(59,124,236,.18);box-shadow:0 0 0 3px rgba(59,124,236,.12)}.dsh-materials-toolbar{gap:8px;padding:9px 16px}.dsh-materials-search{min-width:0;max-width:none}.dsh-materials-toolbar-actions{gap:5px}.dsh-materials-toolbar-actions button{min-width:36px;padding:9px}.dsh-materials-toolbar-actions button:first-child{min-width:48px}.dsh-materials-toolbar-actions button.is-active{border-color:var(--ml-accent);background:rgba(59,124,236,.2);color:#bcd4ff}.dsh-materials-body{padding:12px 14px}.dsh-materials-grid{display:block;columns:2 150px;column-gap:10px}.dsh-materials-item{display:inline-flex;width:100%;margin:0 0 10px;break-inside:avoid;border-radius:11px;vertical-align:top}.dsh-materials-thumb{aspect-ratio:auto;min-height:90px}.dsh-materials-thumb img{height:auto;min-height:90px;max-height:230px;object-fit:cover}.dsh-materials-meta{padding:8px 9px}.dsh-materials-item-info{display:none}.dsh-materials-zoom{position:absolute;z-index:3;top:8px;right:8px;display:grid;width:27px;height:27px;padding:0;place-items:center;border:1px solid rgba(255,255,255,.32);border-radius:8px;background:rgba(9,14,24,.68);color:#fff;font:15px/1 inherit;cursor:pointer;backdrop-filter:blur(6px);opacity:.82}.dsh-materials-zoom:hover{opacity:1;background:#397cf0}.dsh-materials-selectionbar{min-height:58px;padding:8px 14px;gap:8px}.dsh-materials-selection-summary strong{min-width:auto}.dsh-materials-selection-actions{gap:5px}.dsh-materials-selection-actions button{padding:8px 9px}.dsh-materials-preview{position:absolute;inset:58px 0 0;z-index:48;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(5,8,14,.82);backdrop-filter:blur(10px)}.dsh-materials-preview-card{display:flex;max-width:min(1000px,92%);max-height:92%;flex-direction:column;overflow:hidden;border:1px solid var(--ml-line);border-radius:16px;background:var(--ml-card,#121722);box-shadow:var(--dsw-alias-bg-mask-drop,0 18px 48px rgba(0,0,0,.35))}.dsh-materials-preview-card>img{display:block;max-width:100%;max-height:calc(90vh - 130px);object-fit:contain;background:var(--dsw-alias-bg-base,#090d14)}.dsh-materials-preview-bar{display:flex;align-items:center;gap:8px;padding:10px 12px}.dsh-materials-preview-bar strong{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-materials-preview-bar button{padding:7px 10px;border:1px solid var(--ml-line);border-radius:8px;background:var(--ml-card);color:var(--dsw-alias-label-primary,#f2f5fa);cursor:pointer}@media(max-width:620px){.dsh-materials-panel{width:min(350px,calc(100% - 12px))}.dsh-materials-grid{columns:2 120px}.dsh-materials-selectionbar{align-items:stretch}.dsh-materials-selection-actions{display:grid;grid-template-columns:1fr 1fr 1fr}.dsh-materials-selection-actions .is-primary{grid-column:auto}}@media(prefers-color-scheme:light){.dsh-materials-zoom{border-color:rgba(255,255,255,.75);background:rgba(24,34,52,.68)}}',
      '.dsh-materials-location{display:flex;align-items:center;gap:8px;margin:0 16px 8px;padding:9px 10px;border:1px solid var(--ml-line);border-radius:11px;background:rgba(255,255,255,.035)}.dsh-materials-location-current{display:flex;min-width:0;flex:1;align-items:center;gap:8px}.dsh-materials-location-icon{display:grid;width:27px;height:27px;flex:none;place-items:center;border-radius:8px;background:rgba(118,168,255,.14);color:var(--ml-accent)}.dsh-materials-location-current>span:last-child{display:flex;min-width:0;flex-direction:column}.dsh-materials-location-current strong,.dsh-materials-location-current small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dsh-materials-location-current strong{font-size:12px}.dsh-materials-location-current small{max-width:205px;color:var(--ml-muted);font-size:9px}.dsh-materials-location>button{flex:none;padding:7px 8px;border:1px solid var(--ml-line);border-radius:8px;background:rgba(255,255,255,.055);color:inherit;font:10px inherit;cursor:pointer}.dsh-materials-recent{display:flex;align-items:center;gap:8px;margin:0 16px 9px;color:var(--ml-muted);font-size:10px}.dsh-materials-recent>span{flex:none}.dsh-materials-recent select{min-width:0;flex:1;height:30px;padding:0 26px 0 8px;border:1px solid var(--ml-line);border-radius:8px;background:var(--ml-card);color:inherit;font:10px inherit;outline:none}.dsh-materials-recent select:focus{border-color:var(--ml-accent)}@media(prefers-color-scheme:light){.dsh-materials-location{background:#f4f7fb}.dsh-materials-location>button{background:#fff;color:#354156}}',
      '.dsh-materials-head{padding-bottom:8px}.dsh-materials-location{padding:7px 8px;margin-bottom:8px}.dsh-materials-location-current small{display:none}.dsh-materials-location.is-expanded .dsh-materials-location-current small{display:block}.dsh-materials-location>button{padding:6px 8px}.dsh-materials-location>button.dsh-materials-location-toggle{width:28px;padding:6px 0;font-size:13px}.dsh-materials-extra{overflow:hidden;animation:dsh-materials-extra-in .15s ease}@keyframes dsh-materials-extra-in{from{max-height:0;opacity:0}to{max-height:120px;opacity:1}}.dsh-materials-extra .dsh-materials-dropzone{margin-bottom:8px}.dsh-materials-panel.is-drop-active .dsh-materials-location{border-color:var(--ml-accent)}',
      '.dsh-materials-organize{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 16px 4px}.dsh-materials-panel{position:relative}.dsh-arrange-pop{position:absolute;top:calc(100% + 8px);right:0;z-index:80;display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid rgba(128,128,128,.35);border-radius:12px;background:var(--dsw-alias-bg-layer-3,rgba(18,22,30,.97));box-shadow:var(--dsw-alias-bg-mask-drop,0 16px 44px rgba(0,0,0,.35));backdrop-filter:blur(12px);white-space:nowrap}.dsh-arrange-field{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#9aa5b5)}.dsh-arrange-field select{height:28px;padding:0 4px 0 6px;border:1px solid rgba(128,128,128,.35);border-radius:8px;background:var(--ml-card);color:var(--dsw-alias-label-primary,#e6ebf3);font:12px inherit;outline:none}.dsh-arrange-field select:focus{border-color:#76a8ff}.dsh-arrange-pop button{padding:6px 12px;border:1px solid var(--ml-line);border-radius:8px;background:var(--ml-card);color:var(--dsw-alias-label-primary,#e6ebf3);font:12px inherit;cursor:pointer}.dsh-arrange-pop .dsh-arrange-run{border-color:#3b7bec;background:#3b7bec;color:#fff}.dsh-arrange-pop .dsh-arrange-run:hover{background:#4b89f5}.dsh-arrange-pop button:hover{background:rgba(255,255,255,.12)}.dsh-materials-sort{display:flex;align-items:center;gap:6px;min-width:0;color:var(--ml-muted);font-size:10px}.dsh-materials-sort>span{flex:none}.dsh-materials-sort select{min-width:0;height:28px;padding:0 4px 0 6px;border:1px solid var(--ml-line);border-radius:8px;background:var(--ml-card);color:inherit;font:10px inherit;outline:none}.dsh-materials-sort select:focus{border-color:var(--ml-accent)}.dsh-materials-tagfilter{display:flex;align-items:center;gap:5px;min-width:0}.dsh-materials-tagfilter-label{flex:none;color:var(--ml-muted);font-size:10px}.dsh-materials-tagall{flex:none;padding:3px 8px;border:1px solid var(--ml-line);border-radius:999px;background:transparent;color:var(--ml-muted);font:10px inherit;cursor:pointer}.dsh-materials-tagall.is-active,.dsh-materials-tagall:hover{border-color:var(--ml-accent);color:#bcd4ff}.dsh-materials-tagdot{width:16px;height:16px;flex:none;padding:0;border:2px solid rgba(255,255,255,.28);border-radius:50%;cursor:pointer;transition:transform .12s ease,box-shadow .12s ease}.dsh-materials-tagdot:hover{transform:scale(1.15)}.dsh-materials-tagdot.is-active{border-color:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.35);transform:scale(1.12)}.dsh-materials-tagfilter-count{flex:none;margin-left:2px;color:var(--ml-muted);font-size:9px;white-space:nowrap}.dsh-materials-tagset{position:absolute;z-index:3;top:8px;left:8px;display:grid;width:22px;height:22px;padding:0;place-items:center;border:1px solid rgba(255,255,255,.32);border-radius:50%;background:rgba(9,14,24,.5);color:#fff;font:11px/1 inherit;cursor:pointer;backdrop-filter:blur(6px);opacity:.75}.dsh-materials-tagset:hover{opacity:1;transform:scale(1.1)}.dsh-materials-tagset.is-set{width:15px;height:15px;border:2px solid rgba(255,255,255,.65);opacity:1;box-shadow:0 0 0 2px rgba(0,0,0,.25)}.dsh-materials-item.is-tagged{border-color:rgba(255,255,255,.22)}.dsh-materials-item-info{display:block;flex:none;color:var(--ml-muted);font-size:9px;white-space:nowrap}.dsh-materials-tagmenu{position:absolute;z-index:60;bottom:74px;left:50%;transform:translateX(-50%);display:flex;flex-direction:column;gap:9px;box-sizing:border-box;width:max-content;padding:12px 14px;border:1px solid var(--ml-line);border-radius:14px;background:var(--dsw-alias-bg-layer-3,#161c29);box-shadow:var(--dsw-alias-bg-mask-drop,0 18px 50px rgba(0,0,0,.45))}.dsh-materials-tagmenu-title{color:var(--ml-muted);font-size:10px;text-align:center}.dsh-materials-tagmenu-row{display:flex;gap:8px}.dsh-materials-tagmenu-row .dsh-materials-tagdot{width:22px;height:22px}.dsh-materials-tagmenu-actions{display:flex;gap:6px}.dsh-materials-tagmenu-actions button{flex:1;padding:6px 8px;border:1px solid var(--ml-line);border-radius:8px;background:var(--ml-card);color:var(--dsw-alias-label-primary,#dce3ee);font:10px inherit;cursor:pointer}.dsh-materials-tagmenu-actions button:hover{background:rgba(255,255,255,.12)}.dsh-materials-preview-info{flex:none;color:var(--ml-muted);font-size:10px;white-space:nowrap}@media(prefers-color-scheme:light){.dsh-materials-tagdot{border-color:rgba(23,32,51,.25)}.dsh-materials-tagdot.is-active{border-color:#172033;box-shadow:0 0 0 3px rgba(55,124,240,.3)}.dsh-materials-tagall,.dsh-materials-tagall.is-active,.dsh-materials-tagall:hover{color:var(--dsw-alias-brand-primary,#397cf0)}.dsh-materials-tagset{border-color:rgba(23,32,51,.35);color:#fff}}',
      '.dsh-canvas-dock{display:flex;align-items:center;box-sizing:border-box;width:calc(100% - 32px);max-width:768px;margin:0 auto;padding:2px 0}',
      '.dsh-canvas-attach-state{margin-left:8px;font-size:12px;color:var(--dsw-alias-label-secondary, #666)}',
      '.dsh-canvas-mode{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;line-height:1;padding:5px 12px;border-radius:999px;border:1px solid rgba(128,128,128,.4);background:transparent;color:var(--dsw-alias-label-primary, #333);cursor:pointer}',
      '.dsh-canvas-mode:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))}',
      '.dsh-canvas-mode-dot{width:8px;height:8px;border-radius:50%;background:#bbb;flex:none}',
      '.dsh-canvas-mode-on{border-color:#3b82f6;background:rgba(59,130,246,.12);color:#1d4ed8}',
      '.dsh-canvas-mode-on .dsh-canvas-mode-dot{background:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.25)}',
      '.dsh-canvas-mode-state{font-size:11px;opacity:.7}',
      '.dsh-canvas-images{display:grid;gap:10px;margin:8px 0 2px;max-width:900px}',
      '.dsh-canvas-images-cols-1{grid-template-columns:minmax(0,560px)}',
      '.dsh-canvas-images-cols-2{grid-template-columns:repeat(2,minmax(0,1fr))}',
      '.dsh-canvas-images-cols-3{grid-template-columns:repeat(3,minmax(0,1fr))}',
      '.dsh-canvas-tool-output{margin:12px 0 4px;max-width:900px}',
      '.dsh-canvas-tool-bar{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}',
      '.dsh-canvas-tool-title{font-size:13px;font-weight:600;white-space:nowrap}',
      '.dsh-canvas-tool-count{font-size:12px;color:var(--dsw-alias-label-tertiary, #888);margin-right:auto;white-space:nowrap}',
      '.dsh-canvas-tool-btn{font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid rgba(128,128,128,.35);background:transparent;color:var(--dsw-alias-label-primary, #333);cursor:pointer;white-space:nowrap}',
      '.dsh-canvas-tool-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1))}',
      '.dsh-canvas-image{display:flex;flex-direction:column;gap:6px;min-width:0}',
      '.dsh-canvas-image-box{display:flex;align-items:center;justify-content:center;aspect-ratio:4/3;background:rgba(15,23,42,.045);border:1px solid var(--dsw-alias-border-l3,rgba(128,128,128,.22));border-radius:12px;overflow:hidden}',
      '.dsh-canvas-image-send{cursor:pointer;border:none;background:transparent;padding:0;width:100%}',
      '.dsh-canvas-image-send:hover{background:rgba(59,130,246,.06);border-color:rgba(59,130,246,.55)}',
      '.dsh-canvas-image-img{width:100%;height:100%;object-fit:contain;display:block}',
      '.dsh-canvas-image-loading{color:var(--dsw-alias-label-tertiary, #999);font-size:12px}',
      '.dsh-canvas-image-meta{display:flex;align-items:center;justify-content:space-between;gap:6px}',
      '.dsh-canvas-image-name{font-size:12px;color:var(--dsw-alias-label-secondary, #666);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.dsh-canvas-image-actions{display:flex;align-items:center;justify-content:flex-end;gap:6px;flex:none}',
      '.dsh-canvas-add-btn{font:inherit;font-size:12px;padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3, rgba(128,128,128,.35));background:transparent;color:var(--dsw-alias-label-primary, #333);cursor:pointer;flex:none}',
      '.dsh-canvas-add-btn:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))}',
      '.dsh-canvas-lightbox{position:fixed;inset:0;z-index:2200;display:flex;align-items:center;justify-content:center;padding:32px;background:rgba(8,12,20,.82);backdrop-filter:blur(10px)}',
      '.dsh-canvas-lightbox-inner{display:flex;max-width:min(94vw,1280px);max-height:92vh;flex-direction:column;overflow:hidden;border-radius:16px;background:#111827;box-shadow:0 24px 80px rgba(0,0,0,.45)}',
      '.dsh-canvas-lightbox-image{display:block;max-width:92vw;max-height:82vh;object-fit:contain;background:#0b0f17}',
      '.dsh-canvas-lightbox-bar{display:flex;align-items:center;gap:8px;padding:10px 12px;color:#f3f4f6}',
      '.dsh-canvas-lightbox-bar span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}',
      '.dsh-canvas-lightbox-bar button{border:1px solid #4b5563;border-radius:7px;background:#1f2937;color:#f9fafb;padding:5px 10px;cursor:pointer}',
      '@media(max-width:720px){.dsh-canvas-images-cols-2,.dsh-canvas-images-cols-3{grid-template-columns:1fr}.dsh-canvas-lightbox{padding:12px}}',
      '.dsh-text-rebuild-overlay{position:absolute;inset:58px 0 0;z-index:35;display:flex;justify-content:flex-end;padding:14px;box-sizing:border-box;background:rgba(5,8,14,.42);backdrop-filter:blur(3px);container-type:inline-size}',
      '.dsh-text-rebuild-panel{display:flex;flex-direction:column;width:min(900px,calc(100% - 12px));max-height:100%;overflow:hidden;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:#1b1e24;color:#f8fafc;box-shadow:0 22px 60px rgba(0,0,0,.44)}',
      '.dsh-text-rebuild-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.1)}',
      '.dsh-text-rebuild-title{font-size:15px;font-weight:700}.dsh-text-rebuild-subtitle{margin-top:4px;color:#9ca3af;font-size:11px}',
      '.dsh-text-rebuild-close{width:30px;height:30px;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:#252932;color:#e5e7eb;font-size:20px;line-height:1;cursor:pointer}.dsh-text-rebuild-close:disabled{opacity:.4;cursor:wait}',
      '.dsh-text-rebuild-body{display:grid;grid-template-columns:minmax(240px,.9fr) minmax(0,1.1fr);gap:12px;min-height:0;overflow:hidden;padding:12px}',
      '.dsh-text-rebuild-preview{display:flex;align-items:center;justify-content:center;min-height:min(44vh,400px);max-height:min(56vh,520px);overflow:auto;padding:10px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:#0d1015}.dsh-text-rebuild-preview img{display:block;max-width:100%;height:auto;object-fit:contain}',
      '.dsh-text-select-wrap{position:relative;display:inline-block;width:100%;max-width:100%;line-height:0;user-select:none}.dsh-text-select-wrap img{display:block;width:100%;max-width:100%;height:auto;max-height:min(56vh,520px);object-fit:contain;margin:0 auto}.dsh-text-select-overlay{position:absolute;inset:0;cursor:crosshair;touch-action:none}.dsh-text-select-box{position:absolute;border:2px solid #60a5fa;background:rgba(59,130,246,.18);box-shadow:0 0 0 1px rgba(255,255,255,.35);pointer-events:none}.dsh-text-select-hint{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:8px 10px;border-radius:8px;background:rgba(15,23,42,.82);color:#e5e7eb;font-size:12px;white-space:nowrap;pointer-events:none}.dsh-text-select-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:8px}.dsh-text-select-coords{flex:1;min-width:120px;color:#94a3b8;font-size:11px}.dsh-text-select-actions button{padding:5px 8px;border:1px solid rgba(255,255,255,.14);border-radius:7px;background:#252932;color:#e5e7eb;font:11px system-ui,sans-serif;cursor:pointer}.dsh-text-select-actions button:hover:not(:disabled){background:#303640}.dsh-text-select-actions button:disabled{opacity:.45;cursor:not-allowed}.dsh-text-select-empty{margin-top:8px;color:#9ca3af;font-size:11px;line-height:1.4}',
      '.dsh-text-select-zoom{display:block;width:100%;box-sizing:border-box;margin:8px 0 0;padding:7px 9px;border:1px solid rgba(96,165,250,.42);border-radius:7px;background:rgba(37,99,235,.13);color:#bfdbfe;font:11px system-ui,sans-serif;cursor:pointer;white-space:nowrap}.dsh-text-select-zoom:hover{background:rgba(37,99,235,.25)}.dsh-text-zoom-overlay{position:absolute;inset:0;z-index:5;display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box;background:rgba(5,8,14,.78);backdrop-filter:blur(5px)}.dsh-text-zoom-dialog{display:flex;flex-direction:column;width:min(1100px,100%);height:min(92%,860px);overflow:hidden;border:1px solid rgba(255,255,255,.16);border-radius:14px;background:#11151c;box-shadow:0 24px 80px rgba(0,0,0,.55)}.dsh-text-zoom-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.1);color:#e5e7eb;font-size:12px}.dsh-text-zoom-head-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}.dsh-text-zoom-head-main strong{font-size:13px;color:#f8fafc}.dsh-text-zoom-head-main span{color:#9ca3af;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dsh-text-zoom-tools{display:flex;align-items:center;gap:5px;flex:none}.dsh-text-zoom-tools button{min-width:28px;height:28px;padding:0 8px;border:1px solid rgba(255,255,255,.15);border-radius:7px;background:#252932;color:#e5e7eb;font:600 13px/1 system-ui,sans-serif;cursor:pointer}.dsh-text-zoom-tools button:hover{background:#303640}.dsh-text-zoom-value{min-width:42px;text-align:center;color:#d1d5db;font:11px ui-monospace,SFMono-Regular,monospace}.dsh-text-zoom-tools .dsh-text-zoom-fit{font-size:11px}.dsh-text-zoom-tools .dsh-text-zoom-close{font-size:19px;font-weight:400}.dsh-text-zoom-stage{display:flex;align-items:center;justify-content:center;min-height:0;flex:1;overflow:hidden;padding:14px;background:#0b0f16;touch-action:none}.dsh-text-select-wrap-large{width:auto;max-width:none;line-height:0;flex:none;transform-origin:center center;will-change:transform}.dsh-text-select-wrap-large img{display:block;width:auto;max-width:calc(100vw - 96px);max-height:calc(100vh - 250px);object-fit:contain}.dsh-text-zoom-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;border-top:1px solid rgba(255,255,255,.1)}.dsh-text-zoom-actions button{padding:6px 10px;border:1px solid rgba(255,255,255,.15);border-radius:7px;background:#252932;color:#e5e7eb;font:11px system-ui,sans-serif;cursor:pointer}.dsh-text-zoom-actions button:hover:not(:disabled){background:#303640}.dsh-text-zoom-actions button:disabled{opacity:.45;cursor:not-allowed}.dsh-text-zoom-empty{padding:10px 14px;border-top:1px solid rgba(255,255,255,.1);color:#9ca3af;font-size:11px}',
      '.dsh-text-rebuild-info{min-width:0;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px}.dsh-text-rebuild-empty{padding:22px 10px;border:1px dashed rgba(255,255,255,.18);border-radius:10px;color:#9ca3af;font-size:12px;text-align:center}',
      '.dsh-text-rebuild-row{padding:9px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:#22262e}.dsh-text-rebuild-row-top{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0;color:#aab2c0;font-size:10px}.dsh-text-rebuild-row-top input{accent-color:#3b82f6}.dsh-text-rebuild-confidence{color:#86efac}.dsh-text-rebuild-box{margin-left:auto;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#8b95a7;font-family:ui-monospace,SFMono-Regular,monospace}.dsh-text-rebuild-row textarea{box-sizing:border-box;width:100%;min-height:48px;margin-top:6px;resize:vertical;padding:7px 8px;border:1px solid rgba(255,255,255,.12);border-radius:7px;background:#11141a;color:#f8fafc;font:13px/1.45 system-ui,sans-serif;outline:none}.dsh-text-rebuild-row textarea:focus{border-color:#3b82f6}.dsh-text-rebuild-row-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}.dsh-text-rebuild-row-controls label{display:flex;align-items:center;gap:4px;color:#9ca3af;font-size:10px}.dsh-text-rebuild-row-controls input[type=number]{width:54px;padding:4px 5px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:#11141a;color:#e5e7eb;font-size:11px}.dsh-text-rebuild-row-controls input[type=color]{width:26px;height:24px;padding:1px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:#11141a}.dsh-text-rebuild-row-controls select{max-width:108px;min-width:0;padding:4px 5px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:#11141a;color:#e5e7eb;font-size:11px}.dsh-text-rebuild-row-controls button,.dsh-text-rebuild-add{margin-left:auto;padding:4px 8px;border:1px solid rgba(255,255,255,.12);border-radius:6px;background:#2a303a;color:#d1d5db;font:11px system-ui,sans-serif;cursor:pointer}.dsh-text-rebuild-row-controls button:hover,.dsh-text-rebuild-add:hover{background:#374151;color:#fff}.dsh-text-rebuild-add{margin:0 0 2px;align-self:flex-start}.dsh-text-rebuild-foot{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding:12px 14px;border-top:1px solid rgba(255,255,255,.1)}.dsh-text-rebuild-note{flex:1;min-width:0;color:#9ca3af;font-size:11px;line-height:1.45}.dsh-text-rebuild-actions{display:flex;gap:8px;flex:none}.dsh-text-rebuild-actions button{padding:8px 12px;border-radius:8px;font:650 12px system-ui,sans-serif;cursor:pointer}.dsh-text-rebuild-cancel{border:1px solid rgba(255,255,255,.14);background:#252932;color:#e5e7eb}.dsh-text-rebuild-export{border:1px solid #2563eb;background:#2563eb;color:#fff}.dsh-text-rebuild-export:hover{background:#3b82f6}.dsh-text-rebuild-actions button:disabled{opacity:.45;cursor:not-allowed}',
      '@container (max-width:820px){.dsh-text-rebuild-body{grid-template-columns:1fr;overflow:auto}.dsh-text-rebuild-preview{min-height:150px;max-height:min(36vh,300px)}.dsh-text-rebuild-info{min-height:240px}.dsh-text-rebuild-foot{align-items:stretch;flex-direction:column}.dsh-text-rebuild-actions{justify-content:flex-end}}',
      '@media(max-width:760px){.dsh-text-rebuild-overlay{inset:58px 0 0;padding:8px}.dsh-text-rebuild-body{grid-template-columns:1fr;overflow:auto}.dsh-text-rebuild-preview{min-height:140px;max-height:260px}.dsh-text-rebuild-info{min-height:220px}.dsh-text-rebuild-foot{align-items:stretch;flex-direction:column}.dsh-text-rebuild-actions{justify-content:flex-end}}',
      '@media (prefers-color-scheme:light){.dsh-text-rebuild-overlay{background:rgba(226,232,240,.52)}.dsh-text-rebuild-panel{border-color:#d1d5db;background:#fff;color:#111827;box-shadow:0 22px 60px rgba(15,23,42,.2)}.dsh-text-rebuild-head,.dsh-text-rebuild-foot{border-color:#e5e7eb}.dsh-text-rebuild-subtitle,.dsh-text-rebuild-note,.dsh-text-rebuild-empty,.dsh-text-rebuild-row-top,.dsh-text-rebuild-row-controls label{color:#6b7280}.dsh-text-rebuild-close{border-color:#d1d5db;background:#f3f4f6;color:#374151}.dsh-text-rebuild-preview{border-color:#e5e7eb;background:#f8fafc}.dsh-text-select-hint{background:rgba(15,23,42,.78);color:#f8fafc}.dsh-text-select-coords,.dsh-text-select-empty{color:#6b7280}.dsh-text-select-actions button{border:1px solid rgba(96,165,250,.45);background:rgba(37,99,235,.15);color:#bfdbfe}.dsh-text-select-actions button:disabled{opacity:.55;cursor:not-allowed}.dsh-text-select-actions button:hover:not(:disabled){background:rgba(37,99,235,.32);color:#eff6ff}.dsh-text-select-actions button:hover:not(:disabled){background:#e5e7eb}.dsh-text-rebuild-row{border-color:#e5e7eb;background:#f8fafc}.dsh-text-rebuild-row textarea,.dsh-text-rebuild-row-controls input[type=number],.dsh-text-rebuild-row-controls input[type=color],.dsh-text-rebuild-row-controls select{border-color:#d1d5db;background:#fff;color:#111827}.dsh-text-rebuild-row-controls button,.dsh-text-rebuild-add{border-color:#d1d5db;background:#f3f4f6;color:#374151}.dsh-text-rebuild-row-controls button:hover,.dsh-text-rebuild-add:hover{background:#e5e7eb;color:#111827}.dsh-text-rebuild-cancel{border-color:#d1d5db;background:#fff;color:#374151}}',
      '@media (prefers-color-scheme:light){.dsh-text-select-zoom{border-color:#93c5fd;background:#eff6ff;color:#1d4ed8}.dsh-text-zoom-overlay{background:rgba(226,232,240,.78)}.dsh-text-zoom-dialog{border-color:#d1d5db;background:#fff;box-shadow:0 24px 80px rgba(15,23,42,.25)}.dsh-text-zoom-head{border-color:#e5e7eb;color:#111827}.dsh-text-zoom-head button,.dsh-text-zoom-actions button{border-color:#d1d5db;background:#f3f4f6;color:#374151}.dsh-text-zoom-stage{background:#f8fafc}.dsh-text-zoom-actions{border-color:#e5e7eb}.dsh-text-zoom-empty{border-color:#e5e7eb;color:#6b7280}}',
      '.dsh-canvas-overlay{position:fixed;top:0;right:0;bottom:0;z-index:1000;display:flex;flex-direction:column;container-type:inline-size;background:var(--dsw-alias-bg-base,#15171c);border-left:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));color:var(--dsw-alias-label-primary,#e5e7eb);pointer-events:auto}',
      '.dsh-canvas-overlay-hidden{display:none!important}',
      /* Windows 自绘标题栏避让:下移画布,高度取应用自己的标题栏变量(继承自 frame 层) */
      /* Windows 标题栏避让:精确值由客户端实测写内联 style.top(1.9.2 纯 CSS var 方案 Win 实机未生效) */
      '.dsh-canvas-overlay-below-titlebar{top:40px}',
      '.dsh-canvas-resizer{position:absolute;left:-3px;top:0;bottom:0;width:8px;cursor:col-resize;z-index:5;touch-action:none}',
      '.dsh-canvas-resizer:hover,.dsh-canvas-resizer:active{background:rgba(0,120,255,.25)}',
      '.dsh-canvas-toolbar{position:relative;display:flex;align-items:center;align-content:center;gap:7px 8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.09));background:var(--dsw-alias-bg-layer-1,#1b1e24);color:var(--dsw-alias-label-primary,#e5e7eb);flex:none;overflow:visible}',
      '.dsh-canvas-title{font-weight:650;font-size:14px;white-space:nowrap;color:var(--dsw-alias-label-primary,#f8fafc)}',
      '.dsh-canvas-project{display:inline-flex;align-items:center;gap:5px;font:600 11px ui-rounded,"SF Pro Rounded",sans-serif;padding:4px 8px;border:1px solid rgba(96,165,250,.18);border-radius:7px;background:rgba(37,99,235,.16);color:#93c5fd;max-width:180px;white-space:nowrap;cursor:pointer}',
      '.dsh-canvas-project:hover{background:rgba(37,99,235,.27);color:#bfdbfe}',
      '.dsh-canvas-project-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-canvas-project-chevron{font-size:10px;opacity:.72;flex:none}',
      '.dsh-canvas-status{font-size:11px;padding:2px 8px;border-radius:999px;white-space:nowrap}',
      '.dsh-canvas-status-ready{background:#e6f6e6;color:#1a7f1a}',
      '.dsh-canvas-status-loading{background:#fff4e0;color:#b26a00}',
      '.dsh-canvas-status-error{background:#fde8e8;color:#b00}',
      '.dsh-canvas-operation-progress{display:inline-flex;align-items:center;gap:6px;min-width:112px;max-width:170px;flex:none;color:#cbd5e1;font-size:11px;white-space:nowrap}',
      '.dsh-canvas-operation-progress-track{position:relative;width:76px;height:5px;overflow:hidden;border-radius:99px;background:rgba(148,163,184,.24)}',
      '.dsh-canvas-operation-progress-fill{display:block;height:100%;border-radius:inherit;background:#60a5fa;transition:width .25s ease}',
      '.dsh-canvas-operation-progress-fill.is-indeterminate{width:38%;animation:dsh-canvas-progress 1.2s ease-in-out infinite}',
      '@keyframes dsh-canvas-progress{0%{transform:translateX(-140%)}100%{transform:translateX(300%)}}',
      '.dsh-canvas-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#8b95a7);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-canvas-feedback{font-size:12px;color:var(--dsw-alias-state-success-primary,#86efac);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-canvas-tb{font:inherit;font-size:13px;padding:5px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.13));background:var(--dsw-alias-bg-layer-2,#252932);color:var(--dsw-alias-label-primary,#e5e7eb);cursor:pointer;white-space:nowrap}',
      '.dsh-canvas-tb:hover{background:var(--dsw-alias-interactive-bg-hover,#303640);border-color:var(--dsw-alias-border-l3,rgba(255,255,255,.2));color:var(--dsw-alias-label-primary,#fff)}',
      '.dsh-canvas-tb-close{font-weight:600}',
      '.dsh-canvas-more-menu{position:absolute;z-index:24;right:68px;top:calc(100% - 2px);width:190px;padding:6px;border:1px solid rgba(255,255,255,.12);border-radius:10px;background:#1d2027;box-shadow:0 16px 38px rgba(0,0,0,.4);display:flex;flex-direction:column;gap:3px}',
      '.dsh-canvas-more-menu button{font:inherit;font-size:12px;text-align:left;padding:8px 10px;border:0;border-radius:7px;background:transparent;color:#e5e7eb;cursor:pointer}',
      '.dsh-canvas-more-menu button:hover:not(:disabled){background:#2b3039;color:#fff}',
      '.dsh-canvas-more-menu button:disabled{opacity:.38;cursor:not-allowed}',
      '.dsh-canvas-more-menu .dsh-canvas-more-danger{color:#fca5a5}',
      '.dsh-canvas-engine-dialog{position:absolute;z-index:30;inset:58px 0 0;display:flex;align-items:flex-start;justify-content:center;padding:18px;box-sizing:border-box;background:rgba(5,8,14,.42);backdrop-filter:blur(3px)}',
      '.dsh-canvas-engine-card{display:flex;flex-direction:column;gap:12px;width:min(620px,100%);max-height:calc(100vh - 110px);overflow:auto;box-sizing:border-box;padding:16px;border:1px solid rgba(255,255,255,.14);border-radius:14px;background:#1d2027;color:#e5e7eb;box-shadow:0 20px 56px rgba(0,0,0,.46)}',
      '.dsh-canvas-engine-loading{padding:22px 8px;text-align:center;color:#9ca3af;font-size:12px}',
      '.dsh-canvas-engine-options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}',
      '.dsh-canvas-engine-option{display:flex;align-items:flex-start;gap:8px;padding:10px;border:1px solid rgba(255,255,255,.12);border-radius:9px;background:#252932;cursor:pointer}',
      '.dsh-canvas-engine-option:has(input:checked){border-color:#3b82f6;background:rgba(37,99,235,.16);box-shadow:0 0 0 1px rgba(59,130,246,.22)}',
      '.dsh-canvas-engine-option input{margin-top:2px;accent-color:#3b82f6}',
      '.dsh-canvas-engine-option span{display:flex;min-width:0;flex-direction:column;gap:4px}.dsh-canvas-engine-option strong{display:flex;align-items:center;gap:6px;font-size:12px}.dsh-canvas-engine-option small{color:#9ca3af;font-size:10px;line-height:1.4}',
      '.dsh-canvas-engine-badge{display:inline-flex;padding:2px 6px;border-radius:99px;background:rgba(245,158,11,.14);color:#fbbf24;font:normal 9px/1.4 system-ui,sans-serif}.dsh-canvas-engine-badge.is-ready{background:rgba(34,197,94,.14);color:#86efac}',
      '.dsh-canvas-engine-setup{display:flex;flex-direction:column;gap:10px;padding:11px;border:1px solid rgba(255,255,255,.1);border-radius:10px;background:#171a20}',
      '.dsh-canvas-engine-steps{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.dsh-canvas-engine-steps>div{display:flex;align-items:flex-start;gap:7px;padding:8px;border-radius:8px;background:#22262e;color:#cbd5e1}.dsh-canvas-engine-steps b{display:grid;place-items:center;width:20px;height:20px;flex:none;border-radius:50%;background:#374151;color:#d1d5db;font-size:10px}.dsh-canvas-engine-steps .is-done b{background:#166534;color:#bbf7d0}.dsh-canvas-engine-steps span{display:flex;min-width:0;flex-direction:column;gap:2px;font-size:11px;font-weight:650}.dsh-canvas-engine-steps small{color:#8b95a7;font-size:9px;line-height:1.35;font-weight:400}',
      '.dsh-canvas-engine-inline-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.dsh-canvas-engine-inline-actions .dsh-canvas-tb:last-child{margin-left:auto}',
      '.dsh-canvas-engine-api-grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.dsh-canvas-engine-key{grid-column:1/-1}',
      '.dsh-canvas-engine-field{display:flex;align-items:center;gap:9px;color:#aab2c0;font-size:11px}.dsh-canvas-engine-field>span{display:flex;width:105px;flex:none;flex-direction:column;gap:2px;font-weight:650}.dsh-canvas-engine-field small{color:#7f8999;font-size:9px;line-height:1.3;font-weight:400}.dsh-canvas-engine-field input{flex:1;min-width:0;box-sizing:border-box;padding:8px 9px;border:1px solid rgba(255,255,255,.14);border-radius:7px;background:#11141a;color:#f8fafc;font:12px system-ui,sans-serif;outline:none}.dsh-canvas-engine-field input:focus{border-color:#3b82f6}',
      '.dsh-canvas-engine-note{color:#9ca3af;font-size:10px;line-height:1.45}.dsh-canvas-engine-error,.dsh-canvas-engine-notice{padding:8px 10px;border-radius:7px;font-size:11px;line-height:1.4}.dsh-canvas-engine-error{background:rgba(239,68,68,.12);color:#fca5a5}.dsh-canvas-engine-notice{background:rgba(34,197,94,.1);color:#86efac}',
      '.dsh-canvas-project-dialog{position:absolute;z-index:20;top:58px;left:50%;transform:translateX(-50%);width:min(580px,calc(100% - 40px));max-height:calc(100% - 84px);overflow:auto;box-sizing:border-box;padding:16px;border:1px solid var(--dsw-alias-border-l2,rgba(15,23,42,.14));border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111827);box-shadow:0 18px 48px rgba(15,23,42,.2);display:flex;flex-direction:column;gap:11px}',
      '.dsh-canvas-project-dialog-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
      '.dsh-canvas-project-dialog-title{font-size:14px;font-weight:650;color:var(--dsw-alias-label-primary,#111827)}',
      '.dsh-canvas-project-subtitle{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);margin-top:-4px}',
      '.dsh-canvas-project-dialog-heading .dsh-canvas-project-subtitle{margin-top:3px}',
      '.dsh-canvas-project-dialog-close{width:28px;height:28px;padding:0;border:1px solid rgba(255,255,255,.12);border-radius:8px;background:#252932;color:#cbd5e1;font-size:20px;line-height:1;cursor:pointer}',
      '.dsh-canvas-project-dialog-close:hover{background:#303640;color:#fff}',
      '.dsh-canvas-project-current{display:flex;align-items:center;gap:10px;padding:11px 12px;border:1px solid rgba(96,165,250,.25);border-radius:11px;background:rgba(37,99,235,.11)}',
      '.dsh-canvas-project-current-empty{justify-content:center;border-style:dashed;background:transparent;color:#9ca3af;font-size:12px}',
      '.dsh-canvas-project-current-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:rgba(59,130,246,.2);color:#93c5fd;font-size:18px;flex:none}',
      '.dsh-canvas-project-current-main{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}',
      '.dsh-canvas-project-current-main small{font-size:10px;color:#86efac}',
      '.dsh-canvas-project-current-main strong{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-canvas-project-current-main code{font:10px ui-monospace,SFMono-Regular,monospace;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-canvas-project-section-title{font-size:11px;font-weight:650;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,#6b7280);text-transform:uppercase}',
      '.dsh-canvas-project-input{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:#11141a;color:#f8fafc;font:13px system-ui,sans-serif;outline:none}',
      '.dsh-canvas-project-input:focus{border-color:#3b82f6;box-shadow:0 0 0 2px rgba(59,130,246,.18)}',
      '.dsh-canvas-project-actions{display:flex;justify-content:flex-end;gap:8px}',
      '.dsh-canvas-project-confirm{background:#3b82f6;color:#fff;border-color:#3b82f6}',
      '.dsh-canvas-project-confirm:hover{background:#2563eb}',
      '.dsh-canvas-project-list{display:flex;flex-direction:column;gap:7px;max-height:360px;overflow:auto;padding:2px}',
      '.dsh-canvas-project-empty{padding:28px 14px;border:1px dashed #d1d5db;border-radius:10px;text-align:center;color:#6b7280;font-size:12px}',
      '.dsh-canvas-project-error{color:#b91c1c;background:#fef2f2}',
      '.dsh-canvas-project-card,.dsh-canvas-folder-card{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f2937);text-align:left;display:flex;align-items:center;gap:8px;padding:5px 7px;transition:border-color .12s,background .12s}',
      '.dsh-canvas-project-card:hover,.dsh-canvas-folder-card:hover{border-color:var(--dsw-alias-accent,#3b82f6);background:var(--dsw-alias-bg-layer-2,rgba(59,130,246,.06))}',
      '.dsh-canvas-project-card-current{border-color:#3b82f6;background:rgba(37,99,235,.16);box-shadow:0 0 0 1px rgba(59,130,246,.24)}',
      '.dsh-canvas-project-card-open{display:flex;align-items:center;gap:10px;flex:1;min-width:0;padding:5px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;cursor:pointer}',
      '.dsh-canvas-project-card-open:hover{background:rgba(255,255,255,.045)}',
      '.dsh-canvas-project-card-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:#e0e7ff;color:#4338ca;font-size:18px;flex:none}',
      '.dsh-canvas-project-card-main{display:flex;flex:1;min-width:0;flex-direction:column;gap:2px}',
      '.dsh-canvas-project-card-main strong{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-canvas-project-card-main small,.dsh-canvas-project-card-open time{font-size:11px;color:#9ca3af;font-weight:400}',
      '.dsh-canvas-project-card-actions{display:flex;align-items:center;gap:3px;flex:none}',
      '.dsh-canvas-project-card-actions button{padding:5px 7px;border:0;border-radius:6px;background:transparent;color:#aab2c0;font:11px system-ui,sans-serif;cursor:pointer}',
      '.dsh-canvas-project-card-actions button:hover{background:rgba(255,255,255,.08);color:#fff}',
      '.dsh-canvas-project-card-actions .dsh-canvas-project-card-delete:hover{background:rgba(239,68,68,.12);color:#fca5a5}',
      '.dsh-canvas-folder-card span:nth-child(2){flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-canvas-browser-path{padding:7px 9px;border-radius:7px;background:#11141a;color:#aab2c0;font:11px ui-monospace,SFMono-Regular,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-canvas-frame-wrap{flex:1;min-height:0;position:relative}',
      '.dsh-canvas-frame{position:absolute;top:0;left:0;right:0;bottom:0;width:100%;height:100%;border:none;display:block}'
      ,'@media (prefers-color-scheme:light){.dsh-canvas-overlay{color-scheme:light}.dsh-canvas-project{background:#eef2ff;border-color:#dbeafe;color:#4338ca}.dsh-canvas-project:hover{background:#e0e7ff;color:#3730a3}.dsh-canvas-more-menu{background:#fff;border-color:rgba(15,23,42,.14);box-shadow:0 16px 38px rgba(15,23,42,.18)}.dsh-canvas-more-menu button{color:#1f2937}.dsh-canvas-more-menu button:hover:not(:disabled){background:#f3f4f6;color:#111827}.dsh-canvas-more-menu .dsh-canvas-more-danger{color:#b91c1c}.dsh-canvas-engine-dialog{background:rgba(226,232,240,.52)}.dsh-canvas-engine-card{background:#fff;border-color:rgba(15,23,42,.14);color:#1f2937;box-shadow:0 18px 48px rgba(15,23,42,.2)}.dsh-canvas-engine-option{background:#f8fafc;border-color:#e5e7eb}.dsh-canvas-engine-option:has(input:checked){background:#eff6ff;border-color:#60a5fa}.dsh-canvas-engine-option small,.dsh-canvas-engine-note{color:#6b7280}.dsh-canvas-engine-field{color:#64748b}.dsh-canvas-engine-field input{background:#fff;border-color:#d1d5db;color:#111827}.dsh-canvas-engine-error{background:#fef2f2;color:#b91c1c}.dsh-canvas-project-dialog{background:#fff;border-color:rgba(15,23,42,.14);box-shadow:0 18px 48px rgba(15,23,42,.2)}.dsh-canvas-project-dialog-title{color:#111827}.dsh-canvas-project-subtitle{color:#6b7280}.dsh-canvas-project-dialog-close{background:#fff;border-color:rgba(15,23,42,.14);color:#64748b}.dsh-canvas-project-dialog-close:hover{background:#f3f4f6;color:#111827}.dsh-canvas-project-current{background:#eff6ff;border-color:#bfdbfe}.dsh-canvas-project-current-empty{background:transparent;color:#6b7280}.dsh-canvas-project-current-icon{background:#dbeafe;color:#2563eb}.dsh-canvas-project-current-main small{color:#15803d}.dsh-canvas-project-current-main code{color:#64748b}.dsh-canvas-project-section-title{color:#6b7280}.dsh-canvas-project-input{background:#fff;border-color:rgba(15,23,42,.2);color:#111827}.dsh-canvas-project-card,.dsh-canvas-folder-card{background:#fff;border-color:#e5e7eb;color:#1f2937}.dsh-canvas-project-card:hover,.dsh-canvas-folder-card:hover{background:#f8fbff;border-color:#93c5fd}.dsh-canvas-project-card-current{background:#eff6ff;border-color:#60a5fa;box-shadow:0 0 0 1px #bfdbfe}.dsh-canvas-project-card-open:hover{background:#f3f4f6}.dsh-canvas-project-card-main small,.dsh-canvas-project-card-open time{color:#6b7280}.dsh-canvas-project-card-actions button{color:#64748b}.dsh-canvas-project-card-actions button:hover{background:#f3f4f6;color:#111827}.dsh-canvas-project-card-actions .dsh-canvas-project-card-delete:hover{background:#fef2f2;color:#b91c1c}.dsh-canvas-browser-path{background:#f3f4f6;color:#4b5563}.dsh-canvas-project-empty{border-color:#d1d5db;color:#6b7280}.dsh-canvas-project-error{background:#fef2f2;color:#b91c1c}}'
      ,'@media (prefers-color-scheme:dark){.dsh-canvas-overlay{color-scheme:dark}}'
      ,'@media (prefers-color-scheme:light){.dsh-canvas-engine-badge{background:#fff7ed;color:#c2410c}.dsh-canvas-engine-badge.is-ready{background:#ecfdf5;color:#047857}.dsh-canvas-engine-setup{background:#f8fafc;border-color:#e2e8f0}.dsh-canvas-engine-steps>div{background:#fff;color:#334155;border:1px solid #e5e7eb}.dsh-canvas-engine-steps b{background:#e5e7eb;color:#475569}.dsh-canvas-engine-steps .is-done b{background:#dcfce7;color:#166534}.dsh-canvas-engine-steps small,.dsh-canvas-engine-field small{color:#64748b}.dsh-canvas-engine-notice{background:#ecfdf5;color:#047857}}'
      ,'@media (prefers-color-scheme:light){.dsh-text-rebuild-overlay{background:rgba(241,245,249,.58)}.dsh-text-rebuild-panel{background:#fff;color:#111827;border-color:rgba(15,23,42,.14);box-shadow:0 22px 60px rgba(15,23,42,.2)}.dsh-text-rebuild-head,.dsh-text-rebuild-foot{border-color:rgba(15,23,42,.1)}.dsh-text-rebuild-subtitle,.dsh-text-rebuild-note,.dsh-text-rebuild-empty,.dsh-text-rebuild-row-top,.dsh-text-rebuild-row-controls label{color:#64748b}.dsh-text-rebuild-close{background:#f8fafc;border-color:#e5e7eb;color:#334155}.dsh-text-rebuild-preview{background:#f1f5f9;border-color:#e2e8f0}.dsh-text-rebuild-row{background:#f8fafc;border-color:#e2e8f0}.dsh-text-rebuild-row textarea,.dsh-text-rebuild-row-controls input[type=number],.dsh-text-rebuild-row-controls input[type=color],.dsh-text-rebuild-row-controls select{background:#fff;border-color:#cbd5e1;color:#111827}.dsh-text-rebuild-row-controls button,.dsh-text-rebuild-add{background:#f1f5f9;border-color:#cbd5e1;color:#334155}.dsh-text-rebuild-cancel{background:#fff;border-color:#cbd5e1;color:#334155}}'
      ,'@container (max-width:920px){.dsh-canvas-toolbar{flex-wrap:wrap}.dsh-canvas-hint,.dsh-canvas-feedback{order:20;flex:1 0 calc(100% - 24px);min-height:16px}.dsh-canvas-project{max-width:110px}.dsh-canvas-tb{padding:5px 9px;font-size:12px}}'
      ,'@container (max-width:680px){.dsh-canvas-status{display:none}.dsh-canvas-title{font-size:13px}.dsh-canvas-project{max-width:92px}.dsh-canvas-toolbar{gap:6px;padding:7px 9px}.dsh-canvas-tb{padding:5px 7px;font-size:11px}}'
      ,'/* 聊天生图:生成中占位徽标与自动上画布开关(v1.9) */'
      ,'.dsh-canvas-gen-ask{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:5px 10px;border-radius:9px;background:rgba(10,132,255,.08);border:1px solid rgba(10,132,255,.3);font-size:12px;max-width:100%}'
      ,'.dsh-canvas-gen-ask-text{color:var(--dsw-alias-label-primary,#1f2328)}'
      ,'.dsh-canvas-gen-ask button{padding:3px 9px;border:1px solid rgba(10,132,255,.4);border-radius:6px;background:#fff;color:#0a84ff;font-size:12px;cursor:pointer;white-space:nowrap}'
      ,'.dsh-canvas-gen-ask button:hover{background:rgba(10,132,255,.1)}'
      ,'.dsh-canvas-gen-ask .dsh-canvas-gen-ask-dismiss{border-color:var(--dsw-alias-border-l2,#e2e2e6);color:var(--dsw-alias-label-secondary,#6b7280);background:transparent}'
      ,'.dsh-canvas-project-reason{margin:0 0 10px;padding:9px 12px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-accent,#0a84ff) 10%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-accent,#0a84ff) 35%,transparent);color:var(--dsw-alias-label-primary,#1f2328);font-size:12px;line-height:18px}'
      ,'.dsh-canvas-engine-autoadd{margin:10px 14px 0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2,#e2e2e6);border-radius:10px;background:var(--dsw-alias-bg-layer-1,#fafafa)}'
      ,'.dsh-canvas-engine-autoadd-row{display:flex;align-items:flex-start;gap:9px;cursor:pointer}'
      ,'.dsh-canvas-engine-autoadd-row input{margin-top:3px;flex:0 0 auto}'
      ,'.dsh-canvas-engine-autoadd-row span{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,#1f2328)}'
      ,'.dsh-canvas-engine-autoadd-row small{display:block;margin-top:3px;font-size:11px;line-height:16px;font-weight:400;color:var(--dsw-alias-label-secondary,#6b7280)}'
      ,'/* 聊天输入区生图比例选择(v1.9.2):芯片 + 向上弹出的比例卡片网格 */'
      ,'.dsh-canvas-ratio-wrap{position:relative;display:inline-flex;flex:none}'
      ,'.dsh-canvas-ratio-chip{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;line-height:1;padding:5px 12px;border-radius:999px;border:1px solid rgba(128,128,128,.4);background:transparent;color:var(--dsw-alias-label-primary,#333);cursor:pointer;white-space:nowrap}'
      ,'.dsh-canvas-ratio-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.12))}'
      ,'.dsh-canvas-ratio-chip-set{border-color:rgba(59,130,246,.55);background:rgba(59,130,246,.1);color:#1d4ed8}'
      ,'.dsh-canvas-ratio-chip-caret{font-size:10px;opacity:.6;transform:translateY(1px)}'
      ,'.dsh-canvas-ratio-pop{position:fixed;z-index:9999;width:328px;box-sizing:border-box;padding:12px;border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2,#e2e2e6);box-shadow:0 10px 30px rgba(0,0,0,.16);transform:translateY(calc(-100% - 10px));display:flex;flex-direction:column;gap:8px}'
      ,'.dsh-canvas-ratio-pop-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#6b7280)}'
      ,'.dsh-canvas-ratio-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}'
      ,'.dsh-canvas-ratio-card{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;min-height:66px;padding:8px 2px 7px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:transparent;cursor:pointer;font:inherit}'
      ,'.dsh-canvas-ratio-card:hover{border-color:rgba(59,130,246,.5);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}'
      ,'.dsh-canvas-ratio-card.is-selected{border-color:#3b82f6;background:rgba(59,130,246,.1)}'
      ,'.dsh-canvas-ratio-card-icon{display:block;width:15px;height:15px;border:1.6px solid var(--dsw-alias-label-primary,#4b5563);border-radius:3px;flex:none}'
      ,'.dsh-canvas-ratio-card.is-selected .dsh-canvas-ratio-card-icon{border-color:#1d4ed8}'
      ,'.dsh-canvas-ratio-icon-auto{border-style:dashed;border-color:var(--dsw-alias-label-secondary,#9ca3af)}'
      ,'.dsh-canvas-ratio-card-label{font-size:11.5px;line-height:1;color:var(--dsw-alias-label-primary,#1f2328)}'
      ,'.dsh-canvas-ratio-card.is-selected .dsh-canvas-ratio-card-label{color:#1d4ed8;font-weight:600}'
      ,'.dsh-canvas-ratio-card-px{font-size:10px;line-height:1;color:var(--dsw-alias-label-secondary,#9ca3af)}'
      ,'.dsh-canvas-ratio-auto{display:flex;align-items:center;justify-content:center;gap:6px;padding:6px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2,#d1d5db);background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);cursor:pointer}'
      ,'.dsh-canvas-ratio-auto:hover{border-color:rgba(59,130,246,.55);color:#1d4ed8}'
      ,'.dsh-canvas-ratio-auto.is-selected{border-style:solid;border-color:#3b82f6;color:#1d4ed8;background:rgba(59,130,246,.08)}'
      ,'.dsh-canvas-ratio-count-row{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}'
      ,'.dsh-canvas-ratio-count{padding:6px 0;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,#e5e7eb);background:transparent;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary,#1f2328);cursor:pointer}'
      ,'.dsh-canvas-ratio-count:hover{border-color:rgba(59,130,246,.5);background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}'
      ,'.dsh-canvas-ratio-count.is-selected{border-color:#3b82f6;background:rgba(59,130,246,.1);color:#1d4ed8;font-weight:600}'
      ,'.dsh-canvas-ratio-pop-note{font-size:10.5px;line-height:14px;color:var(--dsw-alias-label-secondary,#9ca3af)}'
    ].join('\n');
    // ---- plugin ----
    function compatibilityLogger(ctx, level, message, error) {
      try {
        const logger = ctx && ctx.logger;
        const fn = logger && (logger[level] || logger.info);
        if (typeof fn === 'function') fn.call(logger, '[canvas-workbench] ' + message + (error ? ': ' + (error.message || String(error)) : ''));
        else if (typeof console !== 'undefined' && console[level]) console[level]('[canvas-workbench] ' + message, error || '');
      } catch (e) {}
    }
    function safeEffect(ctx, label, setup) {
      try {
        if (ctx && typeof ctx.effect === 'function') return ctx.effect(() => {
          try { return setup(); }
          catch (error) { compatibilityLogger(ctx, 'warn', label + ' 已停用', error); return () => {}; }
        });
        const dispose = setup();
        return typeof dispose === 'function' ? dispose : () => {};
      } catch (error) {
        compatibilityLogger(ctx, 'warn', label + ' 注册失败', error);
        return () => {};
      }
    }
    function safeSlot(ctx, name, registration, useEffect) {
      const install = () => {
        if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
          compatibilityLogger(ctx, 'warn', '当前 DSH 不提供插槽 ' + name);
          return () => {};
        }
        const result = ctx.slots.inject(name, () => {
          try { return ctx.slots.register(registration.options, registration.component); }
          catch (error) { compatibilityLogger(ctx, 'warn', '插槽 ' + name + ' 注册失败', error); return () => {}; }
        });
        if (result && typeof result.catch === 'function') result.catch((error) => compatibilityLogger(ctx, 'warn', '插槽 ' + name + ' 注入失败', error));
        return typeof result === 'function' ? result : () => {};
      };
      return useEffect === false ? install() : safeEffect(ctx, '插槽 ' + name, install);
    }
    function apply(ctx) {
      clientRootContext = ctx;
      // DSH 的会话服务和插槽在不同桌面版本中并不完全一致。它们全部是
      // 可选增强能力：缺少某一项时只关闭对应 UI，绝不能阻断 renderer。
      // DSH 2.0.4/rc.7 将浏览器会话附件服务注册为 `conversation`；部分
      // 旧构建曾使用 `uiConversation`。通过 Cordis 的 get/inject 取服务，
      // 不再直接访问未声明属性，保证两个命名都能兼容。
      let conversationEventsApi = null;
      let conversationEventDispose = null;
      const installConfigurationHelper = () => {
        dshConfigurationHelper = (prompt) => {
          const sessions = ctx.sessions || (typeof ctx.get === 'function' ? ctx.get('sessions') : null);
          const conversation = conversationApi || (typeof ctx.get === 'function' ? (ctx.get('conversation') || ctx.get('uiConversation')) : null);
          const sessionId = sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot().current : activeChatSessionId;
          const scope = sessions && typeof sessions.scope === 'function' && sessionId ? sessions.scope(sessionId) : null;
          if (!conversation || !conversation.input || typeof conversation.input.for !== 'function' || !scope) return false;
          const input = conversation.input.for(scope);
          if (!input || typeof input.setDraft !== 'function') return false;
          const snapshot = input.state && typeof input.state.getSnapshot === 'function' ? input.state.getSnapshot() : {};
          const draft = String(snapshot && snapshot.draft || '');
          input.setDraft(draft.trim() ? draft + '\n\n' + prompt : prompt);
          const textarea = document.querySelector('[data-composer-card] textarea');
          if (textarea && typeof textarea.focus === 'function') requestAnimationFrame(() => textarea.focus({ preventScroll: true }));
          return true;
        };
      };
      const installConversationEvents = (api) => {
        if (!api || conversationEventsApi === api || !api.events || typeof api.events.register !== 'function') return false;
        try {
          if (typeof conversationEventDispose === 'function') conversationEventDispose();
          const result = api.events.register(canvasImagesDefinition);
          conversationEventsApi = api;
          conversationEventDispose = typeof result === 'function' ? result : null;
          return true;
        } catch (error) {
          compatibilityLogger(ctx, 'warn', '会话图片事件已停用', error);
          return false;
        }
      };
      try {
        conversationApi = typeof ctx.get === 'function' ? (ctx.get('conversation') || ctx.get('uiConversation') || null) : null;
        installConversationEvents(conversationApi);
        installConfigurationHelper();
      } catch (error) { conversationApi = null; }
      try {
        ctx.inject(['conversation'], (scope) => {
          conversationApi = scope.conversation || conversationApi;
          installConversationEvents(conversationApi);
          installConfigurationHelper();
          return () => { if (conversationApi === scope.conversation) conversationApi = null; };
        });
      } catch (error) { compatibilityLogger(ctx, 'warn', '当前 DSH 暂未提供 conversation 服务', error); }
      try {
        ctx.inject(['uiConversation'], (scope) => {
          conversationApi = scope.uiConversation || conversationApi;
          installConversationEvents(conversationApi);
          installConfigurationHelper();
          return () => { if (conversationApi === scope.uiConversation) conversationApi = null; };
        });
      } catch (error) { /* 新版没有旧别名是正常情况 */ }
      safeEffect(ctx, '会话图片事件清理', () => () => {
        if (typeof conversationEventDispose === 'function') conversationEventDispose();
        conversationEventDispose = null;
        conversationEventsApi = null;
        dshConfigurationHelper = null;
        clientRootContext = null;
      });
      // modelDirectories 在旧 DSH 版本中不存在，因此不声明为插件硬依赖。
      // 通过 Cordis 的延迟 inject 获取：新版可精确跟随聊天模型，
      // 旧版则仅失去该增强能力，画布仍可加载并回退本地 OCR。
      try {
        ctx.inject(['modelDirectories'], (scope) => {
          modelDirectoriesApi = scope.modelDirectories || null;
          window.dispatchEvent(new CustomEvent('dsh-canvas:model-directories-ready'));
          return () => { if (modelDirectoriesApi === scope.modelDirectories) modelDirectoriesApi = null; };
        });
      } catch (error) { compatibilityLogger(ctx, 'warn', '当前 DSH 不提供会话模型目录，文字识别将使用本地兜底', error); }
      const styleTag = document.createElement('style');
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      // ctx.effect 立即执行回调；回调返回清理函数（不执行），卸载时才移除样式
      safeEffect(ctx, '样式清理', () => () => styleTag.remove());

      // 会话服务可能在插件 apply 之后才出现。上面的幂等安装器会在
      // get 或延迟 inject 任一路径就绪时注册，避免重启后旧对话图片卡片消失。
      if (!conversationEventsApi) compatibilityLogger(ctx, 'warn', '会话图片事件正在等待 conversation 服务');

      safeEffect(ctx, '本地图片回退', () => installLocalMarkdownImageFallback());

      // 与 DSH 2.x 官方 deliverables 插件保持同一注册时序。
      // turnTail 是会话回放的结构插槽，不应再包一层 effect，
      // 否则已完成回合可能在插槽注册前已经物化。
      // 结构插槽只依赖 slots，不应被 conversation 服务的启动时序阻断。
      safeSlot(ctx, 'conversation.chat.turnTail', {
        options: {
          name: 'conversation.chat.turnTail',
          // 新版官方桌面的列表插槽要求条目带稳定 id,缺 id 的注册会被静默忽略
          // (对照官方 schedule-created 条目)。数据获取双保险:select(旧版宿主调用)
          // + ImageTail 组件内从 props.turn 自取(新版宿主直接传插槽载荷)。
          id: 'dsh-canvas-image-tail',
          order: 10,
          select: (owner) => {
            try {
              const data = owner && owner.turn && owner.turn.data && typeof owner.turn.data.get === 'function' ? owner.turn.data.get('canvas-images') : null;
              const images = data && Array.isArray(data.images) ? data.images.filter((i) => i.seq <= owner.seq) : [];
              // 不再截取最后 9 张：每轮的全部图片输出都要显示，
              // 网格列数逻辑本身能自适应任意数量。
              return images.length ? images : null;
            } catch (error) { return null; }
          }
        },
        component: ImageTail
      }, false);

      safeSlot(ctx, 'conversation.input.dock', {
        options: { name: 'conversation.input.dock', id: 'dsh-canvas-mode', order: 30, label: 'Design Mode' },
        component: DesignModeToggle
      });

      safeSlot(ctx, 'shell.overlay', {
        options: { name: 'shell.overlay', id: 'dsh-canvas-overlay', order: 0 },
        component: CanvasOverlayBoundary
      });
    }

    exports.apply = apply;
    // conversation 在不同 DSH 版本中的注册时序和别名不同，使用上面的
    // 延迟注入兼容；这里只把稳定的 slots 设为硬依赖。
    exports.inject = ['slots'];
    return module.exports;
  }
});
