"""Source-grounded color, alpha and ownership measurements; no model calls."""
import numpy as np
from PIL import Image,ImageDraw

def text_colors(spec):
    a=np.asarray(Image.open(spec['input']).convert('RGB'));height,width=a.shape[:2];result=[]
    for e in spec['elements']:
        if not e.get('enabled',True) or e['type']!='text':continue
        b=e.get('recognitionBounds') or e;x,y,w,h=[int(b[k]) for k in ('x','y','width','height')];x=max(0,x);y=max(0,y);right=min(width,x+w);bottom=min(height,y+h)
        if right<=x or bottom<=y:continue
        pad=12;left=max(0,x-pad);top=max(0,y-pad);r=min(width,right+pad);bot=min(height,bottom+pad);sample=a[top:bot,left:r];ring=np.ones(sample.shape[:2],bool);ring[y-top:bottom-top,x-left:right-left]=False
        pixels=sample[ring];bg=np.median(pixels,axis=0) if len(pixels) else np.array([255,255,255]);tile=a[y:bottom,x:right]
        bins,counts=np.unique((sample//16).reshape(-1,3),axis=0,return_counts=True);candidates=[]
        for center,count in zip(bins*16+8,counts):
            contrast=float(np.max(np.abs(center-bg)))
            if contrast>=40:candidates.append((count*contrast**.5,center,contrast))
        best=None
        for _,center,contrast in sorted(candidates,key=lambda c:c[0],reverse=True)[:12]:
            close=np.max(np.abs(sample.astype('int16')-center),axis=2)<=22
            mask=Image.fromarray(close.astype('uint8')*255);mp=mask.load()
            for xx in range(mask.width):
                for yy in [0,mask.height-1]:
                    if mp[xx,yy]==255:ImageDraw.floodfill(mask,(xx,yy),128)
            for yy in range(mask.height):
                for xx in [0,mask.width-1]:
                    if mp[xx,yy]==255:ImageDraw.floodfill(mask,(xx,yy),128)
            inside=np.asarray(mask)[y-top:bottom-top,x-left:right-left]==255;values=tile[inside];score=len(values)*contrast**.5
            if len(values)>=3 and (best is None or score>best[0]):best=(score,values)
        ink=best[1] if best else np.empty((0,3),dtype='uint8')
        row={'id':e['id'],'hasVisibleInk':len(ink)>=3,'sourceInkPixels':len(ink)}
        if len(ink)>=3:
            quant=ink//16;colors,counts=np.unique(quant,axis=0,return_counts=True);centers=colors*16+8;contrast=np.max(np.abs(centers-bg),axis=1);winner=colors[np.argmax(counts*np.sqrt(np.maximum(contrast,1)))];values=ink[np.all(quant==winner,axis=1)];color=np.median(values,axis=0).astype(int);row['color']='#'+''.join('%02X'%v for v in color)
        result.append(row)
    return {'colors':result}

def matte_quality(spec):
    a=np.asarray(Image.open(spec['input']).convert('RGBA'))[:,:,3];edges=[float(np.mean(edge>=200)) for edge in [a[0],a[-1],a[:,0],a[:,-1]]];coverage=float(np.mean(a>=16));leak=coverage>.985 or sum(v>.65 for v in edges)>=3
    return {'accepted':not leak,'coverage':coverage,'opaqueEdges':edges,'reason':'多个画框边缘仍不透明，可能保留矩形背景' if leak else ''}

def text_material_ownership(spec):
    products=[]
    for e in spec['elements']:
        if e.get('enabled') and e['type']=='image' and e.get('visualKind')=='product' and e.get('file') and e.get('status')=='complete':
            cropped=bool(e.get('contentFile') and e.get('bounds'));file=e['contentFile'] if cropped else e['file']
            with Image.open(file) as im:alpha=np.array(im.getchannel('A'),copy=True)
            products.append((e,alpha,int(e['bounds']['x']) if cropped else 0,int(e['bounds']['y']) if cropped else 0))
    result=[]
    for e in spec['elements']:
        if not e.get('enabled') or e['type']!='text':continue
        b=e.get('recognitionBounds') or e;x,y,w,h=[int(b[k]) for k in ('x','y','width','height')];owners=[]
        for p,a,px,py in products:
            left=max(x,px);top=max(y,py);right=min(x+w,px+a.shape[1]);bottom=min(y+h,py+a.shape[0])
            if right<=left or bottom<=top:continue
            tile=a[top-py:bottom-py,left-px:right-px]
            if tile.size and int(np.count_nonzero(tile>=160))/max(1,w*h)>.8:owners.append(p['id'])
        if owners:result.append({'id':e['id'],'productIds':owners})
    return {'candidates':result}


def shape_evidence(spec):
    im=Image.open(spec['input']).convert('RGB');e=spec['element'];x,y,w,h=[int(e[k]) for k in ('x','y','width','height')]
    tile=np.asarray(im.crop((x,y,x+w,y+h))).astype('int16');fill=e.get('fill') or '#FFFFFF';color=np.array([int(fill[i:i+2],16) for i in (1,3,5)])
    expected=Image.new('L',(w,h));ImageDraw.Draw(expected).rounded_rectangle((0,0,w-1,h-1),radius=max(0,e.get('radius',0)),fill=255);mask=np.asarray(expected)>0
    coverage=float(np.mean(np.max(np.abs(tile-color),axis=2)[mask]<=45)) if mask.any() else 0
    return {'nativeEligible':coverage>=.78,'fillCoverage':coverage,'reason':'原图实心矩形/圆角填充覆盖率' if coverage>=.78 else '原图不是对应实心矩形，保留实际图形轮廓'}
