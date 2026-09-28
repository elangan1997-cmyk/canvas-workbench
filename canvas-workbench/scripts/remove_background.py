#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地 rembg 背景移除。

完整安装包会预置 rembg[cpu] 与 isnet-general-use ONNX 模型；开发版未预置时，
才会在用户目录创建隔离环境并按需下载。模型与依赖不会写入画布项目。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
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

import subprocess
import sys
import time


REMBG_VERSION = "2.0.61"
RUNTIME_ROOT = Path.home() / ".dsh" / "canvas-workbench" / "rembg-runtime"
MODEL_ROOT = Path.home() / ".dsh" / "canvas-workbench" / "rembg-models"
MODEL_URL = os.environ.get("DSH_REMBG_MODEL_URL", "https://github.com/danielgatis/rembg/releases/download/v0.0.0/isnet-general-use.onnx")
MARKER = RUNTIME_ROOT / ("rembg-" + REMBG_VERSION + ".ready")
PROGRESS_PATH: Path | None = None


def emit_progress(stage: str, message: str, percent: int | None = None) -> None:
    """写入可轮询的进度文件，同时保留一行 JSON 日志供宿主诊断。"""
    payload = {
        "ok": True,
        "stage": stage,
        "message": message,
        "percent": percent,
        "updatedAt": time.time(),
    }
    if PROGRESS_PATH:
        try:
            PROGRESS_PATH.parent.mkdir(parents=True, exist_ok=True)
            temporary = PROGRESS_PATH.with_name(PROGRESS_PATH.name + ".tmp-" + str(os.getpid()))
            temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            temporary.replace(PROGRESS_PATH)
        except OSError:
            # 进度展示不能影响实际去背景任务。
            pass
    print(json.dumps({"progress": True, **payload}, ensure_ascii=False), flush=True)


def runtime_python() -> Path:
    if os.name == "nt":
        return RUNTIME_ROOT / "Scripts" / "python.exe"
    return RUNTIME_ROOT / "bin" / "python"


def run_checked(argv: list[str], label: str) -> None:
    try:
        subprocess.run(argv, check=True, timeout=900)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(label + "超时，请检查网络后重试") from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(label + "失败（退出码 " + str(exc.returncode) + "）") from exc


PIP_INDEX_URL = os.environ.get("DSH_PIP_INDEX", "").strip()


def pip_install_args() -> list[str]:
    args = ["-m", "pip", "install", "--disable-pip-version-check", "--prefer-binary", "--timeout", "120"]
    if PIP_INDEX_URL:
        args += ["-i", PIP_INDEX_URL]
    return args


def install_runtime() -> Path:
    python = runtime_python()
    RUNTIME_ROOT.mkdir(parents=True, exist_ok=True)
    if not python.exists():
        emit_progress("environment", "正在创建 rembg 隔离运行环境", 8)
        run_checked([sys.executable, "-m", "venv", str(RUNTIME_ROOT)], "创建 rembg 虚拟环境")
    emit_progress("environment", "正在安装 rembg 本地依赖", 18)
    run_checked(
        [
            str(python),
            *pip_install_args(),
            "rembg[cpu]==" + REMBG_VERSION,
        ],
        "安装 rembg 本地运行环境",
    )
    MARKER.write_text(REMBG_VERSION + "\n", encoding="utf-8")
    emit_progress("environment", "rembg 运行环境准备完成", 45)
    return python


def ensure_runtime_no_exec() -> None:
    """prepare 模式:确保隔离 venv 存在(由当前解释器直接调用 install_runtime)。"""
    if importlib.util.find_spec("rembg") is not None:
        return
    python = runtime_python()
    if MARKER.exists() and python.exists():
        probe = subprocess.run(
            [str(python), "-c", "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('rembg') else 1)"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
        )
        if probe.returncode == 0:
            return
    install_runtime()


def prepare_model() -> None:
    """预下载 isnet 模型到 REMBG_HOME(pooch 之后按文件命中缓存,不再联网)。"""
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("REMBG_HOME", str(MODEL_ROOT))
    os.environ.setdefault("U2NET_HOME", str(MODEL_ROOT))
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    emit_progress("model", "正在预下载 isnet-general-use 模型", 55)
    try:
        import pooch  # type: ignore
        pooch.retrieve(
            url=MODEL_URL,
            known_hash=None,
            fname="isnet-general-use.onnx",
            path=str(MODEL_ROOT),
            progressbar=False,
        )
        emit_progress("model", "模型预下载完成", 85)
    except Exception as exc:  # noqa: BLE001 - 预下载失败不致命,首次使用时会再试
        emit_progress("model", "模型预下载失败(首次使用时会重试): " + str(exc)[:120], 55)


def ensure_runtime() -> None:
    """当前解释器已有 rembg 时直接使用，否则切换到隔离 venv。"""
    if importlib.util.find_spec("rembg") is not None:
        emit_progress("environment", "已检测到 rembg 运行环境", 45)
        return
    python = runtime_python()
    venv_ready = False
    if MARKER.exists() and python.exists():
        # 这里只检查模块是否可发现，不直接 import rembg。rembg 会连带加载
        # numpy/scipy/onnxruntime，首次冷启动可能接近 30 秒，旧探测会误超时。
        probe = subprocess.run(
            [str(python), "-c", "import importlib.util; raise SystemExit(0 if importlib.util.find_spec('rembg') else 1)"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
        venv_ready = probe.returncode == 0
    if not venv_ready:
        python = install_runtime()
    else:
        emit_progress("environment", "已复用本地 rembg 运行环境", 45)
    # 重新进入 venv，避免系统 Python 与 rembg 依赖混用。
    # 不要用 Path.resolve() 比较：macOS venv 的 bin/python 通常是指向
    # 系统解释器的符号链接，resolve 后会和当前解释器看起来完全相同，
    # 但实际启动路径仍决定了 Python 是否加载 venv 的 site-packages。
    current_executable = os.path.normpath(os.path.abspath(sys.executable))
    runtime_executable = os.path.normpath(os.path.abspath(str(python)))
    if current_executable != runtime_executable:
        # Windows 的 os.execv 拼命令行不加引号,路径带空格时参数被拆碎(argparse usage 报错);
        # 统一改 subprocess 透传参数与退出码。
        result = subprocess.run([str(python), *sys.argv], check=False)
        raise SystemExit(result.returncode)


class ModelDownloadProgress:
    """把 pooch 下载器的字节回调转成前端可显示的模型下载进度。"""

    def __init__(self) -> None:
        self.total = 0
        self.downloaded = 0
        self.last_reported = -1
        self.last_report_at = 0.0

    def update(self, amount: int) -> None:
        self.downloaded += max(0, int(amount or 0))
        if not self.total:
            return
        # 环境准备占 0-45%，模型下载占 55-85%，模型加载/推理随后进入 88%。
        ratio = min(1.0, self.downloaded / max(1, int(self.total)))
        percent = min(84, 55 + int(ratio * 29))
        now = time.monotonic()
        if percent == self.last_reported or (now - self.last_report_at < 0.2 and percent < 84):
            return
        self.last_reported = percent
        self.last_report_at = now
        emit_progress("model", "正在下载 isnet-general-use 模型（" + str(percent) + "%）", percent)

    def reset(self) -> None:
        # pooch 下载完成后会调用 reset，再 update(total)；不要让进度回退。
        return

    def close(self) -> None:
        emit_progress("model", "模型下载完成，正在加载 isnet-general-use", 85)


def new_session_with_progress(new_session, model: str):
    """临时接管 pooch.retrieve 的进度条，完成后恢复原函数。"""
    import pooch

    original_retrieve = pooch.retrieve

    def retrieve(*args, **kwargs):
        if kwargs.get("progressbar") is True:
            kwargs["progressbar"] = ModelDownloadProgress()
        return original_retrieve(*args, **kwargs)

    pooch.retrieve = retrieve
    try:
        return new_session(model)
    finally:
        pooch.retrieve = original_retrieve


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=None)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--model", default="isnet-general-use")
    parser.add_argument("--progress-file", type=Path, default=None)
    parser.add_argument("--prepare", action="store_true", help="只准备运行环境与模型(后台预置),不做推理")
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
    if args.prepare:
        ensure_runtime_no_exec()
        prepare_model()
        print(json.dumps({"ok": True, "prepared": True}, ensure_ascii=False), flush=True)
        return 0
    if not args.input or not args.output:
        raise RuntimeError("缺少 --input/--output")
    global PROGRESS_PATH
    PROGRESS_PATH = args.progress_file
    emit_progress("environment", "正在准备本地 rembg 环境", 3)
    if args.model != "isnet-general-use":
        raise RuntimeError("仅支持 isnet-general-use 模型")
    if not args.input.exists():
        raise RuntimeError("输入图片不存在：" + str(args.input))

    # 同时设置新旧版本变量：2.0.61 使用 U2NET_HOME，新版 rembg 优先
    # REMBG_HOME。两者指向同一目录，确保模型只下载一份。
    MODEL_ROOT.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("REMBG_HOME", str(MODEL_ROOT))
    os.environ.setdefault("U2NET_HOME", str(MODEL_ROOT))
    os.environ.setdefault("OMP_NUM_THREADS", "2")
    ensure_runtime()

    from PIL import Image
    from rembg import new_session, remove

    args.output.parent.mkdir(parents=True, exist_ok=True)
    emit_progress("model", "正在下载/加载 isnet-general-use 模型（首次使用可能需要一些时间）", None)
    session = new_session_with_progress(new_session, args.model)
    emit_progress("processing", "模型已就绪，正在移除背景", 88)
    with Image.open(args.input) as image:
        # isnet-general-use 已提供软 alpha；保留 alpha matting 关闭时的
        # 原始边缘，避免产品边缘被过度侵蚀。
        result = remove(image.convert("RGBA"), session=session)
        result.save(args.output, format="PNG", optimize=True)
    emit_progress("complete", "去背景完成", 100)
    _final = '{"success":true,"model":"isnet-general-use","image":"' + str(args.output).replace('\\', '\\\\').replace('"', '\\"') + '"}'
    _out = getattr(args, 'result_output', None)
    if _out:
        try:
            from pathlib import Path as _P2
            _P2(_out).write_text(_final, encoding='utf-8')
        except Exception:
            pass
    print(_final)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        emit_progress("error", str(exc), None)
        print('{"success":false,"error":"' + str(exc).replace('\\', '\\\\').replace('"', '\\"').replace('\n', '\\n') + '"}')
        raise SystemExit(1)
