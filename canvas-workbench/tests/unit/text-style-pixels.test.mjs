import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('source pixel calibration recovers known font size/color and preserves uncertain rows', (t) => {
  const probe = spawnSync('python3', ['-c', 'from PIL import Image'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('Python/Pillow unavailable');
  const result = spawnSync('python3', [fileURLToPath(new URL('../fixtures/text-style-pixels.py', import.meta.url))], { encoding: 'utf8' });
  if (result.status === 77) return t.skip(result.stdout.trim());
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
