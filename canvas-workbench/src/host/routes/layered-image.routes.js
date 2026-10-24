import { parseQuery, respond } from '../server/http.js';
import { createLayeredImageService } from '../services/layered-image.js';

async function readLayerBody(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 45 * 1024 * 1024) throw new Error('请求过大，图片不能超过32MB');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求格式无效');
  return body;
}

export function register(router, h) {
  const service = h.layeredImage || createLayeredImageService(h);
  const add = (method, suffix, action, many = false) => {
    router.add({ method, path: '/dsh-canvas/layered-image/' + suffix, prefix: false }, async (req, res, { query, CORS }) => {
      try {
        const body = method === 'GET' ? parseQuery(query) : await readLayerBody(req);
        const result = await service[action](action === 'analyze' ? { ...body, autoRefine: body.autoRefine !== false } : body);
        respond(res, method === 'POST' && ['analyze', 'run', 'export'].includes(action) ? 202 : 200,
          { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: true, [many ? 'tasks' : 'task']: result }));
      } catch (error) {
        respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String(error?.message || error) }));
      }
    });
  };
  add('POST', 'analyze', 'analyze'); add('GET', 'task', 'get'); add('GET', 'tasks', 'list', true);
  add('POST', 'run', 'run'); add('POST', 'cancel', 'cancel'); add('POST', 'export', 'export');
  add('POST', 'refine', 'refine');
}
