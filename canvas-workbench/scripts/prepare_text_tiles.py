#!/usr/bin/env python3
"""Crop selected source pixels for vision OCR; never downsample a long page."""
import argparse
import json
import math
from pathlib import Path
from PIL import Image


def prepare(spec):
    image = Image.open(spec['input'])
    width, height = image.size
    output = Path(spec['output'])
    output.mkdir(parents=True, exist_ok=True)
    tiles = []
    for region in spec['crops']:
        left = max(0, min(width, math.floor(float(region.get('x', 0)))))
        top = max(0, min(height, math.floor(float(region.get('y', 0)))))
        right = max(left, min(width, math.ceil(float(region.get('x', 0)) + float(region['width']))))
        bottom = max(top, min(height, math.ceil(float(region.get('y', 0)) + float(region['height']))))
        if right - left < 6 or bottom - top < 6:
            continue
        region_width, region_height = right - left, bottom - top
        # Decide on the selected crop, never the full artwork. Ordinary
        # selections (including a wide, short heading) need one model call.
        direct = region_width * region_height <= 1_600_000 and max(region_width, region_height) <= 2400
        step_x = region_width if direct else 960
        step_y = region_height if direct else 640
        padding = 0 if direct else 80
        # Small cores bound both text density and provider image resizing.
        # 80px overlap preserves lines crossing a tile boundary.
        for y in range(top, bottom, step_y):
            for x in range(left, right, step_x):
                box = (max(left, x - padding), max(top, y - padding), min(right, x + step_x + padding), min(bottom, y + step_y + padding))
                if len(tiles) >= 96:
                    raise ValueError('选区过大，请分批识别（每批最多 96 个分块）')
                path = output / ('tile-%03d.png' % len(tiles))
                crop = image.crop(box).convert('RGB')
                crop.save(path, format='PNG')
                tiles.append({'path': str(path), 'x': box[0], 'y': box[1], 'width': crop.width, 'height': crop.height,
                              'core': {'x': x, 'y': y, 'width': min(step_x, right - x), 'height': min(step_y, bottom - y)}})
    if not tiles:
        raise ValueError('选区不在图片范围内')
    return {'success': True, 'width': width, 'height': height, 'tiles': tiles}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--spec', required=True)
    args = parser.parse_args()
    spec = json.loads(Path(args.spec).read_text(encoding='utf-8'))
    try:
        result = prepare(spec)
    except Exception as exc:
        result = {'success': False, 'error': str(exc)}
    serialized = json.dumps(result, ensure_ascii=False)
    Path(spec['result_output']).write_text(serialized, encoding='utf-8')
    print(serialized)
    raise SystemExit(0 if result['success'] else 1)
