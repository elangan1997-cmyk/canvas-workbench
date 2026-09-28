// 自 lib/index.js apply() 机械迁移（v1.8 Phase 2）：每个 handler 体逐字未改，
// 原来的 `if (pathname === … && req.method === …) { … }` 外壳由 router 负责。
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { imageEngineHealth } from '../../../lib/image-engine.js';
import { chatGenerationStatus } from '../services/chat-generation.js';
import { isMac, isWindows, platformCapabilities } from '../../../lib/platform.js';
import { VENDOR_ASSETS } from '../vendor-assets.js';
import { respond } from '../server/http.js';
import { name } from '../plugin-meta.js';

const PACKAGE_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();

export function register(router, h) {
  const { ctx, runProcess } = h;

  // 聊天生图状态:进行中数量 + 最近完成的产出路径(客户端轮询,驱动
  // 「生成中占位提示」与「完成后自动上画布」)。只读,无副作用。
  router.add({ method: 'GET', path: '/dsh-canvas/generation-status', prefix: false }, async (req, res, { CORS }) => {
    respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, ...chatGenerationStatus() }));
  });
  // The canvas renderer must not depend on a public CDN.  DSH Desktop
  // may block third-party scripts inside srcdoc frames, and domestic or
  // offline networks can leave the iframe waiting forever.  Serve the
  // pinned React/Excalidraw builds from the plugin package itself.
  router.add({ method: 'GET', path: '/dsh-canvas/vendor/', prefix: true }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          const asset = VENDOR_ASSETS.get(pathname.slice('/dsh-canvas/vendor/'.length));
          if (!asset) {
            respond(res, 404, { ...CORS, 'content-type': 'text/plain; charset=utf-8' }, 'vendor asset not found');
            return;
          }
          try {
            const bytes = await readFile(asset.path);
            respond(res, 200, {
              ...CORS,
              'content-type': asset.type,
              'content-length': String(bytes.byteLength),
              'cache-control': 'public, max-age=31536000, immutable'
            }, bytes);
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'text/plain; charset=utf-8' }, 'vendor asset unavailable');
          }
          return;
  });

  router.add({ method: 'GET', path: '/dsh-canvas/health', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          try {
            const health = await imageEngineHealth(ctx);
            const hasService = (serviceName) => {
              try { return Boolean(ctx && typeof ctx.get === 'function' && ctx.get(serviceName)); } catch { return false; }
            };
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({
              ok: true,
              plugin: name,
              version: PACKAGE_VERSION,
              platform: platformCapabilities(),
              capabilities: {
                webServer: Boolean(ctx.webServer),
                subprocess: Boolean(ctx.subprocess),
                llm: hasService('llm'),
                attachments: hasService('attachments')
              },
              imageEngine: health
            }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          }
          return;
  });

  router.add({ method: 'GET', path: '/dsh-canvas/system-appearance', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          // Electron 会按应用主题覆盖 webview 的 prefers-color-scheme，页面上
          // 读“系统外观”读到的其实是 DSH 的主题；真实值只能从主机进程问
          // （macOS defaults / Windows 注册表）。
          try {
            let dark = null;
            if (isMac) {
              const result = await runProcess('/usr/bin/defaults', ['read', '-g', 'AppleInterfaceStyle']);
              dark = result.exitCode === 0 && /dark/i.test(result.stdout);
            } else if (isWindows) {
              const result = await runProcess('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme']);
              dark = result.exitCode === 0 && /0x0\b/i.test(result.stdout);
            }
            respond(res, 200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: true, known: dark !== null, dark: dark === true }));
          } catch (err) {
            respond(res, 200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: false, known: false }));
          }
          return;
  });
}
