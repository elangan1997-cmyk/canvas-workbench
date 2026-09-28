#!/usr/bin/env python3
"""Build a narrow, feathered image2 inpainting mask from OCR boxes.

The image-generation runners use the same convention as the canvas masks:
transparent pixels are editable and opaque pixels are locked.  OCR boxes are
expanded just enough to include antialiasing and glyph shadows, then blurred
at the edge so the later pixel-preserving composite cannot leave a hard seam.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except NameError:
    pass


def _number(value: object, fallback: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path)
    parser.add_argument("--blocks", help="OCR block JSON array")
    parser.add_argument("--regions", default="[]", help="authoritative user-selected region JSON array")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--padding", type=float, default=0.0, help="extra pixels around each OCR box")
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
        from PIL import Image, ImageDraw, ImageFilter

        image = Image.open(args.source).convert("RGBA")
        try:
            blocks = json.loads(args.blocks)
        except json.JSONDecodeError:
            blocks = []
        if not isinstance(blocks, list):
            blocks = []
        try:
            regions = json.loads(args.regions)
        except json.JSONDecodeError:
            regions = []
        if not isinstance(regions, list):
            regions = []

        width, height = image.size
        # A fixed 3-10px margin was insufficient for large display type and for
        # vision-model boxes that land a few pixels inside the actual glyphs.
        # Keep a small image-level floor, then expand every row proportionally
        # to its own box/font height.  This covers outlines, shadows and
        # antialiasing without turning a text edit into a whole-image edit.
        automatic = max(4.0, min(14.0, min(width, height) * 0.005))
        base_padding = max(2.0, min(24.0, automatic + max(0.0, args.padding)))
        selected = Image.new("L", (width, height), 0)
        draw = ImageDraw.Draw(selected)
        count = 0
        region_count = 0
        # Explicit user regions are authoritative.  Painting the exact region
        # avoids leaving glyph fragments when a vision/OCR box is too small or
        # slightly displaced.  The user can deliberately include enough local
        # background for image2 to reconstruct a clean plate.
        for raw in regions[:24]:
            if not isinstance(raw, dict):
                continue
            x0 = max(0.0, _number(raw.get("x")))
            y0 = max(0.0, _number(raw.get("y")))
            x1 = min(width, x0 + max(0.0, _number(raw.get("width"))))
            y1 = min(height, y0 + max(0.0, _number(raw.get("height"))))
            if x1 - x0 < 6 or y1 - y0 < 6:
                continue
            draw.rectangle((round(x0), round(y0), round(x1), round(y1)), fill=255)
            region_count += 1

        # Compatibility fallback for callers that do not yet pass selections.
        for raw in ([] if region_count else blocks[:200]):
            if not isinstance(raw, dict) or raw.get("enabled") is False:
                continue
            text = str(raw.get("text") or "").strip()
            if not text:
                continue
            box_x = max(0.0, _number(raw.get("x")))
            box_y = max(0.0, _number(raw.get("y")))
            box_w = max(2.0, _number(raw.get("width"), 2.0))
            box_h = max(2.0, _number(raw.get("height"), 2.0))
            font_h = max(box_h, _number(raw.get("fontSize"), box_h))
            pad_x = max(base_padding, min(52.0, box_h * 0.24, font_h * 0.22))
            pad_y = max(base_padding, min(44.0, box_h * 0.38, font_h * 0.30))
            x0 = box_x - pad_x
            y0 = box_y - pad_y
            x1 = box_x + box_w + pad_x
            y1 = box_y + box_h + pad_y
            if x1 <= 0 or y1 <= 0 or x0 >= width or y0 >= height:
                continue
            draw.rectangle((round(max(0.0, x0)), round(max(0.0, y0)), round(min(width, x1)), round(min(height, y1))), fill=255)
            count += 1

        # A fully opaque mask is a safe no-op if every OCR candidate was
        # disabled; it also makes accidental whole-image generation impossible.
        mask_count = region_count or count
        if mask_count:
            # Give the image model a visibly soft transition.  The later
            # composite still restores every pixel outside this declared mask.
            blur_radius = max(3.0, min(8.0, min(width, height) * 0.0035))
            selected = selected.filter(ImageFilter.GaussianBlur(blur_radius))
        alpha = selected.point(lambda value: 255 - value)
        result = Image.new("RGBA", image.size, (255, 255, 255, 255))
        result.putalpha(alpha)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        result.save(args.output, format="PNG", optimize=True)
        print(json.dumps({"success": True, "width": width, "height": height, "blocks": count, "regions": region_count, "padding": round(base_padding, 2), "blur": round(blur_radius if mask_count else 0, 2)}, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
