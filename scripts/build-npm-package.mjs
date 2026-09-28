import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, '..');
const sourceDir = resolve(root, 'canvas-workbench');
const sourcePackage = JSON.parse(await readFile(resolve(sourceDir, 'package.json'), 'utf8'));
const packageName = 'canvas-workbench';
const devClientId = "id: '@local/canvas-workbench'";
const npmClientId = "id: 'canvas-workbench'";
const stageDir = resolve(root, 'dist', 'npm', `${packageName}-${sourcePackage.version}`);

const publishPackage = {
  name: packageName,
  version: sourcePackage.version,
  description: sourcePackage.description,
  keywords: ['dsh', 'deepseek-harness', 'canvas', 'excalidraw', 'image-editing'],
  license: 'MIT',
  type: sourcePackage.type,
  os: sourcePackage.os,
  engines: { node: '>=22.19.0' },
  repository: {
    type: 'git',
    url: 'git+https://github.com/elangan1997-cmyk/dsh-canvas-suite.git',
    directory: 'canvas-workbench'
  },
  homepage: 'https://github.com/elangan1997-cmyk/dsh-canvas-suite#readme',
  bugs: { url: 'https://github.com/elangan1997-cmyk/dsh-canvas-suite/issues' },
  publishConfig: {
    access: 'public',
    registry: 'https://registry.npmjs.org/'
  },
  main: sourcePackage.main,
  exports: {
    ...sourcePackage.exports,
    './cordis.patch.yml': './cordis.patch.yml'
  },
  files: ['lib', 'src', 'scripts', 'vendor', 'adobe-bridge', 'cordis.patch.yml', 'README.md', 'LICENSE'],
  dshCanvasCompatibility: sourcePackage.dshCanvasCompatibility,
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: sourcePackage.dsh.client
  },
  peerDependencies: {
    '@deepseek-ai/dsh-llm': '>=0.1.0-rc.7',
    '@deepseek-ai/dsh-tools': '>=0.1.0-rc.7',
    react: '>=18.2.0'
  },
  peerDependenciesMeta: {
    '@deepseek-ai/dsh-llm': { optional: true },
    '@deepseek-ai/dsh-tools': { optional: true },
    react: { optional: true }
  },
  dependencies: sourcePackage.dependencies || {}
};

await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

for (const name of ['lib', 'src', 'scripts', 'vendor', 'adobe-bridge']) {
  await cp(resolve(sourceDir, name), resolve(stageDir, name), {
    recursive: true,
    filter: (path) => !/(^|[/\\])(?:__pycache__|\.DS_Store)(?:$|[/\\])/.test(path)
      && !/\.(?:pyc|pyo|log|map)$/.test(path)
      && !/(^|[/\\])(?:auth\.json|\.env)$/.test(path)
  });
}

// npm 客户端注册 id 必须与实际安装包名一致，否则 Host 即使加载成功，
// 前端也不会注册设计模式入口。开发态仍保持 @local/canvas-workbench。
const stagedClientPath = resolve(stageDir, 'lib', 'client.js');
let stagedClient = await readFile(stagedClientPath, 'utf8');
const clientIdHits = stagedClient.split(devClientId).length - 1;
if (clientIdHits !== 1) {
  throw new Error(`client id 替换点异常：期望 1 处，实际 ${clientIdHits} 处`);
}
stagedClient = stagedClient.replace(devClientId, npmClientId);
await writeFile(stagedClientPath, stagedClient, 'utf8');

await cp(resolve(sourceDir, 'README.md'), resolve(stageDir, 'README.md'));
await cp(resolve(root, 'LICENSE'), resolve(stageDir, 'LICENSE'));
await writeFile(
  resolve(stageDir, 'cordis.patch.yml'),
  `- insert:\n    - id: canvas-workbench\n      name: ${packageName}\n`,
  'utf8'
);
await writeFile(resolve(stageDir, 'package.json'), `${JSON.stringify(publishPackage, null, 2)}\n`, 'utf8');

console.log(stageDir);
