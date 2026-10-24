import { parseQuery, respond } from '../server/http.js';
import { pickFolder } from '../../../lib/platform.js';

async function bodyOf(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw new Error('请求过大，请使用文件路径，不要传图片内容'); chunks.push(chunk); }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式无效');
  return body;
}

export function register(router, h) {
  const service = h.automation;
  router.add({ method: 'POST', path: '/dsh-canvas/automation/pick-folder', prefix: false }, async (req, res, { CORS, sameOriginRequest }) => {
    try {
      if (!sameOriginRequest()) throw new Error('仅允许当前工作台选择文件夹');
      const path = await pickFolder(h.ctx, h.runProcess, '选择后台批处理的图片文件夹');
      respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, value: { path: path || '' } }));
    } catch (error) { respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 500) })); }
  });
  for (const [method, suffix, action] of [
    ['POST', 'plan', 'plan'], ['POST', 'submit', 'submit'], ['GET', 'job', 'get'], ['GET', 'jobs', 'list'],
    ['POST', 'cancel', 'cancel'], ['POST', 'resume', 'resume'], ['GET', 'events', 'events'],
    ['POST', 'ack', 'acknowledge'], ['POST', 'open', 'open'], ['GET', 'canvas', 'inspect'], ['POST', 'canvas', 'arrange'],
    ['POST', 'canvas-result', 'completeCanvasCommand'], ['POST', 'review', 'review']
  ]) {
    router.add({ method, path: '/dsh-canvas/automation/' + suffix, prefix: false }, async (req, res, { query, CORS, sameOriginRequest }) => {
      if (!sameOriginRequest()) { respond(res, 403, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: '仅允许当前工作台或本地调用' })); return; }
      try {
        const body = method === 'GET' ? parseQuery(query) : await bodyOf(req);
        const value = await service[action](body);
        respond(res, action === 'submit' ? 202 : 200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: true, value }));
      } catch (error) { respond(res, 400, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 1200) })); }
    });
  }
  router.add({ method: 'POST', path: '/dsh-canvas/automation/context', prefix: false }, async (req, res, { CORS, sameOriginRequest }) => {
    try {
      if (!sameOriginRequest()) throw new Error('仅允许当前工作台同步选区');
      const b = await bodyOf(req), current = h.chatContexts.get(String(b.sessionId || ''));
      if (!current || current.project !== b.project) throw new Error('当前项目已切换');
      const previous = h.canvasAutomationContexts.get(current.sessionId);
      if (previous?.project === b.project && Number(b.revision || 0) < Number(previous.revision || 0)) {
        respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, stale: true })); return;
      }
      const elements = Array.isArray(b.elements) ? b.elements.slice(0, 5000).filter(e => e && typeof e.id === 'string' && ['x','y','width','height'].every(k => Number.isFinite(e[k])))
        .map(e => ({ id: e.id.slice(0, 100), type: String(e.type || '').slice(0, 40), x: e.x, y: e.y, width: e.width, height: e.height,
          angle: Number(e.angle) || 0, opacity: Number.isFinite(e.opacity) ? e.opacity : 100, name: String(e.name || '').slice(0, 240), path: String(e.path || '').slice(0, 8000) })) : [];
      h.canvasAutomationContexts.set(current.sessionId, { project: b.project, selectedIds: Array.isArray(b.selectedIds) ? b.selectedIds.filter(x => typeof x === 'string').slice(0, 500) : [],
        elements, sceneStamp: typeof b.sceneStamp === 'string' ? b.sceneStamp.slice(0, 200000) : '', revision: Number(b.revision) || 0, at: Date.now() });
      respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true }));
    } catch (error) { respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String(error.message || error).slice(0, 500) })); }
  });
}
