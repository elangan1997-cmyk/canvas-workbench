#!/usr/bin/env python3
"""把生成图按目标宽高比居中裁切(cover 语义)。
dsh-codex 的 imagegen 上游把 size 写死为 auto,无法在请求里指定比例;
聊天侧显式选了比例时,生成后用它裁到所选比例——只裁不放大,保证不糊。
已在目标比例内(±0.5%)则原样通过,不重编码。"""

import argparse
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except NameError:
    import sys as _sys
    if hasattr(_sys.stdout, 'reconfigure'):
        _sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(_sys.stderr, 'reconfigure'):
        _sys.stderr.reconfigure(encoding='utf-8')

import pathlib
from PIL import Image, ImageOps


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=pathlib.Path)
    parser.add_argument("--output", type=pathlib.Path)
    parser.add_argument("--size", help="目标比例的参考尺寸 WxH,如 1080x1920")
    parser.add_argument('--spec', default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if getattr(args, 'spec', None):
        import json as _json
        from pathlib import Path as _P
        spec = _json.loads(_P(args.spec).read_text(encoding='utf-8'))
        # 值经 argparse 声明的 type 转换器处理(如 Path),与命令行语义一致。
        for action in parser._actions:
            if action.dest in spec:
                value = spec[action.dest]
                if action.type is not None:
                    try:
                        value = action.type(value)
                    except Exception:
                        pass
                setattr(args, action.dest, value)
        for key, value in spec.items():
            if not hasattr(args, key):
                setattr(args, key, value)
        if getattr(args, 'input', None) is None and not getattr(args, 'prepare', False):
            parser.error('--input is required')
    try:
        target_w, target_h = (int(v) for v in str(args.size).lower().split("x"))
        if target_w <= 0 or target_h <= 0:
            raise ValueError("bad size")
    except ValueError:
        print("err bad-size", flush=True)
        return 2

    image = Image.open(args.input)
    image = ImageOps.exif_transpose(image)
    width, height = image.size
    target_ratio = target_w / target_h
    current_ratio = width / height
    if abs(current_ratio - target_ratio) / target_ratio < 0.005:
        if args.input.resolve() != args.output.resolve():
            args.output.parent.mkdir(parents=True, exist_ok=True)
            image.save(args.output, format="PNG", optimize=True)
        print("ok same-ratio", flush=True)
        return 0

    if current_ratio > target_ratio:
        # 比 target 更"宽":左右裁
        new_width = round(height * target_ratio)
        left = (width - new_width) // 2
        box = (left, 0, left + new_width, height)
    else:
        # 比 target 更"高":上下裁
        new_height = round(width / target_ratio)
        top = (height - new_height) // 2
        box = (0, top, width, top + new_height)
    cropped = image.crop(box)
    if cropped.mode not in ("RGB", "RGBA"):
        cropped = cropped.convert("RGBA" if "A" in cropped.mode or cropped.mode == "P" else "RGB")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    cropped.save(args.output, format="PNG", optimize=True)
    print("ok cropped", cropped.size, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
