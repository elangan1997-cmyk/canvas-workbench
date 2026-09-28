#!/usr/bin/env python3
"""Build an Illustrator-editable SVG from OCR blocks on top of a background.

Mirrors export_text_psd.py's text normalization / geometry / colour rules:
- blocks carry pixel coords (x, y, width, height), fontSize defaults to
  height * 0.92, colour is #rrggbb;
- the clean plate (text removed) becomes the embedded background when
  available; otherwise the untouched source is embedded and the text group
  is written hidden (original glyphs are still in the background — enable
  the group in Illustrator's Layers panel after editing).

Fonts: PostScript names from the panel are mapped to family + weight/style
attributes so Illustrator resolves the installed family (阿里巴巴普惠体 3.0 /
思源黑体 SC / Inter / Montserrat / Poppins / Source Sans Pro — all free for
commercial use). The PostScript name is kept as a fallback family.
"""

import argparse
import base64
import io
import json
import re
from pathlib import Path

try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except NameError:
    pass


import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from export_text_psd import normalize_text, parse_color  # noqa: E402


def font_attributes(postscript: str) -> tuple[str, str, str]:
    """PostScript 名 → (font-family 列表, font-weight, font-style)。"""
    ps = str(postscript or "").strip()
    weight = "400"
    style = "normal"
    families: list[str] = []
    m = re.fullmatch(r"AlibabaPuHuiTi_3_(\d{2,3})_(Regular|Bold|Medium|Light|Heavy)", ps)
    if m:
        families = ["Alibaba PuHuiTi 3.0", "阿里巴巴普惠体 3.0"]
        weight = {"35": "250", "45": "300", "55": "400", "65": "500", "85": "700", "95": "800", "105": "900", "115": "900"}.get(m.group(1), "400")
    else:
        m = re.fullmatch(r"SourceHanSansSC-(ExtraLight|Light|Normal|Regular|Medium|Bold|Heavy)", ps)
        if m:
            families = ["Source Han Sans SC", "思源黑体 SC"]
            weight = {"ExtraLight": "250", "Light": "300", "Normal": "350", "Regular": "400", "Medium": "500", "Bold": "700", "Heavy": "900"}[m.group(1)]
        else:
            m = re.fullmatch(r"(Inter|Montserrat|Poppins|SourceSansPro|SourceSans3)-([A-Za-z]+)", ps)
            if m:
                families = [{"SourceSansPro": "Source Sans Pro", "SourceSans3": "Source Sans 3"}.get(m.group(1), m.group(1))]
                token = m.group(2).lower()
                for key, value in [("thin", "100"), ("extralight", "200"), ("light", "300"), ("regular", "400"), ("medium", "500"), ("semibold", "600"), ("bold", "700"), ("extrabold", "800"), ("black", "900")]:
                    if token.startswith(key):
                        weight = value
                        break
                style = "italic" if token.endswith("italic") else "normal"
    if ps:
        families.append(ps)
    families.append("sans-serif")
    return ", ".join(families), weight, style


def escape_xml(value: str) -> str:
    return (str(value)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace('"', "&quot;"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--blocks", default=None, help="JSON array of OCR blocks")
    parser.add_argument("--clean-input", default="", help="optional clean plate with text removed")
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

        clean_path = Path(args.clean_input) if args.clean_input else None
        background_path = clean_path if (clean_path and clean_path.is_file() and clean_path.stat().st_size > 0) else Path(args.input)
        has_clean = background_path == clean_path
        image = Image.open(background_path).convert("RGBA")
        # 统一嵌入为 PNG，避免 JPEG/WEBP 直传时部分 AI 版本按文件头猜测出错
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=True)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        width, height = image.size

        try:
            blocks = json.loads(args.blocks)
        except json.JSONDecodeError:
            blocks = []
        if not isinstance(blocks, list):
            blocks = []

        parts: list[str] = []
        visible_count = 0
        for index, raw in enumerate(blocks[:200]):
            if not isinstance(raw, dict) or raw.get("enabled") is False:
                continue
            text = normalize_text(raw.get("text"))
            if not text:
                continue
            x = max(0, float(raw.get("x", 0) or 0))
            y = max(0, float(raw.get("y", 0) or 0))
            box_width = max(2, float(raw.get("width", 240) or 240))
            box_height = max(2, float(raw.get("height", 48) or 48))
            size = max(8, min(220, float(raw.get("fontSize") or box_height * 0.92 or box_height * 0.92)))
            family, weight, style = font_attributes(raw.get("fontPostScript") or "")
            r, g, b = parse_color(raw.get("color"))
            align = str(raw.get("textAlign") or "left").lower()
            anchor = {"center": "middle", "right": "end", "end": "end"}.get(align, "start")
            # 与 PSD 预览层一致：文本框内左上起排（PIL draw.text((1, 0))）。
            # SVG 用基线定位：ascent ≈ 0.8em，再加少量视觉居中偏移。
            tx = x + 1 if anchor == "start" else x + box_width / 2 if anchor == "middle" else x + box_width - 1
            baseline = y + size * 0.82
            rotation = float(raw.get("rotation") or 0)
            transform = f' transform="rotate({rotation:.2f} {tx:.1f} {baseline:.1f})"' if abs(rotation) > 0.05 else ""
            parts.append(
                f'<text id="dsh-text-{index + 1}" x="{tx:.1f}" y="{baseline:.1f}" '
                f'font-family="{escape_xml(family)}" font-size="{size:.1f}" font-weight="{weight}" font-style="{style}" '
                f'fill="#{r:02x}{g:02x}{b:02x}" text-anchor="{anchor}" xml:space="preserve"{transform}>{escape_xml(text)}</text>'
            )
            visible_count += 1

        group_display = "" if has_clean else ' display="none"'
        note = "background=text-removed clean plate" if has_clean else "background=original (text layer hidden: enable it in Illustrator Layers after editing)"
        svg = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            f'width="{width}" height="{height}" viewBox="0 0 {width} {height}">\n'
            f'<title>DSH 文字重建 — {escape_xml(note)}</title>\n'
            '<desc>背景为嵌入位图，文字为可编辑文本对象；字体均为免费商用（阿里巴巴普惠体 3.0 / 思源黑体 / Inter 等，需本机安装）。</desc>\n'
            f'<g id="DSH 背景"><image x="0" y="0" width="{width}" height="{height}" xlink:href="data:image/png;base64,{encoded}"/></g>\n'
            f'<g id="DSH 文字"{group_display}>\n' + "\n".join(parts) + "\n</g>\n</svg>\n"
        )
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(svg, encoding="utf-8")
        print(json.dumps({"success": True, "width": width, "height": height, "texts": visible_count, "cleanBackground": has_clean, "output": str(output)}, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
