#!/usr/bin/env python3
"""Preserve source pixels outside an inpainting mask.

--crop x,y,w,h : the model only saw a native-resolution window of the source
                 (see prepare_model_input.py --crop-to-mask); resize the generated
                 result to that window and paste it back before compositing, so
                 nothing outside the window is touched and nothing gets upscaled.
--tone-match   : the model often returns the repaired area slightly brighter /
                 warmer than the surroundings, which reads as a rectangular
                 "patch" even with a feathered edge. Measure the mean colour of
                 source vs generated inside the feather ring (where both should
                 show the same untouched content) and shift the generated pixels
                 by that difference (clamped) before compositing.
"""

import argparse
import pathlib
import sys

try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except NameError:
    pass
from PIL import Image, ImageChops, ImageFilter, ImageStat


def parse_crop(value, size):
    try:
        x, y, w, h = [int(round(float(part))) for part in str(value).split(",")]
    except Exception:
        return None
    if w <= 0 or h <= 0 or x < 0 or y < 0 or x + w > size[0] or y + h > size[1]:
        print(f"composite_edit: crop {value} outside source {size[0]}x{size[1]}, using whole-image path", file=sys.stderr)
        return None
    return x, y, w, h


def tone_match(source, generated, band):
    """Shift `generated` so its mean colour inside `band` matches `source`."""
    if band.getbbox() is None:
        return generated
    stat_src = ImageStat.Stat(source.convert("RGB"), band)
    stat_gen = ImageStat.Stat(generated.convert("RGB"), band)
    if not stat_src.count or stat_src.count[0] < 400:
        return generated
    offsets = []
    for s_mean, g_mean in zip(stat_src.mean, stat_gen.mean):
        offsets.append(max(-32.0, min(32.0, s_mean - g_mean)))
    if all(abs(offset) < 1.0 for offset in offsets):
        return generated
    channels = list(generated.split())
    for index, offset in enumerate(offsets):
        channels[index] = channels[index].point(lambda value, o=offset: max(0, min(255, int(round(value + o)))))
    print(f"composite_edit: tone offset r{offsets[0]:+.1f} g{offsets[1]:+.1f} b{offsets[2]:+.1f}", file=sys.stderr)
    return Image.merge("RGBA", channels)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=pathlib.Path)
    parser.add_argument("--generated", type=pathlib.Path)
    parser.add_argument("--mask", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--crop", help="x,y,w,h window the model worked on")
    parser.add_argument("--tone-match", action="store_true")
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

    source = Image.open(args.source).convert("RGBA")
    generated = Image.open(args.generated).convert("RGBA")
    crop = parse_crop(args.crop, source.size) if args.crop else None
    if crop:
        x, y, w, h = crop
        patch = generated if generated.size == (w, h) else generated.resize((w, h), Image.Resampling.LANCZOS)
        generated = source.copy()
        generated.paste(patch, (x, y))
    elif generated.size != source.size:
        generated = generated.resize(source.size, Image.Resampling.LANCZOS)

    if args.mask:
        mask_rgba = Image.open(args.mask).convert("RGBA")
        if mask_rgba.size != source.size:
            mask_rgba = mask_rgba.resize(source.size, Image.Resampling.NEAREST)
        alpha = mask_rgba.getchannel("A")
        selected = alpha.point(lambda value: 255 - value)
        # The prepared mask already contains the safety expansion around the
        # painted area. Keep that core fully generated so old glyphs cannot
        # leak back into the repaired region.
        core = selected.point(lambda value: 255 if value >= 8 else 0)
        # Feather ring outside the core: a wide, low-frequency transition
        # (about 1.8% of the short side, 14–48px) so a slight tone/texture
        # difference of the generated core fades out instead of reading as a
        # rectangular patch. The core itself stays fully opaque.
        feather_radius = max(14, min(48, round(min(source.size) * 0.018)))
        feather_kernel = feather_radius * 2 + 1
        expanded = core.filter(ImageFilter.MaxFilter(feather_kernel))
        feather = expanded.filter(ImageFilter.GaussianBlur(max(3.0, feather_radius * 0.72)))
        # GaussianBlur has a soft tail; clip it back to the geometric ring so
        # no generated pixels are ever written outside the declared feather.
        feather = ImageChops.multiply(feather, expanded)
        if crop:
            # Never let the feather reach outside the window the model saw.
            window = Image.new("L", source.size, 0)
            window.paste(255, (crop[0], crop[1], crop[0] + crop[2], crop[1] + crop[3]))
            feather = ImageChops.multiply(feather, window)
        edit_region = ImageChops.lighter(core, feather)
        if args.tone_match:
            # Ring = feathered area minus the core: both images should show the
            # same untouched content there.
            ring = ImageChops.subtract(expanded, core)
            generated = tone_match(source, generated, ring)
        result = Image.composite(generated, source, edit_region)
    else:
        result = generated

    args.output.parent.mkdir(parents=True, exist_ok=True)
    result.convert("RGB").save(args.output, format="PNG", optimize=True)


if __name__ == "__main__":
    main()
