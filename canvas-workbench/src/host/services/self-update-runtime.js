import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

// Desktop 0.2.1 moved pnpm under primary-runtime. Prefer the exact path
// supplied by the host; retain the older application layouts.
export function resolveBundledPnpm({ execPath = process.execPath, resourcesPath = process.resourcesPath,
  argv = process.argv, platform = process.platform, exists = existsSync } = {}) {
  const path = platform === 'win32' ? win32 : posix;
  const candidates = argv.filter((arg) => typeof arg === 'string' && path.isAbsolute(arg)
    && /[\\/]pnpm[\\/]bin[\\/]pnpm\.(?:mjs|cjs)$/i.test(arg));
  const roots = [resourcesPath,
    path.join(path.dirname(execPath), '..', platform === 'darwin' ? 'Resources' : 'resources'),
    path.join(path.dirname(execPath), 'resources')].filter(Boolean);
  for (const root of roots) {
    for (const layout of [['runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin'], ['runtime', 'pnpm', 'bin']]) {
      for (const name of ['pnpm.mjs', 'pnpm.cjs']) candidates.push(path.join(root, ...layout, name));
    }
  }
  const found = [...new Set(candidates)].find((candidate) => exists(candidate));
  if (!found) throw new Error('未找到 DSH 自带的 pnpm 安装器；请更新或重新安装 DSH 桌面应用后重试');
  return found;
}

export function profileDirectoryFromPluginPath(value) {
  const path = String(value || '').replace(/\\/g, '/');
  if (!path.includes('/node_modules/canvas-workbench/')) return '';
  // Works for direct installs and pnpm's resolved .pnpm/.../node_modules path.
  return path.slice(0, path.indexOf('/node_modules/'));
}

export function updaterFailureSummary(result) {
  if (result.error) return String(result.error);
  const lines = String(result.log || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const root = lines.findIndex((line) => /(?:^|\s)(?:Error:|TypeError:|SyntaxError:|ERR_[A-Z_]+|Cannot find module)/.test(line));
  return (root >= 0 ? lines.slice(root, root + 4) : lines.slice(0, 6)).join(' | ').slice(0, 1800)
    || '安装器退出码 ' + result.code;
}

export function updaterFallback({ exe, pnpm, version, profileDir, platform = process.platform }) {
  if (platform === 'win32') {
    const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    return '请完全退出 DSH 后在 PowerShell 运行：\n$env:ELECTRON_RUN_AS_NODE=1\n& '
      + [exe, pnpm, 'add', 'canvas-workbench@' + version, '--dir', profileDir].map(quote).join(' ');
  }
  const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return '请完全退出 DSH 后在终端运行：\nELECTRON_RUN_AS_NODE=1 '
    + [exe, pnpm, 'add', 'canvas-workbench@' + version, '--dir', profileDir].map(quote).join(' ');
}
