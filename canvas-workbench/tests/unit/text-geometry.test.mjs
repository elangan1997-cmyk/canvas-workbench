import test from 'node:test';
import assert from 'node:assert/strict';
import { refineTextGeometry } from '../../src/host/services/text-geometry.js';

test('matches model rows to measured table lines without merging their text or columns', () => {
  const blocks = [
    { text: '【产品名称】', x: 36, y: 414, width: 204, height: 58, color: '#123456' },
    { text: '观赏鱼专用盐', x: 242, y: 414, width: 400, height: 58 }
  ];
  const result = refineTextGeometry(blocks, [
    { text: '观赏鱼专用盐', x: 80, y: 120, width: 660, height: 122 },
    { text: '【产品名称】 观赏鱼专用盐', x: 60, y: 427, width: 371, height: 34 }
  ]);
  assert.equal(result.refinedCount, 2);
  assert.equal(result.blocks[0].text, blocks[0].text);
  assert.equal(result.blocks[0].color, '#123456');
  assert.equal(result.blocks[0].y, 425);
  assert.equal(result.blocks[1].y, 425);
  assert.equal(result.blocks[0].height, 38);
  assert.ok(result.blocks[0].x + result.blocks[0].width < result.blocks[1].x + 5);
});

test('excludes packaging outside selection, rotated text and unmatched OCR content', () => {
  const block = { text: '观赏鱼专用盐', x: 100, y: 1300, width: 300, height: 50, rotation: 0 };
  const line = { text: '观赏鱼专用盐', x: 130, y: 1305, width: 260, height: 30 };
  assert.deepEqual(refineTextGeometry([block], [line], [{ x: 0, y: 0, width: 800, height: 900 }]).blocks, [block]);
  assert.equal(refineTextGeometry([{ ...block, rotation: 15 }], [line]).refinedCount, 0);
  assert.equal(refineTextGeometry([block], [{ ...line, text: '不相关文字' }]).refinedCount, 0);
});
