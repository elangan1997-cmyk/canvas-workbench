import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildIllustratorTextJsx } from '../../src/host/services/illustrator-text.js';

for (const platform of ['mac', 'win']) test(`${platform}: AI script keeps editable point text, fitted baseline, color, tracking and rotation`, () => {
  const calls = [];
  const doc = { artboards: [{ artboardRect: [0, 500, 1000, 0] }], layers: [{}],
    placedItems: { add: () => ({ embed() {} }) },
    textFrames: { pointText: (anchor) => {
      const tf = { anchor, textRange: { characterAttributes: {}, paragraphAttributes: {} },
        transform(matrix) { this.matrix = matrix; } };
      calls.push(tf); return tf;
    } }, saveAs(file) { this.saved = file; }, close(mode) { this.closed = mode; } };
  const output = platform === 'win' ? "C:\\项目 空格\\O'Neil\\可编辑.ai" : '/tmp/项目 空格/可编辑.ai';
  const jsx = buildIllustratorTextJsx({ background: output + '.png', output, width: 1000, height: 500, blocks: [
    { text: '校准文字', x: 10, y: 20, width: 300, fontSize: 280, fontPostScript: 'Inter-Bold', textAlign: 'right', color: '#123456', tracking: -32.47, rotation: 30,
      textFit: { text: '校准文字', fontPostScript: 'Inter-Bold', fontSize: 280, tracking: -32.47, baselineOffset: 200, originOffsetX: 4, advance: 290 } },
    { text: '排除', enabled: false }
  ] });
  const context = { $: { sleep() {} }, app: { redraw() {}, documents: { add: () => doc }, textFonts: { getByName: (name) => ({ name }) }, getIdentityMatrix: () => ({}) },
    File: function(path) { this.fsName = path; }, RGBColor: function() {}, IllustratorSaveOptions: function() {},
    DocumentColorSpace: { RGB: 1 }, RulerUnits: { Points: 1 }, Justification: { LEFT: 0, CENTER: 1, RIGHT: 2 },
    Transformation: { DOCUMENTORIGIN: 0 }, SaveOptions: { DONOTSAVECHANGES: 2 } };
  const bytes = platform === 'win' ? '\uFEFF' + jsx : jsx;
  assert.equal(vm.runInNewContext(bytes.replace(/^\uFEFF?#target[^\n]*\n/, ''), context), 'dsh-ai-done');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contents, '校准文字');
  const attrs = calls[0].textRange.characterAttributes;
  assert.equal(attrs.size, 280);
  assert.equal(attrs.tracking, -32);
  assert.equal(attrs.fillColor.red, 18);
  assert.equal(calls[0].textRange.paragraphAttributes.justification, 2);
  assert.deepEqual(Array.from(calls[0].anchor), [304, 280]);
  const m=calls[0].matrix;
  assert.ok(Math.abs(m.mValueA*304+m.mValueC*280+m.mValueTX-304)<1e-8);
  assert.ok(Math.abs(m.mValueB*304+m.mValueD*280+m.mValueTY-280)<1e-8);
  assert.ok(Math.abs(calls[0].matrix.mValueB + .5) < 1e-10);
  assert.equal(doc.saved.fsName, output);
  assert.equal(doc.closed, 2);
  assert.doesNotMatch(jsx, /close every document|app\.documents\[|CloseOptions/);
  assert.doesNotMatch(jsx, /\?Justification\./, 'ExtendScript enum assignments require explicit branches');
});

test('SVG fallback uses clean background, calibrated typography and UTF-8 spec result', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const probe = spawnSync('python3', ['-c', 'from PIL import Image']);
  if (probe.status !== 0) return t.skip('Python/Pillow unavailable');
  const r = spawnSync('python3', [fileURLToPath(new URL('../fixtures/text-export-svg.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
