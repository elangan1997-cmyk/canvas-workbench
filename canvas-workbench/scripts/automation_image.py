"""Deterministic region editing: model changes never touch pixels outside the region."""
import argparse,json,sys
from pathlib import Path
from PIL import Image,ImageOps

def run(s):
    opened=Image.open(s['input'])
    if opened.width*opened.height>20_000_000: raise ValueError('图片超过2000万像素')
    image=ImageOps.exif_transpose(opened).convert('RGBA')
    if s['operation']=='inspect':
        alpha=image.getchannel('A');bbox=alpha.getbbox();low,high=alpha.getextrema()
        return {'success':True,'width':image.width,'height':image.height,'alphaMin':low,'alphaMax':high,
            'foregroundBounds':({'x':bbox[0],'y':bbox[1],'width':bbox[2]-bbox[0],'height':bbox[3]-bbox[1]} if bbox else None)}
    r=s['region']; vals=[r.get(k) for k in ('x','y','width','height')]
    if any(not isinstance(v,(float,int)) or isinstance(v,bool) for v in vals): raise ValueError('选区坐标无效')
    x,y,w,h=map(round,vals)
    if x<0 or y<0 or w<1 or h<1 or x+w>image.width or y+h>image.height: raise ValueError('选区超出原图边界')
    if s['operation']=='crop': result=image.crop((x,y,x+w,y+h))
    elif s['operation']=='composite':
        changed=Image.open(s['edited']).convert('RGBA')
        if abs(changed.width/changed.height-w/h)/(w/h)>.1: raise ValueError('生成的局部图比例不符，原图未修改')
        changed=changed.resize((w,h),Image.Resampling.LANCZOS)
        result=image.copy();result.paste(changed,(x,y))
    else: raise ValueError('未知图像操作')
    Path(s['output']).parent.mkdir(parents=True,exist_ok=True);result.save(s['output'],'PNG')
    return {'success':True,'width':result.width,'height':result.height,'region':{'x':x,'y':y,'width':w,'height':h}}

if __name__=='__main__':
    a=argparse.ArgumentParser();a.add_argument('--spec',required=True);args=a.parse_args();s={}
    try:
        s=json.loads(Path(args.spec).read_text(encoding='utf-8'));value=run(s);code=0
    except Exception as e: value={'success':False,'error':str(e)[:1000]};code=1
    encoded=json.dumps(value,ensure_ascii=False)
    if s.get('result_output'):Path(s['result_output']).write_text(encoded,encoding='utf-8')
    try:print(encoded)
    except UnicodeEncodeError:print(json.dumps(value,ensure_ascii=True))
    sys.exit(code)
