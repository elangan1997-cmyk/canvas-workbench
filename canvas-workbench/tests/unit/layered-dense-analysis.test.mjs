import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeLayeredDocument } from '../../src/host/services/layered-image-analysis.js';
import { normalizeLayerElements, analyzeLayeredImagePart } from '../../src/host/services/layered-image-model.js';

const finish={type:'finish',reason:{kind:'stop'}};
test('dense layout separates 80 text objects, splits only truncated cores and resumes cached neighbours',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-dense-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const rows=Array.from({length:80},(_,i)=>({text:'菜品编号'+String(i+1).padStart(3,'0'),x:80+(i%2)*1000,y:40+Math.floor(i/2)*32,width:220,height:22,fontSize:22,confidence:99}));
 const calls=[];let truncate=true;
 const ctx={attachments:{saveImage:async({data,name})=>({...JSON.parse(Buffer.from(data).toString()),id:'image',name})},llm:{resolveModelInfo:async()=>({}),prepareCall:async()=>({config:{},stream:async function*(call){
  const a=call.messages[0].content[1].attachment;calls.push(a.name);
  if(call.purpose==='canvas-layer-analysis'){assert.match(call.system,/本轮只规划大结构/);yield{type:'text-delta',index:0,text:JSON.stringify({elements:[{id:'bg',type:'background',name:'底图'},{id:'band',type:'shape',name:'斜切色带',description:'斜切渐变，用矩形近似',x:0,y:980,width:1000,height:20}]})};yield finish;return;}
  if(truncate&&a.name==='图层文字 tile-0-0'){truncate=false;yield{type:'text-delta',index:0,text:'{"blocks":['};yield{type:'finish',reason:{kind:'max-tokens'}};return;}
  const blocks=rows.filter(b=>b.x>=a.x&&b.x<a.x+a.width&&b.y>=a.y&&b.y<a.y+a.height).map(b=>({...b,x:b.x-a.x,y:b.y-a.y}));
  yield{type:'text-delta',index:0,text:JSON.stringify({blocks})};yield finish;
 }})}};
 const runtime={directory:root,ocr:async()=>({blocks:rows}),crop:async r=>writeFile(r.output,JSON.stringify(r)),progress:async()=>{}};
 const body={provider:'ds',model:'current',reasoningEffort:'high'},uploaded={bytes:Buffer.from(JSON.stringify({width:2000,height:1400})),mime:'image/png'};
 const result=await analyzeLayeredDocument(ctx,uploaded,body,2000,1400,new AbortController().signal,runtime);
 assert.equal(result.analysisStrategy,'dense');assert.equal(result.elements.filter(e=>e.type==='text').length,80);assert.equal(calls.filter(n=>n==='图层文字 tile-0-0').length,1,'same truncated region is not bought again');assert.ok(calls.some(n=>n==='图层文字 tile-0-0-a'));
 assert.deepEqual(result.elements.filter(e=>e.type==='text').map(e=>[e.text,e.x,e.y]),rows.sort((a,b)=>a.y-b.y||a.x-b.x).map(e=>[e.text,e.x,e.y]));
 const count=calls.length;const replay=await analyzeLayeredDocument(ctx,uploaded,body,2000,1400,new AbortController().signal,runtime);assert.equal(calls.length,count,'same task resumes every completed tile without another model request');assert.equal(replay.elements.length,result.elements.length);
 const text=result.elements.filter(e=>e.type==='text');assert.ok(text.every(e=>!e.geometryIssues));
 assert.equal(result.elements.find(e=>e.id==='band').type,'image','unsupported gradients are preserved as source artwork, never a knowingly wrong rectangle');
 for(const row of rows)row.text='原文'+row.text;
 const sourceRuntime={...runtime,textSourceHash:'original-content-v2',fixedLayout:result.elements.filter(e=>e.type!=='text')},completeBody={...body,reconstruction:'complete'};
 const corrected=await analyzeLayeredDocument(ctx,uploaded,completeBody,2000,1400,new AbortController().signal,sourceRuntime);
 assert.ok(corrected.elements.filter(e=>e.type==='text').every(e=>e.text.startsWith('原文')),'HD text checkpoints cannot override original-source text');
 assert.equal(calls.filter(n=>n==='图片拆层分析').length,0);assert.equal(corrected.elements.find(e=>e.id==='band').id,'band','material ownership remains stable');
 const after=calls.length;await analyzeLayeredDocument(ctx,uploaded,completeBody,2000,1400,new AbortController().signal,sourceRuntime);assert.equal(calls.length,after,'original-source text checkpoints resume independently');
});

test('max-token completion receives a bounded standalone retry and records the discarded response',async()=>{
 let calls=0;const attempts=[];const budgets=[];
 const ctx={attachments:{saveImage:async()=>({id:'source'})},llm:{resolveModelInfo:async()=>({}),prepareCall:async b=>{budgets.push(b.maxTokens);return{config:{},stream:async function*(){calls++;yield{type:'text-delta',index:0,text:calls===1?'incomplete':'{"elements":[]}'};yield calls===1?{type:'finish',reason:{kind:'max-tokens'}}:finish;}};}}};
 const r=await analyzeLayeredImagePart(ctx,{bytes:Buffer.from('source'),mime:'image/png'},{provider:'ds',model:'current',onAnalysisAttempt:async a=>attempts.push(a)},100,100,new AbortController().signal);
 assert.equal(calls,2);assert.deepEqual(budgets,[14000,24000]);assert.equal(attempts[0].finish,'max-tokens');assert.equal(r.elements[0].type,'background');
});

test('text capacity is independent of image reconstruction limits and still has a finite memory cap',()=>{
 const text=Array.from({length:100},(_,i)=>({id:'t'+i,type:'text',text:'文字',x:0,y:i,width:20,height:10}));assert.equal(normalizeLayerElements(text,200,2000).length,101);
 assert.throws(()=>normalizeLayerElements(Array.from({length:41},(_,i)=>({id:'p'+i,type:'image',x:0,y:0,width:20,height:20})),200,2000),/40/);
 assert.throws(()=>normalizeLayerElements(Array.from({length:321},(_,i)=>({...text[0],id:'t'+i})),200,2000),/320/);
});

test('OCR coverage rows never flatten already calibrated independent labels or prices',async()=>{
 const {suppressOverlappingOcrRows}=await import('../../src/host/services/layered-image-refinement.js');
 const rows=[{id:'name',type:'text',text:'芒果冰冰乐',x:10,y:20,width:100,height:20,enabled:true,nativeText:true},
 {id:'price',type:'text',text:'18',x:200,y:20,width:24,height:20,enabled:true,nativeText:true},
 {id:'ocr',type:'text',text:'芒果冰冰乐 18',x:10,y:20,width:214,height:20,enabled:true,textMode:'image',sourceTextSupplement:true},
 {id:'missing',type:'text',text:'未拆说明',x:10,y:90,width:100,height:20,enabled:true,textMode:'image',sourceTextSupplement:true},
 {id:'locked',type:'text',text:'芒果冰冰乐 18',x:10,y:20,width:214,height:20,enabled:true,textMode:'image',modeLocked:true}];
 assert.equal(suppressOverlappingOcrRows(rows),1);assert.equal(rows[2].enabled,false);assert.equal(rows[2].retainedInBackground,true);assert.ok(rows[0].nativeText&&rows[1].nativeText);assert.equal(rows[3].enabled,true);assert.equal(rows[4].enabled,true);
});

test('recalibration starts from immutable recognition geometry rather than a prior narrowed crop',async t=>{
 const {restoreRecognitionGeometry}=await import('../../src/host/services/layered-image-refinement.js');
 const {mkdir}=await import('node:fs/promises');const root=await mkdtemp(join(tmpdir(),'recognition-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'analysis'));
 await writeFile(join(root,'analysis/manifest.json'),JSON.stringify({completed:['tile-0-0']}));
 await writeFile(join(root,'analysis/tile-0-0.json'),JSON.stringify({result:[{text:'芒果冰冰乐',x:100,y:200,width:130,height:30}]}));
 const es=[{type:'text',text:'芒果冰冰乐',x:110,y:201,width:59,height:25},{type:'text',text:'锁定',x:9,y:9,width:10,height:10,geometryLocked:true}];
 await restoreRecognitionGeometry(es,root);assert.equal(es[0].width,130);assert.equal(es[0].x,100);
 es[0].x=120;es[0].width=40;await restoreRecognitionGeometry(es,root);assert.equal(es[0].width,130);assert.equal(es[0].x,100);assert.equal(es[1].x,9);
});

test('substitute fonts may differ in weight within verified geometry; missing text and overflow still require repair',async()=>{
 const {partitionReadbackTypography}=await import('../../src/host/services/layered-image-refinement.js');
 const e={id:'price',nativeText:true,color:'#666666',cleanupBounds:{x:10,y:20,width:43,height:18},bounds:{x:9,y:20,width:45,height:19}};
 const good={id:'price',reason:'价格16/M字号放大且变粗'},bad={id:'price',reason:'价格16/M有重影、缺失'};
 const r=partitionReadbackTypography([e],{issues:[good,bad]});assert.deepEqual(r.issues,[bad]);assert.deepEqual(r.typographyNotes,[good]);
 assert.equal(partitionReadbackTypography([{...e,bounds:{...e.bounds,width:100}}],{issues:[good]}).issues.length,1);
 assert.equal(partitionReadbackTypography([e],{issues:[good]},'strict').issues.length,1);
});
