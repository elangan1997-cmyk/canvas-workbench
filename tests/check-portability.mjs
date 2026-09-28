import { access, readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

// v1.8 起 Host 源码分布在 canvas-workbench/src/{host,shared}/**，lib/index.js 只是入口薄壳；
// 针对 Host 的内容断言按整棵源码树检查。
async function readTree(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await readTree(p));
    else if (entry.name.endsWith('.js')) out.push(await readFile(p, 'utf8'));
  }
  return out;
}

const root = resolve(import.meta.dirname, '..');
const required = [
  'canvas-workbench/package.json',
  'canvas-workbench/lib/index.js',
  'canvas-workbench/lib/client.js',
  'canvas-workbench/lib/image-engine.js',
  'canvas-workbench/lib/platform.js',
  'canvas-workbench/lib/chat-image-router.js',
  'dsh-codex/package.json',
  'dsh-codex/lib/index.js',
  'dsh-codex/lib/client.js',
  'mac-installer/build-macos-installer.sh',
  'mac-installer/prepare-macos-bundle.sh',
  'mac-installer/scripts/postinstall',
  'mac-installer/health-check.sh',
  'windows-installer/install.ps1',
  'windows-installer/health-check.ps1',
  'windows-installer/uninstall.ps1',
  'scripts/build-npm-package.mjs',
  'docs/NPM-DISTRIBUTION.md'
];

for (const relative of required) {
  const info = await stat(resolve(root, relative));
  if (!info.isFile() || info.size <= 0) throw new Error(`missing: ${relative}`);
}

const host = [
  await readFile(resolve(root, 'canvas-workbench/lib/index.js'), 'utf8'),
  ...await readTree(resolve(root, 'canvas-workbench/src/host')),
  ...await readTree(resolve(root, 'canvas-workbench/src/shared'))
].join('\n');
if (host.includes("if (!path.startsWith('/')) throw")) throw new Error('POSIX-only absolute path gate remains');
if (host.includes("resolveExecutable('python3')")) throw new Error('unabstracted python3 lookup remains');
if (!host.includes('platformCapabilities()')) throw new Error('health endpoint lacks platform capabilities');

const client = await readFile(resolve(root, 'canvas-workbench/lib/client.js'), 'utf8');
const chatImageRouter = await readFile(resolve(root, 'canvas-workbench/lib/chat-image-router.js'), 'utf8');
if (!client.includes('[A-Za-z]:[\\\\/]')) throw new Error('client lacks Windows drive path support');
if (!client.includes('pendingRenames.current.get')) throw new Error('client lacks rename-race protection');
if (!client.includes('displayImageName')) throw new Error('client lacks extension-free canvas labels');
if (!client.includes('pathWithin2')) throw new Error('client lacks cross-platform project path matching');
if (!host.includes('isPathWithin(projectDir, linkedSource)')) throw new Error('host lacks cross-platform rename path matching');
if (!host.includes('if (!sourceInsideProject)')) throw new Error('host lacks single-rename collision guard');
if (!host.includes('renamedSource = targetPath')) throw new Error('host does not return fallback assets source path');
if (!host.includes('sourcePath: resultPath')) throw new Error('host rename response lacks canonical source path');
if (!client.includes('result.data.sourcePath || result.data.path')) throw new Error('client rename result lacks canonical source path');
if (!client.includes('latestSnapshot.current = {')) throw new Error('client rename does not patch latest snapshot before save');
if (!client.includes('reconcileFinalImages')) throw new Error('client lacks stable final-image reconciliation');
if (!chatImageRouter.includes('<canvas_image_output producer="imagegen">final</canvas_image_output>')) throw new Error('imagegen result lacks final-output provenance marker');
if (!client.includes("item.producer === 'imagegen'")) throw new Error('chat image output is not restricted to imagegen final outputs');
if (!client.includes('canvasAutoAddEnabled() && activeCanvasProjectPath')) throw new Error('auto-added chat images still duplicate in turn tail');
if (!client.includes('/[*\\[\\]{}]/.test(candidate.split(/[?#]/, 1)[0])')) throw new Error('client does not reject image glob placeholders');
for (const marker of ['materialSelection', 'filteredMaterials', 'attachSelectedMaterialsToChat', 'deleteSelectedMaterials', '搜索文件名', '已选 ']) {
  if (!client.includes(marker)) throw new Error(`material library interaction missing: ${marker}`);
}
for (const marker of ['materialSelectMode', 'materialPreview', 'application/x-dsh-material', 'application/x-dsh-canvas-image', 'material-drag-start', 'source:\'context-menu\'', '加入素材库']) {
  if (!client.includes(marker)) throw new Error(`material drawer workflow missing: ${marker}`);
}
if (!client.includes("prev.includes(item.name) ? prev.filter((name) => name !== item.name) : prev.concat(item.name)")) throw new Error('material multi-select does not independently toggle each item');
if (client.includes('const additive = !!(event && (event.metaKey || event.ctrlKey || event.shiftKey))')) throw new Error('material multi-select still requires keyboard modifiers');
if (!client.includes('dsh-material-drag-action') || !client.includes('attempt < 12') || !client.includes("}, 1200);")) throw new Error('canvas-to-material drag handoff lacks a visible handle or iframe race protection');
for (const marker of ['MATERIAL_LIBRARY_KEY', 'materialLibrary.recent', 'chooseMaterialDirectory', '/dsh-canvas/materials/select', '最近访问']) {
  if (!client.includes(marker)) throw new Error(`independent material directory workflow missing: ${marker}`);
}
if (!client.includes('materialControlsOpen') || !client.includes('dsh-materials-location-toggle') || !client.includes("materialControlsOpen || materialDropActive")) throw new Error('material directory controls are not collapsible or drag-aware');
if (!host.includes("'/dsh-canvas/materials/open'")) throw new Error('material library lacks native folder open endpoint');
if (!host.includes("'/dsh-canvas/materials/select'")) throw new Error('material library lacks native folder picker endpoint');
if (!host.includes('materialDirectory(params.dir, params.cwd)') || !host.includes('materialDirectory(body.dir, body.cwd)')) throw new Error('material routes remain coupled to the current project cwd');

const macBuild = await readFile(resolve(root, 'mac-installer/build-macos-installer.sh'), 'utf8');
if (macBuild.includes('dsh-codex-dsh2')) throw new Error('Mac installer still references a private checkout path');
if (!macBuild.includes('$WORKSPACE_DIR/dsh-codex/lib')) throw new Error('Mac installer does not bundle dsh-codex');
const sync = await readFile(resolve(root, 'sync-local-plugins.sh'), 'utf8');
if (!sync.includes('sync_codex_compat')) throw new Error('sync script lacks dsh-codex compatibility sync');
if (!sync.includes('remove_legacy_home_explorer')) throw new Error('sync script lacks legacy file-browser cleanup');
if (!sync.includes('$PROFILES_ROOT/web/node_modules/@local/$package')) throw new Error('sync script lacks web profile package sync');
if (!sync.includes('$PROFILES_ROOT/$active/node_modules/@local/$package')) throw new Error('sync script lacks active profile package sync');
for (const marker of ['diff -qr "$source/src" "$destination/src"', 'diff -qr "$source/adobe-bridge" "$destination/adobe-bridge"', 'diff -qr "$source/vendor" "$destination/vendor"']) {
  if (!sync.includes(marker)) throw new Error(`sync freshness check misses runtime tree: ${marker}`);
}
if (!host.includes("'/dsh-canvas/image-status'")) throw new Error('host lacks image status endpoint');
const clientImages = await readFile(resolve(root, 'canvas-workbench/lib/client.js'), 'utf8');
if (!clientImages.includes("'/dsh-canvas/image-status?path='")) throw new Error('client lacks stale image filtering');
if (clientImages.includes('cdn.jsdelivr.net/npm/react@') && !clientImages.includes('EXCALIDRAW_SRCDOC_LOCAL')) throw new Error('canvas still depends directly on a public CDN');
for (const asset of ['react-18.3.1.production.min.js', 'react-dom-18.3.1.production.min.js', 'excalidraw-0.17.6.production.min.js']) {
  await access(resolve(root, 'canvas-workbench/vendor', asset));
}
const srcdocPrefix = 'const EXCALIDRAW_SRCDOC = ';
const srcdocStart = clientImages.indexOf(srcdocPrefix);
// build-client 分段拼接可能保留一个或多个换行；不要把便携性检查
// 绑定到生成文件的空行数。
const srcdocTail = clientImages.slice(srcdocStart).match(/`;\n\s*\/\/ Excalidraw\/React/);
const srcdocEnd = srcdocTail ? srcdocStart + srcdocTail.index : -1;
if (srcdocStart < 0 || srcdocEnd < 0) throw new Error('unable to locate Excalidraw srcdoc');
const srcdocLiteral = clientImages.slice(srcdocStart + srcdocPrefix.length, srcdocEnd + 1);
const srcdoc = Function('"use strict"; return ' + srcdocLiteral)();
for (const match of srcdoc.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
  if (match[1].trim()) Function(match[1]);
}

const codex = await readFile(resolve(root, 'dsh-codex/lib/src-C3kK80Ix.js'), 'utf8');
for (const marker of ['maxRequestImageBytes: 20971520', 'requestImagePixelBudget: 4194304', 'requestImageMaxBytes: 1048576']) {
  if (!codex.includes(marker)) throw new Error(`dsh-codex image compatibility budget missing: ${marker}`);
}

const installer = await readFile(resolve(root, 'windows-installer/install.ps1'), 'utf8');
for (const marker of ['profiles', 'node_modules\\@local', 'desktop\\node_modules\\@local', 'cordis.patch.yml']) {
  if (!installer.includes(marker)) throw new Error(`installer missing marker: ${marker}`);
}

const npmBuilder = await readFile(resolve(root, 'scripts/build-npm-package.mjs'), 'utf8');
for (const marker of ["const packageName = 'canvas-workbench'", "bundle: { patch: './cordis.patch.yml' }", "'lib', 'src', 'scripts', 'vendor', 'adobe-bridge', 'cordis.patch.yml', 'README.md', 'LICENSE'", "const npmClientId = \"id: 'canvas-workbench'\""]) {
  if (!npmBuilder.includes(marker)) throw new Error(`npm package builder missing marker: ${marker}`);
}
if (!npmBuilder.includes("(?:auth\\.json|\\.env)")) throw new Error('npm package builder lacks credential exclusion');
if (!sync.includes("llm-openai-codex 'dsh-codex'")) throw new Error('sync script does not inject dsh-codex into the active profile');
const macUninstall = await readFile(resolve(root, 'mac-installer/uninstall.sh'), 'utf8');
if (!macUninstall.includes("*/node_modules/dsh-codex")) throw new Error('Mac uninstaller does not remove profile-scoped dsh-codex copies');

console.log('portability checks passed');
