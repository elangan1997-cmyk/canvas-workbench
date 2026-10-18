// Exercise the actual COM transport body with Windows dependencies injected.
// This validates command construction, not an installed Windows Adobe app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../lib/platform.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function runAdobeJsxViaCom(');
const end = source.indexOf('\n/**', start);
const body = source.slice(start, end).replace(/^export /, '').trim();
const runCom = new Function('ADOBE_APPS', 'isWindows', 'resolveFirst', 'psSingleQuote', `return (${body});`)(
  { photoshop: { progId: 'Photoshop.Application' }, illustrator: { progId: 'Illustrator.Application' } }, true,
  async () => 'powershell.exe', (s) => "'" + String(s).replace(/'/g, "''") + "'"
);

for (const app of ['photoshop', 'illustrator']) test(`Windows ${app} export COM transport preserves Chinese/space/apostrophe paths and reports success`, async () => {
  const jsxPath = "C:\\项目 空格\\O'Neil\\文字重建.jsx";
  const result = await runCom({}, async (exe, args, cwd, timeout) => {
    assert.equal(exe, 'powershell.exe');
    assert.deepEqual(args.slice(0, 3), ['-NoLogo', '-NoProfile', '-EncodedCommand']);
    const ps = Buffer.from(args[3], 'base64').toString('utf16le');
    assert.ok(ps.includes(app === 'photoshop' ? 'Photoshop.Application' : 'Illustrator.Application'));
    assert.ok(ps.includes("DoJavaScriptFile('C:\\项目 空格\\O''Neil\\文字重建.jsx')"));
    assert.equal(cwd, 'C:\\临时 目录');
    assert.equal(timeout, 180000);
    return { exitCode: 0, stdout: 'DSH_JSX=dsh-done\r\n', stderr: '' };
  }, { app, jsxPath, workDir: 'C:\\临时 目录' });
  assert.equal(result.ok, true);
});

test('Windows Adobe activation failure stays a failure for the format fallback', async () => {
  const result = await runCom({}, async () => ({ exitCode: 0, stdout: 'DSH_JSX_ERR=com-activate-failed\r\n', stderr: '' }),
    { app: 'illustrator', jsxPath: 'C:\\temp\\text.jsx' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'com-activate-failed');
});
