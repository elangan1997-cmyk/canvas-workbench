// 自 lib/index.js apply() 机械迁移（v1.8 Phase 2）：每个 handler 体逐字未改，
// 原来的 `if (pathname === … && req.method === …) { … }` 外壳由 router 负责。
import { imageEngineHealth, readImageEngineSettings, testImageApiConnection, writeImageEngineSettings, writeLegacyApiAuth } from '../../../lib/image-engine.js';
import { readToolchainStatus, runToolchainProvisioning } from '../services/local-toolchain.js';
import { checkUpdate, performSelfUpdate } from '../services/self-update.js';
import { isAbsolutePath } from '../../../lib/platform.js';
import { stat } from 'node:fs/promises';
import { parseQuery, readBody, respond } from '../server/http.js';
import { expandHome, normalizeLocalPath } from '../../shared/utils/paths.js';
import { MAX_IMAGE_BYTES, MAX_SOURCE_BYTES, isSourceImagePath, sourceKindOf } from '../../shared/utils/image-types.js';

export function register(router, h) {
  const { chatContexts, ctx, projectDirectory } = h;
  // 图像生成/编辑只允许在画布设置中显式选择一个引擎：
  // dsh-codex（独立 OAuth）或 API（读取本机已有 image2 凭据）。
  // 返回值始终脱敏，绝不把 API key 发送到前端或写入项目。
  router.add({ method: 'GET', path: '/dsh-canvas/image-settings', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          const settings = await readImageEngineSettings();
          const health = await imageEngineHealth(ctx);
          respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({
            ok: true,
            engine: settings.engine,
            apiBaseUrl: settings.apiBaseUrl,
            apiModel: settings.apiModel,
            imageSize: settings.imageSize,
            imageCount: settings.imageCount,
            health
          }));
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/image-settings', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          if (!sameOriginRequest()) {
            respond(res, 403, { 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: '仅允许从当前 DSH 页面修改图像引擎设置' }));
            return;
          }
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            // 只提交 body 里实际出现的字段:升级/重载期间客户端若发出部分请求,
            // 绝不能让 undefined 字段参与归一化链路(1.9.40 Win 实机观测到用户
            // 配置被写回出厂默认,此处按"只补缺失、绝不覆盖"收紧)。
            const patch = {};
            for (const key of ['engine', 'apiBaseUrl', 'apiModel', 'imageSize', 'imageCount']) {
              if (body && Object.prototype.hasOwnProperty.call(body, key) && body[key] !== undefined && body[key] !== null) patch[key] = body[key];
            }
            const settings = await writeImageEngineSettings(patch);
            if (body.apiKey || body.clearApiKey === true) {
              await writeLegacyApiAuth({ apiKey: body.apiKey, baseUrl: settings.apiBaseUrl, clear: body.clearApiKey === true });
            }
            const health = await imageEngineHealth(ctx);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({
              ok: true,
              engine: settings.engine,
              apiBaseUrl: settings.apiBaseUrl,
              apiModel: settings.apiModel,
              imageCount: settings.imageCount,
              health
            }));
          } catch (err) {
            respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'GET', path: '/dsh-canvas/toolchain-status', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          const status = await readToolchainStatus();
          respond(res, 200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: true, status }));
          return;
  });

  // 宿主操作日志尾部(Python 调用/工具链迁移/桥接事件),诊断"失败但没报错"的场景。
  router.add({ method: 'GET', path: '/dsh-canvas/toolchain-log', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          const { readOpTail } = await import('../services/op-log.js');
          const { parseQuery } = await import('../server/http.js');
          const lines = Math.max(10, Math.min(300, Number(parseQuery(query).lines) || 80));
          const text = await readOpTail(lines);
          respond(res, 200, { ...CORS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, text || '(暂无日志)');
          return;
  });

  router.add({ method: 'GET', path: '/dsh-canvas/update-check', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          respond(res, 200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: true, ...(await checkUpdate()) }));
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/self-update', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          if (!sameOriginRequest()) {
            respond(res, 403, { 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: '仅允许从当前 DSH 页面执行更新' }));
            return;
          }
          const result = await performSelfUpdate();
          respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify(result));
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/client-debug', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const { writeFile: debugWrite, mkdir: debugMkdir } = await import('node:fs/promises');
            const { join: debugJoin } = await import('node:path');
            const { dshHome: debugHome } = await import('../services/image-engine-settings.js');
            const debugDir = debugJoin(debugHome(), 'canvas-workbench');
            await debugMkdir(debugDir, { recursive: true });
            // 合并写入:标题栏/模型等多个探针各报各的字段,不互相覆盖。
            let merged = {};
            try { merged = JSON.parse(await (await import('node:fs/promises')).readFile(debugJoin(debugDir, 'client-debug.json'), 'utf8')); } catch {}
            const stamped = { ...merged, ...body };
            if (body.modelTracking) stamped.modelTracking = body.modelTracking;
            if (body.titlebar) stamped.titlebar = body.titlebar;
            await debugWrite(debugJoin(debugDir, 'client-debug.json'), JSON.stringify(stamped, null, 2) + '\n', 'utf8');
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true }));
          } catch (err) {
            respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/toolchain-prepare', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          if (!sameOriginRequest()) {
            respond(res, 403, { 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: '仅允许从当前 DSH 页面执行配置操作' }));
            return;
          }
          const result = await runToolchainProvisioning(ctx);
          respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify(result));
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/image-setup', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          if (!sameOriginRequest()) {
            respond(res, 403, { 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: '仅允许从当前 DSH 页面执行配置操作' }));
            return;
          }
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const action = String(body.action || '');
            if (action === 'test-api') {
              const settings = await writeImageEngineSettings({
                engine: 'api',
                apiBaseUrl: body.apiBaseUrl,
                apiModel: body.apiModel
              });
              if (body.apiKey) await writeLegacyApiAuth({ apiKey: body.apiKey, baseUrl: settings.apiBaseUrl });
              const test = await testImageApiConnection();
              respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, test, health: await imageEngineHealth(ctx) }));
              return;
            }
            if (action === 'install-dsh-codex') {
              const health = await imageEngineHealth(ctx);
              if (!health.dshCodex.installed) {
                // npm 版没有独立的"安装/修复"工具(老文案指向完整包时代的东西);
                // 直接触发后台预置下载 dsh-codex(含镜像兜底+gzip 校验)。
                const { runToolchainProvisioning } = await import('../services/local-toolchain.js');
                const result = await runToolchainProvisioning(ctx);
                const after = await imageEngineHealth(ctx);
                if (after.dshCodex.installed) {
                  respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({
                    ok: true,
                    message: '✓ dsh-codex 已下载安装完成。请完全退出并重启 DSH,然后在引擎设置中切换到 dsh-codex 并登录。',
                    restartRequired: true,
                    health: after
                  }));
                } else {
                  respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({
                    ok: true,
                    message: 'dsh-codex 正在后台下载,请稍后查看「更多 → 本地工具链状态」;完成后需重启 DSH。',
                    restartRequired: true,
                    health: after
                  }));
                }
                return;
              }
              respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({
                ok: true,
                message: '当前 DSH profile 已安装兼容版 dsh-codex；聊天推理与画布图片现使用同一路由。',
                restartRequired: false,
                health
              }));
              return;
            }
            respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: '未知配置操作' }));
          } catch (err) {
            respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  // 图片输出卡片在渲染前只需要确认文件是否已经落盘，不应为此下载整张图片。
  // 模型有时会在最终文本中提到尚未生成/已删除的路径；客户端用这个轻量
  // 状态接口过滤失效引用，避免把它们显示成“图片加载失败”。
  router.add({ method: 'GET', path: '/dsh-canvas/image-status', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          const path = normalizeLocalPath(parseQuery(query).path || '');
          if (!isSourceImagePath(path) || !isAbsolutePath(path)) {
            respond(res, 400, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: false, exists: false, error: 'bad image path' }));
            return;
          }
          try {
            const info = await stat(path);
            const kind = sourceKindOf(path);
            const maxBytes = kind === 'image' ? MAX_IMAGE_BYTES : MAX_SOURCE_BYTES;
            if (!info.isFile() || info.size <= 0 || info.size > maxBytes) throw new Error('invalid image file');
            respond(res, 200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: true, exists: true, kind, size: info.size, mtime: info.mtimeMs }));
          } catch (err) {
            respond(res, 404, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: false, exists: false }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/chat-context', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const sessionId = String(body.sessionId || '').trim();
            if (!sessionId) throw new Error('缺少聊天会话 ID');
            const cwd = expandHome(String(body.cwd || '')).replace(/[\\/]+$/, '');
            const project = body.project ? projectDirectory(cwd, body.project) : '';
            chatContexts.set(sessionId, { sessionId, cwd, project, designMode: body.designMode === true, updatedAt: Date.now() });
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true }));
          } catch (err) {
            respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });
}
