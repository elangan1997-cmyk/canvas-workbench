#!/usr/bin/env python3
"""Normalize and expand a transparent-area inpainting mask."""

import argparse
import pathlib
from PIL import Image, ImageFilter

import sys
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass



def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=pathlib.Path)
    parser.add_argument("--mask", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument('--spec', default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if getattr(args, 'spec', None):
        import json as _json
        from pathlib import Path as _P
        spec = _json.loads(_P(args.spec).read_text(encoding='utf-8'))
        for action in parser._actions:
            if action.dest in spec:
                value = spec[action.dest]
                if action.type is not None:
                    try: value = action.type(value)
                    except Exception: pass
                setattr(args, action.dest, value)
        for key, value in spec.items():
            if not hasattr(args, key):
                setattr(args, key, value)

    source = Image.open(args.source)
    mask = Image.open(args.mask).convert("RGBA")
    if mask.size != source.size:
        mask = mask.resize(source.size, Image.Resampling.NEAREST)

    # The canvas mask uses transparent pixels for the editable region. Expand
    # that region enough to include glyph antialiasing, shadows and outlines.
    selected = mask.getchannel("A").point(lambda value: 255 - value)
    # Bold display type often has antialiasing, shadow and outline extending
    # well beyond the user's painted centre line. At 2K/2.4K the previous 24px
    # cap could leave vertical glyph fragments outside the composite core.
    # Use roughly 2% of the short side, capped at 48px to avoid reaching nearby
    # products when the user paints a reasonably tight selection.
    radius = max(10, min(48, round(min(source.size) * 0.020)))
    kernel = radius * 2 + 1
    if kernel % 2 == 0:
        kernel += 1
    selected = selected.filter(ImageFilter.MaxFilter(kernel)).point(lambda value: 255 if value >= 8 else 0)
    alpha = selected.point(lambda value: 255 - value)

    prepared = Image.new("RGBA", source.size, (255, 255, 255, 255))
    prepared.putalpha(alpha)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    prepared.save(args.output, format="PNG", optimize=True)


if __name__ == "__main__":
    main()
