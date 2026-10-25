import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {homedir} from 'node:os';

test('HD cores keep their positions, graphic PNGs have real alpha, and low font matching can still produce editable fitted glyphs',t=>{
 const python=process.env.DSH_TEST_PYTHON||join(homedir(),'.dsh/canvas-workbench/psd-runtime',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 if(spawnSync(python,['-c','from PIL import Image']).status!==0)return t.skip('Python/Pillow unavailable');
 const run=spawnSync(python,['-c',`
import sys,tempfile
from pathlib import Path
sys.path.insert(0,'scripts')
from PIL import Image,ImageDraw
from layered_image import run,strict_font
import refine_layered_text as refine
from infer_text_style import font_candidates
with tempfile.TemporaryDirectory() as temp:
 p=Path(temp);source=p/'original.png';Image.new('RGBA',(40,20),'white').save(source);tiles=[]
 for i,color in enumerate(['red','green','blue','yellow']):
  x,y=i%2*20,i//2*10;f=p/(str(i)+'.png');Image.new('RGBA',(40,20),color).save(f)
  box={'x':x,'y':y,'width':20,'height':10};tiles.append({'id':str(i),'file':str(f),'core':box,'region':box})
 out=p/'stitched.png';result=run({'operation':'stitch-hd-tiles','input':str(source),'output':str(out),'tiles':tiles});assert (result['width'],result['height'])==(80,40)
 im=Image.open(out);assert im.getpixel((0,0))[:3]==(255,0,0) and im.getpixel((79,39))[:3]==(255,255,0);assert im.getchannel('A').getextrema()==(255,255)
 im=Image.new('RGBA',(100,100),'white');ImageDraw.Draw(im).ellipse((20,20,40,40),fill='black');im.save(source)
 e={'id':'art','type':'image','x':18,'y':18,'width':25,'height':25,'foregroundColors':['#000000']};graphic=p/'graphic.png'
 result=run({'operation':'graphic-cutout','input':str(source),'output':str(graphic),'element':e});assert result['eligible'] and result['hasTransparency']
 Image.open(graphic).crop((18,18,43,43)).save(p/'crop.png');placed=p/'placed.png'
 run({'operation':'place-cutout','input':str(p/'crop.png'),'output':str(placed),'width':100,'height':100,'element':{**e,'x':50,'y':50},'elements':[{'id':'printed','type':'text','x':55,'y':55,'width':10,'height':10}]})
 assert Image.open(placed).getchannel('A').getbbox()==(52,52,73,73)
 assert Image.open(placed).getpixel((60,60))[3]==255,'a text bounding box must not punch a hole through the product'
 bad=p/'bad-matte.png';im=Image.new('RGBA',(50,70),'green');im.putpixel((0,0),(0,0,0,0));im.save(bad)
 assert not run({'operation':'matte-quality','input':str(bad)})['accepted'],'one transparent pixel is not a valid product cutout'
 cropframe=p/'frame.png';im=Image.new('RGBA',(40,80));ImageDraw.Draw(im).rectangle((10,40,20,60),fill='red');im.save(cropframe)
 result=run({'operation':'normalize','input':str(cropframe),'output':str(placed),'width':200,'height':200,'element':{'x':30,'y':20,'width':40,'height':80,'forceModelCutout':True}})
 assert Image.open(placed).getchannel('A').getbbox()==(40,60,51,81),'crop framing must preserve internal transparent padding and position'
 product=p/'owned.png';Image.new('RGBA',(10,10),'green').save(product)
 ownership=run({'operation':'text-material-ownership','elements':[{'id':'cup','type':'image','visualKind':'product','enabled':True,'status':'complete','file':str(product),'contentFile':str(product),'bounds':{'x':20,'y':20,'width':10,'height':10}},
 {'id':'printed','type':'text','enabled':True,'x':22,'y':22,'width':4,'height':4},{'id':'outside','type':'text','enabled':True,'x':28,'y':28,'width':4,'height':4}]})
 assert [r['id'] for r in ownership['candidates']]==['printed'],'ownership uses full text area and cropped alpha, not a bounding rectangle intersection'
 family,ps,weight,_=font_candidates(False)[0];font=strict_font(ps,24,'Milk Tea');im=Image.new('RGBA',(220,80),'white');ImageDraw.Draw(im).text((20,20),'Milk Tea',font=font,fill='black');im.save(source)
 e={'id':'word','type':'text','enabled':True,'text':'Milk Tea','x':18,'y':18,'width':150,'height':38,'fontPostScript':ps,'fontSize':24,'color':'#000000'}
 original=refine.infer_block;refine.infer_block=lambda image,block:{**block,'styleConfidence':0.1}
 fitted=refine.refine({'input':str(source),'elements':[e],'complete':True})['elements'][0];refine.infer_block=original
 assert fitted['fontAvailable'] and fitted['textFit'],fitted
 vertical={**e,'id':'vertical','text':'M\\ni\\nl\\nk','x':20,'y':5,'width':18,'height':70}
 fitted_vertical=refine.refine({'input':str(source),'elements':[vertical],'complete':True})['elements'][0]
 assert fitted_vertical['fontAvailable'] and fitted_vertical['textFit']['leading']>fitted_vertical['fontSize'],fitted_vertical
 before=source.read_bytes();glyph=p/'source-glyph.png';run({'operation':'source-glyph-cutout','input':str(source),'output':str(glyph),'element':e})
 image=Image.open(glyph);assert image.getchannel('A').getbbox() is not None and image.getpixel((0,0))[3]==0
 assert image.getchannel('A').getbbox()[2]<image.width and source.read_bytes()==before
 paper=p/'paper.png';plate=p/'plate.png';im=Image.new('RGBA',(200,100),'white');ImageDraw.Draw(im).rectangle((10,10,60,80),fill='green');ImageDraw.Draw(im).rectangle((90,30,100,40),fill='black');im.save(paper);Image.new('RGBA',(200,100),'green').save(plate)
 result=run({'operation':'preserve-canvas-margin','source':str(paper),'input':str(plate),'output':str(plate)});im=Image.open(plate)
 assert result['applied'] and im.getpixel((0,0))[:3]==(255,255,255) and im.getpixel((95,35))[:3]==(255,255,255) and im.getpixel((30,30))[:3]==(0,128,0)
 # Near-white original ink must never be copied into the clean interior.
 im=Image.new('RGBA',(200,100),'white');ImageDraw.Draw(im).text((80,40),'OLD',fill=(244,244,244));im.save(paper);Image.new('RGBA',(200,100),(250,249,247)).save(plate)
 run({'operation':'preserve-canvas-margin','source':str(paper),'input':str(plate),'output':str(plate)})
 assert Image.open(plate).crop((65,30,140,70)).getextrema()==((255,255),(255,255),(255,255),(255,255)), 'clean interior must not acquire source ghost glyphs'
 im=Image.new('RGBA',(200,100),'white');ImageDraw.Draw(im).line((10,80,180,10),fill='#F47700',width=8);im.save(source)
 assert not run({'operation':'shape-evidence','input':str(source),'element':{'x':0,'y':0,'width':200,'height':100,'fill':'#F47700'}})['nativeEligible'], 'an irregular brush stroke is not a filled rectangle'
 ImageDraw.Draw(im).rectangle((20,30,80,60),fill='#F47700');im.save(source)
 assert run({'operation':'shape-evidence','input':str(source),'element':{'x':20,'y':30,'width':60,'height':30,'fill':'#F47700'}})['nativeEligible']
 im=Image.new('RGBA',(200,120),(164,193,108));ImageDraw.Draw(im).rectangle((100,0,199,119),fill=(165,181,106));ImageDraw.Draw(im).line((30,20,90,100),fill='#E6751E',width=8);im.save(source)
 run({'operation':'source-glyph-cutout','input':str(source),'output':str(glyph),'element':{'x':10,'y':10,'width':180,'height':100,'sourceTextColor':'#E6751E'}})
 extracted=Image.open(glyph);assert extracted.getpixel((180,70))[3]==0 and extracted.getpixel((60,60))[3]>200, 'known orange ink cannot be replaced with the dominant green gradient cluster'
 print('PASS: real HD pixels, ownership, alpha and installed-font substitution')
`],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
 assert.equal(run.status,0,run.stdout+run.stderr);
});
