import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectLayerReadback,parseReadbackResult,layerReadbackTimeout} from '../../src/host/services/layered-image-readback.js';

test('readback accepts multiple complete JSON blocks without dropping issues, while rejecting truncated output',()=>{
 assert.deepEqual(parseReadbackResult('<think>reason {ignored}</think>```json\n{"issues":[{"id":"a","reason":"a {brace} and \\\"quote\\\""}]}\n```\n{"issues":[{"id":"b","reason":"错字"}]}').issues.map(i=>i.id),['a','b']);
 assert.throws(()=>parseReadbackResult('{"issues":[]}\n{"issues":['),/完整/);
 assert.throws(()=>parseReadbackResult('{"other":[]}'),/问题数组/);
 assert.equal(parseReadbackResult('{"id":"t","text":"原文","x":1,"y":2,"width":3,"height":4}').issues[0].text,'原文');
 assert.equal(parseReadbackResult('```json\n[{"id":"t","reason":"实际差异"}]\n```').issues.length,1);
 assert.throws(()=>parseReadbackResult('[{"id":"t","reason":"实际差异"},'));
});

test('complete readback retains spatial evidence for text missing from the IR, including multiple missing rows',async t=>{
 const root=await mkdtemp(join(tmpdir(),'readback-missing-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const ctx={attachments:{saveImage:async()=>({id:'crop'})},llm:{prepareCall:async()=>({config:{},stream:async function*(){yield{type:'text-delta',index:0,text:JSON.stringify({issues:[{id:'missing',kind:'missing-text',text:'奶茶',x:10,y:20,width:30,height:10},{id:'missing',kind:'missing-text',text:'16/M',x:50,y:20,width:25,height:10}]})};yield{type:'finish',reason:{kind:'stop'}};}})}};
 const result=await inspectLayerReadback(ctx,{directory:root,source:'source',width:100,height:100,reconstruction:'complete',analysisModel:{provider:'ds',model:'current'},elements:[]},'preview',new AbortController().signal,{pixel:async spec=>writeFile(spec.output,spec.input)});
 assert.equal(result.complete,true);assert.equal(result.issues.length,2);assert.equal(result.issues[0].kind,'missing-text');assert.equal(result.issues[0].x,10);assert.notEqual(result.issues[0].id,result.issues[1].id);
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

test('known text repairs retain source positions, colors, vertical parts and explicit removals',async t=>{
 const root=await mkdtemp(join(tmpdir(),'readback-typed-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const ctx={attachments:{saveImage:async()=>({id:'crop'})},llm:{prepareCall:async()=>({config:{},stream:async function*(){yield{type:'text-delta',index:0,text:JSON.stringify({issues:[{id:'t',text:'棒打鲜橙',x:10,y:20,width:60,height:50,color:'#111111',parts:[{text:'棒打',layout:'vertical',x:10,y:20,width:20,height:50},{text:'鲜橙',layout:'vertical',x:40,y:20,width:20,height:50}]},{id:'fake',absent:true,reason:'原图无此底框'},{id:'art',text:'推荐',typographyKind:'handwriting',x:10,y:5,width:30,height:15,color:'#101010'}]})};yield{type:'finish',reason:{kind:'stop'}};}})}};
 const result=await inspectLayerReadback(ctx,{directory:root,source:'source',width:100,height:100,reconstruction:'complete',analysisModel:{provider:'ds',model:'current'},elements:[{id:'t',enabled:true,type:'text',x:10,y:20,width:60,height:50},{id:'fake',enabled:true,type:'shape',x:0,y:0,width:10,height:10},{id:'art',enabled:true,type:'text',x:10,y:5,width:30,height:15}]},'preview',new AbortController().signal,{pixel:async spec=>writeFile(spec.output,spec.input)});
 assert.equal(result.issues[0].sourceConfirmed,true);assert.equal(result.issues[0].parts.length,2);assert.equal(result.issues[0].parts[1].layout,'vertical');assert.equal(result.issues[0].color,'#111111');assert.equal(result.issues[1].absent,true);assert.equal(result.issues[2].typographyKind,'handwriting');
});

test('unplanned images and shapes are retained; an unlocated issue cannot silently pass verification',async t=>{
 const root=await mkdtemp(join(tmpdir(),'readback-open-world-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const ctx={attachments:{saveImage:async()=>({id:'crop'})},llm:{prepareCall:async()=>({config:{},stream:async function*(){yield{type:'text-delta',index:0,text:JSON.stringify({issues:[{id:'missing',kind:'missing-image',visualKind:'product',name:'漏掉的水果',description:'原图左侧一颗',x:5,y:5,width:20,height:30,reason:'原图存在且预览遗漏'},{id:'missing',kind:'missing-shape',fill:'#88CC00',radius:5,x:50,y:20,width:30,height:10,reason:'原图标签底框遗漏'},{id:'unknown-object',reason:'仍有未定位对象'}]})};yield{type:'finish',reason:{kind:'stop'}};}})}};
 const result=await inspectLayerReadback(ctx,{directory:root,source:'source',width:100,height:100,reconstruction:'complete',analysisModel:{provider:'ds',model:'current'},elements:[]},'preview',new AbortController().signal,{pixel:async spec=>writeFile(spec.output,spec.input)});
 assert.equal(result.issues.length,2);assert.equal(result.issues[0].kind,'missing-image');assert.equal(result.issues[1].kind,'missing-shape');assert.notEqual(result.issues[0].id,result.issues[1].id);assert.equal(result.complete,false);assert.equal(result.incompleteRegions.length,1);
});

test('dense complete verification has time for independent source regions instead of timing out the whole menu at four minutes',()=>{assert.equal(layerReadbackTimeout({width:100,height:100,reconstruction:'complete'}),240000);assert.equal(layerReadbackTimeout({width:2807,height:1992,reconstruction:'complete'}),900000);assert.equal(layerReadbackTimeout({width:2807,height:1992,reconstruction:'preserve'}),240000);});
