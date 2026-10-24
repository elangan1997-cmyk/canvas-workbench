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
import { calibrateLayeredAnalysis, checkLayerLayout, runLayerRefinementScript, hasBlockingLayerQuality } from './layered-image-refinement.js';

const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
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
  const active = new Map(), cache = new Map(), saves = new Map(), preparing = new Set();
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
  const present = task => ({ id: task.id, name: task.name, sourceHash: task.sourceHash, width: task.width, height: task.height,
    autoExportFormat: task.autoExportFormat, openAfterExport: task.openAfterExport, automatic: task.automatic === true, recoveryEvents: task.recoveryEvents || [],
    status: task.status, stage: task.stage, message: task.message, progress: task.progress, error: task.error || '',
    warnings: task.warnings || [], engine: task.engine || '', imageModel: task.imageModel || '', localOnly: task.localOnly === true, createdAt: task.createdAt, updatedAt: task.updatedAt,
    quality: task.quality ? { ...task.quality, reviewAcknowledged: task.qualityAcknowledged === true } : null, analysisModel: task.analysisModel || null, analysisAttempts: task.analysisAttempts || 0,
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
    for (const e of task.elements || []) for (const k of ['file', 'rawFile', 'reusedRawFile', 'contentFile']) if (e[k] && !isPathWithin(dir, e[k])) throw new Error('任务素材路径无效');
    if (task.status === 'running' && !active.has(dir)) {
      task.status = 'failed'; task.stage = 'error'; task.error = '应用上次关闭时任务尚未完成。已保留素材，可继续拆层；结果未知的请求需核对后再重试。';
      for (const e of task.elements || []) if (e.requestState === 'submitted') e.requestState = 'unknown';
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
    const result = overrides.calibrate ? await overrides.calibrate(task, options, signal) : await calibrateLayeredAnalysis(h, task, options, signal);
    task.elements = normalizeLayerElements(result.elements, task.width, task.height);
    task.quality = result.quality;
    task.analysisWarnings = [...new Set([...(task.analysisWarnings || []), ...(result.warnings || [])])].slice(0, 200);
    task.warnings = [...task.analysisWarnings];
  };

  const transientLocal = error => error?.localRetryable === true || ['EAGAIN','EBUSY','EIO','EMFILE','ENFILE','EPIPE'].includes(error?.code);
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
    if (e.type === 'shape' || e.extractionMode === 'photo') {
      const local = await pixel({ operation:'render-structure',input:task.source,output,element:e,elements:task.elements },signal);
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
    if (await exists(output) && !(e.type === 'background' && e.plateVersion !== 3 && await exists(raw))) {
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
        if (checked.aligned) { e.alignment = checked.aligned; task.warnings.push('“' + e.name + '”已按原图区域回位，请核对边缘与字号'); }
        if (e.type === 'background') {
          if (!e.platePrepared) { await pixel({ operation: 'background-plate', source: task.source, input: output, output, elements: task.elements }, signal); e.platePrepared = true; e.plateVersion = 3; }
          await cleanPlate(task, e, signal);
        }
        return;
      }
    }
    if (e.nativeText) {
      await pixel({ operation: 'text', width: task.width, height: task.height, element: { ...e, geometry: textLayerGeometry(e) }, output }, signal);
      e.file = output; e.status = 'complete'; e.requestState = 'local'; return;
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
        const result = await generate({ ctx, image: await readFile(task.source), prompt: extractionPrompt(e, task.elements, task.width, task.height),
          engine: task.engine, signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]),
          background: e.type === 'background' ? 'opaque' : 'transparent', maxAttempts: 1, settingsOverride: settings });
        // Retain a returned result even when cancellation races the response.
        await writeFile(raw, result.bytes, { flag: 'wx' });
        e.rawFile = raw; e.requestState = 'returned'; await save(task);
      } catch (error) {
        e.requestState = 'unknown'; e.status = 'failed'; e.error = String(error?.message || error); await save(task); throw error;
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
    if (e.type === 'background') { await pixel({ operation: 'background-plate', source: task.source, input: output, output, elements: task.elements }, signal); e.platePrepared = true; e.plateVersion = 3; }
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
        const prepared = task.elements.map(e => ({ ...e, ...(e.nativeText ? { geometry: textLayerGeometry(e) } : {}) }));
        const manifest = await pixel({ operation: 'assemble', directory: task.directory, width: task.width, height: task.height, elements: prepared }, signal);
        const signature = hash({exporterRevision:2,layers:prepared.map(e => ({ id:e.id, assetKey:e.assetKey, z:e.z, enabled:e.enabled, bounds:e.bounds })),composite:hash(await readFile(manifest.composite))});
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
              const file = join(work, 'layer-' + i + '.png'); await copyFile(b.contentFile || b.file, file); elements.push({ ...b, file });
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

  async function prepareRun(task, body) {
      let elements = normalizeLayerElements(body.elements || task.elements, task.width, task.height);
      if (!task.flat) {
        const structured = await pixel({ operation:'structure', input:task.source, elements });
        elements = normalizeLayerElements(structured.elements,task.width,task.height);
        task.structureChanges = structured.structureChanges || []; task.structureVersion=1;
      }
      if (elements.some(e => e.enabled && e.geometryIssues?.length)) throw new Error('元素尺寸或坐标无效，请重新分析或修正后再提取');
      if (hasBlockingLayerQuality(task.quality) && !body.acceptQualityIssues) throw new Error('校准问题尚未核对，请复核问题或重新校准后继续');
      const supplied = body.imageSettingsOverride || {};
      const settings = { ...await settingsFor(), dshCodexModel: dshCodexImageModel(ctx),
        ...Object.fromEntries(['apiBaseUrl', 'apiModel', 'dshCodexModel'].filter(k => typeof supplied[k] === 'string' && supplied[k].length < 1000).map(k => [k, supplied[k]])) };
      const engine = body.engine || settings.engine;
      if (!['api', 'dsh-codex'].includes(engine)) throw new Error('请在画布设置中选择有效的图像引擎');
      const old = new Map(task.elements.map(e => [e.id, e]));
      const selected = elements.map(e => ({ id: e.id, type: e.type, description: e.description, text: e.text, x: e.x, y: e.y, width: e.width, height: e.height,
        ...(e.nativeText ? { nativeText: true, cleanupBounds: e.cleanupBounds } : {}) }));
      for (const e of elements) {
        // Layer ordering is assembly metadata; moving a layer must not buy
        // another extraction of the same pixels.
        const { z, status, revision, ...appearance } = e;
        if (revision) appearance.revision = revision;
        const key = hash({ pipeline: 'layers-v1', source: task.sourceHash, engine, model: engine === 'api' ? settings.apiModel : settings.dshCodexModel,
          element: appearance, ...(e.type === 'background' ? { selected: [...selected].sort((a, b) => a.id.localeCompare(b.id)) } : {}) });
        const previous = old.get(e.id);
        e.assetKey = key;
        if (e.type === 'background' && previous?.rawFile && previous.description===e.description && previous.revision===e.revision && task.engine===engine && task.imageModel===(engine==='api'?settings.apiModel:settings.dshCodexModel) && isPathWithin(task.directory,previous.rawFile)) e.reusedRawFile=previous.rawFile;
        if (previous?.assetKey === key) Object.assign(e, { file: previous.file, rawFile: previous.rawFile, status: previous.status, requestState: previous.requestState,
          extractionEngine: previous.extractionEngine, platePrepared: previous.platePrepared, plateVersion: previous.plateVersion, alignment: previous.alignment, actualPixels: previous.actualPixels, returnedFraming: previous.returnedFraming, placementQualityIssues: previous.placementQualityIssues, assetTime: previous.assetTime, contentFile: previous.contentFile, bounds: previous.bounds });
      }
      if (!body.retryUnknown && elements.some(e => e.enabled && e.requestState === 'unknown')) throw new Error('有请求结果未知，请先核对服务记录；确认仍需重试时勾选“接受未知请求可能重复消耗额度”');
      task.elements = elements; task.engine = engine; task.retryUnknown = body.retryUnknown === true;
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
  async function executeRun(task, settings, signal) {
        const enabled = task.elements.filter(e => e.enabled), order = [...enabled.filter(e => e.type !== 'background'), ...enabled.filter(e => e.type === 'background')];
        let done = 0;
        for (const e of order) {
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
        }
        const failed = order.filter(e => e.status !== 'complete');
        if (failed.length) throw new Error('已保存 '+done+'/'+order.length+' 个图层；以下步骤无法自动完成：'+failed.map(e => e.name+'：'+e.error).join('；').slice(0,1000));
        const manifest = await recoverLocal(task, '图层装配', () => pixel({ operation: 'assemble', directory: task.directory, width: task.width, height: task.height, elements: enabled }, signal), signal);
        const issues = [...new Map([...(task.quality?.issues || []).filter(i => i.severity === 'warning' && !['layer-content-bounds-review','background-size-adapted','covered-photo-region-local-fill'].includes(i.code)), ...checkLayerLayout(task.elements, task.width, task.height),
          ...task.elements.flatMap(e => [...(e.backgroundQualityIssues || []), ...(e.placementQualityIssues || [])])].map(issue => [[issue.id,issue.otherId,issue.code].join(':'),issue])).values()];
        task.quality = { ...(task.quality || {}), status: issues.some(i => ['error', 'review'].includes(i.severity)) ? 'needs_review' : 'passed', issues };
        task.preview = manifest.preview; task.status = 'ready'; task.stage = 'complete'; task.progress = 100;
        task.message = '独立图层已准备，请逐层检查后导出 AI、PSD 或 SVG';
        if (task.quality.status === 'needs_review' && !task.qualityAcknowledged) {
          task.status = 'needs_review'; task.stage = 'quality'; task.message = '素材已保存，但背景或排版仍需核对，尚未自动导出'; return;
        }
        if (task.autoExportFormat) {
          signal.throwIfAborted(); task.status = 'running'; task.stage = 'export'; task.message = '正在自动导出 ' + task.autoExportFormat.toUpperCase() + '…'; await save(task);
          await recoverLocal(task, '导出文件', () => exportArtifact(task, task.autoExportFormat, signal, task.openAfterExport), signal);
        }
  }

  return {
    async analyze(body) {
      body = workspaceScope(body);
      const automaticSettings = body.autoRun === true ? { ...await settingsFor(), dshCodexModel: dshCodexImageModel(ctx) } : null;
      const uploaded = decodeImageData(body.imageData);
      if (!uploaded) throw new Error('图片数据无效或超过32MB');
      if (!body.flat && (!body.provider || !body.model)) throw new Error('请先在聊天输入区选择支持图片的模型');
      const id = 'layers-' + Date.now().toString(36) + '-' + randomBytes(6).toString('hex'), directory = directoryFor(body, id);
      await mkdir(join(directory, 'assets'), { recursive: true });
      const input = join(directory, 'source.original'), source = join(directory, 'source.png');
      await writeFile(input, uploaded.bytes, { flag: 'wx' });
      const dimensions = await pixel({ operation: 'inspect', input, output: source });
      const task = { schema: 1, id, directory, source, sourceHash: hash(uploaded.bytes), name: safeImageName(body.name || '画布图片.png'),
        width: dimensions.width, height: dimensions.height, sourceCheckerboard: dimensions.checkerboard === true, status: 'running', stage: 'analysis', message: '正在分析图层与前后关系…', progress: 3,
        createdAt: Date.now(), elements: [], exports: [], warnings: [], error: '', generationAttempts: 0,
        analysisModel: body.flat ? null : { provider: body.provider, model: body.model, reasoningEffort: body.reasoningEffort || '' },
        automatic: body.autoRun === true, autoRefine: body.autoRefine === true, flat: body.flat === true, workspaceRoot: body.storageScope === 'workspace' ? body.cwd : projectDirectory(body.cwd, body.project) };
      cache.set(directory, task);
      start(task, async signal => {
        const result = body.flat ? { elements: [{ id: 'original', type: 'background', name: '原图（普通PSD转换）', x: 0, y: 0, width: task.width, height: task.height }], warnings: [] }
          : await analyze(ctx, { bytes: await readFile(source), mime: 'image/png' }, body, task.width, task.height, AbortSignal.any([signal, AbortSignal.timeout(480000)]));
        signal.throwIfAborted();
        task.elements = normalizeLayerElements(result.elements, task.width, task.height);
        task.analysisWarnings = result.warnings || []; task.warnings = [...task.analysisWarnings]; task.analysisAttempts = result.analysisAttempts || (body.flat ? 0 : 1);
        if (result.rawAnalysis) await writeFile(join(task.directory, 'model-analysis.json'), JSON.stringify(result.rawAnalysis, null, 2));
        if (task.autoRefine && !body.flat) {
          task.stage = 'calibration'; task.message = '正在校准原图文字位置、候选字体和基线…'; await save(task);
          try { await calibrate(task, body, signal); }
          catch (error) { signal.throwIfAborted(); task.quality = { status: 'needs_review', issues: [{ code: 'calibration-failed', severity: 'review', message: String(error.message || error).slice(0, 500) }] }; }
        }
        task.status = task.automatic ? 'running' : 'review'; task.stage = task.automatic ? 'preparing' : 'review'; task.progress = task.automatic ? 10 : 100;
        task.message = task.quality?.status === 'needs_review' ? '自动校准发现需复核的问题，尚未发起素材生成' : '已建立原图坐标清单，请核对元素、字体和前后关系';
        if (task.automatic) {
          if (hasBlockingLayerQuality(task.quality)) {
            task.status = 'needs_review'; task.stage = 'quality'; task.message = '自动校准发现无法可靠处理的内容，已保留清单和原因，未发起素材生成'; return;
          }
          const imageSettingsOverride = Object.fromEntries(['apiBaseUrl','apiModel','dshCodexModel'].map(key => [key,automaticSettings[key]]));
          const settings = await prepareRun(task, { ...body, storageScope: undefined, engine: body.engine || automaticSettings.engine, imageSettingsOverride });
          await save(task); await executeRun(task, settings, signal);
        }
      });
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
      preparing.add(task.directory);
      let settings;
      try { settings = await prepareRun(task, body); } finally { preparing.delete(task.directory); }
      start(task, signal => executeRun(task, settings, signal));
      return present(task);
    },
    async cancel(body) {
      const task = await load(body, body.id);
      active.get(task.directory)?.controller.abort(new Error('用户取消拆层任务'));
      task.status = 'cancelled'; task.stage = 'cancelled'; task.message = '已请求停止后续操作，正在收尾的本地步骤和已返回素材会保留';
      await save(task); return present(task);
    },
    async export(body) {
      const task = await load(body, body.id); ensureIdle(task);
      if (task.quality?.status === 'needs_review' && !body.acceptQualityIssues && !task.qualityAcknowledged) throw new Error('背景或排版问题尚未核对，未导出文件');
      if (body.acceptQualityIssues === true) task.qualityAcknowledged = true;
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
        await calibrate(task, body, signal);
        task.status = 'review'; task.stage = 'review'; task.message = task.quality?.status === 'needs_review' ? '有校准问题需要复核，请查看清单' : '校准完成，继续处理时成功素材会按内容复用';
      });
      return present(task);
    },
    // Tests can await background work without exposing a test endpoint.
    async settled(body) { const dir = directoryFor(body, body.id); await active.get(dir)?.promise; return present(await load(body, body.id)); }
  };
}
