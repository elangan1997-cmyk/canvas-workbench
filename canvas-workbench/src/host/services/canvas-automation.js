import { createHash, randomBytes } from 'node:crypto';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { generateImage, readImageEngineSettings } from '../../../lib/image-engine.js';
import { resolvePythonWithDeps } from '../../../lib/platform.js';
import { dshCodexImageModel } from '../../providers/image/dsh-codex.provider.js';
import { expandHome } from '../../shared/utils/paths.js';
import { isRasterImagePath, MAX_IMAGE_BYTES, mimeOf, sniffImageMime, extOf } from '../../shared/utils/image-types.js';
import { PLUGIN_ROOT } from '../vendor-assets.js';
import { runPythonSpec } from './python-launch.js';
import { appendAutomationOutputs, mutateAutomationCanvas, patchAutomationCanvas, readAutomationCanvas, summarizeAutomationCanvas } from './automation-canvas.js';
import { hasBlockingLayerQuality } from './layered-image-refinement.js';

const OPERATIONS = new Set(['layered_export', 'flat_psd', 'remove_background', 'edit_image']);
const TERMINAL = new Set(['completed', 'partial', 'failed', 'cancelled', 'interrupted', 'needs_review']);
const validId = value => /^auto-[a-z0-9]+-[a-f0-9]{12}$/.test(String(value || ''));
const message = error => String(error?.message || error).slice(0, 1200);
const cleanName = value => String(value || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/^\.+|[. ]+$/g, '').slice(0, 80) || '图片批处理';
const absolute = value => { const p = expandHome(String(value || '').trim()); if (!p || !isAbsolute(p)) throw new Error('请使用绝对文件夹或文件路径'); return resolve(p); };
const budgetError = text => Object.assign(new Error(text), { code: 'NEEDS_REVIEW' });
const delay = ms => new Promise(r => setTimeout(r, ms));
const rasterMime=async path=>{
  if(isRasterImagePath(path))return mimeOf(path);
  if(extOf(path))return null;
  const file=await open(path,'r');try{const header=Buffer.alloc(32);const {bytesRead}=await file.read(header,0,32,0);return sniffImageMime(header.subarray(0,bytesRead));}finally{await file.close();}
};

/** Durable serial jobs; published jobs outlive the chat turn, never a host shutdown. */
export function createCanvasAutomation(h, overrides = {}) {
  const root = overrides.root || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'canvas-workbench', 'automation-jobs');
  const records = new Map(), workers = new Map(), saves = new Map(), queue = [], sceneCommands = new Map();
  let pumping = false, disposed = false, submissionChain = Promise.resolve();
  const fileFor = id => { if (!validId(id)) throw new Error('批处理任务编号无效'); return join(root, id + '.json'); };
  const save = job => {
    job.updatedAt = Date.now();
    const snapshot = JSON.stringify(job, null, 2), file = fileFor(job.id);
    const pending = (saves.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(root, { recursive: true }); await writeFile(file + '.tmp', snapshot, 'utf8'); await rename(file + '.tmp', file);
    });
    saves.set(file, pending); return pending;
  };
  const initialized = (async () => {
    await mkdir(root, { recursive: true });
    for (const name of (await readdir(root)).filter(n => n.endsWith('.json') && validId(n.slice(0, -5))).sort().slice(-1000)) {
      try {
        const job = JSON.parse(await readFile(join(root, name), 'utf8'));
        if (job.id + '.json' !== name || !isAbsolute(job.project) || !Array.isArray(job.items)) continue;
        if (['queued', 'running', 'cancelling'].includes(job.status)) {
          job.status = 'interrupted'; job.message = '应用关闭前尚未完成，已保留结果；请继续任务，未知生成请求不会自动重复';
          for (const item of job.items) if (item.status === 'running') { item.status = 'interrupted'; if (item.requestState === 'submitted') item.requestState = 'unknown'; }
          await save(job);
        }
        records.set(job.id, job);
      } catch { /* An incomplete record must not hide the rest of the queue. */ }
    }
  })();
  initialized.catch(() => {});
  const load = async id => { await initialized; fileFor(id); const job = records.get(id); if (!job) throw new Error('批处理任务不存在'); return job; };
  const present = job => ({ id: job.id, operation: job.operation, status: job.status, message: job.message || '', project: job.project,
    sessionId: job.sessionId, createdAt: job.createdAt, updatedAt: job.updatedAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
    model: job.model, imageEngine: job.imageSettings.engine, imageModel: job.imageSettings.engine === 'dsh-codex' ? job.imageSettings.dshCodexModel : job.imageSettings.apiModel,
    allowGeneration: job.allowGeneration, maxImageRequests: job.maxImageRequests, imageRequestsUsed: job.imageRequestsUsed || 0,
    reconstruction:job.reconstruction||'preserve',enhanceSource:job.enhanceSource===true,
    completed: job.items.filter(i => i.status === 'completed').length, total: job.items.length,
    needsReview: job.items.filter(i => i.status === 'needs_review').length, failed: job.items.filter(i => i.status === 'failed').length,
    progress: Math.round(job.items.filter(i => ['completed', 'failed', 'needs_review'].includes(i.status)).length / Math.max(1, job.items.length) * 100),
    items: job.items.map(({ sourceCopy, raw, ...i }) => ({ ...i })), presentation: job.presentation || null });
  const python = async (script, spec, signal) => {
    signal?.throwIfAborted();
    if (overrides.python) return overrides.python(script, spec, signal);
    const py = await resolvePythonWithDeps(h.ctx);
    const run = await runPythonSpec((exe, args, cwd, timeout) => h.runProcessWithTimeout(exe, args, cwd, timeout), py,
      join(PLUGIN_ROOT, 'scripts', script), spec, { cwd: PLUGIN_ROOT, timeoutMs: 600000 });
    signal?.throwIfAborted();
    let value; try { value = JSON.parse(String(run.stdout || '').trim()); } catch { throw new Error(script + ' 没有返回有效结果'); }
    if (run.exitCode !== 0 || value.success !== true) throw new Error(value.error || run.stderr || script + ' 执行失败');
    return value;
  };
  const contextFor = body => ({ cwd: body.cwd || '', ...(h.chatContexts.get(String(body.sessionId || '')) || {}) });
  const inspect = async body => {
    const current = contextFor(body), project = absolute(body.project || current.project);
    const scene = await readAutomationCanvas(project);
    const summary = summarizeAutomationCanvas(scene);
    const live = h.canvasAutomationContexts?.get(String(body.sessionId || ''));
    if (live && live.project === project && Date.now() - live.at < 10000) {
      const selected = new Set(live.selectedIds || []);
      if (Array.isArray(live.elements) && Number(live.revision) >= summary.revision) { summary.elements = live.elements.map(e => ({ ...e })); summary.revision = live.revision; }
      for (const e of summary.elements) e.selected = selected.has(e.id);
    }
    return { project, ...summary, model: current.modelSelection || null };
  };
  const collect = async body => {
    const limit = body.maxFiles === undefined ? 100 : Number(body.maxFiles);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('批次图片数量上限应为1至500');
    if (body.folder && body.paths?.length) throw new Error('请选择文件夹或文件清单中的一种输入方式');
    let paths = [], sourceProject = '', targets = [];
    const ignored = [];
    if (body.folder) {
      const directory = absolute(body.folder); if (!(await lstat(directory)).isDirectory()) throw new Error('输入文件夹不存在');
      const scan = async (dir, depth) => {
        if (depth > 12) throw new Error('目录层级超过12层，请缩小范围');
        for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))) {
          if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
          const p = join(dir, e.name);
          if (e.isDirectory() && body.recursive === true) await scan(p, depth + 1);
          else if (e.isFile() && await rasterMime(p)) { paths.push(p); if (paths.length > limit) throw new Error('图片超过本批上限' + limit + '张，请缩小文件夹或明确提高maxFiles'); }
        }
      }; await scan(directory, 0);
    } else if (Array.isArray(body.paths) && body.paths.length) paths = body.paths.map(absolute);
    else {
      const scene = await inspect({ ...body, project: body.sourceProject || body.project }); sourceProject = scene.project;
      const ids = new Set(Array.isArray(body.elementIds) ? body.elementIds : []);
      targets = scene.elements.filter(e => e.type === 'image' && (ids.size ? ids.has(e.id) : body.selectedOnly === false || e.selected));
      if (ids.size && targets.length !== ids.size) throw new Error('部分指定对象不存在或不是图片，请先重新读取画布');
      if (!targets.length) throw new Error('请指定图片文件夹、文件路径，或在画布中选中图片');
      paths = targets.map(e => e.path);
    }
    paths = [...new Set(paths)]; if (paths.length > limit) throw new Error('图片数量超过本批上限');
    const files = [];
    for (const p of paths) {
      try {
        const info = await lstat(p);
        if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) throw new Error('文件为空、不可读或超过32MB');
        const mime=await rasterMime(p);if(!mime)throw new Error('仅支持PNG/JPG/WebP/GIF/AVIF/BMP栅格图片，无扩展名附件按真实文件头识别');
        files.push({ path: p, name: basename(p),mime, size: info.size, mtime: info.mtimeMs, elementId: targets.find(e => e.path === p)?.id || '' });
      } catch (error) { ignored.push({ path: p, reason: message(error) }); }
    }
    if (!files.length) throw new Error('没有可处理的图片' + (ignored.length ? '：' + ignored[0].reason : ''));
    return { files, ignored, sourceProject };
  };
  const options = body => {
    if (!OPERATIONS.has(body.operation)) throw new Error('请选择拆层导出、普通PSD转换、抠图或图片编辑');
    const formats = [...new Set(Array.isArray(body.formats) ? body.formats : ['psd'])];
    if (!formats.length || formats.some(f => !['psd', 'ai', 'svg'].includes(f))) throw new Error('导出格式应为PSD、AI或SVG');
    const max = body.maxImageRequests === undefined ? 0 : Number(body.maxImageRequests);
    if (!Number.isInteger(max) || max < 0 || max > 10000) throw new Error('图像请求上限应为0至10000的整数');
    if (body.operation === 'edit_image' && (!String(body.prompt || '').trim() || String(body.prompt).length > 12000)) throw new Error('图片编辑需要明确的修改要求（不超过12000字）');
    if (body.region) for (const k of ['x', 'y', 'width', 'height']) if (!Number.isFinite(body.region[k]) || body.region[k] < (k === 'width' || k === 'height' ? 1 : 0)) throw new Error('局部选区坐标无效，请使用原图像素');
    return { formats, maxImageRequests: max, allowGeneration: body.allowGeneration === true };
  };
  const plan = async body => {
    const selected = options(body), inputs = await collect(body);
    return { operation: body.operation, ...inputs, formats: selected.formats, allowGeneration: selected.allowGeneration,
      maxImageRequests: selected.maxImageRequests, count: inputs.files.length,
      notice: body.operation === 'flat_psd' ? '普通PSD转换只封装原图，不拆层、不生成可编辑文字' : body.operation === 'remove_background' ? '本地抠图，不调用图像生成' : '拆层中的原图提取与文字校准优先本地完成；需重建时受明确图像请求上限限制' };
  };
  const reserveImage = async (job, item) => {
    if (!job.allowGeneration || (job.imageRequestsUsed || 0) >= job.maxImageRequests) throw budgetError('本批图像生成未开启或已达到请求上限，成功素材已保留');
    job.imageRequestsUsed = (job.imageRequestsUsed || 0) + 1; item.imageRequestsUsed = (item.imageRequestsUsed || 0) + 1; item.requestState = 'submitted'; await save(job);
  };
  const waitLayer = async (service, request, signal) => {
    signal.throwIfAborted();
    const abort = () => { service.cancel(request).catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try { const task = await service.settled(request); signal.throwIfAborted(); return task; }
    finally { signal.removeEventListener('abort', abort); }
  };
  const reconcileRequests = async job => {
    let total = 0;
    for (const item of job.items) {
      total += Number(item.imageRequestsUsed || 0);
      if (item.layeredTaskId && h.layeredImage) {
        const task = await h.layeredImage.get({ project: job.project, id: item.layeredTaskId });
        total += Number(task.generationAttempts || 0);
        item.requestState = (task.elements.some(e => ['submitted', 'unknown'].includes(e.requestState))||['submitted','unknown'].includes(task.sourceHd?.requestState)||Object.values(task.sourceHd?.tiles||{}).some(s=>['submitted','unknown'].includes(s))) ? 'unknown' : 'returned';
      }
    }
    // The persisted item/child journals are authoritative and include pending
    // network calls. A local preflight rejection may legitimately correct an
    // old overcount; keeping the previous maximum would charge it forever.
    job.imageRequestsUsed = total;
  };
  const perform = async (job, item, signal) => {
    if (overrides.perform) return overrides.perform(job, item, signal);
    const work = join(job.project, 'outputs', '批处理过程', job.id, item.id); await mkdir(work, { recursive: true });
    if (!item.sourceCopy) {
      const bytes = await readFile(item.path); if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new Error('输入文件已变更或超过32MB');
      item.sourceCopy = join(work, 'source' + (/\.[a-z0-9]+$/i.exec(item.name)?.[0] || (item.mime==='image/jpeg'?'.jpg':'.'+String(item.mime||'image/png').split('/')[1])));
      try { await writeFile(item.sourceCopy, bytes, { flag: 'wx' }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      item.sourceHash = createHash('sha256').update(await readFile(item.sourceCopy)).digest('hex'); await save(job);
    }
    const dimensions = await python('automation_image.py', { operation: 'inspect', input: item.sourceCopy }, signal);
    if (['layered_export', 'flat_psd'].includes(job.operation)) {
      const service = h.layeredImage;
      if(!item.layeredTaskId && item.previousLayeredTasks?.length){
        const candidate=item.previousLayeredTasks[item.previousLayeredTasks.length-1];
        try{await service.get({project:job.project,id:candidate});item.layeredTaskId=candidate;await save(job);}catch{}
      }
      if (!item.layeredTaskId) {
        if(item.hdSource&&item.hdReferenceHash!==item.sourceHash)throw new Error('高清前置任务与当前原图不一致，未采用旧高清素材');
        const sourceData='data:'+(mimeOf(item.sourceCopy)||'image/png')+';base64,'+(await readFile(item.sourceCopy)).toString('base64');
        const task = await service.analyze({ project: job.project, imageData: item.hdSource?'data:image/png;base64,'+(await readFile(item.hdSource)).toString('base64'):sourceData,
          ...(item.hdSource?{referenceImageData:sourceData}:{}),
          name: item.name, ...job.model, flat: job.operation === 'flat_psd', autoRefine: true, editableText: job.editableText, fontPolicy: job.fontPolicy,localOnly:!job.allowGeneration,
          reconstruction:job.reconstruction,enhanceSource:job.enhanceSource,maxImageRequests:Math.max(0,job.maxImageRequests-(job.imageRequestsUsed||0)) });
        item.layeredTaskId = task.id; await save(job);
      }
      const request = { project: job.project, id: item.layeredTaskId };
      let task = await waitLayer(service, request, signal);
      if (['failed','cancelled'].includes(task.status) && !task.elements.length) {
        // Keep ownership of the analysis and all completed tile checkpoints.
        // Resume the same child instead of starting a full duplicate analysis.
        if(item.analysisResumeRevision===job.runRevision)throw new Error(task.error||'图层分析失败，已保存完成的分区');
        item.analysisResumeRevision=job.runRevision;await save(job);
        await service.run({...request,localOnly:!job.allowGeneration,maxImageRequests:Math.max(0,job.maxImageRequests-(job.imageRequestsUsed||0)),engine:job.imageSettings.engine,imageSettingsOverride:job.imageSettings});
        task=await waitLayer(service,request,signal);
        if(task.status==='failed'&&!task.elements.length)throw new Error(task.error||'图层分析失败，已保存完成的分区，可继续原任务');
      }
      await reconcileRequests(job); await save(job);
      if (hasBlockingLayerQuality(task.quality)) throw budgetError(task.message || '图层结构数据无效，需要重新分析');
      if (task.elements.some(e => e.requestState === 'unknown') && !job.retryUnknown) throw budgetError('有图像请求结果未知，未自动重发；请核对后再继续');
      const attemptsBefore = task.generationAttempts || 0;
      const needsCompleteValidation=task.reconstruction==='complete'&&(task.textTruthVersion!==4||task.materialGeometryTruth!==1||task.completeness?.complete!==true||task.assemblyCheck?.verified!==true);
      if (!task.elements.every(e => !e.enabled || e.status === 'complete') || task.status === 'needs_review'||needsCompleteValidation) {
        await service.run({ ...request, engine: job.imageSettings.engine, imageSettingsOverride: job.imageSettings,
          localOnly: !job.allowGeneration, retryUnknown: job.retryUnknown, maxImageRequests: attemptsBefore + Math.max(0, job.maxImageRequests - (job.imageRequestsUsed || 0)) });
        try { task = await waitLayer(service, request, signal); }
        finally { await reconcileRequests(job); await save(job); }
      }
      await reconcileRequests(job); await save(job);
      item.warnings = task.warnings || []; item.quality = task.quality || null;
      if(task.reconstruction==='complete'&&(task.status==='failed'||task.completeness?.complete!==true||task.assemblyCheck?.verified!==true))throw budgetError(task.error||task.message||'完整拆分未通过装配核验，不能仅凭PNG已提取就导出');
      if (!task.elements.every(e => !e.enabled || e.status === 'complete') || task.status === 'needs_review') throw budgetError(task.error || task.message || '图层提取尚未完成');
      const outputs = [...(item.outputs || [])];
      for (const format of job.operation === 'flat_psd' ? ['psd'] : job.formats) {
        if (outputs.some(e => e.kind === format)) continue;
        const existing = [...(task.exports || [])].reverse().find(e => e.kind === format);
        if (existing) { outputs.push({ ...existing, width: task.width, height: task.height }); continue; }
        await service.export({ ...request, format, openAfterExport: false }); task = await waitLayer(service, request, signal);
        if (task.status !== 'ready') throw new Error(task.error || '文件导出失败');
        const file = [...task.exports].reverse().find(e => e.kind === format); if (!file) throw new Error('导出没有返回文件');
        outputs.push({ ...file, width: task.width, height: task.height }); item.outputs = outputs; await save(job);
      }
      return outputs;
    }
    let output = join(work, 'result.png');
    if (job.operation === 'remove_background') {
      const result = await python('remove_background.py', { input: item.sourceCopy, output, model: 'birefnet-general-lite' }, signal);
      item.warnings = result.warning ? [String(result.warning)] : [];
    } else {
      if (item.requestState === 'unknown' && !job.retryUnknown) throw budgetError('上次图像请求结果未知，未自动重发');
      let input = item.sourceCopy;
      if (job.region) { input = join(work, 'region.png'); await python('automation_image.py', { operation: 'crop', input: item.sourceCopy, region: job.region, output: input }, signal); }
      const raw = join(work, 'generated.original');
      let returned = false; try { await stat(raw); returned = true; } catch {}
      if (!returned) {
        await reserveImage(job, item);
        try {
          const result = await (overrides.generate || generateImage)({ ctx: h.ctx, image: await readFile(input), prompt: job.prompt,
            engine: job.imageSettings.engine, settingsOverride: job.imageSettings, maxAttempts: 1, signal });
          await writeFile(raw, result.bytes, { flag: 'wx' }); item.requestState = 'returned'; await save(job);
        } catch (error) { item.requestState = 'unknown'; await save(job); throw error; }
      }
      if (job.region) await python('automation_image.py', { operation: 'composite', input: item.sourceCopy, edited: raw, region: job.region, output }, signal);
      else { output = raw; }
    }
    const verified = await python('automation_image.py', { operation: 'inspect', input: output }, signal);
    if (job.operation === 'remove_background' && (!verified.foregroundBounds || verified.alphaMax === 0 || verified.alphaMin === 255)) throw budgetError('抠图结果为空或未产生透明背景，原图及结果已保留，请核对主体与本地模型');
    if (!job.region && job.operation === 'edit_image' && Math.abs(verified.width / verified.height - dimensions.width / dimensions.height) / (dimensions.width / dimensions.height) > .1) throw budgetError('编辑结果比例改变，未自动加入画布，请核对任务中的原始结果');
    const name = item.name.replace(/\.[^.]+$/, '') + (job.operation === 'remove_background' ? '-抠图.png' : '-编辑.png');
    const published = await h.writeManagedSource(job.project, name, await readFile(output), 'image');
    return [{ ...published, width: verified.width, height: verified.height }];
  };
  const publish = async job => {
    const outputs = job.items.flatMap(i => i.outputs || []);
    if (outputs.length) await appendAutomationOutputs(h, job.project, outputs, job.id);
    job.presentation = { revision: Date.now(), pending: job.openCanvas && outputs.length > 0, project: job.project };
    await save(job);
  };
  const pump = async () => {
    if (pumping || disposed) return; pumping = true;
    try {
      while (queue.length && !disposed) {
        const id = queue.shift(), job = records.get(id); if (!job || job.status !== 'queued') continue;
        const controller = new AbortController();
        const entry = { controller, promise: null }; workers.set(id, entry);
        entry.promise = (async () => {
          job.status = 'running'; job.runRevision=(job.runRevision||0)+1;job.startedAt ||= Date.now(); await save(job);
          try {
            for (const item of job.items) {
              controller.signal.throwIfAborted(); if (item.status === 'completed') continue;
              item.status = 'running'; item.error = ''; job.message = '正在处理 ' + (job.items.indexOf(item) + 1) + '/' + job.items.length + '：' + item.name; await save(job);
              try {
                item.outputs = (await perform(job, item, controller.signal)).map(output=>{
                  const previous=[...(item.previousOutputs||[])].reverse().find(p=>(p.kind||'image')===(output.kind||'image'));
                  return {...output,sourceItemId:item.id,...(previous&&previous.path!==output.path?{replacePath:previous.path}:{})};
                }); controller.signal.throwIfAborted();
                item.status = 'completed'; await appendAutomationOutputs(h, job.project, item.outputs, job.id);
              } catch (error) {
                if (controller.signal.aborted) { item.status = 'cancelled'; throw error; }
                item.status = error.code === 'NEEDS_REVIEW' || /结果未知|请求上限|尚未完成|无法在本地|核对/.test(message(error)) ? 'needs_review' : 'failed';
                item.error = message(error);
              }
              await reconcileRequests(job);await save(job);
            }
            const done = job.items.filter(i => i.status === 'completed').length;
            job.status = done === job.items.length ? 'completed' : done ? 'partial' : job.items.some(i => i.status === 'needs_review') ? 'needs_review' : 'failed';
            job.message = '已完成 ' + done + '/' + job.items.length + ' 张；' + (job.items.length - done) + ' 张需核对或重试';
          } catch (error) { job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.message = controller.signal.aborted ? '任务已停止，成功结果及素材已保留' : message(error); }
          finally { await reconcileRequests(job);job.finishedAt = Date.now(); await publish(job); workers.delete(id); }
        })();
        try { await entry.promise; } catch (error) { job.status = 'failed'; job.message = message(error); await save(job).catch(() => {}); workers.delete(id); }
      }
    } finally { pumping = false; }
  };
  const enqueue = job => { if (!queue.includes(job.id)) queue.push(job.id); void pump(); };
  return {
    inspect, plan,
    async submit(body) {
      const work = async () => {
      await initialized; if (disposed) throw new Error('后台服务正在关闭');
      const preview = await plan(body), current = contextFor(body);
      let preprocessing=null;
      if(body.preprocessingJobId){
        preprocessing=await load(body.preprocessingJobId);
        if(preprocessing.status!=='completed'||preprocessing.operation!=='edit_image')throw new Error('高清前置任务尚未完成或类型不符');
        for(const file of preview.files){const prior=preprocessing.items.find(i=>i.path===file.path&&i.outputs?.some(o=>o.kind==='image'));
          if(!prior||prior.sourceHash!==createHash('sha256').update(await readFile(file.path)).digest('hex'))throw new Error('高清前置任务没有匹配的原图：'+file.name);
        }
      }
      const model = { ...(body.provider && body.model ? { provider: body.provider, model: body.model, reasoningEffort: body.reasoningEffort } : current.modelSelection || {}) };
      if (body.operation === 'layered_export' && (!model.provider || !model.model)) throw new Error('尚未取得当前聊天模型，请在聊天区选择模型后重试');
      const settings = await (overrides.settings || readImageEngineSettings)();
      const imageSettings = { engine: settings.engine, apiBaseUrl: settings.apiBaseUrl, apiModel: settings.apiModel, dshCodexModel: dshCodexImageModel(h.ctx) };
      const requestId = String(body.requestId || '').slice(0, 120);
      const fingerprint = createHash('sha256').update(JSON.stringify({ sessionId: body.sessionId || '', operation: body.operation,
        files: preview.files, formats: preview.formats, model, imageSettings, editableText: body.editableText !== false, fontPolicy: body.fontPolicy || 'substitute',reconstruction:body.reconstruction||'preserve',enhanceSource:body.enhanceSource===true,
        prompt: body.prompt || '', region: body.region || null, allowGeneration: preview.allowGeneration, maxImageRequests: preview.maxImageRequests,
        outputParent: body.outputParent || current.cwd, outputProject: body.outputProject || '', projectName: body.projectName || '', openCanvas: body.openCanvas !== false,preprocessingJobId:body.preprocessingJobId||'' })).digest('hex');
      const duplicate = [...records.values()].find(j => j.sessionId === String(body.sessionId || '') && (requestId ? j.requestId === requestId : j.fingerprint === fingerprint && Date.now() - j.createdAt < 30000));
      if (duplicate) {
        if (requestId && duplicate.fingerprint !== fingerprint) throw new Error('该request_id已用于另一组参数，请使用原参数取回任务或换一个编号');
        return present(duplicate);
      }
      const id = 'auto-' + Date.now().toString(36) + '-' + randomBytes(6).toString('hex');
      const parent = absolute(body.outputParent || current.cwd || (body.folder ? dirname(absolute(body.folder)) : dirname(preview.files[0].path)));
      const project = body.outputProject ? absolute(body.outputProject) : join(parent, cleanName(body.projectName || '图片批处理') + '-' + id.slice(5));
      if (body.outputProject && [...(h.canvasAutomationContexts?.values() || [])].some(c => c.project === project && Date.now() - c.at < 10000)) throw new Error('该输出项目正在编辑，请使用自动创建的新项目，避免覆盖尚未保存的操作');
      if (!body.outputProject) await mkdir(project, { recursive: false });
      else if (!(await stat(project)).isDirectory()) throw new Error('指定的输出项目不存在');
      await mutateAutomationCanvas(h, project, () => {});
      const job = { schema: 1, id, requestId, fingerprint, operation: body.operation, sessionId: String(body.sessionId || ''), cwd: current.cwd || parent, project, model,
        imageSettings, formats: preview.formats, allowGeneration: preview.allowGeneration, maxImageRequests: preview.maxImageRequests, imageRequestsUsed: 0,
        editableText: body.editableText !== false, fontPolicy: body.fontPolicy === 'strict' ? 'strict' : 'substitute',reconstruction:body.reconstruction==='complete'?'complete':'preserve',enhanceSource:body.enhanceSource===true,
        prompt: String(body.prompt || ''), region: body.region || null, retryUnknown: false, openCanvas: body.openCanvas !== false,
        createdAt: Date.now(), updatedAt: Date.now(), status: 'queued', message: '已加入后台队列', ignored: preview.ignored,
        preprocessingJobId:body.preprocessingJobId||'',
        items: preview.files.map((file, i) => {const prior=preprocessing?.items.find(item=>item.path===file.path);return { ...file,...(prior?{hdSource:prior.outputs.find(o=>o.kind==='image').path,hdReferenceHash:prior.sourceHash}:{}), id: 'item-' + (i + 1), status: 'queued', outputs: [], warnings: [] };}) };
      records.set(id, job); await save(job); enqueue(job); return present(job);
      };
      const pending = submissionChain.catch(() => {}).then(work);
      submissionChain = pending.catch(() => {}); return pending;
    },
    async get(body) { return present(await load(body.id)); },
    async list(body = {}) { await initialized; return [...records.values()].filter(j => !body.sessionId || j.sessionId === body.sessionId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 100).map(j => { const value = present(j); if (body.summary !== false && body.summary !== 'false') delete value.items; return value; }); },
    async cancel(body) {
      const job = await load(body.id); if (TERMINAL.has(job.status)) return present(job);
      if (workers.has(job.id)) { job.status = 'cancelling'; workers.get(job.id).controller.abort(new Error('用户停止批处理')); }
      else { job.status = 'cancelled'; job.finishedAt = Date.now(); }
      job.message = '正在停止后续处理，已返回结果会保留'; await save(job); return present(job);
    },
    async resume(body) {
      const job = await load(body.id); if (workers.has(job.id) || ['queued', 'running', 'cancelling'].includes(job.status)) throw new Error('任务仍在执行，请等待收尾');
      if (job.status === 'completed'&&!body.reprocess) return present(job);
      if(body.reprocess===true){
        const targets=job.items.filter(item=>!body.itemId||item.id===body.itemId);if(!targets.length)throw new Error('指定的批处理文件不存在');
        for(const item of targets){item.previousOutputs=[...(item.previousOutputs||[]),...(item.outputs||[])];item.outputs=[];item.status='queued';}
      }
      if (body.allowGeneration !== undefined) job.allowGeneration = body.allowGeneration === true;
      if (body.maxImageRequests !== undefined) { options({ ...job, maxImageRequests: body.maxImageRequests }); job.maxImageRequests = body.maxImageRequests; }
      job.retryUnknown = body.retryUnknown === true;
      await reconcileRequests(job);
      if (job.items.some(i => i.requestState === 'unknown') && !job.retryUnknown) throw new Error('有图像请求结果未知，核对后需显式retryUnknown才可继续');
      for (const item of job.items) if (item.status !== 'completed') item.status = 'queued';
      job.status = 'queued'; job.message = '继续处理未完成项目，已成功文件会复用'; await save(job); enqueue(job); return present(job);
    },
    async events(body) {
      await initialized;
      const sid = String(body.sessionId || '');
      for (const [id, c] of sceneCommands) if (c.kind === 'refresh' && c.deadline <= Date.now()) sceneCommands.delete(id);
      return [...[...records.values()].filter(j => j.sessionId === sid && j.presentation?.pending).sort((a, b) => a.updatedAt - b.updatedAt).map(j => ({ id: j.id, kind: j.presentation.kind || 'project', project: j.project, cwd: j.cwd, sessionId: j.sessionId, revision: j.presentation.revision, status: j.status, message: j.message,
        ...(j.presentation.kind === 'review' ? { taskId: j.presentation.taskId, generationAllowed: j.allowGeneration, maxImageRequests: j.presentation.maxImageRequests } : {}) })),
        ...[...sceneCommands.values()].filter(c => c.sessionId === sid && c.deadline > Date.now()).map(({ resolve, reject, timer, ...c }) => c)];
    },
    async acknowledge(body) {
      if (String(body.id || '').startsWith('scene-')) { const command = sceneCommands.get(body.id); if (command?.kind === 'refresh') sceneCommands.delete(body.id); return { acknowledged: true }; }
      const job = await load(body.id); if (Number(body.revision) === job.presentation?.revision) { job.presentation.pending = false; await save(job); } return { acknowledged: true };
    },
    async open(body) { const job = await load(body.id); job.openCanvas = true; job.presentation = { revision: Date.now(), pending: true, project: job.project }; await save(job); return present(job); },
    async review(body) {
      const job = await load(body.id);
      if (workers.has(job.id)) throw new Error('任务仍在处理，请等待收尾后核对图层');
      const item = body.itemId ? job.items.find(i => i.id === body.itemId) : job.items.find(i => i.layeredTaskId && i.status !== 'completed') || job.items.find(i => i.layeredTaskId);
      if (!item?.layeredTaskId) throw new Error('该文件尚未建立图层清单，请先完成分析');
      const task = await h.layeredImage.get({ project: job.project, id: item.layeredTaskId });
      if (body.openCanvas !== false) {
        await reconcileRequests(job);
        job.presentation = { kind: 'review', revision: Date.now(), pending: true, taskId: task.id, project: job.project,
          maxImageRequests: (task.generationAttempts || 0) + Math.max(0, job.maxImageRequests - job.imageRequestsUsed) };
        await save(job);
      }
      return { jobId: job.id, itemId: item.id, project: job.project, task };
    },
    async arrange(body) {
      const current = contextFor(body), project = absolute(body.project || current.project);
      if (typeof body.baseRevision !== 'number' || !Number.isFinite(body.baseRevision)) throw new Error('请先读取画布，并提供该次读取的baseRevision');
      if (!Array.isArray(body.patches) || !body.patches.length || body.patches.length > 500) throw new Error('一次请指定1至500个对象');
      const live = h.canvasAutomationContexts?.get(String(body.sessionId || ''));
      if (live && live.project === project && Date.now() - live.at < 10000) {
        const id = 'scene-' + randomBytes(12).toString('hex');
        return new Promise((resolveCommand, rejectCommand) => {
          const command = { id, kind: 'patch', project, sessionId: String(body.sessionId || ''), patches: body.patches, sceneStamp: live.sceneStamp || '', baseRevision: Number(body.baseRevision), deadline: Date.now() + 10000,
            resolve: resolveCommand, reject: rejectCommand, timer: null };
          command.timer = setTimeout(() => { sceneCommands.delete(id); rejectCommand(new Error('画布未及时确认调整，请重新读取对象核对结果后再操作')); }, 10000);
          sceneCommands.set(id, command);
        });
      }
      const scene = await patchAutomationCanvas(h, project, body.patches, body.baseRevision);
      const id = 'scene-' + randomBytes(12).toString('hex');
      sceneCommands.set(id, { id, kind: 'refresh', project, sessionId: String(body.sessionId || ''), deadline: Date.now() + 60000 });
      return { project, ...summarizeAutomationCanvas(scene) };
    },
    async completeCanvasCommand(body) {
      const command = sceneCommands.get(String(body.id || ''));
      if (!command || command.kind !== 'patch' || command.sessionId !== String(body.sessionId || '')) throw new Error('画布调整请求已过期');
      clearTimeout(command.timer); sceneCommands.delete(command.id);
      if (body.error) command.reject(new Error(String(body.error).slice(0, 500)));
      else {
        try {
          const summary = summarizeAutomationCanvas(await readAutomationCanvas(command.project));
          const previous = h.canvasAutomationContexts?.get(command.sessionId);
          if (previous?.project === command.project && Number(previous.revision || 0) <= summary.revision) h.canvasAutomationContexts.set(command.sessionId,
            { ...previous, elements: summary.elements, revision: summary.revision, sceneStamp: typeof body.sceneStamp === 'string' ? body.sceneStamp.slice(0, 200000) : '', at: Date.now() });
          command.resolve({ project: command.project, ...summary });
        }
        catch (error) { command.reject(error); }
      }
      return { acknowledged: true };
    },
    async settled(body) { await initialized; while (records.get(body.id)?.status === 'queued' || workers.has(body.id)) { const p = workers.get(body.id)?.promise; if (p) await p.catch(() => {}); else await delay(10); } return present(await load(body.id)); },
    async dispose() { disposed = true; for (const command of sceneCommands.values()) { clearTimeout(command.timer); command.reject?.(new Error('插件关闭')); } sceneCommands.clear(); for (const entry of workers.values()) entry.controller.abort(new Error('插件关闭')); await Promise.allSettled([...workers.values()].map(e => e.promise)); }
  };
}
