// 自 lib/index.js apply() 机械迁移（v1.8 Phase 2）：每个 handler 体逐字未改，
// 原来的 `if (pathname === … && req.method === …) { … }` 外壳由 router 负责。
import { isAbsolutePath, isWindows, openFolder, pickFolder } from '../../../lib/platform.js';
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parseQuery, readBody, respond } from '../server/http.js';
import { expandHome, normalizeLocalPath } from '../../shared/utils/paths.js';
import { name } from '../plugin-meta.js';
import { mimeOf } from '../../shared/utils/image-types.js';
import { readCanvasProjectElements } from '../services/project-store.js';

export function register(router, h) {
  const { ctx, flattenRecycleBin, projectDirectory, projectStatePath, runProcess, scanProjectImagesShared, stateWriteChains } = h;
  // 仅保留画布“选择项目目录”所需的最小目录枚举能力。
  // 独立 home-explorer 文件浏览器已移除，避免额外 UI 和重复注入。
  router.add({ method: 'GET', path: '/dsh-canvas/list-directories', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          if (!sameOriginRequest()) {
            respond(res, 403, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ error: 'forbidden' }));
            return;
          }
          const path = normalizeLocalPath(parseQuery(query).path || '');
          if (!path || !isAbsolutePath(path)) {
            respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ error: 'missing-or-invalid-path' }));
            return;
          }
          try {
            const entries = await readdir(path, { withFileTypes: true });
            const directories = entries
              .filter((entry) => entry.isDirectory())
              .map((entry) => ({ name: entry.name, type: 'directory', path: join(path, entry.name) }));
            respond(res, 200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ entries: directories }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/import-project', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            let selected = expandHome(typeof body.path === 'string' ? body.path : '');
            if (!selected) {
              selected = await pickFolder(ctx, runProcess, '选择要导入画布的项目文件夹');
            }
            const info = await stat(selected);
            if (!info.isDirectory()) throw new Error('选择的不是文件夹');
            await mkdir(join(selected, 'assets'), { recursive: true });
            await mkdir(join(selected, 'outputs'), { recursive: true });
            const images = await scanProjectImagesShared(selected);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, project: selected, images }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/project-files', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('当前聊天没有画布项目');
            const images = await scanProjectImagesShared(projectDir);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, project: projectDir, images }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/backup-canvas', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir || !body.snapshot) throw new Error('没有可备份的画布');
            const backupDir = join(projectDir, '画布备份');
            await mkdir(backupDir, { recursive: true });
            const name = 'canvas-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
            const path = join(backupDir, name);
            // 性能 v3：备份与主存一致，剥离有磁盘引用的图片 base64；
            // 服务端先验证文件真实存在（access），保证备份必定可还原。
            let snapshotOut = body.snapshot;
            try {
              if (snapshotOut && snapshotOut.files && typeof snapshotOut.files === 'object') {
                const pathByFileId = {};
                (Array.isArray(snapshotOut.elements) ? snapshotOut.elements : []).forEach((item) => {
                  if (!item || item.type !== 'image' || item.isDeleted || !item.fileId) return;
                  const p = item.customData && item.customData.dshSourcePath;
                  if (p && !pathByFileId[item.fileId]) pathByFileId[item.fileId] = String(p);
                });
                const nextFiles = {};
                let stripped = false;
                for (const [id, f] of Object.entries(snapshotOut.files)) {
                  const p = pathByFileId[id];
                  if (f && typeof f.dataURL === 'string' && f.dataURL.startsWith('data:') && p && mimeOf(p)) {
                    try { await access(p); nextFiles[id] = { id: f.id || id, mimeType: f.mimeType, dshPath: p, created: f.created, lastRetrieved: f.lastRetrieved }; stripped = true; continue; } catch (err) {}
                  }
                  nextFiles[id] = f;
                }
                if (stripped) snapshotOut = { ...snapshotOut, files: nextFiles };
              }
            } catch (err) {}
            await writeFile(path, JSON.stringify(snapshotOut), 'utf8');
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, path }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'GET', path: '/dsh-canvas/projects', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          const cwd = expandHome(parseQuery(query).cwd || '');
          if (!cwd) { respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ error: 'missing cwd' })); return; }
          try {
            const entries = await readdir(cwd, { withFileTypes: true });
            const projects = [];
            for (const entry of entries) {
              if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
              const dir = join(cwd, entry.name);
              const canvas = join(dir, 'canvas.json');
              try {
                const info = await stat(canvas);
                const elements = (await readCanvasProjectElements(canvas, info)).filter((item) => item && !item.isDeleted);
                projects.push({ name: entry.name, path: dir, elements: elements.length, images: elements.filter((item) => item.type === 'image').length, updatedAt: info.mtimeMs });
              } catch (err) {}
            }
            projects.sort((a, b) => b.updatedAt - a.updatedAt);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ projects }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/rename-project', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            const requested = String(body.name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().replace(/[. ]+$/g, '').slice(0, 80);
            if (!projectDir || !requested) throw new Error('项目名称不能为空');
            const info = await stat(projectDir);
            if (!info.isDirectory()) throw new Error('项目目录不存在');
            await stat(join(projectDir, 'canvas.json'));
            const target = join(dirname(projectDir), requested);
            if (target === projectDir) {
              respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, project: projectDir, name: basename(projectDir) }));
              return;
            }
            try { await access(target); throw new Error('同级目录中已存在同名项目'); } catch (err) { if (err && err.message === '同级目录中已存在同名项目') throw err; }
            await rename(projectDir, target);
            // 路径改写：canvas.json（及历史备份）里的绝对路径引用随目录改名
            // 同步更新。改造前内嵌 base64 掩盖了这个问题（改名后归档引用、
            // check-sources 早已失效）；存储改用 dshPath 引用后这里必须同步，
            // 否则改名会导致图片无法还原。JSON 转义安全：搜索串用转义后形式。
            try {
              const fromJson = JSON.stringify(projectDir).slice(1, -1);
              const toJson = JSON.stringify(target).slice(1, -1);
              if (fromJson !== toJson) {
                const rewritePaths = async (file) => {
                  const raw = await readFile(file, 'utf8');
                  if (raw.indexOf(fromJson) === -1) return;
                  await writeFile(file, raw.split(fromJson).join(toJson), 'utf8');
                };
                await rewritePaths(join(target, 'canvas.json'));
                try {
                  const legacyBackups = await readdir(join(target, '画布备份'));
                  for (const b of legacyBackups) {
                    if (/\.json$/i.test(b)) await rewritePaths(join(target, '画布备份', b)).catch(() => {});
                  }
                } catch (err) {}
              }
            } catch (err) {}
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, project: target, name: requested }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/delete-project', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('缺少项目目录');
            const info = await stat(projectDir);
            if (!info.isDirectory()) throw new Error('项目目录不存在');
            await stat(join(projectDir, 'canvas.json'));
            const recycleDir = join(dirname(projectDir), '已删除画布项目');
            const normDir = (v) => String(v).replace(/\\/g, '/');
            if (projectDir === recycleDir || normDir(projectDir).startsWith(normDir(recycleDir) + '/')) throw new Error('项目已在回收目录中');
            await mkdir(recycleDir, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const base = basename(projectDir);
            let target = join(recycleDir, base + '-删除于-' + stamp);
            for (let index = 2; index <= 1000; index += 1) {
              try { await access(target); target = join(recycleDir, base + '-删除于-' + stamp + '-' + index); }
              catch (err) { break; }
            }
            await rename(projectDir, target);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, archived: target, recycle: recycleDir }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/open-project', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req));
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('当前聊天没有可打开的项目目录');
            await mkdir(join(projectDir, 'assets'), { recursive: true });
            await mkdir(join(projectDir, 'outputs'), { recursive: true });
            await flattenRecycleBin(projectDir);
            const outcome = await openFolder(ctx, runProcess, projectDir);
            if (outcome.exitCode !== 0) throw new Error(isWindows ? '资源管理器打开失败' : '访达打开失败');
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, project: projectDir, assets: join(projectDir, 'assets') }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: null, path: '/dsh-canvas/state', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          if (req.method === 'GET') {
            const path = projectStatePath(query);
            if (!path) { respond(res, 200, { ...CORS, 'content-type': 'application/json' }, 'null'); return; }
            try {
              const text = await readFile(path, 'utf8');
              respond(res, 200, { ...CORS, 'content-type': 'application/json' }, text);
            } catch (err) {
              respond(res, 200, { ...CORS, 'content-type': 'application/json' }, 'null');
            }
            return;
          }
          if (req.method === 'POST') {
            const path = projectStatePath(query);
            if (!path) { respond(res, 500, { ...CORS, 'content-type': 'text/plain' }, 'no state path'); return; }
            try {
              const body = await readBody(req);
              const snapshot = JSON.parse(body);
              const incomingMeta = snapshot && snapshot.dshMeta && typeof snapshot.dshMeta === 'object' ? snapshot.dshMeta : {};
              const incomingSavedAt = Number(incomingMeta.revision || incomingMeta.savedAt || 0);
              const incomingBaseRevision = Number(incomingMeta.baseRevision || 0);
              const previousWrite = stateWriteChains.get(path) || Promise.resolve();
              const writeTask = previousWrite.catch(() => {}).then(async () => {
                let existingSavedAt = 0;
                try {
                  const existing = JSON.parse(await readFile(path, 'utf8'));
                  existingSavedAt = Number(existing && existing.dshMeta && (existing.dshMeta.revision || existing.dshMeta.savedAt) || 0);
                } catch (err) {}
                // 新版状态已有版本标记时，旧版/旧缓存发来的无标记状态不再允许
                // 覆盖它；带更早时间戳的状态同样只确认但不落盘。
                if (
                  // 已版本化的项目不接受无基线快照；旧聊天/旧插件即使
                  // 把旧内容标成“刚保存”，也不能覆盖当前项目。
                  (existingSavedAt > 0 && (incomingSavedAt <= 0 || incomingBaseRevision <= 0)) ||
                  (incomingSavedAt > 0 && existingSavedAt >= incomingSavedAt) ||
                  // 客户端基于旧版本编辑时，拒绝其迟到写入，避免旧聊天
                  // 在删除后再次把已删除元素“复活”。
                  (existingSavedAt > 0 && incomingBaseRevision > 0 && existingSavedAt > incomingBaseRevision)
                ) {
                  return { stale: true, project: dirname(path), savedAt: existingSavedAt };
                }
                const projectDir = dirname(path);
                const assetsDir = join(projectDir, 'assets');
                const outputsDir = join(projectDir, 'outputs');
                await mkdir(assetsDir, { recursive: true });
                await mkdir(outputsDir, { recursive: true });
                const temp = path + '.tmp-' + process.pid + '-' + Date.now();
                await writeFile(temp, body, 'utf8');
                await rename(temp, path);
                await writeFile(join(projectDir, 'project.json'), JSON.stringify({ version: 1, canvas: 'canvas.json', assets: 'assets', outputs: 'outputs', updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
                return { stale: false, project: projectDir, savedAt: incomingSavedAt };
              });
              stateWriteChains.set(path, writeTask.catch(() => {}));
              const result = await writeTask;
              respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, project: result.project, stale: !!result.stale, savedAt: result.savedAt || 0 }));
            } catch (err) {
              respond(res, 500, { ...CORS, 'content-type': 'text/plain' }, 'save failed');
            }
            return;
          }
  });
}
