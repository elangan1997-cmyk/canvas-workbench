// 本地工具链后台预置(v1.9.2):插件启动后在后台把 Python 运行时、rembg+模型、
// vtracer、dsh-codex 下载部署并自检,用户首次点击时已就绪。
// 下载全程镜像兜底:直连可达走官方源,否则 PyPI→清华、GitHub→gh 代理、npm→npmmirror。
// 所有状态落在 ~/.dsh/canvas-workbench/toolchain-status.json,前端经 /dsh-canvas/toolchain-status 读取。
import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHome } from './image-engine-settings.js';
import { resolvePython } from '../../../lib/platform.js';
import { logOp } from './op-log.js';

const PLUGIN_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DATA_ROOT = () => join(dshHome(), 'canvas-workbench');
const STATUS_PATH = () => join(DATA_ROOT(), 'toolchain-status.json');

const PIP_MIRRORS = ['https://pypi.tuna.tsinghua.edu.cn/simple', 'https://mirrors.aliyun.com/pypi/simple'];
const NPM_MIRROR = 'https://registry.npmmirror.com';
const GH_MIRRORS = ['https://gh-proxy.com/', 'https://ghfast.top/', 'https://mirror.ghproxy.com/'];

const PYTHON_BUILD_TAG = '20241016';
const PYTHON_VERSION = '3.11.10';
// dsh-codex 与 DSH 核心代际配对(官方按内核代际发版,peer 范围不交叉满足,
// 装错代际会被宿主启动时的 peer 校验直接拒载、显示"版本不匹配"):
// 0.2.x 核心(0.2.0 正式 / 0.2.0-rc.x)配 0.3.2(peers ^0.2.0-rc.1);
// 0.1.7-rc.x 内核配 0.3.1(peers ^0.1.7-rc.2)。核心换代时同步更新此表。
const DSH_CODEX_PAIRING = [
  { corePrefix: '0.2', version: '0.3.2' },
  { corePrefix: '0.1', version: '0.3.1' },
];
const DSH_CODEX_FALLBACK = '0.3.2';

function pairedDshCodexVersion(coreVersion) {
  const v = String(coreVersion || '');
  for (const row of DSH_CODEX_PAIRING) if (v.startsWith(row.corePrefix + '.')) return row.version;
  return DSH_CODEX_FALLBACK;
}

/** 运行时核心代际:借本插件必有的 peer(dsh-tools)的解析位置读宿主核心版本。 */
async function runningCoreVersion() {
  try {
    const { createRequire } = await import('node:module');
    const pkgPath = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-tools/package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    return String(pkg.version || '');
  } catch { return ''; }
}
// 2026-09-28 默认模型切 BiRefNet-lite(214MB,质量显著优于 isnet 的 170MB);
// 文件名必须与 rembg 会话名一致,pooch 按文件名命中缓存。
const REMBG_MODEL_URL = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx';
const REMBG_MODEL_FILE = 'birefnet-general-lite.onnx';

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
  // 注意:不要用 Readable.fromWeb + stream.pipeline——该链路在 Electron 44 / Node 24
  // 下会损坏字节流(Win 实机复刻验证:三个源直连全 GZIP-OK,经此链写盘后 magic 全错且字节数各异)。
  // 改为 web 标准 reader 循环,内存聚合后一次性写盘。
  let lastError = '';
  for (const url of urls) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const total = Number(res.headers.get('content-length')) || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let done = 0;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        const chunk = Buffer.from(step.value);
        chunks.push(chunk);
        done += chunk.length;
        if (onProgress && (total ? done % 5242880 < chunk.length : true)) onProgress(done, total);
      }
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) throw new Error('空响应');
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, buffer);
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

/** 单次 prepare 的硬超时:脚本内部对 pip 有 900s 超时,但 pooch 模型下载等环节没有,
 *  经系统代理的死连接会无限挂住整个预置队列(实测 2026-09-28),到点整组杀掉走重试。 */
const PREPARE_TIMEOUT_MS = 14 * 60 * 1000;

async function runPrepareOnce(python, scriptName, pipIndex, extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(python, [join(PLUGIN_ROOT, 'scripts', scriptName), '--prepare'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, DSH_PIP_INDEX: pipIndex, ...extraEnv },
    });
    let out = '';
    let err = '';
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => {
      if (!child.pid) return finish({ ok: false, error: '准备超时:进程未启动' });
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']).on('close', () => {});
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      finish({ ok: false, error: '准备超时(' + Math.round(PREPARE_TIMEOUT_MS / 60000) + ' 分钟),已终止并自动重试' });
    }, PREPARE_TIMEOUT_MS);
    child.stdout && child.stdout.on('data', (c) => { out += c; });
    child.stderr && child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => finish({ ok: false, error: String(e) }));
    child.on('close', (code) => finish({ ok: code === 0, out: out.slice(-300), err: err.slice(-300) }));
  });
}

async function preparePythonTool(python, scriptName, statusKey, extraEnv = {}) {
  try {
    await patchStatus({ [statusKey]: { state: 'preparing' } });
    await logOp('toolchain', { key: statusKey, phase: 'start' });
    // pip 源三级递进(2026-09-28 实测教训):
    //  1) 官方源 + NO_PROXY(绕开系统代理——Clash 类系统代理会把 files.pythonhosted.org
    //     的 CDN 拖到近 0 速,直连反而快);2) 可达镜像 + NO_PROXY(清华在本机实测 403,
    //     逐个探测取第一个可达的,阿里云兜底);3) 可达镜像 + 继承环境(应对直连被墙的网络)。
    // Windows 上杀软实时扫描会短暂锁住新落盘的依赖文件(WinError 32,实测 onnxruntime),
    // 属瞬时占用:失败等 20 秒重试,最多 3 次。
    let mirrorIndex = '';
    for (const mirror of PIP_MIRRORS) {
      if (await reachable(mirror)) { mirrorIndex = mirror; break; }
    }
    const bypassProxy = { ...extraEnv, NO_PROXY: '*', no_proxy: '*' };
    const strategies = [
      { pipIndex: '', env: bypassProxy },
      { pipIndex: mirrorIndex, env: bypassProxy },
      { pipIndex: mirrorIndex, env: { ...extraEnv } },
    ];
    let lastError = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const strategy = strategies[attempt - 1];
      const result = await runPrepareOnce(python, scriptName, strategy.pipIndex, strategy.env);
      await logOp('toolchain', { key: statusKey, phase: 'attempt-' + attempt, pipIndex: strategy.pipIndex || 'official', ok: result.ok, error: result.ok ? undefined : String(result.error || result.err || '').slice(0, 200) });
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
    await logOp('toolchain', { key: statusKey, phase: 'error', error: String((error && error.message) || error).slice(0, 300) });
    return false;
  }
}

/** 预下 BiRefNet-lite 模型(约 214MB):宿主走镜像链下好后,rembg 的 pooch 按文件名命中缓存不再联网。 */
async function ensureRembgModel() {
  const target = join(DATA_ROOT(), 'rembg-models', REMBG_MODEL_FILE);
  try {
    const info = await stat(target).catch(() => null);
    if (info && info.size > 150 * 1024 * 1024) {
      await patchStatus({ rembgModel: { state: 'ready' } });
      return;
    }
    await patchStatus({ rembgModel: { state: 'downloading' } });
    await logOp('toolchain', { key: 'rembgModel', phase: 'download-start', bytes: info && info.size });
    await download(mirrorChain(REMBG_MODEL_URL), target + '.part', (done, total) => {
      patchStatus({ rembgModel: { state: 'downloading', percent: total ? Math.round((done / total) * 100) : 0 } }).catch(() => {});
    });
    await rename(target + '.part', target);
    await patchStatus({ rembgModel: { state: 'ready' } });
    await logOp('toolchain', { key: 'rembgModel', phase: 'ready' });
  } catch (error) {
    await rm(target + '.part', { force: true }).catch(() => {});
    await patchStatus({ rembgModel: { state: 'error', error: String((error && error.message) || error).slice(0, 200) } }).catch(() => {});
    await logOp('toolchain', { key: 'rembgModel', phase: 'error', error: String((error && error.message) || error).slice(0, 300) });
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
 * 预置 dsh-codex(聊天生图引擎之一):按运行核心代际选配对版本(0.2.x→0.3.2,
 * 0.1.7→0.3.1),npm 拉取(官方源→npmmirror 兜底),解压进 profile 的
 * node_modules,并补 deps + bundles 注册,重启后插件与登录路由就位。
 * 已装版本与核心代际不匹配时(如桌面升级 0.2.0 后遗留 0.3.1)自动换正确版本。
 */
async function ensureDshCodex() {
  try {
    const profileDir = await activeProfileDir();
    const coreVersion = await runningCoreVersion();
    const DSH_CODEX_VERSION = pairedDshCodexVersion(coreVersion);
    const moduleEntry = join(profileDir, 'node_modules', 'dsh-codex', 'lib', 'index.js');
    if (await exists(moduleEntry)) {
      let installed = '';
      try { installed = String(JSON.parse(await readFile(join(profileDir, 'node_modules', 'dsh-codex', 'package.json'), 'utf8')).version || ''); } catch {}
      const knownOfficial = DSH_CODEX_PAIRING.some((row) => row.version === installed);
      if (installed === DSH_CODEX_VERSION || !knownOfficial) {
        // 版本已是配对版,或是官方配对表之外的自定义 fork(用户自管,不擅自替换)。
        await patchStatus({ dshCodex: { state: 'ready', source: 'existing', version: installed } });
        return;
      }
      await patchStatus({ dshCodex: { state: 'downloading', note: `已装 ${installed} 与核心 ${coreVersion || '?'} 代际不匹配,升级到 ${DSH_CODEX_VERSION}` } });
    } else {
      await patchStatus({ dshCodex: { state: 'downloading', note: `核心 ${coreVersion || '?'} → dsh-codex ${DSH_CODEX_VERSION}` } });
    }
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
    // npmmirror 的 tarball 会 302 到 cdn.npmmirror.com:把 CDN 直链也列为候选;
    // 逐候选下载并做 gzip 魔数校验,某源被网络干扰成乱码(HTTP 200 但非 gzip)时自动换下一个。
    const candidates = [
      `${NPM_MIRROR}/dsh-codex/-/dsh-codex-${DSH_CODEX_VERSION}.tgz`,
      `https://cdn.npmmirror.com/packages/dsh-codex/${DSH_CODEX_VERSION}/dsh-codex-${DSH_CODEX_VERSION}.tgz`,
      tarball,
    ];
    const archivePath = join(work, 'pkg.tgz');
    let archiveOk = false;
    let lastDownloadError = '';
    for (const candidate of candidates) {
      try {
        await download([candidate], archivePath);
        const { open: openHandle } = await import('node:fs/promises');
        const handle = await openHandle(archivePath, 'r');
        const head = Buffer.alloc(2);
        await handle.read(head, 0, 2, 0);
        await handle.close();
        if (head[0] === 0x1f && head[1] === 0x8b) { archiveOk = true; break; }
        await rm(archivePath, { force: true }).catch(() => {});
      } catch (err) {
        lastDownloadError = String((err && err.message) || err);
      }
    }
    if (!archiveOk) {
      throw new Error('下载内容校验失败(全部源均非 gzip,网络干扰),可稍后在状态卡点「立即准备」重试 ' + lastDownloadError.slice(0, 80));
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
      pkg.dependencies['dsh-codex'] = DSH_CODEX_VERSION;
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
        await preparePythonTool(python, 'export_text_psd.py', 'psdTools');
      }
      await ensureRembgModel();
      await ensureDshCodex();
      await patchStatus({ finishedAt: nowStamp() });
      await logOp('toolchain', { phase: 'finished' });
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
      await preparePythonTool(python, 'export_text_psd.py', 'psdTools');
    }
    await ensureRembgModel();
    await ensureDshCodex();
    await patchStatus({ finishedAt: nowStamp() });
    await logOp('toolchain', { phase: 'finished' });
    return { ok: true, status: await readToolchainStatus() };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    running = false;
  }
}
