import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectLayerReadback,parseReadbackResult} from '../../src/host/services/layered-image-readback.js';

test('readback accepts multiple complete JSON blocks without dropping issues, while rejecting truncated output',()=>{
 assert.deepEqual(parseReadbackResult('<think>reason {ignored}</think>```json\n{"issues":[{"id":"a","reason":"a {brace} and \\\"quote\\\""}]}\n```\n{"issues":[{"id":"b","reason":"错字"}]}').issues.map(i=>i.id),['a','b']);
 assert.throws(()=>parseReadbackResult('{"issues":[]}\n{"issues":['),/完整/);
 assert.throws(()=>parseReadbackResult('{"other":[]}'),/问题数组/);
});

test('dense readback isolates token limits and caches unchanged verification regions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'readback-'));t.after(()=>rm(root,{recursive:true,force:true}));let fail=true,calls=0;const budgets=[];
 const ctx={attachments:{saveImage:async({data})=>({...JSON.parse(Buffer.from(data).toString()),id:'crop'})},llm:{prepareCall:async spec=>{budgets.push(spec.maxTokens);return {config:{},stream:async function*(request){calls++;const r=request.messages[0].content[1].attachment.region;if(fail&&r.x===0&&r.y===0){if(r.width<900){yield{type:'finish',reason:{kind:'provider-error'}};return;}yield{type:'text-delta',index:0,text:'{"issues":['};yield{type:'finish',reason:{kind:'max-tokens'}};}else{yield{type:'text-delta',index:0,text:'{"issues":[]}'};yield{type:'finish',reason:{kind:'stop'}};}}};}}};
 const task={directory:root,source:'source',width:2000,height:1400,analysisModel:{provider:'ds',model:'current'},elements:[]};
 const runtime={pixel:async spec=>writeFile(spec.output,JSON.stringify({region:spec.region,input:spec.input}))};
 let result=await inspectLayerReadback(ctx,task,'preview',new AbortController().signal,runtime);
 assert.equal(result.complete,false);assert.equal(result.checkedRegions,4);assert.equal(result.incompleteRegions.length,1);assert.equal(calls,7);assert.ok(budgets.includes(16000));
 fail=false;result=await inspectLayerReadback(ctx,task,'preview',new AbortController().signal,runtime);assert.equal(result.complete,true);assert.equal(calls,8,'only the failed region must be retried');
 await inspectLayerReadback(ctx,task,'preview',new AbortController().signal,runtime);assert.equal(calls,8,'verified neighbours and the resumed tile must now all be cached');
});
