#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地位图转 SVG 的轻量 harness。

VTracer 与 Vecto 都是确定性的本地程序，不是模型。脚本只负责：
1. 计算图片复杂度；2. 检测可用后端；3. auto 模式按复杂度选择；4. 统一输出 JSON。

适配器不会把图片上传到云端。彩色扁平稿优先使用 ImageTracerJS（纯 JS、
Unlicense、按需安装到隔离目录）；VTracer 优先使用官方 Python 扩展，
其次使用官方 CLI；Vecto 使用其官方 CLI（``vecto trace input -o output``）。
"""

from __future__ import annotations

import argparse
from io import BytesIO
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any


RASTER_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"}
VTRACER_VERSION = "0.6.15"
VTRACER_RUNTIME = Path.home() / ".dsh" / "canvas-workbench" / "vtracer-runtime"
VTRACER_MARKER = VTRACER_RUNTIME / ("vtracer-" + VTRACER_VERSION + ".ready")
VECTO_RUNTIME = Path.home() / ".dsh" / "canvas-workbench" / "vecto-runtime" / ("vecto.exe" if os.name == "nt" else "vecto")
DOTNET_RUNTIME = Path.home() / ".dsh" / "canvas-workbench" / "dotnet-runtime"
IMAGETRACER_VERSION = "1.2.6"
IMAGETRACER_RUNTIME = Path.home() / ".dsh" / "canvas-workbench" / "imagetracer-runtime"
VECTOR_MODES = {"auto", "flat", "full", "silhouette"}


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def fail(message: str, **extra: Any) -> int:
    emit({"success": False, "error": message, **extra})
    return 1


def find_executable(names: list[str]) -> str:
    for name in names:
        if name in ("vecto", "vecto.exe") and VECTO_RUNTIME.exists() and os.access(VECTO_RUNTIME, os.X_OK) and (os.name == "nt" or shutil.which("dotnet") or (DOTNET_RUNTIME / "dotnet").exists()):
            candidate = str(VECTO_RUNTIME)
            if probe_vecto(candidate):
                return candidate
        found = shutil.which(name)
        if found and name in ("vecto", "vecto.exe") and os.name != "nt" and not (shutil.which("dotnet") or (DOTNET_RUNTIME / "dotnet").exists()):
            continue
        if found and name in ("vecto", "vecto.exe") and not probe_vecto(found):
            continue
        if found:
            return found
    return ""


def probe_vecto(executable: str) -> bool:
    """Vecto 的 macOS 发布包可能是 framework-dependent apphost。

    启动一次帮助命令可提前发现缺少 .NET/损坏二进制，避免点击“转矢量”
    后才生成空文件。探测严格限时且不读取用户文件。
    """
    try:
        env = os.environ.copy()
        if os.name != "nt" and (DOTNET_RUNTIME / "dotnet").exists():
            env["DOTNET_ROOT"] = str(DOTNET_RUNTIME)
            env["PATH"] = str(DOTNET_RUNTIME) + os.pathsep + env.get("PATH", "")
        result = subprocess.run([executable, "--help"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8, env=env)
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def runtime_python() -> Path:
    if os.name == "nt":
        return VTRACER_RUNTIME / "Scripts" / "python.exe"
    return VTRACER_RUNTIME / "bin" / "python"


def imagetracer_cli() -> Path:
    return IMAGETRACER_RUNTIME / "node_modules" / "imagetracerjs" / "nodecli" / "nodecli.js"


def ensure_imagetracer_runtime() -> None:
    """准备 ImageTracerJS 隔离运行时。

    ImageTracerJS 是纯 JavaScript、Unlicense 的本地矢量化器，适合颜色较少
    的卡通和信息图。只在本次判定为扁平稿时按需安装到 ``~/.dsh``，不污染
    DSH 自带 Node，也不把 npm 依赖复制进插件目录。
    """
    cli = imagetracer_cli()
    if cli.exists():
        return
    npm = shutil.which("npm")
    if not npm:
        raise RuntimeError("未找到 npm，无法准备 ImageTracerJS")
    IMAGETRACER_RUNTIME.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [npm, "install", "--prefix", str(IMAGETRACER_RUNTIME), "--no-package-lock", "--ignore-scripts", "--no-audit", "--no-fund", "imagetracerjs@" + IMAGETRACER_VERSION],
        check=True,
        timeout=180,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if not cli.exists():
        raise RuntimeError("ImageTracerJS 安装后缺少 nodecli.js")


def ensure_vtracer_runtime(skip_if_vecto: bool = True) -> None:
    """首次没有任何后端时自动准备一个隔离的 VTracer Python 运行时。

    Vecto 是独立 CLI，不适合用 pip 静默替代；如果用户已经安装 Vecto，
    则不下载 VTracer，避免浪费磁盘和网络。
    """
    in_runtime = False
    try:
        in_runtime = runtime_python().resolve() == Path(sys.executable).resolve()
    except OSError:
        pass
    if importlib.util.find_spec("vtracer") or find_executable(["vtracer"]):
        # 复杂度评估使用 Pillow；只在隔离的 VTracer 环境中补齐，绝不污染系统 Python。
        if in_runtime and importlib.util.find_spec("PIL") is None:
            subprocess.run([str(runtime_python()), "-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", "--timeout", "120", "pillow"], check=True, timeout=180)
        return
    if skip_if_vecto and find_executable(["vecto", "vecto.exe"]):
        return
    python = runtime_python()
    if not VTRACER_MARKER.exists() or not python.exists():
        VTRACER_RUNTIME.mkdir(parents=True, exist_ok=True)
        if not python.exists():
            subprocess.run([sys.executable, "-m", "venv", str(VTRACER_RUNTIME)], check=True, timeout=120)
        install_cmd = [str(python), "-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", "--timeout", "120"]
        pip_index = os.environ.get("DSH_PIP_INDEX", "").strip()
        if pip_index:
            install_cmd += ["-i", pip_index]
        subprocess.run(install_cmd + ["vtracer==" + VTRACER_VERSION, "pillow"], check=True, timeout=300)
        VTRACER_MARKER.write_text(VTRACER_VERSION + "\n", encoding="utf-8")
    # 让后续 import 与依赖都在隔离环境中运行。
    # Windows 的 os.execv 不给带空格参数加引号,改 subprocess 透传(同 remove_background)。
    result = subprocess.run([str(python), *sys.argv], check=False)
    raise SystemExit(result.returncode)


def image_complexity(path: Path) -> dict[str, Any]:
    """返回可解释的轻量复杂度指标，不把失败变成不可用。"""
    try:
        from PIL import Image, ImageFilter, ImageStat

        with Image.open(path) as original:
            image = original.convert("RGB")
            width, height = image.size
            sample = image.copy()
            sample.thumbnail((256, 256), Image.Resampling.BILINEAR)
            pixels = list(sample.getdata())
            # 量化后估算颜色数量，避免对高分辨率图像分配巨大的集合。
            quantized = {(r // 16, g // 16, b // 16) for r, g, b in pixels}
            colors = len(quantized)
            # 用无抖动限色后的前四个颜色覆盖率估计“扁平稿”。
            # 这比原始抗锯齿颜色数更可靠，也能识别蓝白海报和 Logo。
            palette = sample.quantize(colors=8, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
            histogram = sorted(palette.histogram(), reverse=True)
            flat_coverage = sum(histogram[:4]) / max(1, sum(histogram))
            edges = sample.filter(ImageFilter.FIND_EDGES)
            gray = edges.convert("L")
            values = list(gray.getdata())
            edge_density = sum(1 for value in values if value >= 48) / max(1, len(values))
            stat = ImageStat.Stat(sample.convert("L"))
            contrast = min(1.0, float(stat.stddev[0]) / 96.0)
            # 颜色、边缘与对比度共同决定“照片/复杂插画”程度。
            score = min(1.0, 0.52 * min(1.0, colors / 280.0) + 0.34 * edge_density + 0.14 * contrast)
            return {
                "width": width,
                "height": height,
                "pixels": width * height,
                "estimatedColors": colors,
                "flatCoverage": round(flat_coverage, 4),
                "flatSuitability": round(min(1.0, max(0.0, (flat_coverage - 0.62) / 0.34)), 4),
                "edgeDensity": round(edge_density, 4),
                "contrast": round(contrast, 4),
                "score": round(score, 4),
                "class": "complex" if score >= 0.34 else "simple",
            }
    except Exception as exc:
        size = path.stat().st_size if path.exists() else 0
        # 没有 Pillow 时仍可完成后端检测；保守地选择 VTracer。
        return {"pixels": 0, "bytes": size, "score": 0.5, "class": "complex", "metricError": str(exc)}


def installed_backends() -> dict[str, dict[str, Any]]:
    vtracer_cli = find_executable(["vtracer"])
    vecto_cli = find_executable(["vecto", "vecto.exe"])
    return {
        "imagetracer": {
            "available": bool(shutil.which("node") and imagetracer_cli().exists()),
            "python": False,
            "cli": str(imagetracer_cli()) if imagetracer_cli().exists() else None,
        },
        "vtracer": {
            "available": bool(vtracer_cli or importlib.util.find_spec("vtracer")),
            "python": bool(importlib.util.find_spec("vtracer")),
            "cli": vtracer_cli or None,
        },
        "vecto": {
            "available": bool(vecto_cli),
            "python": False,
            "cli": vecto_cli or None,
        },
    }


def choose_backend(requested: str, complexity: dict[str, Any], available: dict[str, dict[str, Any]], vector_mode: str = "auto") -> tuple[str, str]:
    if requested in ("imagetracer", "vtracer", "vecto"):
        if available[requested]["available"]:
            return requested, "用户指定后端"
        raise RuntimeError(requested + " 未安装或不在 PATH 中")
    if requested != "auto":
        raise RuntimeError("backend 只能是 auto、imagetracer、vtracer 或 vecto")
    # 彩色卡通/信息图优先 ImageTracerJS：它保留更多局部颜色和小块；VTracer
    # 仍负责照片、复杂渐变和轮廓稿；Vecto 作为可用时的几何拟合后备。
    if vector_mode == "flat":
        preferences = ["imagetracer", "vtracer", "vecto"]
    elif vector_mode == "silhouette":
        preferences = ["vtracer", "imagetracer", "vecto"]
    else:
        preferences = ["vtracer", "vecto", "imagetracer"]
    for candidate in preferences:
        if available.get(candidate, {}).get("available"):
            return candidate, "复杂度为" + str(complexity.get("class")) + "，优先" + candidate
    raise RuntimeError("未检测到 ImageTracerJS、VTracer 或 Vecto。请先安装一个本地后端后重试")


def choose_vector_mode(requested: str, complexity: dict[str, Any]) -> tuple[str, str]:
    if requested != "auto":
        return requested, "用户指定模式"
    suitability = float(complexity.get("flatSuitability", 0.0) or 0.0)
    # 截图常带黑色画布边缘，会把整体对比度抬高、拉低 suitability；只要
    # 主色覆盖率足够高且颜色数量仍有限，仍按扁平插画处理，避免误走全量模式。
    if suitability >= 0.68 or (
        float(complexity.get("flatCoverage", 0.0) or 0.0) >= 0.78
        and int(complexity.get("estimatedColors", 9999) or 9999) <= 220
        and float(complexity.get("edgeDensity", 1.0) or 1.0) <= 0.18
    ):
        return "flat", "检测到低色彩扁平版式，使用结构化模式"
    if float(complexity.get("edgeDensity", 0.0) or 0.0) >= 0.32:
        return "silhouette", "图像边缘复杂，使用主体轮廓模式"
    return "full", "未检测到明显扁平版式，使用全量模式"


def _svg_text(value: Any) -> str:
    """统一校验 VTracer 返回值，避免把错误对象写成空 SVG。"""
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if not isinstance(value, str) or not value.lstrip().startswith("<"):
        raise RuntimeError("VTracer 未返回有效 SVG")
    return value


def _normalise_png(image_bytes: bytes) -> tuple[bytes, tuple[int, int]]:
    """把特殊编码/色彩模式转成 VTracer 稳定可读的标准 PNG。

    raw API 对部分带 ICC、调色板或浏览器导出的图片会直接抛出
    ``Failed to decode img_bytes``。先由 Pillow 完整解码并重新编码，可
    保留透明通道，同时避免把原始文件改写到项目目录。
    """
    from PIL import Image

    with Image.open(BytesIO(image_bytes)) as original:
        original.load()
        has_alpha = original.mode in ("RGBA", "LA", "PA") or "transparency" in original.info
        image = original.convert("RGBA" if has_alpha else "RGB")
        output = BytesIO()
        image.save(output, format="PNG", optimize=False)
        return output.getvalue(), image.size


def _normalise_flat_png(image_bytes: bytes) -> tuple[bytes, tuple[int, int], int]:
    """为蓝白版式、Logo 和信息图准备稳定的限色输入。

    这一步不是把图变成黑白，而是关闭抖动并把抗锯齿产生的近似颜色
    合并到有限调色板，避免 VTracer 为每个边缘过渡创建独立碎片。
    """
    from PIL import Image

    with Image.open(BytesIO(image_bytes)) as original:
        original.load()
        has_alpha = original.mode in ("RGBA", "LA", "PA") or "transparency" in original.info
        image = original.convert("RGBA" if has_alpha else "RGB")
        rgb = image.convert("RGB")
        # 企业蓝白稿一般只需要 6～8 个颜色；保留少量灰/黑色以兼容正文和阴影。
        quantized = rgb.quantize(colors=8, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert("RGB")
        output = BytesIO()
        if has_alpha:
            alpha = image.getchannel("A")
            result = quantized.convert("RGBA")
            result.putalpha(alpha)
            result.save(output, format="PNG", optimize=False)
        else:
            quantized.save(output, format="PNG", optimize=False)
        return output.getvalue(), image.size, 8


def _write_svg(output: Path, value: Any) -> None:
    output.write_text(_svg_text(value), encoding="utf-8")


def vector_quality(output: Path, vector_mode: str) -> dict[str, Any]:
    """给调用方一个可解释的结果摘要，不把“成功生成”误报成“文字可编辑”。

    位图转 SVG 能稳定还原的是色块、轮廓和几何关系；小字号文字仍会被当作
    像素轮廓处理。因此把路径数量、文件体积和模式提示一起返回，供画布显示
    轻量反馈，也方便后续按复杂度继续优化，而不是静默生成一张难以编辑的图。
    """
    text = output.read_text(encoding="utf-8", errors="replace")
    path_count = text.count("<path")
    shape_count = sum(text.count("<" + tag) for tag in ("rect", "circle", "ellipse", "polygon", "polyline", "line"))
    warnings: list[str] = []
    if vector_mode == "flat":
        warnings.append("结构化模式适合色块、Logo 和线条；小字号文字建议保留原图或 AI/PDF 源文件")
    elif vector_mode == "full" and path_count > 3000:
        warnings.append("全量模式路径较多，适合展示和缩放；若要继续编辑，建议使用 AI/PDF 源文件")
    elif vector_mode == "silhouette":
        warnings.append("轮廓模式只保留主体边界，不保证内部文字和细节")
    return {
        "svgBytes": output.stat().st_size,
        "pathCount": path_count,
        "shapeCount": shape_count,
        "warnings": warnings,
    }


def run_vtracer(path: Path, output: Path, info: dict[str, Any], vector_mode: str = "auto") -> str:
    module = importlib.util.find_spec("vtracer")
    if module:
        import vtracer  # type: ignore

        # 0.6.x 的 Python 扩展同时提供“按路径”和“按字节”两套接口。
        # 按路径的 Rust API 在 DSH 子进程、临时目录或包含非 ASCII 字符的路径
        # 下偶尔会报 `No image file found at specified input path`，即使 Python
        # 本身已经可以看到该文件。优先把已存在的文件读成字节交给扩展，绕过
        # 这层重复的路径解析；这样也能让画布传入的临时图片与原图走同一条链路。
        if vector_mode == "flat":
            options = {
                "colormode": "color",
                "hierarchical": "cutout",
                "mode": "polygon",
                "filter_speckle": 8,
                "color_precision": 5,
                "path_precision": 2,
                "corner_threshold": 45,
                "splice_threshold": 45,
            }
        elif vector_mode == "silhouette":
            options = {
                "colormode": "bw",
                "hierarchical": "cutout",
                "mode": "spline",
                "filter_speckle": 12,
                "path_precision": 2,
            }
        else:
            options = {
                "colormode": "color",
                "hierarchical": "stacked",
                "mode": "spline",
                "filter_speckle": 4,
                "color_precision": 6,
                "path_precision": 3,
            }
        raw_converter = getattr(vtracer, "convert_raw_image_to_svg", None)
        if callable(raw_converter):
            image_bytes = path.read_bytes()
            if not image_bytes:
                raise RuntimeError("输入图片为空")
            if vector_mode == "flat":
                image_bytes, _, _ = _normalise_flat_png(image_bytes)
            raw_error: BaseException | None = None
            try:
                _write_svg(output, raw_converter(image_bytes, **options))
                return "vtracer-python-raw"
            except BaseException as exc:
                # pyo3 的 PanicException 不一定继承 Exception；不要立刻终止，
                # 先走标准 PNG 兜底。这样可修复部分“能被浏览器显示但 raw API
                # 无法解码”的图片。
                raw_error = exc

            try:
                normalised, _ = _normalise_png(image_bytes)
            except BaseException as exc:
                detail = str(raw_error or exc).strip() or type(raw_error or exc).__name__
                raise RuntimeError("VTracer 读取图片失败：" + detail) from exc

            try:
                _write_svg(output, raw_converter(normalised, **options))
                return "vtracer-python-raw-normalized"
            except BaseException as normalised_error:
                # 0.6.x 仍暴露按路径 API；把标准化 PNG 放到 ASCII 临时目录后
                # 再尝试一次，规避 raw API 与 Rust decoder 的兼容性差异。
                path_converter = getattr(vtracer, "convert_image_to_svg_py", None)
                if callable(path_converter):
                    try:
                        with tempfile.TemporaryDirectory(prefix="dsh-vtracer-") as temp_dir:
                            normalised_path = Path(temp_dir) / "input.png"
                            normalised_path.write_bytes(normalised)
                            # convert_image_to_svg_py 直接写入 out_path，返回值为 None。
                            path_converter(str(normalised_path), str(output), **options)
                            if not output.exists() or output.stat().st_size == 0:
                                raise RuntimeError("VTracer 未生成有效 SVG")
                        return "vtracer-python-path-normalized"
                    except BaseException as path_error:
                        normalised_error = path_error
                detail = str(normalised_error).strip() or type(normalised_error).__name__
                original_detail = str(raw_error).strip() if raw_error else ""
                if original_detail and original_detail != detail:
                    detail = original_detail + "；标准化后仍失败：" + detail
                raise RuntimeError("VTracer 读取图片失败：" + detail) from normalised_error

        if hasattr(vtracer, "Config"):
            # VTracer 1.x 官方 Python API；按复杂度减少复杂图片的节点数量。
            if info.get("class") == "simple":
                config = vtracer.Config(mode="polygon", hierarchical="cutout")
                if hasattr(config, "max_colors"):
                    config.max_colors = 32
            else:
                poster = getattr(vtracer.Config, "poster", None)
                config = poster() if callable(poster) else vtracer.Config(mode="spline", hierarchical="stacked")
                if hasattr(config, "max_colors"):
                    config.max_colors = 64
            config.convert_file(str(path), str(output))
        elif hasattr(vtracer, "convert_file"):
            vtracer.convert_file(str(path), str(output))
        elif hasattr(vtracer, "convert_image_to_svg_py"):
            vtracer.convert_image_to_svg_py(str(path), str(output), **options)
        else:
            raise RuntimeError("当前 VTracer Python 扩展缺少可识别的转换 API")
        return "vtracer-python"
    executable = find_executable(["vtracer"])
    if not executable:
        raise RuntimeError("VTracer 不可用")
    args = [executable, str(path), str(output), "--hierarchical", "cutout", "--mode", "polygon", "--optimize", "2"]
    if info.get("class") == "complex":
        args = [executable, str(path), str(output), "--preset", "photo", "--optimize", "2"]
    subprocess.run(args, check=True, timeout=180, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    return "vtracer-cli"


def run_imagetracer(path: Path, output: Path, info: dict[str, Any], vector_mode: str = "flat") -> str:
    """用 ImageTracerJS 处理彩色卡通/信息图。

    它的颜色量化和分层策略与 VTracer 不同，尤其适合用户这类有限色彩的
    插画：保留腮红、眼睛、围巾和小装饰等局部色块，再用二次曲线拟合边缘。
    输入先统一成 PNG，避开 nodecli 对 JPEG/WebP 解码器的差异。
    """
    node = shutil.which("node")
    cli = imagetracer_cli()
    if not node or not cli.exists():
        raise RuntimeError("ImageTracerJS 不可用")
    normalised, _ = _normalise_png(path.read_bytes())
    colors = 24 if vector_mode == "flat" else 32
    pathomit = 2 if vector_mode == "flat" else 1
    with tempfile.TemporaryDirectory(prefix="dsh-imagetracer-") as temp_dir:
        input_path = Path(temp_dir) / "input.png"
        input_path.write_bytes(normalised)
        args = [
            node,
            str(cli),
            str(input_path),
            "-outfilename",
            str(output),
            "colorsampling",
            "2",
            "numberofcolors",
            str(colors),
            "colorquantcycles",
            "3",
            "pathomit",
            str(pathomit),
            "ltres",
            "0.5",
            "qtres",
            "0.5",
            "layering",
            "0",
            "roundcoords",
            "2",
            "rightangleenhance",
            "true",
            "linefilter",
            "false",
        ]
        subprocess.run(args, check=True, timeout=240, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if not output.exists() or output.stat().st_size == 0:
        raise RuntimeError("ImageTracerJS 未生成有效 SVG")
    return "imagetracerjs-nodecli"


def run_vecto(path: Path, output: Path, info: dict[str, Any], vector_mode: str = "auto") -> str:
    executable = find_executable(["vecto", "vecto.exe"])
    if not executable:
        raise RuntimeError("Vecto CLI 不可用")
    trace_path = path
    temp_dir = None
    if vector_mode == "flat":
        try:
            normalised, _, _ = _normalise_flat_png(path.read_bytes())
            temp_dir = tempfile.TemporaryDirectory(prefix="dsh-vecto-flat-")
            trace_path = Path(temp_dir.name) / "input.png"
            trace_path.write_bytes(normalised)
        except Exception:
            trace_path = path
    args = [executable, "trace", str(trace_path), "-o", str(output)]
    # Vecto 的 --style photo / --colors 选项在其 CLI 中可用；复杂图不强行几何简化。
    if info.get("class") == "complex":
        args.extend(["--style", "photo", "--colors", "32"])
    env = os.environ.copy()
    if os.name != "nt" and (DOTNET_RUNTIME / "dotnet").exists():
        env["DOTNET_ROOT"] = str(DOTNET_RUNTIME)
        env["PATH"] = str(DOTNET_RUNTIME) + os.pathsep + env.get("PATH", "")
    try:
        subprocess.run(args, check=True, timeout=180, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
        return "vecto-cli"
    finally:
        if temp_dir is not None:
            temp_dir.cleanup()


def prepare_runtime() -> None:
    """后台预置:确保 vtracer 隔离 venv 就绪(不 exec 重入、不推理)。"""
    if importlib.util.find_spec("vtracer") or find_executable(["vtracer"]):
        return
    python = runtime_python()
    if VTRACER_MARKER.exists() and python.exists():
        probe = subprocess.run(
            [str(python), "-c", "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('vtracer') else 1)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
        )
        if probe.returncode == 0:
            return
    VTRACER_RUNTIME.mkdir(parents=True, exist_ok=True)
    if not python.exists():
        subprocess.run([sys.executable, "-m", "venv", str(VTRACER_RUNTIME)], check=True, timeout=120)
    install_cmd = [str(python), "-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", "--timeout", "120"]
    pip_index = os.environ.get("DSH_PIP_INDEX", "").strip()
    if pip_index:
        install_cmd += ["-i", pip_index]
    subprocess.run(install_cmd + ["vtracer==" + VTRACER_VERSION, "pillow"], check=True, timeout=300)
    VTRACER_MARKER.write_text(VTRACER_VERSION + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--backend", choices=["auto", "imagetracer", "vtracer", "vecto"], default="auto")
    parser.add_argument("--vector-mode", choices=sorted(VECTOR_MODES), default="auto")
    parser.add_argument("--prepare", action="store_true", help="只准备 vtracer 运行环境(后台预置)")
    args = parser.parse_args()
    if args.prepare:
        prepare_runtime()
        print(json.dumps({"ok": True, "prepared": True}, ensure_ascii=False), flush=True)
        return 0
    if not args.input or not args.output:
        return fail("缺少 --input/--output")
    if not args.input.exists() or not args.input.is_file():
        return fail("输入图片不存在")
    if args.input.suffix.lower().lstrip(".") not in RASTER_EXTENSIONS:
        return fail("仅支持 PNG/JPG/WebP/GIF/AVIF/BMP 栅格图片")
    info = image_complexity(args.input)
    effective_mode, mode_reason = choose_vector_mode(args.vector_mode, info)
    # 扁平稿优先准备 ImageTracerJS；安装失败时自动回退到 VTracer，不影响已有流程。
    imagetracer_error = ""
    if effective_mode == "flat" and args.backend in ("auto", "imagetracer"):
        try:
            ensure_imagetracer_runtime()
        except (OSError, subprocess.SubprocessError, RuntimeError) as exc:
            imagetracer_error = str(exc)
            if args.backend == "imagetracer":
                return fail("自动准备 ImageTracerJS 失败：" + imagetracer_error)

    partial_available = installed_backends()
    need_vtracer = args.backend == "vtracer" or (
        args.backend == "auto" and not (effective_mode == "flat" and partial_available.get("imagetracer", {}).get("available"))
    )
    if need_vtracer:
        try:
            ensure_vtracer_runtime(skip_if_vecto=args.backend == "auto")
        except (OSError, subprocess.SubprocessError) as exc:
            # 先给出可操作的检测结果；如果 Vecto 已存在则仍可继续。
            if not find_executable(["vecto", "vecto.exe"]):
                return fail("自动准备 VTracer 失败：" + str(exc) + "；也可以手动安装 vtracer 或 Vecto CLI")
    available = installed_backends()
    try:
        backend, reason = choose_backend(args.backend, info, available, effective_mode)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        if backend == "imagetracer":
            engine = run_imagetracer(args.input, args.output, info, effective_mode)
        elif backend == "vtracer":
            engine = run_vtracer(args.input, args.output, info, effective_mode)
        else:
            engine = run_vecto(args.input, args.output, info, effective_mode)
        if not args.output.exists() or args.output.stat().st_size == 0:
            raise RuntimeError(backend + " 未生成 SVG")
        quality = vector_quality(args.output, effective_mode)
        if imagetracer_error:
            reason += "；ImageTracerJS 不可用，已回退"
        emit({"success": True, "backend": backend, "engine": engine, "vectorMode": effective_mode, "reason": mode_reason + "；" + reason, "complexity": info, "quality": quality, "available": available, "output": str(args.output)})
        return 0
    except (RuntimeError, subprocess.SubprocessError, OSError) as exc:
        return fail(str(exc), backend=args.backend, vectorMode=args.vector_mode, complexity=info, available=available)


if __name__ == "__main__":
    raise SystemExit(main())
