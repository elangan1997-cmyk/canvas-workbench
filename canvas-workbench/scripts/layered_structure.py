"""Source geometry, rectangular photographs and independent simple graphic layers.
No model calls; never remove a photograph's own scene background.
"""
import math
from collections import deque
from statistics import median
from PIL import Image, ImageDraw, ImageChops


def boundary(im, axis, estimate, lo, hi, span, exclude=()):
    limit=im.height if axis=='y' else im.width
    if estimate<=1:return 0,True
    if estimate>=limit-1:return limit,True
    start=max(1,round(estimate-span));stop=min(limit-1,round(estimate+span))
    pixels=im.load();step=max(1,(hi-lo)//120);best=None
    for pos in range(start,stop+1):
        if any(p[axis]-3<=pos<=p[axis]+p["height" if axis=="y" else "width"]+3 for p in exclude):continue
        values=[]
        for a in range(max(0,lo),min(im.width if axis=='y' else im.height,hi),step):
            p,q=(pixels[a,pos-1],pixels[a,pos]) if axis=='y' else (pixels[pos-1,a],pixels[pos,a])
            values.append(max(abs(p[k]-q[k]) for k in range(3)))
        if not values:continue
        mid=median(values);coverage=sum(v>=14 for v in values)/len(values)
        if mid<20 or coverage<.7:continue
        score=mid*(1-.4*abs(pos-estimate)/max(1,span))
        if best is None or score>best[0]:best=(score,pos)
    return (best[1],True) if best else (round(estimate),False)


def photo_rectangle(im,e,exclude=()):
    x,y,w,h=[int(e[k]) for k in ('x','y','width','height')]
    # Wide, straight discontinuities can refine panel edges; a loose object
    # silhouette cannot pass this test and is never silently made a photo panel.
    top,a=boundary(im,'y',y,x,x+w,max(12,h*.3),exclude)
    bottom,b=boundary(im,'y',y+h,x,x+w,max(12,h*.3),exclude)
    left,c=boundary(im,'x',x,max(top,y+min(h//5,80)),min(bottom,y+h),max(8,w*.15),exclude)
    right,d=boundary(im,'x',x+w,max(top,y+min(h//5,80)),min(bottom,y+h),max(8,w*.15),exclude)
    if not (a and b and c and d) or right-left<20 or bottom-top<20:return None
    if not .55<((right-left)*(bottom-top))/(w*h)<1.8:return None
    return dict(x=left,y=top,width=right-left,height=bottom-top)


def pill_behind(im,e):
    x,y,w,h=[int(e[k]) for k in ('x','y','width','height')]
    pad=max(24,round(h*.85)+8);box=(max(0,x-pad),max(0,y-pad),min(im.width,x+w+pad),min(im.height,y+h+pad))
    crop=im.crop(box).convert('RGB');cw,ch=crop.size;data=list(crop.getdata())
    white=bytearray(1 if min(p)>=207 and max(p)-min(p)<=38 else 0 for p in data);seen=bytearray(len(white));candidates=[]
    for seed,v in enumerate(white):
        if not v or seen[seed]:continue
        seen[seed]=1;q=deque([seed]);xs=[];ys=[];colors=[]
        while q:
            i=q.popleft();px,py=i%cw,i//cw;xs.append(px);ys.append(py);colors.append(data[i])
            for nx,ny in ((px-1,py),(px+1,py),(px,py-1),(px,py+1)):
                if 0<=nx<cw and 0<=ny<ch:
                    j=ny*cw+nx
                    if white[j] and not seen[j]:seen[j]=1;q.append(j)
        if len(xs)<w*h*.15 or min(xs)==0 or min(ys)==0 or max(xs)==cw-1 or max(ys)==ch-1:continue
        a,b,c,d=min(xs)+box[0],min(ys)+box[1],max(xs)+box[0]+1,max(ys)+box[1]+1
        if a>x or b>y or c<x+w or d<y+h or c-a<w*1.03 or d-b<h*1.05:continue
        if c-a>w+pad*1.9 or d-b>h+pad*1.8:continue
        fill='#'+''.join(f'{round(median(p[k] for p in colors)):02X}' for k in range(3))
        candidates.append((len(xs),dict(x=a,y=b,width=c-a,height=d-b,fill=fill)))
    return max(candidates,key=lambda p:p[0])[1] if candidates else None


def inspect_structure(spec):
    im=Image.open(spec['input']).convert('RGB');elements=[dict(e) for e in spec['elements']];changes=[]
    plates={e['id']:pill_behind(im,e) for e in elements if e.get('type')=='text' and e.get('enabled',True)}
    for e in elements:
        if e.get('type')!='image' or not e.get('enabled',True) or e.get('modeLocked') or e.get('geometryLocked'):continue
        # Pixel edge detection refines framing, but cannot overrule the model's
        # explicit product-vs-panel decision (a tabletop is not a photo frame).
        if e.get('visualKind')=='product' or (e.get('extractionMode')=='cutout' and e.get('classificationReason')):continue
        if e.get('extractionMode')=='cutout' and e['x']==0 and e['y']==0 and e['width']==im.width and e['height']==im.height:continue
        rect=photo_rectangle(im,e,[p for p in plates.values() if p])
        if rect:
            before={k:e[k] for k in ('x','y','width','height')};e.update(rect,extractionMode='photo',geometrySource='source-rectangle-edges')
            changes.append({'id':e['id'],'kind':'rectangular-photo','from':before,'to':rect})
    for e in list(elements):
        if e.get('type')!='text' or not e.get('enabled',True):continue
        # A local component must enclose the actual text; never invent a card
        # merely because the description contains the word "label".
        if any(s.get('type')=='shape' and s.get('textElementId') in (e['id'],e.get('textGroupId','')) for s in elements):continue
        plate=plates.get(e['id'])
        if not plate:continue
        # Only promote a capsule/box when there is a verified enclosing margin.
        elements.append(dict(id=e['id']+'-plate',type='shape',name=e['name']+'·圆角底框',shapeKind='roundedRect',
            radius=round(plate['height']/2),textElementId=e['id'],z=e['z']-.1,enabled=True,role='decoration',**plate))
        changes.append({'id':e['id']+'-plate','kind':'text-plate','to':plate})
    photos=[e for e in elements if e.get('extractionMode')=='photo' and e.get('enabled',True)]
    # Adjacent panels on a common row share the same framing line, not the
    # top of a white caption inside one of the photos.
    for i,a in enumerate(photos):
        for b in photos[i+1:]:
            if abs(a['x']+a['width']-b['x'])<=8 or abs(b['x']+b['width']-a['x'])<=8:
                if 0<abs(a['y']-b['y'])<=8:
                    top=min(a['y'],b['y'])
                    for e in (a,b):e['height']+=e['y']-top;e['y']=top
    existing={e['id'] for e in elements}
    for i,a in enumerate(photos):
        for b in photos[i+1:]:
            r=None
            if a['x']==b['x'] and a['width']==b['width']:
                upper,lower=sorted([a,b],key=lambda e:e['y']);gap=lower['y']-upper['y']-upper['height']
                if 0<gap<=8:r=dict(x=a['x'],y=upper['y']+upper['height'],width=a['width'],height=gap)
            if a['y']==b['y'] and abs(a['height']-b['height'])<=3:
                left,right=sorted([a,b],key=lambda e:e['x']);gap=right['x']-left['x']-left['width']
                if 0<gap<=8:r=dict(x=left['x']+left['width'],y=a['y'],width=gap,height=min(a['height'],b['height']))
            if r:
                region=im.crop((r['x'],r['y'],r['x']+r['width'],r['y']+r['height']));colors=list(region.getdata());color=tuple(round(median(p[k] for p in colors)) for k in range(3))
                if min(color)<190:continue
                id='divider-'+a['id']+'-'+b['id']
                if id not in existing:elements.append(dict(id=id,type='shape',shapeKind='rect',name='照片分隔线',fill='#'+''.join(f'{v:02X}' for v in color),radius=0,z=max(a['z'],b['z'])+.1,enabled=True,**r));existing.add(id)
    return {'elements':elements,'structureChanges':changes}


def rounded_mask(size,e,offset=(0,0),padding=0):
    m=Image.new('L',size);d=ImageDraw.Draw(m);x=e['x']-offset[0]-padding;y=e['y']-offset[1]-padding
    d.rounded_rectangle((x,y,x+e['width']-1+padding*2,y+e['height']-1+padding*2),radius=max(0,e.get('radius',0)+padding),fill=255)
    return m


def render_local(spec):
    source=Image.open(spec['input']).convert('RGBA');e=spec['element'];out=Image.new('RGBA',source.size);issues=[]
    if e['type']=='shape':
        size=(int(e['width']),int(e['height']));scale=3
        tile=Image.new('RGBA',(size[0]*scale,size[1]*scale));d=ImageDraw.Draw(tile)
        d.rounded_rectangle((0,0,tile.width-1,tile.height-1),radius=max(0,e.get('radius',0)*scale),fill=e.get('fill','#FFFFFF'))
        out.paste(tile.resize(size,Image.Resampling.LANCZOS),(int(e['x']),int(e['y'])))
        engine='local-vector-shape'
    elif e.get('extractionMode')=='photo' or e.get('sourceRegion'):
        x,y,w,h=[int(e[k]) for k in ('x','y','width','height')];tile=source.crop((x,y,x+w,y+h));pixels=tile.load()
        for plate in spec['elements']:
            if plate.get('type')!='shape' or not plate.get('textElementId') or not plate.get('enabled',True):continue
            if not(x<=plate['x'] and y<=plate['y'] and plate['x']+plate['width']<=x+w and plate['y']+plate['height']<=y+h):continue
            # The original photo is exact outside the occlusion. Reconstruct
            # only the covered capsule footprint using neighbouring photo rows.
            mask=rounded_mask((w,h),plate,(x,y),3);mp=mask.load();a=max(0,plate['y']-y-5);b=min(h-1,plate['y']+plate['height']-y+5)
            original=tile.copy().load()
            for py in range(a,b+1):
                t=(py-a)/max(1,b-a)
                for px in range(max(0,plate['x']-x-4),min(w,plate['x']+plate['width']-x+4)):
                    if mp[px,py]:pixels[px,py]=tuple(round(original[px,a][k]*(1-t)+original[px,b][k]*t) for k in range(3))+(255,)
            issues.append({'id':e['id'],'code':'covered-photo-region-local-fill','severity':'warning','message':'原照片像素与矩形背景已保留；标签遮挡区域按上下邻域局部补全，未声称恢复不可见的原始细节'})
        out.paste(tile,(x,y));engine='source-photo-rectangle'
    else:raise ValueError('当前元素不支持本地结构提取')
    from layered_image import save,info
    save(out,spec['output']);return {**info(out),'engine':engine,'placementIssues':issues}


def source_object_region(spec):
    """Tighten a small product on a simple local surface; exclude separate text.
    The model chooses the object, connected source pixels measure its boundary.
    """
    from PIL import ImageFilter
    source=Image.open(spec['input']).convert('RGB');e=spec['element'];px=max(24,round(e['width']*.8));py=max(28,round(e['height']*.8))
    x=max(0,round(e['x']-px));y=max(0,round(e['y']-py));right=min(source.width,round(e['x']+e['width']+px));bottom=min(source.height,round(e['y']+e['height']+py))
    crop=source.crop((x,y,right,bottom));w,h=crop.size;data=list(crop.getdata());mask=Image.new('L',crop.size);values=[]
    for yy in range(h):
        edges=[]
        for side in [range(min(6,w)),range(max(0,w-6),w)]:edges.append(tuple(median(data[yy*w+xx][k] for xx in side) for k in range(3)))
        bg=max(edges,key=sum)
        for xx in range(w):values.append(255 if max(abs(data[yy*w+xx][k]-bg[k]) for k in range(3))>32 else 0)
    # A thin separator must not connect the cup shadow to the image edge.
    for yy in range(h):
        if sum(bool(v) for v in values[yy*w:(yy+1)*w])>w*.75:
            values[yy*w:(yy+1)*w]=[0]*w
    mask.putdata(values);mask=mask.filter(ImageFilter.MaxFilter(3));data=mask.tobytes();seen=bytearray(len(data));choices=[]
    for start,value in enumerate(data):
        if not value or seen[start]:continue
        seen[start]=1;q=deque([start]);xs=[];ys=[];overlap=0
        while q:
            i=q.popleft();xx,yy=i%w,i//w;xs.append(xx);ys.append(yy)
            if e['x']<=x+xx<e['x']+e['width'] and e['y']<=y+yy<e['y']+e['height']:overlap+=1
            for nx,ny in ((xx-1,yy),(xx+1,yy),(xx,yy-1),(xx,yy+1)):
                if 0<=nx<w and 0<=ny<h:
                    j=ny*w+nx
                    if data[j] and not seen[j]:seen[j]=1;q.append(j)
        a,b,c,d=min(xs),min(ys),max(xs)+1,max(ys)+1
        if a==0 or b==0 or c==w or d==h or overlap<e['width']*e['height']*.08:continue
        area=(c-a)*(d-b)
        if not e['width']*e['height']*.35<area<e['width']*e['height']*4:continue
        choices.append((overlap,{'x':max(0,x+a-2),'y':max(0,y+b-2),'width':min(source.width,x+c+2)-max(0,x+a-2),'height':min(source.height,y+d+2)-max(0,y+b-2)}))
    return {'bounds':max(choices,key=lambda item:item[0])[1] if choices else None}
