// dsh-codex 图像 Provider（自 lib/image-engine.js 逐字迁移，v1.8 Phase 3）。
// 只处理输入/状态/输出/错误，不感知 UI（执行文档 §3.3）。
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dshHome } from '../../host/services/image-engine-settings.js';
import { dataUrl } from '../../shared/utils/image-bytes.js';

async function moduleCandidates() {
  const root = dshHome();
  const candidates = [];
  // Resolve from the canvas plugin that is currently loaded by DSH first. This
  // keeps chat inference and canvas image generation on the exact same
  // dsh-codex build/profile instead of accidentally finding another profile's
  // stale copy during the fallback directory scan below.
  try {
    const resolved = import.meta.resolve('dsh-codex');
    if (resolved && resolved.startsWith('file:')) candidates.push(fileURLToPath(resolved));
  } catch {}
  candidates.push(
    process.env.DSH_CODEX_MODULE_PATH,
    join(process.cwd(), 'node_modules', 'dsh-codex', 'lib', 'index.js'),
    join(root, 'profiles', 'web', 'node_modules', 'dsh-codex', 'lib', 'index.js'),
    join(root, 'profiles', 'desktop', 'node_modules', 'dsh-codex', 'lib', 'index.js'),
    join(root, 'profiles', 'node_modules', 'dsh-codex', 'lib', 'index.js'),
  );
  try {
    const profiles = await (await import('node:fs/promises')).readdir(join(root, 'profiles'), { withFileTypes: true });
    for (const profile of profiles) {
      if (!profile.isDirectory()) continue;
      candidates.push(join(root, 'profiles', profile.name, 'node_modules', 'dsh-codex', 'lib', 'index.js'));
    }
  } catch {}
  return [...new Set(candidates.filter(Boolean))];
}

async function loadCodexModule() {
  let lastMissing = '';
  let sawFile = false;
  for (const filename of await moduleCandidates()) {
    try {
      await access(filename);
    } catch {
      continue;
    }
    sawFile = true;
    try {
      return await import(pathToFileURL(filename).href);
    } catch (error) {
      // dsh-codex 的入口静态依赖一组由宿主提供的 peer 包（pi-ai、cordis 等）。
      // 宿主加载 dsh-codex 走应用内部解析；本处的 Node 原生导入依赖
      // ~/.dsh 层级的解析链。缺包时记下第一个缺失包名，供健康检查透出。
      const match = error && error.code === 'ERR_MODULE_NOT_FOUND'
        ? /Cannot find package '([^']+)'/.exec(error.message || '') : null;
      if (match) lastMissing = match[1];
    }
  }
  if (lastMissing) {
    throw new Error(`dsh-codex 依赖的 ${lastMissing} 在本机解析链中缺失。可在终端执行：npm install --prefix ~/.dsh/profiles ${lastMissing}，然后重启 DSH`);
  }
  if (!sawFile) throw new Error('未找到 dsh-codex，请先在当前 DSH profile 安装 dsh-codex');
  throw new Error('dsh-codex 模块加载失败，请重启 DSH 后重试');
}

async function generateWithDshCodex({ ctx, image, prompt, signal }) {
  const module = await loadCodexModule();
  const service = typeof ctx.get === 'function' ? ctx.get('openAICodex') : null;
  const credentials = service && service.credentials
    ? service.credentials
    : module.OpenAICodexCredentialStore ? new module.OpenAICodexCredentialStore() : null;
  if (!credentials || !module.OpenAICodexImageClient) throw new Error('当前 dsh-codex 未提供图片编辑客户端，请重启 DSH 后重试');
  const client = new module.OpenAICodexImageClient(credentials);
  const images = Array.isArray(image) ? image : image ? [image] : [];
  return Buffer.from(await client.generate(prompt, images.map(dataUrl), signal || AbortSignal.timeout(360000)));
}

export const dshCodexProvider = {
  id: 'dsh-codex',
  capabilities: ['image.generate', 'image.edit'],
  loadCodexModule,
  async generate({ ctx, images, prompt, signal, settings = {}, sizeOnEdit }) {
    // 比例提示词由 generateChatImage 在 Provider 分派前统一注入，API 与
    // dsh-codex 得到完全相同的构图约束；画布局部编辑仍保持原图比例。
    return generateWithDshCodex({ ctx, image: images, prompt, signal });
  },
  async health(ctx) {
    let installed = false;
    let detail = '';
    try {
      await loadCodexModule();
      installed = true;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    let authenticated = false;
    try {
      const service = typeof ctx.get === 'function' ? ctx.get('openAICodex') : null;
      if (service && typeof service.authStatus === 'function') authenticated = Boolean((await service.authStatus()).authenticated);
      else if (installed) {
        const module = await loadCodexModule();
        if (module.openAICodexAuthStatus) authenticated = Boolean((await module.openAICodexAuthStatus()).authenticated);
      }
    } catch {}
    return installed
      ? { installed, authenticated, ready: installed && authenticated }
      : { installed, authenticated, ready: false, detail };
  }
};
