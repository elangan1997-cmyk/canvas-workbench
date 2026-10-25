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
 run({'operation':'place-cutout','input':str(p/'crop.png'),'output':str(placed),'width':100,'height':100,'element':{**e,'x':50,'y':50}})
 assert Image.open(placed).getchannel('A').getbbox()==(52,52,73,73)
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
 print('PASS: real HD pixels, ownership, alpha and installed-font substitution')
`],{cwd:new URL('../..',import.meta.url),encoding:'utf8'});
 assert.equal(run.status,0,run.stdout+run.stderr);
});
