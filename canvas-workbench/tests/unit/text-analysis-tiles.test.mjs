import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startHost } from '../integration/host-harness.mjs';

const exec = promisify(execFile);
test('vision tile calls use original pixels, retry independently and retain later/empty tiles', async (t) => {
  try { await exec('python3', ['-c', 'from PIL import Image']); }
  catch { return t.skip('Python/Pillow unavailable'); }
  const pluginDir = fileURLToPath(new URL('../../', import.meta.url));
  const host = await startHost({ pluginDir });
  const work = await mkdtemp(join(tmpdir(), 'text-analysis-test-'));
  try {
    const input = join(work, 'source.png');
    await exec('python3', ['-c', 'from PIL import Image; import sys; Image.new("RGB",(900,2100),"white").save(sys.argv[1])', input]);
    const { analyzeSelectedText, visionBlocks } = await import(pathToFileURL(join(host.stageDir, 'src/host/services/text-analysis.js')).href);
    const saved = [];
    host.ctx.attachments.saveImage = async ({ data, name }) => {
      const bytes = Buffer.from(data);
      const attachment = { id: 'fixture-' + saved.length, width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), name };
      saved.push(attachment);
      return attachment;
    };
    host.ctx.llm.resolveModelInfo = async () => ({ capabilities: { imageInput: true } });
    let calls = 0;
    host.ctx.llm.prepareCall = async () => {
      if (++calls === 1) throw new Error('transient fixture failure');
      return { config: {}, stream: async function* (call) {
        assert.match(call.system, /禁止归一化/);
        const text = call.messages[0].content[0].text;
        assert.match(text, /像素/);
        const name = call.messages[0].content[1].attachment.name;
        const blocks = name.endsWith('2') ? [] : [{ text: '测试重复文字', x: 10, y: name.endsWith('1') ? 30 : 130, width: 200, height: 24, fontSize: 24 },
          ...(name.endsWith('1') ? [] : [{ text: '01', x: 10, y: 20, width: 30, height: 30 }])];
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ blocks }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } };
    };
    const run = async (executable, args, cwd) => {
      const output = await exec(executable, args, { cwd });
      return { exitCode: 0, ...output };
    };
    const result = await analyzeSelectedText(host.ctx, { bytes: await readFile(input), ext: 'png', mime: 'image/png' },
      { provider: 'fixture', model: 'vision', crops: [{ x: 0, y: 0, width: 900, height: 2100 }] }, run);
    assert.equal(result.tileCount, 4);
    assert.equal(result.completedTileCount, 4);
    assert.equal(calls, 5);
    assert.equal(result.width, 900);
    assert.equal(result.height, 2100);
    assert.deepEqual(result.blocks.map((b) => b.y), [30, 1330, 1970]);
    assert.ok(result.blocks.every((b) => b.x === 10 && b.fontSize === 24));
    assert.ok(saved.every((a) => a.width === 900 && a.height <= 800));
    // The old normalization contract remains compatible for other consumers.
    assert.equal(visionBlocks({ blocks: [{ text: '测试', x: 100, y: 500, width: 200, height: 40 }] }, 900, 2100)[0].y, 1050);
  } finally { await host.close(); await rm(work, { recursive: true, force: true }); }
});
