import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCanvasAutomation } from '../../src/host/services/canvas-automation.js';
import { appendAutomationOutputs, mutateAutomationCanvas, patchAutomationCanvas, readAutomationCanvas } from '../../src/host/services/automation-canvas.js';

async function fixture(t, perform) {
  const root = await mkdtemp(join(tmpdir(), 'canvas-auto-'));
  const input = join(root, 'input'); await mkdir(input);
  await writeFile(join(input, '1.png'), 'original1'); await writeFile(join(input, '2.png'), 'original2');
  const h = { ctx: {}, stateWriteChains: new Map(), chatContexts: new Map([['sid', { cwd: root, project: join(root, 'source'), modelSelection: { provider: 'current-provider', model: 'current-model' } }]]), canvasAutomationContexts: new Map() };
  const options = { root: join(root, 'queue'), settings: async () => ({ engine: 'dsh-codex' }), perform: perform || (async (job, item) => {
    const path = join(job.project, 'assets', item.name); await writeFile(path, await readFile(item.path)); return [{ path, name: item.name, width: 40, height: 60, kind: 'image' }];
  }) };
  const service = createCanvasAutomation(h, options);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, input, h, options, service, body: { sessionId: 'sid', folder: input, operation: 'flat_psd' } };
}

test('folder plans exclude hidden/symlink files, freeze exact counts, reject truncation and create no projects', async t => {
  const f = await fixture(t); await mkdir(join(f.input, 'sub')); await writeFile(join(f.input, 'sub', '3.jpg'), 'third');
  await writeFile(join(f.input, '._4.png'), 'sidecar'); await writeFile(join(f.input, '.hidden.png'), 'hidden'); await symlink(join(f.input, '1.png'), join(f.input, 'link.png'));
  const before = await readdir(f.root);
  assert.equal((await f.service.plan(f.body)).count, 2);
  assert.equal((await f.service.plan({ ...f.body, recursive: true })).count, 3);
  await assert.rejects(f.service.plan({ ...f.body, maxFiles: 1 }), /上限/);
  assert.deepEqual(await readdir(f.root), before);
  await assert.rejects(f.service.plan({ ...f.body, folder: '', paths: [join(f.input, 'missing.png')] }), /没有可处理/);
});

test('extensionless image attachments are accepted by their real header without renaming the input',async t=>{
 const f=await fixture(t),path=join(f.input,'attachment-no-extension'),data=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6unwAAAAASUVORK5CYII=','base64');await writeFile(path,data);await writeFile(join(f.input,'notes-no-extension'),'not an image');
 const plan=await f.service.plan({...f.body,folder:'',paths:[path]});assert.equal(plan.count,1);assert.equal(plan.files[0].mime,'image/png');assert.equal(plan.files[0].path,path);assert.deepEqual(await readFile(path),data);
 assert.equal((await f.service.plan(f.body)).count,3);
});

test('batch isolates failures, preserves originals, resumes only failed files and emits one persistent project event', async t => {
  let fail = true; const calls = [];
  const f = await fixture(t, async (job, item) => {
    calls.push(item.name); if (item.name === '2.png' && fail) throw new Error('controlled bad image');
    const path = join(job.project, 'assets', item.name); await writeFile(path, 'result'); return [{ path, width: 80, height: 120 }];
  });
  const created = await f.service.submit(f.body); let job = await f.service.settled(created);
  assert.equal(job.status, 'partial'); assert.equal(job.completed, 1); assert.equal(job.failed, 1);
  assert.equal(await readFile(join(f.input, '1.png'), 'utf8'), 'original1');
  assert.equal((await readAutomationCanvas(job.project)).elements.length, 1);
  assert.equal((await f.service.events({ sessionId: 'other' })).length, 0);
  fail = false; await f.service.resume(created); job = await f.service.settled(created);
  assert.equal(job.status, 'completed'); assert.deepEqual(calls, ['1.png', '2.png', '2.png']);
  assert.equal((await readAutomationCanvas(job.project)).elements.length, 2);
  const [event] = await f.service.events({ sessionId: 'sid' }); assert.equal(event.project, job.project);
  await f.service.acknowledge({ id: job.id, revision: event.revision }); assert.equal((await f.service.events({ sessionId: 'sid' })).length, 0);
  const restarted = createCanvasAutomation(f.h, f.options); t.after(() => restarted.dispose());
  assert.equal((await restarted.get(created)).completed, 2);
  assert.equal((await restarted.list({ sessionId: 'sid' }))[0].items, undefined);
  assert.equal((await restarted.get(created)).model.model, 'current-model');
});

test('queued cancellation prevents execution; active cancellation stops following files and retains returned outputs', async t => {
  let entered; const start = new Promise(r => { entered = r; }); let calls = 0;
  const f = await fixture(t, async (_job, _item, signal) => {
    calls++; entered(); await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const a = await f.service.submit(f.body); await start;
  const b = await f.service.submit({ ...f.body, projectName: 'second job' }); await f.service.cancel(b); await f.service.cancel(a);
  assert.equal((await f.service.settled(a)).status, 'cancelled'); assert.equal((await f.service.settled(b)).status, 'cancelled'); assert.equal(calls, 1);
});

test('explicit item reprocess updates its existing canvas object without rerunning adjacent completed files', async t => {
  const calls=[];
  const f=await fixture(t,async(job,item)=>{
    calls.push(item.id); const path=join(job.project,'assets',item.id+'-'+calls.length+'.ai');await writeFile(path,'result');
    return [{path,kind:'ai',width:200,height:100}];
  });
  const created=await f.service.submit(f.body);let job=await f.service.settled(created);
  const before=await readAutomationCanvas(job.project),old=before.elements[0],neighbor=before.elements[1];
  await patchAutomationCanvas(f.h,job.project,[{id:old.id,x:420,y:300,width:640,height:320}],before.dshMeta.revision);
  await f.service.resume(created);assert.deepEqual(calls,['item-1','item-2']);
  await assert.rejects(f.service.resume({...created,reprocess:true,itemId:'missing'}),/不存在/);
  await f.service.resume({...created,reprocess:true,itemId:'item-1'});job=await f.service.settled(created);
  assert.equal(job.status,'completed');assert.deepEqual(calls,['item-1','item-2','item-1']);
  const after=await readAutomationCanvas(job.project),updated=after.elements.find(e=>e.id===old.id);
  assert.equal(after.elements.length,2);assert.equal(updated.x,420);assert.equal(updated.y,300);assert.equal(updated.width,640);assert.equal(updated.height,320);
  assert.notEqual(updated.fileId,old.fileId);assert.equal(after.files[old.fileId],undefined);
  assert.equal(updated.customData.dshSourcePath,job.items[0].outputs[0].path);assert.deepEqual(after.elements[1],neighbor);
  assert.equal(job.items[0].previousOutputs[0].path,old.customData.dshSourcePath);assert.equal(job.imageRequestsUsed,0);
});

test('restart marks submitted edits unknown, never resends without explicit retry and keeps request budget', async t => {
  const f = await fixture(t); const created = await f.service.submit(f.body); const done = await f.service.settled(created);
  const file = join(f.options.root, created.id + '.json'), record = JSON.parse(await readFile(file, 'utf8'));
  record.status = 'running'; record.operation = 'edit_image'; record.prompt = 'edit source'; record.imageRequestsUsed = 1; record.maxImageRequests = 1;
  record.items[1].status = 'running'; record.items[1].requestState = 'submitted'; record.items[1].imageRequestsUsed = 1;
  await writeFile(file, JSON.stringify(record));
  const restarted = createCanvasAutomation(f.h, f.options); t.after(() => restarted.dispose());
  const job = await restarted.get(created); assert.equal(job.status, 'interrupted'); assert.equal(job.items[1].requestState, 'unknown');
  await assert.rejects(restarted.resume({ id: created.id }), /retryUnknown/);
  await restarted.resume({ id: created.id, retryUnknown: true }); assert.equal((await restarted.settled(created)).status, 'completed');
  assert.equal((await restarted.get(created)).imageRequestsUsed, 1); assert.equal(done.project, job.project);
});

test('image generation hard cap applies across files; completed results are reused on explicit budget increase', async t => {
  const f = await fixture(t); delete f.options.perform;
  let count = 0;
  f.options.python = async (_script, spec) => ({ success: true, width: 20, height: 30 });
  f.options.generate = async () => { count++; return { bytes: Buffer.from('generated') }; };
  f.h.writeManagedSource = async (project, name, bytes) => { const path = join(project, 'assets', name); await writeFile(path, bytes); return { path, name, kind: 'image' }; };
  const s = createCanvasAutomation(f.h, f.options); t.after(() => s.dispose());
  const created = await s.submit({ ...f.body, operation: 'edit_image', prompt: 'change one label', allowGeneration: true, maxImageRequests: 1 });
  let job = await s.settled(created); assert.equal(job.status, 'partial'); assert.equal(count, 1); assert.equal(job.imageRequestsUsed, 1);
  await s.resume({ ...created, maxImageRequests: 2 }); job = await s.settled(created);
  assert.equal(job.status, 'completed'); assert.equal(count, 2); assert.equal(job.imageRequestsUsed, 2);
});

test('canvas writes serialize, preserve project metadata, deduplicate assets and reject stale/partial patches atomically', async t => {
  const f = await fixture(t), project = join(f.root, 'canvas'); await mkdir(project);
  await writeFile(join(project, 'project.json'), JSON.stringify({ version: 1, userMetadata: 'keep' }));
  const outputs = [{ path: join(project, 'assets/a.png'), width: 200, height: 100 }, { path: join(project, 'assets/b.png'), width: 40, height: 100 }];
  await Promise.all(outputs.map(output => appendAutomationOutputs(f.h, project, [output], 'job')));
  let scene = await readAutomationCanvas(project); assert.equal(scene.elements.length, 2); assert.equal(scene.elements[0].width / scene.elements[0].height, 2);
  assert.equal(JSON.parse(await readFile(join(project, 'project.json'))).userMetadata, 'keep');
  await appendAutomationOutputs(f.h, project, outputs, 'job'); scene = await readAutomationCanvas(project); assert.equal(scene.elements.length, 2);
  const before = JSON.stringify(scene), id = scene.elements[0].id;
  await assert.rejects(patchAutomationCanvas(f.h, project, [{ id, x: 99 }, { id: 'missing', x: 5 }], scene.dshMeta.revision), /不存在/);
  assert.equal(JSON.stringify(await readAutomationCanvas(project)), before);
  const changed = await patchAutomationCanvas(f.h, project, [{ id, x: 123 }], scene.dshMeta.revision);
  assert.equal(changed.elements[0].x, 123); assert.deepEqual(changed.elements[1], scene.elements[1]);
  await assert.rejects(patchAutomationCanvas(f.h, project, [{ id, x: 1 }], scene.dshMeta.revision), /已被修改/);
});

test('live selection and canvas commands use current object IDs and require save acknowledgement', async t => {
  const f = await fixture(t); const saved = await mutateAutomationCanvas(f.h, join(f.root, 'source'), () => {}); const revision = saved.dshMeta.revision;
  f.h.canvasAutomationContexts.set('sid', { project: join(f.root, 'source'), at: Date.now(), selectedIds: ['live'], revision,
    elements: [{ id: 'live', type: 'image', path: join(f.input, '1.png'), x: 4, y: 5, width: 40, height: 60 }] });
  const scene = await f.service.inspect({ sessionId: 'sid' }); assert.equal(scene.revision, revision); assert.equal(scene.elements[0].selected, true);
  assert.equal((await f.service.plan({ sessionId: 'sid', operation: 'flat_psd', elementIds: ['live'] })).count, 1);
  await assert.rejects(f.service.arrange({ sessionId: 'sid', patches: [{ id: 'live', x: 1 }] }), /baseRevision/);
  const result = f.service.arrange({ sessionId: 'sid', baseRevision: revision, patches: [{ id: 'live', x: 10 }] });
  let event; for (let i = 0; i < 30 && !event; i++) { event = (await f.service.events({ sessionId: 'sid' })).find(e => e.kind === 'patch'); await new Promise(r => setTimeout(r, 1)); }
  assert.equal(event.patches[0].id, 'live'); assert.equal(event.baseRevision, revision);
  await f.service.completeCanvasCommand({ id: event.id, sessionId: 'sid', error: 'stale scene' });
  await assert.rejects(result, /stale scene/);
  f.h.canvasAutomationContexts.get('sid').elements = [];
  assert.equal((await f.service.inspect({ sessionId: 'sid' })).elements.length, 0);
  await mutateAutomationCanvas(f.h, join(f.root, 'source'), s => { s.elements = [{ id: 'new', type: 'image', x: 98, y: 80, width: 40, height: 60 }]; });
  const latest = await f.service.inspect({ sessionId: 'sid' }); assert.equal(latest.elements[0].x, 98); assert.ok(latest.revision > revision);
});

test('official chat tool maps structured folder/object actions and respects cancellation without executing', async () => {
  const source = await readFile(new URL('../../src/host/services/canvas-automation-tool.js', import.meta.url), 'utf8');
  const { automationToolSpec, installCanvasAutomationTool } = await import('data:text/javascript;base64,' + Buffer.from(source.replace("import { defineTool } from '@deepseek-ai/dsh-tools';", 'const defineTool = value => value;')).toString('base64'));
  let received; const service = { submit: async body => { received = body; return { id: 'job', finishedAt: undefined }; } };
  const ctx = { tools: { get: () => null, register: tool => { assert.equal(tool.name, 'canvas_workbench'); return () => {}; } }, effect: fn => fn() };
  assert.equal(installCanvasAutomationTool(ctx, service, () => ({})), true);
  const spec = automationToolSpec(service, () => ({ project: '/current', cwd: '/work' }));
  const exec = { signal: new AbortController().signal, agent: { session: { id: 'sid' } } };
  const value = await spec.execute({ action: 'submit', operation: 'flat_psd', folder: '/images', max_files: 5 }, exec);
  assert.deepEqual(value, { ok: true, action: 'submit', id: 'job' }); assert.equal(received.sessionId, 'sid'); assert.equal(received.maxFiles, 5); assert.equal(received.project, '/current');
  const aborted = new AbortController(); aborted.abort(); received = null;
  await assert.rejects(spec.execute({ action: 'submit' }, { ...exec, signal: aborted.signal })); assert.equal(received, null);
});

test('duplicate and concurrent submissions return the same durable job, explicit identifiers reject parameter drift', async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.service.submit(f.body), f.service.submit(f.body)]);
  assert.equal(a.id, b.id); await f.service.settled(a);
  const c = await f.service.submit({ ...f.body, requestId: 'stable-request', projectName: 'specific' }); await f.service.settled(c);
  assert.equal((await f.service.submit({ ...f.body, requestId: 'stable-request', projectName: 'specific' })).id, c.id);
  await assert.rejects(f.service.submit({ ...f.body, requestId: 'stable-request', projectName: 'changed' }), /另一组参数/);
});

test('AI export retry reuses completed layers and PSD; review opens the actual child task with the batch budget', async t => {
  const f = await fixture(t); delete f.options.perform;
  f.options.python = async () => ({ success: true, width: 40, height: 60 });
  let task, runs = 0, failAI = true; const exports = [];
  f.h.layeredImage = {
    analyze: async () => { task = { id: 'child', status: 'review', width: 40, height: 60, generationAttempts: 0, elements: [{ enabled: true, status: 'pending' }], quality: { status: 'passed' }, exports: [] }; return task; },
    get: async () => task, settled: async () => task,
    run: async () => { runs++; task.elements[0].status = 'complete'; task.status = 'ready'; },
    export: async ({ format }) => {
      exports.push(format);
      if (format === 'ai' && failAI) { task.status = 'failed'; task.error = 'controlled editor failure'; return; }
      task.status = 'ready'; task.error = ''; const path = join(f.root, 'result.' + format); await writeFile(path, 'result'); task.exports.push({ path, kind: format });
    }
  };
  const s = createCanvasAutomation(f.h, f.options); t.after(() => s.dispose());
  const created = await s.submit({ ...f.body, folder: '', paths: [join(f.input, '1.png')], operation: 'layered_export', formats: ['psd', 'ai'] });
  assert.equal((await s.settled(created)).status, 'failed');
  const review = await s.review({ id: created.id }); assert.equal(review.task.id, 'child');
  const event = (await s.events({ sessionId: 'sid' })).find(e => e.kind === 'review'); assert.equal(event.taskId, 'child'); assert.equal(event.generationAllowed, false); assert.equal(event.maxImageRequests, 0);
  failAI = false; await s.resume({ id: created.id }); assert.equal((await s.settled(created)).status, 'completed');
  assert.equal(runs, 1); assert.deepEqual(exports, ['psd', 'ai', 'ai']);
});

test('background API resumes full validation even when all PNG assets were already extracted',async t=>{
 const f=await fixture(t);delete f.options.perform;f.options.python=async()=>({success:true,width:40,height:60});let validated=false,runs=0;
 const child={id:'child',reconstruction:'complete',status:'cancelled',width:40,height:60,generationAttempts:0,elements:[{enabled:true,status:'complete'}],quality:{issues:[]},exports:[]};
 f.h.layeredImage={analyze:async()=>child,get:async()=>child,settled:async()=>child,
 run:async()=>{runs++;validated=true;Object.assign(child,{status:'ready',textTruthVersion:3,completeness:{complete:true},assemblyCheck:{verified:true}});},
 export:async({format})=>{assert.equal(validated,true,'export waits for source-text/assembly validation');const path=join(f.root,'validated.'+format);await writeFile(path,'validated');child.exports.push({path,kind:format});}};
 const service=createCanvasAutomation(f.h,f.options);t.after(()=>service.dispose());const job=await service.submit({...f.body,folder:'',paths:[join(f.input,'1.png')],operation:'layered_export',formats:['ai','psd'],reconstruction:'complete'});
 const result=await service.settled(job);assert.equal(result.status,'completed');assert.equal(runs,1);assert.equal(result.items[0].outputs.length,2);
});
