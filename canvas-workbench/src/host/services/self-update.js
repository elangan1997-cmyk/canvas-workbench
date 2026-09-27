// 插件自更新(v1.9.4):检查 npm 最新版(官方源→npmmirror 兜底),一键用应用自带的
// pnpm 完成 profile 依赖/锁文件/白名单升级——与手动升级流程完全一致,不再依赖
// 插件市场检索节奏(市场有 minimumReleaseAge 24h 策略,且未必及时提供更新按钮)。
// 源码/开发副本安装(@local)不支持,提示走同步脚本。
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_PATH = fileURLToPath(import.meta.url);
const NPM_REGISTRY = 'https://registry.npmjs.org';
const NPM_MIRROR = 'https://registry.npmmirror.com';
const PACKAGE_NAME = 'canvas-workbench';

function normalizeSlashes(path) { return String(path || '').replace(/\\/g, '/'); }

/** 由本文件所在路径推导安装形态与 profile 目录。 */
export function installContext() {
  const self = normalizeSlashes(SELF_PATH);
  const marker = '/node_modules/' + PACKAGE_NAME + '/';
  const index = self.indexOf(marker);
  if (index < 0) return { mode: 'source' };
  const installRoot = self.slice(0, index); // <profile>/node_modules 或 <profiles>/node_modules/@local
  if (installRoot.endsWith('/@local') || installRoot.endsWith('\\@local')) return { mode: 'local' };
  return { mode: 'profile', profileDir: dirname(installRoot) };
}

function compareVersions(a, b) {
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = Number(pa[i]) || 0;
    const nb = Number(pb[i]) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

async function fetchJson(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally { clearTimeout(timer); }
}

export async function readInstalledVersion() {
  try {
    const pkg = JSON.parse(await readFile(join(dirname(SELF_PATH), '../../../package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch { return ''; }
}

/** 检查更新:返回当前/最新/是否有更新,以及安装形态(source/local 不支持一键更新)。 */
export async function checkUpdate() {
  const context = installContext();
  const current = await readInstalledVersion();
  let latest = '';
  let registry = '';
  let error = '';
  for (const base of [NPM_REGISTRY, NPM_MIRROR]) {
    try {
      const manifest = await fetchJson(base + '/' + PACKAGE_NAME);
      latest = String((manifest.distTags && manifest.distTags.latest) || (manifest['dist-tags'] && manifest['dist-tags'].latest) || '');
      if (latest) { registry = base; break; }
    } catch (err) { error = String((err && err.message) || err); }
  }
  const supportSelfUpdate = context.mode === 'profile';
  return {
    ok: Boolean(latest || current),
    current,
    latest,
    registry,
    hasUpdate: Boolean(latest && current && compareVersions(latest, current) > 0),
    mode: context.mode,
    profileDir: context.profileDir || '',
    supported: supportSelfUpdate,
    error: latest ? '' : (error || '无法读取最新版本')
  };
}

function runUpdater(exe, args, env, onOutput) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const feed = (chunk) => { out += chunk; if (onOutput) onOutput(String(chunk)); };
    if (child.stdout) child.stdout.on('data', feed);
    if (child.stderr) child.stderr.on('data', feed);
    child.on('error', (error) => resolve({ ok: false, log: out, error: String(error && error.message || error) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, log: out }));
  });
}

/**
 * 执行自更新:改 profile 三处配置 → 应用自带 pnpm 安装 → 要求重启 DSH。
 * Windows 下若个别文件被占用(EBUSY),返回可复制的 PowerShell 兜底命令。
 */
export async function performSelfUpdate() {
  const context = installContext();
  if (context.mode !== 'profile') {
    return { ok: false, error: context.mode === 'local' ? '本机为开发副本安装,请用仓库同步脚本更新' : '源码运行环境不支持一键更新' };
  }
  const check = await checkUpdate();
  if (!check.latest) return { ok: false, error: '读取最新版本失败:' + check.error };
  if (!check.hasUpdate) return { ok: true, upToDate: true, current: check.current };
  const { profileDir } = context;

  // 1) 取目标版本的 integrity 与 tarball
  let manifest = null;
  for (const base of [NPM_REGISTRY, NPM_MIRROR]) {
    try { manifest = await fetchJson(base + '/' + PACKAGE_NAME + '/' + check.latest); if (manifest && manifest.dist) break; } catch {}
  }
  if (!manifest || !manifest.dist) return { ok: false, error: '读取版本信息失败' };
  const integrity = String(manifest.dist.integrity || '');

  // 2) 三处配置升级(package.json / pnpm-lock.yaml / pnpm-workspace.yaml)
  try {
    const pkgPath = join(profileDir, 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    pkg.dependencies = pkg.dependencies || {};
    pkg.dependencies[PACKAGE_NAME] = '^' + check.latest;
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, error: '更新 package.json 失败:' + String((err && err.message) || err) };
  }
  try {
    const lockPath = join(profileDir, 'pnpm-lock.yaml');
    const lock = await readFile(lockPath, 'utf8');
    let next = lock.replace(new RegExp('(canvas-workbench:\\n\\s+specifier: \\^?)[0-9.]+\\n\\s+version: [0-9.]+'), '$1' + check.latest + '\n        version: ' + check.latest);
    next = next.replace(new RegExp('canvas-workbench@[0-9.]+:\\n\\s+resolution: \\{integrity: [^}]+\\}'), 'canvas-workbench@' + check.latest + ':\n    resolution: {integrity: ' + integrity + '}');
    next = next.replace(new RegExp('canvas-workbench@[0-9.]+: \\{\\}'), 'canvas-workbench@' + check.latest + ': {}');
    await writeFile(lockPath, next, 'utf8');
  } catch (err) {
    return { ok: false, error: '更新锁文件失败:' + String((err && err.message) || err) };
  }
  try {
    const wsPath = join(profileDir, 'pnpm-workspace.yaml');
    const ws = await readFile(wsPath, 'utf8');
    const entry = PACKAGE_NAME + '@' + check.latest;
    const next = /- canvas-workbench@[0-9.]+/.test(ws)
      ? ws.replace(new RegExp('- canvas-workbench@[0-9.]+'), '- ' + entry)
      : ws.replace(/\nminimumReleaseAgeExclude:\n/, '\nminimumReleaseAgeExclude:\n  - ' + entry + '\n');
    await writeFile(wsPath, next, 'utf8');
  } catch (err) {
    return { ok: false, error: '更新安装策略白名单失败:' + String((err && err.message) || err) };
  }

  // 3) 应用自带 pnpm 安装(ELECTRON_RUN_AS_NODE 复用应用二进制)
  const exe = process.execPath;
  const resources = process.resourcesPath || join(dirname(exe), '..', 'resources');
  const pnpm = join(resources, 'runtime', 'pnpm', 'bin', 'pnpm.mjs');
  const result = await runUpdater(exe, [pnpm, 'install', '--dir', profileDir], { ...process.env, ELECTRON_RUN_AS_NODE: '1' });
  const logTail = String(result.log || '').split(/\r?\n/).filter(Boolean).slice(-6).join(' | ');
  if (!result.ok) {
    const fallback = `操作失败(可能文件被占用)。请完全退出 DSH 后在 PowerShell 运行:\n$env:ELECTRON_RUN_AS_NODE=1\n& "${exe}" "${pnpm}" install --dir "${profileDir}"`;
    return { ok: false, error: (result.error || logTail || '安装器退出码 ' + result.code) + '\n' + fallback, log: result.log };
  }
  return { ok: true, installed: check.latest, restartRequired: true, log: logTail };
}
