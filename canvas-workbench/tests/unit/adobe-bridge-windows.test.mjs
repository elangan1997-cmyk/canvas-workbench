// Adobe 桥接 Windows 分支单测：在 macOS 上用 isWindows:true 注入模拟（不需要 Windows 真机）。
// 覆盖：① 所有 PowerShell 调用走 -EncodedCommand 且内容正确（引号/中文路径不再经命令行转义）；
//       ② 提权安装的 UAC 流程（外层 Start-Process -Verb RunAs + 内层 .ps1 带结果 JSON 回写 + 取消路径）；
//       ③ appRunning 的 Get-Process 探测。
// 真机验收清单：仓库 WINDOWS-TEST-CHECKLIST.md。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, chmod, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdobeBridge } from '../../src/host/services/adobe-bridge.js';

const decodeEncoded = (b64) => Buffer.from(String(b64), 'base64').toString('utf16le');

async function makeWorld({ runProcess }) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-bridge-win-'));
  await mkdir(join(home, 'plugin', 'adobe-bridge'), { recursive: true });
  const files = [
    'dsh-bridge-core.jsx', 'DSH画布桥接-Photoshop.jsx', 'DSH画布桥接-Illustrator.jsx',
    'DSH桥接-发送选中图层-Photoshop.jsx', 'DSH桥接-置入返回件-Photoshop.jsx',
    'DSH桥接-发送选中对象-Illustrator.jsx', 'DSH桥接-置入返回件-Illustrator.jsx'
  ];
  for (const name of files) await writeFile(join(home, 'plugin', 'adobe-bridge', name), '\uFEFF// ' + name);
  const bridge = createAdobeBridge({
    pluginRoot: join(home, 'plugin'),
    home,
    pluginVersion: '9.9.9',
    isWindows: true,
    runProcess,
    resolveExecutable: async (name) => name === 'powershell' ? 'POWERSHELL.EXE' : name
  });
  return { home, bridge, dispose: () => rm(home, { recursive: true, force: true }) };
}

test('Windows：appRunning 走 -EncodedCommand 的 Get-Process 探测', async () => {
  const calls = [];
  const w = await makeWorld({
    runProcess: async (exe, args) => {
      calls.push({ exe, args });
      return { exitCode: 0, stdout: '1', stderr: '' };
    }
  });
  try {
    assert.equal(await w.bridge.appRunning('photoshop'), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].exe, 'POWERSHELL.EXE');
    assert.deepEqual(calls[0].args.slice(0, 2), ['-NoProfile', '-EncodedCommand']);
    assert.match(decodeEncoded(calls[0].args[2]), /Get-Process -Name Photoshop/);
    assert.equal(decodeEncoded(calls[0].args[2]).includes('-Command'), false, '不允许 -Command 直拼');
  } finally { await w.dispose(); }
});

test('Windows：remoteEval 用 COM DoJavaScriptFile 驱动用户副本脚本，OK:/ERR: 协议照常', async () => {
  const w = await makeWorld({
    runProcess: async (exe, args, cwd) => {
      assert.equal(exe, 'POWERSHELL.EXE');
      assert.equal(args[1], '-EncodedCommand');
      const script = decodeEncoded(args[2]);
      assert.match(script, /New-Object -ComObject Photoshop\.Application/);
      assert.match(script, /DoJavaScriptFile\('(.+)'\)/);
      const jsxPath = script.match(/DoJavaScriptFile\('(.+)'\)/)[1];
      // 驱动脚本此时应已落盘：BOM + 无头模式 + evalFile 用户副本
      const driver = await readFile(jsxPath, 'utf8');
      assert.ok(driver.startsWith('\uFEFF'), '驱动 jsx 带 BOM');
      assert.match(driver, /DSH_BRIDGE_HEADLESS = true/);
      assert.match(driver, /dsh-bridge-photoshop\.jsx/);
      assert.doesNotMatch(driver, /DSH画布桥接-Photoshop\.jsx/);
      assert.match(driver, /B\.ps\.sendSelection\(false\)/);
      assert.match(cwd, /dsh-canvas-bridge/);
      return { exitCode: 0, stdout: 'OK:3', stderr: '' };
    }
  });
  try {
    assert.equal(await w.bridge.remoteEval('photoshop', 'B.ps.sendSelection(false)', 5000), '3');
  } finally { await w.dispose(); }
});

test('Windows：installScriptsElevated 走 UAC——外层 Start-Process -Verb RunAs，内层 .ps1 带结果 JSON；确认后回读', async () => {
  const pf = await mkdtemp(join(tmpdir(), 'dsh-fake-programfiles-'));
  const deniedDir = join(pf, 'Adobe', 'Adobe Photoshop 2025', 'Presets', 'Scripts');
  await mkdir(deniedDir, { recursive: true });
  await chmod(deniedDir, 0o555); // 模拟 Program Files：目录存在但不可写
  const prevPF = process.env.ProgramFiles;
  process.env.ProgramFiles = pf;
  let launcherScript = '';
  const w = await makeWorld({
    runProcess: async (exe, args) => {
      assert.equal(args[1], '-EncodedCommand', '提权外层命令也必须 EncodedCommand');
      launcherScript = decodeEncoded(args[2]);
      assert.match(launcherScript, /Start-Process/);
      assert.match(launcherScript, /-Verb RunAs/);
      assert.match(launcherScript, /-Wait/);
      const match = launcherScript.match(/"-File",\s*'([^']+)'/);
      assert.ok(match, '外层命令以 -File 引用内层脚本');
      const innerPath = match[1];
      const raw = await readFile(innerPath, 'utf8');
      assert.ok(Buffer.from(raw, 'utf8').subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), '内层 .ps1 必须带 BOM（PS 5.1 中文防乱码）');
      const inner = raw.slice(1);
      assert.match(inner, /Copy-Item -LiteralPath/);
      assert.match(inner, /ConvertTo-Json/);
      assert.ok(inner.includes(deniedDir), '内层脚本覆盖被拒目录');
      // 模拟 UAC 确认 + 提权复制成功：把内层脚本会写的结果 JSON 落盘
      const resultPath = inner.match(/\| Set-Content -LiteralPath '([^']+)'/)[1];
      await writeFile(resultPath, JSON.stringify({ ok: true, errors: [] }), 'utf8');
      return { exitCode: 0, stdout: '', stderr: '' };
    }
  });
  try {
    const result = await w.bridge.installScriptsElevated();
    assert.equal(result.elevated, true);
    assert.ok(launcherScript.includes('powershell.exe'));
  } finally {
    await chmod(deniedDir, 0o755);
    if (prevPF === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = prevPF;
    await rm(pf, { recursive: true, force: true });
    await w.dispose();
  }
});

test('Windows：UAC 点「否」→ 明确报「已取消授权」', async () => {
  const pf = await mkdtemp(join(tmpdir(), 'dsh-fake-programfiles-'));
  const deniedDir = join(pf, 'Adobe', 'Adobe Illustrator 2026', 'Presets', 'zh_CN', 'Scripts');
  await mkdir(deniedDir, { recursive: true });
  await chmod(deniedDir, 0o555);
  const prevPF = process.env.ProgramFiles;
  process.env.ProgramFiles = pf;
  const w = await makeWorld({
    runProcess: async () => ({ exitCode: 2, stdout: '', stderr: '' }) // 外层 catch → exit 2 = UAC 取消
  });
  try {
    await assert.rejects(w.bridge.installScriptsElevated(), /已取消授权/);
  } finally {
    await chmod(deniedDir, 0o755);
    if (prevPF === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = prevPF;
    await rm(pf, { recursive: true, force: true });
    await w.dispose();
  }
});
