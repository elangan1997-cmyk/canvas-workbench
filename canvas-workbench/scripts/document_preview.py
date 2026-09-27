#!/usr/bin/env python
"""把 PDF / AI（PDF 兼容格式）的首页渲染成 JPEG，供画布预览使用。

背景：macOS 用 sips/qlmanage，其他平台靠 pdftoppm(Poppler)。Windows 上这两个
都没有，于是 .ai / .pdf 的预览一直只是"预览转换器不可用"的占位 SVG。
这里用插件自带 Python 运行时的 PyMuPDF 直接渲染，不依赖任何外部命令。

AI 文件在"创建 PDF 兼容文件"（Illustrator 默认勾选）时文件头是 %PDF-x.y，
可以按 PDF 直接解析；旧版 PostScript 版 AI 无法解析，此时以非 0 退出，
由上层回退到占位图，不影响画布。

输出：成功时打印一行 JSON（success/width/height/pages），退出码 0。
"""
import argparse
import json
import os
import sys


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max", type=int, default=2400, help="最长边像素上限")
    parser.add_argument("--quality", type=int, default=88, help="JPEG 质量")
    args = parser.parse_args()

    try:
        import pymupdf as fitz
    except Exception:
        try:
            import fitz  # 旧版本模块名
        except Exception as exc:
            emit({"success": False, "error": "pymupdf 不可用: %s" % exc})
            return 2

    try:
        if not os.path.isfile(args.input) or os.path.getsize(args.input) <= 0:
            emit({"success": False, "error": "输入文件不存在或为空"})
            return 3
    except OSError as exc:
        emit({"success": False, "error": "无法访问输入: %s" % exc})
        return 3

    try:
        document = fitz.open(args.input)
    except Exception as exc:
        emit({"success": False, "error": "打开失败: %s" % exc})
        return 4

    try:
        if document.page_count < 1 or document.needs_pass:
            emit({"success": False, "error": "文档没有可渲染页面"})
            return 5
        page = document.load_page(0)
        rect = page.rect
        longest = max(float(rect.width), float(rect.height)) or 1.0
        # 栅格化倍率：让最长边落在 --max 附近，同时限幅避免超大图拖垮内存
        zoom = min(6.0, max(0.2, float(args.max) / longest))
        pixmap = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        data = pixmap.tobytes("jpeg", jpg_quality=max(40, min(95, int(args.quality))))
        with open(args.output, "wb") as handle:
            handle.write(data)
        emit({
            "success": True,
            "pages": int(document.page_count),
            "width": int(pixmap.width),
            "height": int(pixmap.height),
            "bytes": len(data),
        })
        return 0
    except Exception as exc:
        emit({"success": False, "error": "渲染失败: %s" % exc})
        return 6
    finally:
        try:
            document.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
