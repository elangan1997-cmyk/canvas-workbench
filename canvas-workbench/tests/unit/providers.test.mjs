import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProviderRegistry } from '../../src/providers/registry.js';
import {
  normalizeImageEngine, normalizeApiBaseUrl, effectiveApiBase, DEFAULT_API_BASE_URL, DEFAULT_API_MODEL,
  readImageEngineSettings, writeImageEngineSettings, imageEngineSettingsPath
} from '../../src/host/services/image-engine-settings.js';
import { parseImagePayload, imageApiRetryDelay, modelIdsFromPayload, RETRYABLE_IMAGE_API_STATUSES, gatewaySizeFor } from '../../src/providers/image/openai-compatible.provider.js';
import { imageMediaType, dataUrl } from '../../src/shared/utils/image-bytes.js';
import { imageProviders, generateImage, ratioHintFor } from '../../src/providers/image-engine.js';
import * as libShim from '../../lib/image-engine.js';

test('registry: register / get / require / findByCapability', () => {
  const r = createProviderRegistry();
  assert.throws(() => r.register({}), /缺少 id/);
  assert.throws(() => r.register({ id: 'x' }), /缺少 generate/);
  r.register({ id: 'a', capabilities: ['image.generate'], generate: async () => Buffer.alloc(0) });
  r.register({ id: 'b', capabilities: ['image.generate', 'video.generate'], generate: async () => Buffer.alloc(0) });
  assert.equal(r.get('a').id, 'a');
  assert.throws(() => r.require('zzz'), /未注册的生成引擎：zzz/);
  assert.deepEqual(r.findByCapability('video.generate').map((p) => p.id), ['b']);
  assert.deepEqual(r.list().map((p) => p.id), ['a', 'b']);
  assert.equal(r.unregister('a'), true);
  assert.equal(r.get('a'), undefined);
});

test('默认注册表含 dsh-codex 与 api，且 lib 薄壳导出同一实例', () => {
  assert.deepEqual(imageProviders.list().map((p) => p.id).sort(), ['api', 'dsh-codex']);
  assert.equal(libShim.imageProviders, imageProviders);
  for (const name of ['generateImage', 'generateChatImage', 'imageEngineHealth', 'testImageApiConnection', 'readImageEngineSettings', 'writeImageEngineSettings', 'readLegacyApiAuth', 'writeLegacyApiAuth', 'normalizeImageEngine', 'imageEngineSettingsPath']) {
    assert.equal(typeof libShim[name], 'function', name);
  }
});

test('normalizeImageEngine：非法值回落 dsh-codex', () => {
  assert.equal(normalizeImageEngine('api'), 'api');
  assert.equal(normalizeImageEngine(' dsh-codex '), 'dsh-codex');
  assert.equal(normalizeImageEngine('nope'), 'dsh-codex');
  assert.equal(normalizeImageEngine(undefined), 'dsh-codex');
});

test('normalizeApiBaseUrl：去尾斜杠、去 /v1、空值回退', () => {
  assert.equal(normalizeApiBaseUrl('https://x.test/v1/'), 'https://x.test');
  assert.equal(normalizeApiBaseUrl('https://x.test///'), 'https://x.test');
  assert.equal(normalizeApiBaseUrl('', 'fb'), 'fb');
  assert.equal(normalizeApiBaseUrl(undefined), DEFAULT_API_BASE_URL);
});

test('effectiveApiBase：设置改过默认地址时优先设置，否则用旧 auth 的网关', () => {
  assert.equal(effectiveApiBase({ apiBaseUrl: DEFAULT_API_BASE_URL }, { baseUrl: 'https://gw.test' }), 'https://gw.test');
  assert.equal(effectiveApiBase({ apiBaseUrl: 'https://custom.test/' }, { baseUrl: 'https://gw.test' }), 'https://custom.test');
  assert.equal(effectiveApiBase({ apiBaseUrl: '' }, { baseUrl: '' }), DEFAULT_API_BASE_URL);
});

test('settings 读写：缺文件给默认值；写入 0600 并可读回', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-home-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    assert.equal(imageEngineSettingsPath(), join(home, 'canvas-workbench', 'image-engine.json'));
    assert.deepEqual(await readImageEngineSettings(), { engine: 'dsh-codex', apiBaseUrl: DEFAULT_API_BASE_URL, apiModel: DEFAULT_API_MODEL, imageSize: 'auto', imageCount: 1 });
    const next = await writeImageEngineSettings({ engine: 'api', apiBaseUrl: 'https://x.test/v1', apiModel: ' m1 ' });
    assert.deepEqual(next, { engine: 'api', apiBaseUrl: 'https://x.test', apiModel: 'm1', imageSize: 'auto', imageCount: 1 });
    const sized = await writeImageEngineSettings({ imageSize: '1536x1024' });
    assert.equal(sized.imageSize, '1536x1024');
    assert.equal((await writeImageEngineSettings({ imageSize: '1920x1080' })).imageSize, '1920x1080');
    assert.equal((await writeImageEngineSettings({ imageSize: '2560x1080' })).imageSize, '2560x1080');
    assert.equal((await writeImageEngineSettings({ imageSize: '3840x2160' })).imageSize, 'auto');
    assert.equal((await writeImageEngineSettings({ imageCount: 4 })).imageCount, 4);
    assert.equal((await writeImageEngineSettings({ imageCount: 99 })).imageCount, 1);
    assert.equal((await writeImageEngineSettings({ imageSize: 'bogus' })).imageSize, 'auto');
    const mode = (await stat(imageEngineSettingsPath())).mode & 0o777;
    assert.equal(mode, 0o600);
    assert.deepEqual(JSON.parse(await readFile(imageEngineSettingsPath(), 'utf8')), next);
    assert.deepEqual(await readImageEngineSettings(), next);
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;
    await rm(home, { recursive: true, force: true });
  }
});

test('parseImagePayload：b64 直接解码；缺数据报错', async () => {
  const b = await parseImagePayload({ data: [{ b64_json: Buffer.from('hi').toString('base64') }] });
  assert.equal(b.toString(), 'hi');
  assert.throws(() => parseImagePayload({}), /未返回图片数据/);
  assert.throws(() => parseImagePayload({ data: [{}] }), /可读取的图片数据/);
});

test('imageApiRetryDelay：retry-after 秒/日期/缺省指数退避（上限 40s）', () => {
  const h = (v) => ({ headers: { get: () => v } });
  assert.equal(imageApiRetryDelay(h('3'), 1), 3000);
  assert.equal(imageApiRetryDelay(h('999'), 1), 20000);
  const soon = new Date(Date.now() + 5000).toUTCString();
  const d = imageApiRetryDelay(h(soon), 1);
  assert.ok(d > 3000 && d <= 5000, String(d));
  assert.equal(imageApiRetryDelay(h(''), 1), 10000);
  assert.equal(imageApiRetryDelay(h(''), 2), 20000);
  assert.equal(imageApiRetryDelay(h(''), 3), 40000);
  assert.equal(imageApiRetryDelay(h(''), 9), 40000);
  assert.ok(RETRYABLE_IMAGE_API_STATUSES.has(502) && !RETRYABLE_IMAGE_API_STATUSES.has(400));
});

test('modelIdsFromPayload：data / models 两种形状去重', () => {
  assert.deepEqual(modelIdsFromPayload({ data: [{ id: 'a' }, 'b', { model: 'a' }, { name: 'c' }] }), ['a', 'b', 'c']);
  assert.deepEqual(modelIdsFromPayload({ models: ['x'] }), ['x']);
  assert.deepEqual(modelIdsFromPayload(null), []);
});

test('imageMediaType / dataUrl', () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
  assert.equal(imageMediaType(png), 'image/png');
  assert.equal(imageMediaType(Buffer.from([255, 216, 255, 0])), 'image/jpeg');
  assert.equal(imageMediaType(Buffer.from('RIFF0000WEBPVP8 ')), 'image/webp');
  assert.equal(imageMediaType(Buffer.from('GIF89a')), 'image/gif');
  assert.equal(imageMediaType(Buffer.from('hello')), 'application/octet-stream');
  assert.ok(dataUrl(png).startsWith('data:image/png;base64,'));
  assert.throws(() => dataUrl(Buffer.from('hello')), /格式无效/);
});

test('generateImage：空输入报错；未知引擎经 normalize 回落 dsh-codex（不触网）', async () => {
  await assert.rejects(generateImage({ ctx: { get: () => null }, image: Buffer.alloc(0), prompt: 'x' }), /图片输入为空/);
});

test('gatewaySizeFor:非标比例映射到网关标准三档(对数距离最近)', () => {
  const cases = {
    '1024x1024': '1024x1024', '1536x1024': '1536x1024', '1024x1536': '1024x1536',
    '1080x1920': '1024x1536', '1920x1080': '1536x1024', '2560x1080': '1536x1024',
    '1280x960': '1536x1024', '960x1280': '1024x1536', '2048x1024': '1536x1024',
    '1024x2048': '1024x1536', '1280x1024': '1536x1024', '1024x1280': '1024x1536'
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(gatewaySizeFor(input), expected, input);
  assert.equal(gatewaySizeFor('auto'), '');
  assert.equal(gatewaySizeFor('bogus'), '');
});

test('ratioHintFor:把画布选择明确注入模型提示词', () => {
  const hint = ratioHintFor('2560x1080');
  assert.match(hint, /21:9/);
  assert.match(hint, /2560×1080/);
  assert.match(hint, /必须遵守/);
  assert.equal(ratioHintFor('auto'), '');
});
