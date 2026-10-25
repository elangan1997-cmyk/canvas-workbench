#!/usr/bin/env python3
"""Pixel IO for the layered-image workflow; no model calls or font downloads."""
import argparse
import json
import math
from pathlib import Path
import sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from PIL import ImageChops

MAX_PIXELS = 20_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS


def load(file):
    with Image.open(file) as im:
        if im.width * im.height > MAX_PIXELS or min(im.size) < 1:
            raise ValueError('图片超过2000万像素，请缩小后再拆层')
        return im.convert('RGBA')


def info(im):
    a = im.getchannel('A')
    h = a.histogram()
    bbox = a.getbbox()
    return {'width': im.width, 'height': im.height, 'transparentPixels': h[0],
            'semiTransparentPixels': sum(h[1:255]), 'alphaMin': a.getextrema()[0],
            'bbox': list(bbox) if bbox else None, 'hasTransparency': h[0] > 0 and bbox is not None,
            'checkerboard': looks_like_checkerboard(im)}


def looks_like_checkerboard(im):
    # A generated transparency grid is a common failure. Require a repeated
    # neutral two-tone signal in at least three corners, not just any texture.
    w, h = im.size
    boxes = [(0, 0, w // 4, h // 4), (w * 3 // 4, 0, w, h // 4),
             (0, h * 3 // 4, w // 4, h), (w * 3 // 4, h * 3 // 4, w, h)]
    tile = min(96, w // 6, h // 6)
    if tile >= 32:
        boxes += [(x, y, x + tile, y + tile) for y in range(0, h - tile + 1, tile * 2) for x in range(0, w - tile + 1, tile * 2)]
    votes = 0
    for box in boxes:
        if min(box[2] - box[0], box[3] - box[1]) < 20:
            continue
        sample = im.crop(box).resize((96, 96)).convert('RGB')
        pixels = list(sample.getdata())
        neutral = sum(max(p) - min(p) < 12 for p in pixels) / len(pixels)
        if neutral < .96:
            continue
        row = [sum(sample.getpixel((x, 48))) / 3 for x in range(96)]
        col = [sum(sample.getpixel((48, y))) / 3 for y in range(96)]
        jumps = lambda line: sum(abs(a - b) > 22 for a, b in zip(line, line[1:]))
        if 7 <= jumps(row) <= 65 and 7 <= jumps(col) <= 65:
            votes += 1
    return votes >= 3


def save(im, file):
    file = Path(file)
    file.parent.mkdir(parents=True, exist_ok=True)
    im.save(file, 'PNG')


def strict_font(postscript, size, text=''):
    # Reuse the platform-aware search, never its system-font fallback.
    from export_text_psd import _resolve_font_file
    stem = postscript.replace('_', '-') if postscript.startswith('AlibabaPuHuiTi_3_') else postscript
    file = _resolve_font_file(stem, ('.ttf', '.otf', '.TTF', '.OTF'))
    if not file:
        raise ValueError('未安装所选字体：' + postscript + '。请安装该字体或改为保留字形图层')
    font = ImageFont.truetype(file, max(1, round(size)))
    try:
        from fontTools.ttLib import TTFont
        opened = TTFont(file, fontNumber=0)
        names = opened['name'].names
        actual = {n.toUnicode() for n in names if n.nameID == 6}
        if postscript not in actual:
            raise ValueError('字体文件与PostScript名称不一致：' + postscript)
        cmap = opened.getBestCmap() or {}
        missing = [ch for ch in text if ch not in '\r\n\t' and ord(ch) not in cmap]
        if missing:
            raise ValueError('所选字体缺少字形：' + ''.join(dict.fromkeys(missing))[:30] + '，请更换字体或保留原字形图层')
    except ImportError:
        pass  # Pillow can render; the actual editor still checks its font.
    return font


def render_text(spec):
    b, size = spec['element'], (spec['width'], spec['height'])
    if not b.get('fontAccepted'):
        raise ValueError('请先接受此候选字体')
    font_size = float(b.get('fontSize', 24))
    font = strict_font(b['fontPostScript'], font_size, str(b['text']))
    im = Image.new('RGBA', size)
    draw = ImageDraw.Draw(im)
    geo = b['geometry']
    anchor_x, anchor_y = geo['transform'][4:6]
    tracking = round(float(b.get('tracking', 0))) * font_size / 1000
    for i, line in enumerate(str(b['text']).replace('\r\n', '\n').replace('\r', '\n').split('\n')):
        advance = float(font.getlength(line)) + tracking * max(0, len(line) - 1)
        x = anchor_x - advance * ({'center': .5, 'right': 1}.get(b.get('textAlign'), 0))
        y = anchor_y + i * font_size * 1.2
        if tracking:
            for ch in line:
                draw.text((x, y), ch, font=font, fill=b.get('color', '#111827'), anchor='ls')
                x += font.getlength(ch) + tracking
        else:
            draw.text((x, y), line, font=font, fill=b.get('color', '#111827'), anchor='ls')
    angle = float(b.get('rotation', 0))
    if angle:
        im = im.rotate(-angle, resample=Image.Resampling.BICUBIC, center=(anchor_x, anchor_y))
    if im.getchannel('A').getbbox() is None:
        raise ValueError('文字位于画布外或没有可显示内容')
    save(im, spec['output'])
    return info(im)


def source_text(spec):
    """Lossless fallback for unsupported fonts/effects; never regenerate text.
    The original region includes its local backdrop, explicitly reported as a
    raster fallback rather than pretending it is editable or recovered glyphs.
    """
    source=load(spec['input']);e=spec['element'];b=dict(e.get('cleanupBounds') or e)
    # The measured ink cluster may cover only a dot or part of a word. Raster
    # fallback must preserve the entire recognized region as well as that ink.
    if e.get('cleanupBounds'):
        right=max(b['x']+b['width'],e['x']+e['width']);bottom=max(b['y']+b['height'],e['y']+e['height'])
        b['x']=min(b['x'],e['x']);b['y']=min(b['y'],e['y']);b['width']=right-b['x'];b['height']=bottom-b['y']
    values=[b.get(k) for k in ('x','y','width','height')]
    if any(not isinstance(v,(int,float)) or isinstance(v,bool) or not math.isfinite(v) for v in values):raise ValueError('文字区域坐标无效')
    x,y,w,h=values
    if w<=0 or h<=0 or x<0 or y<0 or x>=source.width or y>=source.height:raise ValueError('文字区域尺寸无效')
    a,c=max(0,math.floor(x-2)),min(source.width,math.ceil(x+w+2))
    b,d=max(0,math.floor(y-2)),min(source.height,math.ceil(y+h+2))
    result=Image.new('RGBA',source.size);result.paste(source.crop((a,b,c,d)),(a,b))
    save(result,spec['output']);return {**info(result),'engine':'source-text-region'}


def normalize(spec):
    im = load(spec['input'])
    actual = list(im.size)
    width, height = spec.get('width', im.width), spec.get('height', im.height)
    if width * height > MAX_PIXELS:
        raise ValueError('画布超过2000万像素')
    aligned = None
    placement_issues = []
    element = spec.get('element') or {}
    framing = 'canvas'
    canvas_matches = abs(math.log((im.width / im.height) / (width / height))) <= .025
    rectangle = [element.get(k) for k in ('x', 'y', 'width', 'height')]
    valid = not spec.get('background') and not element.get('nativeText') and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in rectangle)
    if valid:
        x, y, w, h = rectangle
        valid = x >= 0 and y >= 0 and w >= 1 and h >= 1 and x+w <= width and y+h <= height
    alpha = im.getchannel('A')
    box = alpha.point(lambda a: 255 if a >= 32 else 0).getbbox()
    transparent = alpha.getextrema()[0] == 0
    # A response's canvas is not its visible layer. Strip transparent padding
    # before measuring, then uniformly contain the whole asset in the source ROI.
    # Keep alpha>=4 soft edges; discard only almost invisible stray pixels.
    fit = valid and not spec.get('preserve_placement') and (not canvas_matches or transparent)
    if spec.get('background') and not canvas_matches and not spec.get('preserve_placement'):
        if looks_like_checkerboard(im) and not spec.get('allow_checkerboard'):
            raise ValueError('模型把背景画成了棋盘格，原始返回已保留，不能作为背景交付')
        if alpha.getextrema()[0] != 255:
            raise ValueError('背景未完整填充，请重新补全背景')
        if abs(math.log((im.width/im.height)/(width/height))) > .8:
            raise ValueError('背景构图比例与原图差异过大，原始返回已保留')
        # Background completion fills the document as one coherent plate.
        scale = max(width/im.width, height/im.height)
        size = (max(width, round(im.width*scale)), max(height, round(im.height*scale)))
        resized = im.resize(size, Image.Resampling.LANCZOS)
        left, top = (size[0]-width)//2, (size[1]-height)//2
        im = resized.crop((left, top, left+width, top+height))
        aligned = {'from':[0,0,*actual], 'to':[0,0,width,height], 'mode':'cover', 'scale':scale}
        framing = 'background-cover'
        placement_issues.append({'id': element.get('id',''), 'code':'background-size-adapted', 'severity':'warning',
            'message':'背景已等比缩放并铺满原图画布，原图可见背景由后续步骤保留'})
    elif fit and box:
        frame = alpha.point(lambda a: 255 if a >= 4 else 0).getbbox() if transparent else (0, 0, *im.size)
        bw, bh = box[2]-box[0], box[3]-box[1]
        mismatch = abs(math.log((bw/bh)/(w/h)))
        if mismatch > .8:
            raise ValueError('“'+str(element.get('name') or '当前图层')[:120]+'”可见内容 '+str(bw)+'×'+str(bh)+' 与图层区域 '+str(round(w))+'×'+str(round(h))+' 差异过大，可能混入其他内容；原始返回已保留，请核对识别框')
        crop = im.crop(frame)
        scale = min(w/crop.width, h/crop.height)
        size = (max(1, min(round(w), round(crop.width*scale))), max(1, min(round(h), round(crop.height*scale))))
        left, top = round(x+(w-size[0])/2), round(y+(h-size[1])/2)
        placed = Image.new('RGBA', (width, height))
        placed.paste(crop.resize(size, Image.Resampling.LANCZOS), (left, top))
        aligned = {'from': list(frame), 'to': [left, top, left+size[0], top+size[1]], 'mode': 'contain', 'scale': scale}
        im = placed
        framing = 'layer-alpha-bounds' if transparent else 'layer-canvas'
        if mismatch > .08:
            placement_issues.append({'id': element.get('id', ''), 'code': 'layer-content-bounds-review', 'severity': 'warning' if mismatch <= .25 else 'review',
                'message': '“'+str(element.get('name') or '当前图层')[:120]+'”已去透明留白并等比适配为 '+str(size[0])+'×'+str(size[1])+'，放入 '+str(round(w))+'×'+str(round(h))+' 原图区域；保留完整内容，未填满部分请核对识别框与原图位置'})
    elif not canvas_matches:
        name = str(element.get('name') or '当前图层')[:120]
        expected = ('；图层区域 '+str(round(w))+'×'+str(round(h))) if valid else ''
        raise ValueError('“'+name+'”返回 '+str(actual[0])+'×'+str(actual[1])+'，与原图画布 '+str(width)+'×'+str(height)+expected+' 的比例不匹配；原始结果已保留，请核对该层区域')
    elif im.size != (width, height):
        im = im.resize((width, height), Image.Resampling.LANCZOS)
    result = info(im)
    if spec.get('background') and result['checkerboard'] and not spec.get('allow_checkerboard'):
        raise ValueError('模型把背景画成了棋盘格，不能作为完整背景交付。原始返回文件已保留，请核对或使用原图像素提取')
    if spec.get('background') and result['alphaMin'] != 255:
        raise ValueError('背景未完整填充，请重新补全背景')
    if result['bbox'] is None:
        raise ValueError('素材完全透明，没有可显示像素')
    save(im, spec['output'])
    return {**result, 'actualPixels': actual, 'resized': actual != [width, height], 'aligned': aligned, 'framing': framing, 'placementIssues': placement_issues}


def crop_layer(spec):
    im = load(spec['input'])
    box = im.getchannel('A').point(lambda a: 255 if a >= 4 else 0).getbbox()
    if not box:
        raise ValueError('图层没有可见内容，无法裁出素材')
    crop = im.crop(box)
    save(crop, spec['output'])
    return {'bounds': {'x': box[0], 'y': box[1], 'width': crop.width, 'height': crop.height}, **info(crop)}


def background_plate(spec):
    original, generated = load(spec['source']), load(spec['input'])
    if original.size != generated.size:
        raise ValueError('背景补全与原图尺寸不一致')
    # Even feathered source/model mixing creates visible rectangular tonal
    # boundaries on a gradient or tabletop. Never paste the text-bearing source
    # back into a completed plate. Exact flat artwork has its separate local
    # source_flat path; photograph panels retain source pixels in their layers.
    save(generated, spec['output'])
    return {**info(generated),'sourceBackgroundPixels':0,'engine':'coherent-generated-background'}


def source_flat(spec):
    """Only reconstruct a flat plate when all visible background agrees.

    Extraction copies original pixels; overlapping unmerged elements make this
    path ineligible, rather than pretending to recover an occluded subject.
    """
    im = load(spec['input'])
    rgb = im.convert('RGB')
    color = rgb.getpixel((0, 0))
    difference = ImageChops.difference(rgb, Image.new('RGB', im.size, color))
    r, g, b = difference.split()
    delta = ImageChops.lighter(ImageChops.lighter(r, g), b)
    foreground = delta.point(lambda x: 255 if x > 4 else 0)
    outside = Image.new('L', im.size, 255)
    draw = ImageDraw.Draw(outside)
    for e in spec['elements']:
        if e['type'] == 'background':
            continue
        draw.rectangle((e['x'] - 2, e['y'] - 2, e['x'] + e['width'] + 2, e['y'] + e['height'] + 2), fill=0)
    pixels = outside.histogram()[255]
    mismatches = ImageChops.multiply(outside, foreground).histogram()[255]
    if pixels < im.width * im.height * .15 or mismatches > max(5, pixels * .001):
        return {'eligible': False}
    # Every border must agree too: a texture hidden by erroneous boxes is not
    # a verified flat background.
    border = Image.new('L', im.size)
    ImageDraw.Draw(border).rectangle((0, 0, im.width - 1, im.height - 1), outline=255, width=2)
    if ImageChops.multiply(border, foreground).histogram()[255] > 5:
        return {'eligible': False}
    e = spec['element']
    if e['type'] == 'background':
        result = Image.new('RGBA', im.size, (*color, 255))
    else:
        x, y, w, h = e['x'], e['y'], e['width'], e['height']
        merged = set(e.get('mergedIds', []))
        for other in spec['elements']:
            if other['id'] == e['id'] or other['id'] in merged or other['type'] == 'background':
                continue
            overlap = max(0, min(x + w, other['x'] + other['width']) - max(x, other['x'])) * max(0, min(y + h, other['y'] + other['height']) - max(y, other['y']))
            if overlap > 4:
                return {'eligible': False, 'reason': 'overlapping-elements'}
        region = Image.new('L', im.size)
        ImageDraw.Draw(region).rectangle((x, y, x + w - 1, y + h - 1), fill=255)
        alpha = ImageChops.multiply(foreground, region)
        if not alpha.getbbox():
            return {'eligible': False}
        result = im.copy()
        result.putalpha(ImageChops.multiply(alpha, im.getchannel('A')))
    save(result, spec['output'])
    return {'eligible': True, 'engine': 'source-pixel-flat', 'color': list(color), **info(result)}


def assemble(spec):
    root = Path(spec['directory']).resolve()
    width, height = spec['width'], spec['height']
    if width * height > MAX_PIXELS:
        raise ValueError('画布超过2000万像素')
    preview = Image.new('RGBA', (width, height))
    layers, total = [], 0
    for i, b in enumerate(sorted(spec['elements'], key=lambda b: b['z'])):
        if not b.get('enabled', True):
            continue
        file = Path(b.get('contentFile') or b['file']).resolve()
        if not file.is_relative_to(root):
            raise ValueError('素材路径不属于当前拆层任务')
        im = load(file)
        bounds = b.get('bounds') if b.get('contentFile') else None
        if bounds:
            if im.size != (bounds['width'], bounds['height']):
                raise ValueError('素材尺寸与图层边界不一致：' + b['name'])
            preview.alpha_composite(im, (bounds['x'], bounds['y']))
            bbox = (bounds['x'], bounds['y'], bounds['x'] + im.width, bounds['y'] + im.height)
        else:
            if im.size != (width, height):
                raise ValueError('图层画布尺寸不一致：' + b['name'])
            preview.alpha_composite(im)
            bbox = im.getchannel('A').getbbox()
        if not bbox:
            raise ValueError('空图层：' + b['name'])
        crop = im if bounds else im.crop(bbox)
        total += crop.width * crop.height
        if total > 100_000_000:
            raise ValueError('图层总像素过多，请减少图层或降低原图尺寸')
        raw = root / ('export-' + str(i) + '.rgba')
        raw.write_bytes(crop.tobytes())
        layers.append({'id': b['id'], 'name': b['name'], 'raw': str(raw), 'left': bbox[0], 'top': bbox[1],
                       'width': crop.width, 'height': crop.height, 'element': b})
    save(preview, root / 'preview.png')
    composite = root / 'composite.rgba'
    composite.write_bytes(preview.tobytes())
    return {'width': width, 'height': height, 'layers': layers, 'composite': str(composite), 'preview': str(root / 'preview.png')}


def exclude_owned_regions(im,e,elements):
    alpha=im.getchannel('A');draw=ImageDraw.Draw(alpha)
    for other in elements:
        if not other.get('enabled',True) or other['id']==e['id'] or other['type']=='background':continue
        x,y,w,h=[int(other[k]) for k in ('x','y','width','height')]
        if w*h>=e['width']*e['height']*.9:continue
        if x>=e['x']-2 and y>=e['y']-2 and x+w<=e['x']+e['width']+2 and y+h<=e['y']+e['height']+2:
            draw.rectangle((max(0,x-2),max(0,y-2),min(im.width,x+w+1),min(im.height,y+h+1)),fill=0)
    im.putalpha(alpha)


def run(spec):
    op = spec.get('operation', 'inspect')
    if op == 'text-presence':
        from infer_text_style import pixel_foreground
        im=load(spec['input']);e=spec['element'];x,y,w,h=[int(e[k]) for k in ('x','y','width','height')]
        fg=pixel_foreground(im,(x,y,min(im.width,x+w),min(im.height,y+h)),e.get('color'),ignore_leaders=True)
        count=sum(fg['mask'].histogram()[1:]) if fg else 0
        return {'hasVisibleInk':count>=8,'inkPixels':count}
    if op == 'source-glyph-cutout':
        from infer_text_style import pixel_foreground
        im=load(spec['input']);e=spec['element'];x,y,w,h=[int(e[k]) for k in ('x','y','width','height')]
        box=(max(0,x-2),max(0,y-2),min(im.width,x+w+2),min(im.height,y+h+2));fg=pixel_foreground(im,box,None,ignore_leaders=False)
        if not fg:raise ValueError('未能提取可靠的原始字形，未使用不透明文字补片')
        mask=fg['mask'].resize((max(1,round(fg['mask'].width/fg['sx'])),max(1,round(fg['mask'].height/fg['sy']))),Image.Resampling.LANCZOS)
        left,top=round(fg['left']),round(fg['top']);tile=im.crop((left,top,left+mask.width,top+mask.height));tile.putalpha(mask)
        out=Image.new('RGBA',im.size);out.paste(tile,(left,top));save(out,spec['output']);return info(out)
    if op == 'place-cutout':
        im=load(spec['input']);e=spec['element'];w,h=int(e['width']),int(e['height'])
        if im.size!=(w,h):raise ValueError('本地抠图改变了素材尺寸，未强行拉伸')
        if not info(im)['hasTransparency']:raise ValueError('本地抠图未产生有效透明区域')
        out=Image.new('RGBA',(int(spec['width']),int(spec['height'])));out.paste(im,(int(e['x']),int(e['y'])));exclude_owned_regions(out,e,spec.get('elements',[]));save(out,spec['output']);return info(out)
    if op == 'graphic-cutout':
        source=load(spec['input']);e=spec['element'];colors=e.get('foregroundColors',[])
        if not colors:return {'eligible':False}
        rgb=[tuple(int(c[i:i+2],16) for i in (1,3,5)) for c in colors];x,y,w,h=[int(e[k]) for k in ('x','y','width','height')]
        tile=source.crop((x,y,x+w,y+h));mask=Image.new('L',(w,h));mp=mask.load();p=tile.load()
        for yy in range(h):
            for xx in range(w):
                distance=min(max(abs(p[xx,yy][k]-c[k]) for k in range(3)) for c in rgb)
                mp[xx,yy]=round(255*max(0,min(1,(80-distance)/45)))
        coverage=sum(mask.histogram()[1:])/(w*h)
        if coverage<.002 or coverage>.72:return {'eligible':False}
        tile.putalpha(mask);out=Image.new('RGBA',source.size);out.paste(tile,(x,y));exclude_owned_regions(out,e,spec.get('elements',[]));save(out,spec['output']);return {'eligible':True,'engine':'hd-graphic-color-matte',**info(out)}
    if op == 'stitch-hd-tiles':
        source=load(spec['input']);tiles=spec['tiles'];prepared=[]
        for t in tiles:
            image=load(t['file']);r=t['region']
            if abs(math.log((image.width/image.height)/(r['width']/r['height'])))>.025:raise ValueError('高清分区返回改变构图比例：'+t['id'])
            prepared.append((t,image))
        scale=min(min(im.width/t['region']['width'],im.height/t['region']['height']) for t,im in prepared)
        if scale<1.2:raise ValueError('高清分区未达到原图1.2倍实际像素，不作为高清成功')
        w,h=round(source.width*scale),round(source.height*scale)
        if w*h>MAX_PIXELS:raise ValueError('高清拼接超过2000万像素')
        result=Image.new('RGBA',(w,h))
        for t,im in prepared:
            r,c=t['region'],t['core'];x1,y1=round(c['x']*scale),round(c['y']*scale);x2,y2=round((c['x']+c['width'])*scale),round((c['y']+c['height'])*scale)
            box=((c['x']-r['x'])*im.width/r['width'],(c['y']-r['y'])*im.height/r['height'],(c['x']+c['width']-r['x'])*im.width/r['width'],(c['y']+c['height']-r['y'])*im.height/r['height'])
            part=im.transform((x2-x1,y2-y1),Image.Transform.EXTENT,box,resample=Image.Resampling.BICUBIC);result.paste(part,(x1,y1))
        save(result,spec['output']);return info(result)
    if op == 'reference-canvas':
        im=load(spec['input']);w,h=int(spec['width']),int(spec['height'])
        if w*h>MAX_PIXELS or min(w,h)<1:raise ValueError('参考画布尺寸无效')
        if abs(math.log((im.width/im.height)/(w/h)))>.025:raise ValueError('高清返回改变了原图长宽比例，未采用')
        # Only a comparison reference is resampled; generated master and
        # original input remain separate and unchanged on disk.
        im=im.resize((w,h),Image.Resampling.LANCZOS);save(im,spec['output']);return info(im)
    if op == 'inspect':
        im = load(spec['input'])
        if spec.get('output'):
            save(im, spec['output'])
        return info(im)
    if op == 'enhanced-region':
        from PIL import ImageOps
        im=load(spec['input']);source=load(spec['source']);e=spec['element']
        x,y,w,h=[int(e[k]) for k in ('x','y','width','height')]
        if min(w,h)<1 or x<0 or y<0 or x+w>source.width or y+h>source.height:raise ValueError('高清区域无效')
        if abs(math.log((im.width/im.height)/(w/h)))>.12:raise ValueError('高清素材构图比例与原区域不符')
        scale=max(im.width/w,im.height/h);size=(max(w,round(w*scale)),max(h,round(h*scale)))
        if size[0]*size[1]>MAX_PIXELS:raise ValueError('高清素材超过2000万像素')
        # Small aspect rounding differences use original edge pixels as padding,
        # never stretch the subject or crop it. AI keeps this high-density PNG.
        tile=source.crop((x,y,x+w,y+h)).resize(size,Image.Resampling.LANCZOS)
        sharp=ImageOps.contain(im,size,Image.Resampling.LANCZOS);tile.alpha_composite(sharp,((size[0]-sharp.width)//2,(size[1]-sharp.height)//2))
        save(tile,spec['highOutput']);placed=Image.new('RGBA',source.size);placed.paste(tile.resize((w,h),Image.Resampling.LANCZOS),(x,y));save(placed,spec['output'])
        return {**info(placed),'highResolutionPixels':list(size)}
    if op == 'verify-source-regions':
        from PIL import ImageChops
        source=load(spec['source']);preview=load(spec['input'])
        if source.size!=preview.size:raise ValueError('核验画布尺寸不同')
        exact=[]
        for e in spec['elements']:
            b=e.get('bounds') or e;x,y,w,h=[int(b[k]) for k in ('x','y','width','height')]
            if min(w,h)>0 and x>=0 and y>=0 and x+w<=source.width and y+h<=source.height:
                delta=ImageChops.difference(source.crop((x,y,x+w,y+h)),preview.crop((x,y,x+w,y+h)))
                if e.get('file'):
                    mask=load(e['file']).getchannel('A').crop((x,y,x+w,y+h))
                    delta=Image.merge('RGBA',tuple(ImageChops.multiply(channel,mask) for channel in delta.split()))
                if not any(channel.getbbox() for channel in delta.split()):exact.append(e['id'])
        return {'exact':exact}
    if op == 'source-object-region':
        from layered_structure import source_object_region
        return source_object_region(spec)
    if op == 'exclude-native-text':
        im=load(spec['input']);alpha=im.getchannel('A');draw=ImageDraw.Draw(alpha)
        for e in spec['elements']:
            b=dict(e.get('cleanupBounds') or e)
            if e.get('bounds'):
                actual=e['bounds'];right=max(b['x']+b['width'],actual['x']+actual['width']);bottom=max(b['y']+b['height'],actual['y']+actual['height']);b['x']=min(b['x'],actual['x']);b['y']=min(b['y'],actual['y']);b['width']=right-b['x'];b['height']=bottom-b['y']
            draw.rectangle((max(0,math.floor(b['x']-3)),max(0,math.floor(b['y']-3)),min(im.width,math.ceil(b['x']+b['width']+3)),min(im.height,math.ceil(b['y']+b['height']+3))),fill=0)
        im.putalpha(alpha);save(im,spec['output']);return {**info(im),'empty':alpha.getbbox() is None}
    if op == 'analysis-crop':
        im=load(spec['input']);r=spec['region'];x,y,w,h=[int(r[k]) for k in ('x','y','width','height')]
        if x<0 or y<0 or w<1 or h<1 or x+w>im.width or y+h>im.height:raise ValueError('分析区域无效')
        crop=im.crop((x,y,x+w,y+h));draw=ImageDraw.Draw(crop)
        for e in spec.get('exclude',[]):
            if e.get('enabled',True):draw.rectangle((e['x']-x,e['y']-y,e['x']+e['width']-x-1,e['y']+e['height']-y-1),fill='white')
        target=spec.get('highlight')
        if target:draw.rectangle((max(0,target['x']-x-3),max(0,target['y']-y-3),min(w-1,target['x']+target['width']-x+2),min(h-1,target['y']+target['height']-y+2)),outline='#ff00aa',width=1)
        save(crop,spec['output']);return info(crop)
    if op == 'source-layout-plate':
        from layered_source_plate import source_plate
        return source_plate(spec)
    if op == 'structure':
        from layered_structure import inspect_structure
        return inspect_structure(spec)
    if op == 'render-structure':
        from layered_structure import render_local
        return render_local(spec)
    if op == 'normalize':
        return normalize(spec)
    if op == 'crop-layer':
        return crop_layer(spec)
    if op == 'background-plate':
        return background_plate(spec)
    if op == 'source-flat':
        return source_flat(spec)
    if op == 'source-text':
        return source_text(spec)
    if op == 'text':
        return render_text(spec)
    if op == 'assemble':
        return assemble(spec)
    raise ValueError('未知像素处理操作')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--spec', required=True)
    args = parser.parse_args()
    spec = json.loads(Path(args.spec).read_text(encoding='utf-8'))
    try:
        result = {'success': True, **run(spec)}
    except Exception as e:
        result = {'success': False, 'error': str(e)}
    encoded = json.dumps(result, ensure_ascii=False)
    if spec.get('result_output'):
        Path(spec['result_output']).write_text(encoded, encoding='utf-8')
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    print(encoded)
    return 0 if result['success'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
