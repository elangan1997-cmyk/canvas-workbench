import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_DSH_CODEX_IMAGE_MODEL, dshCodexImageModel, dshCodexProvider } from '../../src/providers/image/dsh-codex.provider.js';

test('canvas defaults to Image 2.5 and explicitly passes the live or frozen dsh-codex model to the client', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-model-'));
  const previous = { home: process.env.DSH_HOME, module: process.env.DSH_CODEX_MODULE_PATH };
  t.after(async () => {
    for (const [key, value] of [['DSH_HOME', previous.home], ['DSH_CODEX_MODULE_PATH', previous.module]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  // No real credential store or image backend is loaded by this client fixture.
  const file = join(root, 'codex.mjs');
  await writeFile(file, `export const OPENAI_CODEX_IMAGE_EDITS_URL='https://fixture.invalid/images/edits';
  export const OPENAI_CODEX_IMAGE_GENERATIONS_URL='https://fixture.invalid/images/generations';
  export class OpenAICodexImageClient {
    constructor(credentials,fetch){this.fetch=fetch;}
    async generate(prompt, images, signal, model = 'gpt-image-2') {
      if (model === 'unavailable') throw new Error('model unavailable');
      if (prompt === 'request fixture') return this.fetch(OPENAI_CODEX_IMAGE_EDITS_URL,{method:'POST',body:JSON.stringify({model,background:'auto',images}),signal});
      return Buffer.from(JSON.stringify({prompt,images,model,aborted:signal.aborted}));
    }
  }`);
  process.env.DSH_HOME = root; process.env.DSH_CODEX_MODULE_PATH = file;
  const service = { credentials: {}, proxy: { fetch: () => assert.fail('No network request authorized') } };
  const ctx = { get: () => service }, images = [Buffer.from([137,80,78,71,13,10,26,10,0])];
  const generate = async settings => JSON.parse((await dshCodexProvider.generate({ctx,images,prompt:'retain source',settings})).toString());
  assert.equal(DEFAULT_DSH_CODEX_IMAGE_MODEL, 'gpt-image-2.5');
  assert.equal(dshCodexImageModel({}), 'gpt-image-2.5');
  assert.equal((await generate()).model, 'gpt-image-2.5');
  service.imagePreferences = () => ({imageGenerationModel:'gpt-image-2.5-sunburst'});
  assert.equal((await generate()).model, 'gpt-image-2.5-sunburst');
  const frozen = await generate({dshCodexModel:'gpt-image-2.5'});
  assert.equal(frozen.model, 'gpt-image-2.5'); assert.match(frozen.images[0], /^data:image\/png;base64,/);
  assert.equal(frozen.aborted, false);
  await assert.rejects(generate({dshCodexModel:'unavailable'}), /model unavailable/);
  service.proxy.fetch=async (url,init) => Buffer.from(init.body);
  const payload=JSON.parse((await dshCodexProvider.generate({ctx,images,prompt:'request fixture',background:'transparent',settings:{dshCodexModel:'gpt-image-2.5'}})).toString());
  assert.equal(payload.model,'gpt-image-2.5');assert.equal(payload.background,'transparent');assert.equal(payload.images.length,1);
});
