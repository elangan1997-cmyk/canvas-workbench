import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { analyzeLayeredImage, normalizeLayerElements, extractionPrompt, verifyLayerTextContent } from '../../src/host/services/layered-image-model.js';
import { automaticLayerQuality, hasBlockingLayerQuality, calibrateLayeredAnalysis, layerTextConflicts } from '../../src/host/services/layered-image-refinement.js';

test('high-confidence OCR omissions go back to the selected vision model, never into a silent OCR overwrite',async()=>{
 const elements=[{id:'t',type:'text',text:'散装发货实拍即所见',enabled:true,x:179,y:1288,width:433,height:43}];
 const conflicts=layerTextConflicts(elements,[{text:'散装发货实拍即为所见',confidence:99.3,x:181,y:1290,width:429,height:39}]);
 assert.equal(conflicts.length,1);assert.equal(elements[0].text,'散装发货实拍即所见');
 const ctx={attachments:{saveImage:async()=>({id:'original'})},llm:{prepareCall:async body=>{assert.equal(body.model,'selected-ds');return {config:{},stream:async function*({messages,purpose}){
  assert.equal(purpose,'canvas-layer-text-check');assert.ok(messages.length);
  yield{type:'text-delta',index:0,text:JSON.stringify({corrections:[{id:'t',text:'散装发货实拍即为所见',reason:'原图存在为字'},{id:'t',text:'模型凭空新增的促销文案'}]})};yield{type:'finish',reason:{kind:'stop'}};
 }}}}};
 const r=await verifyLayerTextContent(ctx,{bytes:Buffer.from('original'),mime:'image/png'},{provider:'ds',model:'selected-ds'},conflicts,new AbortController().signal);
 assert.deepEqual(r,[{id:'t',text:'散装发货实拍即为所见',reason:'原图存在为字'}]);
 assert.equal(layerTextConflicts(elements,[{text:'散装发货实拍即为所见',confidence:50,x:181,y:1290,width:429,height:39}]).length,0);
});

test('model must decide product versus framed photo before extraction, with one bounded semantic retry', async()=>{
  let calls=0;
  const ctx={attachments:{saveImage:async()=>({id:'image'})},llm:{resolveModelInfo:async()=>({}),prepareCall:async()=>({config:{},stream:async function*({system}){
    calls++;assert.match(system,/接触阴影/);assert.match(system,/framingEvidence/);
    yield {type:'text-delta',index:0,text:JSON.stringify({elements:[{id:'product',type:'image',x:30,y:300,width:900,height:470,extractionMode:'photo',
      ...(calls>1?{visualKind:'product',classificationReason:'商品与台面连续，无独立照片边框',shadowMode:'preserve'}:{})}]})};
    yield {type:'finish',reason:{kind:'stop'}};
  }})}};
  const r=await analyzeLayeredImage(ctx,{bytes:Buffer.from('image'),mime:'image/png'},{provider:'selected',model:'ds'},790,1452,new AbortController().signal);
  assert.equal(calls,2);assert.equal(r.semanticPolicyVersion,2);
  const e=r.elements.find(e=>e.id==='product');assert.equal(e.extractionMode,'cutout');assert.equal(e.shadowMode,'preserve');
  assert.match(extractionPrompt(e,r.elements,790,1452),/半透明Alpha/);
  assert.match(extractionPrompt(r.elements[0],r.elements,790,1452),/阴影与倒影也要移除/);
  assert.equal(normalizeLayerElements([{...e,modeLocked:true,extractionMode:'photo'}],790,1452)[1].extractionMode,'photo','an explicit user override remains authoritative');
});

test('visual warnings cannot require acceptance; invalid geometry is never waived by acknowledgement',()=>{
  const q=automaticLayerQuality({status:'needs_review',issues:[{id:'t',code:'font-fit-unresolved',severity:'review'},{code:'textured-background',severity:'review'}]});
  assert.equal(hasBlockingLayerQuality(q),false);assert.ok(q.issues.every(i=>i.severity==='warning'));
  assert.equal(hasBlockingLayerQuality({status:'passed',reviewAcknowledged:true,issues:[{code:'invalid-geometry',severity:'error'}]}),true);
});

test('multiline text calibrates individual original baselines; raster fallback is lossless and product semantics survive edge detection',async t=>{
  const python=process.env.DSH_TEST_PYTHON||join(homedir(),'.dsh/canvas-workbench/psd-runtime',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(spawnSync(python,['-c','from PIL import Image']).status!==0)return t.skip('Python/Pillow unavailable');
  const root=await mkdtemp(join(tmpdir(),'dsh-semantic-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'source.png');
  const setup=spawnSync(python,['-c',`import sys;sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw
from layered_image import strict_font
im=Image.new('RGB',(400,200),'#ECF1F6');d=ImageDraw.Draw(im);f=strict_font('Inter-Regular',28,'First lineSecond line')
d.text((70,48),'First line',font=f,fill='#16253A',anchor='ls');d.text((55,100),'Second line',font=f,fill='#16253A',anchor='ls');im.save(sys.argv[1])`,source],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
  assert.equal(setup.status,0,setup.stderr);
  const elements=normalizeLayerElements([{id:'t',type:'text',name:'两行',text:'First line\nSecond line',color:'#16253A',x:30,y:10,width:300,height:110,z:1}],400,200);
  const h={ctx:{},runProcessWithTimeout:async(exe,args,cwd)=>{
    if(args.some(a=>a.endsWith('ocr_image.py')))return{exitCode:0,stdout:JSON.stringify({blocks:[{text:'First line',x:70,y:27,width:116,height:22},{text:'Second line',x:55,y:79,width:160,height:22}]})};
    const r=spawnSync(exe,args,{cwd,encoding:'utf8'});return{exitCode:r.status,stdout:r.stdout,stderr:r.stderr};
  }};
  const r=await calibrateLayeredAnalysis(h,{source,directory:root,elements,width:400,height:200},{editableText:true,fontPolicy:'substitute'},new AbortController().signal);
  const lines=r.elements.filter(e=>e.type==='text');assert.equal(lines.length,2);assert.ok(lines.every(e=>e.nativeText&&e.fontAccepted),JSON.stringify(r));
  assert.equal(lines[0].text,'First line');assert.equal(lines[1].text,'Second line');assert.ok(lines[1].y-lines[0].y>45);assert.equal(lines[0].textGroupId,'t');assert.equal(r.quality.status,'passed');
  const check=spawnSync(python,['-c',`import sys,tempfile;sys.path.insert(0,'scripts')
from pathlib import Path
from PIL import Image,ImageDraw,ImageChops
from layered_image import source_text
from layered_structure import inspect_structure
im=Image.open(sys.argv[1]).convert('RGBA');out=str(Path(sys.argv[1]).with_name('fallback.png'))
e={'id':'text','type':'text','x':50,'y':20,'width':150,'height':35}
r=source_text({'input':sys.argv[1],'output':out,'element':e});layer=Image.open(out)
assert r['engine']=='source-text-region' and layer.getpixel((0,0))[3]==0
assert ImageChops.difference(im.crop((48,18,202,57)),layer.crop((48,18,202,57))).convert('RGB').getbbox() is None
# A strong rectangular transition in a continuous product scene cannot change
# the model's product decision back to a whole photo panel.
d=ImageDraw.Draw(im);d.rectangle((0,120,399,199),fill='#202020');im.save(sys.argv[1])
p={'id':'p','name':'产品','type':'image','visualKind':'product','classificationReason':'独立商品','extractionMode':'cutout','x':0,'y':120,'width':400,'height':80,'z':1}
r=inspect_structure({'input':sys.argv[1],'elements':[p]});assert r['elements'][0]['extractionMode']=='cutout' and not r['structureChanges']
print('PASS')`,source],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
  assert.equal(check.status,0,check.stdout+check.stderr);
});
