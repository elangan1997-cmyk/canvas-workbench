"""Conservative local plate for dense artwork: keep the original visual system.
Only independently extracted footprints change; their opaque source regions
cover the unknown surface. This never claims to recover unseen photo detail.
"""
from statistics import median
from PIL import Image,ImageDraw


def surface_fill(image,element,padding=2):
    x,y,w,h=[int(element[k]) for k in ('x','y','width','height')]
    x1,y1,x2,y2=max(0,x-padding),max(0,y-padding),min(image.width,x+w+padding),min(image.height,y+h+padding)
    if x2<=x1 or y2<=y1:return
    original=image.copy();src=original.load();dst=image.load();top=max(0,y1-3);bottom=min(image.height-1,y2+2)
    # Repeated border samples reject isolated black artwork edges. Reconstruct
    # a smooth local surface, never copy a neighbouring glyph into the hole.
    border=[src[a,top][:3] for a in range(x1,x2)]+[src[a,bottom][:3] for a in range(x1,x2)]
    border += [src[max(0,x1-3),b][:3] for b in range(y1,y2)]+[src[min(image.width-1,x2+2),b][:3] for b in range(y1,y2)]
    bg=tuple(round(median(p[k] for p in border)) for k in range(3))
    for a in range(x1,x2):
        col_top=[src[xx,top][:3] for xx in range(max(0,a-3),min(image.width,a+4))]
        col_bottom=[src[xx,bottom][:3] for xx in range(max(0,a-3),min(image.width,a+4))]
        t=tuple(round(median(p[k] for p in col_top)) for k in range(3));b=tuple(round(median(p[k] for p in col_bottom)) for k in range(3))
        if max(abs(t[k]-bg[k]) for k in range(3))>35:t=bg
        if max(abs(b[k]-bg[k]) for k in range(3))>35:b=bg
        for yy in range(y1,y2):
            r=(yy-top)/max(1,bottom-top);dst[a,yy]=tuple(round(t[k]*(1-r)+b[k]*r) for k in range(3))+(255,)


def source_plate(spec):
    from layered_image import load,save,info
    from refine_layered_text import clean_background
    source=load(spec['input']);result=source.copy();regions=[]
    for e in spec['elements']:
        if not e.get('enabled',True) or e['type']=='background':continue
        if e['type'] in ('image','shape') or (e['type']=='text' and not e.get('nativeText')):
            # Erase exactly the opaque source patch that will be put back.
            # Using a larger guessed text box silently deleted nearby words.
            footprint=e.get('bounds') if e['type']=='text' else None
            surface_fill(result,footprint or e,0 if footprint or e['type']=='image' else 2);regions.append(e['id'])
    save(result,spec['output'])
    cleaned=clean_background({'input':spec['output'],'source':spec['input'],'output':spec['output'],'elements':spec['elements']})
    unresolved={i['id'] for i in cleaned.get('issues',[]) if i.get('id')}
    # Bounded fallback for an opaque/complex text surface. Prefer a source
    # glyph patch to duplicating live text on top of the old printed words.
    result=Image.open(spec['output']).convert('RGBA')
    for e in spec['elements']:
        if e['id'] in unresolved:surface_fill(result,e)
    save(result,spec['output'])
    return {**info(result),'engine':'source-layout-plate','unresolvedTextIds':sorted(unresolved),'issues':[
        {'code':'source-plate-hidden-fill','severity':'warning','message':'保留原图的渐变、线条与版式；独立图像下方不可见区域按邻近背景补齐，不代表还原隐藏内容'}] if regions else []}
