#!/usr/bin/env python
"""把 SVG 里的**外部图片引用**内联成 base64 data URL，供画布预览使用。

为什么需要：Illustrator「导出为 SVG」默认把位图写成**外链**（`xlink:href="xxx.png"`），
文件在同目录时 AI 自己能显示，但画布/浏览器拿到的是一份独立 SVG（data URL 或独立
HTTP 响应），相对路径无从解析 —— 结果就是**只看到文字、背景整块丢失**。
插件自己生成的 SVG 本来就是内嵌的（见 export_text_svg.py），但用户一旦在 AI 里
重新导出就会退化成外链。

策略：只处理「非 data: / http(s): / // / #」的 href，按 SVG 所在目录解析相对路径，
读文件转 base64 内联；找不到文件的原样保留（不阻断预览）。没有可内联项时
`changed=false`，由上层决定直接用原文件。

输出：成功时打印一行 JSON（success/changed/inlined/skipped），退出码 0。
"""
import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import urllib.parse

# 只匹配 href/src 形式的属性；SVG 里的图片引用就这两种写法
HREF_RE = re.compile(r'(xlink:href|href)\s*=\s*"([^"]*)"')
REMOTE_PREFIXES = ('data:', 'http://', 'https://', '//', '#')


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def resolve_local(href, base_dir):
    """把 href 解析成本地文件路径；不是本地文件就返回空串。"""
    raw = href.split('#', 1)[0].split('?', 1)[0]
    if not raw or raw.startswith(REMOTE_PREFIXES):
        return ''
    if raw.lower().startswith('file://'):
        parsed = urllib.parse.urlparse(raw)
        path = urllib.parse.unquote(parsed.path or '')
        # Windows: file:///C:/x → /C:/x，需要去掉开头的斜杠
        if os.name == 'nt' and re.match(r'^/[A-Za-z]:', path):
            path = path[1:]
        return path
    return os.path.normpath(os.path.join(base_dir, raw.replace('/', os.sep)))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()

    try:
        with open(args.input, 'r', encoding='utf-8', errors='replace') as handle:
            svg = handle.read()
    except OSError as exc:
        emit({'success': False, 'error': '读取失败: %s' % exc})
        return 2

    base_dir = os.path.dirname(os.path.abspath(args.input))
    stats = {'inlined': 0, 'skipped': 0}

    def replace(match):
        attr, href = match.group(1), match.group(2)
        target = resolve_local(href, base_dir)
        if not target or not os.path.isfile(target):
            if href and not href.startswith(REMOTE_PREFIXES):
                stats['skipped'] += 1
            return match.group(0)
        try:
            with open(target, 'rb') as handle:
                payload = base64.b64encode(handle.read()).decode('ascii')
        except OSError:
            stats['skipped'] += 1
            return match.group(0)
        mime = mimetypes.guess_type(target)[0] or 'image/png'
        stats['inlined'] += 1
        return '%s="data:%s;base64,%s"' % (attr, mime, payload)

    out = HREF_RE.sub(replace, svg)

    if stats['inlined'] == 0:
        emit({'success': True, 'changed': False, 'inlined': 0, 'skipped': stats['skipped']})
        return 0

    try:
        with open(args.output, 'w', encoding='utf-8') as handle:
            handle.write(out)
    except OSError as exc:
        emit({'success': False, 'error': '写入失败: %s' % exc})
        return 3

    emit({
        'success': True,
        'changed': True,
        'inlined': stats['inlined'],
        'skipped': stats['skipped'],
        'bytes': len(out.encode('utf-8')),
    })
    return 0


if __name__ == '__main__':
    sys.exit(main())
