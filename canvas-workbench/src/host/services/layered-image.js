import { createHash, randomBytes } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isMac, isWindows, resolvePythonWithDeps, runAdobeJsxViaCom, openWithSystem } from '../../../lib/platform.js';
import { generateImage, readImageEngineSettings } from '../../../lib/image-engine.js';
import { dshCodexImageModel } from '../../providers/image/dsh-codex.provider.js';
import { decodeImageData, safeImageName } from '../../shared/utils/data-url.js';
import { isPathWithin } from '../../shared/utils/paths.js';
import { PLUGIN_ROOT } from '../vendor-assets.js';
import { runPythonSpec } from './python-launch.js';
import { textLayerGeometry } from './native-text-psd.js';
import { analyzeLayeredImage, extractionPrompt, normalizeLayerElements } from './layered-image-model.js';
import { buildLayeredIllustratorJsx, buildLayeredPsd, buildLayeredSvg } from './layered-image-export.js';
import { calibrateLayeredAnalysis, checkLayerLayout, runLayerRefinementScript, hasBlockingLayerQuality, automaticLayerQuality, partitionReadbackTypography } from './layered-image-refinement.js';
import { denseSourceStructure } from './layered-source-policy.js';
import { enhanceLayerRegion,verifyEnhancedRegion } from './layered-image-enhancement.js';
import { inspectLayerReadback } from './layered-image-readback.js';
import { refineLayerSourceRegions } from './layered-image-regions.js';
import {completeLayerPlan,completeLayerAudit,deduplicateCompleteText} from './layered-complete-policy.js';
import {prepareLayerSourceHd,identifySourceBrands,sourceBrandConstraint} from './layered-source-hd.js';
import {recoverCompleteText} from './layered-complete-text.js';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const nativeRepresentation=e=>({text:e.text,font:e.fontPostScript,color:e.color,tracking:e.tracking,...textLayerGeometry(e)});
const exists = async path => { try { await access(path); return true; } catch { return false; } };
const validId = id => /^layers-[a-z0-9]+-[a-f0-9]{12}$/.test(String(id || ''));
export const LAYERED_TASK_DIRECTORY = '图片拆层';
let illustratorChain = Promise.resolve();
const withIllustrator = work => {
  const pending = illustratorChain.catch(() => {}).then(work);
  illustratorChain = pending.catch(() => {});
  return pending;
};

/** One scoped service per host. Manifests and assets survive host restarts. */
export function createLayeredImageService(h, overrides = {}) {
  const active = new Map(), cache = new Map(), saves = new Map(), preparing = new Map();
  const { ctx, projectDirectory, previewUrl, runProcess, runProcessWithTimeout } = h;
  const generate = overrides.generate || generateImage;
  const analyze = overrides.analyze || analyzeLayeredImage;
  const settingsFor = overrides.settings || readImageEngineSettings;
  const workspaceScope = body => {
    if (body.storageScope !== 'workspace') return body;
    const current = h.chatContexts?.get(String(body.sessionId || ''));
    const cwd = String(current?.cwd || body.cwd || '').trim();
    if (!cwd || !isAbsolute(cwd)) throw new Error('当前聊天工作目录尚未就绪，请先选择工作区再拆层');
    return { ...body, cwd, project: cwd };
  };
  const baseFor = body => {
    const scoped = workspaceScope(body);
    const project = projectDirectory(scoped.cwd, scoped.project);
    if (!project || !isAbsolute(project)) throw new Error('请先打开有效的画布项目');
    return join(project, 'outputs', LAYERED_TASK_DIRECTORY);
  };
  const directoryFor = (body, id) => {
    if (!validId(id)) throw new Error('拆层任务编号无效');
    return join(baseFor(body), id);
  };
  const save = task => {
    task.updatedAt = Date.now();
    const file = join(task.directory, 'task.json'), snapshot = JSON.stringify(task, null, 2);
    const chain = (saves.get(file) || Promise.resolve()).catch(() => {}).then(async () => {
      await writeFile(file + '.tmp', snapshot, 'utf8'); await rename(file + '.tmp', file);
    });
    saves.set(file, chain);
    return chain;
  };
  const present = task => ({ id: task.id, name: task.name, sourceHash: task.sourceHash,referenceSourceHash:task.referenceSourceHash||'', width: task.width, height: task.height,
    autoExportFormat: task.autoExportFormat, openAfterExport: task.openAfterExport, automatic: task.automatic === true, recoveryEvents: task.recoveryEvents || [],
    status: task.status, stage: task.stage, message: task.message, progress: task.progress, error: task.error || '',
    warnings: task.warnings || [], engine: task.engine || '', imageModel: task.imageModel || '', localOnly: task.localOnly === true, createdAt: task.createdAt, updatedAt: task.updatedAt,
    quality: task.quality ? { ...task.quality, reviewAcknowledged: task.qualityAcknowledged === true } : null, analysisModel: task.analysisModel || null, analysisAttempts: task.analysisAttempts || 0,
    analysisProgress:task.analysisProgress||null,analysisStrategy:task.analysisStrategy||'',analysisComplete:task.analysisComplete===true,
    assemblyCheck:task.assemblyCheck||null,reconstruction:task.reconstruction||'preserve',sourceHd:task.sourceHd||null,completeness:task.completeness||null,
    generationAttempts: task.generationAttempts || 0, maxImageRequests: task.maxImageRequests ?? 40,
    sourceUrl: previewUrl(task.source, task.createdAt), previewUrl: task.preview ? previewUrl(task.preview, task.updatedAt) : '',
    outputDirectory: task.directory, storageProject: join(task.directory, '..', '..', '..'),
    workspaceRoot: task.workspaceRoot || join(task.directory, '..', '..', '..'),
    structureChanges: task.structureChanges || [],
    elements: (task.elements || []).map(({ file, rawFile, reusedRawFile, contentFile, assetKey, geometry, ...e }) => ({ ...e, ...(file ? { url: previewUrl(contentFile || file, e.assetTime || 0) } : {}) })),
    exports: task.exports || [] });
  const load = async (body, id) => {
    const dir = directoryFor(body, id);
    if (cache.has(dir)) return cache.get(dir);
    const task = JSON.parse(await readFile(join(dir, 'task.json'), 'utf8'));
    if (task.id !== id || task.directory !== dir || !isPathWithin(dir, task.source)) throw new Error('拆层任务记录损坏');
    for(const k of ['referenceSource','analysisSource','suppliedHdSource'])if(task[k]&&!isPathWithin(dir,task[k]))throw new Error('任务参考素材路径无效');
    for (const e of task.elements || []) for (const k of ['file', 'rawFile', 'reusedRawFile', 'contentFile']) if (e[k] && !isPathWithin(dir, e[k])) throw new Error('任务素材路径无效');
    // v1 complete mode passed two references through the old single-buffer
    // facade. dataUrl rejected those bytes before client.generate could send
    // HTTP. Only this exact local preflight error is safe to recover without
    // the unknown-request approval used for actual network failures.
    const rejected=(task.elements||[]).filter(e=>task.reconstruction==='complete'&&e.requestState==='unknown'&&e.error==='图片输入格式无效'&&!e.rawFile);
    if(rejected.length){for(const e of rejected){e.requestState='not-submitted';e.status='pending';e.error='';}task.generationAttempts=Math.max(0,(task.generationAttempts||0)-rejected.length);task.recoveryEvents=[...(task.recoveryEvents||[]),{step:'multi-image-local-preflight',count:rejected.length,at:Date.now(),message:'旧单图接口在本地拒绝多图字节，未发送HTTP；恢复素材并扣回本地误计数'}];await save(task);}
    if (task.status === 'running' && !active.has(dir)) {
      task.status = 'failed'; task.stage = 'error'; task.error = '应用上次关闭时任务尚未完成。已保留素材，可继续拆层；结果未知的请求需核对后再重试。';
      for (const e of task.elements || []) if (e.requestState === 'submitted') e.requestState = 'unknown';
      if(task.sourceHd?.requestState==='submitted')task.sourceHd.requestState='unknown';
      for(const key of Object.keys(task.sourceHd?.tiles||{}))if(task.sourceHd.tiles[key]==='submitted')task.sourceHd.tiles[key]='unknown';
      await save(task);
    }
    cache.set(dir, task);
    return task;
  };
  const pixel = async (spec, signal) => {
    signal?.throwIfAborted();
    if (overrides.pixel) return overrides.pixel(spec, signal);
    const python = await resolvePythonWithDeps(ctx);
    const run = await runPythonSpec((exe, args, cwd, timeout) => runProcessWithTimeout(exe, args, cwd, timeout),
      python, join(PLUGIN_ROOT, 'scripts', 'layered_image.py'), spec, { cwd: PLUGIN_ROOT, timeoutMs: 180000 });
    signal?.throwIfAborted();
    let result; try { result = JSON.parse(String(run.stdout || '').trim()); } catch {
      const error = new Error('图层像素处理未返回结果'); error.localRetryable = run.exitCode == null || run.timedOut === true; throw error;
    }
    if (run.exitCode !== 0 || !result.success) throw new Error(result.error || '图层像素处理失败');
    return result;
  };
  const start = (task, work) => {
    if (active.has(task.directory)) throw new Error('该拆层任务仍在执行，请等待当前步骤结束');
    const controller = new AbortController();
    const entry = { controller, promise: null };
    active.set(task.directory, entry);
    entry.promise = Promise.resolve().then(async () => {
      await save(task);
      await work(controller.signal);
    }).catch(error => {
      if (controller.signal.aborted) {
        task.status = 'cancelled'; task.stage = 'cancelled'; task.message = '已停止后续请求，已返回的素材保留';
      } else {
        task.status = 'failed'; task.stage = 'error'; task.error = String(error?.message || error).slice(0, 1200); task.message = task.error;
      }
    }).finally(async () => {
      try { await save(task); } finally { active.delete(task.directory); }
    });
    // Every worker is retained and its error recorded. No unhandled rejection.
    entry.promise.catch(() => {});
  };
  const ensureIdle = task => { if (active.has(task.directory) || preparing.has(task.directory)) throw new Error('当前步骤仍在执行，请稍候'); };

  const cleanPlate = async (task, element, signal) => {
    if (!task.autoRefine || !task.elements.some(e => e.enabled && e.nativeText)) return;
    const spec = { operation: 'clean-background', input: element.file, source: task.source, output: element.file, elements: task.elements };
    const result = overrides.refinement ? await overrides.refinement(spec, signal) : await runLayerRefinementScript(h, spec, signal);
    element.backgroundQualityIssues = result.issues || [];
    task.backgroundRepairs = result.repairedRegions || [];
    await writeFile(join(task.directory, 'background-quality.json'), JSON.stringify(result, null, 2));
  };
  const calibrate = async (task, options, signal) => {
    const prior=new Map(task.elements.map(e=>[e.id,e]));
    const result = overrides.calibrate ? await overrides.calibrate(task, options, signal) : await calibrateLayeredAnalysis(h, task, options, signal);
    signal?.throwIfAborted();
    task.elements = normalizeLayerElements(result.elements, task.width, task.height);
    // Refinement changes the plan, not ownership of the original responses.
    // Keep the old cache signature so prepareRun can decide what to reuse;
    // leave status pending until changed typography has actually been rendered.
    for(const e of task.elements){const old=prior.get(e.id);if(!old)continue;
      for(const key of ['assetKey','rawFile','reusedRawFile','file','contentFile','bounds','assetTime','requestState','extractionEngine','platePrepared','plateVersion','actualPixels','returnedFraming','alignment','placementQualityIssues'])if(old[key]!==undefined)e[key]=old[key];
    }
    task.quality = automaticLayerQuality(result.quality);
    const unsupported = new Set((result.quality?.issues || []).filter(i => ['font-unavailable','font-fit-unresolved','unsupported-text-geometry','strict-font-review'].includes(i.code)).map(i=>i.id));
    for (const e of task.elements) if (e.type==='text' && (unsupported.has(e.id) || !e.nativeText)) {
      e.nativeText=false; e.fontAccepted=false; e.sourceTextFallback=true;
    }
    task.textPolicyVersion=2;
    task.analysisWarnings = [...new Set([...(task.analysisWarnings || []), ...(result.warnings || [])])].slice(0, 200);
    task.warnings = [...task.analysisWarnings];
  };

  const transientLocal = error => error?.localRetryable === true || ['EAGAIN','EBUSY','EIO','EMFILE','ENFILE','EPIPE'].includes(error?.code);
  async function fixCompleteText(task,ids,settings,signal,render=false){
    if(!ids.length)return [];
    task.stage='verification';task.message='正在对照原图核对 '+ids.length+' 处文字与包装归属，复用已完成素材…';await save(task);
    const result=await (overrides.recoverText||recoverCompleteText)(ctx,task,ids,pixel,signal);
    for(const old of task.elements){const next=result.elements.find(e=>e.id===old.id);if(!next)continue;
      if(result.changed.includes(old.id))for(const k of ['cleanupBounds','textFit','sourceTextFallback','nativePreviewSignature','contentUncertain'])delete old[k];
      Object.assign(old,next);if(result.changed.includes(old.id)){delete old.contentUncertain;delete old.nativePreviewSignature;}if(result.unresolved.includes(old.id)){old.contentUncertain=true;old.nativeText=false;}
    }
    if(result.unresolved.length)throw new Error('完整拆分仍有无法确认的文字：'+result.unresolved.join('、')+'；原图与高清参考已保留，未把它们伪装成可编辑内容');
    const targets=task.elements.filter(e=>result.changed.includes(e.id)&&e.enabled&&e.type==='text');
    // Narrow upright CJK columns are multiple baselines, not one horizontal
    // word squeezed into a character-wide rectangle. Keep native text in both
    // Adobe formats and measure the same line spacing in the preview.
    for(const e of targets)if(!/[\r\n]/.test(e.text)&&/[\u3400-\u9fff]/.test(e.text)&&e.text.length>=3&&e.height/e.width>=e.text.length*.65)e.text=Array.from(e.text).join('\n');
    if(targets.length){
      const refined=await (overrides.completeRefinement||((spec,s)=>runLayerRefinementScript(h,spec,s)))({operation:'refine',input:task.source,elements:targets,complete:true},signal);
      for(const next of refined.elements){const e=task.elements.find(e=>e.id===next.id);Object.assign(e,next);e.nativeText=!!(e.fontAvailable&&e.textFit);e.fontAccepted=e.nativeText;if(!e.nativeText)throw new Error('完整拆分的替代字体无法显示：'+e.name);
        if(task.quality?.fontPolicy==='strict'&&Number(e.styleConfidence||0)<.9)throw new Error('严格字体策略无法确认原字体：'+e.name+'；未自动换成近似字体');
        if(render){await extract(task,e,settings,signal);e.contentFile ||=join(task.directory,'layers',e.id+'-'+safeImageName(e.name+'.png'));const crop=await pixel({operation:'crop-layer',input:e.file,output:e.contentFile},signal);e.bounds=crop.bounds;e.assetTime=(await stat(e.contentFile)).mtimeMs;}
      }
    }
    if(render)for(const e of task.elements.filter(e=>result.changed.includes(e.id)&&e.enabled&&e.unresolvedAsGlyph)){
      await extract(task,e,settings,signal);e.contentFile ||=join(task.directory,'layers',e.id+'-'+safeImageName(e.name+'.png'));const crop=await pixel({operation:'crop-layer',input:e.file,output:e.contentFile},signal);e.bounds=crop.bounds;
    }
    deduplicateCompleteText(task.elements);return result.changed;
  }
  async function recoverLocal(task, label, work, signal, canRetry = () => true) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      try { return await work(); }
      catch (error) {
        signal.throwIfAborted();
        if (attempt >= 2 || !canRetry() || !transientLocal(error)) throw error;
        task.recoveryEvents = [...(task.recoveryEvents || []), { step: label, attempt: attempt+1, at: Date.now(), error: String(error.message || error).slice(0,500) }].slice(-60);
        task.message = '正在自动恢复“'+label+'”（'+(attempt+1)+'/2），复用已返回素材'; await save(task);
        await (overrides.retryDelay ? overrides.retryDelay(attempt, signal) : new Promise(resolve => setTimeout(resolve, (attempt+1)*400)));
      }
    }
  }

  async function extract(task, e, settings, signal) {
    const output = join(task.directory, 'assets', e.id + '-' + e.assetKey.slice(0, 20) + '.png');
    const raw = e.reusedRawFile || join(task.directory, 'assets', e.id + '-' + e.assetKey.slice(0, 20) + '.original');
    if(e.unresolvedAsGlyph){
      await pixel({operation:'source-glyph-cutout',input:task.source,output,element:e},signal);e.file=output;e.status='complete';e.error='';e.requestState='local';e.extractionEngine='source-unconfirmed-glyph';return;
    }
    if(task.reconstruction==='complete'&&e.type==='image'&&task.analysisSource&&!e.useOriginalRegion){
      const original=output+'.reference.png',candidate=output+'.hd.png',report=join(task.directory,'analysis','material-'+e.id+'.json');
      await pixel({operation:'analysis-crop',input:task.source,output:original,region:e},signal);await pixel({operation:'analysis-crop',input:task.analysisSource,output:candidate,region:e},signal);
      const signature=hash({original:hash(await readFile(original)),candidate:hash(await readFile(candidate)),brands:task.sourceFacts?.brands||[],model:task.analysisModel});let checked;
      try{const prior=JSON.parse(await readFile(report,'utf8'));if(prior.signature===signature)checked=prior;}catch{}
      if(!checked){checked={...await (overrides.verifyEnhancement||verifyEnhancedRegion)(ctx,task.analysisModel,original,candidate,signal,task.sourceFacts?.brands||[]),signature};await writeFile(report,JSON.stringify(checked,null,2));}
      e.hdSourceCheck=checked;if(!checked.accepted){e.useOriginalRegion=true;task.warnings.push('“'+e.name+'”高清版本未通过身份/品牌核对，改从原图透明提取：'+checked.reason);}
    }
    if(task.reconstruction==='complete'&&e.type==='image'&&e.extractionMode==='cutout'&&!await exists(raw)){
      const source=e.useOriginalRegion?task.source:task.analysisSource||task.source;
      if(e.visualKind==='graphic'){
        const local=await pixel({operation:'graphic-cutout',input:source,output,element:e,elements:task.elements},signal);
        if(local.eligible){e.file=output;e.status='complete';e.error='';e.requestState='local';e.extractionEngine=local.engine;return;}
      }
      if(e.visualKind==='product'||e.visualKind==='graphic'&&!/文字|书法|标题|标识|logo|印章/.test(e.name+' '+e.description)){
        const input=output+'.matte-input.png',matte=output+'.local-matte.png';
        await pixel({operation:'analysis-crop',input:source,output:input,region:e},signal);
        try{
          if(!await exists(matte)){
            const python=await resolvePythonWithDeps(ctx),run=await runPythonSpec((exe,args,cwd,timeout)=>runProcessWithTimeout(exe,args,cwd,timeout),python,join(PLUGIN_ROOT,'scripts','remove_background.py'),{input,output:matte,model:'birefnet-general-lite'},{cwd:PLUGIN_ROOT,timeoutMs:600000});
            if(run.exitCode!==0||!await exists(matte))throw new Error('本地素材抠图不可用');
          }
          await pixel({operation:'place-cutout',input:matte,output,element:e,elements:task.elements,width:task.width,height:task.height},signal);
          e.file=output;e.status='complete';e.error='';e.requestState='local';e.extractionEngine='hd-product-local-matte';return;
        }catch(error){signal.throwIfAborted();task.warnings.push('“'+e.name+'”本地透明提取未通过，继续模型提取：'+String(error.message||error));}
      }
    }
    if(await enhanceLayerRegion(task,e,settings,signal,{ctx,pixel,generate,save,verify:overrides.verifyEnhancement}))return;
    if(e.type==='background'&&task.analysisStrategy==='dense'&&task.reconstruction!=='complete'){
      const local=await pixel({operation:'source-layout-plate',input:task.source,output,elements:task.elements},signal);
      e.file=output;e.status='complete';e.error='';e.requestState='local';e.extractionEngine=local.engine;e.backgroundQualityIssues=local.issues||[];
      task.sourcePlateFallbackIds=local.unresolvedTextIds||[];return;
    }
    if (e.type==='text' && !e.nativeText) {
      delete e.nativePreviewSignature;
      const local=await pixel({operation:'source-text',input:task.source,output,element:e},signal);
      e.sourceTextFallback=true;e.file=output;e.status='complete';e.error='';e.requestState='local';e.extractionEngine=local.engine;
      return;
    }
    if (e.type === 'shape' || e.extractionMode === 'photo' || e.sourceRegion) {
      const local = await pixel({ operation:'render-structure',input:task.reconstruction==='complete'&&task.analysisSource&&!e.useOriginalRegion?task.analysisSource:task.source,output,element:e,elements:task.elements },signal);
      e.file=output;e.status='complete';e.error='';e.requestState='local';e.extractionEngine=local.engine;
      e.placementQualityIssues=local.placementIssues||[];return;
    }
    if (!e.nativeText && e.preserveSource !== false) {
      const flat = await pixel({ operation: 'source-flat', input: task.source, output, elements: task.elements, element: e }, signal);
      if (flat.eligible) {
        e.file = output; e.status = 'complete'; e.error = ''; e.extractionEngine = flat.engine; e.requestState = 'local';
        if (e.type === 'background') await cleanPlate(task, e, signal);
        return;
      }
    }
    if (e.nativeText) {
      try { await pixel({ operation: 'text', width: task.width, height: task.height, element: { ...e, geometry: textLayerGeometry(e) }, output }, signal); e.extractionEngine='local-native-text';e.nativePreviewSignature=hash(nativeRepresentation(e)); }
      catch (error) {
        signal.throwIfAborted();
        if (transientLocal(error) || !/字体|字形|候选|文字位于画布外/i.test(String(error.message||error))) throw error;
        e.nativeText=false;e.fontAccepted=false;e.sourceTextFallback=true;delete e.nativePreviewSignature;
        const local=await pixel({operation:'source-text',input:task.source,output,element:e},signal);e.extractionEngine=local.engine;
        task.warnings.push('“'+e.name+'”渲染字体不可用，已自动保留原字形区域：'+String(error.message||error).slice(0,180));
      }
      e.file = output; e.status = 'complete'; e.requestState = 'local'; return;
    }
    if (await exists(output) && !(e.type === 'background' && e.plateVersion !== 4 && await exists(raw))) {
      let checked;
      try { checked = await pixel({ operation: 'normalize', input: output, output, width: task.width, height: task.height, background: e.type === 'background', element: e, preserve_placement: true, allow_checkerboard: task.sourceCheckerboard === true }, signal); }
      catch (error) {
        signal.throwIfAborted();
        if (transientLocal(error) || !await exists(raw)) throw error;
        await rename(output, output + '.invalid-' + Date.now()); e.file = ''; e.status = 'pending';
        task.warnings.push('“'+e.name+'”的处理中间图无效，已保留诊断副本并从原始返回自动重建');
      }
      if (checked && checked.width === task.width && checked.height === task.height && (e.type === 'background' || e.nativeText || checked.hasTransparency)) {
        e.file = output; e.status = 'complete'; e.error = '';
        if(await exists(raw))e.rawFile=raw;
        e.requestState=e.nativeText?'local':'returned';
        e.extractionEngine=e.extractionEngine||(e.nativeText?'local-native-text':'model-reconstruction');
        if (checked.aligned) { e.alignment = checked.aligned; task.warnings.push('“' + e.name + '”已按原图区域回位，请核对边缘与字号'); }
        if (e.type === 'background') {
          if (!e.platePrepared) { await pixel({ operation: 'background-plate', source: task.source, input: output, output, elements: task.elements }, signal); e.platePrepared = true; e.plateVersion = 4; }
          await cleanPlate(task, e, signal);
        }
        return;
      }
    }
    if (e.type === 'background' && !task.elements.some(x => x.type !== 'background')) {
      await copyFile(task.source, output); e.file = output; e.status = 'complete'; return;
    }
    if (!await exists(raw)) {
      if (task.localOnly) throw new Error('“' + e.name + '”无法在本地完整提取。请检查遮挡和图层合并，或关闭“仅使用原图提取”后再运行');
      if (e.requestState === 'unknown' && !task.retryUnknown) throw new Error('“' + e.name + '”上次请求结果未知。请核对服务记录，并接受可能重复消耗额度后再重试');
      if ((task.generationAttempts || 0) >= task.maxImageRequests) throw new Error('图像请求已达到本轮上限，已保留成功素材；提高请求上限后可继续');
      task.generationAttempts = (task.generationAttempts || 0) + 1;
      e.requestState = 'submitted'; await save(task);
      try {
        const result = await generate({ ctx, image: task.reconstruction==='complete'&&task.analysisSource?[await readFile(task.referenceSource||task.source),await readFile(task.analysisSource)]:await readFile(task.source), prompt: extractionPrompt(e, task.elements, task.width, task.height)+(e.type==='image'?sourceBrandConstraint(task):''),
          engine: task.engine, signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]),
          background: e.type === 'background' ? 'opaque' : 'transparent', maxAttempts: 1, settingsOverride: settings });
        // Retain a returned result even when cancellation races the response.
        await writeFile(raw, result.bytes, { flag: 'wx' });
        e.rawFile = raw; e.requestState = 'returned'; await save(task);
      } catch (error) {
        if(error.imageRequestNotSent===true){e.requestState='not-submitted';task.generationAttempts=Math.max(0,(task.generationAttempts||0)-1);}else e.requestState = 'unknown';
        e.status = 'failed'; e.error = String(error?.message || error); await save(task); throw error;
      }
    } else { e.rawFile = raw; e.requestState = 'returned'; }
    signal.throwIfAborted();
    let inspected = await pixel({ operation: 'normalize', input: raw, output, width: task.width, height: task.height, background: e.type === 'background', element: e, allow_checkerboard: task.sourceCheckerboard === true }, signal);
    if (e.type !== 'background' && !inspected.hasTransparency) {
      task.message = '“' + e.name + '”未返回透明通道，正在本地去除背景'; await save(task);
      if (overrides.matte) await overrides.matte(output, signal);
      else {
        const python = await resolvePythonWithDeps(ctx), matte = output + '.matte.png';
        const run = await runPythonSpec((exe, args, cwd, timeout) => runProcessWithTimeout(exe, args, cwd, timeout), python,
          join(PLUGIN_ROOT, 'scripts', 'remove_background.py'), { input: output, output: matte, model: 'birefnet-general-lite' }, { cwd: PLUGIN_ROOT, timeoutMs: 600000 });
        if (run.exitCode !== 0 || !await exists(matte)) {
          await writeFile(join(task.directory, 'matte-' + e.id + '-error.json'), JSON.stringify({exitCode: run.exitCode ?? null, timedOut: run.timedOut === true, stderr: String(run.stderr || '').slice(-4000), stdout: String(run.stdout || '').slice(-2000)}, null, 2));
          const error = new Error('“' + e.name + '”本地去背景' + (run.exitCode == null ? '进程被中断' : run.timedOut ? '超时' : '失败') + '，原始返回已保存；详情见任务文件夹中的 matte 日志'); error.localRetryable = run.exitCode == null || run.timedOut === true; throw error;
        }
        signal.throwIfAborted();
        inspected = await pixel({ operation: 'normalize', input: matte, output, width: task.width, height: task.height, element: e }, signal);
      }
      inspected = await pixel({ operation: 'inspect', input: output }, signal);
      if (!inspected.hasTransparency) throw new Error('前景仍无有效透明区域，不能作为独立图层：' + e.name);
      if (!task.warnings.includes('部分素材由本地抠图生成透明边缘，请检查半透明细节及残影')) task.warnings.push('部分素材由本地抠图生成透明边缘，请检查半透明细节及残影');
    }
    e.file = output; e.error = '';
    if (e.type === 'background') { await pixel({ operation: 'background-plate', source: task.source, input: output, output, elements: task.elements }, signal); e.platePrepared = true; e.plateVersion = 4; }
    if (e.type === 'background') await cleanPlate(task, e, signal);
    e.status = 'complete'; e.extractionEngine = 'model-reconstruction';
    e.actualPixels = inspected.actualPixels || [inspected.width, inspected.height];
    e.returnedFraming = inspected.framing || 'canvas';
    e.placementQualityIssues = inspected.placementIssues || [];
    if (e.returnedFraming !== 'canvas') task.warnings.push('“' + e.name + '”返回独立图层素材 ' + e.actualPixels.join('×') + '，已等比放回原图区域，请核对边缘及留白');
    if (inspected.aligned) { e.alignment = inspected.aligned; task.warnings.push('“' + e.name + '”已按原图区域回位，请核对边缘与字号'); }
    if (inspected.resized) task.warnings.push('“' + e.name + '”由 ' + inspected.actualPixels.join('×') + ' 等比适配至原图画布，请检查位置和清晰度');
  }

  async function exportArtifact(task, kind, signal, openAfterExport = false) {
        const stale=task.elements.some(e=>e.enabled&&e.nativeText&&e.nativePreviewSignature!==hash(nativeRepresentation(e)));
        if(stale||(task.analysisStrategy==='dense'&&task.assemblyCheck?.verified===false)||(task.reconstruction==='complete'&&task.completeness?.complete!==true)){
          for(const e of task.elements.filter(e=>e.enabled)){
            if(e.nativeText)await extract(task,e,{},signal);
            e.contentFile ||=join(task.directory,'layers',e.id+'-'+safeImageName(e.name+'.png'));
            const crop=await pixel({operation:'crop-layer',input:e.file,output:e.contentFile},signal);e.bounds=crop.bounds;
          }
          await validateAssembly(task,{},signal,task.elements.filter(e=>e.enabled));
        }
        const prepared = task.elements.map(e => ({ ...e, ...(e.nativeText ? { geometry: textLayerGeometry(e) } : {}) }));
        const manifest = await pixel({ operation: 'assemble', directory: task.directory, width: task.width, height: task.height, elements: prepared }, signal);
        const highDensity=[];
        for(const e of prepared.filter(e=>e.enabled&&e.enhancementCheck?.accepted===true&&e.enhancedFile&&isPathWithin(task.directory,e.enhancedFile))){
          if(await exists(e.enhancedFile))highDensity.push({id:e.id,hash:hash(await readFile(e.enhancedFile))});
        }
        const signature = hash({exporterRevision:4,highDensity,layers:prepared.map(e => ({ id:e.id, assetKey:e.assetKey, type:e.type,nativeText:e.nativeText, native:e.nativeText?nativeRepresentation(e):undefined,z:e.z, enabled:e.enabled, bounds:e.bounds })),composite:hash(await readFile(manifest.composite))});
        const checkpoint = task.exportCheckpoint;
        let output, published;
        if (checkpoint?.kind === kind && checkpoint.signature === signature && await exists(checkpoint.published?.path)) {
          output = checkpoint.output; published = checkpoint.published;
        } else {
        const base = task.name.replace(/\.[^.]+$/, ''); output = join(task.directory, base + (task.flat ? '-普通转换-' : '-拆层-') + Date.now() + '.' + kind);
        if (kind === 'psd') await writeFile(output, await buildLayeredPsd(manifest), { flag: 'wx' });
        else if (kind === 'svg') await writeFile(output, await buildLayeredSvg(task), { encoding: 'utf8', flag: 'wx' });
        else {
          const work = await mkdtemp(join(tmpdir(), 'dsh-layer-ai-'));
          try {
            // ASCII temporary names also avoid legacy Adobe path encodings.
            const elements = [];
            for (const [i, b] of prepared.filter(e => e.enabled).entries()) {
              const file = join(work, 'layer-' + i + '.png');
              const enhanced=b.enhancementCheck?.accepted===true&&b.enhancedFile&&isPathWithin(task.directory,b.enhancedFile)&&await exists(b.enhancedFile)?b.enhancedFile:'';
              await copyFile(enhanced || b.contentFile || b.file, file); elements.push({ ...b, file });
            }
            const target = join(work, 'layers.ai'), jsxPath = join(work, 'layers.jsx');
            const jsx = buildLayeredIllustratorJsx({ width: task.width, height: task.height, elements, output: target });
            await withIllustrator(async () => {
              signal.throwIfAborted();
              for (let attempt = 0; attempt < 2; attempt++) {
                let failure = '';
                if (isMac) {
                  await writeFile(jsxPath, jsx, 'utf8');
                  const script = join(work, 'export.applescript');
                  await writeFile(script, 'with timeout of 300 seconds\ntell application id "com.adobe.illustrator"\nactivate\n«event miscDjxM» (read POSIX file ' + JSON.stringify(jsxPath) + ' as «class utf8»)\nend tell\nend timeout\n', 'utf8');
                  const executable = await ctx.subprocess.resolveExecutable('osascript');
                  const result = await runProcessWithTimeout(executable, [script], work, 300000);
                  if (result.exitCode !== 0) failure = String(result.stderr || 'Illustrator 没有返回成功结果');
                } else if (isWindows) {
                  await writeFile(jsxPath, '\uFEFF' + jsx, 'utf8');
                  const result = await runAdobeJsxViaCom(ctx, runProcessWithTimeout, { app: 'illustrator', jsxPath, workDir: work, timeoutMs: 300000 });
                  if (!result.ok) failure = String(result.error || 'Illustrator 没有返回成功结果');
                } else throw new Error('原生 AI 导出需要 macOS 或 Windows 上的 Illustrator，可改选 PSD / SVG');
                if (!failure) break;
                await writeFile(join(task.directory, 'illustrator-export-' + Date.now() + '.log'), failure, 'utf8');
                if (attempt === 0 && /MRAP|1346458189/.test(failure)) {
                  // Illustrator occasionally retains a stale document handle
                  // immediately after close/reopen. Only retry this local,
                  // non-billable export, never an image generation request.
                  if (await exists(target)) await rename(target, join(work, 'first-attempt.ai'));
                  await new Promise(resolve => setTimeout(resolve, 1500)); signal.throwIfAborted(); continue;
                }
                throw new Error('Illustrator 原生 AI 导出没有完成，请确认应用可正常运行后重试；素材已保留，也可选择 PSD / SVG。详细原因已保存到任务文件夹中的导出日志。');
              }
            });
            signal.throwIfAborted();
            const bytes = await readFile(target);
            if (bytes.length < 1024 || bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('Illustrator 未生成有效的 PDF 兼容原生 AI 文件');
            await writeFile(output, bytes, { flag: 'wx' });
          } finally { await rm(work, { recursive: true, force: true }); }
        }
        signal.throwIfAborted();
        const fileInfo = await stat(output);
        published = { path: output, name: output.slice(output.lastIndexOf('/') + 1).split('\\').pop(), kind, size: fileInfo.size, mtime: fileInfo.mtimeMs, managed: true, url: previewUrl(output, fileInfo.mtimeMs) };
        if (h.writeManagedSource) published = await h.writeManagedSource(join(task.directory, '..', '..', '..'), published.name, await readFile(output), kind);
          task.exportCheckpoint = { kind, signature, output, published }; await save(task);
        }
        if (h.cacheSourcePreview) await h.cacheSourcePreview(published.path, published.mtime, kind, manifest.preview);
        if (!task.exports.some(file => file.path === published.path)) task.exports.push(published); task.preview = manifest.preview;
        // Persist the delivered file before launching an external editor.
        await save(task);
        // The managed asset is now authoritative. Keep resumable layer inputs,
        // but not a second full PSD/AI/SVG in the process directory.
        if (published.path !== output) await rm(output, { force: true }).catch(() => {});
        let opened = false;
        if (openAfterExport && ['ai', 'psd', 'svg'].includes(kind)) {
          try {
            if (overrides.open) await overrides.open(published, signal);
            else if (isMac) {
              const executable = await ctx.subprocess.resolveExecutable('open');
              const app = kind === 'psd' ? 'com.adobe.Photoshop' : 'com.adobe.illustrator';
              const result = await runProcessWithTimeout(executable, ['-b', app, published.path], task.directory, 30000);
              if (result.exitCode !== 0) throw new Error(result.stderr || '应用未返回成功');
            } else if (isWindows) {
              const result = await openWithSystem(ctx, runProcess, published.path, task.directory, { app: kind === 'psd' ? 'photoshop' : 'illustrator' });
              if (!result.ok) throw new Error(result.error || '应用未返回成功');
            } else throw new Error('此系统不支持自动打开 Adobe');
            opened = true;
          } catch (error) {
            task.warnings.push('文件已保存，但未能自动打开 Adobe：' + String(error.message || error).slice(0, 240));
          }
        }
        task.status = 'ready'; task.stage = 'complete'; task.progress = 100;
        task.message = kind.toUpperCase() + ' 已保存到项目，可在画布中继续编辑' + (opened ? '，已打开 Adobe' : '');
  }

  async function prepareRun(task, body, signal) {
      signal?.throwIfAborted();
      if(task.analysisStrategy==='dense'&&task.imageGeometryVersion===1){
        const plan=await refineLayerSourceRegions(ctx,{...task,elements:body.elements||task.elements},pixel,signal);
        body={...body,elements:plan.elements};task.imageGeometryVersion=plan.version;
      }
      let elements = normalizeLayerElements(body.elements || task.elements, task.width, task.height);
      if(task.reconstruction==='complete')elements=completeLayerPlan(elements);
      if(task.analysisStrategy==='dense'&&task.reconstruction!=='complete'){
        const resolved=denseSourceStructure(elements);elements=normalizeLayerElements(resolved.elements,task.width,task.height);
        task.analysisWarnings=[...new Set([...(task.analysisWarnings||[]),...resolved.warnings])];
      }
      if (!task.flat && task.reconstruction!=='complete' && elements.some(e=>e.enabled && e.type==='text' &&
        (/\r|\n/.test(e.text) || (!e.nativeText && e.textMode!=='image' && !e.sourceTextFallback && task.autoRefine)))) {
        // Old paused tasks and edited fonts use the same automatic local policy
        // as new tasks, without another vision or image-generation request.
        const previous=task.elements;task.elements=elements;
        try { await calibrate(task,{editableText:body.editableText ?? task.editableText ?? true,fontPolicy:body.fontPolicy||task.quality?.fontPolicy||'substitute'},signal);elements=task.elements; }
        catch(error) {
          signal?.throwIfAborted();
          elements=elements.map(e=>e.type==='text'?{...e,nativeText:false,fontAccepted:false,sourceTextFallback:true}:e);
          task.quality=automaticLayerQuality({issues:[{code:'calibration-failed',severity:'review',message:'文字校准未完成，已保留原字形区域：'+String(error.message||error).slice(0,400)}]});
        }
        finally { task.elements=previous; }
      }
      if (!task.flat) {
        const structured = await pixel({ operation:'structure', input:task.source, elements },signal);
        elements = normalizeLayerElements(structured.elements,task.width,task.height);
        task.structureChanges = structured.structureChanges || []; task.structureVersion=1;
      }
      if (elements.some(e => e.enabled && e.geometryIssues?.length)) throw new Error('元素尺寸或坐标无效，请重新分析或修正后再提取');
      task.quality=automaticLayerQuality(task.quality);
      if (hasBlockingLayerQuality(task.quality)) throw new Error('图层结构存在无效数据，无法生成：'+task.quality.issues.filter(i=>['error','review'].includes(i.severity)).map(i=>i.message||i.code).join('；'));
      const supplied = body.imageSettingsOverride || {};
      const settings = { ...await settingsFor(), dshCodexModel: dshCodexImageModel(ctx),
        ...Object.fromEntries(['apiBaseUrl', 'apiModel', 'dshCodexModel'].filter(k => typeof supplied[k] === 'string' && supplied[k].length < 1000).map(k => [k, supplied[k]])) };
      signal?.throwIfAborted();
      const engine = body.engine || settings.engine;
      if (!['api', 'dsh-codex'].includes(engine)) throw new Error('请在画布设置中选择有效的图像引擎');
      const old = new Map(task.elements.map(e => [e.id, e]));
      // Explicit font choices are validated by the real renderer. Changing a
      // font must not silently replace it with the inferred source candidate.
      for(const e of elements)if(e.type==='text'&&e.nativeText&&!e.fontAccepted)e.fontAccepted=true;
      const selected = elements.map(e => ({ id: e.id, type: e.type, description: e.description, text: e.text, x: e.x, y: e.y, width: e.width, height: e.height,
        extractionMode:e.extractionMode,visualKind:e.visualKind,shadowMode:e.shadowMode,
        ...(e.nativeText ? { nativeText: true, cleanupBounds: e.cleanupBounds } : {}) }));
      const backgroundSelectionKey=hash([...selected].sort((a,b)=>a.id.localeCompare(b.id)));
      const removalKey=list=>hash(list.filter(e=>e.type==='image'||e.type==='shape').map(e=>({id:e.id,type:e.type,description:e.description,enabled:e.enabled,x:e.x,y:e.y,width:e.width,height:e.height,revision:e.revision,extractionMode:e.extractionMode,visualKind:e.visualKind,shadowMode:e.shadowMode})).sort((a,b)=>a.id.localeCompare(b.id)));
      for (const e of elements) {
        // Layer ordering is assembly metadata; moving a layer must not buy
        // another extraction of the same pixels.
        const { z, status, revision, ...appearance } = e;
        if (revision) appearance.revision = revision;
        const key = hash({ pipeline: 'layers-v1', source: task.sourceHd?.fingerprint||task.sourceHash, engine, model: engine === 'api' ? settings.apiModel : settings.dshCodexModel,
          element: appearance, ...(e.type === 'background' ? { selected: [...selected].sort((a, b) => a.id.localeCompare(b.id)) } : {}) });
        const previous = old.get(e.id);
        e.assetKey = key;
        if(previous?.requestState==='unknown')e.requestState='unknown';
        if (e.type === 'background' && previous?.rawFile && removalKey(task.elements)===removalKey(elements) && previous.description===e.description && previous.revision===e.revision && task.engine===engine && task.imageModel===(engine==='api'?settings.apiModel:settings.dshCodexModel) && isPathWithin(task.directory,previous.rawFile)) e.reusedRawFile=previous.rawFile;
        if (previous?.assetKey === key) Object.assign(e, { file: previous.file, rawFile: previous.rawFile, status: previous.status, requestState: previous.requestState,
          extractionEngine: previous.extractionEngine,nativePreviewSignature:previous.nativePreviewSignature, enhancedFile:previous.enhancedFile,enhancementCheck:previous.enhancementCheck,platePrepared: previous.platePrepared, plateVersion: previous.plateVersion, alignment: previous.alignment, actualPixels: previous.actualPixels, returnedFraming: previous.returnedFraming, placementQualityIssues: previous.placementQualityIssues, assetTime: previous.assetTime, contentFile: previous.contentFile, bounds: previous.bounds });
      }
      if (!body.retryUnknown && elements.some(e => e.enabled && e.requestState === 'unknown')) throw new Error('有请求结果未知，请先核对服务记录；确认仍需重试时勾选“接受未知请求可能重复消耗额度”');
      task.elements = elements; task.engine = engine; task.retryUnknown = body.retryUnknown === true;
      task.backgroundSelectionKey=backgroundSelectionKey;
      const maximum = body.maxImageRequests === undefined ? (task.generationAttempts || 0) + 40 : Number(body.maxImageRequests);
      if (!Number.isInteger(maximum) || maximum < 0 || maximum > 10000) throw new Error('图像请求上限应为0至10000的整数');
      task.maxImageRequests = maximum;
      task.imageModel = engine === 'api' ? settings.apiModel : settings.dshCodexModel;
      task.localOnly = body.localOnly === true;
      task.autoExportFormat = ['ai', 'psd', 'svg'].includes(body.autoExportFormat) ? body.autoExportFormat : '';
      task.openAfterExport = body.openAfterExport === true;
      task.qualityAcknowledged = body.acceptQualityIssues === true;
      task.warnings = [...(task.analysisWarnings || task.warnings.filter(w => !/部分素材由本地抠图|由 \d+×\d+ 等比适配/.test(w)))];
      task.exports = []; task.preview = ''; task.status = 'running'; task.stage = 'extract'; task.error = ''; task.progress = 0; task.message = '开始逐元素提取，已成功素材会复用';
      return settings;
  }
  async function validateAssembly(task,settings,signal,order){
        const enabled=task.elements.filter(e=>e.enabled);
        const separateRasterText=async(refresh=false)=>{
          const confirmedNative=order.filter(e=>e.nativeText&&e.geometrySource==='source-ocr-token');
          for(const e of order.filter(e=>e.enabled&&e.type==='text'&&!e.nativeText)){
          if(refresh){await extract(task,e,settings,signal);const crop=await pixel({operation:'crop-layer',input:e.file,output:e.contentFile},signal);e.bounds=crop.bounds;}
          delete e.excludedNativeIds;
          const a=e.bounds;
          const overlaps=confirmedNative.filter(n=>{const b=n.cleanupBounds||n;return a.x<b.x+b.width+3&&a.x+a.width>b.x-3&&a.y<b.y+b.height+3&&a.y+a.height>b.y-3;});
          if(!overlaps.length)continue;
          // Keep the original raster word, but remove the price/label that is
          // now represented by independent live type. Rectangle overlap alone
          // must not flatten that already-confirmed editable text.
          const masked=await pixel({operation:'exclude-native-text',input:e.file,output:e.file,elements:overlaps},signal);
          if(masked.empty){e.enabled=false;e.retainedInBackground=false;continue;}
          const crop=await pixel({operation:'crop-layer',input:e.file,output:e.contentFile},signal);e.bounds=crop.bounds;e.excludedNativeIds=overlaps.map(n=>n.id);e.assetTime=(await stat(e.contentFile)).mtimeMs;
        }
        };
        if(task.reconstruction!=='complete')await separateRasterText();
        let layoutIssues=checkLayerLayout(task.elements,task.width,task.height);
        const overlapping=new Set([...layoutIssues.flatMap(i=>[i.id,i.otherId]).filter(Boolean),...(task.sourcePlateFallbackIds||[])]);
        if(task.reconstruction==='complete'&&overlapping.size){
          await fixCompleteText(task,[...overlapping].filter(id=>task.elements.some(e=>e.id===id&&e.type==='text')),settings,signal,true);
          layoutIssues=checkLayerLayout(task.elements,task.width,task.height);
        }
        for (const e of order.filter(e=>task.reconstruction!=='complete'&&e.nativeText && overlapping.has(e.id))) {
          e.nativeText=false;e.fontAccepted=false;e.sourceTextFallback=true;
          await extract(task,e,settings,signal);
          const crop=await pixel({operation:'crop-layer',input:e.file,output:e.contentFile},signal);e.bounds=crop.bounds;
          e.assetTime=(await stat(e.contentFile)).mtimeMs;
          task.warnings.push('“'+e.name+'”文字排版超界或重叠，已自动改用原图文字区域，避免重复排版');
        }
        if(task.reconstruction!=='complete'&&order.some(e=>!e.nativeText&&overlapping.has(e.id)))await separateRasterText(true);
        let manifest = await recoverLocal(task, '图层装配', () => pixel({ operation: 'assemble', directory: task.directory, width: task.width, height: task.height, elements: enabled }, signal), signal);
        if(task.analysisStrategy==='dense'&&(overrides.readback||ctx.llm?.prepareCall)){
          const signature=hash({readbackRevision:4,image:hash(await readFile(manifest.preview))});
          if(task.assemblyCheck?.signature!==signature||task.assemblyCheck?.complete===false||task.assemblyCheck?.verified===false){
            for(let visualPass=0;visualPass<(task.reconstruction==='complete'?3:2);visualPass++){
            task.stage='verification';task.message='正在对照原图检查装配后的文字、价格和版式…';await save(task);
            try{
              const discardExactCopies=async input=>{
                const checked=partitionReadbackTypography(task.elements,input,task.quality?.fontPolicy||'substitute');
                const copies=task.elements.filter(e=>!e.excludedNativeIds?.length&&checked.issues.some(i=>i.id===e.id)&&((e.type==='text'&&!e.nativeText)||(e.sourceRegion&&!e.enhancedFile)));
                if(!copies.length)return checked;
                const result=await pixel({operation:'verify-source-regions',source:task.source,input:manifest.preview,elements:copies},signal);
                return {...checked,issues:checked.issues.filter(i=>!(result.exact||[]).includes(i.id)),exactSourceIds:result.exact||[]};
              };
              const checked=await discardExactCopies(await (overrides.readback||inspectLayerReadback)(ctx,task,manifest.preview,AbortSignal.any([signal,AbortSignal.timeout(240000)]),{pixel}));
              await writeFile(join(task.directory,'assembly-check.json'),JSON.stringify(checked,null,2));
              const repaired=[];
              const restoreIssues=async issues=>{const restored=[],targets=new Map();
              if(task.reconstruction==='complete')for(const issue of issues.filter(i=>i.kind==='missing-text')){
                let e=task.elements.find(e=>(e.type==='text'||e.unresolvedAsGlyph)&&(()=>{const b=e.recognitionBounds||e;const area=Math.max(0,Math.min(b.x+b.width,issue.x+issue.width)-Math.max(b.x,issue.x))*Math.max(0,Math.min(b.y+b.height,issue.y+issue.height)-Math.max(b.y,issue.y));return area>Math.min(b.width*b.height,issue.width*issue.height)*.5;})());
                if(!e){
                  if(task.elements.length>=320)throw new Error('补漏文字超过总图层上限，已保留核验清单');
                  e={id:issue.id,type:'text',name:'补漏文字 '+issue.id,text:issue.text||'待核对',enabled:true,z:200,fontSize:Math.max(8,issue.height),fontPostScript:'AlibabaPuHuiTi_3_55_Regular',color:'#111111',textAlign:'left',assetKey:hash(issue),status:'pending'};
                  task.elements.push(e);
                }
                for(const key of ['x','y','width','height'])e[key]=issue[key];e.recognitionBounds=Object.fromEntries(['x','y','width','height'].map(k=>[k,e[k]]));e.enabled=true;e.type='text';e.nativeText=false;delete e.embeddedInMaterial;delete e.unresolvedAsGlyph;if(e.typographyKind==='unreadable')delete e.typographyKind;
                if(!enabled.includes(e))enabled.push(e);if(!order.includes(e))order.push(e);issue.id=e.id;
              }
              for(const issue of issues){
                const e=task.elements.find(e=>e.enabled&&e.id===issue.id);if(!e||e.type==='background')continue;
                targets.set(e.id,issue.reason);
                const a=e.bounds||e;
                for(const n of task.elements.filter(n=>n.enabled&&n.nativeText&&n.id!==e.id)){
                  const b=n.bounds||n;if(e.excludedNativeIds?.includes(n.id)||(a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y))targets.set(n.id,issue.reason);
                }
              }
              for(const [id,reason] of targets){
                const e=task.elements.find(e=>e.id===id);
                if(task.reconstruction==='complete'&&e.type==='text')continue;
                if(task.reconstruction==='complete'&&e.type==='image'&&e.extractionMode==='cutout'){
                  e.useOriginalRegion=true;e.assetKey=hash({previous:e.assetKey,originalRepair:true});
                  await extract(task,e,settings,signal);const crop=await pixel({operation:'crop-layer',input:e.file,output:e.contentFile},signal);e.bounds=crop.bounds;restored.push(e.id);continue;
                }
                if(e.type==='text'){e.nativeText=false;e.fontAccepted=false;e.sourceTextFallback=true;}
                else if(e.type==='shape'||e.enhancedFile){e.type='image';e.sourceRegion=true;e.modeLocked=true;e.extractionMode='photo';e.resolutionPolicy='preserve';delete e.enhancedFile;e.enhancementCheck={accepted:false,reason};}
                else continue;
                await extract(task,e,settings,signal);
                const crop=await pixel({operation:'crop-layer',input:e.file,output:e.contentFile},signal);e.bounds=crop.bounds;e.assetTime=(await stat(e.contentFile)).mtimeMs;
                restored.push(e.id);task.warnings.push('“'+e.name+'”装配对照发现问题，已自动保留原图区域：'+reason);
              }
              if(task.reconstruction==='complete')restored.push(...await fixCompleteText(task,[...targets.keys()].filter(id=>task.elements.some(e=>e.id===id&&e.type==='text')),settings,signal,true));
              if(restored.length){
                if(task.reconstruction!=='complete')await separateRasterText(true);
                const bg=task.elements.find(e=>e.enabled&&e.type==='background');await extract(task,bg,settings,signal);const crop=await pixel({operation:'crop-layer',input:bg.file,output:bg.contentFile},signal);bg.bounds=crop.bounds;
                manifest=await pixel({operation:'assemble',directory:task.directory,width:task.width,height:task.height,elements:enabled},signal);
              }
              repaired.push(...restored);return restored;};
              await restoreIssues(checked.issues);
              let finalCheck=checked;
              if(repaired.length)finalCheck=await discardExactCopies(await (overrides.readback||inspectLayerReadback)(ctx,task,manifest.preview,AbortSignal.any([signal,AbortSignal.timeout(240000)]),{pixel}));
              let finalSourceFallback=[];
              if(task.reconstruction!=='complete'&&visualPass===1&&finalCheck.issues.length){
                finalSourceFallback=await restoreIssues(finalCheck.issues);
                if(finalSourceFallback.length)finalCheck=await discardExactCopies(finalCheck);
              }
              task.assemblyCheck={signature:hash({readbackRevision:4,image:hash(await readFile(manifest.preview))}),issues:checked.issues,repaired:[...new Set(repaired)],finalSourceFallback,remainingIssues:finalCheck.issues,exactSourceIds:finalCheck.exactSourceIds||[],typographyNotes:finalCheck.typographyNotes||[],complete:finalCheck.complete!==false,incompleteRegions:finalCheck.incompleteRegions||[],verified:finalCheck.complete!==false&&finalCheck.issues.length===0};
              if(finalCheck.typographyNotes?.length)task.warnings.push(finalCheck.typographyNotes.length+' 处替代字体/字重差异已记录；原文字区域与内容仍通过，保留可编辑文字');
              if(finalCheck.complete===false)task.warnings.push('装配核验有未完成分区，已保留成功分区与说明；可原任务继续');
              if(finalCheck.issues.length)task.warnings.push('装配对照仍有 '+finalCheck.issues.length+' 项视觉差异，详情已保留在任务记录中');
            }catch(error){signal.throwIfAborted();task.assemblyCheck={signature:'',verified:false,complete:false,error:String(error.message||error)};task.warnings.push('装配视觉核验未完成，已保留文件与说明：'+String(error.message||error));}
            if(task.assemblyCheck?.verified)break;
            }
          }
        }
        const issues = [...new Map([...(task.quality?.issues || []).filter(i => i.severity === 'warning' && !['layer-content-bounds-review','background-size-adapted','covered-photo-region-local-fill','assembly-readback-difference'].includes(i.code)), ...layoutIssues,
          ...(task.assemblyCheck?.remainingIssues||[]).map(i=>({id:i.id,code:'assembly-readback-difference',severity:'warning',message:i.reason})),
          ...task.elements.flatMap(e => [...(e.backgroundQualityIssues || []), ...(e.placementQualityIssues || [])])].map(issue => [[issue.id,issue.otherId,issue.code].join(':'),issue])).values()];
        task.quality = automaticLayerQuality({ ...(task.quality || {}), issues });
        if(task.reconstruction==='complete'){
          task.completeness={...completeLayerAudit(task.elements),layoutIssues:checkLayerLayout(task.elements,task.width,task.height),verified:task.assemblyCheck?.verified===true};
          task.completeness.complete=task.completeness.complete&&!task.completeness.layoutIssues.length&&task.completeness.verified;
          if(!task.completeness.complete)throw new Error('完整拆分尚未通过：'+JSON.stringify(task.completeness)+'；已保留进度，不把部分拆分报告成完成');
        }
        task.preview = manifest.preview; task.status = 'ready'; task.stage = 'complete'; task.progress = 100;
        task.message = '独立图层已准备，可导出 AI、PSD 或 SVG；自动处理说明已保存';
        if (hasBlockingLayerQuality(task.quality)) {
          throw new Error('图层结构检查失败：'+task.quality.issues.filter(i=>['error','review'].includes(i.severity)).map(i=>i.message||i.code).join('；'));
        }
  }
  async function executeRun(task, settings, signal) {
        if(task.reconstruction==='complete'){
          const ids=task.elements.filter(e=>e.enabled&&e.type==='text'&&(!e.nativeText||e.sourceTextSupplement&&!e.contentVerified)).map(e=>e.id);
          await fixCompleteText(task,ids,settings,signal);deduplicateCompleteText(task.elements);
        }
        const enabled = task.elements.filter(e => e.enabled), order = [...enabled.filter(e => e.type !== 'background'), ...enabled.filter(e => e.type === 'background')];
        let done = 0;
        const processElement=async e=>{
          signal.throwIfAborted();
          task.stage = e.type === 'background' ? 'background' : 'extract'; task.message = '正在处理 ' + (done + 1) + '/' + order.length + '：' + e.name; await save(task);
          try {
            await recoverLocal(task, e.name, async () => {
              await extract(task, e, settings, signal);
              e.contentFile = join(task.directory, 'layers', e.id + '-' + safeImageName(e.name + '.png'));
              const crop = await pixel({ operation: 'crop-layer', input: e.file, output: e.contentFile }, signal); e.bounds = crop.bounds;
              if(e.extractionMode==='photo' && (crop.width!==undefined && (crop.width!==e.width || crop.height!==e.height || crop.alphaMin!==255))) throw new Error('完整照片的矩形边界或不透明背景校验失败：'+e.name);
              e.assetTime = (await stat(e.contentFile)).mtimeMs;
            }, signal, () => e.requestState !== 'unknown');
            done++;
          } catch (err) {
            signal.throwIfAborted(); e.status = 'failed'; e.error = String(err.message || err).slice(0,1200);
          }
          task.progress = Math.round(done / order.length * 90); await save(task);
        };
        if(task.reconstruction==='complete'){
          const foreground=order.filter(e=>e.type!=='background');let cursor=0;
          const outcomes=await Promise.allSettled(Array.from({length:Math.min(2,foreground.length)},async()=>{while(cursor<foreground.length)await processElement(foreground[cursor++]);}));
          const failure=outcomes.find(r=>r.status==='rejected');if(failure)throw failure.reason;
          for(const e of order.filter(e=>e.type==='background'))await processElement(e);
        }else for(const e of order)await processElement(e);
        const failed = order.filter(e => e.status !== 'complete');
        if (failed.length) throw new Error('已保存 '+done+'/'+order.length+' 个图层；以下步骤无法自动完成：'+failed.map(e => e.name+'：'+e.error).join('；').slice(0,1000));
        await validateAssembly(task,settings,signal,order);
        if (task.autoExportFormat) {
          signal.throwIfAborted(); task.status = 'running'; task.stage = 'export'; task.message = '正在自动导出 ' + task.autoExportFormat.toUpperCase() + '…'; await save(task);
          await recoverLocal(task, '导出文件', () => exportArtifact(task, task.autoExportFormat, signal, task.openAfterExport), signal);
        }
  }

  async function executeAnalysis(task,body,signal,automaticSettings=null) {
        if((task.enhanceSource||task.reconstruction==='complete')&&!task.sourceFacts&&ctx.llm?.prepareCall){
          task.message='正在从原图核实主品牌，防止高清重绘换成其他品牌…';await save(task);
          task.sourceFacts=await identifySourceBrands(ctx,task,signal);await writeFile(join(task.directory,'source-identity.json'),JSON.stringify(task.sourceFacts,null,2));
        }
        if(task.enhanceSource&&!task.sourceHd?.prepared){
          const settings=automaticSettings||{...await settingsFor(),dshCodexModel:dshCodexImageModel(ctx)};
          task.engine=body.engine||settings.engine;task.imageModel=task.engine==='dsh-codex'?settings.dshCodexModel:settings.apiModel;
          task.stage='enhancement';task.message='正在生成高清识别母版，原图继续用于内容核对…';await save(task);
          await prepareLayerSourceHd(task,settings,signal,{ctx,pixel,generate,save});
        }
        const result = body.flat ? { elements: [{ id: 'original', type: 'background', name: '原图（普通PSD转换）', x: 0, y: 0, width: task.width, height: task.height }], warnings: [] }
          : await analyze(ctx, { bytes: await readFile(task.analysisSource||task.source), mime: 'image/png' }, body, task.width, task.height, AbortSignal.any([signal, AbortSignal.timeout(900000)]),{
            directory:task.directory,
            ocr:signal=>runLayerRefinementScript(h,{input:task.analysisSource||task.source,lang:'chi_sim+eng',psm:'11'},signal,'ocr_image.py'),
            crop:(region,signal)=>pixel({operation:'analysis-crop',input:task.analysisSource||task.source,output:region.output,region,exclude:region.exclude||[]},signal),
            refineImages:(elements,signal)=>refineLayerSourceRegions(ctx,{...task,elements},pixel,signal),
            progress:async value=>{task.analysisProgress=value;task.stage='analysis';task.message=value.message;task.progress=4;await save(task);}
          });
        signal.throwIfAborted();
        task.elements = normalizeLayerElements(result.elements, task.width, task.height);
        for(const e of task.elements)if(e.type==='text')e.recognitionBounds={x:e.x,y:e.y,width:e.width,height:e.height};
        task.analysisWarnings = result.warnings || []; task.warnings = [...task.analysisWarnings]; task.analysisAttempts = result.analysisAttempts || (body.flat ? 0 : 1);
        task.semanticPolicyVersion=result.semanticPolicyVersion||1;
        task.analysisComplete=true;task.analysisStrategy=result.analysisStrategy||'whole';
        task.imageGeometryVersion=result.imageGeometryVersion||0;
        if (result.rawAnalysis) await writeFile(join(task.directory, 'model-analysis.json'), JSON.stringify(result.rawAnalysis, null, 2));
        if (task.autoRefine && !body.flat) {
          task.stage = 'calibration'; task.message = '正在校准原图文字位置、候选字体和基线…'; await save(task);
          try { await calibrate(task, {...body,editableText:task.editableText}, signal); }
          catch (error) {
            signal.throwIfAborted();
            task.elements=task.elements.map(e=>e.type==='text'?{...e,nativeText:false,fontAccepted:false,sourceTextFallback:true}:e);
            task.quality=automaticLayerQuality({issues:[{code:'calibration-failed',severity:'review',message:'本地文字校准未完成，已自动保留原字形区域：'+String(error.message||error).slice(0,400)}]});
          }
        }
        task.status = task.automatic ? 'running' : 'review'; task.stage = task.automatic ? 'preparing' : 'review'; task.progress = task.automatic ? 10 : 100;
        task.message = task.automatic ? '已建立原图坐标清单，正在自动处理图层' : '已建立清单，可调整或直接生成';
        if (task.automatic) {
          if (hasBlockingLayerQuality(task.quality)) {
            task.status = 'needs_review'; task.stage = 'quality'; task.message = '图层结构存在无效数据，已保留原因，请重新分析'; return;
          }
          automaticSettings=automaticSettings||{...await settingsFor(),dshCodexModel:dshCodexImageModel(ctx)};
          const imageSettingsOverride = {...Object.fromEntries(['apiBaseUrl','apiModel','dshCodexModel'].map(key => [key,automaticSettings[key]])),...(body.imageSettingsOverride||{})};
          const settings = await prepareRun(task, { ...body,elements:undefined, storageScope: undefined, engine: body.engine || automaticSettings.engine, imageSettingsOverride },signal);
          await save(task); await executeRun(task, settings, signal);
        }
  }

  return {
    async analyze(body) {
      body = workspaceScope(body);
      const automaticSettings = body.autoRun === true || body.enhanceSource === true || body.referenceImageData ? { ...await settingsFor(), dshCodexModel: dshCodexImageModel(ctx) } : null;
      const uploaded = decodeImageData(body.imageData);
      if (!uploaded) throw new Error('图片数据无效或超过32MB');
      if (!body.flat && (!body.provider || !body.model)) throw new Error('请先在聊天输入区选择支持图片的模型');
      const id = 'layers-' + Date.now().toString(36) + '-' + randomBytes(6).toString('hex'), directory = directoryFor(body, id);
      await mkdir(join(directory, 'assets'), { recursive: true });
      const input = join(directory, 'source.original'), source = join(directory, 'source.png');
      await writeFile(input, uploaded.bytes, { flag: 'wx' });
      const dimensions = await pixel({ operation: 'inspect', input, output: source });
      const maximum=Number(body.maxImageRequests??40);if(!Number.isInteger(maximum)||maximum<0||maximum>10000)throw new Error('图像请求上限无效');
      const task = { schema: 1, id, directory, source,reconstruction:body.reconstruction==='complete'?'complete':'preserve',enhanceSource:body.enhanceSource===true||!!body.referenceImageData,maxImageRequests:maximum,localOnly:body.localOnly===true, sourceHash: hash(uploaded.bytes), name: safeImageName(body.name || '画布图片.png'),
        width: dimensions.width, height: dimensions.height, sourceCheckerboard: dimensions.checkerboard === true, status: 'running', stage: 'analysis', message: '正在分析图层与前后关系…', progress: 3,
        createdAt: Date.now(), elements: [], exports: [], warnings: [], error: '', generationAttempts: 0,
        analysisModel: body.flat ? null : { provider: body.provider, model: body.model, reasoningEffort: body.reasoningEffort || '' },
        analysisComplete:false,analysisOptions:{reconstruction:body.reconstruction==='complete'?'complete':'preserve',editableText:body.editableText!==false,fontPolicy:body.fontPolicy||'substitute',localOnly:body.localOnly===true},
        automatic: body.autoRun === true, autoRefine: body.autoRefine === true, editableText:body.editableText!==false, flat: body.flat === true, workspaceRoot: body.storageScope === 'workspace' ? body.cwd : projectDirectory(body.cwd, body.project) };
      if(body.referenceImageData){
        const reference=decodeImageData(body.referenceImageData);if(!reference)throw new Error('原图参考数据无效');
        const raw=join(directory,'reference.original'),canonical=join(directory,'reference-original.png');await writeFile(raw,reference.bytes,{flag:'wx'});await pixel({operation:'inspect',input:raw,output:canonical});
        task.referenceSource=canonical;task.referenceSourceHash=hash(reference.bytes);task.suppliedHdSource=source;
      }
      cache.set(directory, task);
      start(task,signal=>executeAnalysis(task,body,signal,automaticSettings));
      return present(task);
    },
    async get(body) { return present(await load(body, body.id)); },
    async list(body) {
      let dirs; try { dirs = await readdir(baseFor(body), { withFileTypes: true }); } catch { return []; }
      const tasks = [];
      for (const d of dirs.filter(d => d.isDirectory() && validId(d.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 30)) {
        try { tasks.push(present(await load(body, d.name))); } catch { /* One damaged manifest must not hide other tasks. */ }
      }
      return tasks.sort((a, b) => b.createdAt - a.createdAt);
    },
    async run(body) {
      const task = await load(body, body.id); ensureIdle(task);
      if(!task.elements.length && task.analysisModel && !task.flat){
        task.automatic=true;task.status='running';task.stage='analysis';task.error='';task.message='正在恢复原任务的结构与文字分区分析…';
        const options={...(task.analysisOptions||{editableText:task.editableText!==false,fontPolicy:'substitute'}),...task.analysisModel,...body,autoRun:true};
        task.autoRefine=true;start(task,signal=>executeAnalysis(task,options,signal));return present(task);
      }
      const controller=new AbortController();preparing.set(task.directory,controller);
      let settings;
      task.status='running';task.stage='preparing';task.error='';task.message='正在准备原任务，已有图层和高清分区会复用';await save(task);
      try { settings = await prepareRun(task, body,controller.signal); }
      catch(error){task.status=controller.signal.aborted?'cancelled':'failed';task.stage=task.status==='cancelled'?'cancelled':'error';task.error=controller.signal.aborted?'':String(error.message||error);task.message=task.error||'已取消准备，成功素材保留';await save(task);throw error;}
      finally { preparing.delete(task.directory); }
      start(task, signal => executeRun(task, settings, signal));
      return present(task);
    },
    async cancel(body) {
      const task = await load(body, body.id);
      preparing.get(task.directory)?.abort(new Error('用户取消拆层任务'));
      active.get(task.directory)?.controller.abort(new Error('用户取消拆层任务'));
      task.status = 'cancelled'; task.stage = 'cancelled'; task.message = '已请求停止后续操作，正在收尾的本地步骤和已返回素材会保留';
      await save(task); return present(task);
    },
    async export(body) {
      const task = await load(body, body.id); ensureIdle(task);
      task.quality=automaticLayerQuality(task.quality);
      if (hasBlockingLayerQuality(task.quality)) throw new Error('图层结构存在无效数据，无法导出，请重新分析');
      if (!['ai', 'psd', 'svg'].includes(body.format)) throw new Error('请选择 AI、PSD 或 SVG 格式');
      if (!task.elements.length || task.elements.some(e => e.enabled && (e.status !== 'complete' || !e.file))) throw new Error('请先完成所有已选图层的提取');
      task.status = 'running'; task.stage = 'export'; task.progress = 10; task.error = ''; task.message = '正在生成 ' + body.format.toUpperCase() + ' 文件…';
      start(task, async signal => {
        await recoverLocal(task, '导出文件', () => exportArtifact(task, body.format, signal, body.openAfterExport === true), signal);
      });
      return present(task);
    },
    async refine(body) {
      const task = await load(body, body.id); ensureIdle(task); task.autoRefine = true;
      task.status = 'running'; task.stage = 'calibration'; task.message = '正在按原图重新校准文字和布局…';
      start(task, async signal => {
        if(task.analysisStrategy==='dense'&&task.imageGeometryVersion!==2&&ctx.llm?.prepareCall){
          task.message='正在按局部原像素复查完整商品边界…';await save(task);
          try{const plan=await refineLayerSourceRegions(ctx,task,pixel,signal);task.elements=plan.elements;task.imageGeometryVersion=plan.version;task.analysisWarnings=[...(task.analysisWarnings||[]),...plan.warnings];}
          catch(error){signal.throwIfAborted();task.warnings.push('局部商品边界复查未完成：'+String(error.message||error));}
        }
        await calibrate(task, body, signal);
        task.status = 'review'; task.stage = 'review'; task.message = '校准完成，可直接生成；成功素材会按内容复用';
      });
      return present(task);
    },
    // Tests can await background work without exposing a test endpoint.
    async settled(body) { const dir = directoryFor(body, body.id); await active.get(dir)?.promise; return present(await load(body, body.id)); }
  };
}
