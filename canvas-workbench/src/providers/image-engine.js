// 图像引擎门面（v1.8 Phase 3）：保持 lib/image-engine.js 的函数签名与行为不变，
// 内部改为经 Provider Registry 分派。新增视频/其它 Provider 时只动 registry，不改这里。
import { dshCodexProvider } from './image/dsh-codex.provider.js';
import { openAICompatibleProvider, testImageApiConnection } from './image/openai-compatible.provider.js';
import { createProviderRegistry } from './registry.js';
import { imageEngineSettingsPath, normalizeImageEngine, readImageEngineSettings } from '../host/services/image-engine-settings.js';

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
  // 聊天路径显式选了比例时,编辑请求也带 size(尊重用户意图);
  // 画布编辑/智能擦除走 generateImage,不传 sizeOnEdit,输出跟随原图。
  // 两个 Provider 的 generate 现在都返回 Buffer[](dsh-codex 并行多张 / API n 参数)。
  const buffers = await provider.generate({ ctx, images: inputs, prompt: trimmed, settings, signal, sizeOnEdit: true });
  const list = Array.isArray(buffers) && buffers.length ? buffers : [buffers];
  return { engine: selected, bytes: list[0], images: list };
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
