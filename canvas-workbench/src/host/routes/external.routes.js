// 自 lib/index.js apply() 机械迁移（v1.8 Phase 2）：每个 handler 体逐字未改，
// 原来的 `if (pathname === … && req.method === …) { … }` 外壳由 router 负责。
import { open, readdir, stat } from 'node:fs/promises';
import { isWindows, openWithSystem } from '../../../lib/platform.js';
import { basename, dirname, join } from 'node:path';
import { readBody, respond } from '../server/http.js';
import { expandHome, normalizeLocalPath } from '../../shared/utils/paths.js';
import { MAX_SOURCE_BYTES, extOf, isSourceImagePath, sourceKindOf } from '../../shared/utils/image-types.js';
import { name } from '../plugin-meta.js';

export function register(router, h) {
  const { ctx, previewUrl, projectDirectory, runProcess, writeManagedImage } = h;
  router.add({ method: 'POST', path: '/dsh-canvas/open-in-photoshop', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('当前聊天没有画布项目');

            let path = expandHome(String(body.sourcePath || ''));
            let materialized = false;
            if (path && isSourceImagePath(path)) {
              const info = await stat(path);
              if (!info.isFile()) path = '';
            } else {
              path = '';
            }
            if (!path) {
              const image = await writeManagedImage(projectDir, body.name || 'Photoshop-编辑.png', body.dataURL);
              path = image.path;
              materialized = true;
            }

            let opened = false;
            let lastError = '';
            if (isWindows) {
              const result = await openWithSystem(ctx, runProcess, path, dirname(path), { app: 'photoshop' });
              opened = result.ok === true;
              lastError = result.error || result.stderr.trim();
            } else {
              const opener = await ctx.subprocess.resolveExecutable('open');
              const attempts = [['-b', 'com.adobe.Photoshop', path], ['-a', 'Adobe Photoshop 2026', path], ['-a', 'Adobe Photoshop 2025', path], ['-a', 'Adobe Photoshop', path]];
              for (const args of attempts) {
                const result = await runProcess(opener, args, dirname(path));
                if (result.exitCode === 0) { opened = true; break; }
                lastError = result.stderr.trim() || lastError;
              }
            }
            if (!opened) throw new Error(lastError || '未找到 Adobe Photoshop，请先安装或启动 Photoshop');

            const info = await stat(path);
            const watchDirectory = dirname(path);
            const psdBaseline = [];
            try {
              const siblings = await readdir(watchDirectory, { withFileTypes: true });
              for (const sibling of siblings) {
                // macOS 在部分磁盘/共享目录会生成 AppleDouble `._文件名`
                // 元数据。它不是可编辑 PSD，绝不能进入基线或画布。
                if (!sibling.isFile() || sibling.name.startsWith('.') || extOf(sibling.name) !== 'psd') continue;
                const siblingPath = join(watchDirectory, sibling.name);
                const siblingInfo = await stat(siblingPath);
                psdBaseline.push({ path: siblingPath, mtime: siblingInfo.mtimeMs, size: siblingInfo.size });
              }
            } catch (err) {}
            const assetsDir = join(projectDir, 'assets');
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({
              ok: true,
              image: {
                path,
                name: basename(path),
                mtime: info.mtimeMs,
                size: info.size,
                kind: sourceKindOf(path),
                managed: path === assetsDir || path.startsWith(assetsDir + (isWindows ? '\\' : '/')),
                url: previewUrl(path, info.mtimeMs)
              },
              materialized,
              photoshopWatch: { directory: watchDirectory, startedAt: Date.now(), baseline: psdBaseline }
            }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/photoshop-outputs', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            const directory = normalizeLocalPath(body.directory);
            if (!projectDir || !directory) throw new Error('缺少 Photoshop 跟踪目录');
            const directoryInfo = await stat(directory);
            if (!directoryInfo.isDirectory()) throw new Error('Photoshop 跟踪目录不存在');
            const baseline = new Map((Array.isArray(body.baseline) ? body.baseline : []).slice(0, 1000).map((item) => [String(item && item.path || ''), item || {}]));
            const entries = await readdir(directory, { withFileTypes: true });
            const outputs = [];
            for (const entry of entries) {
              if (!entry.isFile() || entry.name.startsWith('.') || extOf(entry.name) !== 'psd') continue;
              const path = join(directory, entry.name);
              const info = await stat(path);
              if (!info.isFile() || info.size <= 0 || info.size > MAX_SOURCE_BYTES) continue;
              const previous = baseline.get(path);
              const changed = !previous || Math.abs(Number(previous.mtime || 0) - info.mtimeMs) > 1 || Number(previous.size || 0) !== info.size;
              if (!changed) continue;
              outputs.push({ path, name: entry.name, mtime: info.mtimeMs, size: info.size, kind: 'psd', managed: path.startsWith(join(projectDir, 'assets') + '/'), url: previewUrl(path, info.mtimeMs) });
            }
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, outputs }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/open-in-illustrator', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            const path = expandHome(String(body.sourcePath || ''));
            const kind = sourceKindOf(path);
            if (!projectDir || !path || !isSourceImagePath(path)) throw new Error('Illustrator 编辑需要项目中的源文件（图片/SVG/PDF/AI/PSD 均可）');
            const info = await stat(path);
            if (!info.isFile()) throw new Error('源文件不存在');
            let opened = false;
            let lastError = '';
            if (isWindows) {
              const result = await openWithSystem(ctx, runProcess, path, dirname(path), { app: 'illustrator' });
              opened = result.ok === true;
              lastError = result.error || result.stderr.trim();
            } else {
              const opener = await ctx.subprocess.resolveExecutable('open');
              const attempts = [['-b', 'com.adobe.Illustrator', path], ['-a', 'Adobe Illustrator 2026', path], ['-a', 'Adobe Illustrator 2025', path], ['-a', 'Adobe Illustrator 2024', path], ['-a', 'Adobe Illustrator', path]];
              for (const args of attempts) {
                const result = await runProcess(opener, args, dirname(path));
                if (result.exitCode === 0) { opened = true; break; }
                lastError = result.stderr.trim() || lastError;
              }
            }
            if (!opened) throw new Error(lastError || '未找到 Adobe Illustrator，请先安装或启动 Illustrator');
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, path, name: basename(path), kind, mtime: info.mtimeMs, url: previewUrl(path, info.mtimeMs) }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });
}
