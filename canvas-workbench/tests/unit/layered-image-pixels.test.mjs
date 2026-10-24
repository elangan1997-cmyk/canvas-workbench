import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

test('independent layer canvases and alpha crops return to long-image coordinates without accepting a mismatched background', t => {
  const python = process.env.DSH_TEST_PYTHON || join(homedir(), '.dsh/canvas-workbench/psd-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (spawnSync(python,['-c','from PIL import Image']).status !== 0) return t.skip('Python/Pillow unavailable');
  const script = `
import sys,tempfile
from pathlib import Path
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw,ImageChops
from layered_image import normalize,crop_layer
with tempfile.TemporaryDirectory() as temp:
 root=Path(temp);raw=root/'raw.png';out=root/'placed.png'
 e={'name':'独立照片','x':30,'y':140,'width':120,'height':70}
 spec={'input':str(raw),'output':str(out),'width':240,'height':500,'element':e}
 im=Image.new('RGBA',(480,280));ImageDraw.Draw(im).rectangle((20,20,459,259),fill='#28a060');im.save(raw)
 r=normalize(spec);assert r['framing']=='layer-alpha-bounds',r
 assert not r['placementIssues'],r
 placed=Image.open(out).copy();assert placed.size==(240,500)
 assert placed.getpixel((90,175))==(40,160,96,255)
 assert placed.getpixel((29,140))[3]==0 and placed.getpixel((150,210))[3]==0
 # Cached full-size images retain the already accepted placement/padding.
 normalize({**spec,'input':str(out),'preserve_placement':True})
 assert ImageChops.difference(placed,Image.open(out)).getbbox() is None
 content=root/'crop.png';r=crop_layer({'input':str(out),'output':str(content)})
 assert Image.open(content).size==(r['bounds']['width'],r['bounds']['height'])
 # A square engine canvas with a tight matching transparent layer is also valid.
 im=Image.new('RGBA',(500,500));ImageDraw.Draw(im).rectangle((10,100,249,239),fill='#28a060');im.save(raw)
 r=normalize(spec);assert r['framing']=='layer-alpha-bounds',r
 assert Image.open(out).getchannel('A').getbbox()==(30,140,150,210)
 # Visible content is uniformly fitted even when the engine canvas happens to match.
 im=Image.new('RGBA',(480,280));ImageDraw.Draw(im).rectangle((20,40,459,239),fill='#28a060');im.save(raw)
 r=normalize(spec);assert r['placementIssues'][0]['code']=='layer-content-bounds-review',r
 im=Image.new('RGBA',(500,500));ImageDraw.Draw(im).rectangle((10,100,249,239),fill='#28a060');im.save(raw)
 for invalid in [{**spec,'element':{**e,'nativeText':True}},{**spec,'element':{**e,'x':-10}}]:
  try:normalize(invalid)
  except ValueError as error:assert '500×500' in str(error) and '240×500' in str(error),str(error)
  else:raise AssertionError('invalid aspect must stay blocked')
print('PASS: cropped formats, long canvas coordinates, cache idempotence, exact PNG bounds and background rejection')
`;
  const result=spawnSync(python,['-c',script],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('source-pixel extraction preserves exact flat artwork, rejects occlusion and rejects a textured plate', t => {
  const python = process.env.DSH_TEST_PYTHON || join(homedir(), '.dsh/canvas-workbench/psd-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (spawnSync(python, ['-c', 'from PIL import Image']).status !== 0) return t.skip('Python/Pillow unavailable');
  const script = `
import sys,tempfile
from pathlib import Path
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw,ImageChops
from layered_image import source_flat
with tempfile.TemporaryDirectory() as temp:
 root=Path(temp);source=root/'source.png'
 im=Image.new('RGBA',(80,100),(238,234,225,255));d=ImageDraw.Draw(im);d.rectangle((20,20,50,70),fill='#256c5a');d.ellipse((45,55,65,75),fill='#db8044');im.save(source)
 bg={'id':'bg','type':'background','x':0,'y':0,'width':80,'height':100}
 a={'id':'a','type':'image','x':20,'y':20,'width':31,'height':51}
 b={'id':'b','type':'image','x':45,'y':55,'width':21,'height':21}
 elements=[bg,a,b];base={'input':str(source),'elements':elements}
 assert not source_flat({**base,'element':a,'output':str(root/'a.png')})['eligible']
 merged={**a,'width':46,'height':56,'mergedIds':['b']}
 fg=root/'group.png';plate=root/'background.png'
 assert source_flat({**base,'element':merged,'output':str(fg)})['eligible']
 assert source_flat({**base,'element':bg,'output':str(plate)})['eligible']
 rebuilt=Image.alpha_composite(Image.open(plate),Image.open(fg))
 assert ImageChops.difference(im,rebuilt).convert('RGB').getbbox() is None
 assert Image.open(fg).getpixel((30,30))==(37,108,90,255)
 assert Image.open(fg).getpixel((0,0))[3]==0
 d.line((0,0,79,99),fill='black',width=2);im.save(source)
 assert not source_flat({**base,'element':bg,'output':str(plate)})['eligible']
print('PASS: exact source pixels, merged masks, overlap and texture gates')
`;
  const result = spawnSync(python, ['-c', script], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('generated cutouts match reviewed source rectangles and cropped PNG dimensions roundtrip into the original canvas', t => {
  const python = process.env.DSH_TEST_PYTHON || join(homedir(), '.dsh/canvas-workbench/psd-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (spawnSync(python,['-c','from PIL import Image']).status !== 0) return t.skip('Python/Pillow unavailable');
  const script = `
import sys,tempfile
from pathlib import Path
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw,ImageChops
from layered_image import normalize,crop_layer,assemble,looks_like_checkerboard
with tempfile.TemporaryDirectory() as temp:
 p=Path(temp)/'cutout.png';out=Path(temp)/'placed.png'
 im=Image.new('RGBA',(200,200));ImageDraw.Draw(im).rectangle((50,80,150,110),fill='#ff6900');im.putpixel((0,199),(255,255,255,1));im.save(p)
 spec={'input':str(p),'output':str(out),'width':200,'height':200,'element':{'x':20,'y':10,'width':100,'height':30}}
 result=normalize(spec);assert result['aligned']
 placed=Image.open(out).copy();box=placed.getchannel('A').getbbox()
 assert box==(21,10,119,40)  # uniform scale preserves the 101:31 cutout shape
 assert placed.getpixel((70,20))==(255,105,0,255)
 normalize({**spec,'input':str(out)})
 assert ImageChops.difference(placed,Image.open(out)).getbbox() is None
 cut=Path(temp)/'content.png';cropped=crop_layer({'input':str(out),'output':str(cut)})
 assert Image.open(cut).size==(cropped['bounds']['width'],cropped['bounds']['height'])
 e={'id':'a','name':'A','file':str(out),'contentFile':str(cut),'bounds':cropped['bounds'],'z':1,'enabled':True}
 built=assemble({'directory':temp,'width':200,'height':200,'elements':[e]})
 assert ImageChops.difference(placed,Image.open(built['preview'])).getbbox() is None
 bad=Image.new('RGBA',(200,200));ImageDraw.Draw(bad).rectangle((5,5,190,190),fill='red');bad.save(p)
 try:normalize({**spec,'element':{'x':0,'y':0,'width':150,'height':10}})
 except ValueError:pass
 else:raise AssertionError('mixed content must not be squeezed into the element box')
 grid=Image.new('RGB',(600,800),'white');draw=ImageDraw.Draw(grid)
 for y in range(0,800,8):
  for x in range(0,600,8):
   draw.rectangle((x,y,x+7,y+7),fill=(205,205,205) if (x//8+y//8)%2 else (145,145,145))
 draw.rectangle((150,0,500,760),fill='red')
 assert looks_like_checkerboard(grid),'partial grid must be rejected despite foreground contamination'
print('PASS: exact source rectangle, natural PNG bounds, assembly roundtrip and fake grid guard')
`;
  const result=spawnSync(python,['-c',script],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('padded portrait responses fit wide photo regions without distortion or repeated scaling', t => {
  const python = process.env.DSH_TEST_PYTHON || join(homedir(), '.dsh/canvas-workbench/psd-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (spawnSync(python,['-c','from PIL import Image']).status !== 0) return t.skip('Python/Pillow unavailable');
  const script = `
import sys,tempfile
from pathlib import Path
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw,ImageChops
from layered_image import normalize,crop_layer
with tempfile.TemporaryDirectory() as temp:
 root=Path(temp);raw=root/'raw.png';out=root/'out.png'
 e={'id':'photo','name':'鱼缸','x':0,'y':324,'width':790,'height':556}
 spec={'input':str(raw),'output':str(out),'width':790,'height':1798,'element':e}
 # Same dimensions/padding as the real failed return, including soft alpha edges.
 im=Image.new('RGBA',(1105,1423));d=ImageDraw.Draw(im)
 d.rectangle((0,375,1104,1025),fill=(20,120,80,12));d.rectangle((0,380,1104,1023),fill=(20,120,80,255));im.save(raw)
 r=normalize(spec);assert r['framing']=='layer-alpha-bounds' and r['aligned']['mode']=='contain',r
 assert r['aligned']['from']==[0,375,1105,1026],r
 placed=Image.open(out).copy();assert placed.size==(790,1798)
 box=placed.getchannel('A').getbbox();assert r['aligned']['to']==[0,370,790,835],r
 assert box[0]==0 and box[2]==790 and 370<=box[1]<=371 and 834<=box[3]<=835,box
 assert abs(790/465-1105/651)<.005
 assert r['semiTransparentPixels']>0 and placed.getpixel((395,369))[3]==0
 assert r['placementIssues'][0]['severity']=='warning',r
 normalize({**spec,'input':str(out),'preserve_placement':True})
 assert ImageChops.difference(placed,Image.open(out)).getbbox() is None
 cropped=crop_layer({'input':str(out),'output':str(root/'natural.png')})
 assert Image.open(root/'natural.png').size==(cropped['bounds']['width'],cropped['bounds']['height'])
 # Enlargement uses the same placement, with exact ROI coverage for a matching ratio.
 im=Image.new('RGBA',(100,100));ImageDraw.Draw(im).rectangle((10,40,89,59),fill='#20a060');im.save(raw)
 r=normalize({**spec,'element':{**e,'width':640,'height':160}})
 assert Image.open(out).getchannel('A').getbbox()==(0,324,640,484)
 assert not r['placementIssues']
 # Opaque independent photos also adapt; they can be matted afterwards.
 Image.new('RGBA',(800,400),'blue').save(raw)
 r=normalize({**spec,'element':{**e,'width':640,'height':360}})
 assert Image.open(out).getchannel('A').getbbox()==(0,344,640,664)
 assert r['framing']=='layer-canvas' and r['placementIssues']
 # A moderately different background canvas covers the document without gaps.
 Image.new('RGBA',(800,1200),'blue').save(raw)
 r=normalize({**spec,'background':True})
 assert r['framing']=='background-cover' and r['alphaMin']==255,r
 assert Image.open(out).size==(790,1798)
 # Transparent or wildly mismatched backgrounds remain invalid.
 for size,fill in [((800,1200),(0,0,255,0)),((800,400),'blue')]:
  Image.new('RGBA',size,fill).save(raw)
  try:normalize({**spec,'background':True})
  except ValueError:pass
  else:raise AssertionError('invalid background must stay blocked')
print('PASS: real return dimensions, soft alpha, uniform shrink/enlarge, ROI bounds and cache stability')
`;
  const result=spawnSync(python,['-c',script],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('background reconstruction does not reintroduce photo strips outside imperfect model boxes', t => {
  const python=process.env.DSH_TEST_PYTHON || join(homedir(),'.dsh/canvas-workbench/psd-runtime',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  if(spawnSync(python,['-c','from PIL import Image']).status!==0)return t.skip('Python/Pillow unavailable');
  const result=spawnSync(python,['-c',`
import sys,tempfile
from pathlib import Path
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw
from layered_image import background_plate
from refine_layered_text import clean_background
with tempfile.TemporaryDirectory() as tmp:
 p=Path(tmp);original=Image.new('RGBA',(200,220),'#dce8f4');d=ImageDraw.Draw(original);d.rectangle((0,80,199,180),fill='#303030');original.save(p/'source.png')
 Image.new('RGBA',(200,220),'#dce8f4').save(p/'generated.png')
 r=background_plate({'source':str(p/'source.png'),'input':str(p/'generated.png'),'output':str(p/'out.png'),'elements':[{'type':'image','x':0,'y':80,'width':200,'height':60}]})
 out=Image.open(p/'out.png');assert out.getpixel((100,175))[:3]==(220,232,244),'unmasked photo tail must not be restored'
 assert out.getpixel((10,10))==original.getpixel((10,10)),'verified source background must survive'
 # Smooth light-ray variation with no remaining original ink is already clean.
 grad=Image.new('RGBA',(200,220));gp=grad.load()
 for y in range(220):
  for x in range(200):gp[x,y]=(170+x//3,190+x//4,210+x//5,255)
 dirty=grad.copy();ImageDraw.Draw(dirty).rectangle((30,40,150,60),fill='#183865');dirty.save(p/'source.png');grad.save(p/'out.png')
 spec={'source':str(p/'source.png'),'input':str(p/'out.png'),'output':str(p/'clean.png'),'elements':[{'id':'title','nativeText':True,'enabled':True,'color':'#183865','x':20,'y':30,'width':150,'height':40}]}
 q=clean_background(spec);assert not q['issues'],q
 dirty.save(p/'out.png');q=clean_background(spec);assert q['issues'],'real residual ink on a varied surface must remain blocked'
print('PASS: no residual photo strip; clean gradients accepted; real residual ink still blocked')
`],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});

test('rectangular photos keep their own scene and label capsules become independent shapes without touching other pixels', t => {
 const python=process.env.DSH_TEST_PYTHON||join(homedir(),'.dsh/canvas-workbench/psd-runtime',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 if(spawnSync(python,['-c','from PIL import Image']).status!==0)return t.skip('Python/Pillow unavailable');
 const r=spawnSync(python,['-c',`
import sys,tempfile
from pathlib import Path
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw,ImageChops
from layered_structure import inspect_structure,render_local,rounded_mask
from layered_image import crop_layer
with tempfile.TemporaryDirectory() as tmp:
 p=Path(tmp);im=Image.new('RGBA',(240,320),'#aabbd0');d=ImageDraw.Draw(im)
 d.rectangle((10,80,229,219),fill='#375e32');d.rectangle((20,90,220,210),outline='#779e52',width=2)
 d.rounded_rectangle((35,105,184,144),radius=20,fill='#eef2fa');d.rectangle((50,116,169,131),fill='#152030');im.save(p/'source.png')
 photo={'id':'photo','type':'image','name':'完整照片','x':10,'y':80,'width':220,'height':140,'z':1,'enabled':True}
 text={'id':'label','type':'text','name':'标签','x':50,'y':116,'width':120,'height':16,'z':3,'enabled':True,'nativeText':True}
 plan=inspect_structure({'input':str(p/'source.png'),'elements':[photo,text]})
 shapes=[e for e in plan['elements'] if e['type']=='shape'];assert len(shapes)==1,plan
 plate=shapes[0];assert plate['textElementId']=='label' and 1<plate['z']<3
 photo=plan['elements'][0];assert photo['extractionMode']=='photo' and photo['width']==220
 render_local({'input':str(p/'source.png'),'output':str(p/'photo.png'),'element':photo,'elements':plan['elements']})
 result=Image.open(p/'photo.png');assert result.getpixel((15,85))==(55,94,50,255),'photo scene background must remain opaque'
 assert result.getpixel((60,120))[:3]!=(21,32,48),'old text must not remain baked into the photo'
 original=im.crop((10,80,230,220));actual=result.crop((10,80,230,220));mask=rounded_mask((220,140),plate,(10,80),3)
 diff=ImageChops.difference(original,actual).convert('RGB');outside=ImageChops.invert(mask)
 for channel in diff.split():assert ImageChops.multiply(channel,outside).getbbox() is None,'source pixels outside the covered label changed'
 crop=crop_layer({'input':str(p/'photo.png'),'output':str(p/'natural.png')});assert crop['width']==220 and crop['height']==140 and crop['alphaMin']==255
 render_local({'input':str(p/'source.png'),'output':str(p/'shape.png'),'element':plate,'elements':plan['elements']})
 shape=Image.open(p/'shape.png');assert shape.getpixel((100,120))[3]==255 and shape.getpixel((10,80))[3]==0
 # Explicit isolated subjects must not be reclassified from their rectangular search box.
 isolated=inspect_structure({'input':str(p/'source.png'),'elements':[{**photo,'extractionMode':'cutout','modeLocked':True}]})
 assert isolated['elements'][0]['extractionMode']=='cutout'
 mistaken=inspect_structure({'input':str(p/'source.png'),'elements':[{**photo,'extractionMode':'cutout'},text]})
 assert mistaken['elements'][0]['extractionMode']=='photo','source frames must correct a model classification mistake'
 # A whole white page is not a closed text capsule.
 Image.new('RGB',(240,320),'white').save(p/'white.png')
 plain=inspect_structure({'input':str(p/'white.png'),'elements':[text]});assert len(plain['elements'])==1
print('PASS: photo background opacity, exact uncovered pixels, independent shape and false-capsule guard')
`],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);
});
