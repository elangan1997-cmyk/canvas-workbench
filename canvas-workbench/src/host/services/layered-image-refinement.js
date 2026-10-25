import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { resolvePythonWithDeps } from '../../../lib/platform.js';
import { PLUGIN_ROOT } from '../vendor-assets.js';
import { runPythonSpec } from './python-launch.js';
import { refineTextGeometry } from './text-geometry.js';
import { verifyLayerTextContent } from './layered-image-model.js';
import { MAX_LAYER_ELEMENTS } from './layered-image-limits.js';

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

// Visual uncertainty is handled by the executor, never by an acknowledgement
// checkbox. Invalid inputs and operational failures still stop the task.
const REPAIRABLE_LAYER_QUALITY = new Set(['textured-background', 'background-region-large', 'layer-content-bounds-review', 'text-overlap', 'text-outside-canvas',
  'font-unavailable','font-fit-unresolved','unsupported-text-geometry','strict-font-review','calibration-failed']);
export function automaticLayerQuality(quality) {
  if (!quality) return quality;
  const issues = (quality.issues || []).map(i => REPAIRABLE_LAYER_QUALITY.has(i.code) ? { ...i, severity:'warning' } : i);
  return { ...quality, status:issues.some(i=>['error','review'].includes(i.severity))?'needs_review':'passed', issues };
}
export function hasBlockingLayerQuality(quality) {
  return automaticLayerQuality(quality)?.status === 'needs_review';
}

export function splitLayerTextLines(elements) {
  let room = MAX_LAYER_ELEMENTS-elements.length;
  const ids = new Set(elements.map(e=>e.id));
  return elements.flatMap(e=>{
    const lines=String(e.text||'').replace(/\r\n?/g,'\n').split('\n');
    if (e.type!=='text' || lines.length<2 || lines.some(line=>!line.trim()) || lines.length-1>room || Math.abs(e.rotation||0)>2) return [e];
    const children=lines.map((text,i)=>{
      const baseId=e.id.slice(0,45)+'-line-'+(i+1);let id=baseId,serial=1;while(ids.has(id))id=baseId+'-'+(++serial);ids.add(id);
      const {cleanupBounds,textFit,fontCandidates,recognitionBounds,...base}=e;
      return {...base,id,text:text.trim(),name:e.name+'·第'+(i+1)+'行',textGroupId:e.textGroupId||e.id,
        y:e.y+Math.floor(e.height*i/lines.length),height:Math.max(1,Math.floor(e.height*(i+1)/lines.length)-Math.floor(e.height*i/lines.length)),
        z:e.z+i*.001,fontAccepted:false};
    });
    room-=lines.length-1;return children;
  });
}

export async function restoreRecognitionGeometry(elements,directory,ocr=[]){
  const compact=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'');let candidates=[];
  if(elements.some(e=>e.type==='text'&&!e.recognitionBounds&&!e.geometryLocked)){
    try{
      const manifest=JSON.parse(await readFile(join(directory,'analysis','manifest.json'),'utf8'));
      for(const id of manifest.completed||[])if(/^tile-\d+-\d+(?:-[ab])*$/.test(id)){
        const tile=JSON.parse(await readFile(join(directory,'analysis',id+'.json'),'utf8'));if(Array.isArray(tile.result))candidates.push(...tile.result);
      }
    }catch{}
  }
  for(const e of elements){
    if(e.type!=='text'||e.geometryLocked)continue;
    let b=e.recognitionBounds;
    if(!b){
      const pool=e.textMode==='image'?ocr:candidates;
      b=pool.filter(r=>compact(r.text)===compact(e.text)&&Math.abs(r.y-e.y)<=Math.max(60,e.height*2))
        .sort((a,b)=>(Math.abs(a.y-e.y)*5+Math.abs(a.x-e.x))-(Math.abs(b.y-e.y)*5+Math.abs(b.x-e.x)))[0]||e;
      e.recognitionBounds=Object.fromEntries(['x','y','width','height'].map(k=>[k,b[k]]));
    }
    Object.assign(e,e.recognitionBounds);
  }
  return elements;
}

export function layerTextConflicts(elements,lines) {
  const compact=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'');
  const close=(a,b)=>{
    if(Math.min(a.length,b.length)<6 || Math.max(a.length,b.length)>160 || Math.abs(a.length-b.length)>2)return false;
    let prior=Array.from({length:b.length+1},(_,i)=>i);
    for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(next[j-1]+1,prior[j]+1,prior[j-1]+(a[i-1]===b[j-1]?0:1));prior=next;}
    return prior[b.length]<=2;
  };
  return elements.filter(e=>e.type==='text'&&e.enabled&&e.textMode!=='image').flatMap(e=>{
    const candidate=lines.filter(l=>l.confidence>=90 && compact(l.text)!==compact(e.text) && close(compact(l.text),compact(e.text)) &&
      Math.abs(l.y-e.y)<=Math.max(e.height,l.height)*.35 && Math.max(0,Math.min(l.x+l.width,e.x+e.width)-Math.max(l.x,e.x))>=Math.min(l.width,e.width)*.8)
      .sort((a,b)=>Math.abs(a.y-e.y)-Math.abs(b.y-e.y))[0];
    return candidate?[{id:e.id,text:e.text,ocrText:candidate.text,confidence:candidate.confidence,x:candidate.x,y:candidate.y,width:candidate.width,height:candidate.height}]:[];
  });
}

export function suppressOverlappingOcrRows(elements){
  const compact=s=>String(s||'').normalize('NFKC').replace(/\s+/g,'');let count=0;
  const native=elements.filter(e=>e.enabled&&e.type==='text'&&e.nativeText);
  for(const e of elements){
    if(!e.enabled||e.type!=='text'||e.modeLocked||!(e.sourceTextSupplement||e.textMode==='image'))continue;
    const row=e.cleanupBounds||e;
    if(!native.some(n=>{
      const b=n.cleanupBounds||n,area=Math.max(0,Math.min(row.x+row.width,b.x+b.width)-Math.max(row.x,b.x))*Math.max(0,Math.min(row.y+row.height,b.y+b.height)-Math.max(row.y,b.y));
      return compact(e.text).includes(compact(n.text))&&area>=b.width*b.height*.4;
    }))continue;
    e.enabled=false;e.retainedInBackground=true;count++;
  }
  return count;
}

export function partitionReadbackTypography(elements,checked,fontPolicy='substitute'){
  const typographyNotes=[];
  const issues=checked.issues.filter(issue=>{
    if(fontPolicy==='strict')return true;
    const e=elements.find(e=>e.id===issue.id&&e.nativeText),reason=String(issue.reason||'');
    if(!e||!e.bounds||!e.cleanupBounds||!/字体|字号|字重|变粗|变细|字距|空格|颜色.*变浅|发灰|发虚/.test(reason)||/错字|错价|价格变化|变成|重影|叠|遮|覆盖|擦除|漏字|缺失|截断|错位|越界|消失|新增/.test(reason))return true;
    const a=e.bounds,b=e.cleanupBounds,hex=e.color||'';
    const dark=/^#[0-9a-f]{6}$/i.test(hex)&&[1,3,5].reduce((sum,i)=>sum+parseInt(hex.slice(i,i+2),16),0)/3<=160;
    if(!dark||Math.abs(a.x-b.x)>4||Math.abs(a.y-b.y)>4||a.width>b.width*1.2||a.height>b.height*1.3||a.width<b.width*.75||a.height<b.height*.75)return true;
    typographyNotes.push(issue);return false;
  });
  return {...checked,issues,typographyNotes};
}

/** OCR supplies geometry, while the selected chat model owns text content and object semantics. */
export async function calibrateLayeredAnalysis(h, task, options, signal) {
  let elements = splitLayerTextLines(task.elements), warnings = [], issues = [], refinedCount = 0;
  const unresolvedContent=new Set(); let ocrLines=[];
  try {
    let local;try{local=JSON.parse(await readFile(join(task.directory,'local-ocr.json'),'utf8'));if(!Array.isArray(local.blocks))local=null;}catch{}
    if(!local)local=await runLayerRefinementScript(h, { input: task.source, lang: 'chi_sim+eng', psm: '11' }, signal, 'ocr_image.py');
    ocrLines=local.blocks||[];
    await restoreRecognitionGeometry(elements,task.directory,ocrLines);
    await writeFile(join(task.directory, 'local-ocr.json'), JSON.stringify(local, null, 2));
    const text = elements.filter(e => e.type === 'text');
    const refined = refineTextGeometry(text, local.blocks || [], [], { minLength: 2 }); refinedCount = refined.refinedCount;
    const byId = new Map(refined.blocks.map(e => [e.id, e]));
    elements = elements.map(e => byId.get(e.id) || e);
    const conflicts=layerTextConflicts(elements,local.blocks||[]);
    if(conflicts.length){
      let corrections=[];
      try {
        corrections=await verifyLayerTextContent(h.ctx,{bytes:await readFile(task.source),mime:'image/png'},task.analysisModel||options,conflicts,
          signal?AbortSignal.any([signal,AbortSignal.timeout(240000)]):AbortSignal.timeout(240000));
        task.textContentCheckAttempts=(task.textContentCheckAttempts||0)+1;
        await writeFile(join(task.directory,'text-content-check.json'),JSON.stringify({conflicts,corrections},null,2));
      }catch(error){signal?.throwIfAborted();warnings.push('文字候选有差异，已保留原字形区域：'+String(error.message||error).slice(0,200));}
      const verified=new Map(corrections.map(c=>[c.id,c]));
      elements=elements.map(e=>{
        if(!conflicts.some(c=>c.id===e.id))return e;
        const checked=verified.get(e.id);
        if(!checked){unresolvedContent.add(e.id);return e;}
        if(checked.text!==e.text)issues.push({id:e.id,code:'text-content-corrected',severity:'warning',message:'模型对照原图自动补正文字：“'+e.text+'” → “'+checked.text+'”'});
        return {...e,text:checked.text};
      });
    }
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
    const refined = await runLayerRefinementScript(h, { operation: 'refine', input: task.source, elements,
      ...(task.analysisStrategy==='dense'?{ocrLines}: {}) }, signal);
    elements = refined.elements; issues.push(...(refined.issues || [])); warnings.push(...(refined.warnings || []));
    for (const e of elements) if (e.type === 'text' && e.enabled) {
        const errors = issues.filter(i => i.id === e.id && ['error', 'review'].includes(i.severity));
        const accepted = options.editableText === true && e.textMode!=='image' && !unresolvedContent.has(e.id) && e.fontAvailable && e.textFit && !errors.length && (options.fontPolicy !== 'strict' || e.styleConfidence >= .9);
        e.nativeText = Boolean(accepted); e.fontAccepted = Boolean(accepted);
        if (!accepted) {
          e.sourceTextFallback=true;
          issues.push({ id:e.id,code:'source-text-preserved',severity:'warning',message:'“'+e.name+'”自动保留原字形区域，不额外生成文字；该层为图像文字' });
        } else delete e.sourceTextFallback;
    }
  }
  if(task.analysisStrategy==='dense'){
    const count=suppressOverlappingOcrRows(elements);
    if(count)warnings.push(count+' 个OCR补漏整行不再覆盖已校准的独立文字；未拆出的原字仍保留在原背景');
  }
  for (const e of elements) if (e.geometryIssues?.length) issues.push({ id: e.id, code: 'invalid-geometry', severity: 'error', message: '元素坐标或尺寸缺失，请重新识别' });
  const quality = automaticLayerQuality({ issues, refinedCount, fontPolicy: options.fontPolicy === 'strict' ? 'strict' : 'substitute', decorationsMerged: decorations.map(e => ({ id: e.id, name: e.name })) });
  await writeFile(join(task.directory, 'calibration.json'), JSON.stringify({ elements, quality, warnings }, null, 2));
  return { elements, quality, warnings };
}

export function checkLayerLayout(elements, width, height) {
  const issues = [];
  const texts = elements.filter(e => e.enabled && e.type==='text' && e.bounds);
  for (let i = 0; i < texts.length; i++) {
    const a = texts[i].bounds;
    if (texts[i].nativeText&&(a.x < 0 || a.y < 0 || a.x + a.width > width || a.y + a.height > height)) issues.push({ id: texts[i].id, code: 'text-outside-canvas', severity: 'error', message: '文字超出画布' });
    for (let j = i + 1; j < texts.length; j++) {
      const b = texts[j].bounds, area = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      if(!texts[i].nativeText&&!texts[j].nativeText)continue;
      if(texts[i].nativeText&&texts[j].excludedNativeIds?.includes(texts[i].id)||texts[j].nativeText&&texts[i].excludedNativeIds?.includes(texts[j].id))continue;
      if (area > Math.min(a.width * a.height, b.width * b.height) * .04) issues.push({ id: texts[i].id, otherId: texts[j].id, code: 'text-overlap', severity: 'review', message: texts[i].name + ' 与 ' + texts[j].name + ' 可能重叠，请核对排版' });
    }
  }
  return issues;
}
