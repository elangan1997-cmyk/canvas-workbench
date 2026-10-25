import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPsd } from 'ag-psd';
import { normalizeLayerElements, extractionPrompt } from '../../src/host/services/layered-image-model.js';
import { createLayeredImageService } from '../../src/host/services/layered-image.js';
import { nativeLayerText, buildLayeredIllustratorJsx } from '../../src/host/services/layered-image-export.js';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6unwAAAAASUVORK5CYII=';
const sampleElements = () => [
  { id: 'bg', type: 'background', name: '背景', z: 0 },
  { id: 'object', type: 'image', name: '产品', description: '绿色产品，包装字随产品保留', x: 1, y: 1, width: 2, height: 2, z: 1 }
];

async function fixture(t, generation) {
  const project = await mkdtemp(join(tmpdir(), 'dsh-layers-test-'));
  t.after(() => rm(project, { recursive: true, force: true }));
  const generated = [];
  const pixel = async spec => {
    if (spec.operation === 'text-colors') return {colors:[]};
    if (spec.operation === 'matte-quality') return {accepted:true};
    if (spec.operation === 'text-material-ownership') return {candidates:[]};
    if (spec.operation === 'structure') return {elements:spec.elements,structureChanges:[]};
    if (spec.operation === 'render-structure') { await writeFile(spec.output,'local'); return {engine:spec.element.type==='shape'?'local-vector-shape':'source-photo-rectangle'}; }
    if (spec.operation === 'source-flat') return { eligible: false };
    if (spec.operation === 'inspect') {
      if (spec.output) await writeFile(spec.output, await readFile(spec.input));
      return { success: true, width: 4, height: 4, hasTransparency: true };
    }
    if (spec.operation === 'normalize') {
      await writeFile(spec.output, await readFile(spec.input));
      return { success: true, width: 4, height: 4, hasTransparency: true, actualPixels: [4, 4], resized: false };
    }
    if (spec.operation === 'text' || spec.operation === 'source-text') { await writeFile(spec.output, 'text'); return { success: true,engine:spec.operation==='source-text'?'source-text-region':undefined }; }
    if (spec.operation === 'crop-layer') { await mkdir(join(spec.output, '..'), {recursive:true}); await writeFile(spec.output, await readFile(spec.input)); return { success:true, bounds:{x:0,y:0,width:4,height:4} }; }
    if (['background-plate','preserve-canvas-margin'].includes(spec.operation)) return {success:true};
    if (spec.operation === 'assemble') {
      const layers = [];
      for (const [i, e] of spec.elements.filter(e => e.enabled).sort((a, b) => a.z - b.z).entries()) {
        const raw = join(spec.directory, 'test-' + i + '.rgba');
        await writeFile(raw, Buffer.from(Array.from({ length: 16 }, () => e.type === 'background' ? [0, 0, 255, 255] : [255, 0, 0, 255]).flat()));
        layers.push({ name: e.name, raw, left: 0, top: 0, width: 4, height: 4, element: e });
      }
      const composite = join(spec.directory, 'test-composite.rgba'), preview = join(spec.directory, 'preview.png');
      await writeFile(composite, Buffer.alloc(64, 255)); await writeFile(preview, 'preview');
      return { width: 4, height: 4, layers, composite, preview };
    }
    throw new Error('Unexpected operation ' + spec.operation);
  };
  const h = { ctx: {}, projectDirectory: () => project, previewUrl: file => 'preview:' + file };
  const overrides = { pixel, analyze: async () => ({ elements: sampleElements(), warnings: [] }), settings: async () => ({ engine: 'api', apiModel: 'offline-test' }),
    generate: async args => { generated.push(args); return generation ? generation(args, generated.length) : { bytes: Buffer.from('generated') }; } };
  const service = createLayeredImageService(h, overrides);
  const created = await service.analyze({ imageData: png, provider: 'test', model: 'test', name: '测试.png' });
  const body = { id: created.id };
  await service.settled(body);
  return { service, body, project, generated, h, overrides };
}

test('layer plan enforces a unique background, coordinates, review and stable IDs', () => {
  const plan = normalizeLayerElements([{ id: 'p', type: 'image', x: 500, y: 200, width: 700, height: 1000 }], 900, 1200, { normalized: true });
  assert.equal(plan[0].type, 'background'); assert.equal(plan[1].x, 450); assert.equal(plan[1].width, 450);
  assert.throws(() => normalizeLayerElements([{ id: '../escape' }], 100, 100), /ID/);
  assert.throws(() => normalizeLayerElements([{ id: 'x' }, { id: 'x' }], 100, 100), /重复/);
  assert.throws(() => normalizeLayerElements([{ id: 'a', type: 'background' }, { id: 'b', type: 'background' }], 100, 100), /一个/);
  assert.equal(normalizeLayerElements([{ id: 't', type: 'text', text: '文', nativeText: true }], 100, 100)[1].fontAccepted,false,'font approval is performed automatically by the executor');
  const prompt = extractionPrompt(plan[1], plan, 900, 1200);
  assert.match(prompt, /真实Alpha/); assert.match(prompt, /禁止居中/);
});

test('local preflight rejections consume no image requests, and migration never clears an actual unknown network request',async t=>{
 const f=await fixture(t,async()=>{const e=Error('图片输入格式无效');e.imageRequestNotSent=true;throw e;});
 await f.service.run({...f.body,maxImageRequests:2});const failed=await f.service.settled(f.body);
 assert.equal(failed.generationAttempts,0);assert.ok(failed.elements.every(e=>e.requestState==='not-submitted'));
 const file=join(failed.outputDirectory,'task.json'),record=JSON.parse(await readFile(file,'utf8'));record.reconstruction='complete';record.generationAttempts=2;
 record.elements[0].requestState='unknown';record.elements[0].error='network timeout';
 record.elements[1].requestState='unknown';record.elements[1].error='图片输入格式无效';await writeFile(file,JSON.stringify(record));
 const recovered=await createLayeredImageService(f.h,f.overrides).get(f.body);
 assert.equal(recovered.generationAttempts,1);assert.equal(recovered.elements[0].requestState,'unknown');assert.equal(recovered.elements[1].requestState,'not-submitted');
 assert.equal((await createLayeredImageService(f.h,f.overrides).get(f.body)).generationAttempts,1,'migration is idempotent');
});

test('layer extraction freezes the chosen Codex image model per run and invalidates generated assets when it changes', async t => {
  let model = 'gpt-image-2.5';
  const f = await fixture(t, async (_args, count) => {
    if (count === 1) model = 'gpt-image-2.5-flare';
    return {bytes:Buffer.from('generated')};
  });
  f.h.ctx.get = () => ({imagePreferences:() => ({imageGenerationModel:model})});
  await f.service.run({...f.body,engine:'dsh-codex'});
  let task = await f.service.settled(f.body);
  assert.equal(task.imageModel,'gpt-image-2.5');
  assert.deepEqual(f.generated.map(a=>a.settingsOverride.dshCodexModel),['gpt-image-2.5','gpt-image-2.5']);
  await f.service.run({...f.body,engine:'dsh-codex'});
  task = await f.service.settled(f.body);
  assert.equal(task.imageModel,'gpt-image-2.5-flare');
  assert.equal(f.generated.length,4);
  await f.service.run({...f.body,engine:'dsh-codex'}); await f.service.settled(f.body);
  assert.equal(f.generated.length,4,'same model resumes from assets');
});

test('automatic completion persists a real PSD in assets and preview before opening Adobe', async t => {
  const f = await fixture(t), events = [];
  f.h.writeManagedSource = async (project, name, bytes, kind) => {
    assert.equal(project,f.project); await mkdir(join(project,'assets'),{recursive:true});
    const path=join(project,'assets',name);await writeFile(path,bytes);
    events.push('saved');return {path,name,kind,mtime:1,size:bytes.length,managed:true};
  };
  f.h.cacheSourcePreview = async (path,mtime,kind,preview) => {
    assert.equal(kind,'psd');assert.ok((await readFile(path)).length);assert.ok((await readFile(preview)).length);events.push('preview');
  };
  f.overrides.open = async item => {
    const manifest=JSON.parse(await readFile(join(f.project,'outputs','图片拆层',f.body.id,'task.json'),'utf8'));
    assert.equal(manifest.exports[0].path,item.path);events.push('opened');
  };
  await f.service.run({...f.body,autoExportFormat:'psd',openAfterExport:true});
  const task=await f.service.settled(f.body);
  assert.equal(task.status,'ready');assert.equal(task.exports.length,1);
  assert.deepEqual(events,['saved','preview','opened']);
  const psd=readPsd(await readFile(task.exports[0].path),{skipLayerImageData:true,skipCompositeImageData:true,skipThumbnail:true});
  assert.equal(psd.children.length,2);
  const processFiles = await import('node:fs/promises').then(fs => fs.readdir(join(f.project,'outputs','图片拆层',f.body.id)));
  assert.equal(processFiles.some(name => name.endsWith('.psd')), false, 'managed delivery must not leave a second complete PSD in the process folder');
});

test('failed analysis resumes the same task rather than discarding it or applying an empty UI draft',async t=>{
 const f=await fixture(t);let calls=0;
 f.overrides.analyze=async()=>{if(++calls===1)throw Error('元素分析未正常完成：max-tokens');return{elements:sampleElements(),warnings:[]};};
 f.overrides.calibrate=async task=>({elements:task.elements,quality:{status:'passed',issues:[]}});
 const service=createLayeredImageService(f.h,f.overrides);const task=await service.analyze({imageData:png,provider:'test',model:'test',autoRefine:true});
 let result=await service.settled({id:task.id});assert.equal(result.status,'failed');assert.equal(result.elements.length,0);
 await service.run({id:task.id,elements:[],autoExportFormat:'psd',maxImageRequests:2});result=await service.settled({id:task.id});
 assert.equal(result.id,task.id);assert.equal(result.status,'ready',result.error);assert.equal(result.elements.length,2,'an empty restored UI draft must not replace the new analysis');assert.equal(result.exports.length,1);assert.equal(calls,2);
});

test('new canvas splits follow the current workspace; switching workspace never moves an existing task or reuses an old test path', async t => {
  const f = await fixture(t);
  const a = join(f.project, 'work-a'), b = join(f.project, 'work-b');
  const h = { ...f.h, projectDirectory: (cwd, project) => project || cwd, chatContexts: new Map([['sid', { cwd: a, project: f.project }]]) };
  const service = createLayeredImageService(h, f.overrides);
  const create = () => service.analyze({ imageData: png, name: '当前图片.png', provider: 'test', model: 'test', sessionId: 'sid',
    storageScope: 'workspace', cwd: '/stale-client-workspace', project: f.project });
  const first = await create();
  assert.equal(first.storageProject, a); assert.equal(first.workspaceRoot, a);
  assert.equal(first.outputDirectory, join(a, 'outputs', '图片拆层', first.id));
  const firstRequest = { id: first.id, project: first.storageProject };
  await service.settled(firstRequest);
  h.chatContexts.set('sid', { cwd: b, project: first.storageProject });
  const second = await create(); assert.equal(second.storageProject, b);
  await service.settled({ id: second.id, project: second.storageProject });
  assert.equal((await service.get(firstRequest)).storageProject, a, 'an existing task remains pinned for safe resume');
  assert.equal((await service.list({ cwd: b, sessionId: 'sid', storageScope: 'workspace' })).length, 1);
  const legacy = await service.get({ ...f.body, project: f.project }); assert.equal(legacy.storageProject, f.project);
  await assert.rejects(service.analyze({ imageData: png, provider: 'test', model: 'test', storageScope: 'workspace' }), /工作目录/);
});

test('failure to open Adobe keeps the completed file and reports a warning', async t => {
  const f = await fixture(t);f.overrides.open=async()=>{throw new Error('editor unavailable');};
  await f.service.run({...f.body,autoExportFormat:'psd',openAfterExport:true});
  const task=await f.service.settled(f.body);
  assert.equal(task.status,'ready');assert.equal(task.exports.length,1);
  assert.match(task.warnings.join(' '),/文件已保存.*editor unavailable/);
  assert.ok((await readFile(task.exports[0].path)).length);
});

test('extraction is serial, requests one attempt, persists assets and exports actual PSD layers', async t => {
  const f = await fixture(t);
  await f.service.run(f.body);
  const ready = await f.service.settled(f.body);
  assert.equal(ready.status, 'ready'); assert.equal(f.generated.length, 2);
  assert.equal(f.generated[0].background, 'transparent'); assert.equal(f.generated[1].background, 'opaque');
  assert.equal(f.generated[0].maxAttempts, 1);
  assert.ok(ready.elements.every(e => !('file' in e) && !('rawFile' in e)));
  const reordered = ready.elements.map(e => ({ ...e, z: e.z + 4 }));
  await f.service.run({ ...f.body, elements: reordered }); await f.service.settled(f.body);
  assert.equal(f.generated.length, 2, 'Changing order must reuse successful extraction assets');
  await f.service.export({ ...f.body, format: 'psd' });
  const exported = await f.service.settled(f.body);
  assert.equal(exported.status, 'ready'); assert.equal(exported.exports[0].kind, 'psd');
  const saved = readPsd(await readFile(exported.exports[0].path), { useImageData: true, skipThumbnail: true });
  assert.equal(saved.children.length, 2); assert.deepEqual(saved.children.map(l => l.name), ['背景', '产品']);
  const restarted = createLayeredImageService(f.h, f.overrides);
  assert.equal((await restarted.get(f.body)).exports.length, 1);
  assert.equal((await restarted.list({})).length, 1);
  await assert.rejects(restarted.get({ id: '../x' }), /编号/);
});

test('unknown model outcome is never automatically retried and successful layers survive resume', async t => {
  let rejectBackground = true;
  const f = await fixture(t, async args => {
    if (args.background === 'opaque' && rejectBackground) throw new Error('timeout: outcome unknown');
    return { bytes: Buffer.from('result') };
  });
  await f.service.run(f.body); const failed = await f.service.settled(f.body);
  assert.equal(failed.status, 'failed'); assert.equal(f.generated.length, 2);
  await assert.rejects(f.service.run(f.body), /结果未知/);
  rejectBackground = false;
  await f.service.run({ ...f.body, retryUnknown: true });
  assert.equal((await f.service.settled(f.body)).status, 'ready');
  assert.equal(f.generated.length, 3, 'Already-completed foreground must not be generated again');
});

test('a returned layer rejected by the old aspect check is recovered from its raw file without buying the layer again', async t => {
  const f = await fixture(t); const pixel = f.overrides.pixel; let oldCheck = true; const cachedCalls = [];
  f.overrides.pixel = async spec => {
    if (spec.operation === 'normalize' && spec.input.endsWith('.original') && !spec.background) {
      if (oldCheck) throw new Error('old canvas-only aspect mismatch');
      return { ...await pixel(spec), framing: 'layer-canvas', actualPixels: [32, 12], aligned: { from: [0,0,32,12], to: [1,1,3,3] } };
    }
    if (spec.operation === 'normalize' && spec.preserve_placement) cachedCalls.push(spec);
    return pixel(spec);
  };
  await f.service.run({...f.body,maxImageRequests:1}); assert.equal((await f.service.settled(f.body)).status, 'failed'); assert.equal(f.generated.length, 1);
  oldCheck = false; await f.service.run({ ...f.body, localOnly: true, maxImageRequests: 1 }); const local = await f.service.settled(f.body);
  assert.equal(local.elements.find(e => e.type === 'image').status, 'complete'); assert.equal(f.generated.length, 1, 'cached raw processing is local even if the following background is not available yet');
  await f.service.run(f.body); let ready = await f.service.settled(f.body);
  assert.equal(ready.status, 'ready'); assert.equal(ready.elements.find(e => e.type === 'image').returnedFraming, 'layer-canvas');
  assert.equal(f.generated.length, 2, 'only the still-missing background may generate; the photo is reused');
  await f.service.run(f.body); ready = await f.service.settled(f.body);
  assert.equal(ready.status, 'ready'); assert.equal(f.generated.length, 2); assert.ok(cachedCalls.length > 0);
});

test('cancel aborts current request and does not submit the next element', async t => {
  let started;
  const gate = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async args => {
    started();
    await new Promise((resolve, reject) => args.signal.addEventListener('abort', () => reject(args.signal.reason), { once: true }));
  });
  await f.service.run(f.body); await gate;
  const cancelled = await f.service.cancel(f.body);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal((await f.service.settled(f.body)).status, 'cancelled'); assert.equal(f.generated.length, 1);
});

test('native text metadata remains editable with integer tracking; Illustrator embeds layers and checks saved text', () => {
  const b = { id: 't', name: '原生文字', type: 'text', enabled: true, nativeText: true, fontAccepted: true, text: '可改字',
    fontPostScript: 'Inter-Regular', fontSize: 24, x: 10, y: 12, width: 100, z: 2, color: '#123456', tracking: 25.3 };
  const text = nativeLayerText(b); assert.equal(text.style.tracking, 25); assert.equal(text.text, '可改字');
  const jsx = buildLayeredIllustratorJsx({ width: 900, height: 1200, output: 'C:\\项目 空格\\test.ai', elements: [b, { id: 'p', enabled: true, name: '图像', z: 0, file: 'C:\\素材\\图.png' }] });
  assert.match(jsx, /pi\.embed\(\)/); assert.match(jsx, /doc\.layers\.add\(\)/); assert.match(jsx, /doc=app\.open/);
  assert.match(jsx, /AI text readback mismatch/); assert.match(jsx, /Missing Illustrator font/);
  new Function(jsx.replace(/^#target[^\n]+\n/, ''));
});

test('one-click submission finishes analysis, local recovery, extraction and a real PSD without another run request', async t => {
  const f = await fixture(t); let interruptions = 0; const originalPixel = f.overrides.pixel;
  f.overrides.pixel = async spec => {
    if (spec.operation === 'normalize' && spec.input.endsWith('.original') && interruptions++ === 0) {
      const error = new Error('local worker interrupted'); error.localRetryable = true; throw error;
    }
    return originalPixel(spec);
  };
  f.overrides.retryDelay = async () => {};
  const task = await f.service.analyze({ imageData: png, name: '一次完成.png', provider: 'selected-chat', model: 'selected-model', autoRun: true, autoExportFormat: 'psd', maxImageRequests: 2 });
  const result = await f.service.settled({ id: task.id });
  assert.equal(result.status, 'ready'); assert.equal(result.automatic, true); assert.equal(result.exports.length, 1);
  assert.equal(result.recoveryEvents.length, 1); assert.equal(result.generationAttempts, 2);
  assert.equal(f.generated.length, 2, 'the interrupted local step must reuse raw, never purchase the photo again');
  const saved = readPsd(await readFile(result.exports[0].path), { skipLayerImageData: true, skipCompositeImageData: true, skipThumbnail: true });
  assert.equal(saved.children.length, 2);
});

test('an unrecoverable layer does not prevent independent layers from completing and unknown generation outcomes are not retried', async t => {
  const f = await fixture(t, async (_args, count) => { if (count === 1) throw Error('connection lost; outcome unknown'); return { bytes: Buffer.from('background') }; });
  await f.service.run({ ...f.body, autoExportFormat: 'psd', maxImageRequests: 2 }); const result = await f.service.settled(f.body);
  assert.equal(result.status, 'failed'); assert.equal(result.elements.find(e => e.type === 'image').requestState, 'unknown');
  assert.equal(result.elements.find(e => e.type === 'background').status, 'complete');
  assert.equal(f.generated.length, 2); assert.equal(result.exports.length, 0); assert.match(result.error, /已保存 1\/2/);
  await assert.rejects(f.service.run(f.body), /结果未知/); assert.equal(f.generated.length, 2);
});

test('corrupt derived PNG is rebuilt automatically from returned raw without another image request', async t => {
  const f = await fixture(t); await f.service.run(f.body); await f.service.settled(f.body);
  const disk = JSON.parse(await readFile(join(f.project, 'outputs', '图片拆层', f.body.id, 'task.json'), 'utf8'));
  const object = disk.elements.find(e => e.type === 'image'); await writeFile(object.file, 'broken-png');
  const originalPixel = f.overrides.pixel;
  f.overrides.pixel = async spec => {
    if (spec.operation === 'normalize' && spec.preserve_placement && String(await readFile(spec.input)) === 'broken-png') throw Error('invalid PNG');
    return originalPixel(spec);
  };
  await f.service.run(f.body); const result = await f.service.settled(f.body);
  assert.equal(result.status, 'ready'); assert.equal(f.generated.length, 2);
  assert.match(result.warnings.join(' '), /自动重建/); assert.notEqual(String(await readFile(object.file)), 'broken-png');
});

test('local recovery has a strict retry bound and never silently accepts unresolved quality or exceeds the image cap', async t => {
  const f = await fixture(t); const originalPixel = f.overrides.pixel; let tries = 0;
  f.overrides.retryDelay = async () => {};
  f.overrides.pixel = async spec => {
    if (spec.operation === 'normalize' && spec.input.endsWith('.original')) { tries++; const error = Error('worker repeatedly interrupted'); error.localRetryable = true; throw error; }
    return originalPixel(spec);
  };
  const created = await f.service.analyze({ imageData: png, provider: 'selected', model: 'selected', autoRun: true, maxImageRequests: 1, autoExportFormat: 'psd' });
  const result = await f.service.settled({ id: created.id });
  assert.equal(result.status, 'failed'); assert.equal(f.generated.length, 1); assert.equal(tries, 3); assert.equal(result.recoveryEvents.length, 2);
  assert.equal(result.exports.length, 0);
  f.overrides.calibrate = async task => ({ elements: task.elements, quality: { status: 'needs_review', issues: [{ code: 'invalid-geometry', severity: 'error' }] } });
  const blocked = await f.service.analyze({ imageData: png, provider: 'selected', model: 'selected', autoRun: true, autoRefine: true, maxImageRequests: 3, autoExportFormat: 'psd' });
  assert.equal((await f.service.settled({ id: blocked.id })).status, 'needs_review'); assert.equal(f.generated.length, 1);
});

test('a transient post-publication failure automatically finishes the export without publishing a duplicate or regenerating layers', async t => {
  const f = await fixture(t); let writes = 0, previews = 0;
  f.overrides.retryDelay = async () => {};
  f.h.writeManagedSource = async (project, name, bytes, kind) => { writes++; const path = join(project, 'assets', name); await mkdir(join(project, 'assets'), { recursive: true }); await writeFile(path, bytes); return { path, name, kind, size: bytes.length, mtime: 1 }; };
  f.h.cacheSourcePreview = async () => { if (previews++ === 0) { const error = Error('file temporarily busy'); error.code = 'EBUSY'; throw error; } };
  const created = await f.service.analyze({ imageData: png, provider: 'selected', model: 'selected', autoRun: true, autoExportFormat: 'psd', maxImageRequests: 2 });
  const result = await f.service.settled({ id: created.id });
  assert.equal(result.status, 'ready'); assert.equal(writes, 1); assert.equal(result.exports.length, 1); assert.equal(f.generated.length, 2);
  assert.equal(result.recoveryEvents.at(-1).step, '导出文件');
});

test('automatic analysis never exposes a terminal review state between analysis and extraction', async t => {
  const f = await fixture(t); let release, reached; const gate = new Promise(resolve => { release = resolve; }); const pending = new Promise(resolve => { reached = resolve; }); let reads = 0;
  f.overrides.settings = async () => { if (++reads === 2) { reached(); await gate; } return { engine: 'api', apiModel: 'offline-test' }; };
  const service = createLayeredImageService(f.h, f.overrides);
  const task = await service.analyze({ imageData: png, provider: 'selected', model: 'selected', autoRun: true, maxImageRequests: 2, autoExportFormat: 'psd' });
  await pending; assert.equal((await service.get({ id: task.id })).status, 'running', 'polling must stay active while the next phase is prepared');
  release(); assert.equal((await service.settled({ id: task.id })).status, 'ready');
});

test('concurrent run submissions cannot both prepare the same task or replace the settings used by the active worker', async t => {
  const f = await fixture(t); let release, reached; const gate = new Promise(resolve => { release = resolve; }); const pending = new Promise(resolve => { reached = resolve; });
  f.overrides.settings = async () => { reached(); await gate; return { engine: 'api', apiModel: 'offline-test' }; };
  const service = createLayeredImageService(f.h, f.overrides);
  const running = service.run(f.body); await pending;
  await assert.rejects(service.run({ ...f.body, localOnly: true }), /当前步骤仍在执行/);
  release(); await running; const result = await service.settled(f.body);
  assert.equal(result.status, 'ready'); assert.equal(result.localOnly, false); assert.equal(f.generated.length, 2);
});

test('cancelling a legacy multiline task during automatic calibration cannot start generation afterwards',async t=>{
 const f=await fixture(t);let release,reached;const wait=new Promise(r=>release=r),ready=new Promise(r=>reached=r);
 f.overrides.analyze=async()=>({elements:[{id:'bg',type:'background'},{id:'t',type:'text',text:'First\nSecond',x:0,y:0,width:4,height:4}]});
 f.overrides.calibrate=async task=>{reached();await wait;return{elements:task.elements,quality:{status:'passed',issues:[]}};};
 const service=createLayeredImageService(f.h,f.overrides),created=await service.analyze({imageData:png,provider:'test',model:'test'});await service.settled({id:created.id});
 const running=service.run({id:created.id,maxImageRequests:2});await ready;await service.cancel({id:created.id});release();await assert.rejects(running,/取消/);
 assert.equal((await service.get({id:created.id})).status,'cancelled');assert.equal(f.generated.length,0);
});

test('generated-background review is rechecked and repaired locally without accepting the issue or repurchasing images', async t => {
  const f=await fixture(t); let dirty=true;
  f.overrides.calibrate=async task=>({elements:task.elements,quality:{status:'passed',issues:[]}});
  f.overrides.refinement=async()=>({issues:dirty?[{code:'textured-background',severity:'review'}]:[]});
  // cleanPlate runs when there is native text, independently of image caching.
  f.overrides.analyze=async()=>({elements:[...sampleElements(),{id:'text',type:'text',text:'Menu',nativeText:true,fontAccepted:true,fontPostScript:'Inter-Regular',x:0,y:0,width:1,height:1}]});
  const service=createLayeredImageService(f.h,f.overrides);
  const created=await service.analyze({imageData:png,provider:'selected',model:'selected',autoRun:true,autoRefine:true,autoExportFormat:'psd',maxImageRequests:2});
  let result=await service.settled({id:created.id});assert.equal(result.status,'ready');assert.equal(f.generated.length,2);assert.equal(result.exports.length,1);
  assert.equal(result.quality.issues.find(i=>i.code==='textured-background').severity,'warning','visual differences are reported without a user acknowledgement gate');
  dirty=false;await service.run({id:created.id,autoExportFormat:'psd',maxImageRequests:2});result=await service.settled({id:created.id});
  assert.equal(result.status,'ready');assert.equal(result.quality.reviewAcknowledged,false);assert.equal(f.generated.length,2);assert.equal(result.exports.length,1);
});

test('automatic text correction retains returned product and background caches through refine and needs no extra image quota',async t=>{
 const f=await fixture(t);let corrected=false;
 f.overrides.analyze=async()=>({elements:[...sampleElements(),{id:'text',type:'text',text:'Original',nativeText:true,fontAccepted:true,fontPostScript:'Inter-Regular',x:0,y:0,width:1,height:1}]});
 f.overrides.calibrate=async task=>({elements:task.elements.map(e=>e.type==='text'?{...e,text:corrected?'Corrected':'Original'}:e),quality:{status:'passed',issues:[]}});
 f.overrides.refinement=async()=>({issues:[]});const service=createLayeredImageService(f.h,f.overrides);
 const task=await service.analyze({imageData:png,provider:'test',model:'test',autoRun:true,autoRefine:true,autoExportFormat:'psd',maxImageRequests:2});
 assert.equal((await service.settled({id:task.id})).status,'ready');assert.equal(f.generated.length,2);
 corrected=true;await service.refine({id:task.id,editableText:true});let result=await service.settled({id:task.id});assert.equal(result.status,'review');assert.ok(result.elements.some(e=>e.status==='pending'));
 await service.run({id:task.id,autoExportFormat:'psd',maxImageRequests:2});result=await service.settled({id:task.id});
 assert.equal(result.status,'ready',result.error);assert.equal(result.elements.find(e=>e.id==='text').text,'Corrected');assert.equal(f.generated.length,2);assert.equal(result.generationAttempts,2);
 const psd=readPsd(await readFile(result.exports[0].path),{skipLayerImageData:true,skipCompositeImageData:true});assert.equal(psd.children.find(e=>e.name===result.elements.find(e=>e.id==='text').name).text.text,'Corrected');
});

test('legacy native metadata cannot reuse a source-text bitmap and changing representation invalidates the export checkpoint',async t=>{
 const f=await fixture(t),basePixel=f.overrides.pixel;let nativeRenders=0;
 f.overrides.pixel=async spec=>{
  if(spec.operation==='text'){nativeRenders++;await writeFile(spec.output,'native:'+spec.element.text);return {success:true};}
  return basePixel(spec);
 };
 f.overrides.analyze=async()=>({elements:[{id:'bg',type:'background',name:'背景'},
  {id:'word',type:'text',name:'菜名',text:'奶茶',x:0,y:0,width:1,height:1,nativeText:true,fontAccepted:true}]});
 const s=createLayeredImageService(f.h,f.overrides),a=await s.analyze({imageData:png,provider:'test',model:'current'});await s.settled(a);
 await s.run({id:a.id,autoExportFormat:'psd'});let task=await s.settled(a);assert.equal(task.status,'ready',task.error);
 const manifest=join(task.outputDirectory,'task.json'),stored=JSON.parse(await readFile(manifest,'utf8')),word=stored.elements.find(e=>e.id==='word');
 // Older runs overwrote the native asset with the source fallback, then a
 // calibration restored native metadata at that same asset key.
 await writeFile(word.file,'old source bitmap');delete word.nativePreviewSignature;await writeFile(manifest,JSON.stringify(stored));
 const migrated=createLayeredImageService(f.h,f.overrides);await migrated.export({id:a.id,format:'psd'});task=await migrated.settled(a);
 assert.equal(task.status,'ready',task.error);assert.equal(nativeRenders,2);assert.equal(await readFile(word.file,'utf8'),'native:奶茶');
 let current=JSON.parse(await readFile(manifest,'utf8'));const signature=current.exportCheckpoint.signature,path=current.exportCheckpoint.published.path;
 assert.ok(current.elements.find(e=>e.id==='word').nativePreviewSignature);
 current.elements.find(e=>e.id==='word').nativeText=false;await writeFile(manifest,JSON.stringify(current));
 const raster=createLayeredImageService(f.h,f.overrides);await raster.export({id:a.id,format:'psd'});task=await raster.settled(a);
 assert.equal(task.status,'ready',task.error);current=JSON.parse(await readFile(manifest,'utf8'));
 assert.notEqual(current.exportCheckpoint.signature,signature,'same bitmap composite does not mean the same editable representation');
 assert.notEqual(current.exportCheckpoint.published.path,path);assert.equal(f.generated.length,1,'legacy migration only renders locally');
 const psd=readPsd(await readFile(current.exportCheckpoint.published.path),{skipLayerImageData:true,skipCompositeImageData:true});
 assert.equal(psd.children.find(e=>e.name==='菜名').text,undefined);
});

test('typed photos bypass image generation and matting; PSD shape layers retain a native vector fill and mask', async t => {
 const f=await fixture(t);f.overrides.matte=async()=>{throw Error('photos must never be matted');};
 f.overrides.analyze=async()=>({elements:[{id:'bg',type:'background',name:'背景'},{id:'photo',type:'image',name:'完整照片',extractionMode:'photo',x:0,y:0,width:4,height:3,z:1},{id:'plate',type:'shape',name:'圆角底框',shapeKind:'roundedRect',fill:'#E5EAF3',radius:.5,x:1,y:1,width:2,height:1,z:2}]});
 const service=createLayeredImageService(f.h,f.overrides);const first=await service.analyze({imageData:png,provider:'selected',model:'selected',autoRun:true,maxImageRequests:1,autoExportFormat:'psd'});const result=await service.settled({id:first.id});
 assert.equal(result.status,'ready');assert.equal(f.generated.length,1);assert.equal(f.generated[0].background,'opaque','only the global background may generate');
 assert.equal(result.elements.find(e=>e.id==='photo').extractionEngine,'source-photo-rectangle');
 const doc=readPsd(await readFile(result.exports[0].path),{skipLayerImageData:true,skipCompositeImageData:true,skipThumbnail:true});const shape=doc.children.find(e=>e.name==='圆角底框');
 assert.equal(shape.vectorFill.type,'color');assert.equal(shape.vectorMask.paths[0].knots.length,8);
 assert.deepEqual(shape.vectorFill.color,{r:229,g:234,b:243});
 const jsx=buildLayeredIllustratorJsx({width:4,height:4,elements:result.elements,output:'/tmp/unused-shape.ai'});assert.match(jsx,/roundedRectangle/);assert.match(jsx,/sp\.stroked=false/);
});

test('dense assembled-picture readback restores a flagged native word locally and verifies the repaired preview',async t=>{
 const f=await fixture(t),basePixel=f.overrides.pixel;let checks=0,sourceText=0;
 f.overrides.pixel=async spec=>{
  if(spec.operation==='source-layout-plate'){await writeFile(spec.output,'background');return {engine:'source-layout-plate'};}
  if(spec.operation==='source-text')sourceText++;
  return basePixel(spec);
 };
 f.overrides.analyze=async()=>({analysisStrategy:'dense',elements:[{id:'bg',type:'background',name:'背景',z:-100},{id:'word',type:'text',text:'奶茶',name:'菜名',x:0,y:0,width:3,height:2,z:1,nativeText:true,fontAccepted:true}]});
 f.overrides.readback=async()=>({issues:++checks===1?[{id:'word',reason:'局部原字重影'}]:[]});
 const s=createLayeredImageService(f.h,f.overrides);const a=await s.analyze({imageData:png,provider:'test',model:'current'});await s.settled(a);
 await s.run({id:a.id});const result=await s.settled(a);assert.equal(result.status,'ready',result.error);assert.equal(checks,2);assert.equal(sourceText,2);assert.equal(result.elements.find(e=>e.id==='word').nativeText,false);assert.equal(f.generated.length,0);
});

test('newly exposed visual defects receive a second bounded local correction without another user retry',async t=>{
 const f=await fixture(t),basePixel=f.overrides.pixel;let checks=0;
 f.overrides.pixel=async spec=>{
  if(spec.operation==='source-layout-plate'){await writeFile(spec.output,'background');return {engine:'source-layout-plate'};}
  const r=await basePixel(spec);
  if(spec.operation==='crop-layer')r.bounds=spec.input.includes('word1-')?{x:0,y:0,width:1,height:1}:spec.input.includes('word2-')?{x:2,y:2,width:1,height:1}:r.bounds;
  return r;
 };
 f.overrides.analyze=async()=>({analysisStrategy:'dense',elements:[{id:'bg',type:'background',name:'背景'},...['word1','word2'].map((id,i)=>({id,type:'text',name:id,text:'奶茶',x:i*2,y:i*2,width:1,height:1,nativeText:true,fontAccepted:true}))]});
 f.overrides.readback=async()=>({issues:++checks===1?[{id:'word1',reason:'重影'}]:checks<4?[{id:'word2',reason:'缺字'}]:[]});
 const s=createLayeredImageService(f.h,f.overrides),created=await s.analyze({imageData:png,provider:'test',model:'current'});await s.settled(created);
 await s.run({id:created.id});const result=await s.settled(created);assert.equal(result.status,'ready',result.error);assert.equal(checks,4);assert.equal(result.assemblyCheck.verified,true);assert.equal(f.generated.length,0);assert.ok(result.elements.filter(e=>e.type==='text').every(e=>!e.nativeText));
});

test('the last readback defects are restored locally and proved against source pixels before exporting',async t=>{
 const f=await fixture(t),base=f.overrides.pixel;let checks=0;
 const positions={w1:[0,0],w2:[2,0],w3:[0,2]};
 f.overrides.pixel=async spec=>{
  if(spec.operation==='source-layout-plate'){await writeFile(spec.output,'background');return {engine:'source-layout-plate'};}
  if(spec.operation==='verify-source-regions')return {exact:spec.elements.map(e=>e.id)};
  const r=await base(spec);if(spec.operation==='crop-layer'){
   const id=Object.keys(positions).find(id=>spec.input.includes(id+'-'));if(id){const [x,y]=positions[id];r.bounds={x,y,width:1,height:1};}
  }return r;
 };
 f.overrides.analyze=async()=>({analysisStrategy:'dense',elements:[{id:'bg',type:'background',name:'背景'},...Object.entries(positions).map(([id,[x,y]])=>({id,type:'text',name:id,text:'字',x,y,width:1,height:1,nativeText:true,fontAccepted:true}))]});
 f.overrides.readback=async()=>({complete:true,issues:[{id:++checks===1?'w1':checks<4?'w2':'w3',reason:'错字'}]});
 const s=createLayeredImageService(f.h,f.overrides),a=await s.analyze({imageData:png,provider:'test',model:'current'});await s.settled(a);
 await s.run({id:a.id,autoExportFormat:'psd'});const task=await s.settled(a);
 assert.equal(task.status,'ready',task.error);assert.equal(checks,4,'final source proof needs no additional model or image request');
 assert.deepEqual(task.assemblyCheck.finalSourceFallback,['w3']);assert.equal(task.assemblyCheck.verified,true);
 assert.ok(task.elements.filter(e=>e.type==='text').every(e=>!e.nativeText));assert.equal(task.exports.length,1);assert.equal(f.generated.length,0);
});

test('complete reconstruction repairs the native word instead of silently flattening it',async t=>{
 const f=await fixture(t);let checks=0,repairs=0;
 f.overrides.analyze=async()=>({analysisStrategy:'dense',elements:[{id:'bg',type:'background',name:'背景'},
 {id:'t',type:'text',name:'菜名',text:'奶荼',x:0,y:0,width:2,height:2,nativeText:true,fontAccepted:true}]});
 f.overrides.calibrate=async task=>({elements:task.elements,quality:{issues:[]}});f.overrides.refinement=async()=>({issues:[]});
 f.overrides.readback=async()=>({complete:true,issues:++checks===1?[{id:'t',reason:'原图为奶茶，出现错字'}]:[]});
 f.overrides.recoverText=async(_ctx,task,ids)=>{repairs++;assert.deepEqual(ids,['t']);return {elements:task.elements.map(e=>e.id==='t'?{...e,text:'奶茶',contentVerified:true}:e),changed:['t'],unresolved:[]};};
 f.overrides.completeRefinement=async spec=>({elements:spec.elements.map(e=>({...e,fontAvailable:true,textFit:{text:e.text,fontPostScript:e.fontPostScript,fontSize:e.fontSize,tracking:0,originOffsetX:0,baselineOffset:1,advance:1}}))});
 const s=createLayeredImageService(f.h,f.overrides),a=await s.analyze({imageData:png,provider:'test',model:'current',reconstruction:'complete',autoRefine:true});await s.settled(a);
 await s.run({id:a.id,autoExportFormat:'psd'});const task=await s.settled(a);
 assert.equal(task.status,'ready',task.error);assert.equal(repairs,1);assert.equal(task.elements.find(e=>e.id==='t').nativeText,true);assert.equal(task.completeness.complete,true);assert.deepEqual(task.completeness.rasterText,[]);
 const psd=readPsd(await readFile(task.exports[0].path),{skipLayerImageData:true,skipCompositeImageData:true});assert.equal(psd.children.find(e=>e.name==='菜名').text.text,'奶茶');assert.equal(f.generated.length,1);
});

test('direct export cannot bypass the complete reconstruction audit with cached raster text',async t=>{
 const f=await fixture(t);f.overrides.analyze=async()=>({elements:[{id:'bg',type:'background',name:'背景'},
 {id:'t',type:'text',name:'菜名',text:'奶茶',x:0,y:0,width:2,height:2,nativeText:false}]});
 const s=createLayeredImageService(f.h,f.overrides),a=await s.analyze({imageData:png,provider:'test',model:'current'});await s.settled(a);
 await s.run({id:a.id,autoExportFormat:'psd'});let task=await s.settled(a);assert.equal(task.status,'ready');
 const file=join(task.outputDirectory,'task.json'),stored=JSON.parse(await readFile(file,'utf8'));stored.reconstruction='complete';delete stored.completeness;await writeFile(file,JSON.stringify(stored));
 const current=createLayeredImageService(f.h,f.overrides);await current.export({id:a.id,format:'psd'});task=await current.settled(a);
 assert.equal(task.status,'failed');assert.match(task.error,/完整拆分尚未通过/);assert.equal(task.completeness.complete,false);assert.deepEqual(task.completeness.rasterText,['t']);assert.equal(task.exports.length,1,'only the old partial export remains in history');
});

test('complete visual readback can add and render a genuinely missing text layer outside the original IR',async t=>{
 const f=await fixture(t);let checks=0;
 f.overrides.analyze=async()=>({analysisStrategy:'dense',elements:[{id:'bg',type:'background',name:'背景'}]});
 f.overrides.refinement=async()=>({issues:[]});
 f.overrides.readback=async()=>({complete:true,issues:++checks===1?[{id:'missing-new',kind:'missing-text',text:'奶茶',reason:'原图有文字而预览缺失',x:0,y:0,width:2,height:2}]:[]});
 f.overrides.recoverText=async(_ctx,task,ids)=>({elements:task.elements.map(e=>ids.includes(e.id)?{...e,text:'奶茶',contentVerified:true}:e),changed:ids,unresolved:[]});
 f.overrides.completeRefinement=async spec=>({elements:spec.elements.map(e=>({...e,fontAvailable:true,textFit:{text:e.text,fontPostScript:e.fontPostScript,fontSize:e.fontSize,tracking:0,originOffsetX:0,baselineOffset:1,advance:1}}))});
 const s=createLayeredImageService(f.h,f.overrides),a=await s.analyze({imageData:png,provider:'test',model:'current',reconstruction:'complete'});await s.settled(a);
 await s.run({id:a.id,autoExportFormat:'psd'});const task=await s.settled(a);
 assert.equal(task.status,'ready',task.error);assert.equal(task.completeness.editableText,1);assert.equal(task.elements.find(e=>e.id==='missing-new').nativeText,true);assert.equal(task.exports.length,1);
 const psd=readPsd(await readFile(task.exports[0].path),{skipLayerImageData:true,skipCompositeImageData:true});assert.ok(psd.children.some(e=>e.text?.text==='奶茶'));
});

test('source-grounded visual repairs update native copy and ink directly without another guessing round',async t=>{
 const f=await fixture(t);let reads=0;
 f.overrides.analyze=async()=>({elements:[{id:'bg',type:'background'},{id:'title',type:'text',name:'标题',text:'错误',nativeText:true,fontAccepted:true,fontPostScript:'AlibabaPuHuiTi_3_55_Regular',sourceTextColor:'#111111',x:0,y:0,width:4,height:4}]});
 f.overrides.recoverText=async()=>{throw Error('typed source evidence must not be sent to a second guessing call');};
 f.overrides.readback=async()=>({complete:true,issues:reads++===0?[{id:'title',sourceConfirmed:true,text:'改正',color:'#202020',x:0,y:0,width:3,height:3,reason:'原图真实文字及位置'}]:[]});
 f.overrides.completeRefinement=async spec=>({elements:spec.elements.map(e=>({...e,color:'#FFFFFF',fontAvailable:true,fontSize:8,textFit:{text:e.text,fontPostScript:e.fontPostScript,fontSize:8,tracking:0,baselineOffset:8,originOffsetX:0,advance:3}}))});
 const service=createLayeredImageService(f.h,f.overrides),created=await service.analyze({imageData:png,provider:'ds',model:'current',reconstruction:'complete',autoRun:true,autoExportFormat:'psd',maxImageRequests:1});
 // Real dense images use the same readback gate; keep this tiny fixture bounded.
 const file=join(created.outputDirectory,'task.json');await service.settled({id:created.id});
 const record=JSON.parse(await readFile(file,'utf8'));record.analysisStrategy='dense';record.assemblyCheck={verified:false};record.completeness=null;await writeFile(file,JSON.stringify(record));
 const restarted=createLayeredImageService(f.h,f.overrides);await restarted.run({id:created.id,maxImageRequests:1});const result=await restarted.settled({id:created.id});
 assert.equal(result.status,'ready',result.error);const row=result.elements.find(e=>e.id==='title');assert.equal(row.text,'改正');assert.equal(row.color,'#202020');assert.equal(row.nativeText,true);
});

test('a legacy rasterized shape rejected by the image service is recovered locally from its original vector plan',async t=>{
 const f=await fixture(t),present=await f.service.get(f.body),file=join(present.outputDirectory,'task.json'),record=JSON.parse(await readFile(file,'utf8'));record.reconstruction='complete';record.generationAttempts=1;
 const e=record.elements.find(e=>e.id==='object');Object.assign(e,{requestState:'unknown',status:'failed',error:'OpenAI Codex image request failed (HTTP 400): rejected',type:'image',sourceRegion:true,extractionMode:'photo'});
 await mkdir(join(present.outputDirectory,'analysis'),{recursive:true});await writeFile(join(present.outputDirectory,'analysis/image-regions.json'),JSON.stringify({result:{elements:[{id:e.id,type:'shape',name:'高亮块',x:1,y:1,width:2,height:2,fill:'#88CC00',radius:1,enabled:true}]}}));await writeFile(file,JSON.stringify(record));
 const restored=await createLayeredImageService(f.h,f.overrides).get(f.body),shape=restored.elements.find(e=>e.id==='object');assert.equal(shape.type,'shape');assert.equal(shape.requestState,'local');assert.equal(shape.extractionMode,undefined);assert.equal(restored.generationAttempts,1);assert.equal(f.generated.length,0);
 assert.equal(restored.recoveryEvents.at(-1).previousRequestState,'rejected');
});

test('split native text parts own distinct PNG files instead of overwriting the parent or each other',async t=>{
 const f=await fixture(t);let reads=0;
 f.overrides.analyze=async()=>({elements:[{id:'bg',type:'background'},{id:'title',type:'text',name:'合并价格',text:'1618',nativeText:true,fontAccepted:true,fontPostScript:'AlibabaPuHuiTi_3_55_Regular',x:0,y:0,width:4,height:2}]});
 f.overrides.readback=async()=>({complete:true,issues:reads++===0?[{id:'title',parts:[{text:'16',x:0,y:0,width:1,height:2},{text:'18',x:2,y:0,width:1,height:2}],reason:'两个独立价格'}]:[]});
 f.overrides.completeRefinement=async spec=>({elements:spec.elements.map(e=>({...e,fontAvailable:true,fontSize:1,textFit:{text:e.text,fontPostScript:e.fontPostScript,fontSize:1,tracking:0,baselineOffset:1,originOffsetX:0,advance:1}}))});
 const initial=createLayeredImageService(f.h,f.overrides),created=await initial.analyze({imageData:png,provider:'ds',model:'current',reconstruction:'complete',autoRun:true,maxImageRequests:1});await initial.settled({id:created.id});
 const file=join(created.outputDirectory,'task.json'),record=JSON.parse(await readFile(file,'utf8'));record.analysisStrategy='dense';record.assemblyCheck={verified:false};record.completeness=null;await writeFile(file,JSON.stringify(record));
 const service=createLayeredImageService(f.h,f.overrides);await service.run({id:created.id,maxImageRequests:1});await service.settled({id:created.id});const saved=JSON.parse(await readFile(file,'utf8')),parts=saved.elements.filter(e=>e.textGroupId==='title');
 assert.equal(parts.length,2);assert.equal(new Set(parts.map(e=>e.contentFile)).size,2);assert.ok(parts.every(e=>e.contentFile.includes(e.id+'-')));assert.ok(parts.every(e=>e.contentFile!==saved.elements.find(e=>e.id==='title').contentFile));
});

test('explicit practical delivery keeps a tiny failed decoration as an original group without claiming strict verification or buying images',async t=>{
 const f=await fixture(t);await f.service.run(f.body);const prior=await f.service.settled(f.body);
 const file=join(prior.outputDirectory,'task.json'),record=JSON.parse(await readFile(file,'utf8'));
 Object.assign(record,{width:100,height:100,reconstruction:'complete',analysisStrategy:'dense',assemblyCheck:{verified:false},completeness:null});
 Object.assign(record.elements.find(e=>e.id==='object'),{type:'shape',name:'微小装饰',x:1,y:1,width:2,height:2,fill:'#112233'});await writeFile(file,JSON.stringify(record));
 const base=f.overrides.pixel;f.overrides.pixel=async spec=>spec.operation==='shape-evidence'?{nativeEligible:false}:spec.operation==='graphic-cutout'?{eligible:false}:base(spec);
 f.overrides.readback=async()=>{throw Error('practical mode must not buy another whole-menu review');};
 const service=createLayeredImageService(f.h,f.overrides);await service.run({...f.body,completionPolicy:'practical',localOnly:true,autoExportFormat:'psd'});const result=await service.settled(f.body);
 assert.equal(result.status,'ready',result.error);assert.equal(f.generated.length,2,'existing background must be reused');
 assert.equal(result.completeness.practicalAccepted,true);assert.equal(result.completeness.complete,false);assert.equal(result.assemblyCheck.verified,false);
 const grouped=result.elements.find(e=>e.id==='object');assert.equal(grouped.sourceFallbackGroup,true);assert.equal(grouped.extractionMode,'photo');assert.equal(result.completeness.fallbackGroups[0].id,'object');
 const psd=readPsd(await readFile(result.exports[0].path),{skipLayerImageData:true,skipCompositeImageData:true});assert.equal(psd.children.length,2);
});
