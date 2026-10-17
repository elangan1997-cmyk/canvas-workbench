import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { buildClient } from '../../scripts/build-client.mjs';

const root = new URL('../../', import.meta.url);
async function frameHtml() {
  const { output } = await buildClient();
  const payload = output.match(/const EXCALIDRAW_VENDOR_SCRIPTS = (\[[^\n]+\]);/);
  assert.ok(payload, 'build must embed pinned vendor payloads');
  const base = await readFile(new URL('src/client/core/canvas/frame/00-srcdoc.js', root), 'utf8');
  const variants = (await readFile(new URL('src/client/core/canvas/frame/01-variants.js', root), 'utf8'))
    .replace('__DSH_CANVAS_VENDOR_BASE64__', payload[1]);
  return vm.runInNewContext(base + '\n' + variants + '\nEXCALIDRAW_SRCDOC_CLEAN');
}

test('srcdoc initializes without external scripts or vendor URL requests', async () => {
  const html = await frameHtml();
  assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=/i);
  assert.doesNotMatch(html, /\/dsh-canvas\/vendor\//);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length >= 4, 'initialization scripts must survive HTML boundaries');
  for (const [, source] of scripts) new vm.Script(source);
  assert.match(html, /ReactDOM.createRoot/);
});

test('embedded loader restores UTF-8 vendor bytes in dependency order', async () => {
  const html = await frameHtml();
  const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .find(([, s]) => s.includes('var payloads='))?.[1];
  assert.ok(source);
  const loaded = [];
  vm.runInNewContext(source, {
    atob: s => Buffer.from(s, 'base64').toString('binary'), Uint8Array, TextDecoder,
    document: { createElement: () => ({}), head: { appendChild: s => loaded.push(s.textContent) } },
    window: { __dshCanvasVendorError: message => assert.fail(message) },
  });
  const names = ['react-18.3.1.production.min.js', 'react-dom-18.3.1.production.min.js', 'excalidraw-0.17.6.production.min.js'];
  assert.equal(loaded.length, names.length);
  for (const [i, name] of names.entries()) {
    assert.equal(loaded[i], await readFile(new URL('vendor/' + name, root), 'utf8'));
  }
});
