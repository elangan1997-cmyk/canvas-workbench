import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {refineLayerSourceRegions} from '../../src/host/services/layered-image-regions.js';

test('local pixel context refines the complete cup before source cropping, leaving locked objects alone',async t=>{
 const root=await mkdtemp(join(tmpdir(),'cup-region-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const ctx={attachments:{saveImage:async()=>({id:'crop'})},llm:{prepareCall:async()=>({config:{},stream:async function*(){calls++;yield{type:'text-delta',index:0,text:JSON.stringify({regions:[{id:'cup',x:30,y:30,width:80,height:160}]})};yield{type:'finish',reason:{kind:'stop'}};}})}};
 const original={id:'cup',name:'杯子',type:'image',visualKind:'product',enabled:true,x:40,y:40,width:60,height:100};
 const task={directory:root,source:'source',width:500,height:500,analysisModel:{provider:'ds',model:'current'},elements:[original,{...original,id:'locked',geometryLocked:true}]};
 const result=await refineLayerSourceRegions(ctx,task,async spec=>spec.output?writeFile(spec.output,'crop'):{bounds:null},new AbortController().signal);
 assert.equal(calls,1);assert.ok(result.elements[0].y+result.elements[0].height>original.y+original.height);assert.deepEqual(result.elements[1],task.elements[1]);assert.deepEqual(original,task.elements[0]);assert.equal(result.version,2);
});

test('complete mode verifies large photography groups and caches the same source boundary decision',async t=>{
 const root=await mkdtemp(join(tmpdir(),'large-region-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const ctx={attachments:{saveImage:async()=>({id:'crop'})},llm:{prepareCall:async()=>({config:{},stream:async function*(){calls++;yield{type:'text-delta',index:0,text:JSON.stringify({regions:[{id:'hero',x:20,y:20,width:200,height:300}]})};yield{type:'finish',reason:{kind:'stop'}};}})}};
 const task={directory:root,source:'source',sourceHash:'original',width:500,height:500,reconstruction:'complete',analysisModel:{provider:'ds',model:'current'},elements:[{id:'hero',type:'image',visualKind:'product',enabled:true,name:'实拍组合',x:40,y:50,width:200,height:300}]};
 const pixel=async spec=>spec.output?writeFile(spec.output,'source-crop'):{bounds:null};
 const result=await refineLayerSourceRegions(ctx,task,pixel,new AbortController().signal);assert.equal(result.elements[0].sourceBoundsConfirmed,true);assert.equal(calls,1);
 await refineLayerSourceRegions(ctx,task,pixel,new AbortController().signal);assert.equal(calls,1,'source crop boundary decisions survive restart without re-query');
});


test('source boundary max-token failures split to individual objects and persist successful subgroups',async t=>{
 const root=await mkdtemp(join(tmpdir(),'regions-split-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const ctx={attachments:{saveImage:async()=>({id:'crop'})},llm:{prepareCall:async()=>({config:{},stream:async function*(request){calls++;const rows=request.messages[0].content.filter(c=>c.type==='text').map(c=>JSON.parse(c.text));if(rows.length>1){yield{type:'finish',reason:{kind:'max-tokens'}};return;}yield{type:'text-delta',index:0,text:JSON.stringify({regions:rows.map(r=>({id:r.id,...r.approximateBox}))})};yield{type:'finish',reason:{kind:'stop'}};}})}};
 const task={directory:root,source:'source',width:500,height:500,analysisModel:{provider:'ds',model:'current'},elements:[0,1].map(i=>({id:'cup'+i,name:'杯子'+i,type:'image',visualKind:'product',enabled:true,x:50+i*100,y:50,width:50,height:100}))};
 const pixel=async spec=>spec.output?writeFile(spec.output,'source'):{bounds:null};const a=await refineLayerSourceRegions(ctx,task,pixel,new AbortController().signal);assert.ok(a.elements.every(e=>e.sourceBoundsConfirmed));assert.equal(calls,4);await refineLayerSourceRegions(ctx,task,pixel,new AbortController().signal);assert.equal(calls,4,'oversized grouping is not re-purchased after resume');
});
