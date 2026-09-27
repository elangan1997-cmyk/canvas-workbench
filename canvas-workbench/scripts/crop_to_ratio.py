#!/usr/bin/env python3
"""把生成图按目标宽高比居中裁切(cover 语义)。
dsh-codex 的 imagegen 上游把 size 写死为 auto,无法在请求里指定比例;
聊天侧显式选了比例时,生成后用它裁到所选比例——只裁不放大,保证不糊。
已在目标比例内(±0.5%)则原样通过,不重编码。"""

import argparse
import pathlib
from PIL import Image, ImageOps


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--size", required=True, help="目标比例的参考尺寸 WxH,如 1080x1920")
    args = parser.parse_args()
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
