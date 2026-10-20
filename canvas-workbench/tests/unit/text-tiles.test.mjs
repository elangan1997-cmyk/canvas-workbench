import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('selected long/wide images retain exact source pixels across overlapping tiles', (t) => {
  const probe = spawnSync('python3', ['-c', 'from PIL import Image'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('Python/Pillow unavailable');
  const result = spawnSync('python3', [fileURLToPath(new URL('../fixtures/text-tiles.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
