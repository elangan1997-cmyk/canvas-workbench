import assert from 'node:assert/strict';
import test from 'node:test';
import { readPsd, writePsdBuffer } from 'ag-psd';
import { buildNativeTextPsd } from '../../src/host/services/native-text-psd.js';
import {nativeLayerText,buildLayeredIllustratorJsx} from '../../src/host/services/layered-image-export.js';
import {normalizeLayerElements} from '../../src/host/services/layered-image-model.js';

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

test('PSD roundtrip preserves large type, fitted baseline, tracking and aligned anchors', async () => {
  const block = { text: 'RESTORE', x: 10, y: 20, width: 500, height: 300,
    fontSize: 280, fontPostScript: 'Inter-Bold', color: '#E76F23', textAlign: 'center', tracking: 35,
    textFit: { text: 'RESTORE', fontPostScript: 'Inter-Bold', fontSize: 280, tracking: 35,
      baselineOffset: 215, originOffsetX: -3, advance: 486 } };
  const draft = writePsdBuffer({ width: 1000, height: 600, children: [] });
  const bytes = await buildNativeTextPsd(draft, [block]);
  const layer = readPsd(bytes, { useImageData: true, skipThumbnail: true }).children.find((item) => item.text);
  assert.equal(layer.text.style.fontSize, 280);
  assert.equal(layer.text.style.tracking, 35);
  assert.equal(layer.text.paragraphStyle.justification, 'center');
  assert.deepEqual(layer.text.transform, [1, 0, 0, 1, 250, 235]);
});

test('PSD ignores stale fitting after manual text edits and preserves rotation/right alignment', async () => {
  const draft = writePsdBuffer({ width: 1000, height: 600, children: [] });
  const bytes = await buildNativeTextPsd(draft, [{ text: 'NEW', x: 10, y: 20, width: 300, fontSize: 40,
    fontPostScript: 'Inter-Bold', textAlign: 'right', rotation: 30,
    textFit: { text: 'OLD', fontPostScript: 'Inter-Bold', fontSize: 40, baselineOffset: 1, originOffsetX: 99, advance: 1 } }]);
  const layer = readPsd(bytes, { useImageData: true, skipThumbnail: true }).children.find((item) => item.text);
  assert.equal(layer.text.paragraphStyle.justification, 'right');
  assert.ok(Math.abs(layer.text.transform[0] - Math.cos(Math.PI / 6)) < 0.00001);
  assert.ok(Math.abs(layer.text.transform[1] - 0.5) < 0.00001);
  assert.deepEqual(layer.text.transform.slice(4), [310, 60]);
});


test('tracking is encoded as an integer because Photoshop misreads real-valued Tracking entries', async () => {
  const draft = writePsdBuffer({ width: 100, height: 100, children: [] });
  const bytes = await buildNativeTextPsd(draft, [{ text: 'Spacing', tracking: -32.47, fontSize: 28 }]);
  const layer = readPsd(bytes, { useImageData: true, skipThumbnail: true }).children.find((item) => item.text);
  assert.equal(layer.text.style.tracking, -32);
});

test('upright columns retain the measured leading through resume, PSD and Illustrator export',()=>{
 const b={id:'column',type:'text',name:'竖排',enabled:true,nativeText:true,fontAccepted:true,text:'菜\n单',x:10,y:20,width:12,height:50,fontSize:10,fontPostScript:'Inter-Regular',color:'#112233',tracking:0,
 textFit:{text:'菜\n单',fontPostScript:'Inter-Regular',fontSize:10,tracking:0,baselineOffset:9,originOffsetX:0,advance:10,leading:38}};
 const row=normalizeLayerElements([b],100,100).find(e=>e.id==='column');assert.equal(row.textFit.leading,38);
 const roundtrip=readPsd(writePsdBuffer({width:100,height:100,children:[{name:b.name,text:nativeLayerText(row)}]}),{skipThumbnail:true,useImageData:true}).children[0];
 assert.equal(roundtrip.text.style.leading,38);assert.equal(roundtrip.text.style.autoLeading,false);
 const jsx=buildLayeredIllustratorJsx({width:100,height:100,elements:[row],output:'/test.ai'});assert.match(jsx,/"leading":38/);assert.match(jsx,/ca.leading=b.leading/);
});
