import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPsd } from 'ag-psd';
import { createCanvasAutomation } from '../../src/host/services/canvas-automation.js';
import { createLayeredImageService } from '../../src/host/services/layered-image.js';

for (const blocked of [false,true]) test(`Agent batch uses current typed layer executor and ${blocked?'automatically preserves unsupported text':'automatically rechecks repairable quality'}`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-后台 中文-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const input=join(root,"O'Neil 原图.png");await writeFile(input,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6unwAAAAASUVORK5CYII=','base64'));
 const calls=[];let once=true;
 const h={ctx:{},stateWriteChains:new Map(),chatContexts:new Map([['sid',{cwd:root,modelSelection:{provider:'selected-chat',model:'ds'}}]]),canvasAutomationContexts:new Map(),projectDirectory:(_cwd,project)=>project,previewUrl:p=>'preview:'+p,
 writeManagedSource:async(project,name,bytes,kind)=>{await mkdir(join(project,'assets'),{recursive:true});const path=join(project,'assets',name);await writeFile(path,bytes);return{path,name,kind};}};
 const elements=[{id:'bg',name:'底图',type:'background',z:0},{id:'photo',name:'矩形照片',type:'image',extractionMode:'photo',x:0,y:0,width:4,height:4,z:1}];
 if(blocked)elements.push({id:'text',name:'复杂文字',type:'text',text:'说明',x:0,y:0,width:4,height:1,z:3});
 const pixel=async s=>{calls.push(s.operation);
  if(s.operation==='inspect'){await writeFile(s.output,await readFile(s.input));return{success:true,width:4,height:4};}
  if(s.operation==='structure')return{elements:[...s.elements,{id:'plate',name:'圆角底框',type:'shape',shapeKind:'roundedRect',fill:'#FFFFFF',radius:1,x:0,y:0,width:4,height:2,z:2}],structureChanges:[{id:'plate'}]};
  if(s.operation==='render-structure'){if(s.element.id==='photo'&&once){once=false;throw Object.assign(Error('file temporarily busy'),{code:'EBUSY'});}await writeFile(s.output,'pixels');return{engine:s.element.type==='shape'?'local-vector-shape':'source-photo-rectangle'};}
  if(s.operation==='source-flat'){await writeFile(s.output,'pixels');return{eligible:true,engine:'original-pixels'};}
  if(s.operation==='source-text'){await writeFile(s.output,'original text pixels');return{engine:'source-text-region'};}
  if(s.operation==='crop-layer'){await mkdir(join(s.output,'..'),{recursive:true});await writeFile(s.output,'pixels');return{bounds:{x:0,y:0,width:4,height:4}};}
  if(s.operation==='assemble'){const layers=[];for(const [i,e]of s.elements.filter(e=>e.enabled).entries()){const raw=join(s.directory,'qa-'+i+'.rgba');await writeFile(raw,Buffer.alloc(64,255));layers.push({name:e.name,raw,left:0,top:0,width:4,height:4,element:e});}const composite=join(s.directory,'qa.rgba'),preview=join(s.directory,'preview.png');await writeFile(composite,Buffer.alloc(64,255));await writeFile(preview,'preview');return{width:4,height:4,layers,composite,preview};}
  throw Error('Unexpected '+s.operation);
 };
 h.layeredImage=createLayeredImageService(h,{pixel,retryDelay:async()=>{},settings:async()=>({engine:'api',apiModel:'frozen-image-model'}),generate:async()=>{throw Error('Must not generate or matte rectangular photos');},analyze:async(_ctx,_image,b)=>{assert.equal(b.model,'ds');return{elements,warnings:[]};},calibrate:async task=>({elements:task.elements,quality:{status:'needs_review',issues:[{id:blocked?'text':'photo',code:blocked?'font-fit-unresolved':'text-overlap',severity:'review'}]},warnings:[]})});
 const batch=createCanvasAutomation(h,{root:join(root,'queue'),settings:async()=>({engine:'api',apiModel:'frozen-image-model'}),python:async()=>({success:true,width:4,height:4})});t.after(()=>batch.dispose());
 const source=await readFile(new URL('../../src/host/services/canvas-automation-tool.js',import.meta.url),'utf8');const{automationToolSpec}=await import('data:text/javascript;base64,'+Buffer.from(source.replace("import { defineTool } from '@deepseek-ai/dsh-tools';",'const defineTool=value=>value;')).toString('base64'));
 const tool=automationToolSpec(batch,()=>({cwd:root}));const result=await tool.execute({action:'submit',operation:'layered_export',paths:[input],formats:['psd'],allow_generation:false,max_image_requests:0},{signal:new AbortController().signal,agent:{session:{id:'sid'}}});assert.equal(result.ok,true);
 const job=await batch.settled({id:result.id});
 const direct=async()=>{const created=await h.layeredImage.analyze({project:job.project,imageData:'data:image/png;base64,'+(await readFile(input)).toString('base64'),name:'一键同图.png',provider:'selected-chat',model:'ds',autoRefine:true,autoRun:true,autoExportFormat:'psd',localOnly:true,maxImageRequests:0});return h.layeredImage.settled({project:job.project,id:created.id});};
 assert.equal(job.status,'completed',job.message);assert.equal(job.imageRequestsUsed,0);assert.equal(calls.filter(c=>c==='render-structure').length,3,'photo transient retry then independent shape');assert.ok(calls.includes('structure'));
 const psd=readPsd(await readFile(job.items[0].outputs[0].path),{skipLayerImageData:true,skipCompositeImageData:true});assert.equal(psd.children.length,blocked?4:3);assert.ok(psd.children.some(e=>e.vectorMask));
 if(blocked){assert.ok(calls.includes('source-text'));assert.ok(!psd.children.find(e=>e.name==='复杂文字').text,'fallback must not masquerade as editable text');}
 const child=await h.layeredImage.get({project:job.project,id:job.items[0].layeredTaskId});assert.equal(child.recoveryEvents.length,1);assert.equal(child.quality.status,'passed');assert.equal(child.analysisModel.model,'ds');assert.equal(child.imageModel,'frozen-image-model');
 const canvas=JSON.parse(await readFile(join(job.project,'canvas.json'),'utf8'));assert.equal(canvas.elements.length,1);assert.equal(canvas.elements[0].customData.dshSourcePath,job.items[0].outputs[0].path);const oneClick=await direct();assert.equal(oneClick.status,'ready',oneClick.message);assert.equal(oneClick.exports.length,1);assert.equal(oneClick.generationAttempts,0);
});
