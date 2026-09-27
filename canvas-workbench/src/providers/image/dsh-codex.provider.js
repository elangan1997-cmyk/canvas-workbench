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

/** 比例提示词:让模型主动按所选比例构图(不靠裁切丢画面)。 */
function ratioHintFor(imageSize) {
  const match = /^(\d+)x(\d+)$/.exec(String(imageSize || ''));
  if (!match) return '';
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!w || !h) return '';
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const divisor = gcd(w, h) || 1;
  const ratio = (w / divisor) + ':' + (h / divisor);
  const orient = w === h ? '正方形' : (w > h ? '横版' : '竖版');
  return '【画面比例】请以' + orient + ' ' + ratio + '（' + w + '×' + h + '）构图，主体与关键细节避开四边，最终画面会按该比例输出。';
}

/**
 * dsh-codex 上游把 size 写死为 "auto",比例只能生成后裁:
 * 用自带 Python 运行时按目标比例居中裁切(cover,只裁不放大)。
 * Python/Pillow 缺失或裁切失败时返回原图——比例是增强,不阻断生成。
 */
async function cropToRatio(ctx, buffer, imageSize) {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolvePython } = await import('../../lib/platform.js');
  const scriptPath = join(fileURLToPath(new URL('.', import.meta.url)), '../../..', 'scripts', 'crop_to_ratio.py');
  const work = await mkdtemp(join(tmpdir(), 'dsh-crop-'));
  try {
    const input = join(work, 'in.png');
    const output = join(work, 'out.png');
    await writeFile(input, buffer);
    const python = await resolvePython(ctx);
    const { execFile } = await import('node:child_process');
    const result = await new Promise((resolve) => {
      execFile(python.executable, [...python.prefixArgs, scriptPath, '--input', input, '--output', output, '--size', String(imageSize)], { timeout: 60000 }, (err, stdout) => {
        resolve({ err, stdout: String(stdout || '') });
      });
    });
    if (result.err || !String(result.stdout).startsWith('ok')) return buffer;
    return Buffer.from(await readFile(output));
  } catch {
    return buffer;
  } finally {
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

export const dshCodexProvider = {
  id: 'dsh-codex',
  capabilities: ['image.generate', 'image.edit'],
  loadCodexModule,
  async generate({ ctx, images, prompt, signal, settings = {}, sizeOnEdit }) {
    // 数量:dsh-codex 上游没有 n 参数,并行发多次请求,每次一张。
    const count = Math.max(1, Math.min(8, Number(settings.imageCount) || 1));
    // 比例:上游 size 恒 auto——先在提示词里要求模型按比例构图(不丢画面),
    // 生成后再居中裁切兜底(模型给对比例时为无操作)。与 API 引擎同规则:
    // 纯生成始终生效;编辑仅 sizeOnEdit(聊天路径)才生效。
    const wantsRatio = Boolean(settings.imageSize && settings.imageSize !== 'auto')
      && ((Array.isArray(images) && images.length === 0) || sizeOnEdit === true);
    const hint = wantsRatio ? ratioHintFor(settings.imageSize) : '';
    const finalPrompt = hint ? String(prompt) + '\n' + hint : prompt;
    const jobs = [];
    for (let index = 0; index < count; index += 1) {
      jobs.push(generateWithDshCodex({ ctx, image: images, prompt: finalPrompt, signal }));
    }
    const buffers = await Promise.all(jobs);
    if (!wantsRatio) return buffers;
    return Promise.all(buffers.map((buffer) => cropToRatio(ctx, buffer, settings.imageSize)));
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
