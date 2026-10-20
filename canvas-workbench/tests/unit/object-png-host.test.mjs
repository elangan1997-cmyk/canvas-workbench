import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFile, access } from 'node:fs/promises';
import { register } from '../../src/host/routes/asset.routes.js';
import { isMac } from '../../lib/platform.js';

const png = Buffer.from('89504e470d0a1a0a01020304', 'hex');
async function request(body, fail = false) {
  let handler, status, output, sourcePath, transport;
  register({ add(spec, fn) { if (spec.path === '/dsh-canvas/clipboard-image') handler = fn; } }, {
    ctx: { subprocess: { resolveExecutable: async name => name } },
    async runProcess(executable, args, cwd) {
      sourcePath = cwd + '/object.png';
      assert.deepEqual(await readFile(sourcePath), png);
      transport = { executable, args };
      return { exitCode: fail ? 1 : 0, stderr: fail ? 'clipboard busy' : '' };
    }
  });
  await handler(Readable.from([Buffer.from(JSON.stringify(body))]), {
    writeHead(code) { status = code; }, end(value) { output = JSON.parse(value); }
  }, { CORS: {} });
  return { status, output, sourcePath, transport };
}

test('native clipboard transport receives exact object PNG bytes and removes temporary data', { skip: !isMac }, async () => {
  const result = await request({ imageData: 'data:image/png;base64,' + png.toString('base64') });
  assert.equal(result.status, 200, JSON.stringify(result.output));
  assert.equal(result.output.mimeType, 'image/png');
  assert.match(result.transport.args[1], /class PNGf/);
  await assert.rejects(access(result.sourcePath));
  const failed = await request({ imageData: 'data:image/png;base64,' + png.toString('base64') }, true);
  assert.equal(failed.status, 500);
  await assert.rejects(access(failed.sourcePath));
});

test('a claimed PNG with non-PNG bytes is rejected before touching the system clipboard', async () => {
  const result = await request({ imageData: 'data:image/png;base64,' + Buffer.from('not a png').toString('base64') });
  assert.equal(result.status, 500);
  assert.equal(result.transport, undefined);
});
