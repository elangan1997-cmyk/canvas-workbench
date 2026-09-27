// 本地工具链后台预置(v1.9.2):插件启动后在后台把 Python 运行时、rembg+模型、
// vtracer、dsh-codex 下载部署并自检,用户首次点击时已就绪。
// 下载全程镜像兜底:直连可达走官方源,否则 PyPI→清华、GitHub→gh 代理、npm→npmmirror。
// 所有状态落在 ~/.dsh/canvas-workbench/toolchain-status.json,前端经 /dsh-canvas/toolchain-status 读取。
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dshHome } from './image-engine-settings.js';
import { resolvePython } from '../../../lib/platform.js';

const PLUGIN_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DATA_ROOT = () => join(dshHome(), 'canvas-workbench');
const STATUS_PATH = () => join(DATA_ROOT(), 'toolchain-status.json');

const PIP_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const NPM_MIRROR = 'https://registry.npmmirror.com';
const GH_MIRRORS = ['https://gh-proxy.com/', 'https://mirror.ghproxy.com/'];

const PYTHON_BUILD_TAG = '20241016';
const PYTHON_VERSION = '3.11.10';
const DSH_CODEX_VERSION = '0.3.1';
const REMBG_MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx';

let running = false;

function nowStamp() { return Date.now(); }

export async function readToolchainStatus() {
  try { return JSON.parse(await readFile(STATUS_PATH(), 'utf8')); } catch { return { updatedAt: 0, items: {} }; }
}

async function patchStatus(patch) {
  const current = await readToolchainStatus();
  const next = { ...current, items: { ...current.items, ...patch }, updatedAt: nowStamp() };
  await mkdir(DATA_ROOT(), { recursive: true });
  await writeFile(STATUS_PATH(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

async function exists(path) { try { await access(path); return true; } catch { return false; } }

async function reachable(url, timeoutMs = 4000) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return res.ok || res.status === 405;
  } catch { return false; }
}

async function download(urls, dest, onProgress) {
  let lastError = '';
  for (const url of urls) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length')) || 0;
      let done = 0;
      const source = Readable.fromWeb(res.body);
      source.on('data', (chunk) => {
        done += chunk.length;
        if (onProgress && (total ? done % 5242880 < chunk.length : true)) onProgress(done, total);
      });
      await mkdir(dirname(dest), { recursive: true });
      await pipeline(source, createWriteStream(dest));
      const info = await stat(dest);
      if (!info.size) throw new Error('空文件');
      return dest;
    } catch (error) {
      lastError = String((error && error.message) || error);
      await rm(dest, { force: true }).catch(() => {});
    }
  }
  throw new Error('下载失败(已尝试全部镜像): ' + lastError);
}

function mirrorChain(githubUrl) {
  return [githubUrl, ...GH_MIRRORS.map((prefix) => prefix + githubUrl)];
}

function runCommand(cmd, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], ...options });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolve({ ok: false, error: String(error) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stderr: stderr.slice(-400) }));
  });
}

function pythonAsset() {
  const platformKey = process.platform;
  const archKey = process.arch;
  if (platformKey === 'darwin' && archKey === 'arm64') return `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-aarch64-apple-darwin-install_only.tar.gz`;
  if (platformKey === 'darwin') return `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-x86_64-apple-darwin-install_only.tar.gz`;
  if (platformKey === 'win32') return `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-x86_64-pc-windows-msvc-install_only.zip`;
  if (platformKey === 'linux' && archKey === 'arm64') return `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-aarch64-unknown-linux-gnu-install_only.tar.gz`;
  if (platformKey === 'linux') return `cpython-${PYTHON_VERSION}+${PYTHON_BUILD_TAG}-x86_64-unknown-linux-gnu-install_only.tar.gz`;
  return '';
}

/** 确保 Python 可用:优先自带运行时/系统 Python;都没有时后台下载便携版到 python-runtime。 */
async function ensurePython(ctx) {
  try {
    const found = await resolvePython(ctx).catch(() => null);
    if (found) {
      const version = await new Promise((resolve) => {
        const child = spawn(found.executable, ['--version']);
        let out = '';
        child.stdout && child.stdout.on('data', (c) => { out += c; });
        child.on('error', () => resolve(''));
        child.on('close', () => resolve(out.trim()));
      });
      await patchStatus({ python: { state: 'ready', source: found.managed ? 'runtime' : 'system', version } });
      return found.executable;
    }
  } catch (error) {
    await patchStatus({ python: { state: 'error', error: String((error && error.message) || error) } });
    return '';
  }
  const asset = pythonAsset();
  if (!asset) {
    await patchStatus({ python: { state: 'skipped', reason: '当前平台无便携构建' } });
    return '';
  }
  const runtimeRoot = join(DATA_ROOT(), 'python-runtime');
  try {
    await patchStatus({ python: { state: 'downloading', asset } });
    const base = `https://github.com/astral-sh/python-build-standalone/releases/download/${PYTHON_BUILD_TAG}/`;
    const work = join(tmpdir(), 'dsh-python-' + Date.now().toString(36));
    await mkdir(work, { recursive: true });
    const archive = join(work, asset);
    await download(mirrorChain(base + asset), archive, (done, total) => {
      patchStatus({ python: { state: 'downloading', asset, percent: total ? Math.round((done / total) * 100) : 0 } }).catch(() => {});
    });
    await patchStatus({ python: { state: 'extracting' } });
    // 两种压缩包都由系统 tar 处理:macOS bsdtar 与 Windows 10+ 内置 tar 均支持 tar.gz 与 zip。
    const extracted = await runCommand('tar', ['-xf', archive, '-C', work]);
    if (!extracted.ok) throw new Error('解压失败: ' + extracted.stderr);
    // 官方包顶层是 python/ 目录,整体搬到 python-runtime(resolvePython 探测的就是这里)。
    const inner = join(work, 'python');
    if (!(await exists(inner))) throw new Error('压缩包结构异常(缺少 python/ 顶层目录)');
    await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
    if (process.platform === 'win32') {
      await mkdir(runtimeRoot, { recursive: true });
      const moved = await runCommand('cmd', ['/c', `robocopy "${inner}" "${runtimeRoot}" /e /move /nfl /ndl /njh /njs`]);
      // robocopy 成功码是 0-7,spawn 里只有 0 算 ok;1 表示"有文件复制",也视为成功。
      if (!moved.ok && moved.code !== 1) throw new Error('搬移运行时失败: ' + moved.stderr);
    } else {
      const moved = await runCommand('mv', [inner, runtimeRoot]);
      if (!moved.ok) throw new Error('搬移运行时失败: ' + moved.stderr);
    }
    const verify = await resolvePython(ctx).catch(() => null);
    if (!verify) throw new Error('便携运行时解压后仍不可用');
    await rm(work, { recursive: true, force: true }).catch(() => {});
    await patchStatus({ python: { state: 'ready', source: 'runtime', downloaded: true } });
    return verify.executable;
  } catch (error) {
    await patchStatus({ python: { state: 'error', error: String((error && error.message) || error) } });
    return '';
  }
}

async function runPrepareOnce(python, scriptName, pipIndex, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(python, [join(PLUGIN_ROOT, 'scripts', scriptName), '--prepare'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, DSH_PIP_INDEX: pipIndex, ...extraEnv },
    });
    let out = '';
    let err = '';
    child.stdout && child.stdout.on('data', (c) => { out += c; });
    child.stderr && child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => resolve({ ok: false, error: String(e) }));
    child.on('close', (code) => resolve({ ok: code === 0, out: out.slice(-300), err: err.slice(-300) }));
  });
}

async function preparePythonTool(python, scriptName, statusKey, extraEnv = {}) {
  try {
    await patchStatus({ [statusKey]: { state: 'preparing' } });
    // PyPI 直连不可达时走清华镜像(镜像全球可用,只是境外稍慢)。
    let pipIndex = '';
    if (!(await reachable('https://pypi.org/simple/'))) pipIndex = PIP_MIRROR;
    // Windows 上杀软实时扫描会短暂锁住新落盘的依赖文件(WinError 32,实测 onnxruntime),
    // 属瞬时占用:失败等 20 秒重试,最多 3 次。
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await runPrepareOnce(python, scriptName, pipIndex, extraEnv);
      if (result.ok) {
        await patchStatus({ [statusKey]: { state: 'ready' } });
        return true;
      }
      lastError = (result.err || result.out || result.error || 'prepare 退出码非 0').slice(0, 200);
      if (attempt < 3) {
        await patchStatus({ [statusKey]: { state: 'preparing', retry: attempt + 1 } });
        await new Promise((resolve) => setTimeout(resolve, 20000));
      }
    }
    throw new Error(lastError);
  } catch (error) {
    await patchStatus({ [statusKey]: { state: 'error', error: String((error && error.message) || error).slice(0, 200) } });
    return false;
  }
}

/** 预下 isnet 模型(约 170MB):宿主走镜像链下好后,rembg 的 pooch 按文件名命中缓存不再联网。 */
async function ensureRembgModel() {
  const target = join(DATA_ROOT(), 'rembg-models', 'isnet-general-use.onnx');
  try {
    const info = await stat(target).catch(() => null);
    if (info && info.size > 100 * 1024 * 1024) {
      await patchStatus({ rembgModel: { state: 'ready' } });
      return;
    }
    await patchStatus({ rembgModel: { state: 'downloading' } });
    await download(mirrorChain(REMBG_MODEL_URL), target + '.part', (done, total) => {
      patchStatus({ rembgModel: { state: 'downloading', percent: total ? Math.round((done / total) * 100) : 0 } }).catch(() => {});
    });
    await rename(target + '.part', target);
    await patchStatus({ rembgModel: { state: 'ready' } });
  } catch (error) {
    await rm(target + '.part', { force: true }).catch(() => {});
    await patchStatus({ rembgModel: { state: 'error', error: String((error && error.message) || error).slice(0, 200) } });
  }
}

/** 找到装着 canvas-workbench 的 profile(找不到回退 web),作为 dsh-codex 的安装落点。 */
async function activeProfileDir() {
  const profilesRoot = join(dshHome(), 'profiles');
  const { readdir } = await import('node:fs/promises');
  let fallback = '';
  try {
    for (const entry of await readdir(profilesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const pkgPath = join(profilesRoot, entry.name, 'package.json');
      try {
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
        if (pkg && pkg.dependencies && pkg.dependencies['canvas-workbench']) return join(profilesRoot, entry.name);
        if (entry.name === 'web') fallback = join(profilesRoot, entry.name);
      } catch {}
    }
  } catch {}
  return fallback || join(profilesRoot, 'web');
}

/**
 * 预置 dsh-codex(聊天生图引擎之一):npm 拉 0.3.1(官方源→npmmirror 兜底),
 * 解压进 profile 的 node_modules,并补 deps + bundles 注册,重启后插件与登录路由就位。
 */
async function ensureDshCodex() {
  try {
    const profileDir = await activeProfileDir();
    const moduleEntry = join(profileDir, 'node_modules', 'dsh-codex', 'lib', 'index.js');
    if (await exists(moduleEntry)) {
      await patchStatus({ dshCodex: { state: 'ready', source: 'existing' } });
      return;
    }
    await patchStatus({ dshCodex: { state: 'downloading' } });
    const registry = (await reachable('https://registry.npmjs.org/dsh-codex')) ? 'https://registry.npmjs.org' : NPM_MIRROR;
    const metaRes = await fetch(`${registry}/dsh-codex/${DSH_CODEX_VERSION}`, { redirect: 'follow' });
    if (!metaRes.ok) throw new Error('读取 dsh-codex 包信息失败 HTTP ' + metaRes.status);
    const meta = await metaRes.json();
    const tarball = meta && meta.dist && meta.dist.tarball;
    if (!tarball) throw new Error('包信息里没有 tarball 地址');
    const work = join(tmpdir(), 'dsh-codex-' + Date.now().toString(36));
    await mkdir(work, { recursive: true });
    const target = join(profileDir, 'node_modules', 'dsh-codex');
    // tarball 下载:npmmirror 优先(大陆对官方源 tarball CDN 常被干扰成乱码,实测 HTTP 200 但内容损坏),
    // 下载后校验 gzip 魔数(1F 8B),不是 gzip 就换下一个源重试。
    const mirrorTarball = `${NPM_MIRROR}/dsh-codex/-/dsh-codex-${DSH_CODEX_VERSION}.tgz`;
    const archivePath = join(work, 'pkg.tgz');
    await download([mirrorTarball, tarball], archivePath);
    const { open: openHandle } = await import('node:fs/promises');
    const handle = await openHandle(archivePath, 'r');
    const head = Buffer.alloc(2);
    await handle.read(head, 0, 2, 0);
    await handle.close();
    if (head[0] !== 0x1f || head[1] !== 0x8b) {
      await rm(archivePath, { force: true }).catch(() => {});
      throw new Error('下载内容校验失败(非 gzip,源被干扰),可稍后在状态卡点「立即准备」重试');
    }
    const extracted = await runCommand('tar', ['-xzf', archivePath, '-C', work]);
    if (!extracted.ok) throw new Error('解压失败: ' + extracted.stderr);
    await mkdir(target, { recursive: true });
    // tarball 顶层是 package/,内容平移到目标。
    await rm(target, { recursive: true, force: true }).catch(() => {});
    await rename(join(work, 'package'), target);
    // deps + bundles 注册(与官方桌面安装 canvas-workbench 的方式一致)。
    const pkgPath = join(profileDir, 'package.json');
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      pkg.dependencies = pkg.dependencies || {};
      if (!pkg.dependencies['dsh-codex']) pkg.dependencies['dsh-codex'] = DSH_CODEX_VERSION;
      const bundles = (((pkg.dsh || {}).profile || {}).bundles);
      if (Array.isArray(bundles) && !bundles.includes('dsh-codex')) bundles.push('dsh-codex');
      await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
    } catch {}
    await rm(work, { recursive: true, force: true }).catch(() => {});
    await patchStatus({ dshCodex: { state: 'ready', downloaded: true, restartRequired: true, profile: profileDir } });
  } catch (error) {
    await patchStatus({ dshCodex: { state: 'error', error: String((error && error.message) || error).slice(0, 200) } });
  }
}

/**
 * 后台预置入口:宿主 apply 后延迟触发,串行推进,任何一步失败都不影响其余与插件本体。
 * 已全部就绪时静默跳过;单实例锁防止重复并发。
 */
export function startToolchainProvisioning(ctx) {
  if (running) return;
  running = true;
  const timer = setTimeout(async () => {
    try {
      const python = await ensurePython(ctx);
      if (python) {
        await preparePythonTool(python, 'remove_background.py', 'rembg');
        await preparePythonTool(python, 'vectorize_image.py', 'vectorize');
        await preparePythonTool(python, 'ocr_image.py', 'ocr');
      }
      await ensureRembgModel();
      await ensureDshCodex();
      await patchStatus({ finishedAt: nowStamp() });
    } catch (error) {
      await patchStatus({ error: String((error && error.message) || error).slice(0, 200) }).catch(() => {});
    } finally {
      running = false;
    }
  }, 8000);
  if (typeof timer.unref === 'function') timer.unref();
}

/** 手动触发(设置面板“立即准备”按钮):同一编排,立即执行。 */
export async function runToolchainProvisioning(ctx) {
  if (running) return { ok: true, alreadyRunning: true };
  running = true;
  try {
    const python = await ensurePython(ctx);
    if (python) {
      await preparePythonTool(python, 'remove_background.py', 'rembg');
      await preparePythonTool(python, 'vectorize_image.py', 'vectorize');
      await preparePythonTool(python, 'ocr_image.py', 'ocr');
    }
    await ensureRembgModel();
    await ensureDshCodex();
    await patchStatus({ finishedAt: nowStamp() });
    return { ok: true, status: await readToolchainStatus() };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    running = false;
  }
}
