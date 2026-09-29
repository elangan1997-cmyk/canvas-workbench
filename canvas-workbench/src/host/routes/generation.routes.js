// 自 lib/index.js apply() 机械迁移（v1.8 Phase 2）：每个 handler 体逐字未改，
// 原来的 `if (pathname === … && req.method === …) { … }` 外壳由 router 负责。
import { dirname, join } from 'node:path';
import { runPythonSpec } from '../services/python-launch.js';
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolvePythonWithDeps } from '../../../lib/platform.js';
import { createHash } from 'node:crypto';
import { generateImage, readImageEngineSettings } from '../../../lib/image-engine.js';
import { parseQuery, readBody, respond } from '../server/http.js';
import { MAX_IMAGE_BYTES, cleanJobId, isImagePath, isRasterImagePath } from '../../shared/utils/image-types.js';
import { expandHome } from '../../shared/utils/paths.js';
import { decodeImageData, safeImageName, sourcePathFromImageUrl } from '../../shared/utils/data-url.js';
import { PLUGIN_ROOT } from '../vendor-assets.js';

export function register(router, h) {
  const { ctx, progressPathFor, projectDirectory, runProcess, runProcessWithTimeout, writeManagedImage, writeManagedSvg, writeProgressFile } = h;
  router.add({ method: 'POST', path: '/dsh-canvas/vectorize-image', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          let tempInput = '';
          let tempOutput = '';
          try {
            const body = JSON.parse(await readBody(req) || '{}');
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('当前聊天没有画布项目');
            const requestedBackend = ['auto', 'imagetracer', 'vtracer', 'vecto'].includes(String(body.backend || 'auto')) ? String(body.backend || 'auto') : 'auto';
            const vectorMode = ['auto', 'flat', 'full', 'silhouette'].includes(String(body.vectorMode || 'flat')) ? String(body.vectorMode || 'flat') : 'flat';
            const outputDir = join(projectDir, 'outputs', '.图片编辑临时');
            await mkdir(outputDir, { recursive: true });
            let sourcePath = typeof body.imagePath === 'string' && isRasterImagePath(body.imagePath) ? expandHome(body.imagePath) : '';
            if (sourcePath) {
              try {
                const info = await stat(sourcePath);
                // 空文件或超过单次上传上限都不能交给本地后端；若有 imageData，
                // 下面会自动回退到已上传的画布副本，避免 Rust 只报“找不到图片”。
                if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) sourcePath = '';
              } catch (err) { sourcePath = ''; }
            }
            const uploaded = decodeImageData(body.imageData);
            if (!sourcePath && uploaded) {
              tempInput = join(outputDir, '.vector-input-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.' + uploaded.ext);
              await writeFile(tempInput, uploaded.bytes);
              sourcePath = tempInput;
            }
            if (!isRasterImagePath(sourcePath)) throw new Error('当前图片无法转为矢量（仅支持 PNG/JPG/WebP/GIF/AVIF/BMP）');
            try {
              const info = await stat(sourcePath);
              if (!info.isFile() || info.size <= 0) throw new Error('输入图片尚未落盘，请稍后重试');
            } catch (err) {
              if (err && err.message === '输入图片尚未落盘，请稍后重试') throw err;
              throw new Error('输入图片不存在或无法读取');
            }
            const pluginRoot = PLUGIN_ROOT;
            const script = join(pluginRoot, 'scripts', 'vectorize_image.py');
            await access(script);
            tempOutput = join(outputDir, '.vectorized-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.svg');
            const python = await resolvePythonWithDeps(ctx);
            const result = await runPythonSpec(
              (executable, args, cwd, timeoutMs) => runProcessWithTimeout(executable, args, cwd, timeoutMs),
              python, script,
              { input: expandHome(sourcePath), output: tempOutput, backend: requestedBackend, vector_mode: vectorMode },
              { cwd: pluginRoot, timeoutMs: 360000 });
            const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
            let payload = null;
            try { payload = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch (err) { payload = null; }
            if (result.exitCode !== 0 || !payload || payload.success !== true || !payload.output) {
              throw new Error((payload && payload.error) || result.stderr.trim() || (result.timedOut ? '本地矢量化超时' : '本地矢量化失败'));
            }
            const svgText = await readFile(tempOutput, 'utf8');
            const originalName = safeImageName(body.name || '画布图片.png');
            const dot = originalName.lastIndexOf('.');
            const base = dot > 0 ? originalName.slice(0, dot) : originalName;
            const saved = await writeManagedSvg(projectDir, base + '-矢量.svg', svgText);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, image: saved, backend: payload.backend, engine: payload.engine, vectorMode: payload.vectorMode || vectorMode, reason: payload.reason, complexity: payload.complexity, quality: payload.quality, available: payload.available }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          } finally {
            if (tempInput) await unlink(tempInput).catch(() => {});
            if (tempOutput) await unlink(tempOutput).catch(() => {});
          }
          return;
  });

  router.add({ method: 'GET', path: '/dsh-canvas/remove-background-progress', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          const params = parseQuery(query);
          const projectDir = projectDirectory(params.cwd, params.project);
          const jobId = cleanJobId(params.jobId);
          if (!projectDir || !jobId) {
            respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: '无效的去背景任务' }));
            return;
          }
          const progressPath = progressPathFor(projectDir, jobId);
          try {
            const payload = JSON.parse(await readFile(progressPath, 'utf8'));
            respond(res, 200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify(payload));
          } catch (err) {
            // POST 还没来得及创建文件时，先返回可展示的启动状态。
            respond(res, 200, { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify({ ok: true, jobId, stage: 'starting', message: '正在启动本地 rembg…', percent: 1 }));
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/remove-background', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          let tempOutput = '';
          let progressPath = '';
          let jobId = '';
          try {
            const body = JSON.parse(await readBody(req));
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('当前聊天没有画布项目');
            jobId = cleanJobId(body.jobId) || ('bg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
            progressPath = progressPathFor(projectDir, jobId);
            await mkdir(dirname(progressPath), { recursive: true });
            await writeProgressFile(progressPath, { ok: true, jobId, stage: 'starting', message: '正在启动本地 rembg…', percent: 1 });
            const pluginRoot = PLUGIN_ROOT;
            const script = join(pluginRoot, 'scripts', 'remove_background.py');
            await access(script);
            const outputDir = join(projectDir, 'outputs', '.图片编辑临时');
            await mkdir(outputDir, { recursive: true });
            let sourcePath = typeof body.imagePath === 'string' && isRasterImagePath(body.imagePath) ? expandHome(body.imagePath) : sourcePathFromImageUrl(body.imageUrl);
            const uploaded = decodeImageData(body.imageData);
            if (!sourcePath && uploaded) {
              const masterDir = join(projectDir, '.dsh-edit-masters');
              await mkdir(masterDir, { recursive: true });
              const masterHash = createHash('sha1').update(uploaded.bytes).digest('hex');
              sourcePath = join(masterDir, masterHash + '.' + uploaded.ext);
              try { await access(sourcePath); } catch (err) { await writeFile(sourcePath, uploaded.bytes, { flag: 'wx' }).catch(async (writeErr) => { if (!writeErr || writeErr.code !== 'EEXIST') throw writeErr; }); }
            }
            if (!isRasterImagePath(sourcePath)) throw new Error('当前图片无法进行本地去背景（仅支持 PNG/JPG/WebP/GIF/AVIF/BMP）');
            tempOutput = join(outputDir, '.rembg-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.png');
            const python = await resolvePythonWithDeps(ctx);
            const result = await runPythonSpec(
              (executable, args, cwd) => runProcess(executable, args, cwd),
              python, script,
              { input: expandHome(sourcePath), output: tempOutput, model: 'birefnet-general-lite', progress_file: progressPath },
              { cwd: pluginRoot });
            const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
            let payload = null;
            try { payload = lines.length ? JSON.parse(lines[lines.length - 1]) : null; } catch (err) { payload = null; }
            if (result.exitCode !== 0 || !payload || payload.success !== true || !isImagePath(payload.image)) {
              throw new Error((payload && payload.error) || result.stderr.trim() || 'rembg 去背景失败');
            }
            const finalBytes = await readFile(tempOutput);
            const originalName = safeImageName(body.name || '画布图片.png');
            const dot = originalName.lastIndexOf('.');
            const base = dot > 0 ? originalName.slice(0, dot) : originalName;
            const saved = await writeManagedImage(projectDir, base + '-去背景.png', 'data:image/png;base64,' + finalBytes.toString('base64'));
            await writeProgressFile(progressPath, { ok: true, jobId, stage: 'complete', message: '去背景完成', percent: 100 });
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: true, jobId, engine: 'rembg-birefnet-general-lite', model: 'birefnet-general-lite', transparent: true, image: saved }));
          } catch (err) {
            if (progressPath) await writeProgressFile(progressPath, { ok: false, jobId, stage: 'error', message: String((err && err.message) || err), percent: null }).catch(() => {});
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          } finally {
            if (tempOutput) await unlink(tempOutput).catch(() => {});
            if (progressPath) {
              const timer = setTimeout(() => unlink(progressPath).catch(() => {}), 10 * 60 * 1000);
              if (timer && typeof timer.unref === 'function') timer.unref();
            }
          }
          return;
  });

  router.add({ method: 'POST', path: '/dsh-canvas/edit-image', prefix: false }, async (req, res, { pathname, query, CORS, sameOriginRequest }) => {
          let tempInput = '';
          let tempRawMask = '';
          let tempMask = '';
          let tempModelInput = '';
          let tempModelMask = '';
          let tempModelOverlay = '';
          let tempCropInfo = '';
          let tempGenerated = '';
          let tempComposite = '';
          try {
            const body = JSON.parse(await readBody(req));
            const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
            // 新客户端允许“编辑图片 + 可选遮罩”。显式 mode 优先；仅旧客户端
            // 未提供 mode 时，才把 maskData 兼容解释为擦除任务。
            const explicitMode = body.mode === 'erase' ? 'erase' : (body.mode === 'edit' ? 'edit' : '');
            const mode = explicitMode || (typeof body.maskData === 'string' && body.maskData.startsWith('data:image/') ? 'erase' : 'edit');
            if (!prompt && mode !== 'erase') { respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: '请输入图片修改提示词' })); return; }
            if (prompt.length > 4000) { respond(res, 400, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: '提示词过长' })); return; }

            const pluginRoot = PLUGIN_ROOT;
            const compositeScript = join(pluginRoot, 'scripts', 'composite_edit.py');
            const maskScript = join(pluginRoot, 'scripts', 'prepare_mask.py');
            const modelInputScript = join(pluginRoot, 'scripts', 'prepare_model_input.py');
            const projectDir = projectDirectory(body.cwd, body.project);
            if (!projectDir) throw new Error('当前聊天没有画布项目');
            const outputDir = join(projectDir, 'outputs', '.图片编辑临时');
            await mkdir(outputDir, { recursive: true });

            let currentSourcePath = typeof body.imagePath === 'string' && isRasterImagePath(body.imagePath) ? expandHome(body.imagePath) : sourcePathFromImageUrl(body.imageUrl);
            const rootSourcePath = typeof body.editRootPath === 'string' && isRasterImagePath(body.editRootPath) ? expandHome(body.editRootPath) : '';
            const uploaded = decodeImageData(body.imageData);
            if (!currentSourcePath && uploaded) {
              const masterDir = join(projectDir, '.dsh-edit-masters');
              await mkdir(masterDir, { recursive: true });
              const masterHash = createHash('sha1').update(uploaded.bytes).digest('hex');
              currentSourcePath = join(masterDir, masterHash + '.' + uploaded.ext);
              try { await access(currentSourcePath); } catch (err) { await writeFile(currentSourcePath, uploaded.bytes, { flag: 'wx' }).catch(async (writeErr) => { if (!writeErr || writeErr.code !== 'EEXIST') throw writeErr; }); }
            }
            // 连续擦除时让模型始终参考原始母版，避免把上一次的生成瑕疵
            // 再次作为输入；最终合成仍以当前图为底，保留之前已经完成的修改。
            let sourcePath = mode === 'edit' && rootSourcePath ? rootSourcePath : currentSourcePath;
            let modelSourcePath = mode === 'erase' && rootSourcePath ? rootSourcePath : sourcePath;
            let compositeSourcePath = currentSourcePath && isRasterImagePath(currentSourcePath) ? currentSourcePath : sourcePath;
            if (uploaded && !(mode === 'edit' && rootSourcePath)) {
              if (!sourcePath || !modelSourcePath) {
                tempInput = join(outputDir, '.canvas-edit-input-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.' + uploaded.ext);
                await writeFile(tempInput, uploaded.bytes);
                sourcePath = tempInput;
                modelSourcePath = tempInput;
                compositeSourcePath = tempInput;
              }
            }
            if (!isRasterImagePath(modelSourcePath)) throw new Error('当前图片无法转换为模型输入（仅支持栅格图片）');
            if (!isRasterImagePath(compositeSourcePath)) throw new Error('当前图片无法用于无损合成（仅支持栅格图片）');

            const python = await resolvePythonWithDeps(ctx);
            const mask = decodeImageData(body.maskData);
            if (mode === 'erase' && !mask) throw new Error('请先用画笔涂抹要擦除的区域');
            if (mask) {
              const maskToken = Date.now() + '-' + Math.random().toString(16).slice(2);
              tempRawMask = join(outputDir, '.canvas-edit-mask-raw-' + maskToken + '.png');
              tempMask = join(outputDir, '.canvas-edit-mask-prepared-' + maskToken + '.png');
              await writeFile(tempRawMask, mask.bytes);
              await access(maskScript);
              const prepared = await runPythonSpec(
              (executable, args, cwd) => runProcess(executable, args, cwd),
              python, maskScript,
              { source: expandHome(modelSourcePath), mask: tempRawMask, output: tempMask },
              { cwd: pluginRoot });
              if (prepared.exitCode !== 0) throw new Error(prepared.stderr.trim() || '擦除遮罩预处理失败');
            }

            // 引擎能力差异要在构建提示词前知道:dsh-codex 的生成接口不接收 mask
            // 参数——模型看不到蒙版时,纯选区擦除(如"去掉这几颗蓝莓")会原样返回。
            // 这类引擎改用"蒙版烘焙图":擦除区域画成紫红色半透明色块让模型定位,
            // 提示词同步说明。API 引擎有原生 mask 参数,继续走干净图+mask。
            const engineSettings = await readImageEngineSettings();
            const useMaskOverlay = engineSettings.engine === 'dsh-codex' && Boolean(tempMask);
            const previousHistory = Array.isArray(body.editHistory) ? body.editHistory.filter((item) => typeof item === 'string' && item.trim()).slice(-10) : [];
            const currentInstruction = prompt || '仅清除遮罩区域并制作干净底图：依据遮罩边界四周的真实背景连续补全，不添加任何新内容';
            const cumulative = mode === 'edit' && previousHistory.length
              ? '以原始母版为基础，依次完成这些已确认修改：\n- ' + previousHistory.join('\n- ') + '\n本次继续修改：' + currentInstruction
              : currentInstruction;
            const finalPrompt = mode === 'erase'
              ? '这是严格的局部 clean-plate 图像修复，不是整图重绘、风格化生成或重新设计。'
              + (useMaskOverlay
                ? '图中紫红色半透明色块覆盖的区域是必须移除的内容（色块本身不是画面内容，最终输出中不得保留色块及其边缘），色块外区域是锁定参考。\n'
                : '透明遮罩覆盖的区域是必须移除的内容，遮罩外区域是锁定参考。\n')
              + cumulative
              + '\n硬性要求：\n'
              + '1. 将透明遮罩内的原始内容视为不存在，彻底移除其中的文字、字形、标点、线条、描边、阴影、压痕、色块、反射和所有碎片；不得读取、猜测、复制、复原或改写原内容。\n'
              + '2. 只从遮罩边界外最近的真实背景取样并向内连续延伸，匹配原有颜色、渐变、材质纹理尺度、光照、透视、噪声和水纹方向；结果必须像原本就没有该内容，不能有涂抹感、补丁感、模糊边缘、光晕、接缝或重复纹理。\n'
              + '3. 遮罩边界上如有被部分覆盖的独立元素（相邻的文字、图形、产品部件、边缘线条），它们不是本次要移除的对象：以其在遮罩外的可见部分为依据完整延续补齐，保持原有字形、粗细、颜色与材质；不得将其整块抹除或留半截。\n'
              + (prompt
                ? '4. 除用户明确写出的补全要求外，不得生成任何新物体、字符、图形或装饰。\n'
                : '4. 不得在遮罩内生成任何可读或不可读字符、深色碎点、幽灵轮廓、新物体或装饰。\n')
              + '5. 遮罩外的产品、排版、颜色、清晰度、构图和所有像素必须保持不变；只允许改变透明遮罩区域。'
              : cumulative
                + (mask
                  ? (useMaskOverlay
                    ? '\n图中紫红色半透明色块是遮罩选区（色块不是画面内容，输出不得保留色块）；只允许修改色块区域，色块外必须逐像素保持原样。'
                    : '\n本次只允许修改遮罩选区；遮罩外必须逐像素保持原样。')
                  : '\n本次为整图修改。')
                + '\n保持未提及区域、产品身份、材质纹理、构图、颜色和清晰度不变，不要自行增加文字或装饰。';

            const width = Math.max(1, Number(body.width || 1));
            const height = Math.max(1, Number(body.height || 1));
            await access(compositeScript);
            await access(modelInputScript);
            const modelToken = Date.now() + '-' + Math.random().toString(16).slice(2);
            tempModelInput = join(outputDir, '.canvas-model-input-' + modelToken + '.webp');
            tempModelMask = tempMask ? join(outputDir, '.canvas-model-mask-' + modelToken + '.png') : '';
            const modelSpec = { source: expandHome(modelSourcePath), output_image: tempModelInput, max_side: '1024' };
            if (tempMask) {
              // 有蒙版时只把蒙版周围的原生分辨率窗口交给模型（带上下文边距），避免整图缩放再放大造成擦除区发虚。
              tempCropInfo = join(outputDir, '.canvas-crop-' + modelToken + '.json');
              modelSpec.mask = tempMask;
              modelSpec['output-mask'] = tempModelMask;
              if (useMaskOverlay) {
                tempModelOverlay = join(outputDir, '.canvas-model-overlay-' + modelToken + '.webp');
                modelSpec['output-overlay'] = tempModelOverlay;
              }
              modelSpec['crop-to-mask'] = true;
              modelSpec['crop-info'] = tempCropInfo;
            }
            const modelPrepared = await runPythonSpec(
              (executable, args, cwd) => runProcess(executable, args, cwd),
              python, modelInputScript, modelSpec, { cwd: pluginRoot });
            if (modelPrepared.exitCode !== 0) throw new Error(modelPrepared.stderr.trim() || '模型输入预处理失败');
            const sourceBytes = await readFile(tempModelInput);
            const maskBytes = tempModelMask ? await readFile(tempModelMask) : null;
            const overlayBytes = tempModelOverlay ? await readFile(tempModelOverlay).catch(() => null) : null;
            const modelImage = useMaskOverlay && overlayBytes ? overlayBytes : sourceBytes;
            const generated = await generateImage({
              ctx,
              image: modelImage,
              mask: maskBytes,
              prompt: finalPrompt,
              engine: engineSettings.engine,
              signal: AbortSignal.timeout(900000)
            });
            const engine = generated.engine;
            tempGenerated = join(outputDir, '.image-edit-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.png');
            await writeFile(tempGenerated, generated.bytes);
            tempComposite = join(outputDir, '.composited-edit-' + Date.now() + '-' + Math.random().toString(16).slice(2) + '.png');
            const compositeArgs = [compositeScript, '--source', expandHome(compositeSourcePath), '--generated', tempGenerated, '--output', tempComposite];
            if (tempMask) {
              compositeArgs.push('--mask', tempMask, '--tone-match');
              try {
                const cropInfo = JSON.parse(await readFile(tempCropInfo, 'utf8'));
                if (cropInfo && Number(cropInfo.w) > 0 && Number(cropInfo.h) > 0) compositeArgs.push('--crop', [cropInfo.x, cropInfo.y, cropInfo.w, cropInfo.h].join(','));
              } catch (err) {}
            }
            const compositeSpec = { source: compositeSourcePath, generated: tempGenerated, output: tempComposite };
            if (tempMask) compositeSpec.mask = tempMask;
            if (compositeArgs.includes('--tone-match')) compositeSpec['tone-match'] = true;
            const cropIdx = compositeArgs.indexOf('--crop');
            if (cropIdx >= 0 && cropIdx + 1 < compositeArgs.length) compositeSpec.crop = compositeArgs[cropIdx + 1];
            const composited = await runPythonSpec(
              (executable, args, cwd) => runProcess(executable, args, cwd),
              python, compositeScript, compositeSpec, { cwd: pluginRoot });
            if (composited.exitCode !== 0) throw new Error(composited.stderr.trim() || '图片无损合成失败');

            const finalBytes = await readFile(tempComposite);
            const originalName = safeImageName(body.name || '画布图片.png');
            const dot = originalName.lastIndexOf('.');
            const base = dot > 0 ? originalName.slice(0, dot) : originalName;
            const saved = await writeManagedImage(projectDir, base + (mode === 'erase' ? '-擦除.png' : '-编辑.png'), 'data:image/png;base64,' + finalBytes.toString('base64'));
            const rootPath = rootSourcePath || (currentSourcePath && isRasterImagePath(currentSourcePath) ? currentSourcePath : saved.path);
            const nextHistory = previousHistory.concat([currentInstruction]).slice(-12);
            respond(res, 200, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({
              ok: true,
              engine,
              image: saved,
              editRootPath: rootPath,
              editHistory: nextHistory,
              editDepth: Number(body.editDepth || 0) + 1
            }));
          } catch (err) {
            respond(res, 500, { ...CORS, 'content-type': 'application/json' }, JSON.stringify({ ok: false, error: String((err && err.message) || err) }));
          } finally {
            for (const path of [tempInput, tempRawMask, tempMask, tempModelInput, tempModelMask, tempModelOverlay, tempCropInfo, tempGenerated, tempComposite]) if (path) await unlink(path).catch(() => {});
          }
          return;
  });
}
