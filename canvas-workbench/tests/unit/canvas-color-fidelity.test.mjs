import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const sourceUrl = new URL('../../src/client/core/canvas/frame/00-srcdoc.js', import.meta.url);

test('暗色画布用完整反相还原图片颜色', async () => {
  const source = await readFile(sourceUrl, 'utf8');
  assert.match(
    source,
    /\.excalidraw\.theme--dark canvas\.excalidraw__canvas\{filter:invert\(1\) hue-rotate\(180deg\)!important\}/,
    '暗色主题必须覆盖 Excalidraw 的 invert(.93)，避免图片抬黑、发白'
  );
  assert.doesNotMatch(
    source,
    /theme--dark canvas\.excalidraw__canvas\{filter:invert\(0\.93\)/,
    '不应在 DSH 覆盖中重新引入 0.93 的对比度压缩'
  );
});
