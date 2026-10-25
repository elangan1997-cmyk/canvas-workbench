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
