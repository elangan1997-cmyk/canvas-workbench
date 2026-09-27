// 自 lib/index.js 机械迁移（v1.8 Phase 2），函数体逐字未改。
import { expandUserPath, isAbsolutePath } from '../../../lib/platform.js';
import { join } from 'node:path';

function expandHome(p) {
  return expandUserPath(p);
}

function normalizeLocalPath(value) {
  let path = String(value || '').trim();
  if (/^file:\/\//i.test(path)) {
    try {
      const parsed = new URL(path);
      if (!parsed.hostname || parsed.hostname === 'localhost') path = decodeURIComponent(parsed.pathname);
    } catch (err) {}
  }
  return expandHome(path);
}

function materialDirectory(requestedDir, legacyCwd) {
  const explicit = normalizeLocalPath(requestedDir);
  if (explicit) {
    if (!isAbsolutePath(explicit)) throw new Error('素材库目录必须使用绝对路径');
    return explicit;
  }
  const cwd = normalizeLocalPath(legacyCwd);
  if (!cwd || !isAbsolutePath(cwd)) throw new Error('尚未选择素材库目录');
  // 首次升级沿用旧素材库；客户端收到真实目录后会把它持久化，后续不再随项目切换。
  return join(cwd, '画布素材库');
}

// —— 素材库整理：图片尺寸探测与 Mac 式颜色标记 ——

// 只读文件头部字节解析宽高；SVG 解析 width/height/viewBox 文本属性。

function pathComparable(value) {
  const path = String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function isPathWithin(parent, child) {
  const base = pathComparable(parent);
  const target = pathComparable(child);
  if (!base || !target) return false;
  // Windows volumes are case-insensitive even when the host code is running
  // through a compatibility layer; POSIX paths keep their normal case rules.
  const insensitive = /^[A-Za-z]:\//.test(base) || /^[A-Za-z]:\//.test(target);
  const left = insensitive ? base.toLowerCase() : base;
  const right = insensitive ? target.toLowerCase() : target;
  // Windows 路径是反斜杠:比对前统一成正斜杠,否则宿主扫描的归属判定恒为 false。
  const norm = (value) => String(value).replace(/\\/g, '/');
  return norm(right) === norm(left) || norm(right).startsWith(norm(left) + '/');
}

export { expandHome, normalizeLocalPath, materialDirectory, pathComparable, isPathWithin };
