// 图像引擎门面（v1.8 Phase 3）：保持 lib/image-engine.js 的函数签名与行为不变，
// 内部改为经 Provider Registry 分派。新增视频/其它 Provider 时只动 registry，不改这里。
import { dshCodexProvider } from './image/dsh-codex.provider.js';
import { openAICompatibleProvider, testImageApiConnection } from './image/openai-compatible.provider.js';
import { createProviderRegistry } from './registry.js';
import { imageEngineSettingsPath, normalizeImageCount, normalizeImageEngine, readImageEngineSettings } from '../host/services/image-engine-settings.js';
import { cropToRatio } from '../host/services/image-crop.js';

const imageProviders = createProviderRegistry();
imageProviders.register(dshCodexProvider);
imageProviders.register(openAICompatibleProvider);

export { imageProviders };

export async function generateImage({ ctx, image, mask, prompt, engine, signal }) {
  const settings = await readImageEngineSettings();
  const selected = normalizeImageEngine(engine || settings.engine);
  const bytes = Buffer.from(image || []);
  if (!bytes.length) throw new Error('图片输入为空');
  const provider = imageProviders.require(selected);
  // api Provider 现在返回 Buffer[](生成数量可能 >1);画布编辑路径恒取第一张。
  const buffers = await provider.generate({ ctx, images: [bytes], mask, prompt, settings, signal });
  return { engine: selected, bytes: Array.isArray(buffers) ? buffers[0] : buffers };
}

/** Generate or edit an image for the chat imagegen tool using the same route selected by the canvas. */
export async function generateChatImage({ ctx, images = [], prompt, engine, signal }) {
  const settings = await readImageEngineSettings();
  const selected = normalizeImageEngine(engine || settings.engine);
  const inputs = images.map((item) => Buffer.from(item || [])).filter((item) => item.length);
  if (!String(prompt || '').trim()) throw new Error('图片生成提示词不能为空');
  const provider = imageProviders.require(selected);
  const trimmed = String(prompt).trim();
  // 数量统一在这里串行逐张:API 的 n 参数与并行请求实测都会被网关忽略/限流
  // (429 / n>1 只回一张),串行+间隔最稳,且占位数与产出张数严格一致。
  const count = normalizeImageCount(settings.imageCount);
  const outputs = [];
  for (let index = 0; index < count; index += 1) {
    if (index > 0) await new Promise((resolve) => setTimeout(resolve, 1200));
    const produced = await provider.generate({ ctx, images: inputs, prompt: trimmed, settings, signal, sizeOnEdit: true });
    outputs.push(...(Array.isArray(produced) && produced.length ? produced : [produced]));
  }
  // 比例兜底:网关对非标 size 静默忽略、codex 上游恒 auto——显式选了比例时
  // 生成后统一裁到精确比例(给对比例时为无操作)。画布编辑/智能擦除走
  // generateImage,不经过这里,输出跟随原图。
  if (settings.imageSize && settings.imageSize !== 'auto') {
    const cropped = await Promise.all(outputs.map((buffer) => cropToRatio(ctx, buffer, settings.imageSize)));
    return { engine: selected, bytes: cropped[0], images: cropped };
  }
  return { engine: selected, bytes: outputs[0], images: outputs };
}

export async function imageEngineHealth(ctx) {
  const settings = await readImageEngineSettings();
  const api = await imageProviders.get('api').health();
  const dshCodex = await imageProviders.get('dsh-codex').health(ctx);
  return {
    engine: settings.engine,
    api,
    dshCodex,
    settingsPath: imageEngineSettingsPath(),
  };
}

export { testImageApiConnection, normalizeImageEngine, readImageEngineSettings };
export { imageEngineSettingsPath } from '../host/services/image-engine-settings.js';
export { writeImageEngineSettings, writeLegacyApiAuth, readLegacyApiAuth } from '../host/services/image-engine-settings.js';
