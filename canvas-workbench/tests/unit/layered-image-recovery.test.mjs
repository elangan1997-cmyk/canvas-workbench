import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';

const source = await readFile(new URL('../../src/client/features/layered-image/00-LayeredImagePanel.js', import.meta.url), 'utf8');
const imageData = 'data:image/png;base64,' + Buffer.from('source-one').toString('base64');
const sourceHash = createHash('sha256').update(Buffer.from('source-one')).digest('hex');
const failed = () => ({ id: 'layers-saved-111111111111', sourceHash, name: '原图.png', storageProject: '/chat-workspace', workspaceRoot: '/chat-workspace',
  createdAt: 1, status: 'failed', error: '暂时失败', elements: [{ id: 'photo', type: 'image', name: '照片', status: 'complete', enabled: true }], exports: [],
  generationAttempts: 2, maxImageRequests: 4, width: 100, height: 200, autoExportFormat: 'psd', openAfterExport: true });
const props = () => ({ data: { elementId: 'canvas-image', imageData }, project: { project: '/legacy-canvas', cwd: '/chat-workspace', sessionId: 'sid' },
  onClose() {}, onFile() {}, model: { provider: 'current', model: 'selected' } });

function mount(options = {}) {
  const slots = [], effects = [], requests = [], storage = options.storage || new Map();
  let cursor = 0, scheduled = false, active = true, tree;
  const schedule = () => { if (!scheduled && active) { scheduled = true; queueMicrotask(() => { scheduled = false; if (active) render(); }); } };
  const React = {
    createElement: (type, p, ...children) => ({ type, props: p || {}, children: children.flat(Infinity) }),
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { const value = typeof next === 'function' ? next(slots[index]) : next; if (!Object.is(value, slots[index])) { slots[index] = value; schedule(); } }]; },
    useRef(initial) { const index = cursor++; if (!(index in slots)) slots[index] = { current: initial }; return slots[index]; },
    useEffect(setup, deps) { const index = cursor++, previous = slots[index];
      if (!previous || deps.some((v, i) => !Object.is(v, previous.deps[i]))) { slots[index] = { deps, cleanup: previous?.cleanup }; effects.push(() => { slots[index].cleanup?.(); slots[index].cleanup = setup(); }); } }
  };
  const context = vm.createContext({ React, TEXT_REBUILD_FONTS: [], console, URLSearchParams, Uint8Array, crypto: webcrypto, atob, AbortController, setTimeout, clearTimeout,
    window: { localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) } },
    fetch: async (url, init) => { requests.push({ url, init }); const value = await options.respond(url, init); return { ok: true, json: async () => value }; }
  });
  const Panel = vm.runInContext(source + '\nLayeredImagePanel', context);
  function render() { cursor = 0; tree = Panel(options.props || props()); while (effects.length) effects.shift()(); }
  render();
  const nodes = () => { const all = []; const visit = node => { if (node && typeof node === 'object') { all.push(node); node.children?.forEach(visit); } }; visit(tree); return all; };
  return { requests, storage, nodes, text: () => nodes().flatMap(n => n.children.filter(c => typeof c === 'string')).join(' '),
    button: label => nodes().find(n => n.type === 'button' && n.children.includes(label)),
    async until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('UI did not settle: ' + this.text()); },
    unmount() { active = false; for (const slot of slots) slot?.cleanup?.(); }
  };
}

test('reopening the panel restores the matching failed disk task, format and quota without another analysis request', async t => {
  const saved = failed();
  const ui = mount({ respond: async (url, init) => {
    if (init?.method === 'POST') { const body = JSON.parse(init.body); assert.equal(body.id, saved.id); assert.equal(body.project, '/chat-workspace'); assert.equal(body.maxImageRequests, 4); assert.equal(body.autoExportFormat, 'psd'); return { ok: true, task: saved }; }
    if (url.includes('/tasks?')) return { ok: true, tasks: url.includes('storageScope=workspace') ? [saved] : [] };
    assert.equal(new URL(url, 'http://local').searchParams.get('project'), '/chat-workspace'); return { ok: true, task: saved };
  } });
  t.after(() => ui.unmount());
  assert.equal(ui.button('一键拆层并导出 PSD').props.disabled, true, 'analysis stays disabled while recovery is pending');
  await ui.until(() => ui.text().includes('任务已保存'));
  assert.ok(ui.button('继续生成')); assert.equal(ui.button('一键拆层并导出 PSD'), undefined);
  assert.equal(ui.nodes().find(n => n.type === 'select' && n.props['aria-label'] === '拆层导出格式').props.value, 'psd');
  assert.equal(ui.requests.some(r => r.init), false, 'opening a panel must only read saved progress');
  await ui.button('继续生成').props.onClick();
  assert.equal(ui.requests.filter(r => r.init).length, 1);
  assert.match(ui.requests.find(r => r.init).url, /\/run$/);
});

test('a persisted locator restores an older task beyond the recent list after a complete unmount', async t => {
  const storage = new Map(); const saved = failed(); let listed = true;
  const respond = async url => url.includes('/tasks?') ? { ok: true, tasks: listed ? [saved] : [] } : { ok: true, task: saved };
  const first = mount({ storage, respond });
  await first.until(() => first.text().includes('任务已保存')); first.unmount(); listed = false;
  const second = mount({ storage, respond }); t.after(() => second.unmount());
  await second.until(() => second.text().includes('任务已保存'));
  assert.ok(second.button('继续生成')); assert.equal(second.requests.some(r => r.init), false);
  assert.ok(second.nodes().find(n => n.type === 'option' && n.props.value === saved.id), 'restored locator is also visible in task history');
});

test('same filename on a different image never restores or runs the unrelated task; one failed history source does not hide workspace recovery', async t => {
  const other = { ...failed(), sourceHash: 'different-image-hash' };
  const ui = mount({ respond: async url => ({ ok: true, tasks: [other] }) }); t.after(() => ui.unmount());
  await ui.until(() => ui.button('一键拆层并导出 PSD') && !ui.button('一键拆层并导出 PSD').props.disabled);
  assert.equal(ui.button('继续生成'), undefined); assert.equal(ui.requests.some(r => r.init), false);
  const saved = failed();
  const recovered = mount({ respond: async url => {
    if (url.includes('/tasks?') && !url.includes('storageScope')) throw Error('old project missing');
    return url.includes('/tasks?') ? { ok: true, tasks: [saved] } : { ok: true, task: saved };
  } }); t.after(() => recovered.unmount());
  await recovered.until(() => recovered.text().includes('任务已保存'));
  assert.ok(recovered.button('继续生成'));
});

test('one-click UI submits one automatic pipeline and a restored finished export is delivered to the canvas', async t => {
  const calls = []; const ui = mount({ respond: async (url, init) => {
    if (init) { calls.push(JSON.parse(init.body)); return { ok: true, task: failed() }; }
    return { ok: true, tasks: [] };
  } }); t.after(() => ui.unmount());
  await ui.until(() => ui.button('一键拆层并导出 PSD') && !ui.button('一键拆层并导出 PSD').props.disabled);
  await ui.button('一键拆层并导出 PSD').props.onClick();
  assert.equal(calls.length, 1); assert.equal(calls[0].autoRun, true); assert.equal(calls[0].autoExportFormat, 'psd'); assert.equal(calls[0].maxImageRequests, 40);
  const delivered = []; const done = { ...failed(), status: 'ready', exports: [{ path: '/chat-workspace/assets/result.psd', kind: 'psd', name: 'result.psd' }] };
  const restored = mount({ props: { ...props(), onFile: item => delivered.push(item) }, respond: async url => url.includes('/tasks?') ? { ok: true, tasks: [done] } : { ok: true, task: done } });
  t.after(() => restored.unmount()); await restored.until(() => delivered.length === 1);
  assert.equal(delivered[0].path, done.exports[0].path); assert.equal(restored.requests.some(r => r.init), false);
});
