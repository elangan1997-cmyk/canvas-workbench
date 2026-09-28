// DSH Desktop 渲染进程的 Chrome DevTools Protocol 客户端。
// 用途：smoke 测试 / 回归取证。在页面上下文里 fetch 插件 API（自带同源凭据，
// 绕开 DSH 网关对外部 curl 的 403）、截图（不依赖 macOS 屏幕录制权限）、按文本点击 DOM。
// 前提：DSH Desktop 以 `--remote-debugging-port=9222` 启动。
//
//   open -a "DeepSeek Harness" --args --remote-debugging-port=9222
//
// 用法（模块）：
//   const cdp = await connectDsh();
//   await cdp.eval(`fetch('/dsh-canvas/health').then(r => r.json())`);
//   await cdp.screenshot('/tmp/a.png');
//   await cdp.clickText('素材库');
//   cdp.close();

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const DEFAULT_PORT = Number(process.env.DSH_CDP_PORT || 9222);

export async function listTargets(port = DEFAULT_PORT) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  if (!res.ok) throw new Error(`CDP /json ${res.status}`);
  return res.json();
}

export async function connectDsh({ port = DEFAULT_PORT, match = (t) => t.type === 'page' && (/127\.0\.0\.1:\d+/.test(t.url) || t.url === 'dsh-app://app/') } = {}) {
  const targets = await listTargets(port);
  const target = targets.find(match);
  if (!target) throw new Error('未找到 DSH 渲染页面目标：' + JSON.stringify(targets.map((t) => [t.type, t.url])));
  return connectTarget(target);
}

export function connectTarget(target) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    const listeners = new Map();
    let seq = 0;
    ws.addEventListener('error', (e) => reject(new Error('CDP WebSocket 错误: ' + (e.message || 'unknown'))));
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else res(msg.result);
        return;
      }
      if (msg.method && listeners.has(msg.method)) for (const fn of listeners.get(msg.method)) fn(msg.params);
    });
    ws.addEventListener('open', () => {
      const send = (method, params = {}) => new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
      const client = {
        target,
        send,
        on(method, fn) { if (!listeners.has(method)) listeners.set(method, new Set()); listeners.get(method).add(fn); },
        close() { try { ws.close(); } catch {} },

        /** 在页面上下文求值；表达式可返回 Promise。返回反序列化后的值。 */
        async eval(expression, { timeoutMs = 30000 } = {}) {
          let timer = null;
          const timeout = new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error('eval 超时: ' + expression.slice(0, 80))), timeoutMs);
          });
          let result;
          try {
            result = await Promise.race([
              send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }),
              timeout
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
          if (result.exceptionDetails) {
            const d = result.exceptionDetails;
            throw new Error('页面异常: ' + (d.exception && d.exception.description || d.text));
          }
          return result.result ? result.result.value : undefined;
        },

        /** 同源 fetch 插件 API，返回 { status, headers, body(json|text) }。 */
        async api(path, init = {}, { timeoutMs = 30000 } = {}) {
          const code = `(async () => {
            const r = await fetch(${JSON.stringify(path)}, ${JSON.stringify(init)});
            const ct = r.headers.get('content-type') || '';
            const text = await r.text();
            let body = text;
            if (/json/.test(ct)) { try { body = JSON.parse(text); } catch {} }
            return { status: r.status, contentType: ct, body };
          })()`;
          return this.eval(code, { timeoutMs });
        },

        async screenshot(path, { format = 'png', quality, fillBackground = true } = {}) {
          // DSH Desktop 的 body 是透明材质（data-dsh-desktop-material=transparent），
          // 直接截图会把透明区渲染成白色，与屏幕所见不符；用真实底色令牌填充。
          if (fillBackground) {
            const hex = await this.eval(`(() => { const v = getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(); return /^#[0-9a-f]{6}$/i.test(v) ? v : ''; })()`);
            if (hex) {
              const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
              await send('Emulation.setDefaultBackgroundColorOverride', { color: { r, g, b, a: 1 } });
            }
          }
          const params = { format, captureBeyondViewport: false };
          if (format === 'jpeg') params.quality = quality || 85;
          const { data } = await send('Page.captureScreenshot', params);
          if (fillBackground) await send('Emulation.setDefaultBackgroundColorOverride', {});
          await writeFile(path, Buffer.from(data, 'base64'));
          return path;
        },

        /** 按可见文本点击第一个匹配元素（button/a/div 等），返回是否命中。 */
        async clickText(text, { exact = false, within = 'document' } = {}) {
          return this.eval(`(() => {
            const root = ${within};
            const needle = ${JSON.stringify(text)};
            const nodes = [...root.querySelectorAll('button, a, [role="button"], [role="menuitem"], label, span, div')];
            const hit = nodes.find((n) => {
              const t = (n.textContent || '').trim();
              return ${exact ? 't === needle' : 't === needle || (t.length < needle.length + 12 && t.includes(needle))'} && n.getClientRects().length;
            });
            if (!hit) return false;
            hit.click();
            return true;
          })()`);
        },

        /** 视口 CSS 坐标真实点击（Input 域，受信任事件，对 canvas/iframe 生效）。 */
        async click(cssX, cssY, { button = 'left', clickCount = 1, modifiers = 0 } = {}) {
          const common = { x: cssX, y: cssY, button, clickCount, modifiers };
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common, buttons: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common, buttons: 1 });
        },

        async key(text, { modifiers = 0 } = {}) {
          const printable = text.length === 1 && /[ -~]/.test(text);
          const base = printable
            ? { key: text, text, unmodifiedText: text, windowsVirtualKeyCode: text.toUpperCase().charCodeAt(0), nativeVirtualKeyCode: 0 }
            : { key: text, code: text === 'Escape' ? 'Escape' : undefined, windowsVirtualKeyCode: 0, nativeVirtualKeyCode: 0 };
          await send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers, ...base });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...base });
        },

        async viewportSize() {
          const m = await send('Page.getLayoutMetrics');
          return { width: Math.round(m.cssVisualViewport.width), height: Math.round(m.cssVisualViewport.height) };
        },

        async sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
      };
      resolve(client);
    });
  });
}

// CLI：node tests/smoke/cdp-client.mjs eval "<expr>" | api /dsh-canvas/health | shot out.png | click "文本"
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  const cdp = await connectDsh();
  try {
    if (cmd === 'eval') console.log(JSON.stringify(await cdp.eval(rest.join(' ')), null, 2));
    else if (cmd === 'api') console.log(JSON.stringify(await cdp.api(rest[0]), null, 2));
    else if (cmd === 'shot') console.log(await cdp.screenshot(rest[0] || '/tmp/dsh-shot.png'));
    else if (cmd === 'click') console.log(await cdp.clickText(rest.join(' ')));
    else if (cmd === 'targets') console.log(JSON.stringify(await listTargets(), null, 2));
    else console.log('用法: eval <expr> | api <path> | shot <file> | click <text> | targets');
  } finally { cdp.close(); }
}
