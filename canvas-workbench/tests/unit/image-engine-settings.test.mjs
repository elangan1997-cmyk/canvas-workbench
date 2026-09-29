// 图像引擎设置：写入合并/备份/损坏感知（1.9.41 回归锁——Win 实机观测到升级后
// 用户配置被写回出厂默认；要求升级只补缺失字段，绝不覆盖已有用户设置）。
// 跑法：npm test（或 node --test tests/unit/image-engine-settings.test.mjs）
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageEngineSettingsPath, readImageEngineSettings, writeImageEngineSettings } from '../../src/host/services/image-engine-settings.js';

let home;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'cw-engine-'));
  process.env.DSH_HOME = home;
});
afterEach(async () => {
  delete process.env.DSH_HOME;
  await rm(home, { recursive: true, force: true });
});

test('部分字段写入绝不覆盖未提交的用户设置', async () => {
  await writeImageEngineSettings({ engine: 'api', apiBaseUrl: 'https://gw.example.com', imageSize: '1536x1024', imageCount: 4 });
  // 客户端只改比例（升级/重载期间的典型部分请求）
  const next = await writeImageEngineSettings({ imageSize: '1024x1024' });
  assert.equal(next.engine, 'api');
  assert.equal(next.apiBaseUrl, 'https://gw.example.com');
  assert.equal(next.imageCount, 4);
  assert.equal(next.imageSize, '1024x1024');
});

test('空补丁写入不改变任何既有字段', async () => {
  await writeImageEngineSettings({ engine: 'api', imageCount: 8 });
  const next = await writeImageEngineSettings({});
  assert.equal(next.engine, 'api');
  assert.equal(next.imageCount, 8);
});

test('覆盖写入前保留 .bak 单槽备份', async () => {
  await writeImageEngineSettings({ engine: 'api', imageSize: '1080x1920' });
  await writeImageEngineSettings({ imageSize: 'auto' });
  const bak = JSON.parse(await readFile(imageEngineSettingsPath() + '.bak', 'utf8'));
  assert.equal(bak.engine, 'api');
  assert.equal(bak.imageSize, '1080x1920');
});

test('损坏的配置文件读取时带 corrupted 标记而不是无痕回退', async () => {
  await writeImageEngineSettings({ engine: 'api' });
  await writeFile(imageEngineSettingsPath(), '{"engine": "api", "imageSi', 'utf8'); // 撕裂写
  const settings = await readImageEngineSettings();
  assert.equal(settings.corrupted, true);
  // 损坏后写入：先备份损坏现场，再落新值
  await writeImageEngineSettings({ imageSize: '1024x1024' });
  const bak = await readFile(imageEngineSettingsPath() + '.bak', 'utf8');
  assert.ok(bak.includes('imageSi'));
});
