// Adobe 桥接：纯函数 + 临时目录里的完整收发件流程（不需要 DSH、不需要 Adobe）。
// 协议：adobe-bridge/PROTOCOL.md。跑法：npm test（或 node --test tests/unit/adobe-bridge.test.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildOutboundManifest, isAdobeBridgePath, isPendingBridgeManifest, isReturnableBridgeFile, nextOutboxSeq, outboxFileName, sanitizeBridgeName, validateInboundManifest
} from '../../src/shared/utils/adobe-bridge.js';
import { bridgeDirsFor, createAdobeBridge, extendScriptPath } from '../../src/host/services/adobe-bridge.js';

test('macOS ExtendScript 用户目录路径改用波浪号，Windows 保留绝对路径', () => {
  assert.equal(extendScriptPath('/Users/test/.dsh/bridge.jsx', '/Users/test', false), '~/.dsh/bridge.jsx');
  assert.equal(extendScriptPath('/Users/test2/bridge.jsx', '/Users/test', false), '/Users/test2/bridge.jsx');
  assert.equal(extendScriptPath('C:\\Users\\test\\bridge.jsx', 'C:\\Users\\test', true), 'C:\\Users\\test\\bridge.jsx');
});

test('ExtendScript 核心保留波浪号解析桥接根目录，避免 Photoshop 映射到 /Volumes/Users', async () => {
  const core = await readFile(new URL('../../adobe-bridge/dsh-bridge-core.jsx', import.meta.url), 'utf8');
  assert.ok(core.includes("new Folder('~/.dsh/canvas-workbench/adobe-bridge')"));
  assert.ok(core.includes("/^~[\\/]/.test(full) ? full"));
  assert.ok(!core.includes("B.child(Folder('~'), '.dsh/canvas-workbench/adobe-bridge')"));
});

test('纯函数：路径判定 / 清单名 / 安全名 / 序号', () => {
  assert.equal(isAdobeBridgePath('/p/项目/ADOBE桥接/来自Photoshop/a.png'), true);
  assert.equal(isAdobeBridgePath('C:\\p\\ADOBE桥接\\发件箱\\a.psd'), true);
  assert.equal(isAdobeBridgePath('/p/项目/assets/a.png'), false);
  assert.equal(isPendingBridgeManifest('ps-1.json'), true);
  assert.equal(isPendingBridgeManifest('ps-1.done.json'), false);
  assert.equal(isPendingBridgeManifest('ps-1.failed.json'), false);
  assert.equal(isPendingBridgeManifest('a.png'), false);
  assert.equal(sanitizeBridgeName('标题/v2:*?"<>|.psd'), '标题-v2-------.psd');
  assert.equal(sanitizeBridgeName('   ', '兜底'), '兜底');
  assert.equal(sanitizeBridgeName('x'.repeat(100)).length, 60);
  assert.equal(nextOutboxSeq([]), 1);
  assert.equal(nextOutboxSeq(['0003-a.png', '0007.json', '0007-b.psd', 'x.png', '0002.done.json']), 8);
  assert.equal(outboxFileName(7, '标题 画布.psd'), '0007-标题 画布.psd');
  assert.equal(isReturnableBridgeFile('a.PSD'), true);
  assert.equal(isReturnableBridgeFile('a.txt'), false);
});

test('纯函数：收件清单校验与发件清单构造', () => {
  assert.equal(validateInboundManifest(null).ok, false);
  assert.match(validateInboundManifest({ protocol: 2, app: 'photoshop', jobId: 'x', items: [{ file: 'a.png' }] }).error, /协议版本/);
  assert.match(validateInboundManifest({ protocol: 1, app: 'sketch', jobId: 'x', items: [{ file: 'a.png' }] }).error, /未知 app/);
  assert.match(validateInboundManifest({ protocol: 1, app: 'photoshop', jobId: 'x', items: [] }).error, /items 为空/);
  assert.match(validateInboundManifest({ protocol: 1, app: 'photoshop', jobId: 'x', items: [{ file: '../a.png' }] }).error, /不能含路径/);
  assert.equal(validateInboundManifest({ protocol: 1, app: 'illustrator', jobId: 'ai-1', items: [{ file: 'a.png' }] }).ok, true);
  const out = buildOutboundManifest({ seq: 7, targetApp: 'illustrator', files: [{ file: '0007-a.psd', name: 'a.psd' }], origin: null, createdAt: Date.UTC(2026, 8, 17, 4, 5, 6) });
  assert.equal(out.protocol, 1);
  assert.equal(out.seq, 7);
  assert.equal(out.targetApp, 'illustrator');
  assert.equal(out.files[0].kind, 'psd');
  assert.equal(out.origin, null);
  assert.match(out.jobId, /^out-\d{8}-\d{6}-0007$/);
  assert.equal(buildOutboundManifest({ seq: 1, targetApp: 'nope', files: [] }).targetApp, 'photoshop');
});

async function makeWorld() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-home-'));
  const projectDir = join(home, '项目A');
  await mkdir(projectDir, { recursive: true });
  const bridge = createAdobeBridge({ pluginRoot: join(home, 'plugin'), previewUrl: (p, m) => 'preview:' + p + ':' + Math.round(m), home, pluginVersion: '9.9.9' });
  return { home, projectDir, bridge, dispose: () => rm(home, { recursive: true, force: true }) };
}

test('服务：activate 写握手文件并建好项目桥接目录', async () => {
  const w = await makeWorld();
  try {
    const payload = await w.bridge.activate({ projectDir: w.projectDir, projectName: '项目A', sessionId: 's1' });
    assert.ok(payload, '首次 activate 必写握手');
    const handshake = JSON.parse(await readFile(join(w.bridge.root, 'bridge.json'), 'utf8'));
    assert.equal(handshake.protocol, 1);
    assert.equal(handshake.pluginVersion, '9.9.9');
    assert.equal(handshake.project.dir, w.projectDir);
    const dirs = bridgeDirsFor(w.projectDir);
    assert.equal(handshake.inbox.photoshop, dirs.inbox.photoshop);
    assert.equal(handshake.outbox, dirs.outbox);
    assert.equal(handshake.scriptsInstalled, false);
    for (const dir of [dirs.inbox.photoshop, dirs.inbox.illustrator, dirs.outbox]) assert.ok((await readdir(dir)) instanceof Array, '目录已创建：' + dir);
    assert.equal(await w.bridge.activate({ projectDir: w.projectDir, projectName: '项目A', sessionId: 's1' }), null, '20s 内同项目不重写');
  } finally { await w.dispose(); }
});

test('服务：收件清单 → 列出 → ack；坏清单改名 .failed；未稳定文件不返回', async () => {
  const w = await makeWorld();
  try {
    const dirs = bridgeDirsFor(w.projectDir);
    await mkdir(dirs.inbox.photoshop, { recursive: true });
    const file = join(dirs.inbox.photoshop, 'ps-1-01-标题.png');
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const manifest = { protocol: 1, jobId: 'ps-1', app: 'photoshop', createdAt: 1, document: { name: '海报.psd', width: 100, height: 50 }, merged: false,
      items: [{ file: 'ps-1-01-标题.png', kind: 'png', layer: { name: '标题', id: 3, type: 'text' }, bounds: { left: 1, top: 2, right: 30, bottom: 12 }, artboard: null }] };
    await writeFile(join(dirs.inbox.photoshop, 'ps-1.json'), JSON.stringify(manifest));
    await writeFile(join(dirs.inbox.photoshop, 'bad.json'), '{"protocol":1,"app":"photoshop","jobId":"bad","items":[]}');
    assert.deepEqual(await w.bridge.listInbound(w.projectDir), [], '文件刚写入（<1s）不算稳定');
    const names = (await readdir(dirs.inbox.photoshop)).sort();
    assert.ok(names.includes('bad.failed.json') && !names.includes('bad.json'), '坏清单被改名 .failed.json');
    const old = new Date(Date.now() - 5000);
    await utimes(file, old, old);
    const jobs = await w.bridge.listInbound(w.projectDir);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].jobId, 'ps-1');
    assert.equal(jobs[0].manifestName, 'ps-1.json');
    assert.equal(jobs[0].items[0].path, file);
    assert.equal(jobs[0].items[0].layer.name, '标题');
    assert.match(jobs[0].items[0].url, /^preview:/);
    const acked = await w.bridge.ackInbound(w.projectDir, 'ps-1.json');
    assert.equal(acked.manifest, 'ps-1.done.json');
    assert.deepEqual(await w.bridge.listInbound(w.projectDir), [], 'ack 后不再列出');
    await assert.rejects(w.bridge.ackInbound(w.projectDir, 'ps-1.json'), /不存在或已处理/);
    await assert.rejects(w.bridge.ackInbound(w.projectDir, '../x.json'), /无效|不存在/);
    // 出处解析：按 jobId / 按文件名 / 都没有
    const byJob = await w.bridge.resolveOrigin(w.projectDir, { jobId: 'ps-1', sourcePath: file });
    assert.equal(byJob.layer.name, '标题');
    assert.equal(byJob.document.name, '海报.psd');
    const byName = await w.bridge.resolveOrigin(w.projectDir, { sourcePath: '/elsewhere/ps-1-01-标题.png' });
    assert.equal(byName.jobId, 'ps-1');
    assert.equal(await w.bridge.resolveOrigin(w.projectDir, { sourcePath: '/x/other.png' }), null);
  } finally { await w.dispose(); }
});

test('服务：返回 → 发件箱序号递增、永不覆盖、清单最后写、出处随行', async () => {
  const w = await makeWorld();
  try {
    const dirs = bridgeDirsFor(w.projectDir);
    await mkdir(dirs.inbox.illustrator, { recursive: true });
    await writeFile(join(dirs.inbox.illustrator, 'ai-9.done.json'), JSON.stringify({ protocol: 1, jobId: 'ai-9', app: 'illustrator', items: [{ file: 'ai-9-01-图.png', layer: { name: '图', type: 'pathitem' }, bounds: { left: 0, top: 0, right: 10, bottom: 10 }, artboard: { index: 0, left: 0, top: 0, right: 100, bottom: 100 } }] }));
    const edited = join(w.projectDir, 'assets', '图-画布.psd');
    await mkdir(join(w.projectDir, 'assets'), { recursive: true });
    await writeFile(edited, 'psd-bytes');
    const first = await w.bridge.createReturn(w.projectDir, { app: 'illustrator', items: [{ path: edited, name: '图-画布.psd', bridge: { jobId: 'ai-9' } }] });
    assert.equal(first.seq, 1);
    assert.equal(first.files[0].file, '0001-图-画布.psd');
    assert.equal(first.origin.jobId, 'ai-9');
    assert.equal(first.origin.artboard.right, 100);
    const manifest = JSON.parse(await readFile(first.manifestPath, 'utf8'));
    assert.equal(manifest.targetApp, 'illustrator');
    assert.equal(manifest.files[0].kind, 'psd');
    assert.equal(manifest.origin.layer.name, '图');
    assert.equal(await readFile(join(dirs.outbox, '0001-图-画布.psd'), 'utf8'), 'psd-bytes');
    const second = await w.bridge.createReturn(w.projectDir, { app: 'photoshop', items: [{ path: edited, name: '图-画布.psd' }] });
    assert.equal(second.seq, 2, '第二次序号 +1，不覆盖第一次');
    assert.equal((await readdir(dirs.outbox)).filter((n) => n.startsWith('0001')).length, 2, '0001 的文件与清单都还在');
    await assert.rejects(w.bridge.createReturn(w.projectDir, { app: 'photoshop', items: [] }), /没有可返回/);
    await writeFile(join(w.projectDir, 'assets', 'x.txt'), 'nope');
    await assert.rejects(w.bridge.createReturn(w.projectDir, { app: 'photoshop', items: [{ path: join(w.projectDir, 'assets', 'x.txt'), name: 'x.txt' }] }), /不支持返回/);
    const status = await w.bridge.status();
    assert.ok(status.recentLog.some((line) => line.event === 'return'), '日志记录了 return');
  } finally { await w.dispose(); }
});

test('服务：远程驱动在无 runProcess 的环境下明确拒绝；用户副本按插件源同步', async () => {
  const w = await makeWorld();
  try {
    await assert.rejects(w.bridge.pullSelection('photoshop', w.projectDir), /不支持远程驱动/);
    await assert.rejects(w.bridge.placePending('photoshop', 'place'), /不支持远程驱动/);
    await assert.rejects(w.bridge.remoteEval('photoshop', 'B.ps.sendSelection(false)'), /不支持远程驱动/);
    // ensureUserCopy：把插件 adobe-bridge/*.jsx 复制到 <桥接根>/scripts（这里 pluginRoot 指向临时目录，先造三个假脚本）
    const { mkdir: mk, writeFile: wf, readFile: rf } = await import('node:fs/promises');
    await mk(join(w.home, 'plugin', 'adobe-bridge'), { recursive: true });
    const { ADOBE_BRIDGE_SCRIPT_FILES } = await import('../../src/host/services/adobe-bridge.js');
    for (const name of ADOBE_BRIDGE_SCRIPT_FILES) await wf(join(w.home, 'plugin', 'adobe-bridge', name), '\uFEFF// ' + name);
    const dir = await w.bridge.ensureUserCopy();
    assert.equal(dir, join(w.bridge.root, 'scripts'));
    assert.equal(await rf(join(dir, 'dsh-bridge-core.jsx'), 'utf8'), '\uFEFF// dsh-bridge-core.jsx');
    assert.equal(await rf(join(dir, 'dsh-bridge-photoshop.jsx'), 'utf8'), '\uFEFF// DSH画布桥接-Photoshop.jsx');
    assert.equal(await rf(join(dir, 'dsh-bridge-illustrator.jsx'), 'utf8'), '\uFEFF// DSH画布桥接-Illustrator.jsx');
    await wf(join(w.home, 'plugin', 'adobe-bridge', 'dsh-bridge-core.jsx'), '\uFEFF// v2 longer content');
    await w.bridge.ensureUserCopy();
    assert.equal(await rf(join(dir, 'dsh-bridge-core.jsx'), 'utf8'), '\uFEFF// v2 longer content', '源变了要跟着更新');
  } finally { await w.dispose(); }
});

test('服务：CEP 常驻面板装进用户级扩展目录；无 runProcess 时不设 PlayerDebugMode 但目录照常复制', async () => {
  const w = await makeWorld();
  try {
    const { mkdir: mk, writeFile: wf, readFile: rf } = await import('node:fs/promises');
    const src = join(w.home, 'plugin', 'adobe-bridge');
    await mk(join(src, 'cep', 'CSXS'), { recursive: true });
    for (const name of ['dsh-bridge-core.jsx', 'DSH画布桥接-Photoshop.jsx', 'DSH画布桥接-Illustrator.jsx', 'DSH桥接-发送选中图层-Photoshop.jsx', 'DSH桥接-置入返回件-Photoshop.jsx', 'DSH桥接-发送选中对象-Illustrator.jsx', 'DSH桥接-置入返回件-Illustrator.jsx']) await wf(join(src, name), '\uFEFF// ' + name);
    await wf(join(src, 'cep', 'CSXS', 'manifest.xml'), '<ExtensionManifest ExtensionBundleId="com.dsh.canvasbridge"></ExtensionManifest>');
    await wf(join(src, 'cep', 'index.html'), '<html></html>');
    await wf(join(src, 'cep', 'main.js'), '// panel');
    const record = await w.bridge.installCep();
    assert.equal(record.id, 'com.dsh.canvasbridge');
    assert.equal(record.dir, w.bridge.cepTargetDir());
    assert.equal(record.debugMode.set, false, '单测环境没有 runProcess，不能声称开关已设');
    assert.equal(await rf(join(record.dir, 'CSXS', 'manifest.xml'), 'utf8'), '<ExtensionManifest ExtensionBundleId="com.dsh.canvasbridge"></ExtensionManifest>');
    assert.equal(await rf(join(record.dir, 'main.js'), 'utf8'), '// panel');
    assert.equal(await w.bridge.cepInstalled(), true);
    const status = await w.bridge.status();
    assert.equal(status.cepInstalled, true);
    const installed = JSON.parse(await rf(join(w.bridge.root, 'scripts-installed.json'), 'utf8'));
    assert.equal(installed.cep.dir, record.dir);
  } finally { await w.dispose(); }
});
