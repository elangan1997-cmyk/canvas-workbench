#!/usr/bin/env node
// Windows 兼容静态检查（npm run check 的一环）。
// 目标：在 macOS 开发机上拦住"到 Windows 才炸"的常见错误。这是绊线不是证明——
// 真机验收清单见仓库 WINDOWS-TEST-CHECKLIST.md。
//
//  1. install-windows.ps1：存在、UTF-8 带 BOM（PS 5.1 无 BOM 按 ANSI 读中文必乱码）、
//     剥离字符串/注释后括号配平、无 PS7 独有语法（?? / ?. / ??=）。
//  2. install-windows.cmd：存在、无 BOM（cmd 会把 BOM 当首行命令的一部分）。
//  3. src/host/**：禁止 '-Command' 直拼（必须走 -EncodedCommand，防引号/反斜杠/中文路径转义地狱）。
//  4. src/host/** 与 scripts/**：osascript / /Applications / ~/Library / LaunchAgents 等
//     平台专属调用，40 行内（或同行）必须有 isWindows / isMac / darwin / win32 守卫
//     （启发式：text.routes 的 osascript 嵌在 277 行 if (isMac) 块内，距离 39 行）。
//  5. src/**：禁止硬编码 '/tmp'（用 node:os tmpdir()）。
import { readFileSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url))); // canvas-workbench/
const repoRoot = join(root, '..');
const problems = [];
const fail = (rule, message) => problems.push(`[${rule}] ${message}`);
const self = fileURLToPath(import.meta.url);

/** 把 JS 源码按行去掉 // 与 /* 块注释、字符串字面量（保留引号本身），供规则扫描。 */
function stripJsLines(text) {
  const out = [];
  let inBlock = false;
  for (const rawLine of text.split('\n')) {
    let line = '';
    let i = 0;
    while (i < rawLine.length) {
      if (inBlock) {
        const end = rawLine.indexOf('*/', i);
        if (end === -1) { i = rawLine.length; } else { inBlock = false; i = end + 2; }
        continue;
      }
      const ch = rawLine[i];
      if (ch === '/' && rawLine[i + 1] === '/') break;
      if (ch === '/' && rawLine[i + 1] === '*') { inBlock = true; i += 2; continue; }
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        line += quote;
        i++;
        while (i < rawLine.length && rawLine[i] !== quote) {
          if (rawLine[i] === '\\') i++;
          i++;
        }
        line += quote;
        i++;
        continue;
      }
      line += ch;
      i++;
    }
    out.push(line);
  }
  return out;
}

/* ---------- 1+2. Windows 安装器 ---------- */
const ps1Path = join(repoRoot, 'install-windows.ps1');
const cmdPath = join(repoRoot, 'install-windows.cmd');
const legacyPs1Path = join(repoRoot, 'windows-installer', 'install.ps1');
const legacyCmdPath = join(repoRoot, 'windows-installer', 'install.cmd');
if (!existsSync(ps1Path)) fail('installer', '缺少 install-windows.ps1（README 引用了它）');
if (!existsSync(cmdPath)) fail('installer', '缺少 install-windows.cmd（README 引用了它）');
if (existsSync(ps1Path)) {
  const buf = readFileSync(ps1Path);
  const hasBom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  if (!hasBom) fail('installer-bom', 'install-windows.ps1 必须是 UTF-8 带 BOM（PowerShell 5.1 无 BOM 按 ANSI 读，中文乱码）');
  const text = buf.toString('utf8');
  for (const token of [' ?? ', ' ??=', '?.']) {
    if (text.includes(token)) fail('installer-ps51', `install-windows.ps1 含 PowerShell 7 独有语法 "${token.trim()}"（Win10/11 自带的是 5.1）`);
  }
  /* PowerShell 配平：剥离 '…' 与 "…" 字符串与 <#…#>/#注释 后数括号。
     Here-String 与字符字面量会造成误差——报错时先人工核对。 */
  const stripped = text
    .replace(/<#[\s\S]*?#>/g, '')
    .replace(/#[^\n]*/g, '')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"`]|`[`"])*"/g, '""');
  let brace = 0, paren = 0, bracket = 0;
  for (const ch of stripped) {
    if (ch === '{') brace++;
    if (ch === '}') brace--;
    if (ch === '(') paren++;
    if (ch === ')') paren--;
    if (ch === '[') bracket++;
    if (ch === ']') bracket--;
  }
  if (brace || paren || bracket) fail('installer-balance', `install-windows.ps1 括号不配平 {}=${brace} ()=${paren} []=${bracket}`);
}
if (existsSync(cmdPath)) {
  const buf = readFileSync(cmdPath);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) fail('installer-bom', 'install-windows.cmd 不能带 BOM');
}
if (!existsSync(legacyPs1Path) || !existsSync(legacyCmdPath)) {
  fail('installer-legacy', 'windows-installer/install.ps1 或 install.cmd 缺失');
} else {
  const cmd = readFileSync(legacyCmdPath, 'utf8');
  const ps1 = readFileSync(legacyPs1Path, 'utf8');
  // cmd 传给 PowerShell 的命名参数必须在 install.ps1 的 param(...) 中存在。
  // 2026-09 曾出现 install.cmd 传 -SourceRoot、脚本却未声明，双击必然立即失败。
  const declared = new Set((ps1.match(/param\s*\(([\s\S]*?)\)/i)?.[1] || '').match(/\$[A-Za-z][A-Za-z0-9_]*/g)?.map((x) => x.slice(1).toLowerCase()) || []);
  const passed = [...cmd.matchAll(/(?:^|\s)-([A-Za-z][A-Za-z0-9_]*)\b/g)].map((m) => m[1]).filter((name) => !['nologo', 'noprofile', 'executionpolicy', 'file'].includes(name.toLowerCase()));
  for (const name of passed) if (!declared.has(name.toLowerCase())) fail('installer-legacy-param', `windows-installer/install.cmd 传入未声明参数 -${name}`);
}

/* ---------- 3+4+5. 源码平台规则（扫描时已去掉注释与字符串） ---------- */
const files = [
  ...globSync(join(root, 'src', 'host', '**', '*.js')),
  ...globSync(join(root, 'scripts', '*.mjs')).filter((f) => f !== self),
  ...globSync(join(root, 'src', 'shared', '**', '*.js'))
];
const GUARD = /(isWindows|isMac|darwin|win32)/;
const PLATFORM_TOKENS = [
  ['osascript', /osascript/],
  ['/Applications 路径', /\/Applications\//],
  ['~/Library 路径', /~\/Library|Library\/Application Support/],
  ['LaunchAgents', /LaunchAgents/]
];
for (const file of files) {
  const rawLines = readFileSync(file, 'utf8').split('\n');
  const strippedLines = stripJsLines(rawLines.join('\n'));
  for (let i = 0; i < strippedLines.length; i++) {
    const line = strippedLines[i];
    // 逃生口：本行或上两行的注释 "// platform-guard-ok: 理由" —— 守卫确实存在但距离超出窗口时人工确认
    if (/platform-guard-ok/.test(rawLines[i] + ' ' + (rawLines[i - 1] || '') + ' ' + (rawLines[i - 2] || ''))) continue;
    if (line.includes('-Command')) {
      fail('ps-command', `${file}:${i + 1} PowerShell '-Command' 直拼——src/host 里必须走 -EncodedCommand（引号/反斜杠/中文路径转义）；独立参数形态只允许 lib/platform.js`);
    }
    if (/\/tmp\b/.test(line) && !/tmpdir\(\)/.test(line)) {
      fail('tmp-hardcode', `${file}:${i + 1} 硬编码 /tmp——用 node:os 的 tmpdir()`);
    }
    for (const [label, pattern] of PLATFORM_TOKENS) {
      if (!pattern.test(line)) continue;
      const window = strippedLines.slice(Math.max(0, i - 40), i + 1);
      if (!window.some((l) => GUARD.test(l))) fail('platform-guard', `${file}:${i + 1} 使用 ${label} 但 40 行内没有 isWindows/isMac/darwin/win32 守卫`);
    }
  }
}

if (problems.length) {
  console.error('windows-compat 检查未通过：');
  for (const problem of problems) console.error('  ' + problem);
  process.exit(1);
}
console.log('windows-compat ok: 安装器（BOM/PS5.1/配平）+ 无 -Command 直拼 + 平台调用守卫 + 无硬编码 /tmp');
