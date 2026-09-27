// Adobe 桥接 Host 服务：握手文件、收件清单校验、发件箱写入、出处解析、脚本安装、日志。
// 协议契约见 adobe-bridge/PROTOCOL.md；纯函数在 ../../shared/utils/adobe-bridge.js（有单测）。
// 本文件只做文件系统 I/O，不依赖 DSH ctx（便于 tests/unit 用临时目录直接测）。
import { access, appendFile, copyFile, cp, mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { isWindows as OS_IS_WINDOWS, platformName, userHome } from '../../../lib/platform.js';
import {
  ADOBE_BRIDGE_APPS, ADOBE_BRIDGE_DIR, ADOBE_BRIDGE_INBOX, ADOBE_BRIDGE_OUTBOX, ADOBE_BRIDGE_PROTOCOL,
  bridgeExtOf, buildOutboundManifest, isPendingBridgeManifest, isReturnableBridgeFile, nextOutboxSeq, outboxFileName, validateInboundManifest
} from '../../shared/utils/adobe-bridge.js';

const HANDSHAKE_FILE = 'bridge.json';
const LOG_FILE = 'bridge-log.jsonl';
const INSTALLED_FILE = 'scripts-installed.json';
// 每个应用装进菜单的文件集（面板 + 无界面一键脚本 + 共享核心）；用户副本 = 两者并集。
// PS 菜单里不该出现 AI 的脚本，所以按应用分开。
const SCRIPT_FILES_BY_APP = {
  photoshop: ['dsh-bridge-core.jsx', 'DSH画布桥接-Photoshop.jsx', 'DSH桥接-发送选中图层-Photoshop.jsx', 'DSH桥接-置入返回件-Photoshop.jsx'],
  illustrator: ['dsh-bridge-core.jsx', 'DSH画布桥接-Illustrator.jsx', 'DSH桥接-发送选中对象-Illustrator.jsx', 'DSH桥接-置入返回件-Illustrator.jsx']
};
const SCRIPT_FILES = [...new Set([...SCRIPT_FILES_BY_APP.photoshop, ...SCRIPT_FILES_BY_APP.illustrator])];
const filesForApp = (app) => SCRIPT_FILES_BY_APP[app] || SCRIPT_FILES;
// 心跳：客户端 3s 一次 activate；握手文件最多 20s 重写一次（项目变化时立即写）。
const HANDSHAKE_REWRITE_MS = 20000;
// 收件文件写完 ≥ 1s 才算稳定（脚本用 .part+rename，这里再兜一层）。
const INBOUND_STABLE_MS = 1000;
const LOG_ROTATE_BYTES = 2 * 1024 * 1024;

function bridgeRootDir(home) {
  return join(home || userHome(), '.dsh', 'canvas-workbench', 'adobe-bridge');
}

/** 项目内桥接目录集合。 */
function bridgeDirsFor(projectDir) {
  const root = join(projectDir, ADOBE_BRIDGE_DIR);
  return {
    root,
    inbox: { photoshop: join(root, ADOBE_BRIDGE_INBOX.photoshop), illustrator: join(root, ADOBE_BRIDGE_INBOX.illustrator) },
    outbox: join(root, ADOBE_BRIDGE_OUTBOX)
  };
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJsonAtomic(path, value) {
  const temporary = path + '.hosttmp';
  const text = JSON.stringify(value, null, 2);
  try {
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, path);
  } catch {
    await writeFile(path, text, 'utf8');
  }
}

/**
 * @param {object} options
 * @param {string} [options.pluginVersion] 不传则懒读 pluginRoot/package.json
 * @param {string} options.pluginRoot 插件根目录（找 adobe-bridge/*.jsx）
 * @param {(path: string, mtimeMs: number) => string} [options.previewUrl]
 * @param {string} [options.home] 测试注入用户目录
 * @param {(exe: string, args: string[], cwd: string, timeoutMs: number) => Promise<{exitCode:number, stdout:string, stderr:string, timedOut?:boolean}>} [options.runProcess] 远程驱动用（host 传 runProcessWithTimeout）
 * @param {(name: string) => Promise<string>} [options.resolveExecutable] 远程驱动用（host 传 ctx.subprocess.resolveExecutable）
 * @param {boolean} [options.isWindows] 单测注入：在 macOS 上模拟 Windows 分支；生产取平台真值
 */
export function createAdobeBridge({ pluginVersion, pluginRoot, previewUrl, home, runProcess, resolveExecutable, isWindows: isWindowsOverride }) {
  const isWindows = typeof isWindowsOverride === 'boolean' ? isWindowsOverride : OS_IS_WINDOWS;
  const root = bridgeRootDir(home);
  const active = { projectDir: '', projectName: '', sessionId: '', at: 0, writtenAt: 0 };
  let versionCache = String(pluginVersion || '');
  const version = async () => {
    if (!versionCache) {
      try { versionCache = String(JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8')).version || ''); } catch { versionCache = '?'; }
    }
    return versionCache;
  };

  const log = async (event, detail) => {
    try {
      await mkdir(root, { recursive: true });
      const path = join(root, LOG_FILE);
      try { const info = await stat(path); if (info.size > LOG_ROTATE_BYTES) await rename(path, path + '.1'); } catch {}
      await appendFile(path, JSON.stringify({ at: new Date().toISOString(), event, ...(detail || {}) }) + '\n', 'utf8');
    } catch {}
  };

  /* 「已安装」= 至少装进了一个 Adobe 会扫描的目录（用户副本不算：那只是给「浏览…」用的） */
  const scriptsInstalled = async () => {
    try { const record = await readJson(join(root, INSTALLED_FILE)); return Array.isArray(record.installed) && record.installed.length > 0; } catch { return false; }
  };

  const writeHandshake = async () => {
    await mkdir(root, { recursive: true });
    const dirs = active.projectDir ? bridgeDirsFor(active.projectDir) : null;
    if (dirs) {
      await mkdir(dirs.inbox.photoshop, { recursive: true });
      await mkdir(dirs.inbox.illustrator, { recursive: true });
      await mkdir(dirs.outbox, { recursive: true });
    }
    const payload = {
      protocol: ADOBE_BRIDGE_PROTOCOL,
      plugin: 'canvas-workbench',
      pluginVersion: await version(),
      platform: platformName,
      updatedAt: Date.now(),
      canvasVisible: true,
      project: dirs ? { dir: active.projectDir, name: active.projectName || basename(active.projectDir) } : null,
      inbox: dirs ? { photoshop: dirs.inbox.photoshop, illustrator: dirs.inbox.illustrator } : null,
      outbox: dirs ? dirs.outbox : null,
      scriptsInstalled: await scriptsInstalled()
    };
    await writeJsonAtomic(join(root, HANDSHAKE_FILE), payload);
    active.writtenAt = Date.now();
    return payload;
  };

  /** 客户端心跳：项目变化立即重写握手，否则最多 20s 一次。 */
  const activate = async ({ projectDir, projectName, sessionId }) => {
    const nextDir = String(projectDir || '');
    const changed = nextDir !== active.projectDir;
    active.projectDir = nextDir;
    active.projectName = String(projectName || '');
    active.sessionId = String(sessionId || '');
    active.at = Date.now();
    if (changed || Date.now() - active.writtenAt > HANDSHAKE_REWRITE_MS) {
      const payload = await writeHandshake();
      if (changed) await log('activate', { projectDir: nextDir, sessionId: active.sessionId });
      return payload;
    }
    return null;
  };

  /** 列出某项目所有收件清单（含已处理），供出处解析。 */
  const readInboundManifests = async (projectDir, { pendingOnly } = {}) => {
    const dirs = bridgeDirsFor(projectDir);
    const found = [];
    for (const app of ADOBE_BRIDGE_APPS) {
      const directory = dirs.inbox[app];
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() || !/\.json$/i.test(entry.name) || entry.name.startsWith('.')) continue;
        const pending = isPendingBridgeManifest(entry.name);
        if (pendingOnly && !pending) continue;
        const manifestPath = join(directory, entry.name);
        let raw;
        try { raw = await readJson(manifestPath); } catch (err) {
          if (pending) await log('inbound-manifest-invalid', { manifestPath, error: String(err && err.message || err) });
          continue;
        }
        const checked = validateInboundManifest(raw);
        if (!checked.ok) {
          if (pending) {
            await log('inbound-manifest-rejected', { manifestPath, error: checked.error });
            await rename(manifestPath, manifestPath.replace(/\.json$/i, '.failed.json')).catch(() => {});
          }
          continue;
        }
        found.push({ app, directory, manifestPath, manifestName: entry.name, pending, manifest: raw });
      }
    }
    return found;
  };

  /** 待处理收件：校验文件存在、非空、稳定；返回客户端可直接 add-image 的 items。 */
  const listInbound = async (projectDir) => {
    const manifests = await readInboundManifests(projectDir, { pendingOnly: true });
    const results = [];
    const now = Date.now();
    for (const entry of manifests) {
      const items = [];
      let ready = true;
      for (const item of entry.manifest.items) {
        const path = join(entry.directory, item.file);
        let info;
        try { info = await stat(path); } catch { ready = false; break; }
        if (!info.isFile() || info.size <= 0 || now - info.mtimeMs < INBOUND_STABLE_MS) { ready = false; break; }
        items.push({
          path, name: item.file, kind: bridgeExtOf(item.file) || 'png', mtime: info.mtimeMs, size: info.size,
          url: previewUrl ? previewUrl(path, info.mtimeMs) : '',
          layer: item.layer || null, bounds: item.bounds || null, artboard: item.artboard || null
        });
      }
      if (!ready) continue;
      results.push({
        app: entry.app, jobId: entry.manifest.jobId, manifestName: entry.manifestName, manifestPath: entry.manifestPath,
        document: entry.manifest.document || null, merged: !!entry.manifest.merged, createdAt: Number(entry.manifest.createdAt) || 0, items
      });
    }
    return results;
  };

  /** 客户端已把收件放上画布：清单改名 .done.json（保留，供返回时查出处）。 */
  const ackInbound = async (projectDir, manifestName) => {
    const name = basename(String(manifestName || ''));
    if (!isPendingBridgeManifest(name)) throw new Error('无效的清单名：' + name);
    const dirs = bridgeDirsFor(projectDir);
    for (const app of ADOBE_BRIDGE_APPS) {
      const source = join(dirs.inbox[app], name);
      if (!(await exists(source))) continue;
      const target = source.replace(/\.json$/i, '.done.json');
      await rename(source, target);
      await log('inbound-ack', { app, manifest: name });
      return { ok: true, app, manifest: basename(target) };
    }
    throw new Error('清单不存在或已处理：' + name);
  };

  /**
   * 出处解析：bridge.jobId → 清单；否则按文件名匹配清单 items。
   * 返回 PROTOCOL §4 的 origin 结构或 null。
   */
  const resolveOrigin = async (projectDir, { jobId, sourcePath }) => {
    let manifests;
    try { manifests = await readInboundManifests(projectDir); } catch { return null; }
    const fileName = basename(String(sourcePath || ''));
    const pick = (entry, item) => ({
      app: entry.app, jobId: entry.manifest.jobId, document: entry.manifest.document || null,
      layer: item ? item.layer || null : null, bounds: item ? item.bounds || null : null, artboard: item ? item.artboard || null : null
    });
    if (jobId) {
      const entry = manifests.find((m) => m.manifest.jobId === jobId);
      if (entry) {
        const item = entry.manifest.items.find((it) => it.file === fileName) || entry.manifest.items[0];
        return pick(entry, item);
      }
    }
    if (fileName) {
      for (const entry of manifests) {
        const item = entry.manifest.items.find((it) => it.file === fileName);
        if (item) return pick(entry, item);
      }
    }
    return null;
  };

  /**
   * 写发件箱：复制文件（永不覆盖）+ 最后写清单。
   * items: [{ path, name, bridge?: { jobId } }] —— path 已由路由解析为真实文件。
   */
  const createReturn = async (projectDir, { app, items }) => {
    const targetApp = ADOBE_BRIDGE_APPS.includes(app) ? app : 'photoshop';
    const list = Array.isArray(items) ? items.filter((it) => it && it.path) : [];
    if (!list.length) throw new Error('没有可返回的文件');
    const dirs = bridgeDirsFor(projectDir);
    await mkdir(dirs.outbox, { recursive: true });
    const existing = await readdir(dirs.outbox).catch(() => []);
    const seq = nextOutboxSeq(existing);
    const files = [];
    for (const item of list) {
      const name = String(item.name || basename(item.path));
      if (!isReturnableBridgeFile(name)) throw new Error('不支持返回该类型：' + name);
      const info = await stat(item.path);
      if (!info.isFile() || info.size <= 0) throw new Error('源文件不存在或为空：' + name);
      const file = outboxFileName(seq, name, bridgeExtOf(name));
      await copyFile(item.path, join(dirs.outbox, file));
      files.push({ file, name, kind: bridgeExtOf(name) });
    }
    const first = list[0];
    const origin = await resolveOrigin(projectDir, { jobId: first.bridge && first.bridge.jobId, sourcePath: first.path });
    const manifest = buildOutboundManifest({ seq, targetApp, files, origin });
    const manifestPath = join(dirs.outbox, String(seq).padStart(4, '0') + '.json');
    await writeJsonAtomic(manifestPath, manifest);
    await log('return', { app: targetApp, seq, files: files.map((f) => f.file), origin: origin ? origin.jobId : null });
    return { outbox: dirs.outbox, seq, files, manifestPath, origin, jobId: manifest.jobId };
  };

  const recentLog = async (limit) => {
    try {
      const text = await readFile(join(root, LOG_FILE), 'utf8');
      const lines = text.trim().split('\n');
      return lines.slice(-Math.max(1, Number(limit) || 20)).map((line) => { try { return JSON.parse(line); } catch { return { raw: line }; } });
    } catch { return []; }
  };

  const status = async () => {
    let handshake = null;
    try { handshake = await readJson(join(root, HANDSHAKE_FILE)); } catch {}
    let installed = null;
    try { installed = await readJson(join(root, INSTALLED_FILE)); } catch {}
    return { root, handshakePath: join(root, HANDSHAKE_FILE), handshake, scriptsInstalled: await scriptsInstalled(), cepInstalled: await cepInstalled(), cepDir: cepTargetDir(), installed, active: { ...active }, recentLog: await recentLog(20), scriptFiles: SCRIPT_FILES };
  };

  /**
   * 找本机 PS/AI 的 Scripts 目录。返回 [{ app, level:'app', name, dirs:[…], presets? }]。
   *   macOS  PS：/Applications/Adobe Photoshop <年>/Presets/Scripts（root 权限）
   *          AI：/Applications/Adobe Illustrator <年>/Presets.localized/<每个 locale>/Scripts（root 权限；一个版本合并为一条）
   *   Windows PS：%ProgramFiles%\Adobe\Adobe Photoshop <年>\Presets\Scripts；AI：…\Adobe Illustrator <年>\Presets\<每个 locale>\Scripts
   * 实测（2026-09-18，PS 2025 macOS）：**Photoshop 不扫描 ~/Library/Application Support/Adobe/…/Presets/Scripts**
   * （同目录里用户自己放的脚本从未进过菜单），Illustrator 也没有用户级脚本目录——所以两款应用的菜单入口都需要
   * 一次管理员授权（installScriptsElevated）。日常主路径（远程驱动，§9）不依赖菜单。
   */
  const listDirs = async (directory) => {
    try { return (await readdir(directory, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort(); } catch { return []; }
  };
  /**
   * Windows：从注册表反推 Adobe 应用的安装目录。
   * 只扫 %ProgramFiles%\Adobe 会漏掉**自定义安装路径**（实测本机 PS 装在
   * `C:\ps\Adobe Photoshop 2022`），这类机器上「菜单脚本」永远装不上、
   * UAC 提权流程也走不到。ProgID → CLSID → LocalServer32 指向真实 exe，与装在哪无关：
   *   PS: <root>\Photoshop.exe /Automation
   *   AI: <root>\Support Files\Contents\Windows\Illustrator.exe /Automation
   */
  const findAdobeAppExesFromRegistry = async () => {
    if (!isWindows || typeof runProcess !== 'function') return [];
    const found = [];
    for (const [app, progId] of [['photoshop', 'Photoshop.Application'], ['illustrator', 'Illustrator.Application']]) {
      try {
        const clsidOut = await runProcess('reg', ['query', 'HKLM\\SOFTWARE\\Classes\\' + progId + '\\CLSID', '/ve'], root, 10000);
        const clsid = (String((clsidOut && clsidOut.stdout) || '').match(/\{[0-9A-Fa-f-]{36}\}/) || [])[0];
        if (!clsid) continue;
        const serverOut = await runProcess('reg', ['query', 'HKLM\\SOFTWARE\\Classes\\CLSID\\' + clsid + '\\LocalServer32', '/ve'], root, 10000);
        const value = (String((serverOut && serverOut.stdout) || '').match(/REG_SZ\s+(.+)/) || [])[1];
        if (!value) continue;
        // 去外层引号与尾部开关（/Automation…）；exe 路径自身可能含空格，不能按空格切
        const exe = value.trim().replace(/^"([^"]+)".*$/, '$1').replace(/\s+[/-]\w+\s*$/, '').replace(/^"|"$/g, '').trim();
        if (!exe) continue;
        try { await access(exe); } catch { continue; }
        found.push({ app, exe });
      } catch (err) {}
    }
    return found;
  };

  /** 从 exe 向上找含 Presets 的安装根，再推导 Scripts 目录（PS / AI 布局不同，这样都能找）。 */
  const adobeScriptDirsFromExe = async (app, exe) => {
    let dir = dirname(exe);
    for (let depth = 0; depth < 6 && dir; depth += 1) {
      for (const presetsName of ['Presets.localized', 'Presets']) {
        const presets = join(dir, presetsName);
        const locales = await listDirs(presets);
        if (!locales.length) continue;
        const dirs = app === 'photoshop'
          ? [join(presets, 'Scripts')]
          : locales.map((locale) => join(presets, locale, 'Scripts'));
        return [{ app, level: 'app', name: basename(dir) + '（注册表定位）', presets, dirs }];
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return [];
  };

  const findAdobeScriptDirs = async () => {
    const found = [];
    const appsRoot = isWindows ? join(process.env.ProgramFiles || 'C:\\Program Files', 'Adobe') : '/Applications';
    for (const entry of await listDirs(appsRoot)) {
      const appDir = join(appsRoot, entry);
      if (/^Adobe Photoshop/i.test(entry)) {
        if (!(await exists(join(appDir, 'Presets')))) continue;
        found.push({ app: 'photoshop', level: 'app', name: entry, dirs: [join(appDir, 'Presets', 'Scripts')] });
      } else if (/^Adobe Illustrator/i.test(entry)) {
        for (const presetsName of ['Presets.localized', 'Presets']) {
          const presets = join(appDir, presetsName);
          const locales = await listDirs(presets);
          if (!locales.length) continue;
          found.push({ app: 'illustrator', level: 'app', name: entry + '（' + locales.length + ' 个语言目录）', presets, dirs: locales.map((locale) => join(presets, locale, 'Scripts')) });
          break;
        }
      }
    }
    // Windows 追加：注册表反推出来的自定义安装路径（%ProgramFiles%\Adobe 之外的地方）
    if (isWindows) {
      const known = new Set(found.map((item) => item.name));
      for (const candidate of await findAdobeAppExesFromRegistry()) {
        for (const item of await adobeScriptDirsFromExe(candidate.app, candidate.exe)) {
          if (known.has(item.name)) continue;
          known.add(item.name);
          found.push(item);
        }
      }
    }
    return found;
  };

  /**
   * 安装：① 永远先复制一份用户副本到 <桥接根>/scripts/（远程驱动从这里 evalFile；也供「浏览 / 其它脚本…」与 sudo 命令使用）；
   * ② 再尝试每个 Adobe 应用目录——macOS 下通常是 root 权限，写不进时返回 errors[].hint（可粘贴的 sudo 命令），
   *    真正装进菜单请用 installScriptsElevated（系统管理员密码弹窗）。host 路由与 CLI 共用。
   */
  const installScripts = async () => {
    const sourceDir = join(pluginRoot, 'adobe-bridge');
    for (const file of SCRIPT_FILES) if (!(await exists(join(sourceDir, file)))) throw new Error('插件缺少脚本文件：' + file);
    const userCopyDir = join(root, 'scripts');
    await mkdir(userCopyDir, { recursive: true });
    for (const file of SCRIPT_FILES) await copyFile(join(sourceDir, file), join(userCopyDir, file));
    const targets = await findAdobeScriptDirs();
    const installed = [];
    const errors = [];
    const allScriptsPresent = async (dir, files) => {
      for (const file of files) { try { await access(join(dir, file)); } catch { return false; } }
      return true;
    };
    const sudoHint = (target) => {
      if (isWindows) return '点画布「更多 → 🔐 安装 PS / AI 菜单面板」并在 UAC 弹窗里确认，或以管理员身份运行 node scripts/install-adobe-bridge.mjs';
      const files = filesForApp(target.app).map((f) => '"' + userCopyDir + '/' + f + '"').join(' ');
      if (target.presets) return "终端执行：sudo sh -c 'for d in \"" + target.presets + "\"/*/; do mkdir -p \"$d/Scripts\" && cp " + files.replace(/"/g, '\\"') + " \"$d/Scripts/\"; done'";
      return '终端执行：sudo cp ' + files + ' "' + target.dirs[0] + '/"';
    };
    for (const target of targets) {
      const done = [];
      let failure = null;
      for (const dir of target.dirs) {
        try {
          await mkdir(dir, { recursive: true });
          await access(dir, fsConstants.W_OK);
          for (const file of filesForApp(target.app)) await copyFile(join(sourceDir, file), join(dir, file));
          done.push(dir);
        } catch (err) {
          // 目录不可写但该应用的脚本已全部在位（之前用管理员装过）→ 视为已安装，不算失败
          if (await allScriptsPresent(dir, filesForApp(target.app))) { done.push(dir); continue; }
          failure = err;
        }
      }
      if (done.length) installed.push({ app: target.app, level: target.level, name: target.name, dir: done[0], dirs: done });
      if (failure) {
        const denied = failure.code === 'EACCES' || failure.code === 'EPERM';
        errors.push({ app: target.app, level: target.level, name: target.name, dir: target.dirs[0], error: denied ? '没有写入权限' : String(failure.message || failure), hint: denied ? sudoHint(target) : '' });
      }
    }
    const manualHint = 'Photoshop：文件 → 脚本 → 浏览… ；Illustrator：文件 → 脚本 → 其它脚本… ，选择 ' + userCopyDir + ' 下对应的 .jsx';
    const record = { version: await version(), installedAt: new Date().toISOString(), platform: platformName, files: SCRIPT_FILES, userCopyDir, installed, errors };
    await writeJsonAtomic(join(root, INSTALLED_FILE), record);
    await log('install-scripts', { installed: installed.map((i) => i.dirs), errors: errors.map((e) => e.dir) });
    if (!targets.length) errors.push({ app: '', level: '', name: '', dir: '', error: '未找到已安装的 Photoshop / Illustrator', hint: manualHint });
    return { installed, errors, sourceDir, userCopyDir, manualHint, scriptFiles: SCRIPT_FILES };
  };

  /* ===================== CEP 常驻面板（PS/AI CC 2014+ 通用，用户级安装，免管理员） =====================
     扩展目录：macOS ~/Library/Application Support/Adobe/CEP/extensions/<id>；Windows %APPDATA%\Adobe\CEP\extensions\<id>。
     未签名扩展要打开 Adobe 的用户级开关 PlayerDebugMode=1（CSXS 6~12 各设一次；macOS `defaults write`，Windows 注册表 HKCU）。
     面板本身不含业务逻辑：按钮 evalScript 调用用户副本里的 jsx（ensureUserCopy 保证与插件同版）。 */
  const CEP_ID = 'com.dsh.canvasbridge';
  const CEP_CSXS_VERSIONS = [6, 7, 8, 9, 10, 11, 12];
  const cepExtensionsDir = () => {
    const homeDir = home || userHome();
    return isWindows ? join(process.env.APPDATA || join(homeDir, 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions') : join(homeDir, 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
  };
  const cepTargetDir = () => join(cepExtensionsDir(), CEP_ID);

  /** 设置 PlayerDebugMode=1（允许加载未签名扩展）。没有 runProcess 的环境（单测）跳过并返回 false。 */
  const enableCepDebugMode = async () => {
    if (typeof runProcess !== 'function' || typeof resolveExecutable !== 'function') return { set: false, reason: '当前环境无法执行系统命令' };
    const failures = [];
    for (const v of CEP_CSXS_VERSIONS) {
      try {
        if (isWindows) {
          const reg = await resolveExecutable('reg');
          const r = await runProcess(reg, ['add', 'HKCU\\Software\\Adobe\\CSXS.' + v, '/v', 'PlayerDebugMode', '/t', 'REG_SZ', '/d', '1', '/f'], remoteWorkDir(), 15000);
          if (r.exitCode !== 0) failures.push('CSXS.' + v);
        } else {
          const defaults = await resolveExecutable('defaults');
          const r = await runProcess(defaults, ['write', 'com.adobe.CSXS.' + v, 'PlayerDebugMode', '1'], remoteWorkDir(), 15000);
          if (r.exitCode !== 0) failures.push('CSXS.' + v);
        }
      } catch (err) { failures.push('CSXS.' + v); }
    }
    return { set: failures.length < CEP_CSXS_VERSIONS.length, failures };
  };

  /** 安装/更新 CEP 面板到用户级扩展目录（幂等：每次整目录覆盖，文件很小）。重启 PS/AI 后在「窗口 → 扩展(旧版)」里出现。 */
  const installCep = async () => {
    const sourceDir = join(pluginRoot, 'adobe-bridge', 'cep');
    if (!(await exists(join(sourceDir, 'CSXS', 'manifest.xml')))) throw new Error('插件缺少 CEP 面板源码：adobe-bridge/cep');
    await ensureUserCopy();
    const target = cepTargetDir();
    await mkdir(target, { recursive: true });
    await cp(sourceDir, target, { recursive: true, force: true });
    const debug = await enableCepDebugMode();
    const record = { id: CEP_ID, dir: target, installedAt: new Date().toISOString(), version: await version(), debugMode: debug };
    let installedRecord = {};
    try { installedRecord = await readJson(join(root, INSTALLED_FILE)); } catch {}
    await writeJsonAtomic(join(root, INSTALLED_FILE), { ...installedRecord, cep: record });
    await log('install-cep', { dir: target, debugMode: debug.set });
    return record;
  };
  const cepInstalled = async () => exists(join(cepTargetDir(), 'CSXS', 'manifest.xml'));

  /* ===================== 远程驱动（DSH → Adobe，用户不必打开面板） =====================
     原理：面板脚本支持无头模式（$.global.DSH_BRIDGE_HEADLESS=true 时只挂 DSH_BRIDGE.ps/.ai 函数），
     host 写一段驾驭脚本 → macOS 用 osascript `do javascript`（只接受文本，所以脚本里 $.evalFile 绝对路径）、
     Windows 用 PowerShell COM `DoJavaScriptFile` → 解析 "OK:<值>" / "ERR:<消息>"。
     依赖 createAdobeBridge({ runProcess, resolveExecutable })；测试环境不传则报「当前环境不支持」。 */
  const APP_BUNDLE = { photoshop: 'com.adobe.Photoshop', illustrator: 'com.adobe.Illustrator' };
  const APP_COM = { photoshop: 'Photoshop.Application', illustrator: 'Illustrator.Application' };
  const APP_SCRIPT = { photoshop: 'DSH画布桥接-Photoshop.jsx', illustrator: 'DSH画布桥接-Illustrator.jsx' };
  const APP_LABEL = { photoshop: 'Photoshop', illustrator: 'Illustrator' };
  const remoteWorkDir = () => join(tmpdir(), 'dsh-canvas-bridge');
  /* PowerShell 命令一律经 -EncodedCommand 传输（Base64 of UTF-16LE）：
     绕开 Windows 命令行的引号/反斜杠转义与代码页问题，中文路径、空格路径直达。
     check-windows-compat.mjs 禁止再出现 '-Command' 直拼。 */
  const psEncode = (script) => Buffer.from(String(script), 'utf16le').toString('base64');
  const psSingleQuoted = (value) => "'" + String(value).replace(/'/g, "''") + "'";

  /** 用户副本永远与插件内脚本同步（远程驱动从这里 evalFile，面板「浏览…」也用它） */
  const ensureUserCopy = async () => {
    const sourceDir = join(pluginRoot, 'adobe-bridge');
    const userCopyDir = join(root, 'scripts');
    await mkdir(userCopyDir, { recursive: true });
    /* 无条件覆盖：7 个小文件，别用 size/mtime 判断——曾出现“判定已同步、实际是旧版”导致排查绕大弯 */
    for (const file of SCRIPT_FILES) await copyFile(join(sourceDir, file), join(userCopyDir, file));
    return userCopyDir;
  };

  const requireRemote = () => {
    if (typeof runProcess !== 'function' || typeof resolveExecutable !== 'function') throw new Error('当前环境不支持远程驱动 Adobe');
  };

  /** 目标应用是否在运行（不在运行时不去驱动，避免 AppleScript 把它拉起来）。 */
  const appRunning = async (app) => {
    requireRemote();
    const label = APP_LABEL[app];
    if (!label) return false;
    try {
      if (isWindows) {
        const powershell = await resolveExecutable('powershell');
        const ps = '(Get-Process -Name ' + (app === 'photoshop' ? 'Photoshop' : 'Illustrator') + ' -ErrorAction SilentlyContinue | Measure-Object).Count';
        const result = await runProcess(powershell, ['-NoProfile', '-EncodedCommand', psEncode(ps)], remoteWorkDir(), 15000);
        return Number(String(result.stdout || '').trim()) > 0;
      }
      const osascript = await resolveExecutable('osascript');
      const result = await runProcess(osascript, ['-e', 'tell application "System Events" to exists (first process whose bundle identifier is "' + APP_BUNDLE[app] + '")'], remoteWorkDir(), 15000);
      return /true/i.test(String(result.stdout || ''));
    } catch { return false; }
  };

  /** 在 PS/AI 里无头执行一个桥接脚本调用（call 形如 "B.ps.sendSelection(false)"），返回脚本输出字符串。 */
  const remoteEval = async (app, call, timeoutMs) => {
    requireRemote();
    if (!APP_SCRIPT[app]) throw new Error('未知应用：' + app);
    const limit = Math.max(15000, Number(timeoutMs) || 120000);
    const scriptPath = join(await ensureUserCopy(), APP_SCRIPT[app]);
    const workDir = remoteWorkDir();
    await mkdir(workDir, { recursive: true });
    const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const jsxPath = join(workDir, 'drive-' + app + '-' + stamp + '.jsx');
    const jsx = [
      '$.global.DSH_BRIDGE_HEADLESS = true;',
      '$.evalFile(new File(' + JSON.stringify(scriptPath) + '));',
      'var __dshResult;',
      'try { __dshResult = "OK:" + String((function () { var B = DSH_BRIDGE; return (' + call + '); })()); }',
      'catch (e) { __dshResult = "ERR:" + String(e && e.message ? e.message : e); }',
      '__dshResult;'
    ].join('\n');
    await writeFile(jsxPath, '\uFEFF' + jsx, 'utf8');
    let result;
    const cleanup = [jsxPath];
    try {
      if (isWindows) {
        const powershell = await resolveExecutable('powershell');
        const ps1 = '$a = New-Object -ComObject ' + APP_COM[app] + '; Write-Output ([string]$a.DoJavaScriptFile(' + psSingleQuoted(jsxPath) + '))';
        result = await runProcess(powershell, ['-NoProfile', '-EncodedCommand', psEncode(ps1)], workDir, limit);
      } else {
        const osascript = await resolveExecutable('osascript');
        const applescriptPath = jsxPath + '.applescript';
        cleanup.push(applescriptPath);
        /* activate：跨文档复制/置入类操作要求目标应用在前台（后台远程驱动会报"要求目标文档是最前面的文档"）；
           用户从画布点「→Ps/取图层」时把 Adobe 带到前台本来也是预期行为 */
        await writeFile(applescriptPath, 'with timeout of ' + Math.ceil(limit / 1000) + ' seconds\ntell application id "' + APP_BUNDLE[app] + '"\nactivate\ndo javascript (read POSIX file ' + JSON.stringify(jsxPath) + ' as «class utf8»)\nend tell\nend timeout\n', 'utf8');
        result = await runProcess(osascript, [applescriptPath], workDir, limit + 5000);
      }
    } finally {
      for (const path of cleanup) await unlink(path).catch(() => {});
    }
    const out = String(result && result.stdout || '').trim();
    if (out.startsWith('OK:')) return out.slice(3);
    if (out.startsWith('ERR:')) throw new Error(out.slice(4));
    if (result && result.timedOut) throw new Error(APP_LABEL[app] + ' 响应超时（是否有弹窗挡住了？）');
    throw new Error(String(result && result.stderr || '').trim().split('\n').pop() || (APP_LABEL[app] + ' 没有返回结果'));
  };

  /** 画布「取 Ps 图层 / 取 Ai 对象」：让运行中的 PS/AI 把当前选区送进收件箱（随后客户端轮询上画布）。 */
  const pullSelection = async (app, projectDir, { merged, dpi } = {}) => {
    if (!(await appRunning(app))) throw new Error(APP_LABEL[app] + ' 没有在运行，请先打开它并选中要发送的内容');
    active.projectDir = String(projectDir || active.projectDir);
    await writeHandshake();
    const call = app === 'photoshop' ? 'B.ps.sendSelection(' + (merged ? 'true' : 'false') + ')' : 'B.ai.sendSelection(' + (Math.max(36, Number(dpi) || 150)) + ')';
    const count = Number(await remoteEval(app, call, 180000)) || 0;
    await log('pull', { app, count, projectDir: active.projectDir });
    return { count };
  };

  /** 画布「→Ps / →Ai」之后：直接让运行中的 PS/AI 置入（或打开）发件箱里的待处理返回件。 */
  const placePending = async (app, mode) => {
    if (!(await appRunning(app))) return { placed: 0, running: false };
    const method = mode === 'open' ? 'open' : 'place';
    const call = (app === 'photoshop' ? 'B.ps' : 'B.ai') + '.importPending(' + JSON.stringify(method) + ')';
    const placed = Number(await remoteEval(app, call, 180000)) || 0;
    await log('remote-place', { app, mode: method, placed });
    return { placed, running: true };
  };

  /** DSH 启动时静默调用（不弹任何窗口、不提权）：
      ① 用户副本与 CEP 常驻面板每次都同步（用户级目录，幂等、极快）；
      ② 菜单脚本（应用目录，root）版本一致且文件在位就跳过，否则尝试一次（通常因权限失败并记录 hint）。 */
  const ensureInstalled = async () => {
    try {
      await ensureUserCopy();
      let cep = null;
      try { cep = await installCep(); } catch (err) { await log('ensure-cep-failed', { error: String(err && err.message || err) }); }
      let record = null;
      try { record = await readJson(join(root, INSTALLED_FILE)); } catch {}
      if (record && record.version === await version() && Array.isArray(record.installed) && record.installed.length) {
        const first = record.installed[0];
        const dir = Array.isArray(first.dirs) && first.dirs.length ? first.dirs[0] : first.dir;
        if (dir && await exists(join(dir, SCRIPT_FILES[0]))) return { skipped: true, installed: record.installed, cep };
      }
      const result = await installScripts();
      return { skipped: false, installed: result.installed, errors: result.errors, cep };
    } catch (err) {
      await log('ensure-installed-failed', { error: String(err && err.message || err) });
      return { skipped: false, error: String(err && err.message || err) };
    }
  };

  /** 管理员授权安装（必须由用户点按钮触发）：
      macOS 用 osascript `with administrator privileges`（系统密码框，插件接触不到密码）；
      Windows 用 PowerShell `Start-Process -Verb RunAs` 弹 UAC（凭据同样由系统收集）。 */
  const installScriptsElevated = async () => {
    requireRemote();
    const userCopyDir = await ensureUserCopy();
    const targets = await findAdobeScriptDirs();
    const denied = [];
    for (const target of targets) {
      for (const dir of target.dirs) {
        try { await mkdir(dir, { recursive: true }); await access(dir, fsConstants.W_OK); } catch (err) { if (err && (err.code === 'EACCES' || err.code === 'EPERM')) denied.push({ dir, app: target.app }); }
      }
    }
    if (!denied.length) return { elevated: false, ...(await installScripts()) };
    if (isWindows) {
      await elevateCopyWindows(userCopyDir, denied);
      await log('install-scripts-elevated', { dirs: denied.map((d) => d.dir) });
      return { elevated: true, ...(await installScripts()) };
    }
    const shell = denied.map(({ dir, app }) => 'mkdir -p ' + shellQuote(dir) + ' && cp ' + filesForApp(app).map((f) => shellQuote(join(userCopyDir, f))).join(' ') + ' ' + shellQuote(dir + '/')).join(' && ');
    const osascript = await resolveExecutable('osascript');
    const result = await runProcess(osascript, ['-e', 'do shell script ' + JSON.stringify(shell) + ' with administrator privileges'], remoteWorkDir(), 180000);
    if (result.exitCode !== 0) {
      const message = String(result.stderr || '').trim();
      throw new Error(/-128|取消|cancel/i.test(message) ? '已取消授权' : (message || '授权安装失败'));
    }
    await log('install-scripts-elevated', { dirs: denied.map((d) => d.dir) });
    return { elevated: true, ...(await installScripts()) };
  };

  /* Windows 提权复制：把「建目录 + Copy-Item + 回写结果 JSON」写成一段 .ps1（带 BOM，PowerShell 5.1 无 BOM 的
     UTF-8 会按 ANSI 误读中文），再由 powershell -Verb RunAs 以 UAC 弹窗执行它；外层命令经 -EncodedCommand 传输。
     内层退出码：0 全部成功 / 1 有失败（详情在结果 JSON）/ 外层 2 = 用户在 UAC 里点了「否」。 */
  const elevateCopyWindows = async (userCopyDir, denied) => {
    const workDir = remoteWorkDir();
    await mkdir(workDir, { recursive: true });
    const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const innerPath = join(workDir, 'elevate-' + stamp + '.ps1');
    const resultPath = join(workDir, 'elevate-' + stamp + '.json');
    const inner = [
      '$ErrorActionPreference = "Stop"',
      '$result = @{ ok = $true; errors = @() }'
    ];
    for (const { dir, app } of denied) {
      inner.push('try {');
      inner.push('  New-Item -ItemType Directory -Force -Path ' + psSingleQuoted(dir) + ' | Out-Null');
      for (const file of filesForApp(app)) inner.push('  Copy-Item -LiteralPath ' + psSingleQuoted(join(userCopyDir, file)) + ' -Destination ' + psSingleQuoted(dir) + ' -Force');
      inner.push('} catch { $result.ok = $false; $result.errors += ' + psSingleQuoted(dir) + ' + \': \' + $_.Exception.Message }');
    }
    inner.push('$result | ConvertTo-Json -Compress | Set-Content -LiteralPath ' + psSingleQuoted(resultPath) + ' -Encoding UTF8');
    inner.push('if (-not $result.ok) { exit 1 }');
    await writeFile(innerPath, '\uFEFF' + inner.join('\r\n'), 'utf8');
    try {
      const powershell = await resolveExecutable('powershell');
      const launcher = [
        'try {',
        '  $p = Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",' + psSingleQuoted(innerPath) + ') -Verb RunAs -Wait -PassThru',
        '  exit $p.ExitCode',
        '} catch { exit 2 }'
      ].join('\r\n');
      const result = await runProcess(powershell, ['-NoProfile', '-EncodedCommand', psEncode(launcher)], workDir, 300000);
      if (result.exitCode === 2) throw new Error('已取消授权（UAC）');
      let outcome = null;
      try { outcome = JSON.parse(await readFile(resultPath, 'utf8')); } catch {}
      if (result.exitCode !== 0 || !outcome || outcome.ok !== true) {
        const detail = outcome && Array.isArray(outcome.errors) && outcome.errors.length ? '：' + outcome.errors.join('；') : '';
        throw new Error('授权安装失败' + detail);
      }
      return outcome;
    } finally {
      await unlink(innerPath).catch(() => {});
      await unlink(resultPath).catch(() => {});
    }
  };
  const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";

  return { root, bridgeDirsFor, activate, writeHandshake, listInbound, ackInbound, resolveOrigin, createReturn, status, installScripts, installScriptsElevated, installCep, cepInstalled, cepTargetDir, ensureInstalled, ensureUserCopy, findAdobeScriptDirs, appRunning, remoteEval, pullSelection, placePending, log };
}

export { bridgeRootDir, bridgeDirsFor, SCRIPT_FILES as ADOBE_BRIDGE_SCRIPT_FILES, SCRIPT_FILES_BY_APP as ADOBE_BRIDGE_SCRIPT_FILES_BY_APP };
