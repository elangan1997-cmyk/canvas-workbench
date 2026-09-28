import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const sourceUrl = new URL('../../src/client/app/025-ToolchainCard.js', import.meta.url);

test('BiRefNet 在工具链中明确标为去背景模型', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  assert.match(source, /rembgModel:\s*'去背景模型\(BiRefNet 约214MB\)'/);
  assert.doesNotMatch(source, /rembgModel:\s*'识别模型/);
});
