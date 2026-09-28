#!/usr/bin/env python3
"""Create a PSD text-rebuild draft.

The base PSD is always valid without Photoshop.  It contains the untouched
source and reviewable raster previews for OCR lines.  When Photoshop is
available the host subsequently adds native text layers with JSX.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path



try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except NameError:
    pass

PSD_RUNTIME = Path.home() / ".dsh" / "canvas-workbench" / "psd-runtime"
PSD_TOOLS_VERSION = "1.9.30"
PSD_MARKER = PSD_RUNTIME / ("psd-tools-" + PSD_TOOLS_VERSION + ".ready")
PIP_INDEX_URL = os.environ.get("DSH_PIP_INDEX", "").strip()


def _pip_args():
    args = ["-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", "--timeout", "120"]
    if PIP_INDEX_URL:
        args += ["-i", PIP_INDEX_URL]
    return args


def _runtime_python():
    if os.name == "nt":
        return PSD_RUNTIME / "Scripts" / "python.exe"
    return PSD_RUNTIME / "bin" / "python"


def _install(py):
    import subprocess as sp
    sp.run([str(py), *_pip_args(), "psd-tools==" + PSD_TOOLS_VERSION, "pillow"],
           check=True, timeout=600)
    PSD_MARKER.write_text(PSD_TOOLS_VERSION + "\n", encoding="utf-8")


def ensure_psd_runtime():
    import importlib.util
    import subprocess as sp
    if importlib.util.find_spec("psd_tools") is not None:
        return
    py = _runtime_python()
    ready = False
    if PSD_MARKER.exists() and py.exists():
        probe = sp.run(
            [str(py), "-c", "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('psd_tools') else 1)"],
            stdout=sp.DEVNULL, stderr=sp.DEVNULL, timeout=30)
        ready = probe.returncode == 0
    if not ready:
        PSD_RUNTIME.mkdir(parents=True, exist_ok=True)
        if not py.exists():
            sp.run([sys.executable, "-m", "venv", str(PSD_RUNTIME)], check=True, timeout=300)
        _install(py)
    result = sp.run([str(py), *sys.argv], check=False)
    raise SystemExit(result.returncode)


def parse_color(value: object) -> tuple[int, int, int]:
    match = re.fullmatch(r"#?([0-9a-fA-F]{6})", str(value or ""))
    if not match:
        return (17, 24, 39)
    raw = match.group(1)
    return tuple(int(raw[index:index + 2], 16) for index in (0, 2, 4))


def normalize_text(value: object) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    # Tesseract may put a space between every Chinese glyph.  Remove only
    # those OCR artefacts; spaces inside English phrases remain readable.
    text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text)
    text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[，。！？；：、）》】])", "", text)
    text = re.sub(r"([（【《])\s+", r"\1", text)
    return text


def _font_search_dirs() -> list[Path]:
    # macOS：用户字体目录；Windows：用户与系统字体目录。
    # Windows 安装字体时偶尔会给文件名追加 _0/_1 后缀，用 glob 兜底匹配。
    home = Path.home()
    dirs = [home / "Library" / "Fonts"]
    if sys.platform.startswith("win"):
        dirs.append(home / "AppData" / "Local" / "Microsoft" / "Windows" / "Fonts")
        windir = os.environ.get("WINDIR")
        if windir:
            dirs.append(Path(windir) / "Fonts")
    return [d for d in dirs if d.is_dir()]


def _resolve_font_file(stem: str, extensions: tuple[str, ...]) -> str | None:
    for directory in _font_search_dirs():
        for ext in extensions:
            exact = directory / f"{stem}{ext}"
            if exact.is_file():
                return str(exact)
    # Windows 重命名的字体文件（如 xxx_0.ttf）按前缀匹配。
    for directory in _font_search_dirs():
        for ext in extensions:
            for hit in directory.glob(f"{stem}*{ext}"):
                return str(hit)
    return None


def find_font(postscript: str | None = None) -> str | None:
    # 优先用面板选中的字体（阿里巴巴普惠体 / 思源黑体，均可免费商用），
    # 让 PSD 预览文字与 Photoshop 里替换后的真实字体一致。
    if postscript:
        ps = str(postscript).strip()
        if ps.startswith("AlibabaPuHuiTi_3_"):
            # AlibabaPuHuiTi_3_65_Medium → AlibabaPuHuiTi-3-65-Medium.ttf
            resolved = _resolve_font_file(ps.replace("_", "-"), (".ttf",))
        else:
            # 其余家族（思源黑体 / Inter / Montserrat / Poppins / Source Sans Pro…）
            # 的字体文件名与 PostScript 名一致，通用匹配 .otf/.ttf 两种扩展。
            resolved = _resolve_font_file(ps, (".otf", ".ttf"))
        if resolved:
            return resolved
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica.ttc",
    ]
    return next((item for item in candidates if Path(item).is_file()), None)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--blocks", help="JSON array of OCR blocks")
    parser.add_argument("--clean-input", default="", help="optional image2 clean-plate with OCR text removed")
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
                value = spec[action.dest]
                if action.type is not None:
                    try: value = action.type(value)
                    except Exception: pass
                setattr(args, action.dest, value)
        for key, value in spec.items():
            if not hasattr(args, key):
                setattr(args, key, value)
    ensure_psd_runtime()
    try:
        from PIL import Image, ImageDraw, ImageFont
        from psd_tools import PSDImage
        from psd_tools.api.layers import PixelLayer

        source = Path(args.input)
        output = Path(args.output)
        image = Image.open(source).convert("RGBA")
        # RGB keeps Photoshop and Quick Look compatibility predictable.  The
        # source itself is preserved as a full-canvas pixel layer.
        rgb = Image.new("RGB", image.size, (255, 255, 255))
        rgb.paste(image, mask=image.getchannel("A"))
        psd = PSDImage.new("RGB", image.size, color=0, depth=8)
        original = psd.create_pixel_layer(rgb, name="Original artwork (preserved)")
        clean_path = Path(args.clean_input) if args.clean_input else None
        clean_rgb = None
        if clean_path and clean_path.is_file() and clean_path.stat().st_size > 0:
            clean_image = Image.open(clean_path).convert("RGBA")
            if clean_image.size != image.size:
                clean_image = clean_image.resize(image.size, Image.Resampling.LANCZOS)
            clean_rgb = Image.new("RGB", clean_image.size, (255, 255, 255))
            clean_rgb.paste(clean_image, mask=clean_image.getchannel("A"))
        # The original is always kept for recovery.  When a clean plate is
        # available it becomes the visible base; otherwise the untouched source
        # remains visible and the PSD is still a safe review draft.
        original.visible = clean_rgb is None
        if clean_rgb is not None:
            clean_layer = psd.create_pixel_layer(clean_rgb, name="Clean background (image2)")
            clean_layer.visible = True

        try:
            blocks = json.loads(args.blocks)
        except json.JSONDecodeError:
            blocks = []
        if not isinstance(blocks, list):
            blocks = []
        # psd-tools 1.11 writes layer names through a legacy single-byte
        # encoder; ASCII names keep the offline fallback valid on macOS.
        group = psd.create_group(name="OCR text preview - replace in Photoshop", open_folder=False)
        # OCR/model geometry is a reconstruction suggestion, not verified
        # artwork.  Keep every candidate available for editing, but never let
        # an inaccurate candidate cover the successfully cleaned background
        # when the PSD is first opened or previewed on the canvas.
        group.visible = False
        font_cache: dict[str, str | None] = {}
        for index, raw in enumerate(blocks[:200]):
            if not isinstance(raw, dict) or raw.get("enabled") is False:
                continue
            text = normalize_text(raw.get("text"))
            if not text:
                continue
            x = max(0, int(float(raw.get("x", 0) or 0)))
            y = max(0, int(float(raw.get("y", 0) or 0)))
            width = max(2, int(float(raw.get("width", 240) or 240)))
            height = max(2, int(float(raw.get("height", 48) or 48)))
            size = max(8, min(220, int(float(raw.get("fontSize", height * 0.92) or height * 0.92))))
            postscript = str(raw.get("fontPostScript") or "")
            if postscript not in font_cache:
                font_cache[postscript] = find_font(postscript or None)
            font_path = font_cache[postscript]
            try:
                font = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
            except Exception:
                font = ImageFont.load_default()
            canvas = Image.new("RGBA", (max(width, 4), max(height, size + 8)), (0, 0, 0, 0))
            draw = ImageDraw.Draw(canvas)
            draw.text((1, 0), text, fill=parse_color(raw.get("color")), font=font, spacing=max(1, int(size * 0.15)))
            layer = PixelLayer.frompil(canvas, parent=group, name=f"OCR text {index + 1}", top=y, left=x)
            layer.visible = False
            group.append(layer)
        output.parent.mkdir(parents=True, exist_ok=True)
        psd.save(output)
        print(json.dumps({"success": True, "width": image.width, "height": image.height, "layers": len(blocks[:200]) + 1 + (1 if clean_rgb is not None else 0), "cleanBackground": clean_rgb is not None, "output": str(output)}, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
