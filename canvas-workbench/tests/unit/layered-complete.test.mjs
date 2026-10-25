import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {completeLayerPlan,completeLayerAudit,deduplicateCompleteText} from '../../src/host/services/layered-complete-policy.js';
import {prepareLayerSourceHd} from '../../src/host/services/layered-source-hd.js';
import {codexImageRequestOptions} from '../../src/providers/image/dsh-codex.provider.js';

test('complete policy separates product/text without matting rectangular photo panels, and audit rejects flattened text',()=>{
 const rows=completeLayerPlan([{id:'b',type:'background',enabled:true},{id:'p',type:'image',visualKind:'product',sourceRegion:true,enabled:true},
 {id:'photo',type:'image',visualKind:'photo-panel',enabled:true},{id:'t',type:'text',sourceParentId:'p',sourceTextFallback:true,textMode:'image',enabled:false}]);
 assert.equal(rows[1].extractionMode,'cutout');assert.equal(rows[1].sourceRegion,undefined);assert.equal(rows[1].preserveSource,false);
 assert.equal(rows[2].extractionMode,'photo');assert.equal(rows[2].sourceRegion,true);assert.equal(rows[3].enabled,true);assert.equal(rows[3].textMode,'editable');
 assert.deepEqual(completeLayerAudit(rows).rasterText,['t']);rows[3].nativeText=true;assert.equal(completeLayerAudit(rows).complete,true);
});

test('explicit Codex image size is validated independently of the prompt',()=>{
 assert.deepEqual(codexImageRequestOptions({dshCodexSize:'3840x2720'}),{size:'3840x2720',quality:'high'});
 assert.throws(()=>codexImageRequestOptions({dshCodexSize:'3844x2728'}),/16/);assert.throws(()=>codexImageRequestOptions({dshCodexSize:'9999x9999'}));
 assert.deepEqual(codexImageRequestOptions(),{});
});

test('HD preprocessing persists the returned master, separately aligns original evidence and never buys it twice',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'layer-hd-'));t.after(()=>rm(dir,{recursive:true,force:true}));const original=join(dir,'source.png');await writeFile(original,'original');
 const task={directory:dir,source:original,width:1922,height:1364,engine:'dsh-codex',maxImageRequests:1,generationAttempts:0};let generated=0,referenceInput;
 const runtime={ctx:{},save:async()=>{},generate:async args=>{generated++;assert.equal(args.maxAttempts,1);assert.equal(args.settingsOverride.dshCodexSize,'3840x2720');return {bytes:Buffer.from('HD')};},pixel:async spec=>{
  if(spec.operation==='inspect'){if(spec.output)await writeFile(spec.output,await readFile(spec.input));return spec.input===original?{width:1922,height:1364}:{width:3840,height:2720};}
  if(spec.operation==='reference-canvas'){referenceInput=spec.input;await writeFile(spec.output,'aligned original');return {};}
  throw Error(spec.operation);
 }};
 await prepareLayerSourceHd(task,{},new AbortController().signal,runtime);await prepareLayerSourceHd(task,{},new AbortController().signal,runtime);
 assert.equal(generated,1);assert.equal(task.generationAttempts,1);assert.equal(referenceInput,original);assert.notEqual(task.source,task.analysisSource);
 assert.equal(task.sourceHd.resolutionGoalMet,true);assert.equal(await readFile(task.analysisSource,'utf8'),'HD');assert.equal(await readFile(task.source,'utf8'),'aligned original');assert.equal(await readFile(original,'utf8'),'original');
});

test('complete text deduplication removes an OCR duplicate only when every character is already represented',()=>{
 const rows=[{id:'a',type:'text',enabled:true,nativeText:true,text:'奶茶',x:0,y:0,width:40,height:20},
 {id:'price',type:'text',enabled:true,nativeText:true,text:'16/M',x:60,y:0,width:40,height:20},
 {id:'covered',type:'text',sourceTextSupplement:true,enabled:true,text:'奶茶 16/M',x:0,y:0,width:100,height:20},
 {id:'incomplete',type:'text',sourceTextSupplement:true,enabled:true,text:'奶茶 16/M 18/L',x:0,y:0,width:130,height:20}];
 deduplicateCompleteText(rows);assert.equal(rows[2].enabled,false);assert.equal(rows[3].enabled,true,'a missing price cannot disappear with a duplicate row');
});

test('an unconfirmed source glyph is explicitly non-editable even when independent separation is complete',()=>{
 const report=completeLayerAudit([{id:'t',type:'text',enabled:true,nativeText:true},{id:'tiny',type:'image',enabled:true,visualKind:'graphic',extractionMode:'cutout',unresolvedAsGlyph:true,typographyKind:'unreadable',sourceGlyphReason:'原图微字无法确认'}]);
 assert.equal(report.complete,true);assert.equal(report.allTextEditable,false);assert.equal(report.unconfirmedGlyphs[0].id,'tiny');assert.equal(report.editableText,1);
});

test('ignored single-image resolution triggers bounded resumable model tiles, never interpolation labelled as HD',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'layer-hd-tiles-'));t.after(()=>rm(dir,{recursive:true,force:true}));const original=join(dir,'original.png'),candidate=join(dir,'candidate.png');await writeFile(original,'original');await writeFile(candidate,'small');
 const task={directory:dir,source:original,suppliedHdSource:candidate,width:1922,height:1364,engine:'dsh-codex',maxImageRequests:2,generationAttempts:0};let calls=0;
 const runtime={ctx:{},save:async()=>{},generate:async()=>{calls++;return {bytes:Buffer.from('tile')};},pixel:async spec=>{
  if(spec.operation==='inspect')return spec.input===original?{width:1922,height:1364}:{width:1490,height:1056};
  if(spec.operation==='analysis-crop'){await writeFile(spec.output,'crop');return {};}
  if(spec.operation==='stitch-hd-tiles'){assert.equal(spec.tiles.length,4);await writeFile(spec.output,'stitched');return {width:2700,height:1916};}
  if(spec.operation==='reference-canvas'){await writeFile(spec.output,'aligned');return {};}
  throw Error(spec.operation);
 }};
 await assert.rejects(prepareLayerSourceHd(task,{},new AbortController().signal,runtime),/额度/);
 assert.equal(calls,2);task.maxImageRequests=4;await prepareLayerSourceHd(task,{},new AbortController().signal,runtime);
 assert.equal(calls,4,'already returned sibling tiles are reused');assert.equal(task.generationAttempts,4);assert.equal(task.sourceHd.resolutionGoalMet,true);assert.equal(task.sourceHd.tiled,true);
});
