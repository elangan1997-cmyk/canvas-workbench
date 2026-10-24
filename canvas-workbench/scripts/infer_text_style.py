#!/usr/bin/env python3
"""Estimate per-line typography from a raster image and OCR boxes.

The original font cannot be recovered from flattened pixels.  This helper is
deliberately review-first: it produces an explainable, installed-font
candidate, an approximate size/weight/color, and a confidence hint for the UI.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except NameError:
    pass
from statistics import median


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def has_cjk(text: str) -> bool:
    return bool(re.search(r"[\u3400-\u9fff]", text))


from collections import Counter
from functools import lru_cache


@lru_cache(maxsize=32)
def font_candidates(cjk: bool) -> tuple:
    names = ([('阿里巴巴普惠体 3.0', 'AlibabaPuHuiTi_3_' + suffix, weight)
              for suffix, weight in [('55_Regular', 'normal'), ('65_Medium', 'medium'), ('85_Bold', 'bold'), ('95_ExtraBold', 'bold')]]
             + [('思源黑体', 'SourceHanSansSC-' + suffix, weight)
                for suffix, weight in [('Regular', 'normal'), ('Medium', 'medium'), ('Bold', 'bold')]]
             + [('思源宋体', 'SourceHanSerifSC-' + suffix, weight)
                for suffix, weight in [('Regular', 'normal'), ('Bold', 'bold'), ('Heavy', 'bold')]]) if cjk else [
                    (family, family + '-' + suffix, weight)
                    for family in ('Inter', 'Montserrat', 'SourceSansPro')
                    for suffix, weight in [('Regular', 'normal'), ('Medium' if family != 'SourceSansPro' else 'Semibold', 'medium'), ('Bold', 'bold')]]
    # find_font has a fallback for preview rendering; do not present that
    # fallback under a candidate's name if the requested font is absent.
    from export_text_psd import _resolve_font_file
    result = []
    for family, ps, weight in names:
        stem = ps.replace('_', '-') if ps.startswith('Alibaba') else ps
        path = _resolve_font_file(stem, ('.ttf', '.otf'))
        if path:
            result.append((family, ps, weight, path))
    return tuple(result)


def pixel_foreground(image, box, suggested=None, ignore_leaders=False):
    """Find the dominant ink cluster, excluding antialias and background.

    Work on a bounded thumbnail. Keep original-image coordinates separately;
    model box padding must not become font size or baseline padding.
    """
    from PIL import Image
    crop = image.crop(box).convert('RGB')
    scale = min(1.0, 640 / max(1, crop.width), 180 / max(1, crop.height))
    crop = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.Resampling.LANCZOS)
    sx, sy = crop.width / (box[2] - box[0]), crop.height / (box[3] - box[1])
    pixels = list(crop.getdata())
    w, h = crop.size
    border = [rgb for i, rgb in enumerate(pixels) if i < w or i >= len(pixels)-w or i % w in (0, w-1)]
    bg = tuple(median(c) for c in zip(*border))
    def distance(a, b):
        return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))
    bins = Counter(tuple(v // 16 for v in rgb) for rgb in pixels)
    candidates = []
    hint = tuple(int(suggested[i:i+2], 16) for i in (1, 3, 5)) if re.fullmatch(r'#[0-9a-fA-F]{6}', str(suggested)) else None
    for key, count in bins.most_common(32):
        center = tuple(v * 16 + 8 for v in key)
        contrast = distance(center, bg)
        if contrast < 38:
            continue
        prior = 1.0 + (0.4 * max(0, 1 - distance(center, hint) / 160) if hint else 0)
        candidates.append((count * math.sqrt(contrast) * prior, center))
    if not candidates:
        return None
    seed = max(candidates)[1]
    pool = [p for p in pixels if distance(p, seed) < 28]
    ink = tuple(round(median(c)) for c in zip(*pool))
    contrast = distance(ink, bg)
    radius = max(24, min(70, contrast * 0.32))
    mask = Image.new('L', crop.size)
    mask.putdata([255 if distance(p, ink) < radius and distance(p, bg) > contrast * 0.38 else 0 for p in pixels])
    # OCR quadrilaterals occasionally include a neighbouring line. Separate
    # only broad ink bands with a large blank gap; keep detached accents and
    # the disconnected strokes of a single CJK glyph together.
    data=mask.tobytes();rows=[sum(bool(v) for v in data[y*w:(y+1)*w]) for y in range(h)]
    occupied=[y for y,count in enumerate(rows) if count>=max(2,w*.01)]
    bands=[]
    for y in occupied:
        if not bands or y-bands[-1][-1]>max(5,h*.08):bands.append([y])
        else:bands[-1].append(y)
    if len(bands)>1:
        ranked=sorted(bands,key=lambda b:sum(rows[y] for y in b),reverse=True)
        primary=ranked[0];second=ranked[1]
        def band_width(b):
            xs=[x for y in b for x in range(w) if data[y*w+x]]
            return max(xs)-min(xs)+1 if xs else 0
        if sum(rows[y] for y in second)>.01*sum(rows[y] for y in primary) and band_width(second)>.3*max(1,band_width(primary)) and second[-1]-second[0]>=4:
            clean=bytearray(data)
            for y in range(h):
                if y<primary[0] or y>primary[-1]:clean[y*w:(y+1)*w]=bytes(w)
            mask=Image.frombytes('L',mask.size,bytes(clean))
    if ignore_leaders:
        # Dotted menu leaders are not letter spacing. Remove only tiny,
        # disconnected marks outside the span of substantial glyph strokes;
        # punctuation and i-dots inside the word stay in the mask.
        data=mask.tobytes();seen=set();components=[]
        for start,value in enumerate(data):
            if not value or start in seen:continue
            todo=[start];seen.add(start);points=[]
            while todo:
                at=todo.pop();points.append(at);px,py=at%w,at//w
                for yy in range(max(0,py-1),min(h,py+2)):
                    for xx in range(max(0,px-1),min(w,px+2)):
                        near=yy*w+xx
                        if data[near] and near not in seen:seen.add(near);todo.append(near)
            xs=[p%w for p in points];ys=[p//w for p in points]
            components.append((min(xs),min(ys),max(xs)+1,max(ys)+1,points))
        tallest=max((c[3]-c[1] for c in components),default=0)
        substantial=[c for c in components if c[3]-c[1]>=tallest*.35 or c[2]-c[0]>=tallest*.45]
        if tallest>=10 and substantial:
            left=min(c[0] for c in substantial);right=max(c[2] for c in substantial)
            clean=bytearray(data)
            for a,b,c,d,points in components:
                if max(c-a,d-b)<=max(3,tallest*.18) and (c<left or a>=right):
                    for point in points:clean[point]=0
            mask=Image.frombytes('L',mask.size,bytes(clean))
    bbox = mask.getbbox()
    if not bbox:
        return None
    ink_mask = mask.crop(bbox)
    density = sum(ink_mask.getdata()) / (255 * ink_mask.width * ink_mask.height)
    if not 0.025 < density < 0.85 or ink_mask.height < 4:
        return None
    return {'color': '#%02X%02X%02X' % ink, 'confidence': round(min(0.9, contrast / 180), 2),
            'threshold': round(255 * (1-radius/max(1, contrast))), 'mask': ink_mask, 'sx': sx, 'sy': sy, 'left': box[0] + bbox[0] / sx, 'top': box[1] + bbox[1] / sy}


def render_ink(text, font, tracking=0, threshold=170):
    from PIL import Image, ImageDraw
    # Baseline-anchored metrics include ascenders, descenders and CJK bearings.
    bbox = font.getbbox(text, anchor='ls')
    advance = font.getlength(text) + max(0, len(text)-1) * tracking
    width = max(1, math.ceil(bbox[2]-bbox[0] + max(0, len(text)-1)*tracking))
    canvas = Image.new('L', (width + 4, max(1, bbox[3]-bbox[1]) + 4))
    draw = ImageDraw.Draw(canvas)
    if abs(tracking) < 0.01:
        draw.text((2-bbox[0], 2-bbox[1]), text, font=font, fill=255, anchor='ls')
    else:
        for i, char in enumerate(text):
            draw.text((2-bbox[0] + font.getlength(text[:i]) + i*tracking, 2-bbox[1]), char, font=font, fill=255, anchor='ls')
    canvas = canvas.point(lambda p: 255 if p >= threshold else 0)
    actual = canvas.getbbox()
    if not actual:
        return canvas, bbox, advance
    ink_bbox = (bbox[0]+actual[0]-2, bbox[1]+actual[1]-2, bbox[0]+actual[2]-2, bbox[1]+actual[3]-2)
    return canvas.crop(actual), ink_bbox, advance


def fit_font(text, foreground, cjk):
    from PIL import Image, ImageChops, ImageFilter, ImageFont
    target = foreground['mask']
    sx, sy = foreground['sx'], foreground['sy']
    # Uniform scale for font rendering; source image is never stretched.
    scale = min(sx, sy)
    tw, th = target.width / sx * scale, target.height / sy * scale
    target = target.resize((max(1, round(tw)), max(1, round(th))))
    best = None
    alternatives = []
    for family, ps, weight, path in font_candidates(cjk):
        reference = ImageFont.truetype(path, 100)
        _, ref, _ = render_ink(text, reference, threshold=foreground['threshold'])
        size_h = th * 100 / max(1, ref[3]-ref[1])
        size_w = tw * 100 / max(1, ref[2]-ref[0])
        sizes = {max(5, round(s)) for base in (size_h, size_w) for s in (base-2, base-1, base, base+1, base+2)}
        candidate_best = None
        for size in sorted(sizes):
            if size > 1200:
                continue
            font = ImageFont.truetype(path, size)
            base_mask, bbox, _ = render_ink(text, font, threshold=foreground['threshold'])
            gap = (target.width-base_mask.width) / max(1, len(text)-1)
            gaps = [0]
            if len(text) > 1 and abs(gap) <= size * 0.6:
                gaps.append(gap)
            for tracking in gaps:
                rendered, bbox, advance = render_ink(text, font, tracking, foreground['threshold'])
                dw = abs(rendered.width-target.width)/max(1, target.width)
                dh = abs(rendered.height-target.height)/max(1, target.height)
                if dw > 0.3 or dh > 0.3:
                    continue
                canvas_size = (max(rendered.width, target.width), max(rendered.height, target.height))
                a, b = Image.new('L', canvas_size), Image.new('L', canvas_size)
                a.paste(target, (0, 0)); b.paste(rendered, (0, 0))
                # Slight blur tolerates rasterizer differences without claiming
                # exact recovery of the original font.
                a = a.filter(ImageFilter.GaussianBlur(0.6)); b = b.filter(ImageFilter.GaussianBlur(0.6))
                overlap = sum(ImageChops.darker(a, b).getdata())
                dice = 2*overlap / max(1, sum(a.getdata())+sum(b.getdata()))
                score = dice - (dw+dh)*0.45 - abs(tracking)/size*0.02
                item = {'score': score, 'fontFamily': family, 'fontPostScript': ps, 'fontWeight': weight,
                        'fontSize': round(size / scale, 2), 'tracking': round(tracking/size*1000),
                        'baseline': -bbox[1] / scale, 'bearing': bbox[0]/scale, 'advance': advance/scale,
                        'widthError': dw, 'heightError': dh}
                if candidate_best is None or score > candidate_best['score']:
                    candidate_best = item
        if candidate_best:
            alternatives.append({'fontPostScript': ps, 'score': round(candidate_best['score'], 3)})
            if best is None or candidate_best['score'] > best['score']:
                best = candidate_best
    if best:
        best['candidates'] = sorted(alternatives, key=lambda a: -a['score'])[:3]
    return best


def infer_block(image, raw: dict) -> dict:
    width, height = image.size
    item = dict(raw)
    item.pop('textFit', None)
    item.pop('fontCandidates', None)
    x = clamp(float(raw.get('x', 0) or 0), 0, width-1)
    y = clamp(float(raw.get('y', 0) or 0), 0, height-1)
    w = clamp(float(raw.get('width', 2) or 2), 1, width-x)
    h = clamp(float(raw.get('height', 2) or 2), 1, height-y)
    padding=max(0,min(32,float(raw.get('sourceSearchPadding',0) or 0)))
    box = (max(0,math.floor(x-padding)), max(0,math.floor(y-padding)), min(width, math.ceil(x+w+padding)), min(height, math.ceil(y+h+padding)))
    text = str(raw.get('text') or '').strip()
    cjk = has_cjk(text)
    item.setdefault('fontFamily', '阿里巴巴普惠体 3.0' if cjk else 'Inter')
    item.setdefault('fontPostScript', 'AlibabaPuHuiTi_3_55_Regular' if cjk else 'Inter-Regular')
    item.setdefault('fontWeight', 'normal')
    item.setdefault('fontSize', max(8, round(h)))
    item.setdefault('textAlign', 'left')
    item.setdefault('color', '#111827')
    item['styleConfidence'] = 0.35
    item['styleNote'] = '复杂背景或旋转文字保留识别估计，需校对'
    # Axis-aligned pixel fitting must not flatten angled/multiline text.
    if abs(float(raw.get('rotation') or 0)) > 2 or not text or '\n' in text:
        return item
    fg = pixel_foreground(image, box, raw.get('color'), ignore_leaders=not text.endswith(('.', '。', '…', '·')))
    if not fg:
        return item
    item['color'] = fg['color']
    item['colorConfidence'] = fg['confidence']
    fit = fit_font(text, fg, cjk)
    if not fit or fit['score'] < 0.55 or fit['widthError'] > 0.16 or fit['heightError'] > 0.16:
        item['styleNote'] = '已从原图取色；字体匹配不足，保留识别字号并待校对'
        return item
    for key in ('fontFamily', 'fontPostScript', 'fontWeight', 'fontSize', 'tracking'):
        item[key] = fit[key]
    item['textFit'] = {'text': text, 'fontPostScript': fit['fontPostScript'], 'fontSize': fit['fontSize'],
                       'tracking': fit['tracking'], 'baselineOffset': fg['top']-y+fit['baseline'],
                       'originOffsetX': fg['left']-x-fit['bearing'], 'advance': fit['advance']}
    item['fontCandidates'] = fit['candidates']
    item['styleConfidence'] = round(min(0.94, fit['score']), 3)
    item['styleNote'] = '已对照原图像素校准颜色、字体候选、字号、字距与基线；字体为近似匹配'
    return item


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path)
    parser.add_argument("--blocks")
    parser.add_argument('--spec', default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if getattr(args, 'spec', None):
        import json as _json
        from pathlib import Path as _P
        spec = _json.loads(_P(args.spec).read_text(encoding='utf-8'))
        for action in parser._actions:
            key = action.dest
            if key not in spec and key.replace('_', '-') in spec:
                key = key.replace('_', '-')
            if key in spec:
                value = spec[key]
                if action.type is not None:
                    try: value = action.type(value)
                    except Exception: pass
                setattr(args, action.dest, value)
        for key, value in spec.items():
            if not hasattr(args, key):
                setattr(args, key, value)
    try:
        from PIL import Image

        image = Image.open(args.input).convert("RGB")
        try:
            blocks = json.loads(args.blocks)
        except json.JSONDecodeError:
            blocks = []
        if not isinstance(blocks, list):
            blocks = []
        inferred = [infer_block(image, raw) for raw in blocks[:200] if isinstance(raw, dict)]
        payload = {"success": True, "width": image.width, "height": image.height, "blocks": inferred, "engine": "source-pixel-font-fit", "note": "已对照原图校准，原字体为近似匹配；生成前可逐行修改"}
        encoded = json.dumps(payload, ensure_ascii=False)
        if getattr(args, 'result_output', None):
            Path(args.result_output).write_text(encoded, encoding='utf-8')
        print(encoded)
        return 0
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
