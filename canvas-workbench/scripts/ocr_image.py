#!/usr/bin/env python3
"""Return OCR text blocks for a raster image.

双引擎:优先 Tesseract(若本机装了 pytesseract 与 tesseract 二进制);
否则用 RapidOCR 兜底——纯 pip 安装、免系统二进制、中英文开箱即用,
后台预置会在 ~/.dsh/canvas-workbench/ocr-runtime 建好隔离环境并切入。
输出结构与历史版本完全一致,浏览器端的核对 UI 不感知引擎差异。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

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


OCR_RUNTIME = Path.home() / ".dsh" / "canvas-workbench" / "ocr-runtime"
RAPIDOCR_VERSION = "1.4.4"
RAPIDOCR_MARKER = OCR_RUNTIME / ("rapidocr-" + RAPIDOCR_VERSION + ".ready")
PIP_INDEX_URL = os.environ.get("DSH_PIP_INDEX", "").strip()


def clean_text(value: object) -> str:
    # Tesseract often inserts a space between adjacent CJK glyphs.  Those
    # spaces are not part of the artwork and would become visible gaps in a
    # Photoshop text layer, so remove whitespace only at CJK/CJK boundaries;
    # normal spaces inside Latin words (for example “Aquarium Filter Media”)
    # remain intact.
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])", "", text)
    text = re.sub(r"(?<=[\u3400-\u9fff])\s+(?=[，。！？；：、）》】])", "", text)
    text = re.sub(r"([（【《])\s+", r"\1", text)
    return text


def tesseract_ready() -> bool:
    try:
        import pytesseract  # noqa: F401

        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


def _pip_install_args() -> list[str]:
    args = ["-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", "--timeout", "120"]
    if PIP_INDEX_URL:
        args += ["-i", PIP_INDEX_URL]
    return args


def runtime_python() -> Path:
    if os.name == "nt":
        return OCR_RUNTIME / "Scripts" / "python.exe"
    return OCR_RUNTIME / "bin" / "python"


def rapidocr_available() -> bool:
    try:
        import importlib.util

        return importlib.util.find_spec("rapidocr_onnxruntime") is not None
    except Exception:
        return False


def prepare_runtime() -> None:
    """后台预置:建 ocr-runtime 隔离环境并安装 RapidOCR(不做识别)。"""
    if rapidocr_available():
        return
    python = runtime_python()
    if RAPIDOCR_MARKER.exists() and python.exists():
        probe = subprocess.run(
            [str(python), "-c", "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('rapidocr_onnxruntime') else 1)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
        if probe.returncode == 0:
            return
    OCR_RUNTIME.mkdir(parents=True, exist_ok=True)
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(OCR_RUNTIME)], check=True, timeout=300)
    subprocess.run(
        [str(python), *_pip_install_args(), "rapidocr-onnxruntime==" + RAPIDOCR_VERSION, "pillow"],
        check=True, timeout=1200,
    )
    RAPIDOCR_MARKER.write_text(RAPIDOCR_VERSION + "\n", encoding="utf-8")


def ensure_engine() -> None:
    """Tesseract 可用则直接用;否则确保 RapidOCR 环境就绪并切入(参数透传)。"""
    if tesseract_ready():
        return
    if rapidocr_available():
        return
    python = runtime_python()
    ready = False
    if RAPIDOCR_MARKER.exists() and python.exists():
        probe = subprocess.run(
            [str(python), "-c", "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('rapidocr_onnxruntime') else 1)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30,
        )
        ready = probe.returncode == 0
    if not ready:
        prepare_runtime()
    # Windows 的 os.execv 不给带空格参数加引号,统一 subprocess 透传。
    result = subprocess.run([str(python), *sys.argv], check=False)
    raise SystemExit(result.returncode)


def keep_detection(text: str, confidence: float) -> bool:
    """与 Tesseract 路径同款过滤:弱置信丢弃、拉丁碎片提高门槛。"""
    if not text or confidence < 30:
        return False
    has_cjk = bool(re.search(r"[\u3400-\u9fff]", text))
    has_digit = bool(re.search(r"[0-9]", text))
    latin_only = bool(re.fullmatch(r"[A-Za-z][A-Za-z .,'’:/+&-]*", text))
    if latin_only and not has_digit and confidence < 55:
        return False
    compact_len = len(re.sub(r"[^A-Za-z0-9\u3400-\u9fff]", "", text))
    if not has_cjk and compact_len <= 2 and confidence < 58:
        return False
    return True


def make_line(text: str, x: int, y: int, right: int, bottom: int, offset_x: int, offset_y: int, confidence: float, context: tuple) -> dict:
    box_height = max(1, int(bottom - y))
    return {
        "text": text,
        "originalText": text,
        "x": max(0, int(x) + offset_x),
        "y": max(0, int(y) + offset_y),
        "width": max(1, int(right - x)),
        "height": box_height,
        "right": max(0, int(right) + offset_x),
        "bottom": max(0, int(bottom) + offset_y),
        "context": context,
        "confidence": round(float(confidence), 1),
        "enabled": True,
        "fontSize": max(12, min(220, int(box_height * 0.92))),
        # Photoshop needs a real PostScript font name.  Default to the
        # commercially-free Alibaba PuHuiTi 3.0; PingFang's license
        # does not cover commercial artwork.
        "fontFamily": "阿里巴巴普惠体 3.0",
        "fontPostScript": "AlibabaPuHuiTi_3_55_Regular",
        "fontWeight": "normal",
        "color": "#111827",
    }


def run_tesseract_lines(image, args, offset_x: int, offset_y: int) -> list[dict]:
    import pytesseract
    from pytesseract import Output

    data = pytesseract.image_to_data(image, lang=args.lang, config=f"--psm {args.psm}", output_type=Output.DICT)
    groups: dict[tuple, dict] = {}
    total = len(data.get("text", []))
    for index in range(total):
        text = clean_text(data["text"][index])
        try:
            confidence = float(data.get("conf", ["-1"] * total)[index])
        except (TypeError, ValueError):
            confidence = -1.0
        if not keep_detection(text, confidence):
            continue
        key = tuple(str(data.get(name, [""] * total)[index]) for name in ("block_num", "par_num", "line_num", "page_num"))
        left = int(data.get("left", [0] * total)[index] or 0)
        top = int(data.get("top", [0] * total)[index] or 0)
        width = int(data.get("width", [0] * total)[index] or 0)
        height = int(data.get("height", [0] * total)[index] or 0)
        item = groups.setdefault(key, {"parts": [], "x": left, "y": top, "right": left + width, "bottom": top + height, "confidence": confidence, "context": key[:2]})
        item["parts"].append(text)
        item["x"] = min(item["x"], left)
        item["y"] = min(item["y"], top)
        item["right"] = max(item["right"], left + width)
        item["bottom"] = max(item["bottom"], top + height)
        item["confidence"] = max(item["confidence"], confidence)
    lines = []
    for item in groups.values():
        text = clean_text(" ".join(item["parts"]))
        if not text or not re.search(r"[A-Za-z0-9\u3400-\u9fff]", text):
            continue
        lines.append(make_line(text, item["x"], item["y"], item["right"], item["bottom"], offset_x, offset_y, item["confidence"], tuple(str(v) for v in item["context"])))
    return lines


def run_rapidocr_lines(image, offset_x: int, offset_y: int) -> list[dict]:
    from rapidocr_onnxruntime import RapidOCR

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as handle:
        temp_path = handle.name
    try:
        image.save(temp_path, format="PNG")
        engine = RapidOCR()
        result, _ = engine(temp_path)
    finally:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
    lines = []
    if not result:
        return lines
    for box, text, score in result:
        confidence = max(0.0, min(100.0, float(score or 0) * 100))
        cleaned = clean_text(text)
        if not keep_detection(cleaned, confidence):
            continue
        xs = [float(point[0]) for point in box]
        ys = [float(point[1]) for point in box]
        lines.append(make_line(cleaned, min(xs), min(ys), max(xs), max(ys), offset_x, offset_y, confidence, ("rapid", "0")))
    return lines


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input")
    parser.add_argument("--lang", default="chi_sim+eng")
    parser.add_argument("--psm", default="11")
    parser.add_argument("--crop", default="", help="optional JSON rectangle in original-image pixels")
    parser.add_argument("--prepare", action="store_true", help="只准备 RapidOCR 运行环境(后台预置)")
    parser.add_argument('--spec', default=None, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if getattr(args, 'spec', None):
        # 沙箱 runner 对含空格参数的传递不可靠(Windows 实测):参数走临时 JSON,argv 只留一个 ASCII 路径。
        spec_path = Path(args.spec)
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
        if args.prepare:
            prepare_runtime()
            print(json.dumps({"ok": True, "prepared": True}, ensure_ascii=False), flush=True)
            return 0
        from PIL import Image

        image_path = Path(args.input)
        if not image_path.is_file() or image_path.stat().st_size <= 0:
            raise RuntimeError("OCR 输入图片不存在或为空")
        ensure_engine()
        image = Image.open(image_path).convert("RGB")
        original_width, original_height = image.size
        offset_x = 0
        offset_y = 0
        crop_info = None
        if args.crop:
            try:
                raw_crop = json.loads(args.crop)
            except json.JSONDecodeError as exc:
                raise RuntimeError("框选区域无效") from exc
            if not isinstance(raw_crop, dict):
                raise RuntimeError("框选区域无效")
            left = max(0, min(original_width - 1, int(round(float(raw_crop.get("x", 0) or 0)))))
            top = max(0, min(original_height - 1, int(round(float(raw_crop.get("y", 0) or 0)))))
            right = max(left + 1, min(original_width, int(round(left + float(raw_crop.get("width", 0) or 0)))))
            bottom = max(top + 1, min(original_height, int(round(top + float(raw_crop.get("height", 0) or 0)))))
            if right - left < 6 or bottom - top < 6:
                raise RuntimeError("框选区域太小")
            offset_x, offset_y = left, top
            crop_info = {"x": left, "y": top, "width": right - left, "height": bottom - top}
            image = image.crop((left, top, right, bottom))

        if tesseract_ready():
            lines = run_tesseract_lines(image, args, offset_x, offset_y)
        else:
            lines = run_rapidocr_lines(image, offset_x, offset_y)

        # 同基线几何合并:一行被拆成多个检测结果时按行距/间距合回,
        # 保持真实多行不被误并(与历史行为一致)。
        lines.sort(key=lambda item: (item["y"], item["x"]))
        merged_lines = []
        for item in lines:
            if not merged_lines:
                merged_lines.append(item)
                continue
            previous = merged_lines[-1]
            previous_height = max(1, int(previous["height"]))
            current_height = max(1, int(item["height"]))
            max_height = max(previous_height, current_height)
            overlap = max(0, min(previous["bottom"], item["bottom"]) - max(previous["y"], item["y"]))
            overlap_ratio = overlap / max(1, min(previous_height, current_height))
            center_delta = abs((previous["y"] + previous["bottom"]) / 2 - (item["y"] + item["bottom"]) / 2)
            same_row = overlap_ratio >= 0.45 or center_delta <= max_height * 0.45
            left_item, right_item = (previous, item) if previous["x"] <= item["x"] else (item, previous)
            horizontal_gap = max(0, int(right_item["x"] - left_item["right"]))
            near = horizontal_gap <= max(96, int(max_height * 4))
            same_context = previous.get("context") == item.get("context")
            if same_row and near and (same_context or overlap_ratio >= 0.62):
                previous["text"] = clean_text(previous["text"] + " " + item["text"])
                previous["originalText"] = previous["text"]
                previous["x"] = min(previous["x"], item["x"])
                previous["y"] = min(previous["y"], item["y"])
                previous["right"] = max(previous["right"], item["right"])
                previous["bottom"] = max(previous["bottom"], item["bottom"])
                previous["width"] = max(1, int(previous["right"] - previous["x"]))
                previous["height"] = max(1, int(previous["bottom"] - previous["y"]))
                previous["confidence"] = max(previous["confidence"], item["confidence"])
                previous["fontSize"] = max(12, min(220, int(previous["height"] * 0.92)))
            else:
                merged_lines.append(item)

        blocks = []
        for index, item in enumerate(merged_lines):
            item.pop("right", None)
            item.pop("bottom", None)
            item.pop("context", None)
            item["id"] = f"ocr-{index + 1}"
            blocks.append(item)
        result = {"success": True, "width": original_width, "height": original_height, "blocks": blocks[:200]}
        if crop_info:
            result["crop"] = crop_info
        _out = getattr(args, 'result_output', None)
        if _out:
            try:
                from pathlib import Path as _P2
                _P2(_out).write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
            except Exception:
                pass
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:  # pragma: no cover - surfaced to host/UI
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
