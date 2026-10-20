import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../src/client/core/canvas/frame/00-srcdoc.js', import.meta.url), 'utf8');
const html = vm.runInNewContext(source + '\nEXCALIDRAW_SRCDOC');
const code = html.slice(html.indexOf('async function restoreCanvasSourceFile('), html.indexOf('// 聊天/工具结果回板必须复用'));

function harness({mime = 'image/svg+xml', ok = true} = {}) {
  const calls = [];
  const svg = '<svg viewBox="0 0 900 2100"><image href="data:image/png;base64,AQID"/></svg>';
  class Reader { async readAsDataURL(blob) { this.result = 'data:' + blob.type + ';base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64'); this.onload(); } }
  const context = vm.createContext({ FileReader: Reader, fetch: async (url, options) => {
    calls.push({url,options}); return {ok,status: ok ? 200 : 404,blob: async () => new Blob([svg],{type:mime})};
  }});
  vm.runInContext(code, context);
  return {calls,svg,restore: (file,path) => context.restoreCanvasSourceFile(file,path)};
}

test('disk SVG hydration loads standalone preview including linked background while preserving file identity', async () => {
  const h = harness(), file = {id:'stable',dshPath:'/project/图.svg',mimeType:'image/svg+xml'};
  await h.restore(file);
  assert.equal(h.calls[0].url, '/dsh-canvas/preview?path=' + encodeURIComponent(file.dshPath));
  assert.equal(h.calls[0].options.cache, 'no-store');
  assert.equal(Buffer.from(file.dataURL.split(',')[1],'base64').toString(), h.svg);
  assert.equal(file.id, 'stable'); assert.equal(file.mimeType, 'image/svg+xml');
});

test('legacy inline SVG refreshes from element source instead of retaining broken relative links', async () => {
  const h = harness(), file = {id:'old',dataURL:'data:image/svg+xml;base64,YnJva2Vu'};
  await h.restore(file, '/project/legacy.SVG');
  assert.match(h.calls[0].url, /^\/dsh-canvas\/preview/);
  assert.ok(Buffer.from(file.dataURL.split(',')[1],'base64').toString().includes('data:image/png'));
});

test('raster restoration uses original bytes route and existing raster data is left untouched', async () => {
  const h = harness({mime:'image/png'}), file = {dshPath:'/project/photo.png'};
  await h.restore(file);
  assert.match(h.calls[0].url, /^\/dsh-canvas\/image/);
  await h.restore(file); await h.restore({dataURL:'data:image/png;base64,AQID'});
  assert.equal(h.calls.length, 1);
});

test('document restoration uses preview MIME and failed SVG reload preserves previous data', async () => {
  const h = harness({mime:'image/jpeg'}), file = {dshPath:'/project/design.psd',mimeType:'image/vnd.adobe.photoshop'};
  await h.restore(file); assert.match(h.calls[0].url, /^\/dsh-canvas\/preview/);
  assert.equal(file.mimeType, 'image/jpeg');
  const failed = harness({ok:false}), old = {dshPath:'/gone.svg',dataURL:'previous'};
  await assert.rejects(failed.restore(old), /404/); assert.equal(old.dataURL, 'previous');
});
