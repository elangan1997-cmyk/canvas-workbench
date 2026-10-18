import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../src/client/core/canvas/frame/00-srcdoc.js', import.meta.url), 'utf8');
const html = vm.runInNewContext(source + '\nEXCALIDRAW_SRCDOC');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .find(([, body]) => body.includes('ReactDOM.createRoot'))[1];

// Mount the actual Main tree and use the onChange wired into Excalidraw, so an
// optimized but unused callback cannot make this regression test pass again.
function harness() {
  const messages = [], listeners = [], timers = new Map(), documentListeners = new Map();
  let timerId = 0, tree, hookIndex = 0;
  const hooks = [];
  const effects = [];
  const useEffect = (setup, deps) => {
    const index = hookIndex++, previous = hooks[index];
    if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    effects.push(() => {
      previous?.cleanup?.();
      hooks[index] = { deps, cleanup: setup() };
    });
  };
  const useRef = value => {
    const index = hookIndex++;
    return hooks[index] || (hooks[index] = { current: value });
  };
  const node = { querySelectorAll: () => [], style: {}, addEventListener() {} };
  const document = { getElementById: () => node, querySelectorAll: () => [],
    addEventListener(name, callback) {
      if (!documentListeners.has(name)) documentListeners.set(name, new Set());
      documentListeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { documentListeners.get(name)?.delete(callback); },
    documentElement: { style: {} }, body: node };
  const window = { innerWidth: 1000, __dshSceneToken: 'A',
    parent: { postMessage: message => messages.push(structuredClone(message)) },
    addEventListener: (name, callback) => { if (name === 'message') listeners.push(callback); },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
      useState: value => { hookIndex++; return [value, () => {}]; }, useRef, useEffect },
    ReactDOM: { createRoot: () => ({ render: element => { tree = element; } }) },
    ExcalidrawLib: { Excalidraw() {} } };
  const context = vm.createContext({ window, document, console,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id), setInterval: () => 0, clearInterval() {} });
  vm.runInContext(script, context);
  function propsOfCanvas(element) {
    if (!element || typeof element !== 'object') return;
    if (element.props?.excalidrawAPI) return element.props;
    for (const child of (element.children || []).flat()) {
      const found = propsOfCanvas(child);
      if (found) return found;
    }
  }
  const render = () => {
    hookIndex = 0;
    const result = propsOfCanvas(tree.type());
    effects.splice(0).forEach(effect => effect());
    return result;
  };
  let props = render();
  const firstCanvasProps = props;
  let files = {}, elements = [], state = { zoom: { value: 1 } };
  const api = { getFiles: () => files, getSceneElements: () => elements, getAppState: () => state,
    resetScene() { elements = []; files = {}; props.onChange(elements, state, files); },
    addFiles(items) { for (const item of items) files[item.id] = item; props.onChange(elements, state, files); },
    updateScene(scene) {
      if (scene.elements) elements = scene.elements;
      if (scene.appState) state = { ...state, ...scene.appState };
      props.onChange(elements, state, files);
    },
  };
  props.excalidrawAPI(api);
  messages.length = 0;
  return { window, messages, timers,
    change(nextElements, nextFiles = files, nextState = state) {
      elements = nextElements; files = nextFiles; state = nextState;
      props.onChange(elements, state, files);
    },
    rerender() { props = render(); return props; },
    listenerCount(name) { return documentListeners.get(name)?.size || 0; },
    click(target) {
      const event = { target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; },
        stopPropagation() {}, stopImmediatePropagation() {} };
      for (const callback of documentListeners.get('click') || []) callback(event);
      return event;
    },
    document,
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
    firstCanvasProps,
    get state() { return state; },
    tick() { const batch = [...timers.values()]; timers.clear(); batch.forEach(callback => callback()); },
    message(data) {
      const event = { source: window.parent, data, stopImmediatePropagation() {} };
      // The capture listener owns snapshot/load; do not run the legacy fallback.
      listeners[0](event);
    },
  };
}

const image = (id = 'a', x = 0) => ({ id, type: 'image', fileId: id, x, y: 0, width: 100, height: 100 });
const file = dataURL => ({ dataURL, mimeType: 'image/png' });

test('drag bursts and Main re-renders send one latest scene with no repeated image bytes', () => {
  const h = harness(), files = { a: file('data:image/png;base64,' + 'A'.repeat(4_000_000)) };
  h.window.__dshSentFilesReset(files);
  for (let i = 0; i < 100; i++) { h.change([image('a', i)], files); h.rerender(); }
  assert.equal(h.messages.length, 0);
  assert.equal(h.timers.size, 1);
  h.tick();
  const message = h.messages[0];
  assert.equal(h.messages.length, 1);
  assert.equal(message.snapshot.elements[0].x, 99);
  assert.deepEqual(message.snapshot.usedFileIds, ['a']);
  assert.deepEqual(message.snapshot.files, {});
  assert.ok(JSON.stringify(message).length < 1000);
});

test('new and same-length replaced images reach the parent, deletion and undo retain correct file membership', () => {
  const h = harness();
  h.change([image()], { a: file('AAAA') }); h.tick();
  assert.equal(h.messages.at(-1).snapshot.files.a.dataURL, 'AAAA');
  h.change([image()], { a: file('BBBB') }); h.tick();
  assert.equal(h.messages.at(-1).snapshot.files.a.dataURL, 'BBBB');
  h.change([], { a: file('BBBB') }); h.tick();
  assert.deepEqual(h.messages.at(-1).snapshot.usedFileIds, []);
  h.change([image()], { a: file('BBBB') }); h.tick();
  assert.equal(h.messages.at(-1).snapshot.files.a.dataURL, 'BBBB');
});

test('cancel and scene tokens discard delayed changes from a previous project', () => {
  const h = harness();
  h.change([image()], { a: file('AAAA') });
  h.window.__dshCancelPendingChanged(); h.tick();
  assert.equal(h.messages.length, 0);
  h.change([image()], { a: file('AAAA') });
  h.window.__dshSceneToken = 'B'; h.tick();
  assert.equal(h.messages.length, 0);
});

test('live snapshot barrier flushes the latest position and still returns complete original image data', () => {
  const h = harness(), files = { a: file('ORIGINAL') };
  h.window.__dshSentFilesReset(files);
  h.change([image('a', 123)], files);
  h.message({ type: 'snapshot-request', requestId: 'save' });
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.messages.map(m => m.type), ['changed', 'snapshot-response']);
  assert.equal(h.messages[1].snapshot.elements[0].x, 123);
  assert.equal(h.messages[1].snapshot.files.a.dataURL, 'ORIGINAL');
});

test('progressive project restore publishes no empty/partial changed scene and seeds the delta cache', () => {
  const h = harness(), files = { a: file('ORIGINAL') };
  h.change([image('old')], { old: file('OLD') });
  h.message({ type: 'load', token: 'B', snapshot: { elements: [image()], files } });
  assert.equal(h.messages.length, 0);
  h.tick(); // addFiles emits an empty scene before updateScene.
  assert.equal(h.messages.length, 0);
  h.tick(); // updateScene.
  assert.equal(h.messages.length, 0);
  h.tick(); // loaded barrier.
  assert.deepEqual(h.messages.map(m => m.type), ['loaded']);
  h.change([image('a', 20)], files); h.tick();
  assert.equal(h.messages.at(-1).token, 'B');
  assert.deepEqual(h.messages.at(-1).snapshot.files, {});
});

test('overlay re-renders reuse the same canvas element props and dispatch through the current change handler', () => {
  const h = harness();
  for (let i = 0; i < 50; i++) assert.equal(h.rerender(), h.firstCanvasProps);
  h.change([image('a', 42)], { a: file('IMAGE') }); h.tick();
  assert.equal(h.messages.at(-1).snapshot.elements[0].x, 42);
});

test('project restore starts with the selection arrow instead of retaining the previous hand tool', () => {
  const h = harness();
  h.message({ type: 'load', token: 'B', snapshot: { elements: [image()], files: { a: file('IMAGE') },
    appState: { activeTool: { type: 'hand', locked: true }, viewModeEnabled: true } } });
  h.tick(); h.tick(); h.tick();
  assert.equal(h.state.activeTool.type, 'selection');
  assert.equal(h.state.activeTool.locked, false);
  assert.equal(h.state.viewModeEnabled, false);
});

test('repeated overlay updates do not accumulate document click handlers', () => {
  const h = harness();
  for (let i = 0; i < 200; i++) h.rerender();
  assert.equal(h.listenerCount('click'), 1);
  let reads = 0;
  h.click({ get textContent() { reads++; return 'unrelated canvas control'; }, parentNode: null });
  assert.equal(reads, 1, 'one click must inspect the target only once after repeated drags');
  h.unmount();
  assert.equal(h.listenerCount('click'), 0, 'unmount removes the capture listener');
});

test('ordinary canvas clicks do not scan the embedded vendor source in body/html', () => {
  const h = harness();
  let globalReads = 0;
  Object.defineProperty(h.document.body, 'textContent', { get() { globalReads++; return 'large embedded vendor source'; } });
  Object.defineProperty(h.document.documentElement, 'textContent', { get() { globalReads++; return 'large embedded vendor source'; } });
  h.click({ textContent: 'canvas', parentNode: h.document.body });
  h.click({ textContent: 'canvas', parentNode: h.document.documentElement });
  assert.equal(globalReads, 0);
});

test('material menu still sends the current selection once after repeated updates', () => {
  const h = harness();
  h.change([image('a')], { a: file('ORIGINAL') }, { selectedElementIds: { a: true }, zoom: { value: 1 } });
  for (let i = 0; i < 200; i++) h.rerender();
  const event = h.click({ textContent: '添加到素材库中', parentNode: h.document.body });
  const saved = h.messages.filter(message => message.type === 'save-to-materials');
  assert.equal(event.defaultPrevented, true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].items.length, 1);
  assert.equal(saved[0].items[0].dataURL, 'ORIGINAL');
  assert.equal(h.state.contextMenu, null);
});
