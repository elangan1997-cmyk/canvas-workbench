/*
  DSH 画布桥接 · Photoshop 面板
  ---------------------------------------------------------------------------
  安装：与 dsh-bridge-core.jsx、DSH画布桥接-Illustrator.jsx 一起放进 Photoshop 的 Presets/Scripts，
        重启后 文件 → 脚本 → DSH画布桥接-Photoshop（画布「更多 → 安装 Adobe 桥接脚本」会自动拷贝；
        菜单要重启 PS 才出现，装完当时可用 文件 → 脚本 → 浏览… 打开）。
  功能：① 发送选中图层 → 画布（逐层 / 合并为一张，透明 PNG，裁到图层边界，记录文档坐标）
        ② 发送整个文档 (PSD) → 画布（画布可做图层级编辑）
        ③ 读取项目发件箱 → 「置入为图层」（智能对象，可归位到出发位置）/「打开为新文档」
  面板形态：模态对话框。实测 PS 2025 不支持 ExtendScript 常驻 palette（脚本一结束窗口就被关，
        #targetengine 也留不住）——用完点「关闭」，下次从菜单再开；发件箱靠「刷新」。
  协议：canvas-workbench/adobe-bridge/PROTOCOL.md。排障：~/.dsh/canvas-workbench/adobe-bridge/script-log.txt
  实现要点（子代理改 bug 先读）：
    - 选中图层用 ActionManager targetLayers 取 layerID（有背景层时索引不 +1，否则 +1）；
    - 导出用「隔离可见性 → doc.duplicate(合并可见) → crop 到边界 → 另存 PNG 副本」，不改原文档；
    - 置入用 ActionManager "Plc "，随后按 origin.bounds 缩放/平移归位（PS 坐标本就 y 向下、px）。
    - 无界面自动化测试：$.global.DSH_BRIDGE_HEADLESS = true 后 $.evalFile 本文件，调 DSH_BRIDGE.ps.*。
*/
#target photoshop
#include "dsh-bridge-core.jsx"

(function () {
  var B = DSH_BRIDGE, APP = 'photoshop';
  var cTID = function (s) { return charIDToTypeID(s); };
  var sTID = function (s) { return stringIDToTypeID(s); };
  var prefs = B.loadPrefs(APP, { merged: false, alwaysHome: false });

  /* ===================== Photoshop 侧工具 ===================== */
  function hasBackground(doc) { try { return !!doc.backgroundLayer; } catch (e) { return false; } }
  function px(u) { try { return Number(u.as('px')); } catch (e) { return Number(u); } }

  /* 选中图层的 layerID 列表（多选靠 ActionManager；取不到就退回 activeLayer） */
  function selectedLayerIds(doc) {
    var ids = [];
    try {
      var ref = new ActionReference();
      ref.putEnumerated(cTID('Dcmn'), cTID('Ordn'), cTID('Trgt'));
      var desc = executeActionGet(ref);
      if (desc.hasKey(sTID('targetLayers'))) {
        var list = desc.getList(sTID('targetLayers'));
        var bg = hasBackground(doc);
        for (var i = 0; i < list.count; i++) {
          var idx = list.getReference(i).getIndex();
          if (!bg) idx += 1;
          var r2 = new ActionReference();
          r2.putProperty(cTID('Prpr'), cTID('LyrI'));
          r2.putIndex(cTID('Lyr '), idx);
          ids.push(executeActionGet(r2).getInteger(cTID('LyrI')));
        }
      }
    } catch (e1) {}
    if (!ids.length) { try { ids.push(doc.activeLayer.id); } catch (e2) {} }
    return ids;
  }
  function selectLayerById(id, addToSelection) {
    var ref = new ActionReference();
    ref.putIdentifier(cTID('Lyr '), id);
    var desc = new ActionDescriptor();
    desc.putReference(cTID('null'), ref);
    if (addToSelection) desc.putEnumerated(sTID('selectionModifier'), sTID('selectionModifierType'), sTID('addToSelection'));
    desc.putBoolean(cTID('MkVs'), false);
    executeAction(cTID('slct'), desc, DialogModes.NO);
  }
  function layerById(doc, id) { selectLayerById(id, false); return doc.activeLayer; }
  function layerType(layer) {
    if (layer.typename === 'LayerSet') return 'group';
    try {
      var k = layer.kind;
      if (k === LayerKind.TEXT) return 'text';
      if (k === LayerKind.SMARTOBJECT) return 'smartobject';
      if (k === LayerKind.SOLIDFILL || k === LayerKind.GRADIENTFILL || k === LayerKind.PATTERNFILL) return 'shape';
      if (k === LayerKind.NORMAL) return 'pixel';
    } catch (e) {}
    return 'other';
  }
  function boundsOf(layer) { var b = layer.bounds; return { left: px(b[0]), top: px(b[1]), right: px(b[2]), bottom: px(b[3]) }; }
  function unionBounds(list) {
    var u = null;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!u) u = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      else { u.left = Math.min(u.left, b.left); u.top = Math.min(u.top, b.top); u.right = Math.max(u.right, b.right); u.bottom = Math.max(u.bottom, b.bottom); }
    }
    return u;
  }
  function clampBounds(b, doc) {
    var w = px(doc.width), h = px(doc.height);
    return { left: Math.max(0, Math.floor(b.left)), top: Math.max(0, Math.floor(b.top)), right: Math.min(w, Math.ceil(b.right)), bottom: Math.min(h, Math.ceil(b.bottom)) };
  }
  function docInfo(doc) {
    var path = '';
    try { path = doc.fullName.fsName; } catch (e) {}
    return { name: doc.name, path: path, width: px(doc.width), height: px(doc.height), resolution: Number(doc.resolution), units: 'px', colorMode: String(doc.mode).replace('DocumentMode.', '') };
  }

  /* 遍历图层树；fn 返回 false 表示不深入该组 */
  function walkLayers(container, fn) {
    var ls = container.layers;
    for (var i = 0; i < ls.length; i++) {
      var l = ls[i];
      var descend = fn(l);
      if (descend !== false && l.typename === 'LayerSet') walkLayers(l, fn);
    }
  }
  /* 隔离：只显示目标图层（整组连子层）及其祖先，其余全部隐藏；返回可恢复的快照 */
  function isolate(doc, targets) {
    var targetIds = [], ancestorIds = [], i, p;
    for (i = 0; i < targets.length; i++) {
      targetIds.push(targets[i].id);
      p = targets[i].parent;
      while (p && p.typename !== 'Document') { ancestorIds.push(p.id); p = p.parent; }
    }
    var saved = [];
    walkLayers(doc, function (l) {
      saved.push({ layer: l, visible: l.visible });
      if (B.has(targetIds, l.id)) { l.visible = true; return false; }
      if (B.has(ancestorIds, l.id)) { l.visible = true; return true; }
      l.visible = false;
      return false;
    });
    return saved;
  }
  function restoreVisibility(saved) {
    for (var i = saved.length - 1; i >= 0; i--) { try { saved[i].layer.visible = saved[i].visible; } catch (e) {} }
  }

  /* 把一组图层导出成一张透明 PNG（临时目录），返回 { file, bounds }；不修改原文档 */
  function exportLayersPNG(doc, layers, tempName) {
    var boundsList = [], i;
    for (i = 0; i < layers.length; i++) boundsList.push(boundsOf(layers[i]));
    var b = clampBounds(unionBounds(boundsList), doc);
    if (b.right <= b.left || b.bottom <= b.top) throw new Error('图层「' + layers[0].name + '」没有可见像素');
    var saved = isolate(doc, layers);
    var dup = null;
    try {
      dup = doc.duplicate(tempName, true);
      try { if (dup.mode !== DocumentMode.RGB && dup.mode !== DocumentMode.GRAYSCALE) dup.changeMode(ChangeMode.RGB); } catch (e1) {}
      try { if (dup.bitsPerChannel === BitsPerChannelType.THIRTYTWO) dup.bitsPerChannel = BitsPerChannelType.EIGHT; } catch (e2) {}
      dup.crop([b.left, b.top, b.right, b.bottom]);
      var file = new File(B.child(B.tempFolder(), tempName + '.png'));
      if (file.exists) file.remove();
      var o = new PNGSaveOptions();
      o.compression = 6;
      o.interlaced = false;
      dup.saveAs(file, o, true, Extension.LOWERCASE);
      return { file: file, bounds: b };
    } finally {
      if (dup) { try { dup.close(SaveOptions.DONOTSAVECHANGES); } catch (e3) {} }
      try { app.activeDocument = doc; } catch (e4) {}
      restoreVisibility(saved);
    }
  }

  /* 包一层：像素单位 + 关闭弹窗，结束后恢复 */
  function withQuietPixels(fn) {
    var oldUnits = app.preferences.rulerUnits, oldDialogs = app.displayDialogs;
    app.preferences.rulerUnits = Units.PIXELS;
    app.displayDialogs = DialogModes.NO;
    try { return fn(); } finally { app.preferences.rulerUnits = oldUnits; app.displayDialogs = oldDialogs; }
  }

  /* ===================== 发送 ===================== */
  function sendSelection(merged) {
    var s = B.status();
    if (!s.online) throw new Error(s.reason);
    if (!app.documents.length) throw new Error('请先打开一个文档');
    var doc = app.activeDocument;
    var ids = selectedLayerIds(doc);
    if (!ids.length) throw new Error('请先选中至少一个图层');
    var inbox = B.inboxFolder(s.handshake, APP);
    var job = B.jobId('ps');
    return withQuietPixels(function () {
      var layers = [], items = [], i;
      for (i = 0; i < ids.length; i++) layers.push(layerById(doc, ids[i]));
      if (merged && layers.length > 1) {
        var r = exportLayersPNG(doc, layers, job + '-01');
        var name = job + '-01-' + B.safeName('合并' + layers.length + '层') + '.png';
        B.deliverFile(r.file, inbox, name);
        items.push({ file: name, kind: 'png', layer: { name: '合并·' + layers.length + '层', id: 0, type: 'group' }, bounds: r.bounds, artboard: null });
      } else {
        for (i = 0; i < layers.length; i++) {
          var r1 = exportLayersPNG(doc, [layers[i]], job + '-' + B.pad(i + 1, 2));
          var n1 = job + '-' + B.pad(i + 1, 2) + '-' + B.safeName(layers[i].name) + '.png';
          B.deliverFile(r1.file, inbox, n1);
          items.push({ file: n1, kind: 'png', layer: { name: layers[i].name, id: layers[i].id, type: layerType(layers[i]) }, bounds: r1.bounds, artboard: null });
        }
      }
      for (i = 0; i < ids.length; i++) { try { selectLayerById(ids[i], i > 0); } catch (e) {} }
      B.writeInboundManifest(inbox, { protocol: B.PROTOCOL, jobId: job, app: APP, appVersion: String(app.version), createdAt: B.now(), document: docInfo(doc), merged: !!(merged && layers.length > 1), items: items });
      B.log(APP, '发送 ' + items.length + ' 项 → ' + inbox.fsName + ' (' + job + ')');
      return items.length;
    });
  }

  function sendDocument() {
    var s = B.status();
    if (!s.online) throw new Error(s.reason);
    if (!app.documents.length) throw new Error('请先打开一个文档');
    var doc = app.activeDocument;
    var inbox = B.inboxFolder(s.handshake, APP);
    var job = B.jobId('ps');
    return withQuietPixels(function () {
      var temp = new File(B.child(B.tempFolder(), job + '-doc.psd'));
      if (temp.exists) temp.remove();
      var o = new PhotoshopSaveOptions();
      o.layers = true;
      o.embedColorProfile = true;
      o.maximizeCompatibility = true;
      doc.saveAs(temp, o, true, Extension.LOWERCASE);
      var name = job + '-01-' + B.safeName(B.baseName(doc.name), '文档') + '.psd';
      B.deliverFile(temp, inbox, name);
      var info = docInfo(doc);
      B.writeInboundManifest(inbox, { protocol: B.PROTOCOL, jobId: job, app: APP, appVersion: String(app.version), createdAt: B.now(), document: info, merged: false,
        items: [{ file: name, kind: 'psd', layer: { name: doc.name, id: 0, type: 'document' }, bounds: { left: 0, top: 0, right: info.width, bottom: info.height }, artboard: null }] });
      B.log(APP, '发送整个文档 → ' + name);
      return 1;
    });
  }

  /* ===================== 置入 / 打开 ===================== */
  function placeFile(file) {
    try {
      return placeFileOnce(file);
    } catch (ePlace) {
      /* 发件箱路径含中文/空格时 ActionManager 置入报"常规 Photoshop 错误"(Windows 实测):
         复制到 ASCII 临时目录再置入,与 openDocSafe 的既有兜底同款。 */
      var tempPlace = new File(B.child(B.tempFolder(), 'place-' + B.rand4() + '-' + file.name));
      if (!file.copy(tempPlace)) throw ePlace;
      return placeFileOnce(tempPlace);
    }
  }
  function placeFileOnce(file) {
    var d = new ActionDescriptor();
    d.putPath(cTID('null'), file);
    d.putEnumerated(cTID('FTcs'), cTID('QCSt'), cTID('Qcsa'));
    d.putUnitDouble(cTID('Wdth'), cTID('#Prc'), 100);
    d.putUnitDouble(cTID('Hght'), cTID('#Prc'), 100);
    d.putBoolean(cTID('Lnkd'), false);
    executeAction(cTID('Plc '), d, DialogModes.NO);
    return app.activeDocument.activeLayer;
  }
  /* 归位：缩放到出处尺寸，再平移到出处左上角（PS 坐标 y 向下，与清单一致） */
  function homeLayer(layer, origin) {
    var b = boundsOf(layer);
    var W = origin.bounds.right - origin.bounds.left, H = origin.bounds.bottom - origin.bounds.top;
    var w0 = b.right - b.left, h0 = b.bottom - b.top;
    if (w0 > 0 && h0 > 0 && W > 0 && H > 0 && (Math.abs(w0 - W) > 0.5 || Math.abs(h0 - H) > 0.5)) {
      layer.resize(W / w0 * 100, H / h0 * 100, AnchorPosition.TOPLEFT);
      b = boundsOf(layer);
    }
    layer.translate(origin.bounds.left - b.left, origin.bounds.top - b.top);
  }
  /* 打开文档。PS 的 app.open 对中文目录会报"打开选项不正确"（发件箱路径含中文）——
     先试原路径，失败则复制到 ASCII 临时目录再开。「打开为新文档」优先原路径（保存落回发件箱）。 */
  function openDocSafe(file) {
    var firstError = null;
    try { return app.open(file); } catch (e1) { firstError = e1; }
    var temp = new File(B.child(B.tempFolder(), 'open-' + B.rand4() + '-' + file.name));
    if (!file.copy(temp)) throw new Error('无法读取文件：' + file.name + '（' + (firstError && firstError.message ? firstError.message : firstError) + '）');
    return app.open(temp);
  }
  /* PSD → 图层。PS 脚本层的硬限制（2026-09-18 逐项实测）：图层组不能 move/duplicate 进另一个图层组
     （"非法参数"/"您不能把一个图层组复制到另一个图层组中"）；Mk layerSection+From 描述符会卡死 PS；
     groupLayersEvent 在 PS 2025 报"图层编组当前不可用"。因此分两层：
     ① 顶层全是普通图层 → 真正包进「label ← 画布」组（已端到端验证）；
     ② 顶层含图层组（如文字重建 PSD 的文字组）→ 逐层复制保持顺序、每项加「«画布»」前缀区分、整体平移归位。 */
  function importLayersFromPSD(doc, file, origin, alwaysHome, label) {
    var temp = new File(B.child(B.tempFolder(), 'layers-' + B.rand4() + '-' + file.name));
    if (!file.copy(temp)) throw new Error('无法读取 PSD：' + file.name);
    var src = app.open(temp);
    if (!src) throw new Error('PSD 打开失败：' + file.name);
    /* app.open 后 UI 前台状态需要短暂安定，立刻跨文档复制会报"要求目标文档是最前面的文档" */
    $.sleep(250);
    var srcW, srcH, imported = [], group = null;
    try {
      srcW = px(src.width); srcH = px(src.height);
      /* 注意：不要把 src.layers 缓存进变量再用——过期集合引用会让 duplicate 报
         "要求目标文档是最前面的文档"；每次都实时取 src.layers[i]。 */
      var hasSet = false, i;
      for (i = 0; i < src.layers.length; i++) if (src.layers[i].typename === 'LayerSet') { hasSet = true; break; }
      if (!hasSet) {
        /* ① 全普通层 → 一个组 */
        app.activeDocument = doc;
        $.sleep(120);
        group = doc.layerSets.add();
        group.name = label + ' ← 画布';
        app.activeDocument = src;
        $.sleep(120);
        var dups = [];
        for (i = src.layers.length - 1; i >= 0; i--) dups.push(src.layers[i].duplicate(doc, ElementPlacement.PLACEATBEGINNING));
        app.activeDocument = doc;
        for (i = 0; i < dups.length; i++) { dups[i].move(group, ElementPlacement.INSIDE); imported.push(dups[i]); }
      } else {
        /* ② 含图层组 → 逐层复制 + 前缀（PS 不允许组进组，见函数头注释）。源文档须在最前才能复制出层。 */
        app.activeDocument = src;
        $.sleep(120);
        for (i = src.layers.length - 1; i >= 0; i--) imported.push(src.layers[i].duplicate(doc, ElementPlacement.PLACEATBEGINNING));
        app.activeDocument = doc;
        B.log(APP, 'PSD 顶层含图层组，无法组中组（PS 限制），改为前缀标注：' + file.name);
      }
    } finally {
      try { src.close(SaveOptions.DONOTSAVECHANGES); } catch (eClose) {}
      app.activeDocument = doc;
    }
    /* 改名/平移等写操作要求目标文档在最前（diag8 实测：复制成功、紧接着给非活动文档图层改名报
       "要求目标文档是最前面的文档"）——统一在这里（doc 已是活动文档）做前缀改名。 */
    if (!group && imported.length) for (i = 0; i < imported.length; i++) imported[i].name = '«画布»' + imported[i].name;
    /* 归位/居中：①路径（整组）可安全缩放；②路径（多项）只平移不缩放，避免各项各自缩放破坏相对布局。 */
    var ub = null, b, k;
    for (k = 0; k < imported.length; k++) {
      b = boundsOf(imported[k]);
      if (!ub) ub = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      else { ub.left = Math.min(ub.left, b.left); ub.top = Math.min(ub.top, b.top); ub.right = Math.max(ub.right, b.right); ub.bottom = Math.max(ub.bottom, b.bottom); }
    }
    if (ub) {
      if (origin && B.shouldHome(origin, doc.name, alwaysHome)) {
        var W = origin.bounds.right - origin.bounds.left, H = origin.bounds.bottom - origin.bounds.top;
        if (group && ub.right - ub.left > 0 && Math.abs(srcW - W) > 0.5 && srcW > 0 && srcH > 0) {
          group.resize(W / srcW * 100, H / srcH * 100, AnchorPosition.TOPLEFT);
          ub = boundsOf(group);
        }
        for (k = 0; k < imported.length; k++) imported[k].translate(origin.bounds.left - ub.left, origin.bounds.top - ub.top);
      } else {
        var dw = px(doc.width), dh = px(doc.height);
        var cdx = (dw - (ub.right + ub.left)) / 2, cdy = (dh - (ub.bottom + ub.top)) / 2;
        for (k = 0; k < imported.length; k++) imported[k].translate(cdx, cdy);
      }
    }
    try { doc.activeLayer = group || imported[imported.length - 1]; } catch (eActive) {}
    return imported.length;
  }
  /* 图片置入后的组归位/居中（bounds 为已置入对象的边界）： */
  function homeOrCenter(doc, layer, w, h, origin, alwaysHome) {
    var gb = boundsOf(layer);
    if (B.shouldHome(origin, doc.name, alwaysHome)) {
      var W = origin.bounds.right - origin.bounds.left, H = origin.bounds.bottom - origin.bounds.top;
      var sx = (Number(w) > 0 && W > 0) ? W / Number(w) : 1, sy = (Number(h) > 0 && H > 0) ? H / Number(h) : 1;
      if ((Math.abs(sx - 1) > 0.005 || Math.abs(sy - 1) > 0.005) && gb.right > gb.left && gb.bottom > gb.top) {
        layer.resize(sx * 100, sy * 100, AnchorPosition.TOPLEFT);
        gb = boundsOf(layer);
      }
      layer.translate(origin.bounds.left - gb.left, origin.bounds.top - gb.top);
    } else {
      var dw = px(doc.width), dh = px(doc.height);
      layer.translate((dw - (gb.right + gb.left)) / 2, (dh - (gb.bottom + gb.top)) / 2);
    }
  }
  function importPending(mode) {
    var s = B.status();
    var h = s.handshake;
    if (!h || !h.outbox) throw new Error(s.reason || '未找到发件箱');
    var jobs = B.pendingOutbox(h, APP);
    if (!jobs.length) throw new Error('发件箱没有新的返回件');
    /* 先于任何清单改名之前检查：没有文档可置入时清单必须保持待处理，等用户打开文档再来 */
    if (mode !== 'open' && !app.documents.length) throw new Error('没有打开的文档可置入，请先打开文档或改用「打开为新文档」');
    return withQuietPixels(function () {
      var count = 0, i, j;
      for (i = 0; i < jobs.length; i++) {
        var m = jobs[i].manifest, ok = true, err = '';
        try {
          for (j = 0; j < m.files.length; j++) {
            var f = new File(B.child(jobs[i].file.parent, m.files[j].file));
            if (!f.exists) throw new Error('文件不存在：' + m.files[j].file);
            var origin = m.origin;
            var label = origin && origin.layer && origin.layer.name ? origin.layer.name : B.baseName(m.files[j].name || m.files[j].file);
            var kind = String(m.files[j].kind || B.extOf(m.files[j].file)).toLowerCase();
            if (mode === 'open') {
              openDocSafe(f);
            } else {
              if (!app.documents.length) throw new Error('没有打开的文档可置入，请先打开文档或改用「打开为新文档」');
              var doc = app.activeDocument;
              /* 按格式分流：PSD → 图层进当前文档（组承接）；其它 → 智能对象（图片心智模型） */
              if (kind === 'psd') {
                importLayersFromPSD(doc, f, origin, prefs.alwaysHome, label);
              } else {
                var layer = placeFile(f);
                layer.name = label;
                /* 图片也装进「label ← 画布」组，和原文件内容区分（普通层 move INSIDE 可行，只有组进组不行） */
                var imgGroup = doc.layerSets.add();
                imgGroup.name = label + ' ← 画布';
                layer.move(imgGroup, ElementPlacement.INSIDE);
                homeOrCenter(doc, imgGroup, boundsOf(layer).right - boundsOf(layer).left, boundsOf(layer).bottom - boundsOf(layer).top, origin, prefs.alwaysHome);
                try { doc.activeLayer = imgGroup; } catch (eGroup) {}
              }
            }
            count++;
          }
        } catch (e) { ok = false; err = String(e && e.message ? e.message : e); }
        B.markManifest(jobs[i].file, ok ? 'done' : 'failed', ok ? '' : err);
        B.log(APP, (ok ? '返回件已' + (mode === 'open' ? '打开 ' : '置入 ') : '返回件失败 ') + jobs[i].file.name + (err ? '：' + err : ''));
        if (!ok) throw new Error(err);
      }
      return count;
    });
  }

  /* 对外暴露（无界面自动化测试 / 其它脚本复用）。$.global.DSH_BRIDGE_HEADLESS === true 时只挂函数、不开面板：
     测试脚本先设该标志，再 $.evalFile 本文件，然后直接调 DSH_BRIDGE.ps.sendSelection(false) 等。 */
  B.ps = { sendSelection: sendSelection, sendDocument: sendDocument, importPending: importPending, selectedLayerIds: selectedLayerIds, selectLayerById: selectLayerById, exportLayersPNG: exportLayersPNG, placeFile: placeFile, homeLayer: homeLayer, importLayersFromPSD: importLayersFromPSD, openDocSafe: openDocSafe, boundsOf: boundsOf, layerType: layerType, prefs: prefs };
  if ($.global.DSH_BRIDGE_HEADLESS === true) return;

  /* ===================== 面板（模态对话框） =====================
     实测（2026-09-18，PS 2025）：palette 窗口在脚本结束后立即被 Photoshop 关闭，#targetengine 也留不住
     —— PS 不支持 ExtendScript 常驻面板（InDesign 才支持），因此与 Illustrator 一样用模态 dialog：
     用完点「关闭」，下次从 文件 → 脚本 再开；发件箱靠「刷新」，没有后台轮询。 */
  var win = B.makeWindow('dialog', 'DSH 画布桥接 · Photoshop');
  var g1 = win.add('group');
  g1.orientation = 'row';
  var btnSend = g1.add('button', undefined, '发送选中图层 → 画布');
  var cbMerged = g1.add('checkbox', undefined, '合并为一张');
  cbMerged.value = !!prefs.merged;
  var btnDoc = win.add('button', undefined, '发送整个文档 (PSD) → 画布');
  var outHeader = win.add('statictext', undefined, '发件箱：正在检测…');
  outHeader.characters = 42;
  var g2 = win.add('group');
  g2.orientation = 'row';
  var btnPlace = g2.add('button', undefined, '置入为图层');
  var btnOpen = g2.add('button', undefined, '打开为新文档');
  var btnRefresh = g2.add('button', undefined, '刷新');
  var cbHome = win.add('checkbox', undefined, '总是归位到出发位置（即使文档名不同）');
  cbHome.value = !!prefs.alwaysHome;
  var note = win.add('statictext', undefined, ' ', { multiline: true });
  note.characters = 42;
  win.__note = note;
  var btnClose = win.add('button', undefined, '关闭', { name: 'cancel' });

  function refresh() {
    var s = B.status();
    B.paintStatus(win, s);
    var n = 0;
    if (s.handshake && s.handshake.outbox) { try { n = B.pendingOutbox(s.handshake, APP).length; } catch (e) { n = 0; } }
    outHeader.text = n ? ('📥 发件箱有 ' + n + ' 个返回件待置入') : '发件箱：暂无新返回件';
    btnSend.enabled = btnDoc.enabled = !!s.online;
    btnPlace.enabled = btnOpen.enabled = n > 0;
    return s;
  }
  /* 成功即自动关闭对话框（模态窗口开着会挡住应用，用户反馈过）；失败留在面板上显示原因 */
  function run(label, fn) {
    try {
      var n = fn();
      B.log(APP, label + '成功：' + n + ' 项，面板自动关闭');
      win.close();
      return;
    } catch (e) {
      var msg = String(e && e.message ? e.message : e);
      B.setNote(win, '⚠ ' + label + '失败：' + msg);
      B.log(APP, label + '失败：' + msg);
    }
    try { refresh(); } catch (e2) {}
  }
  btnSend.onClick = function () { run('发送图层', function () { return sendSelection(cbMerged.value); }); };
  btnDoc.onClick = function () { run('发送文档', sendDocument); };
  btnPlace.onClick = function () { run('置入', function () { return importPending('place'); }); };
  btnOpen.onClick = function () { run('打开', function () { return importPending('open'); }); };
  btnRefresh.onClick = function () { try { refresh(); B.setNote(win, '已刷新'); } catch (e) { B.setNote(win, '⚠ ' + e); } };
  cbMerged.onClick = function () { prefs.merged = cbMerged.value; B.savePrefs(APP, prefs); };
  cbHome.onClick = function () { prefs.alwaysHome = cbHome.value; B.savePrefs(APP, prefs); };
  btnClose.onClick = function () { win.close(); };

  refresh();
  B.log(APP, '面板已打开（core ' + B.CORE_VERSION + '）');
  win.center();
  win.show();
})();
