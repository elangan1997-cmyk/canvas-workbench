import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { generateChatImage } from './image-engine.js';
import { readImageEngineSettings, normalizeImageCount } from '../src/host/services/image-engine-settings.js';
import { beginChatGeneration, endChatGeneration, noteChatGenerationCompleted } from '../src/host/services/chat-generation.js';

/** 会话 v4 的生产者归属标识(dsh-codex 同款 Object.freeze 模式)。 */
const CANVAS_MESSAGE_SOURCE = Object.freeze({ kind: 'plugin:canvas-workbench' });

const TOOL_NAME = 'imagegen';
const MAX_REFERENCE_IMAGES = 5;


function safeBaseName(value) {
  const clean = String(value || '聊天生成图片').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim().slice(0, 80);
  return (clean || '聊天生成图片').replace(/\.png$/i, '');
}

function generatedName(now = new Date()) {
  return `聊天生成-${now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:]/g, '-')}.png`;
}

async function uniqueOutputPath(directory, requested) {
  const wanted = safeBaseName(requested || generatedName()) + '.png';
  const suffix = extname(wanted) || '.png';
  const base = wanted.slice(0, -suffix.length);
  for (let index = 1; index <= 1000; index += 1) {
    const target = join(directory, index === 1 ? wanted : `${base}-${index}${suffix}`);
    try { await stat(target); } catch { return target; }
  }
  throw new Error('无法为聊天生成图片分配文件名');
}

async function resolveCanvasProjectDirectory(value) {
  const candidate = String(value || '').replace(/[\\/]+$/, '');
  if (!candidate) throw new Error('当前聊天没有画布项目');
  // 新版上下文直接保存画布项目根目录；少数旧会话保存的是聊天工作目录，
  // 真正项目位于其“画布项目/”子目录。以 canvas.json 为准，避免把聊天
  // 生成图片错误地写到 assets 所在项目的上一层。
  for (const directory of [candidate, join(candidate, '画布项目')]) {
    try {
      const info = await stat(join(directory, 'canvas.json'));
      if (info.isFile()) return directory;
    } catch {}
  }
  return candidate;
}

function collectImageRefs(content, output) {
  for (const block of Array.isArray(content) ? content : []) {
    if (block && block.type === 'image' && block.attachment) output.push(block.attachment);
    else if (block && block.type === 'tool-result') collectImageRefs(block.content, output);
  }
}

async function recentImages(ctx, exec, count) {
  const session = exec.agent && exec.agent.session;
  if (!session || typeof session.deriveMessages !== 'function') throw new Error('当前聊天无法读取历史图片');
  const refs = [];
  for (const message of session.deriveMessages()) collectImageRefs(message.content, refs);
  const selected = refs.slice(-count);
  if (selected.length !== count) throw new Error(`最近聊天中只有 ${selected.length} 张可用图片`);
  return Promise.all(selected.map(async (ref) => Buffer.from((await ctx.attachments.readImage(ref, exec.signal)).data)));
}

async function workspaceImages(ctx, exec, paths) {
  const cwd = exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd;
  const output = [];
  for (const raw of paths) {
    const target = await ctx.fs.resolve(String(raw), { ...(cwd ? { cwd } : {}), signal: exec.signal });
    const info = await ctx.fs.stat(target, exec.signal);
    if (!info || info.type !== 'file') throw new Error(`参考图片不存在：${raw}`);
    const maxBytes = Number(ctx.attachments?.imageLimits?.maxImageBytes) || 32 * 1024 * 1024;
    output.push(Buffer.from(await ctx.fs.readBytes(target, exec.signal, maxBytes)));
  }
  return output;
}

// —— 会话标题归档：文件夹名 = 会话标题，UI 改名后文件夹同步改名 ——

// 标题在 session/title 事件里；从活跃 session 对象倒序取最新一条。
function sessionTitleOf(session) {
  try {
    const events = session && session.events;
    if (!Array.isArray(events)) return '';
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event && event.type === 'session/title' && event.data && typeof event.data.title === 'string' && event.data.title.trim()) return event.data.title.trim();
    }
  } catch (err) {}
  return '';
}

function sanitizeFolderName(title) {
  const clean = String(title || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 60);
  return clean || '未命名会话';
}

const foldersIndexPath = () => join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'canvas-workbench', 'archive-folders.json');
async function readFolderIndex() {
  try {
    const parsed = JSON.parse(await readFile(foldersIndexPath(), 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.folders && typeof parsed.folders === 'object' ? parsed.folders : {};
  } catch (err) { return {}; }
}
async function writeFolderIndex(folders) {
  const path = foldersIndexPath();
  const value = JSON.stringify({ version: 1, updatedAt: Date.now(), folders });
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + '.hosttmp';
  try {
    await writeFile(temporary, value, 'utf8');
    await rename(temporary, path);
  } catch (err) {
    await writeFile(path, value, 'utf8').catch(() => {});
  }
}

const pathKey = (value) => String(value || '').replace(/\\/g, '/').replace(/\/+$/, '');
const markerPathOf = (folder) => join(folder, '.dsh-canvas-session.json');
const exists = async (path) => { try { await stat(path); return true; } catch (err) { return false; } };
async function markerSessionIdOf(folder) {
  try {
    const parsed = JSON.parse(await readFile(markerPathOf(folder), 'utf8'));
    return parsed && typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
  } catch (err) { return ''; }
}

// 返回该会话的归档文件夹（不存在则创建；标题变化则把旧文件夹改名）。
// 归属靠文件夹内 .dsh-canvas-session.json 标记 + 插件数据目录的索引双重记录，
// 索引丢失时仍能靠标记识别同标题文件夹的归属，避免两个同名会话互相覆盖。
async function sessionArchiveFolder(sessionId, session, current) {
  const title = sessionTitleOf(session) || '未命名会话';
  const wantedName = sanitizeFolderName(title);
  const root = current.project || current.cwd
    ? join(await archiveBaseFor(current), 'DSH聊天生成图片')
    : await archiveBaseFor(current);
  const folders = await readFolderIndex();
  const entry = folders[sessionId];
  let folder = entry && entry.folder && String(entry.folder).replace(/\\/g, '/').indexOf('/') >= 0 ? entry.folder : '';
  // 标题没变、文件夹仍在 → 直接复用。
  if (folder && entry.title === title && pathKey(dirname(folder)) === pathKey(root) && await exists(folder)) return folder;
  // 解析目标名：同标题文件夹若归属其他会话，追加短会话号区分。
  let target = join(root, wantedName);
  if (await exists(target) && folder && pathKey(target) !== pathKey(folder)) {
    const owner = await markerSessionIdOf(target);
    if (owner && owner !== sessionId) target = join(root, wantedName + '-' + sessionId.slice(0, 4));
  }
  // 旧文件夹改名跟随新标题（仅同一 root 内移动，跨项目/目录绑定变化不搬旧文件）。
  if (folder && await exists(folder) && pathKey(folder) !== pathKey(target) && pathKey(dirname(folder)) === pathKey(root)) {
    if (await exists(target)) target = join(root, wantedName + '-' + sessionId.slice(0, 4) + '-' + Date.now().toString(36).slice(-4));
    await rename(folder, target).catch(() => { target = folder; });
  } else if (!await exists(target)) {
    await mkdir(target, { recursive: true });
  }
  await writeFile(markerPathOf(target), JSON.stringify({ sessionId, title, updatedAt: Date.now() }), 'utf8').catch(() => {});
  folders[sessionId] = { title, folder: target };
  await writeFolderIndex(folders);
  return target;
}

async function archiveBaseFor(current) {
  if (current.project) return resolveCanvasProjectDirectory(current.project);
  if (current.cwd) return current.cwd;
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'canvas-workbench', '未归档生成图');
}

function parseArgs(raw = {}) {
  const prompt = String(raw.prompt || '').trim();
  if (!prompt) throw new Error('imagegen prompt 不能为空');
  const paths = Array.isArray(raw.referenced_image_paths) ? raw.referenced_image_paths.map(String).filter(Boolean) : [];
  const count = raw.num_last_images_to_include == null ? 0 : Number(raw.num_last_images_to_include);
  if (paths.length > MAX_REFERENCE_IMAGES) throw new Error(`最多支持 ${MAX_REFERENCE_IMAGES} 张参考图片`);
  if (count && (!Number.isInteger(count) || count < 1 || count > MAX_REFERENCE_IMAGES)) throw new Error(`最近图片数量必须为 1-${MAX_REFERENCE_IMAGES}`);
  if (paths.length && count) throw new Error('referenced_image_paths 与 num_last_images_to_include 不能同时使用');
  return { prompt, paths, count, outputPath: raw.output_path ? String(raw.output_path) : '' };
}

function contentOf(value) {
  const fileLine = value.file?.path
    ? `\n<output_path operation="${value.file.operation || 'create'}">${value.file.path}</output_path>`
    : value.writeError ? `\n<write_error>${value.writeError}</write_error>` : '';
  const noticeLine = value.notice ? `\n<notice>${value.notice}</notice>` : '';
  return [
    { type: 'text', text: `<image>image/png, ${value.image.width}x${value.image.height} px, ${value.image.bytes} bytes</image>${fileLine}${noticeLine}` },
    { type: 'image', attachment: value.image },
  ];
}

function routedTool(ctx, original, getChatContext) {
  return defineTool({
    name: TOOL_NAME,
    description: '聊天内生图/改图的唯一推荐入口：使用当前画布「图像引擎设置」生成或编辑图片，自动落盘归档到 DSH聊天生成图片/<会话名>/<日期>/<时段>，并遵循输入区选择的比例与数量。不要改用 codex-imagegen-bridge、pixel-image2 等技能脚本或外部 CLI——它们脱离画布管线，且在本环境常因缺 node 直接失败。设计模式开启时结果自动上画布；关闭设计模式时使用 DSH 原生图片工具。',
    parameters: {
      prompt: { type: 'string', required: true, description: '完整的图片生成或编辑要求。' },
      referenced_image_paths: { type: 'array', items: { type: 'string' }, description: '最多五张本地参考图片路径。' },
      num_last_images_to_include: { type: 'integer', description: '使用最近 1-5 张聊天图片。' },
      output_path: { type: 'string', description: '可选文件名；设计模式下始终归档到当前画布项目目录。' },
    },
    // 不复用 original.output：DSH 暴露的是已经编译成 JSON Schema 的对象，
    // 再传给 defineTool 会被当作 value-schema DSL 解析并在 2.0.x 启动时报错。
    // 这里保持与 dsh-codex imagegen 相同的值结构即可兼容委托结果。
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          prompt: { type: 'string', required: true },
          image: {
            type: 'object', required: true, additionalProperties: false,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', enum: ['image/png'], required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
              name: { type: 'string' },
            },
          },
          file: {
            type: 'object', additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              operation: { type: 'string', enum: ['create', 'update'], required: true },
            },
          },
          writeError: { type: 'string' },
          notice: { type: 'string' },
        },
      },
      render: (_args, value) => contentOf(value),
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      const sessionId = String(exec.agent && exec.agent.session && exec.agent.session.id || '');
      const current = getChatContext(sessionId);
      if (!current || !current.designMode) {
        if (!original || typeof original.execute !== 'function') throw new Error('DSH 原生 imagegen 工具尚未就绪');
        return original.execute(rawArgs, exec);
      }
      // 未绑定项目时不再抛「请先在右侧画布选择或新建项目」：那个报错会把
      // agent 逼向 pixel-image2 之类的旁路技能，图片完全脱离画布管线。
      // 现在生成与聊天推送照常，仅跳过归档并在结果里提示绑定。
      const args = parseArgs(rawArgs);
      const images = args.paths.length ? await workspaceImages(ctx, exec, args.paths) : args.count ? await recentImages(ctx, exec, args.count) : [];
      // 生成数量(两个引擎都支持:API 走 n 参数,dsh-codex 并行多请求):
      // begin/end 计数与产出张数一致,画布端占位与补位逻辑无需感知差异。
      const engineSettings = await readImageEngineSettings();
      const requestedCount = normalizeImageCount(engineSettings.imageCount);
      for (let i = 0; i < requestedCount; i += 1) beginChatGeneration();
      let generated;
      try {
        generated = await generateChatImage({ ctx, images, prompt: args.prompt, signal: exec.signal });
      } finally {
        for (let i = 0; i < requestedCount; i += 1) endChatGeneration();
      }
      const outputs = Array.isArray(generated.images) && generated.images.length ? generated.images : [generated.bytes];
      // 归档基础目录三级回退：绑定画布项目 → 项目内 DSH聊天生成图片；未绑定但有
      // 聊天工作目录 → 工作目录下的 DSH聊天生成图片；两者都没有 → 插件数据目录。
      // 生成图必须始终有落盘路径：没有它，聊天图片卡片拿不到 sourcePath，
      // 缩略图就只能依赖 DSH 原生附件解析，解析一失败整卡“加载图片失败”。
      // 会话层文件夹名 = 会话标题（UI 改名后在下一次生成/消息时同步改名）。
      let archiveNotice = '';
      if (!current.project && current.cwd) {
        archiveNotice = '当前聊天未绑定画布项目：图片已归档到聊天工作目录的 DSH聊天生成图片 文件夹。在右侧画布选择或新建项目后，后续生成会归档到项目内。';
      } else if (!current.project && !current.cwd) {
        archiveNotice = '当前聊天没有可用工作目录：图片已归档到插件数据目录的 未归档生成图 文件夹。';
      }
      // 归档再按 会话标题 → 日期 → 5小时时段 分层（0-5/5-10/10-15/15-20/20-24），
      // 避免一个项目的生成图全部平铺在一个目录里难以查找。
      const sessionFolder = await sessionArchiveFolder(sessionId, exec.agent && exec.agent.session, current);
      const now = new Date();
      const day = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const blockStart = Math.floor(now.getHours() / 5) * 5;
      const block = String(blockStart).padStart(2, '0') + '-' + String(Math.min(blockStart + 5, 24)).padStart(2, '0');
      const archiveDirectory = join(sessionFolder, day, block);
      let value = null;
      for (let index = 0; index < outputs.length; index += 1) {
        const bytes = outputs[index];
        const ref = await ctx.attachments.saveImage({ data: bytes, mediaType: 'image/png', name: 'generated.png' });
        const item = {
          prompt: args.prompt,
          image: { attachmentId: ref.attachmentId, mediaType: 'image/png', bytes: ref.bytes, width: ref.width, height: ref.height, name: 'generated.png' },
        };
        try {
          await mkdir(archiveDirectory, { recursive: true });
          const requested = args.outputPath ? basename(args.outputPath) : generatedName();
          const outputPath = await uniqueOutputPath(archiveDirectory, requested);
          await writeFile(outputPath, bytes, { flag: 'wx' });
          item.image.name = basename(outputPath);
          item.file = { path: outputPath, operation: 'create' };
          noteChatGenerationCompleted(outputPath);
          if (archiveNotice) item.notice = archiveNotice;
        } catch (err) {
          item.writeError = String((err && err.message) || err);
          if (archiveNotice) item.notice = archiveNotice;
        }
        // exec.parent 只在嵌套子调用（code-dispatch）时存在；聊天顶层 imagegen
        // 必须走 deferContext 把生成图作为上下文消息推入对话，否则工具结果被
        // compaction 清理后聊天里就看不到图了。deferContext 在 exec 上恒存在。
        // 多张时逐张推送,聊天里每张一张卡,与单张行为一致。
        if (typeof exec.deferContext === 'function') {
          // 会话格式 v4 要求 producer-owned source kind:{kind:'plugin',plugin:…} 旧包装会被
          // v3→v4 校验整轮拒收(format v4 message requires a producer-owned source kind)。
          // plugin:canvas-workbench 与迁移器对旧会话的改写结果一致,新旧会话形态统一。
          exec.deferContext(createUserMessage({ content: contentOf(item), source: CANVAS_MESSAGE_SOURCE }));
        }
        value = item;
      }
      if (outputs.length > 1 && value) value.imageCount = outputs.length;
      return value;
    },
    presentCall: () => ({ card: 'generic', title: '使用画布引擎生成图片', kind: 'execute' }),
    presentResult: (_args, result) => ({
      card: 'generic',
      title: result.imageCount > 1 ? `已生成 ${result.imageCount} 张图片`
        : result.file && !result.notice ? '图片已生成并归档到画布项目'
        : result.file ? '图片已生成（归档到聊天工作目录）'
        : result.writeError ? '图片已生成，但归档失败'
        : '图片已生成',
      content: result.content,
    }),
  });
}

/** Shadow the global imagegen tool per agent, keeping the base tool available when design mode is off. */
export function installChatImageRouter(ctx, getChatContext) {
  const installed = new Map();
  let syncing = false;
  const remove = (agent) => {
    const current = installed.get(agent);
    if (!current) return;
    installed.delete(agent);
    current.dispose();
  };
  const syncAgent = (agent) => {
    const original = ctx.tools.get(TOOL_NAME);
    const current = installed.get(agent);
    if (current && current.original === original) return;
    if (current) remove(agent);
    if (ctx.tools.get(TOOL_NAME, agent) !== original) return;
    const dispose = agent.ctx.tools.register(routedTool(ctx, original, getChatContext));
    installed.set(agent, { original, dispose });
  };
  const syncAll = () => {
    if (syncing) return;
    syncing = true;
    try {
      for (const agent of ctx.agents.list()) syncAgent(agent);
      for (const agent of [...installed.keys()]) if (ctx.agents.get(agent.id) !== agent) remove(agent);
    } finally { syncing = false; }
  };
  ctx.on('agent/created', async ({ agent }) => { syncAgent(agent); });
  ctx.on('agent/disposed', async ({ agent }) => { installed.delete(agent); });
  ctx.on('tools/change', async () => { syncAll(); });
  // UI 里改会话名后，下一条消息到达时同步归档文件夹改名（生成时也会同步）。
  ctx.on('agent/inbox/inserted', async ({ agent }) => {
    try {
      const session = agent && agent.session;
      const sid = session && session.id;
      if (!sid) return;
      const current = getChatContext(String(sid));
      if (!current || (!current.project && !current.cwd)) return;
      await sessionArchiveFolder(String(sid), session, current);
    } catch (err) {}
  });
  syncAll();
  ctx.effect(() => () => { for (const agent of [...installed.keys()]) remove(agent); }, 'canvas-workbench: chat image routing');
}
