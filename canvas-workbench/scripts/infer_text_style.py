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


def estimate_color(image, box: tuple[int, int, int, int]) -> tuple[str, float]:
    """Return a contrast-weighted foreground color and a confidence hint."""
    x0, y0, x1, y1 = box
    crop = image.crop((x0, y0, x1, y1)).convert("RGB")
    pixels = list(crop.getdata())
    if not pixels:
        return "#111827", 0.15
    # Estimate the local background from the crop border, then prefer pixels
    # furthest from it.  This works for both dark-on-light and light-on-dark
    # text (a darkness-only heuristic fails on dark posters).
    crop_width, crop_height = crop.size
    border = [
        rgb for idx, rgb in enumerate(pixels)
        if idx < crop_width or idx >= len(pixels) - crop_width
        or (idx % max(1, crop_width) < 2)
        or (idx % max(1, crop_width) >= max(1, crop_width) - 2)
    ] or pixels
    background = tuple(median(channel) for channel in zip(*border))
    scored = []
    for rgb in pixels:
        r, g, b = rgb
        distance = math.sqrt(sum((float(channel) - float(background[index])) ** 2 for index, channel in enumerate(rgb)))
        sat = max(rgb) - min(rgb)
        score = distance + sat * 0.12
        scored.append((score, rgb))
    scored.sort(key=lambda item: item[0], reverse=True)
    pool = [rgb for _, rgb in scored[: max(4, min(len(scored), len(scored) // 8 or 1))]]
    color = tuple(round(median(channel)) for channel in zip(*pool))
    confidence = clamp((scored[0][0] - scored[-1][0]) / 255.0, 0.18, 0.88)
    return "#%02x%02x%02x" % color, round(confidence, 2)


def infer_block(image, raw: dict) -> dict:
    width, height = image.size
    x = clamp(float(raw.get("x", 0) or 0), 0, width - 1)
    y = clamp(float(raw.get("y", 0) or 0), 0, height - 1)
    box_width = clamp(float(raw.get("width", 2) or 2), 2, width - x)
    box_height = clamp(float(raw.get("height", 2) or 2), 2, height - y)
    box = (round(x), round(y), round(x + box_width), round(y + box_height))
    text = str(raw.get("text") or "").strip()
    cjk = has_cjk(text)
    color, color_confidence = estimate_color(image, box)
    weight = "normal"
    # PostScript names are what Photoshop's textItem.font expects.  CJK
    # candidates use 阿里巴巴普惠体 3.0 / 思源黑体 (free for commercial use);
    # PingFang and other system fonts are avoided because their licenses do
    # not cover commercial artwork.
    if cjk:
        family = "阿里巴巴普惠体 3.0"
        postscript = "AlibabaPuHuiTi_3_55_Regular"
        if len(text) <= 10 and box_height >= 36:
            weight = "bold"
            postscript = "AlibabaPuHuiTi_3_85_Bold"
    else:
        family = "Inter"
        postscript = "Inter-Regular"
        if box_height >= 32 and len(text) <= 18:
            weight = "bold"
            postscript = "Inter-Bold"
    font_size = max(8, min(220, round(box_height * 0.9)))
    # A line with little vertical padding is more likely to have a heavy face;
    # keep the score modest because this is an estimate, not font recovery.
    style_confidence = clamp(0.48 + min(0.2, color_confidence * 0.22) + (0.08 if cjk else 0), 0.35, 0.82)
    item = dict(raw)
    item.update({
        "fontFamily": family,
        "fontPostScript": postscript,
        "fontWeight": weight,
        "fontSize": font_size,
        "color": color,
        "textAlign": "left",
        "styleConfidence": round(style_confidence, 2),
        "styleNote": "扁平图像推测，原字体不可从像素中完全恢复",
    })
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
        print(json.dumps({"success": True, "width": image.width, "height": image.height, "blocks": inferred, "engine": "local-font-heuristic", "note": "字体/字号/颜色为视觉推测，生成前可逐行修改"}, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
