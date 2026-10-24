import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { resolvePythonWithDeps } from '../../../lib/platform.js';
import { PLUGIN_ROOT } from '../vendor-assets.js';
import { runPythonSpec } from './python-launch.js';
import { refineTextGeometry } from './text-geometry.js';

export async function runLayerRefinementScript(h, spec, signal, script = 'refine_layered_text.py') {
  signal?.throwIfAborted();
  const python = await resolvePythonWithDeps(h.ctx);
  const run = await runPythonSpec((exe, args, cwd, timeout) => h.runProcessWithTimeout(exe, args, cwd, timeout), python,
    join(PLUGIN_ROOT, 'scripts', script), spec, { cwd: PLUGIN_ROOT, timeoutMs: 180000 });
  signal?.throwIfAborted();
  let value; try { value = JSON.parse(String(run.stdout || '').trim()); } catch { throw new Error('文字校准没有返回有效结果'); }
  if (run.exitCode !== 0 || value.success !== true) throw new Error(value.error || run.stderr || '文字校准失败');
  return value;
}

// Both the canvas and the batch entry must let the executor recheck locally
// repairable issues, without bypassing missing fonts or invalid model geometry.
const REPAIRABLE_LAYER_QUALITY = new Set(['textured-background', 'background-region-large', 'layer-content-bounds-review', 'text-overlap', 'text-outside-canvas']);
export function hasBlockingLayerQuality(quality) {
  return quality?.status === 'needs_review' && (quality.issues || []).some(issue =>
    ['review', 'error'].includes(issue.severity) && !REPAIRABLE_LAYER_QUALITY.has(issue.code));
}

/** OCR supplies geometry, while the selected chat model owns text content and object semantics. */
export async function calibrateLayeredAnalysis(h, task, options, signal) {
  let elements = task.elements, warnings = [], issues = [], refinedCount = 0;
  try {
    const local = await runLayerRefinementScript(h, { input: task.source, lang: 'chi_sim+eng', psm: '11' }, signal, 'ocr_image.py');
    await writeFile(join(task.directory, 'local-ocr.json'), JSON.stringify(local, null, 2));
    const text = elements.filter(e => e.type === 'text');
    const refined = refineTextGeometry(text, local.blocks || [], [], { minLength: 2 }); refinedCount = refined.refinedCount;
    const byId = new Map(refined.blocks.map(e => [e.id, e]));
    elements = elements.map(e => byId.get(e.id) || e);
  } catch (error) {
    signal?.throwIfAborted();
    warnings.push('本地OCR定位未完成，保留模型位置并继续像素校准：' + String(error.message || error).slice(0, 240));
  }
  // Fine rules and small category markers belong to the plate. Preserve their
  // source pixels instead of buying model reconstructions of tiny line images.
  const decorations = elements.filter(e => e.type === 'image' && (e.role === 'decoration' || (
    /分割线|短横|引导点|separator|divider|leader/i.test(e.name + ' ' + e.description) && e.width * e.height < task.width * task.height * .01 && Math.max(e.width, e.height) / Math.min(e.width, e.height) > 3)));
  if (decorations.length) {
    const ids = new Set(decorations.map(e => e.id)); elements = elements.filter(e => !ids.has(e.id));
    elements = elements.map(e => ({ ...e, mergedIds: (e.mergedIds || []).filter(id => !ids.has(id)) }));
    const background = elements.find(e => e.type === 'background');
    if (background) background.description += '；保留原图中的装饰：' + decorations.map(e => e.name).join('、');
    warnings.push(decorations.length + ' 个细线或小装饰已合并到背景，保留原图像素');
  }
  if (elements.some(e => e.type === 'text')) {
    const refined = await runLayerRefinementScript(h, { operation: 'refine', input: task.source, elements }, signal);
    elements = refined.elements; issues.push(...(refined.issues || [])); warnings.push(...(refined.warnings || []));
    if (options.editableText !== true) issues = issues.map(i => ['font-unavailable', 'font-fit-unresolved', 'unsupported-text-geometry'].includes(i.code) ? { ...i, severity: 'warning' } : i);
    if (options.editableText === true) {
      for (const e of elements) if (e.type === 'text' && e.enabled) {
        const errors = issues.filter(i => i.id === e.id && ['error', 'review'].includes(i.severity));
        const accepted = e.fontAvailable && e.textFit && !errors.length && (options.fontPolicy !== 'strict' || e.styleConfidence >= .9);
        e.nativeText = Boolean(accepted); e.fontAccepted = Boolean(accepted);
        if (!accepted && !errors.length) issues.push({ id: e.id, code: 'strict-font-review', severity: 'review', message: '严格字体模式下匹配分不足，请选择候选字体' });
      }
    }
  }
  for (const e of elements) if (e.geometryIssues?.length) issues.push({ id: e.id, code: 'invalid-geometry', severity: 'error', message: '元素坐标或尺寸缺失，请重新识别' });
  const quality = { status: issues.some(i => ['error', 'review'].includes(i.severity)) ? 'needs_review' : 'passed',
    issues, refinedCount, fontPolicy: options.fontPolicy === 'strict' ? 'strict' : 'substitute', decorationsMerged: decorations.map(e => ({ id: e.id, name: e.name })) };
  await writeFile(join(task.directory, 'calibration.json'), JSON.stringify({ elements, quality, warnings }, null, 2));
  return { elements, quality, warnings };
}

export function checkLayerLayout(elements, width, height) {
  const issues = [];
  const texts = elements.filter(e => e.enabled && e.nativeText && e.bounds);
  for (let i = 0; i < texts.length; i++) {
    const a = texts[i].bounds;
    if (a.x < 0 || a.y < 0 || a.x + a.width > width || a.y + a.height > height) issues.push({ id: texts[i].id, code: 'text-outside-canvas', severity: 'error', message: '文字超出画布' });
    for (let j = i + 1; j < texts.length; j++) {
      const b = texts[j].bounds, area = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      if (area > Math.min(a.width * a.height, b.width * b.height) * .04) issues.push({ id: texts[i].id, otherId: texts[j].id, code: 'text-overlap', severity: 'review', message: texts[i].name + ' 与 ' + texts[j].name + ' 可能重叠，请核对排版' });
    }
  }
  return issues;
}
