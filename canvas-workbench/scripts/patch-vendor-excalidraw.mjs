// 中性化 vendored Excalidraw 构建里烘入的 Firebase 协作配置。
//
// 背景:excalidraw-0.17.6.production.min.js 是上游官方压缩构建,内含其托管
// 协作服务(excalidraw.com)的客户端配置 VITE_APP_FIREBASE_CONFIG(带一个
// 形似 GCP apiKey 的公开客户端 key)。画布工作台把 Excalidraw 当作纯本地
// 绘图组件在隔离 iframe 里使用,从不调用协作功能,该配置是死数据;但它会让
// 安全扫描器(dsh-plugin-vet R7 等规则)报"硬编码密钥"误报。
//
// 处理:把配置字面量整体替换为 null。这是对 vendored 文件唯一的改动:
//   VITE_APP_FIREBASE_CONFIG:'{"apiKey":…}'  →  VITE_APP_FIREBASE_CONFIG:null
// 升级 vendored Excalidraw 后请重新运行本脚本。上游原文件的 sha256 记录在
// CHANGELOG 对应版本条目中,可自行下载 npm 的 excalidraw@0.17.6 压缩产物核对。
//
//   node scripts/patch-vendor-excalidraw.mjs           # 应用补丁(幂等)
//   node scripts/patch-vendor-excalidraw.mjs --check   # 只校验:已补丁且无 AIza 残留
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(pluginRoot, 'vendor', 'excalidraw-0.17.6.production.min.js');

const CONFIG_RE = /VITE_APP_FIREBASE_CONFIG:'[^']*AIza[^']*'/g;

const raw = await readFile(target, 'utf8');
const hits = raw.match(CONFIG_RE) ?? [];

if (process.argv.includes('--check')) {
  const patched = !hits.length && !raw.includes('AIza');
  console.log(patched
    ? `vendor 补丁一致:Firebase 配置已中性化,无 AIza 残留(文件 sha256 ${createHash('sha256').update(raw).digest('hex').slice(0, 16)}…)`
    : `vendor 补丁缺失或漂移:检测到 ${hits.length} 处未中性化配置(升级 Excalidraw 后请运行 npm run patch:vendor)`);
  process.exit(patched ? 0 : 1);
}

if (!hits.length) {
  if (!raw.includes('AIza')) {
    console.log('vendor 已是补丁状态,无需处理');
  } else {
    console.error('未匹配到已知的 Firebase 配置模式,但文件里仍有 AIza 字样——上游格式可能变化,请人工检查');
    process.exit(1);
  }
} else {
  const patched = raw.replace(CONFIG_RE, 'VITE_APP_FIREBASE_CONFIG:null');
  await writeFile(target, patched);
  console.log(`已中性化 ${hits.length} 处 VITE_APP_FIREBASE_CONFIG(文件 sha256 ${createHash('sha256').update(patched).digest('hex').slice(0, 16)}…)`);
}
