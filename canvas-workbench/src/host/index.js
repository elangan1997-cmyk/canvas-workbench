// v1.8 Phase 2：Host 入口。闭包辅助函数区（原 lib/index.js 430-694）逐字保留；
// 41 条路由拆到 ./routes/*.js，由 createRouter 按原顺序分派；未命中仍回 404 'not found'。
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { access, mkdir, readdir, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isMac, isWindows, resolvePython } from '../../lib/platform.js';
import { PLUGIN_ROOT } from './vendor-assets.js';
import { createPythonToolRegistry } from './adapters/python.adapter.js';
import { startToolchainProvisioning } from './services/local-toolchain.js';
import { register as registerContracts } from './routes/contracts.routes.js';
import { installChatImageRouter } from '../../lib/chat-image-router.js';
import { expandHome, isPathWithin } from '../shared/utils/paths.js';
import { parseQuery, respond } from './server/http.js';
import { MAX_IMAGE_BYTES, MAX_SOURCE_BYTES, SOURCE_EXTENSIONS, cleanJobId, extOf, isSourceImagePath, sourceKindOf } from '../shared/utils/image-types.js';
import { inject, name } from './plugin-meta.js';
import { decodeImageData, safeImageName } from '../shared/utils/data-url.js';
import { createRouter } from './server/router.js';
import { createJobManager } from './jobs/job-manager.js';
import { jobTrackingMiddleware } from './jobs/job-tracking.js';
import { register as registerJobs } from './routes/jobs.routes.js';
import { register as register0 } from './routes/health.routes.js';
import { register as register1 } from './routes/project.routes.js';
import { register as register2 } from './routes/settings.routes.js';
import { register as register3 } from './routes/asset.routes.js';
import { register as register4 } from './routes/generation.routes.js';
import { register as register5 } from './routes/text.routes.js';
import { register as register6 } from './routes/material.routes.js';
import { register as register7 } from './routes/external.routes.js';
import { register as registerAdobeBridge } from './routes/adobe-bridge.routes.js';
import { createAdobeBridge } from './services/adobe-bridge.js';

function apply(ctx) {
  const fs = ctx.get('fs');
  const sp = ctx.get('sandboxPolicy');
  const statePath = () => {
    const root = sp && typeof sp.workspaceRoot === 'string' && sp.workspaceRoot ? sp.workspaceRoot : null;
    return root ? root.replace(/[\\/]+$/, '') + '/.dsh-canvas-state.json' : null;
  };
  const projectStatePath = (query) => {
    const chosen = expandHome(parseQuery(query).project || '');
    if (chosen) return join(chosen.replace(/[\\/]+$/, ''), 'canvas.json');
    const cwd = expandHome(parseQuery(query).cwd || '');
    if (cwd) return join(cwd.replace(/[\\/]+$/, ''), '画布项目', 'canvas.json');
    return statePath();
  };
  const projectDirectory = (cwd, project) => {
    const chosen = expandHome(String(project || ''));
    if (chosen) return chosen.replace(/[\\/]+$/, '');
    const root = expandHome(String(cwd || ''));
    if (root) return join(root.replace(/[\\/]+$/, ''), '画布项目');
    const fallback = statePath();
    return fallback ? dirname(fallback) : '';
  };
  const previewCache = join(tmpdir(), 'dsh-canvas-previews');
  // 同一个 DSH host 可能同时收到多个聊天/旧插件实例的 canvas.json 写入。
  // 按项目路径串行处理，并在串行队列内比较客户端快照时间戳，防止迟到的
  // 旧快照覆盖刚保存的新快照（典型表现就是删除后切聊天又恢复）。
  const stateWriteChains = new Map();
  // 浏览器侧把“当前会话 + 当前画布项目 + 设计模式”发布到 Host。
  // 只保存在本次 DSH 进程内，不写聊天记录；重启后由画布客户端重新发布。
  const chatContexts = new Map();
  const chatContextFor = (sessionId) => chatContexts.get(String(sessionId || '')) || null;
  const previewUrl = (path, mtimeMs) => '/dsh-canvas/preview?path=' + encodeURIComponent(path) + '&v=' + encodeURIComponent(String(Math.round(mtimeMs || 0)));
  const progressPathFor = (projectDir, jobId) => join(projectDir, 'outputs', '.图片编辑临时', '.rembg-progress-' + cleanJobId(jobId) + '.json');
  const writeProgressFile = async (path, payload) => {
    if (!path) return;
    const value = JSON.stringify({ ...payload, updatedAt: Date.now() / 1000 });
    const temporary = path + '.hosttmp';
    try {
      await writeFile(temporary, value, 'utf8');
      await rename(temporary, path);
    } catch (err) {
      await writeFile(path, value, 'utf8').catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  };
  const runProcess = async (executable, args, cwd) => {
    const handle = ctx.subprocess.spawn({ argv: [executable, ...args], cwd, stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } }, graceMs: 2000 });
    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0);
    const stderr = handle.collected.stderr?.readFrom(0);
    return { exitCode: outcome.exitCode, stdout: stdout && stdout.text ? stdout.text : '', stderr: stderr && stderr.text ? stderr.text : '' };
  };
  const runProcessWithTimeout = async (executable, args, cwd, timeoutMs) => {
    const handle = ctx.subprocess.spawn({ argv: [executable, ...args], cwd, stdio: { stdin: 'ignore', stdout: { maxBytes: 256 * 1024 }, stderr: { maxBytes: 256 * 1024 } }, graceMs: 2000 });
    let timedOut = false;
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(async () => {
        timedOut = true;
        try { if (typeof handle.terminate === 'function') await handle.terminate(); } catch (err) {}
        resolve(null);
      }, Math.max(1000, Number(timeoutMs) || 20000));
    });
    let outcome = await Promise.race([handle.done, timeout]);
    if (!outcome) outcome = await handle.done;
    if (timer) clearTimeout(timer);
    const stdout = handle.collected.stdout?.readFrom(0);
    const stderr = handle.collected.stderr?.readFrom(0);
    return { exitCode: timedOut ? -1 : outcome.exitCode, stdout: stdout && stdout.text ? stdout.text : '', stderr: stderr && stderr.text ? stderr.text : '', timedOut };
  };
  const psdPreviewPath = async (path, mtimeMs) => {
    await mkdir(previewCache, { recursive: true });
    const key = createHash('sha1').update(path + ':' + String(Math.round(mtimeMs || 0))).digest('hex');
    const target = join(previewCache, key + '.jpg');
    try { await access(target); return { path: target, mime: 'image/jpeg' }; } catch (err) {}
    if (!isMac) {
      // Windows / Linux：sips 不存在，此前这里直接落占位 SVG。
      // 改用插件自带 Python 渲染 PSD 合成图（Pillow 直读，psd_tools 缩略图兜底）；
      // Python 缺失或转换失败时仍然回退占位图，不阻断画布。
      try {
        const python = await resolvePython(ctx);
        const renderer = join(PLUGIN_ROOT, 'scripts', 'psd_preview.py');
        const rendered = await runProcessWithTimeout(
          python.executable,
          [...python.prefixArgs, renderer, '--input', path, '--output', target, '--max', '2400'],
          dirname(path),
          60000
        );
        if (rendered.exitCode === 0) {
          try { await access(target); return { path: target, mime: 'image/jpeg' }; } catch (err) {}
        }
      } catch (err) {}
      return { path: await documentFallbackPreviewPath(path, mtimeMs, 'psd'), mime: 'image/svg+xml' };
    }
    const sips = await ctx.subprocess.resolveExecutable('sips');
    const result = await runProcess(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '88', '-Z', '2400', path, '--out', target], dirname(path));
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'PSD 预览生成失败');
    return { path: target, mime: 'image/jpeg' };
  };
  const xmlEscape = (value) => String(value || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[ch]));
  const documentFallbackPreviewPath = async (path, mtimeMs, kind) => {
    const key = createHash('sha1').update(path + ':' + String(Math.round(mtimeMs || 0)) + ':' + kind).digest('hex');
    const target = join(previewCache, key + '.svg');
    try { await access(target); return target; } catch (err) {}
    const label = kind === 'ai' ? 'AI / Illustrator' : kind === 'psd' ? 'PSD / Photoshop' : 'PDF';
    const title = basename(path);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="820" viewBox="0 0 1200 820">'
      + '<rect width="1200" height="820" fill="#f7f8fa"/>'
      + '<rect x="210" y="100" width="780" height="620" rx="24" fill="#ffffff" stroke="#cbd5e1" stroke-width="5"/>'
      + '<path d="M420 250h360l110 110v270H420z" fill="#eef2ff" stroke="#94a3b8" stroke-width="5"/>'
      + '<path d="M780 250v115h110" fill="none" stroke="#94a3b8" stroke-width="5"/>'
      + '<text x="600" y="475" text-anchor="middle" fill="#334155" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="84" font-weight="700">' + xmlEscape(label) + '</text>'
      + '<text x="600" y="560" text-anchor="middle" fill="#64748b" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="28">预览转换器不可用，可点击 Illustrator 编辑打开原文件</text>'
      + '<text x="600" y="635" text-anchor="middle" fill="#94a3b8" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="22">' + xmlEscape(title) + '</text></svg>';
    await writeFile(target, svg, 'utf8');
    return target;
  };
  const documentPreviewPath = async (path, mtimeMs, kind) => {
    await mkdir(previewCache, { recursive: true });
    const key = createHash('sha1').update(path + ':' + String(Math.round(mtimeMs || 0)) + ':' + kind).digest('hex');
    const target = join(previewCache, key + '.jpg');
    try { await access(target); return { path: target, mime: 'image/jpeg' }; } catch (err) {}
    let pdftoppm = '';
    try { pdftoppm = await ctx.subprocess.resolveExecutable('pdftoppm'); } catch (err) {}
    if (pdftoppm) {
      const result = await runProcessWithTimeout(pdftoppm, ['-f', '1', '-l', '1', '-singlefile', '-jpeg', '-scale-to', '2400', path, join(previewCache, key)], dirname(path), 20000);
      if (result.exitCode === 0) {
        try { await access(target); return { path: target, mime: 'image/jpeg' }; } catch (err) {}
      }
    }
    // 跨平台兜底：用插件自带 Python 的 PyMuPDF 渲染首页。
    // Windows 既没有 pdftoppm(Poppler) 也没有 macOS 的 qlmanage，此前 .ai/.pdf
    // 只能落占位图 —— 画布上永远是"预览转换器不可用"，改了源文件也看不出变化。
    // AI 文件在 PDF 兼容模式下（Illustrator 默认）文件头就是 %PDF-x.y，可直接解析。
    // ⚠️ 仅非 macOS：macOS 保持 1.8.0 的原路径（pdftoppm -> qlmanage -> 占位图）不变，
    // 避免 mac 上多出一条未验证的渲染分支 —— 本仓库的跨平台兼容承诺是"mac 行为零变化"。
    if (!isMac) try {
      const python = await resolvePython(ctx);
      const renderer = join(PLUGIN_ROOT, 'scripts', 'document_preview.py');
      const rendered = await runProcessWithTimeout(
        python.executable,
        [...python.prefixArgs, renderer, '--input', path, '--output', target, '--max', '2400'],
        dirname(path),
        60000
      );
      if (rendered.exitCode === 0) {
        try { await access(target); return { path: target, mime: 'image/jpeg' }; } catch (err) {}
      }
    } catch (err) {}
    // 旧版 AI 是 PostScript，不一定能被 Poppler 直接读取；尝试 Quick Look，
    // 但严格限时，避免外置盘/损坏文件让项目扫描长期卡住。
    if (kind === 'ai' && isMac) {
      try {
        const quickLook = await ctx.subprocess.resolveExecutable('qlmanage');
        const quickLookDir = join(previewCache, key + '-ql');
        await mkdir(quickLookDir, { recursive: true });
        const result = await runProcessWithTimeout(quickLook, ['-t', '-s', '2400', '-o', quickLookDir, path], dirname(path), 5000);
        if (result.exitCode === 0) {
          const entries = await readdir(quickLookDir, { withFileTypes: true });
          const rendered = entries.find((entry) => entry.isFile() && /\.(png|jpe?g)$/i.test(entry.name));
          if (rendered) {
            const renderedPath = join(quickLookDir, rendered.name);
            await rename(renderedPath, target);
            return { path: target, mime: 'image/jpeg' };
          }
        }
      } catch (err) {}
    }
    const fallback = await documentFallbackPreviewPath(path, mtimeMs, kind);
    return { path: fallback, mime: 'image/svg+xml' };
  };
  /**
   * SVG 预览：先把**外链图片内联**再返回。
   * Illustrator「导出为 SVG」默认把位图写成外链（`xlink:href="xxx.png"`）——同目录下 AI
   * 自己能显示，但画布拿到的是一份独立 SVG（HTTP 响应或 data URL），相对路径无从解析，
   * 表现就是「只看到文字、背景整块丢失」。插件自己生成的 SVG 本来是内嵌的
   * （scripts/export_text_svg.py），用户一旦在 AI 里重新导出就会退化成外链。
   * 没有可内联项（或处理失败）时直接用原文件，不做无谓缓存。
   */
  const svgInlinePreviewPath = async (path, mtimeMs) => {
    await mkdir(previewCache, { recursive: true });
    const key = createHash('sha1').update('svg:' + path + ':' + String(Math.round(mtimeMs || 0))).digest('hex');
    const target = join(previewCache, key + '.svg');
    try { await access(target); return { path: target, mime: 'image/svg+xml' }; } catch (err) {}
    try {
      const python = await resolvePython(ctx);
      const renderer = join(PLUGIN_ROOT, 'scripts', 'svg_inline.py');
      const result = await runProcessWithTimeout(
        python.executable,
        [...python.prefixArgs, renderer, '--input', path, '--output', target],
        dirname(path),
        60000
      );
      const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
      let payload = null;
      try { payload = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch (err) { payload = null; }
      if (result.exitCode === 0 && payload && payload.success === true && payload.changed === true) {
        try { await access(target); return { path: target, mime: 'image/svg+xml' }; } catch (err) {}
      }
    } catch (err) {}
    return { path, mime: 'image/svg+xml' };
  };
  const scanProjectImages = async (root) => {
    const found = [];
    const assetsRoot = join(root, 'assets');
    const walk = async (directory, depth) => {
      if (found.length >= 500 || depth > 8) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (found.length >= 500) break;
        if (entry.name.startsWith('.')) continue;
        const full = join(directory, entry.name);
        if (entry.isDirectory()) {
          // 这些目录通常是依赖/缓存，不可能是项目素材；跳过后可避免
          // 导入一个代码仓库或大目录时递归扫描数万项文件。
          if (entry.name === 'node_modules' || entry.name === '__pycache__' || entry.name === '.cache') continue;
          if (depth === 0 && (entry.name === 'outputs' || entry.name === '画布回收站' || entry.name === '画布备份' || entry.name === 'DSH聊天生成图片')) continue;
          await walk(full, depth + 1);
        } else if (entry.isFile() && isSourceImagePath(entry.name)) {
          const info = await stat(full);
          found.push({ path: full, name: entry.name, mtime: info.mtimeMs, size: info.size, kind: sourceKindOf(entry.name), managed: isPathWithin(assetsRoot, full), url: previewUrl(full, info.mtimeMs) });
        }
      }
    };
    await walk(root, 0);
    return found;
  };
  // 导入项目后首轮同步可能与项目轮询同时到达；共享同一轮扫描结果，
  // 避免同一目录在短时间内被重复递归读取。
  const scanInFlight = new Map();
  const scanProjectImagesShared = (root) => {
    const key = String(root || '');
    const running = scanInFlight.get(key);
    if (running) return running;
    const promise = scanProjectImages(root).finally(() => {
      if (scanInFlight.get(key) === promise) scanInFlight.delete(key);
    });
    scanInFlight.set(key, promise);
    return promise;
  };
  const writeManagedImage = async (projectDir, requestedName, dataURL) => {
    const decoded = decodeImageData(dataURL);
    if (!decoded) throw new Error('图片数据无效或超过 32MB');
    const assetsDir = join(projectDir, 'assets');
    await mkdir(assetsDir, { recursive: true });
    const wanted = safeImageName(requestedName, decoded.ext);
    const suffixAt = wanted.lastIndexOf('.');
    const base = suffixAt > 0 ? wanted.slice(0, suffixAt) : wanted;
    const suffix = suffixAt > 0 ? wanted.slice(suffixAt) : '.' + decoded.ext;
    let saved = '';
    for (let index = 1; index <= 1000; index += 1) {
      const name = index === 1 ? base + suffix : base + '-' + index + suffix;
      const target = join(assetsDir, name);
      try { await writeFile(target, decoded.bytes, { flag: 'wx' }); saved = target; break; }
      catch (err) { if (!err || err.code !== 'EEXIST') throw err; }
    }
    if (!saved) throw new Error('无法生成不重名的项目图片');
    const info = await stat(saved);
    return { path: saved, name: saved.slice(saved.lastIndexOf('/') + 1), mtime: info.mtimeMs, size: info.size, kind: 'image', managed: true, url: previewUrl(saved, info.mtimeMs) };
  };
  const writeManagedSource = async (projectDir, requestedName, bytes, fallbackExt) => {
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('源文件为空或超过 128MB');
    const assetsDir = join(projectDir, 'assets');
    await mkdir(assetsDir, { recursive: true });
    const wanted = safeImageName(requestedName, fallbackExt || 'svg');
    const wantedExt = extOf(wanted);
    if (!SOURCE_EXTENSIONS.has(wantedExt)) throw new Error('仅支持 PSD、SVG、PDF、AI 及常见图片格式');
    const suffixAt = wanted.lastIndexOf('.');
    const base = suffixAt > 0 ? wanted.slice(0, suffixAt) : wanted;
    const suffix = suffixAt > 0 ? wanted.slice(suffixAt) : '.' + wantedExt;
    let saved = '';
    for (let index = 1; index <= 1000; index += 1) {
      const name = index === 1 ? base + suffix : base + '-' + index + suffix;
      const target = join(assetsDir, name);
      try { await writeFile(target, bytes, { flag: 'wx' }); saved = target; break; }
      catch (err) { if (!err || err.code !== 'EEXIST') throw err; }
    }
    if (!saved) throw new Error('无法生成不重名的项目文件');
    const info = await stat(saved);
    return { path: saved, name: basename(saved), mtime: info.mtimeMs, size: info.size, kind: sourceKindOf(saved), managed: true, url: previewUrl(saved, info.mtimeMs) };
  };
  const writeManagedSvg = async (projectDir, requestedName, svgText) => {
    const text = String(svgText || '');
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!/<svg(?:\s|>)/i.test(text) || bytes === 0 || bytes > MAX_IMAGE_BYTES) throw new Error('矢量化程序返回了无效或过大的 SVG');
    const assetsDir = join(projectDir, 'assets');
    await mkdir(assetsDir, { recursive: true });
    const wanted = safeImageName(requestedName, 'svg');
    const suffixAt = wanted.lastIndexOf('.');
    const base = suffixAt > 0 ? wanted.slice(0, suffixAt) : wanted;
    let saved = '';
    for (let index = 1; index <= 1000; index += 1) {
      const name = index === 1 ? base + '.svg' : base + '-' + index + '.svg';
      const target = join(assetsDir, name);
      try { await writeFile(target, text, { flag: 'wx' }); saved = target; break; }
      catch (err) { if (!err || err.code !== 'EEXIST') throw err; }
    }
    if (!saved) throw new Error('无法生成不重名的矢量文件');
    const info = await stat(saved);
    return { path: saved, name: basename(saved), mtime: info.mtimeMs, size: info.size, kind: 'svg', managed: true, url: previewUrl(saved, info.mtimeMs) };
  };
  const flattenRecycleBin = async (projectDir) => {
    const recycleDir = join(projectDir, '画布回收站');
    let rootEntries;
    try { rootEntries = await readdir(recycleDir, { withFileTypes: true }); } catch (err) { return 0; }
    let moved = 0;
    const moveNested = async (directory) => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const source = join(directory, entry.name);
        if (entry.isDirectory()) {
          await moveNested(source);
          await rmdir(source).catch(() => {});
        } else if (entry.isFile() && isSourceImagePath(entry.name)) {
          const dot = entry.name.lastIndexOf('.');
          const base = dot > 0 ? entry.name.slice(0, dot) : entry.name;
          const suffix = dot > 0 ? entry.name.slice(dot) : '';
          let target = join(recycleDir, entry.name);
          for (let index = 2; index <= 1000; index += 1) {
            try { await access(target); target = join(recycleDir, base + '-旧回收-' + index + suffix); }
            catch (err) { break; }
          }
          await rename(source, target);
          moved += 1;
        }
      }
    };
    for (const entry of rootEntries) if (entry.isDirectory()) {
      const nested = join(recycleDir, entry.name);
      await moveNested(nested);
      await rmdir(nested).catch(() => {});
    }
    return moved;
  };

  const jobs = createJobManager();
  const pythonTools = createPythonToolRegistry({ pluginRoot: PLUGIN_ROOT, resolvePython: (c) => resolvePython(c || ctx), run: runProcessWithTimeout });
  // Adobe 桥接（Photoshop/Illustrator 脚本面板 ⇄ 画布）：纯文件夹传输，协议见 adobe-bridge/PROTOCOL.md。
  // runProcess/resolveExecutable 用于"远程驱动"（画布直接取 PS 图层 / 直接置入返回件），见服务内注释。
  const adobeBridge = createAdobeBridge({
    pluginRoot: PLUGIN_ROOT,
    previewUrl,
    runProcess: runProcessWithTimeout,
    resolveExecutable: (name) => ctx.subprocess.resolveExecutable(name)
  });
  // 启动时静默确保 Adobe 脚本已安装（幂等：版本一致且文件在位就跳过；不会弹窗、不提权）。
  adobeBridge.ensureInstalled().catch(() => {});
  // 本地工具链后台预置:镜像兜底下载部署并自检,首次点击即就绪;任何失败只记状态不阻断。
  startToolchainProvisioning(ctx);
  const h = { adobeBridge, jobs, pythonTools, chatContexts, ctx, documentPreviewPath, svgInlinePreviewPath, flattenRecycleBin, previewUrl, progressPathFor, projectDirectory, projectStatePath, psdPreviewPath, runProcess, runProcessWithTimeout, scanProjectImagesShared, stateWriteChains, writeManagedImage, writeManagedSource, writeManagedSvg, writeProgressFile };
  const router = createRouter();
  router.use(jobTrackingMiddleware(jobs));
  register0(router, h);
  register1(router, h);
  register2(router, h);
  register3(router, h);
  register4(router, h);
  register5(router, h);
  register6(router, h);
  register7(router, h);
  registerAdobeBridge(router, h);
  registerJobs(router, h);
  registerContracts(router, h);

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-canvas',
    handler: async (req, res) => {
      const CORS = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      };
      if (req.method === 'OPTIONS') { respond(res, 204, CORS, ''); return; }
      try {
        const raw = String(req.url || '/');
        const qi = raw.indexOf('?');
        const pathname = qi === -1 ? raw : raw.slice(0, qi);
        const query = qi === -1 ? '' : raw.slice(qi + 1);
        const sameOriginRequest = () => {
          const origin = String(req.headers && req.headers.origin || '').trim();
          if (!origin) return true;
          try { return new URL(origin).host === String(req.headers && req.headers.host || ''); } catch { return false; }
        };

        const handled = await router.dispatch(req, res, { pathname, query, CORS, sameOriginRequest });
        if (handled) return;
        respond(res, 404, { ...CORS, 'content-type': 'text/plain' }, 'not found');
      } catch (err) {
        respond(res, 500, { ...CORS, 'content-type': 'text/plain' }, 'internal error');
      }
    }
  });
  // imagegen 只在具体 Agent 作用域内覆盖。设计模式关闭时代理回原始工具，
  // 因而不会修改 DSH 或 dsh-codex 的全局注册，也便于插件卸载/更新。
  try {
    ctx.inject(['tools', 'fs', 'attachments', 'agents'], (toolCtx) => {
      // Image-generation routing is an optional enhancement.  A tool/schema
      // incompatibility in a particular DSH build must not abort the whole
      // canvas plugin (which would put Desktop into Recovery Mode).
      try {
        installChatImageRouter(toolCtx, chatContextFor);
      } catch (err) {
        try { console.warn('[canvas-workbench] image router disabled:', err && err.message || String(err)); } catch (_) {}
      }
    });
  } catch (err) {
    // 老版本 DSH 缺少工具注入能力时，基础画布仍应正常加载。
  }
  // 注意：ctx.effect 会立即执行回调，返回的 disposer 才是清理函数。
  // 这里回调只返回 dispose（不执行），fiber 卸载时才真正销毁路由。
  ctx.effect(() => dispose);
}

export { apply, inject, name };
