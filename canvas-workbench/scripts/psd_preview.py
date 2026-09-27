#!/usr/bin/env python3
"""PSD 预览渲染（Windows / Linux 用；macOS 走系统的 sips）。

优先级：
  1) Pillow 直读 PSD 的「合成图」（Photoshop 默认勾选"最大化兼容性"时存在）——最快，全分辨率
  2) psd_tools 的缩略图（PSD 内嵌缩略图，尺寸很小但总能拿到）
  3) 都失败 -> 非 0 退出，由宿主回退到占位 SVG

用法：
  python psd_preview.py --input <file.psd> --output <preview.jpg> [--max 2400]

输出：stdout 打印 ``OK:<方法>:<宽>x<高>`` 或 ``ERR:<原因>``。
"""
import argparse
import os
import sys


def _flatten(im):
    """把带透明通道/调色板的图合成到白底，JPEG 不接受 alpha。"""
    if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
        from PIL import Image  # noqa: WPS433

        rgba = im.convert("RGBA")
        canvas = Image.new("RGB", rgba.size, (255, 255, 255))
        canvas.paste(rgba, mask=rgba.split()[-1])
        return canvas
    return im.convert("RGB")


def render_with_pillow(path):
    """Pillow 直接读 PSD 合成图（等价于 Photoshop 的"最大化兼容性"预览）。"""
    from PIL import Image  # noqa: WPS433

    im = Image.open(path)
    im.load()
    return im, "pillow"


def render_with_psd_tools(path):
    """兜底：读 PSD 内嵌缩略图，只要求文件本身可解析。"""
    from psd_tools import PSDImage  # noqa: WPS433

    thumb = PSDImage.open(path).thumbnail()
    if thumb is None:
        raise RuntimeError("PSD 内嵌缩略图为空")
    return thumb, "psd_tools.thumbnail"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max", type=int, default=2400)
    parser.add_argument("--quality", type=int, default=88)
    args = parser.parse_args()

    errors = []
    image = None
    method = ""
    for name, fn in (("pillow", render_with_pillow), ("psd_tools", render_with_psd_tools)):
        try:
            image, method = fn(args.input)
            break
        except Exception as exc:  # noqa: BLE001
            errors.append("%s: %s" % (name, exc))

    if image is None:
        print("ERR:" + " | ".join(errors))
        return 1

    try:
        width, height = image.size
        image = _flatten(image)
        if args.max > 0 and (width > args.max or height > args.max):
            image.thumbnail((args.max, args.max))
        out_dir = os.path.dirname(os.path.abspath(args.output))
        if out_dir and not os.path.isdir(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        image.save(args.output, "JPEG", quality=args.quality, optimize=True)
    except Exception as exc:  # noqa: BLE001
        print("ERR:保存失败 %s" % exc)
        return 1

    print("OK:%s:%dx%d" % (method, width, height))
    return 0


if __name__ == "__main__":
    sys.exit(main())
