import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeTextCandidates, supplementTextCoverage } from '../../src/host/services/text-coverage.js';

const line = (text, x = 20, y = 100, width = 400) => ({ text, x, y, width, height: 30, confidence: 97 });
const regions = [{ x: 0, y: 0, width: 900, height: 2100 }];

test('tile overlap deduplicates the same line, keeps complete text and repeated text elsewhere', () => {
  const result = mergeTextCandidates([line('首次清洗，照着4步做'), line('首次清洗，照着4步做', 22, 101),
    line('首次清洗', 20, 100, 180), line('首次清洗，照着4步做', 20, 1500), line('清水', 600, 100, 100)]);
  assert.equal(result.length, 3);
  assert.equal(result.filter((b) => b.text === '首次清洗，照着4步做').length, 2);
});

test('supplements a missed lower line inside selection and explicitly labels the source', () => {
  const result = supplementTextCoverage([line('运输碰撞、摩擦，可能产生碎粒或破损。')],
    [line('运输碰撞、摩擦，可能产生碎粒或破损。'), line('收货先检查；明显异常请拍照联系客服。', 20, 150),
      line('选区外', 950, 150), { ...line('噪点', 20, 200), confidence: 20 }], regions);
  assert.equal(result.supplementedCount, 1);
  assert.equal(result.blocks[1].recognitionSource, 'local-ocr-supplement');
  assert.equal(result.blocks[1].needsReview, true);
});

test('split model objects cover an OCR line without creating overlapping duplicate layers', () => {
  const blocks = [line('天然原矿滤材', 20, 100, 170), line('50%', 190, 100, 80)];
  assert.equal(supplementTextCoverage(blocks, [line('天然原矿滤材50%', 20, 100, 250)], regions).supplementedCount, 0);
  const partial = supplementTextCoverage(blocks.slice(0, 1), [line('天然原矿滤材50%以及其他文字', 20, 100, 500)], regions);
  assert.equal(partial.supplementedCount, 1);
  assert.equal(partial.blocks.find((b) => b.needsReview).enabled, false);
});

test('column gaps and overlapping boxes are not counted as covered pixels', () => {
  const result = supplementTextCoverage([line('左', 20, 100, 100), line('左', 20, 100, 100), line('右', 400, 100, 100)],
    [line('完整一行', 20, 100, 500)], regions);
  assert.equal(result.supplementedCount, 1);
});
