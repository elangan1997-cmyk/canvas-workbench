#!/usr/bin/env python3
"""gpt-image-2 fallback for canvas-local image edits.

The credential is read from ~/.codex-pixel/auth.json and is never printed.
"""

import argparse
import base64
import json
import mimetypes
import pathlib
import time
import urllib.error
import urllib.request
import uuid

import sys
try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8')
except Exception:
    pass



AUTH_FILE = pathlib.Path.home() / ".codex-pixel" / "auth.json"
DEFAULT_BASE_URL = "https://ai-pixel.online"
USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"


def load_auth():
    data = json.loads(AUTH_FILE.read_text(encoding="utf-8"))
    key = str(data.get("OPENAI_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("Pixel API 未配置 OPENAI_API_KEY")
    base = str(data.get("OPENAI_BASE_URL") or data.get("BASE_URL") or DEFAULT_BASE_URL).rstrip("/")
    return key, base


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    body = bytearray()
    for name, value in fields.items():
        body.extend(("--%s\r\n" % boundary).encode())
        body.extend(('Content-Disposition: form-data; name="%s"\r\n\r\n' % name).encode())
        body.extend(str(value).encode("utf-8"))
        body.extend(b"\r\n")
    for name, path in files:
        content = path.read_bytes()
        mime = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        body.extend(("--%s\r\n" % boundary).encode())
        body.extend(('Content-Disposition: form-data; name="%s"; filename="%s"\r\n' % (name, path.name)).encode())
        body.extend(("Content-Type: %s\r\n\r\n" % mime).encode())
        body.extend(content)
        body.extend(b"\r\n")
    body.extend(("--%s--\r\n" % boundary).encode())
    return boundary, bytes(body)


def request_edit(key, base_url, image, mask, prompt, quality):
    fields = {"model": "gpt-image-2", "prompt": prompt, "quality": quality, "n": 1}
    files = [("image", image)]
    if mask:
        files.append(("mask", mask))
    boundary, body = multipart(fields, files)
    request = urllib.request.Request(
        base_url + "/v1/images/edits",
        data=body,
        headers={
            "Authorization": "Bearer " + key,
            "Content-Type": "multipart/form-data; boundary=" + boundary,
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read().decode("utf-8"))


def save_result(result, target):
    items = result.get("data") or []
    if not items:
        raise RuntimeError("image2 没有返回图片")
    item = items[0]
    if item.get("b64_json"):
        raw = base64.b64decode(item["b64_json"])
    elif item.get("url"):
        req = urllib.request.Request(item["url"], headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=120) as response:
            raw = response.read()
    else:
        raise RuntimeError("image2 返回格式无法识别")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(raw)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", type=pathlib.Path)
    parser.add_argument("--mask", type=pathlib.Path)
    parser.add_argument("--prompt")
    parser.add_argument("--quality", choices=["low", "medium", "high", "auto"], default="medium")
    parser.add_argument("--output", type=pathlib.Path)
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
    key, base_url = load_auth()
    last_error = None
    for attempt in range(2):
        try:
            result = request_edit(key, base_url, args.image, args.mask, args.prompt, args.quality)
            save_result(result, args.output)
            print(json.dumps({"success": True, "image": str(args.output)}, ensure_ascii=False))
            return 0
        except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(4)
    raise RuntimeError("image2 编辑失败：%s" % last_error)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"success": False, "error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
