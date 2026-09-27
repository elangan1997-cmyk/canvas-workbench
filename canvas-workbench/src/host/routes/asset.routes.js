// 自 lib/index.js apply() 机械迁移（v1.8 Phase 2）：每个 handler 体逐字未改，
// 原来的 `if (pathname === … && req.method === …) { … }` 外壳由 router 负责。
import { isAbsolutePath, isWindows, revealFile } from '../../../lib/platform.js';
import { access, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { expandHome, isPathWithin, normalizeLocalPath, pathComparable } from '../../shared/utils/paths.js';
import { parseQuery, readBody, respond } from '../server/http.js';
import { MAX_IMAGE_BYTES, MAX_SOURCE_BYTES, extOf, isImagePath, isSourceImagePath, mimeOf, sourceKindOf } from '../../shared/utils/image-types.js';
import { decodeSourceData, safeImageName } from '../../shared/utils/data-url.js';
import { name } from '../plugin-meta.js';

export function register(router, h) {
  const { ctx, documentPreviewPath, svgInlinePreviewPath, flattenRecycleBin, previewUrl, projectDirectory, psdPreviewPath, runProcess, writeManagedImage, writeManagedSource } = h;
  router.add({ method: 'GET', path: '/dsh-canvas/image', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          const path = normalizeLocalPath(parseQuery(query).path || '');
          if (!isImagePath(path)) { respond(res, 400, { ...CORS, 'content-type': 'text/plain' }, 'bad image path'); return; }
          try {
            // ctx.fs 会按会话权限解析路径，某些外置盘会在文件实际可读时仍返回 not found。
            // 该路由本机插件的 localhost 接口使用；先限定为绝对普通文件和 32MB，
            // 再直接读取，避免 /Volumes 下的真实生成图在聊天中变成破图。
            if (!isAbsolutePath(path)) throw new Error('absolute image path required');
            const info = await stat(path);
            if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) throw new Error('invalid image file');
            const bytes = await readFile(path);
            respond(res, 200, {
              ...CORS,
              'content-type': mimeOf(path),
              'content-length': String(bytes.byteLength),
              'cache-control': 'no-store'
            }, bytes);
          } catch (err) {
            respond(res, 404, { ...CORS, 'content-type': 'text/plain' }, 'image not found');
          }
          return;
  });

  router.add({ method: 'GET', path: '/dsh-canvas/preview', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          const path = expandHome(parseQuery(query).path || '');
          if (!isSourceImagePath(path)) { respond(res, 400, { ...CORS, 'content-type': 'text/plain' }, 'bad preview path'); return; }
          try {
            const info = await stat(path);
            const kind = sourceKindOf(path);
            let target = path;
            let contentType = mimeOf(path);
            if (kind === 'psd') {
              const rendered = await psdPreviewPath(path, info.mtimeMs);
              target = rendered.path;
              contentType = rendered.mime;
            } else if (kind === 'pdf' || kind === 'ai') {
              const rendered = await documentPreviewPath(path, info.mtimeMs, kind);
              target = rendered.path;
              contentType = rendered.mime;
            } else if (kind === 'svg') {
              // Illustrator 导出的 SVG 把位图写成外链，画布/浏览器解析不了相对路径
              // → 背景整块丢失。先内联成 data URL 再返回（无外链时直接用原文件）。
              const rendered = await svgInlinePreviewPath(path, info.mtimeMs);
              target = rendered.path;
              contentType = rendered.mime;
            }
            const bytes = await readFile(target);
            if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('preview too large');
            respond(res, 200, { ...CORS, 'content-type': contentType || 'application/octet-stream', 'content-length': String(bytes.byteLength), 'cache-control': 'no-store' }, bytes);
          } catch (err) {
            respond(res, 404, { ...CORS, 'content-type': 'text/plain' }, 'preview unavailable');
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/import-file', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('当前聊天没有画布项目');
            let sourcePath = normalizeLocalPath(body.sourcePath);
            let sourceName = String(body.name || '').trim();
            let bytes = null;
            if (sourcePath && isSourceImagePath(sourcePath)) {
              try {
                const info = await stat(sourcePath);
                if (!info.isFile() || info.size <= 0 || info.size > MAX_SOURCE_BYTES) throw new Error('源文件为空或超过 128MB');
                bytes = await readFile(sourcePath);
                sourceName = sourceName || basename(sourcePath);
              } catch (err) {
                // 桌面端可能只暴露文件内容、不暴露绝对路径；有 dataURL 时继续走内容回退。
                if (!body.dataURL) throw err;
                sourcePath = '';
              }
            }
            const fallbackExt = String(body.kind || extOf(sourceName) || 'svg').toLowerCase().replace(/^\./, '');
            if (!bytes) {
              const decoded = decodeSourceData(body.dataURL, sourceName, fallbackExt);
              if (!decoded) throw new Error('文件数据无效或格式不受支持（支持 PSD、SVG、PDF、AI）');
              bytes = decoded.bytes;
              sourceName = sourceName || '画布文件.' + decoded.ext;
            }
            const image = await writeManagedSource(projectDir, sourceName || ('画布文件.' + fallbackExt), bytes, fallbackExt);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, image }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/check-sources', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const sources = Array.isArray(body.sources) ? body.sources.slice(0, 500) : [];
            const changed = [];
            for (const source of sources) {
              const path = expandHome(String(source && source.path || ''));
              if (!isSourceImagePath(path)) continue;
              try {
                const info = await stat(path);
                const previous = Number(source.mtime || 0);
                const previousSize = Number(source.size || 0);
                if (Math.abs(info.mtimeMs - previous) > 1 || (previousSize > 0 && info.size !== previousSize)) changed.push({ elementId: source.elementId, path, name: source.name || '', mtime: info.mtimeMs, size: info.size, url: previewUrl(path, info.mtimeMs), kind: sourceKindOf(path) });
              } catch (err) {
                changed.push({ elementId: source.elementId, path, missing: true });
              }
            }
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, changed }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/materialize-image', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('当前聊天没有画布项目');
            const image = await writeManagedImage(projectDir, body.name || '画布图片.png', body.dataURL);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, image }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/archive-images', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('当前聊天没有画布项目');
            await flattenRecycleBin(projectDir);
            const paths = Array.isArray(body.paths) ? [...new Set(body.paths.map((item) => expandHome(String(item || ''))))].slice(0, 500) : [];
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const recycleDir = join(projectDir, '画布回收站');
            const records = [];
            for (const source of paths) {
              if (!source || !source.startsWith(projectDir + '/') || !isSourceImagePath(source) || source.includes('/画布回收站/')) continue;
              try {
                await access(source);
                await mkdir(recycleDir, { recursive: true });
                const originalName = source.slice(source.lastIndexOf('/') + 1);
                let target = join(recycleDir, originalName);
                for (let index = 1; index <= 1000; index += 1) {
                  try { await access(target); target = join(recycleDir, originalName.replace(/(\.[^.]+)?$/, '-删除于-' + stamp + (index > 1 ? '-' + index : '') + '$1')); }
                  catch (err) { break; }
                }
                await rename(source, target);
                records.push({ original: source, archived: target });
              } catch (err) {}
            }
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, recycle: recycleDir, records }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/restore-image', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            const archived = expandHome(String(body.archived || ''));
            const original = expandHome(String(body.original || ''));
            if (!projectDir || !archived.startsWith(join(projectDir, '画布回收站') + '/') || !original.startsWith(projectDir + '/')) throw new Error('恢复路径无效');
            await mkdir(dirname(original), { recursive: true });
            try { await access(original); throw new Error('原位置已有同名文件'); } catch (err) { if (err && err.message === '原位置已有同名文件') throw err; }
            await rename(archived, original);
            const info = await stat(original);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, path: original, mtime: info.mtimeMs, url: previewUrl(original, info.mtimeMs) }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/reveal-file', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const target = expandHome(String(body.path || ''));
            if (!target) throw new Error('缺少文件路径');
            const info = await stat(target);
            if (!info.isFile()) throw new Error('目标不是文件');
            const result = await revealFile(ctx, runProcess, target, dirname(target));
            if (result.exitCode !== 0) throw new Error(result.stderr.trim() || (isWindows ? '资源管理器定位失败' : '访达定位失败'));
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, path: target }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/rename-image', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req));
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('当前聊天没有画布项目');
            const assetsDir = join(projectDir, 'assets');
            await mkdir(assetsDir, { recursive: true });
            const oldName = safeImageName(body.oldName || '', body.ext || 'png');
            const linkedSource = expandHome(String(body.sourcePath || ''));
            const nameEquals = (left, right) => isWindows
              ? String(left || '').toLowerCase() === String(right || '').toLowerCase()
              : String(left || '') === String(right || '');
            const sourceInsideProject = linkedSource && isPathWithin(projectDir, linkedSource) && isSourceImagePath(linkedSource);
            const oldExt = sourceInsideProject ? extOf(linkedSource) : (extname(oldName).replace(/^\./, '') || 'png');
            const requested = String(body.newName || '').replace(/\.[a-zA-Z0-9]+$/, '');
            const newName = safeImageName(requested, oldExt);
            let renamedSource = linkedSource;
            if (sourceInsideProject) {
              await stat(linkedSource);
              const targetSource = join(dirname(linkedSource), newName);
              if (pathComparable(targetSource) !== pathComparable(linkedSource)) {
                try { await access(targetSource); throw new Error('源文件所在目录中已存在同名文件'); } catch (err) { if (err && err.message === '源文件所在目录中已存在同名文件') throw err; }
                await rename(linkedSource, targetSource);
                renamedSource = targetSource;
              }
            }
            // 有明确的项目源路径时，上面已经完成了唯一一次磁盘重命名。
            // 不能再按旧文件名扫描 assets：扫描会看到刚改好的 newName，
            // 把它误判成同名冲突，表现为 PNG 重命名失败、画布与文件夹不同步。
            if (!sourceInsideProject) {
              const entries = await readdir(assetsDir, { withFileTypes: true });
              const safeId = String(body.fileId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
              const source = entries.find((entry) => entry.isFile() && nameEquals(entry.name, oldName))
                || entries.find((entry) => entry.isFile() && safeId && entry.name.startsWith(safeId + '.'));
              const collision = entries.find((entry) => entry.isFile() && nameEquals(entry.name, newName) && (!source || !nameEquals(entry.name, source.name)));
              if (collision) throw new Error('项目图片目录中已存在同名文件');
              if (source) {
                const sourcePath = join(assetsDir, source.name);
                const targetPath = join(assetsDir, newName);
                if (source.name !== newName) await rename(sourcePath, targetPath);
                // 旧快照可能只有文件名/fileId，没有 dshSourcePath；重命名后
                // 必须把实际 assets 路径回传给画布，否则下一轮同步会再次物化，
                // 生成重复 PNG 并让画布与文件夹脱节。
                renamedSource = targetPath;
              }
            }
            const resultPath = renamedSource || join(assetsDir, newName);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, name: newName, path: resultPath, sourcePath: resultPath }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  // v1.8：按文件名在项目/工作区常见目录中找回图片（§28 形状）。
  // 场景：AI 文字里写了“计划路径”或附件记录的 sourcePath 已被移动/删除，
  // 而同名文件实际在 DSH聊天生成图片/ 或 assets/ 里。客户端图片输出的最后一级回退调用它。
  router.add({ method: 'GET', path: '/dsh-canvas/resolve-image', prefix: false }, async (req, res, { query, CORS }) => {
    const fail = (status, code, message) => respond(res, status, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: false, error: { code, message } }));
    const params = parseQuery(query);
    const wanted = basename(String(params.name || '')).trim();
    if (!wanted || wanted === '.' || wanted === '..' || !isImagePath(wanted)) { fail(400, 'INVALID_REQUEST', '缺少合法图片文件名'); return; }
    const projectDir = projectDirectory(expandHome(params.cwd || ''), params.project || '');
    const cwd = expandHome(params.cwd || '');
    const roots = [];
    const push = (dir, priority) => { if (dir) roots.push({ dir: dir.replace(/[\/]+$/, ''), priority }); };
    if (projectDir) {
      push(join(projectDir, 'DSH聊天生成图片'), 0);
      push(join(projectDir, 'assets'), 1);
      push(projectDir, 2);
    }
    push(join(cwd, 'DSH聊天生成图片'), 3);
    if (cwd) push(cwd, 4);
    const stripCopy = (value) => String(value).toLowerCase().replace(/-(\d+)(\.[a-z0-9]+)$/i, '$2');
    const wantedExact = String(wanted).toLowerCase();
    const wantedBase = stripCopy(wanted);
    const seen = new Set();
    let exact = [], fuzzy = [];
    let budget = 4000;
    for (const { dir } of roots.sort((a, b) => a.priority - b.priority)) {
      if (seen.has(dir) || budget <= 0) continue;
      seen.add(dir);
      // 有界 BFS：优先精确命中，深度 ≤ 3，跳过隐藏目录与回收站/备份。
      const queue = [[dir, 0]];
      while (queue.length && budget > 0) {
        const [current, depth] = queue.shift();
        let entries;
        try { entries = await readdir(current, { withFileTypes: true }); } catch (err) { continue; }
        for (const entry of entries) {
          budget -= 1;
          if (budget <= 0) break;
          if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '画布回收站' || entry.name === '画布备份') continue;
          const full = join(current, entry.name);
          if (entry.isDirectory()) { if (depth < 3) queue.push([full, depth + 1]); continue; }
          if (!entry.isFile() || !isImagePath(entry.name)) continue;
          const lower = entry.name.toLowerCase();
          if (lower === wantedExact) exact.push(full);
          else if (stripCopy(entry.name) === wantedBase) fuzzy.push(full);
        }
      }
      if (exact.length) break;
    }
    // 会话 cwd 与画布项目常是同级的两个项目目录（例如 8d / 8d过滤棉）；
    // 附件原图往往归档在兄弟项目的 DSH聊天生成图片/ 下。主搜索找不到时，
    // 在父目录的兄弟项目里做精确同名探测（只查这两个约定目录，不递归整棵树）。
    const trySiblingArchives = async () => {
      const parents = [...new Set([projectDir && dirname(projectDir), cwd && dirname(cwd)].filter(Boolean))];
      for (const parent of parents) {
        let siblings;
        try { siblings = await readdir(parent, { withFileTypes: true }); } catch (err) { continue; }
        for (const sibling of siblings) {
          if (!sibling.isDirectory() || sibling.name.startsWith('.')) continue;
          for (const folder of ['DSH聊天生成图片', 'assets']) {
            const candidate = join(parent, sibling.name, folder, wanted);
            try { const info = await stat(candidate); if (info.isFile()) return candidate; } catch (err) {}
          }
        }
      }
      return '';
    };
    let pool = exact.length ? exact : fuzzy;
    if (!pool.length) {
      const sibling = await trySiblingArchives();
      if (sibling) pool = [sibling];
    }
    if (!pool.length) { fail(404, 'ASSET_NOT_FOUND', '未找到同名图片：' + wanted); return; }
    let best = pool[0];
    let bestMtime = -1;
    for (const candidate of pool) {
      try { const info = await stat(candidate); if (info.mtimeMs > bestMtime) { bestMtime = info.mtimeMs; best = candidate; } } catch (err) {}
    }
    respond(res, 200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: true, data: { path: best, exact: Boolean(exact.length) } }));
  });
}
