import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts');

test('Python --spec loader reads the resolved underscore-or-hyphen key', async () => {
  const names = (await readdir(scriptsDir)).filter((name) => name.endsWith('.py'));
  let loaders = 0;
  for (const name of names) {
    const source = await readFile(resolve(scriptsDir, name), 'utf8');
    if (!source.includes("key.replace('_', '-')")) continue;
    loaders += 1;
    assert.doesNotMatch(source, /value\s*=\s*spec\[action\.dest\]/, `${name} ignores its resolved hyphenated key`);
    assert.match(source, /value\s*=\s*spec\[key\]/, `${name} must read the resolved key`);
  }
  assert.ok(loaders >= 16, `expected all spec-aware Python tools, found ${loaders}`);
});
