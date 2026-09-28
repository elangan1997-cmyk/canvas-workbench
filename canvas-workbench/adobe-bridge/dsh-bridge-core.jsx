/*
  DSH 画布桥接 · 共享核心（Photoshop / Illustrator 面板脚本都 #include 本文件）
  ---------------------------------------------------------------------------
  运行环境：Adobe ExtendScript（ES3 方言）。没有 JSON、没有 Array.forEach/map/indexOf、
  没有 String.trim、没有 Date.now、没有 Object.keys —— 本文件自带这些工具，面板脚本只用这里的函数。
  协议契约：canvas-workbench/adobe-bridge/PROTOCOL.md（改字段先改协议）。
  排障：~/.dsh/canvas-workbench/adobe-bridge/script-log.txt（本文件 log() 追加）。
  文件编码：UTF-8 带 BOM（ExtendScript 据此正确解析中文）。
*/
var DSH_BRIDGE = (typeof DSH_BRIDGE !== 'undefined' && DSH_BRIDGE) ? DSH_BRIDGE : {};

(function (B) {
  B.PROTOCOL = 1;
  B.CORE_VERSION = '1.0.0';
  B.ONLINE_MS = 60000;
  B.APP_LABELS = { photoshop: 'Photoshop', illustrator: 'Illustrator' };

  /* ---------- 基础工具（ES3 补齐） ---------- */
  B.now = function () { return new Date().getTime(); };
  B.pad = function (n, w) { var s = String(n); while (s.length < w) s = '0' + s; return s; };
  B.trim = function (s) { return String(s === undefined || s === null ? '' : s).replace(/^\s+|\s+$/g, ''); };
  B.has = function (arr, v) { for (var i = 0; i < arr.length; i++) if (arr[i] === v) return true; return false; };
  B.keys = function (o) { var out = []; for (var k in o) if (o.hasOwnProperty(k)) out.push(k); return out; };
  B.stamp = function () {
    var d = new Date();
    return d.getFullYear() + B.pad(d.getMonth() + 1, 2) + B.pad(d.getDate(), 2) + '-' + B.pad(d.getHours(), 2) + B.pad(d.getMinutes(), 2) + B.pad(d.getSeconds(), 2);
  };
  B.rand4 = function () { var c = 'abcdefghjkmnpqrstuvwxyz23456789', s = ''; for (var i = 0; i < 4; i++) s += c.charAt(Math.floor(Math.random() * c.length)); return s; };
  /* jobId：<ps|ai>-<yyyymmdd>-<hhmmss>-<4 位随机>（PROTOCOL §3） */
  B.jobId = function (prefix) { return prefix + '-' + B.stamp() + '-' + B.rand4(); };
  /* 文件名安全化：去路径分隔与非法字符，限 40 字 */
  B.safeName = function (v, fallback) {
    var s = String(v === undefined || v === null ? '' : v).replace(/[\\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ');
    s = B.trim(s).replace(/^\.+/, '');
    if (s.length > 40) s = s.substring(0, 40);
    return s || (fallback || '图层');
  };
  B.baseName = function (name) { var s = String(name || ''); var i = s.lastIndexOf('.'); return i > 0 ? s.substring(0, i) : s; };
  B.extOf = function (name) { var s = String(name || ''); var i = s.lastIndexOf('.'); return i > 0 ? s.substring(i + 1).toLowerCase() : ''; };
  B.round = function (v) { return Math.round(Number(v) * 100) / 100; };

  /* ---------- 路径拼接（Windows 兼容） ----------
     fsName 在 Windows 是反斜杠（C:\Users\x）；统一按基目录自带的分隔符拼接，
     不要写 X.fsName + '/' + Y 的混分隔（ExtendScript 多数时候能容错，但 File.exists/copy 偶发失败）。 */
  B.child = function (base, name) {
    /* Preserve a tilde-based fullName on macOS. Converting that Folder to
       fsName too early triggers Photoshop 2025's /Users -> /Volumes/Users bug. */
    var full = base && base.fullName !== undefined ? String(base.fullName) : '';
    var b = /^~[\/]/.test(full) ? full : (base && base.fsName !== undefined ? base.fsName : String(base || ''));
    var sep = b.indexOf('\\') >= 0 ? '\\' : '/';
    return b + sep + String(name || '');
  };

  /* ---------- 文本文件（UTF-8，统一 LF：ExtendScript 在 macOS 默认把 \n 写成 CR） ---------- */
  B.readText = function (file) {
    if (!file || !file.exists) return null;
    file.encoding = 'UTF-8';
    file.lineFeed = 'Unix';
    if (!file.open('r')) return null;
    var t = file.read();
    file.close();
    return t;
  };
  B.writeText = function (file, text) {
    file.encoding = 'UTF-8';
    file.lineFeed = 'Unix';
    if (!file.open('w')) throw new Error('无法写入：' + file.fsName);
    file.write(text);
    file.close();
  };

  /* ---------- JSON（ExtendScript 无 JSON 对象） ---------- */
  /* 解析：只接受本机可信文件，用 eval 包裹；非对象/数组开头直接拒绝 */
  B.parseJSON = function (text) {
    if (!text) return null;
    var t = B.trim(String(text).replace(/^\uFEFF/, ''));
    var c = t.charAt(0);
    if (c !== '{' && c !== '[') return null;
    try { return eval('(' + t + ')'); } catch (e) { return null; }
  };
  B.escapeString = function (s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
      .replace(/[\x00-\x1f]/g, function (ch) { var h = ch.charCodeAt(0).toString(16); return '\\u' + B.pad(h, 4); }) + '"';
  };
  B.toJSON = function (v, indent, level) {
    indent = indent === undefined ? '  ' : indent;
    level = level || 0;
    var pad = '', padIn = '', i;
    for (i = 0; i < level; i++) pad += indent;
    padIn = pad + indent;
    var nl = indent ? '\n' : '';
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return isFinite(v) ? String(v) : 'null';
    if (typeof v === 'string') return B.escapeString(v);
    if (typeof v === 'function') return 'null';
    if (v instanceof Array) {
      if (!v.length) return '[]';
      var items = [];
      for (i = 0; i < v.length; i++) items.push(padIn + B.toJSON(v[i], indent, level + 1));
      return '[' + nl + items.join(',' + nl) + nl + pad + ']';
    }
    var ks = B.keys(v), parts = [];
    for (i = 0; i < ks.length; i++) {
      if (typeof v[ks[i]] === 'function') continue;
      parts.push(padIn + B.escapeString(ks[i]) + ': ' + B.toJSON(v[ks[i]], indent, level + 1));
    }
    if (!parts.length) return '{}';
    return '{' + nl + parts.join(',' + nl) + nl + pad + '}';
  };
  B.readJSON = function (file) { return B.parseJSON(B.readText(file)); };
  B.writeJSON = function (file, obj) { B.writeText(file, B.toJSON(obj, '  ')); };

  /* ---------- 桥接根目录 / 日志 / 偏好 ---------- */
  B.rootFolder = function () {
    /* Photoshop 2025/macOS may expose Folder('~').fsName as /Volumes/Users/...
       even though File('~/.dsh/...') resolves correctly. Keep the tilde in the
       path string until ExtendScript resolves it, otherwise bridge.json appears
       missing and all remote operations fail with error 48/offline messages. */
    var f = new Folder('~/.dsh/canvas-workbench/adobe-bridge');
    if (!f.exists) f.create();
    return f;
  };
  B.log = function (app, msg) {
    try {
      var f = new File(B.child(B.rootFolder(), 'script-log.txt'));
      f.encoding = 'UTF-8';
      f.lineFeed = 'Unix';
      if (f.open('a')) { f.writeln(new Date().toString() + ' [' + app + '] ' + msg); f.close(); }
    } catch (e) {}
  };
  B.prefsFile = function () { return new File(B.child(B.rootFolder(), 'panel-prefs.json')); };
  B.loadPrefs = function (app, defaults) {
    var all = B.readJSON(B.prefsFile()) || {};
    var mine = all[app] || {};
    var out = {}, ks = B.keys(defaults), i;
    for (i = 0; i < ks.length; i++) out[ks[i]] = mine[ks[i]] === undefined ? defaults[ks[i]] : mine[ks[i]];
    return out;
  };
  B.savePrefs = function (app, prefs) {
    try { var all = B.readJSON(B.prefsFile()) || {}; all[app] = prefs; B.writeJSON(B.prefsFile(), all); } catch (e) {}
  };
  B.tempFolder = function () {
    var f = new Folder(B.child(Folder.temp, 'dsh-canvas-bridge'));
    if (!f.exists) f.create();
    return f;
  };

  /* ---------- 握手（PROTOCOL §2） ---------- */
  B.readHandshake = function () { return B.readJSON(new File(B.child(B.rootFolder(), 'bridge.json'))); };
  /* 返回 { online, reason, handshake }；离线原因面向用户可读 */
  B.status = function () {
    var h = B.readHandshake();
    if (!h) return { online: false, reason: '未找到 bridge.json：DSH 画布插件未安装，或从未打开过画布', handshake: null };
    if (Number(h.protocol) !== B.PROTOCOL) return { online: false, reason: '协议版本不匹配（脚本 ' + B.PROTOCOL + ' / 插件 ' + h.protocol + '），请更新桥接脚本', handshake: h };
    if (B.now() - Number(h.updatedAt || 0) > B.ONLINE_MS) return { online: false, reason: 'DSH 离线或画布不可见（心跳超时）', handshake: h };
    if (!h.project) return { online: false, reason: '画布还没有绑定项目', handshake: h };
    return { online: true, reason: '', handshake: h };
  };
  B.inboxFolder = function (h, app) {
    var p = h && h.inbox && h.inbox[app];
    if (!p) return null;
    var fo = new Folder(p);
    if (!fo.exists) fo.create();
    return fo;
  };
  B.outboxFolder = function (h) {
    var p = h && h.outbox;
    if (!p) return null;
    var fo = new Folder(p);
    if (!fo.exists) fo.create();
    return fo;
  };

  /* ---------- 收件（脚本 → 画布，PROTOCOL §3） ---------- */
  /* 把临时导出的文件复制进收件箱（最终名），返回最终 File；复制失败抛错 */
  B.deliverFile = function (tempFile, inbox, finalName) {
    var target = new File(B.child(inbox, finalName));
    if (target.exists) target.remove();
    if (!tempFile.copy(target)) throw new Error('复制到收件箱失败：' + finalName);
    try { tempFile.remove(); } catch (e) {}
    return target;
  };
  /* 清单最后写（host 只认清单） */
  B.writeInboundManifest = function (inbox, manifest) {
    var f = new File(B.child(inbox, manifest.jobId + '.json'));
    B.writeJSON(f, manifest);
    return f;
  };

  /* ---------- 发件（画布 → 脚本，PROTOCOL §4） ---------- */
  /* 待处理清单：NNNN.json，排除 .done/.failed；按 seq 升序；可按 targetApp 过滤 */
  B.pendingOutbox = function (h, app) {
    var fo = B.outboxFolder(h);
    if (!fo) return [];
    var files = fo.getFiles(function (f) { return (f instanceof File) && /\.json$/i.test(f.name) && !/\.(done|failed)\.json$/i.test(f.name); });
    var out = [], i;
    for (i = 0; i < files.length; i++) {
      var m = B.readJSON(files[i]);
      if (!m || Number(m.protocol) !== B.PROTOCOL) continue;
      if (app && m.targetApp && m.targetApp !== app) continue;
      out.push({ file: files[i], manifest: m });
    }
    out.sort(function (a, b) { return (Number(a.manifest.seq) || 0) - (Number(b.manifest.seq) || 0); });
    return out;
  };
  /* 处理完：改名 .done.json / .failed.json（失败时把 error 写进清单） */
  B.markManifest = function (file, state, error) {
    var targetName = file.name.replace(/\.json$/i, '.' + state + '.json');
    if (error) {
      try {
        var m = B.readJSON(file) || {};
        m.error = String(error);
        B.writeJSON(new File(B.child(file.parent, targetName)), m);
        file.remove();
        return;
      } catch (e) {}
    }
    file.rename(targetName);
  };
  /* 归位判断：有出处且（总是归位 或 文档名一致） */
  B.shouldHome = function (origin, docName, alwaysHome) {
    if (!origin || !origin.bounds) return false;
    if (alwaysHome) return true;
    return !!(origin.document && origin.document.name && docName && origin.document.name === docName);
  };

  /* ---------- ScriptUI 通用骨架 ---------- */
  /* 创建窗口：type = 'palette'（Photoshop，可常驻）| 'dialog'（Illustrator，模态） */
  B.makeWindow = function (type, title) {
    var w = new Window(type, title, undefined, { closeButton: true, resizeable: false });
    w.orientation = 'column';
    w.alignChildren = ['fill', 'top'];
    w.spacing = 8;
    w.margins = 12;
    var st = w.add('statictext', undefined, '● 正在检测 DSH…', { multiline: true });
    st.characters = 42;
    var pj = w.add('statictext', undefined, '项目：—');
    pj.characters = 42;
    w.__status = st;
    w.__project = pj;
    return w;
  };
  B.paintStatus = function (w, s) {
    if (!w || !w.__status) return;
    if (s.online) {
      w.__status.text = '● 已连接 DSH 画布';
      w.__project.text = '项目：' + (s.handshake.project.name || s.handshake.project.dir);
    } else {
      w.__status.text = '○ 离线：' + s.reason;
      w.__project.text = '项目：—';
    }
    try { w.layout.layout(true); } catch (e) {}
  };
  B.setNote = function (w, text) {
    if (w && w.__note) { w.__note.text = String(text || ''); try { w.layout.layout(true); } catch (e) {} }
  };
})(DSH_BRIDGE);
