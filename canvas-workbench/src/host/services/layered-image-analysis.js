import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { analyzeLayeredImagePart, normalizeLayerElements } from './layered-image-model.js';
import { analyzeTextWithCurrentModel, visionBlocks } from './text-analysis.js';
import { mergeTextCandidates, supplementTextCoverage } from './text-coverage.js';
import { denseSourceStructure } from './layered-source-policy.js';

const readJson=async path=>{try{return JSON.parse(await readFile(path,'utf8'));}catch{return null;}};
const writeJson=async(path,value)=>{await writeFile(path+'.tmp',JSON.stringify(value,null,2));await rename(path+'.tmp',path);};
const contains=(outer,inner)=>inner.x>=outer.x-2&&inner.y>=outer.y-2&&inner.x+inner.width<=outer.x+outer.width+2&&inner.y+inner.height<=outer.y+outer.height+2;

export function layerAnalysisRegions(width,height){
  const nx=Math.ceil(width/1100),ny=Math.ceil(height/800),regions=[];
  for(let y=0;y<ny;y++)for(let x=0;x<nx;x++)regions.push({id:'tile-'+y+'-'+x,depth:0,x:Math.floor(width*x/nx),y:Math.floor(height*y/ny),width:Math.floor(width*(x+1)/nx)-Math.floor(width*x/nx),height:Math.floor(height*(y+1)/ny)-Math.floor(height*y/ny)});
  if(regions.length>32)throw new Error('密集图片超过32个分析区域，请缩小单张图尺寸');
  return regions;
}

/** Layout and typography have separate, resumable output budgets. Crops are
 * internal vision context; the deliverable always uses one original artboard. */
export async function analyzeLayeredDocument(ctx,uploaded,body,width,height,signal,runtime){
  const directory=join(runtime.directory,'analysis');await mkdir(directory,{recursive:true});
  const signature=createHash('sha256').update(uploaded.bytes).update(JSON.stringify({version:3,provider:body.provider,model:body.model,effort:body.reasoningEffort||'',localOnly:body.localOnly===true})).digest('hex');
  const stored=await readJson(join(directory,'manifest.json'));
  const manifest=stored?.signature===signature?stored:{signature,calls:0,completed:[],failures:[]};
  const initialCalls=manifest.calls;
  let progressWrites=Promise.resolve();
  const progress=(message,extra={})=>{Object.assign(manifest,extra);const snapshot=JSON.parse(JSON.stringify(manifest));
    progressWrites=progressWrites.catch(()=>{}).then(async()=>{await writeJson(join(directory,'manifest.json'),snapshot);await runtime.progress?.({message,strategy:snapshot.strategy||'routing',calls:snapshot.calls,completedTiles:snapshot.completed.length,...extra});});return progressWrites;};
  const checkpoint=async(name)=>{const value=await readJson(join(directory,name+'.json'));return value?.signature===signature?value.result:null;};
  const retain=async(name,result)=>writeJson(join(directory,name+'.json'),{signature,result});
  let ocr=await readJson(join(runtime.directory,'local-ocr.json'));
  if(!ocr)try{ocr=await runtime.ocr(signal);await writeJson(join(runtime.directory,'local-ocr.json'),ocr);}catch(error){signal.throwIfAborted();ocr={blocks:[],warning:String(error.message||error)};}
  const diagnostics=[];
  const part=async(structureOnly)=>{
    const name=structureOnly?'layout':'whole';const cached=await checkpoint(name);if(cached)return cached;
    manifest.calls++;
    await progress(structureOnly?'正在规划图像、色块与版面结构，文字将分区处理…':'正在分析图片结构…');
    const result=await analyzeLayeredImagePart(ctx,uploaded,{...body,structureOnly,adaptiveAnalysis:true,onAnalysisAttempt:async value=>{
      diagnostics.push({...value,stage:name});await writeJson(join(directory,name+'-attempt-'+value.attempt+'.json'),value);
    }},width,height,signal);
    await retain(name,result);return result;
  };
  let whole;
  const dense=(ocr.blocks||[]).filter(b=>b.text&&b.confidence>=45).length>=28 || manifest.strategy==='dense';
  if(!dense)try{whole=await part(false);}catch(error){
    signal.throwIfAborted();if(!error.analysisTruncated)throw error;
    manifest.failures.push({stage:'whole',reason:'max-tokens'});await progress('整图分析达到输出上限，正在自动改为分区分析…',{strategy:'dense'});
  }
  if(whole)return{...whole,analysisStrategy:'whole',analysisCalls:manifest.calls};
  manifest.strategy='dense';
  const layout=await part(true);
  let sourceLayout=denseSourceStructure(layout.elements);
  const regionPlan=await checkpoint('image-regions');
  if(regionPlan)sourceLayout={...sourceLayout,elements:regionPlan.elements,warnings:[...sourceLayout.warnings,...regionPlan.warnings]};
  else if(runtime.refineImages){const refined=await runtime.refineImages(sourceLayout.elements,signal);await retain('image-regions',refined);sourceLayout={...sourceLayout,elements:refined.elements,warnings:[...sourceLayout.warnings,...refined.warnings]};}
  const images=sourceLayout.elements.filter(e=>e.type==='image'&&e.enabled!==false);
  const regions=layerAnalysisRegions(width,height),blocks=[],warnings=[...(layout.warnings||[])];let cursor=0;
  const tile=async region=>{
    signal.throwIfAborted();
    const cached=await checkpoint(region.id);if(cached){blocks.push(...cached);if(!manifest.completed.includes(region.id))manifest.completed.push(region.id);return;}
    const split=await checkpoint(region.id+'-split');if(split){for(const child of split)await tile(child);return;}
    if(manifest.calls-initialCalls>=48)throw new Error('本轮分析请求达到48次上限，已保存全部完成分区，可继续任务');
    const pad=64,x=Math.max(0,region.x-pad),y=Math.max(0,region.y-pad);
    const crop={x,y,width:Math.min(width,region.x+region.width+pad)-x,height:Math.min(height,region.y+region.height+pad)-y};
    const path=join(directory,region.id+'.png');await runtime.crop({...crop,output:path,exclude:images},signal);
    const bytes=await readFile(path);let failure;
    for(let attempt=0;attempt<2;attempt++){
      try{
        manifest.calls++;await progress('正在识别菜单文字分区 '+region.id+'；已保留 '+manifest.completed.length+' 个分区');
        const result=await analyzeTextWithCurrentModel(ctx,{bytes,mime:'image/png'},
          {...body,compactText:true,coordinateSpace:'pixels',name:'图层文字 '+region.id,crops:[{x:0,y:0,width:crop.width,height:crop.height}]},false,AbortSignal.any([signal,AbortSignal.timeout(180000)]));
        const mapped=visionBlocks(result.value,crop.width,crop.height,'pixels').map(b=>({...b,x:b.x+x,y:b.y+y})).filter(b=>{
          const cx=b.x+b.width/2,cy=b.y+b.height/2;
          return cx>=region.x&&cx<region.x+region.width&&cy>=region.y&&cy<region.y+region.height&&!images.some(e=>contains(e,b));
        });
        await retain(region.id,mapped);blocks.push(...mapped);manifest.completed.push(region.id);await progress('文字分区已保存 '+manifest.completed.length+' 个');return;
      }catch(error){signal.throwIfAborted();failure=error;if(/max-tokens|JSON|json|Unexpected|unterminated/i.test(error.message||''))break;}
    }
    manifest.failures.push({stage:region.id,reason:String(failure?.message||failure).slice(0,500)});
    // Do not repeat a truncated request at the same size. Smaller ownership
    // cores keep the coordinate system and already-finished neighbours intact.
    if(region.depth>=3||Math.max(region.width,region.height)<180||manifest.calls-initialCalls>=48)throw new Error('分区 '+region.id+' 在自动缩小后仍未完成，已保存其他分区，可原任务继续：'+String(failure?.message||failure));
    const axis=region.width>=region.height?'x':'y',size=axis==='x'?'width':'height',half=Math.floor(region[size]/2);
    const children=[{...region,id:region.id+'-a',depth:region.depth+1,[size]:half},{...region,id:region.id+'-b',depth:region.depth+1,[axis]:region[axis]+half,[size]:region[size]-half}];
    await retain(region.id+'-split',children);await progress('文字分区输出过长，自动缩小该区并继续');for(const child of children)await tile(child);
  };
  // Independent requests share no model conversation, at most two in flight.
  const errors=[];await Promise.all(Array.from({length:Math.min(2,regions.length)},async()=>{while(cursor<regions.length){const region=regions[cursor++];try{await tile(region);}catch(error){errors.push(error);}}}));
  if(errors.length){signal.throwIfAborted();throw errors[0];}
  const merged=mergeTextCandidates(blocks);
  const coverage=supplementTextCoverage(merged,(ocr.blocks||[]).filter(b=>b.confidence>=85&&!images.some(e=>contains(e,b))),[{x:0,y:0,width,height}]);
  // OCR-only omissions remain original pixel regions, not invented editable
  // copy. The selected vision model remains the source of native text content.
  const text=coverage.blocks.filter(b=>b.enabled!==false).map((b,i)=>({...b,id:'text-'+String(i+1).padStart(3,'0'),type:'text',name:'文字 '+String(i+1).padStart(3,'0')+'：'+b.text.slice(0,20),
    description:'原图独立文字行',z:100+i/1000,nativeText:false,
    ...(b.recognitionSource==='local-ocr-supplement'?{textMode:'image',sourceTextFallback:true,sourceTextSupplement:true}:{}),enabled:true}));
  if(coverage.supplementedCount)warnings.push(coverage.supplementedCount+' 个模型遗漏或部分重叠的OCR区域已保留原像素，不作为已确认的可编辑文案');
  warnings.push('密集图按结构与文字分区分析，分区结果映回一张完整原尺寸画板；图像与背景最多40层，文字和形状总层数上限320');
  // Dense layouts contain small product thumbnails and artwork panels whose
  // original pixels must survive. Rebuilding each thumbnail changes identity
  // and wastes image quota; retain these bounded regions with their backdrop.
  const resolved=denseSourceStructure([...sourceLayout.elements,...text]);warnings.push(...sourceLayout.warnings);
  const elements=normalizeLayerElements(resolved.elements,width,height);
  warnings.push('密集版面的照片、插画与装饰主视觉保留原图区块及其局部底色，不重新生成商品；补全不可见背景仍可能使用图像模型');
  await progress('结构及全部文字分区分析完成',{textCount:text.length});
  return{elements,warnings,semanticPolicyVersion:2,analysisStrategy:'dense',analysisAttempts:manifest.calls,analysisCalls:manifest.calls,
    analysisTiles:manifest.completed.length,imageGeometryVersion:runtime.refineImages?2:0,rawAnalysis:diagnostics};
}
