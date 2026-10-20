import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../src/client/core/canvas/frame/00-srcdoc.js', import.meta.url), 'utf8');
const html = vm.runInNewContext(source + '\nEXCALIDRAW_SRCDOC');
const code = html.slice(html.indexOf('// ---- Object PNG:'), html.indexOf('// 聊天/工具结果回板必须复用'));
const png = Buffer.from('89504e470d0a1a0a01020304', 'hex');
const image = (id, path) => ({ id, type: 'image', fileId: 'f-' + id, width: 80, height: 40,
  customData: { dshSourcePath: path, dshFileName: path?.split('/').at(-1) || id + '.png' } });

function harness(elements, ids, { mime = 'image/png', files = {}, svg = '<svg viewBox="0 0 900 2100"/>' } = {}) {
  const messages = [], events = {}, requests = [], renders = [], canvases = [], decodedBlobs = [], draws = [];
  const state = { selectedElementIds: ids, viewBackgroundColor: '#ffffff' };
  class Reader {
    async readAsDataURL(blob) { this.result = 'data:' + blob.type + ';base64,' + Buffer.from(await blob.arrayBuffer()).toString('base64'); this.onload?.(); }
  }
  class Image {
    naturalWidth = 1800; naturalHeight = 4200;
    set src(_) { queueMicrotask(() => this.onload()); }
  }
  class DOMParser {
    parseFromString(text) {
      const attrs = Object.fromEntries(Array.from(text.matchAll(/([\w:-]+)="([^"]*)"/g), m => [m[1], m[2]]));
      const root = { localName: 'svg', getAttribute: key => attrs[key] || null,
        setAttribute: (key, value) => { attrs[key] = value; }, style: { setProperty() {} } };
      return { documentElement: root, querySelector: () => null, attrs };
    }
  }
  class XMLSerializer { serializeToString(doc) { return '<svg ' + Object.entries(doc.attrs).map(([k,v]) => k + '="' + v + '"').join(' ') + '/>'; } }
  const context = vm.createContext({ Blob, Uint8Array, FileReader: Reader, Image, DOMParser, XMLSerializer,
    URL: { createObjectURL: blob => { decodedBlobs.push(blob); return 'blob:test'; }, revokeObjectURL() {} },
    document: { addEventListener: (type, fn) => { events[type] = fn; }, createElement(type) {
      assert.equal(type, 'canvas'); const canvas = { width: 0, height: 0, getContext: () => ({ drawImage(...args) { draws.push(args); } }),
        toBlob(fn) { fn(new Blob([png], { type: 'image/png' })); } }; canvases.push(canvas); return canvas;
    } },
    window: { ExcalidrawLib: { async exportToBlob(args) { renders.push(args); return new Blob([png], { type: 'image/png' }); } } },
    api: { getAppState: () => state, getSceneElements: () => elements, getFiles: () => files, updateScene(scene) { Object.assign(state, scene.appState); } },
    empty: {}, post: m => messages.push(m), fileObject: f => f instanceof Map ? Object.fromEntries(f) : f,
    cleanImageName: (name) => name.replace(/\.[^.]+$/, '') + '.png',
    async fetch(url, options) {
      requests.push({ url, options });
      if (url === '/dsh-canvas/clipboard-image') return { ok: true, json: async () => ({ ok: true }) };
      return { ok: true, blob: async () => new Blob([mime === 'image/png' ? png : mime === 'image/svg+xml' ? svg : Buffer.from('source preview')], { type: mime }) };
    }
  });
  vm.runInContext(code, context);
  return { context, events, messages, requests, renders, canvases, state, decodedBlobs, draws,
    menuClick(event) { context.testEvent = event; return vm.runInContext('onObjectPngMenuClick(testEvent)', context); },
    run: expression => vm.runInContext(expression, context) };
}

test('selected export emits separate original PNGs, without canvas zoom, neighbours or margins', async () => {
  const h = harness([image('a', '/a.png'), image('b', '/b.png'), image('other', '/other.png')], { a: true, b: true, other: false });
  await h.run('exportSelectedObjectsPng()');
  assert.deepEqual(h.messages.map(m => m.name), ['a.png', 'b.png']);
  assert.ok(h.messages.every(m => m.dataUrl === 'data:image/png;base64,' + png.toString('base64')));
  assert.equal(h.renders.length, 0);
  assert.equal(h.requests.length, 2);
});

test('all image/document formats decode their source preview at natural dimensions, not scene dimensions', async () => {
  for (const ext of ['jpg', 'webp', 'gif', 'avif', 'bmp', 'psd', 'ai', 'pdf']) {
    const h = harness([image('a', '/art.' + ext)], { a: true }, { mime: ext === 'svg' ? 'image/svg+xml' : 'image/jpeg' });
    await h.run('exportSelectedObjectsPng()');
    assert.equal(h.canvases[0].width, 1800);
    assert.equal(h.canvases[0].height, 4200);
    assert.equal(h.renders.length, 0);
    assert.match(h.requests[0].url, /^\/dsh-canvas\/preview\?path=/);
    assert.equal(h.messages[0].name, 'art.png');
  }
});

test('viewBox-only SVG renders vectors at the original 900x2100 artboard size for export and copy', async () => {
  const h = harness([image('a', '/art.svg')], { a: true }, { mime: 'image/svg+xml' });
  await h.run('exportSelectedObjectsPng()');
  h.run('copySelectedObjectsPng()'); await h.run('objectPngCopyChain');
  assert.deepEqual(h.canvases.map(c => [c.width,c.height]), [[900,2100],[900,2100]]);
  for (const blob of h.decodedBlobs) {
    const text = await blob.text();
    assert.match(text, /viewBox="0 0 900 2100"/);
    assert.match(text, /width="900"/); assert.match(text, /height="2100"/);
  }
  assert.ok(h.draws.every(args => args[3] === 900 && args[4] === 2100));
  assert.equal(h.renders.length, 0);
  assert.ok(h.messages.some(m => m.type === 'object-png-copied'));
});

test('SVG handles physical units, missing viewBox, comma-separated bounds and small icons', async () => {
  for (const [svg, width, height, box] of [
    ['<svg width="225pt" height="525pt"/>', 300, 700, '0 0 300 700'],
    ['<svg viewBox="-10,-20,900,2100"/>', 900, 2100, '-10,-20,900,2100'],
    ['<svg width="100%" height="100%" viewBox="0 0 900 2100"/>', 900, 2100, '0 0 900 2100'],
    ['<svg width="300" viewBox="0 0 900 2100"/>', 300, 700, '0 0 900 2100'],
    ['<svg viewBox="0 0 24 24"/>', 24, 24, '0 0 24 24']
  ]) {
    const h = harness([image('a', '/art.svg')], { a: true }, { mime: 'image/svg+xml', svg });
    await h.run('exportSelectedObjectsPng()');
    assert.deepEqual([h.canvases[0].width,h.canvases[0].height], [width,height]);
    assert.ok((await h.decodedBlobs[0].text()).includes('viewBox="' + box + '"'));
  }
});

test('oversized SVG reports its limit instead of silently resizing the original artboard', async () => {
  for (const svg of ['<svg viewBox="0 0 20000 40000"/>','<svg viewBox="0 0 20000 20000"/>']) {
    const h = harness([image('a', '/large.svg')], { a: true }, { mime: 'image/svg+xml', svg });
    await h.run('exportSelectedObjectsPng()');
    assert.equal(h.canvases.length, 0);
    assert.equal(h.messages[0].type, 'error');
    assert.match(h.messages[0].message, /原始画板尺寸超过/);
  }
});

test('multiple selected copies of the same source receive distinct PNG filenames', async () => {
  const h = harness([image('a', '/same.ai'), image('b', '/same.ai')], { a: true, b: true });
  await h.run('exportSelectedObjectsPng()');
  assert.deepEqual(h.messages.map(m => m.name), ['same.png', 'same-2.png']);
});

test('right-click copy-as-PNG bypasses padded native rendering and sends actual PNG bytes to the host', async () => {
  const h = harness([image('a', '/art.ai')], { a: true });
  let prevented = false, stopped = false;
  h.menuClick({ target: { closest: s => s === '[data-testid="copyAsPng"]' ? {} : null },
    preventDefault() { prevented = true; }, stopImmediatePropagation() { stopped = true; } });
  await h.run('objectPngCopyChain');
  assert.ok(prevented && stopped);
  assert.equal(h.state.contextMenu, null);
  const payload = JSON.parse(h.requests.find(r => r.url === '/dsh-canvas/clipboard-image').options.body);
  assert.equal(payload.imageData, 'data:image/png;base64,' + png.toString('base64'));
  assert.equal(h.renders.length, 0);
});

test('ordinary copy preserves native element handling and text-input copy remains text', async () => {
  const h = harness([image('a', '')], { a: true }, { files: { 'f-a': { dataURL: 'data:image/png;base64,' + png.toString('base64') } } });
  h.events.copy({ target: { closest: () => null } });
  await h.run('objectPngCopyChain');
  assert.equal(h.requests.filter(r => r.url === '/dsh-canvas/clipboard-image').length, 1);
  const before = h.requests.length;
  h.events.copy({ target: { closest: () => ({}) } });
  await h.run('objectPngCopyChain');
  assert.equal(h.requests.length, before);
});

test('no selection never exports the whole canvas; shape export includes only its bound label with zero padding', async () => {
  const shape = { id: 'rect', type: 'rectangle' };
  const elements = [shape, { id: 'label', type: 'text', containerId: 'rect' }, image('other', '/other.png')];
  const h = harness(elements, {});
  await h.run('exportSelectedObjectsPng()');
  assert.equal(h.renders.length, 0);
  assert.match(h.messages[0].message, /请先选中/);
  h.state.selectedElementIds = { rect: true };
  await h.run('exportSelectedObjectsPng()');
  assert.deepEqual(Array.from(h.renders[0].elements, e => e.id), ['rect', 'label']);
  assert.equal(h.renders[0].exportPadding, 0);
  assert.equal(h.renders[0].appState.exportBackground, false);
});
