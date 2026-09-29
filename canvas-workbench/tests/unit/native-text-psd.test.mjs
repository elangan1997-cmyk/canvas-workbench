import assert from 'node:assert/strict';
import test from 'node:test';
import { readPsd, writePsdBuffer } from 'ag-psd';
import { buildNativeTextPsd } from '../../src/host/services/native-text-psd.js';

test('native PSD writer creates hidden editable Type layers with reviewed styling', async () => {
  const draft = writePsdBuffer({ width: 64, height: 64, children: [] });
  const bytes = await buildNativeTextPsd(draft, [
    { text: '文字层 QA', x: 12, y: 18, fontSize: 24, fontPostScript: 'ArialMT', color: '#112233', enabled: true },
    { text: '排除', x: 1, y: 1, enabled: false }
  ]);
  const psd = readPsd(bytes, { useImageData: true, skipThumbnail: true });
  const textLayers = psd.children.filter((item) => item.text);
  assert.equal(textLayers.length, 1);
  const layer = textLayers[0];
  assert.equal(layer.name, 'OCR text 1 (review before enabling)');
  assert.equal(layer.hidden, true);
  assert.equal(layer.text.text, '文字层 QA');
  assert.deepEqual(layer.text.transform, [1, 0, 0, 1, 12, 42]);
  assert.equal(layer.text.style.font.name, 'ArialMT');
  assert.equal(layer.text.style.fontSize, 24);
  assert.ok(Math.abs(layer.text.style.fillColor.r - 17) < 0.01);
  assert.ok(Math.abs(layer.text.style.fillColor.g - 34) < 0.01);
  assert.ok(Math.abs(layer.text.style.fillColor.b - 51) < 0.01);
});
