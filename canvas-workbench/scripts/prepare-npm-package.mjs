// 生成 npm 发布变体：dist-npm/canvas-workbench/。
//
// 开发态包名是 @local/canvas-workbench（同步脚本按 @local 路径管理运行副本），
// 发布态改为 canvas-workbench，并补齐市场/npm 安装所需的自注册结构：
//   1. cordis.patch.yml —— 装载器 insert 项（dsh-codex / dsh-connect-workbuddy 同款约定）；
//   2. package.json.dsh.bundle.patch —— 指向上面的补丁文件；
//   3. lib/client.js 的模块 id 由 '@local/canvas-workbench' 改为 'canvas-workbench'
//      （客户端注册表要求 id 与安装名一致，见 src/client/main/00-loader-prelude.js 的注释）。
//
//   node scripts/prepare-npm-package.mjs           # 生成 + 校验 + npm pack --dry-run 预览
//   cd dist-npm/canvas-workbench && npm publish    # 真正发布（需要 npm 账号）
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const suiteRoot = dirname(pluginRoot);
const outRoot = join(pluginRoot, 'dist-npm');
const outDir = join(outRoot, 'canvas-workbench');

const NPM_NAME = 'canvas-workbench';
const DEV_ID = "id: '@local/canvas-workbench'";
const NPM_ID = "id: 'canvas-workbench'";

const devPkg = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'));

await rm(outRoot, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// ---- 运行时文件（lib/index.js 是薄壳，宿主真代码在 src/host/，必须随包） ----
for (const dir of ['lib', 'src', 'vendor', 'scripts', 'adobe-bridge']) {
  await cp(join(pluginRoot, dir), join(outDir, dir), {
    recursive: true,
    filter: (src) => !src.includes(`${dir}/__pycache__`) && !src.includes('/__pycache__/'),
  });
}
await cp(join(pluginRoot, 'README.md'), join(outDir, 'README.md'));
await cp(join(suiteRoot, 'LICENSE'), join(outDir, 'LICENSE'));

// ---- 客户端模块 id：@local → npm 包名 ----
const clientPath = join(outDir, 'lib', 'client.js');
let clientJs = await readFile(clientPath, 'utf8');
const hits = clientJs.split(DEV_ID).length - 1;
if (hits !== 1) {
  console.error(`client id 替换点异常：期望 1 处，实际 ${hits} 处，中止（分段源码结构是否变化？）`);
  process.exit(1);
}
clientJs = clientJs.replace(DEV_ID, NPM_ID);
await writeFile(clientPath, clientJs);

// ---- 自注册补丁（市场安装后无需外部 profile 补丁） ----
await writeFile(join(outDir, 'cordis.patch.yml'), `# npm / 市场安装的自注册入口。本地开发（@local 副本 + 同步脚本注入
# profile 补丁）不经过本文件，两条安装路径互不影响。
- insert:
    - id: canvas-workbench
      name: ${NPM_NAME}
`);

// ---- 发布版 package.json ----
const publishPkg = {
  name: NPM_NAME,
  version: devPkg.version,
  description: devPkg.description,
  type: 'module',
  license: 'MIT',
  main: 'lib/index.js',
  exports: {
    '.': { default: './lib/index.js' },
    './client': './lib/client.js',
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json',
  },
  files: ['lib', 'src', 'vendor', 'scripts', 'adobe-bridge', 'cordis.patch.yml', 'README.md', 'LICENSE'],
  os: devPkg.os,
  keywords: ['dsh', 'dsh-plugin', 'dsh-bundle', 'canvas', 'excalidraw', 'design'],
  repository: {
    type: 'git',
    url: 'git+https://github.com/elangan1997-cmyk/dsh-canvas-suite.git',
    directory: 'canvas-workbench',
  },
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: devPkg.dsh?.client ?? { platform: 'web', inject: [] },
  },
  peerDependencies: {
    // 运行时由 DSH 宿主提供（内核 bundle），声明仅用于版本约束说明；
    // profile 安装时 pnpm 对未满足 peer 只告警，与 dsh-codex 生态行为一致。
    // 范围含显式预发布分支：node-semver 规定带预发布标签的版本只有在该元组
    // 也有带预发布标签的比较符时才被范围放行（见 awesome-dsh-plugin
    // contributing.md 的说明），单写 ^0.1.0-rc.7 会静默排除 0.1.7-rc.2。
    '@deepseek-ai/dsh-tools': '0.1.0-rc.7 || >=0.1.0 <0.2.0 || >=0.1.7-rc.1 <0.2.0',
    '@deepseek-ai/dsh-llm': '0.1.0-rc.7 || >=0.1.0 <0.2.0 || >=0.1.7-rc.1 <0.2.0',
  },
  dependencies: {
    'ag-psd': '^31.0.2',
  },
};
await writeFile(join(outDir, 'package.json'), JSON.stringify(publishPkg, null, 2) + '\n');

// ---- 校验：装载入口语法 + 补丁 YAML 结构 + pack 预览 ----
execFileSync('node', ['--check', join(outDir, 'lib', 'client.js')], { stdio: 'inherit' });
execFileSync('node', ['--check', join(outDir, 'lib', 'index.js')], { stdio: 'inherit' });
const patchYaml = await readFile(join(outDir, 'cordis.patch.yml'), 'utf8');
if (!patchYaml.includes(`name: ${NPM_NAME}`)) throw new Error('cordis.patch.yml 生成异常');

console.log(`已生成 ${outDir}`);
console.log(`client id：@local/canvas-workbench → ${NPM_NAME}（sha256 ${createHash('sha256').update(clientJs).digest('hex').slice(0, 16)}…）`);
console.log('\nnpm pack 预览：');
execFileSync('npm', ['pack', '--dry-run'], { cwd: outDir, stdio: 'inherit' });
console.log(`\n下一步（需要 npm 账号）：`);
console.log(`  cd ${outDir}`);
console.log(`  npm publish            # 公开发布后 registry.npmmirror.com 会在数分钟到一小时内自动同步`);
