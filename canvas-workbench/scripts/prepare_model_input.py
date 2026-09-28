#!/usr/bin/env python3
"""Prepare a compact, dimension-matched image/mask pair for image APIs.

--crop-to-mask: instead of downscaling the whole image, cut a native-resolution
window around the editable (transparent) mask area with generous context, so a
small erase region on a 2K+ image no longer comes back as an upscaled blur.
The crop rectangle is written to --crop-info as JSON for composite_edit.py.
"""

import argparse
import json
import pathlib
from PIL import Image

import sys
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass



def mask_bbox(mask: Image.Image):
    # Transparent pixels mark the editable region.
    editable = mask.getchannel("A").point(lambda value: 255 if value < 255 else 0)
    return editable.getbbox()


def crop_window(bbox, width, height, max_side):
    x0, y0, x1, y1 = bbox
    bw, bh = x1 - x0, y1 - y0
    # Context margin: 35% of the larger selection side, never less than 96px —
    # but shrink it (down to 32px) when that would push the window past the
    # model budget, so a selection that fits in max_side stays native-res.
    margin = max(96, int(round(0.35 * max(bw, bh))))
    room = (max_side - max(bw, bh)) // 2
    if room < margin:
        margin = max(32, room)
    cx0, cy0, cx1, cy1 = x0 - margin, y0 - margin, x1 + margin, y1 + margin
    # Grow the window so its long side reaches the model's native budget
    # (up to max_side) — more native pixels, more context, no upscaling.
    target = min(max_side, max(width, height))

    def grow(lo, hi):
        size = hi - lo
        if size >= target:
            return lo, hi
        extra = target - size
        return lo - extra // 2, hi + (extra - extra // 2)

    cx0, cx1 = grow(cx0, cx1)
    cy0, cy1 = grow(cy0, cy1)
    # Clamp into the image, shifting rather than shrinking when possible.
    if cx0 < 0:
        cx1 -= cx0
        cx0 = 0
    if cy0 < 0:
        cy1 -= cy0
        cy0 = 0
    if cx1 > width:
        cx0 -= cx1 - width
        cx1 = width
    if cy1 > height:
        cy0 -= cy1 - height
        cy1 = height
    cx0, cy0 = max(0, cx0), max(0, cy0)
    # Even dimensions play nicer with some image encoders.
    cw, ch = (cx1 - cx0) & ~1, (cy1 - cy0) & ~1
    return cx0, cy0, max(2, cw), max(2, ch)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=pathlib.Path)
    parser.add_argument("--output-image", type=pathlib.Path)
    parser.add_argument("--mask", type=pathlib.Path)
    parser.add_argument("--output-mask", type=pathlib.Path)
    parser.add_argument("--max-side", type=int, default=1024)
    parser.add_argument("--crop-to-mask", action="store_true")
    parser.add_argument("--crop-info", type=pathlib.Path)
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

    source = Image.open(args.source).convert("RGB")
    width, height = source.size
    mask = None
    if args.mask:
        if not args.output_mask:
            parser.error("--output-mask is required with --mask")
        mask = Image.open(args.mask).convert("RGBA")
        if mask.size != source.size:
            mask = mask.resize(source.size, Image.Resampling.NEAREST)

    crop = None
    if args.crop_to_mask and mask is not None:
        bbox = mask_bbox(mask)
        if bbox:
            cx, cy, cw, ch = crop_window(bbox, width, height, max(64, args.max_side))
            # Only crop when it actually buys resolution/context; a selection
            # covering most of the image keeps the whole-image path.
            if cw * ch < width * height * 0.85:
                crop = (cx, cy, cw, ch)
                source = source.crop((cx, cy, cx + cw, cy + ch))
                mask = mask.crop((cx, cy, cx + cw, cy + ch))

    work_w, work_h = source.size
    scale = min(1.0, max(64, args.max_side) / max(work_w, work_h))
    target = (max(1, round(work_w * scale)), max(1, round(work_h * scale)))
    if target != source.size:
        source = source.resize(target, Image.Resampling.LANCZOS)

    args.output_image.parent.mkdir(parents=True, exist_ok=True)
    source.save(args.output_image, format="WEBP", quality=90, method=6)

    if mask is not None:
        if mask.size != target:
            mask = mask.resize(target, Image.Resampling.LANCZOS)
        args.output_mask.parent.mkdir(parents=True, exist_ok=True)
        mask.save(args.output_mask, format="PNG", optimize=True)

    if args.crop_info:
        args.crop_info.parent.mkdir(parents=True, exist_ok=True)
        info = {"image_w": width, "image_h": height, "model_w": target[0], "model_h": target[1], "scale": scale}
        if crop:
            info.update({"x": crop[0], "y": crop[1], "w": crop[2], "h": crop[3]})
        args.crop_info.write_text(json.dumps(info), encoding="utf-8")

    if crop:
        print(f"{width}x{height} crop {crop[2]}x{crop[3]}@{crop[0]},{crop[1]} -> {target[0]}x{target[1]}")
    else:
        print(f"{width}x{height}->{target[0]}x{target[1]}")


if __name__ == "__main__":
    main()
