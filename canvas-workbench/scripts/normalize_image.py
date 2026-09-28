#!/usr/bin/env python3
"""把任意格式的图片字节规范化为真 PNG（模型输出可能是 WEBP/JPEG 却带 .png 扩展名，
Photoshop/Illustrator 按扩展名打开会失败；PIL 按内容嗅探不受影响）。"""

import argparse
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



def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--resize", default="", help="WxH，写回画布前把模型输出缩放回原尺寸")
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
    image = Image.open(args.input)
    if args.resize:
        try:
            w, h = (int(v) for v in str(args.resize).lower().split("x"))
            if w > 0 and h > 0 and image.size != (w, h):
                image = image.resize((w, h), Image.Resampling.LANCZOS)
        except ValueError:
            pass
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.mode or image.mode == "P" else "RGB")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    image.save(args.output, format="PNG", optimize=True)
    print("ok", image.size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
