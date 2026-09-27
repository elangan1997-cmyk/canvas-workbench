// OpenAI 兼容图像 API Provider（自 lib/image-engine.js 逐字迁移，v1.8 Phase 3）。
// 只处理输入/状态/输出/错误，不感知 UI（执行文档 §3.3）。
import { DEFAULT_API_MODEL, effectiveApiBase, readImageEngineSettings, readLegacyApiAuth } from '../../host/services/image-engine-settings.js';
import { imageMediaType } from '../../shared/utils/image-bytes.js';

const PIXEL_BROWSER_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 DSH-Canvas/1.4';

export function modelIdsFromPayload(payload) {
  const values = payload && Array.isArray(payload.data)
    ? payload.data
    : payload && Array.isArray(payload.models) ? payload.models : [];
  return [...new Set(values.map((item) => typeof item === 'string' ? item : item && (item.id || item.model || item.name)).filter(Boolean).map(String))];
}

export function parseImagePayload(payload) {
  const item = payload && Array.isArray(payload.data) ? payload.data[0] : null;
  if (!item || typeof item !== 'object') throw new Error('API 未返回图片数据');
  if (typeof item.b64_json === 'string' && item.b64_json.trim()) return Buffer.from(item.b64_json.trim(), 'base64');
  if (typeof item.url === 'string' && item.url.trim()) return fetch(item.url).then(async (response) => {
    if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
    return Buffer.from(await response.arrayBuffer());
  });
  throw new Error('API 未返回可读取的图片数据');
}

/** 生成数量(n>1)时网关会在 data[] 里回多张图;逐张解码/下载,任一失败即整轮失败。 */
export async function parseImagePayloadAll(payload) {
  const items = payload && Array.isArray(payload.data) ? payload.data.filter((item) => item && typeof item === 'object') : [];
  if (!items.length) throw new Error('API 未返回图片数据');
  const buffers = await Promise.all(items.map(async (item) => {
    if (typeof item.b64_json === 'string' && item.b64_json.trim()) return Buffer.from(item.b64_json.trim(), 'base64');
    if (typeof item.url === 'string' && item.url.trim()) {
      const response = await fetch(item.url);
      if (!response.ok) throw new Error(`图片下载失败（HTTP ${response.status}）`);
      return Buffer.from(await response.arrayBuffer());
    }
    throw new Error('API 未返回可读取的图片数据');
  }));
  if (!buffers.length || buffers.some((buffer) => !buffer || !buffer.length)) throw new Error('API 未返回可读取的图片数据');
  return buffers;
}

export const RETRYABLE_IMAGE_API_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);

export function imageApiRetryDelay(response, attempt) {
  const raw = response && response.headers ? response.headers.get('retry-after') : '';
  if (raw !== null && raw !== '') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(20000, Math.round(seconds * 1000));
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.min(20000, Math.max(0, at - Date.now()));
  }
  // Pixel 的 502/52x 通常是上游短时窗口；2s/5s 连续重试只会
  // 再次命中同一故障。给网关留出恢复时间，最长不超过 40s。
  return Math.min(40000, 10000 * (2 ** Math.max(0, attempt - 1)));
}

export function waitForImageApiRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(signal.reason || new Error('请求已取消'));
    const timer = setTimeout(done, Math.max(0, ms));
    function done() { if (signal) signal.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); if (signal) signal.removeEventListener('abort', aborted); reject(signal.reason || new Error('请求已取消')); }
    if (signal) signal.addEventListener('abort', aborted, { once: true });
  });
}

async function generateWithApi({ image, images, mask, prompt, settings, signal }) {
  const auth = await readLegacyApiAuth();
  if (!auth.configured) throw new Error(`未配置 image2 API 密钥：${auth.filename}`);
  // 保留旧版 auth.json 中的自定义网关；只有设置文件明确改过默认地址时才覆盖它。
  const base = effectiveApiBase(settings, auth);
  const maxAttempts = 4;
  let lastFailure = '';
  const inputImages = Array.isArray(images) && images.length
    ? images.map((item) => Buffer.from(item || [])).filter((item) => item.length)
    : image && Buffer.from(image).length ? [Buffer.from(image)] : [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let body;
    const headers = {
      authorization: `Bearer ${auth.apiKey}`,
      accept: 'application/json',
      'user-agent': PIXEL_BROWSER_USER_AGENT,
    };
    let endpoint = `${base}/v1/images/generations`;
    if (inputImages.length) {
      endpoint = `${base}/v1/images/edits`;
      const form = new FormData();
      form.append('model', String(settings.apiModel || DEFAULT_API_MODEL));
      form.append('prompt', prompt);
      form.append('quality', 'high');
      for (let index = 0; index < inputImages.length; index += 1) {
        const bytes = inputImages[index];
        form.append(inputImages.length > 1 ? 'image[]' : 'image', new Blob([bytes], { type: imageMediaType(bytes) }), `input-${index + 1}.png`);
      }
      if (mask) form.append('mask', new Blob([mask], { type: 'image/png' }), 'mask.png');
      body = form;
    } else {
      headers['content-type'] = 'application/json';
      // 尺寸比例:选了具体比例才传 size(默认 auto 不传,由服务端决定);
      // 编辑/擦除路径(带输入图)不传 size,输出跟随输入比例。
      const request = { model: String(settings.apiModel || DEFAULT_API_MODEL), prompt, quality: 'high' };
      if (settings.imageSize && settings.imageSize !== 'auto') request.size = String(settings.imageSize);
      // 生成数量:聊天抽卡场景一张请求出多张图,减少整轮等待。
      const count = Number(settings.imageCount) || 1;
      if (count > 1) request.n = count;
      body = JSON.stringify(request);
    }
    let response;
    try {
      // 图片网关在高峰期可能需要 3-5 分钟；单次调用必须小于外层任务总预算，
      // 但不能沿用旧的 180 秒，否则请求会在网关受理前/生成中途被本机主动切断。
      const timeoutSignal = AbortSignal.timeout(360000);
      response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch (error) {
      if (signal && signal.aborted) throw new Error('画布图片任务超过总等待时间，本机已停止请求；API 可能尚未受理，请在恢复的窗口中重试');
      lastFailure = error && error.name === 'TimeoutError' ? '请求超时' : String((error && error.message) || error);
      if (attempt < maxAttempts) { await waitForImageApiRetry(Math.min(40000, 10000 * (2 ** Math.max(0, attempt - 1))), signal); continue; }
      throw new Error(`image2 API 连接失败：${lastFailure}（已自动重试 ${maxAttempts - 1} 次）`);
    }
    let payload = null;
    try { payload = await response.json(); } catch {}
    if (response.ok) {
      if (!payload) throw new Error(`image2 API 返回无效响应（HTTP ${response.status}）`);
      return await parseImagePayloadAll(payload);
    }
    const detail = payload && payload.error && typeof payload.error.message === 'string' ? payload.error.message : '';
    lastFailure = `HTTP ${response.status}${detail ? `：${detail}` : ''}`;
    if (RETRYABLE_IMAGE_API_STATUSES.has(response.status) && attempt < maxAttempts) {
      await waitForImageApiRetry(imageApiRetryDelay(response, attempt), signal);
      continue;
    }
    const retried = RETRYABLE_IMAGE_API_STATUSES.has(response.status) ? `（已自动重试 ${attempt - 1} 次）` : '';
    throw new Error(`image2 API 请求失败（${lastFailure}）${retried}`);
  }
  throw new Error(`image2 API 请求失败：${lastFailure || '未知错误'}（已自动重试 ${maxAttempts - 1} 次）`);
}

export async function testImageApiConnection() {
  const settings = await readImageEngineSettings();
  const auth = await readLegacyApiAuth();
  if (!auth.configured) throw new Error('请先填写并保存 API Key');
  const baseUrl = effectiveApiBase(settings, auth);
  const started = Date.now();
  let response;
  try {
    response = await fetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${auth.apiKey}`,
        accept: 'application/json',
        'user-agent': PIXEL_BROWSER_USER_AGENT,
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new Error(`无法连接 API 地址：${error && error.name === 'TimeoutError' ? '连接超时' : String((error && error.message) || error)}`);
  }
  if (response.status === 401 || response.status === 403) throw new Error(`API Key 未通过认证（HTTP ${response.status}）`);
  if (response.status >= 500) throw new Error(`API 服务暂不可用（HTTP ${response.status}）`);
  let payload = null;
  try { payload = await response.json(); } catch {}
  const modelIds = response.ok ? modelIdsFromPayload(payload) : [];
  const selectedModel = String(settings.apiModel || DEFAULT_API_MODEL).trim();
  const modelAvailable = !modelIds.length || modelIds.includes(selectedModel);
  if (response.ok && modelIds.length && !modelAvailable) {
    throw new Error(`API 密钥已通过认证，但当前分组未提供模型 ${selectedModel}；请在服务商后台为该密钥绑定支持此模型的分组`);
  }
  // 部分图片网关只实现 /v1/images/*，models 返回 404/405 仍能证明地址可达；
  // 真正的编辑请求仍会在首次使用时校验模型与额度。
  return {
    ok: response.ok,
    reachable: true,
    authAccepted: response.status !== 401 && response.status !== 403,
    endpointSupported: response.status !== 404 && response.status !== 405,
    status: response.status,
    latencyMs: Date.now() - started,
    baseUrl,
    model: selectedModel,
    modelAvailable,
    availableModelCount: modelIds.length,
  };
}

export const openAICompatibleProvider = {
  id: 'api',
  capabilities: ['image.generate', 'image.edit', 'image.mask'],
  async generate({ images, mask, prompt, settings, signal }) {
    return generateWithApi({ images, mask, prompt, settings, signal });
  },
  async health() {
    const settings = await readImageEngineSettings();
    const auth = await readLegacyApiAuth();
    return { configured: auth.configured, baseUrl: effectiveApiBase(settings, auth), model: settings.apiModel, ready: auth.configured };
  },
  testConnection: testImageApiConnection
};
