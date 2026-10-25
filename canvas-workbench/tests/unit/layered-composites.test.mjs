import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {splitCompleteComposites} from '../../src/host/services/layered-composites.js';

test('photography surrounding an independently planned cup is decomposed into source-positioned objects without rectangle holes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'source-composite-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const rows=[{id:'hero',name:'水果手部摄影',description:'杯外的水果和手',type:'image',visualKind:'product',enabled:true,x:0,y:50,width:300,height:400,z:1},{id:'cup',name:'杯子',type:'image',visualKind:'product',enabled:true,x:100,y:100,width:80,height:250,z:5}];
 const task={directory:root,source:'original',width:500,height:500,reconstruction:'complete',analysisModel:{provider:'ds',model:'current'}};
 const ctx={attachments:{saveImage:async()=>({id:'source'})},llm:{prepareCall:async()=>({config:{},stream:async function*(){calls++;yield{type:'text-delta',index:0,text:JSON.stringify({elements:[{name:'一颗牛油果',description:'保持原果核',x:20,y:50,width:80,height:100},{name:'手和叉子',description:'保留完整叉子',x:100,y:100,width:100,height:150,frontOf:'cup'}]})};yield{type:'finish',reason:{kind:'stop'}};}})}};
 const pixel=async spec=>writeFile(spec.output,'original-crop');let result=await splitCompleteComposites(ctx,task,rows,pixel,new AbortController().signal);
 assert.equal(rows[0].enabled,true);assert.equal(result[0].enabled,false);const pieces=result.filter(e=>e.sourceCompositeId==='hero');assert.equal(pieces.length,2);assert.ok(pieces.every(e=>e.forceModelCutout&&e.sourceBoundsConfirmed));assert.equal(pieces[1].z,5.5);assert.notEqual(pieces[0].width,pieces[1].width);
 result=await splitCompleteComposites(ctx,task,rows,pixel,new AbortController().signal);assert.equal(calls,1,'source semantic plan is durable and independent of image generation');assert.equal(result.length,4);
 const coherent=await splitCompleteComposites(ctx,task,[{...rows[0],name:'玻璃盛器与内部球体'}],pixel,new AbortController().signal);assert.equal(calls,1);assert.equal(coherent.length,1,'a coherent product without a separately owned nested cup stays intact');
});
