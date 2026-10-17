// 构建 lib/client.js：按 src/client/build-manifest.json 的 order 拼接分段源码。
// lib/client.js 是构建产物，不要手工编辑（执行文档 §34）。
//
//   node scripts/build-client.mjs            # 写入 lib/client.js
//   node scripts/build-client.mjs --check    # 只比较：产物与当前 lib/client.js 是否一致（漂移守卫）
//   node scripts/build-client.mjs --out X    # 写到指定路径
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = join(pluginRoot, 'src', 'client', 'build-manifest.json');

export async function buildClient() {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const parts = [];
  for (const entry of manifest.order) {
    if (entry.inline) {
      // 共享 ES 模块内联进浏览器 bundle：去掉 import / export，成为工厂函数作用域内的普通声明。
      const raw = await readFile(join(pluginRoot, 'src', entry.inline), 'utf8');
      const stripped = raw
        .replace(/^import[^\n]*;\s*$/gm, '')
        .replace(/^export\s+\{[^}]*\};?\s*$/gm, '')
        .replace(/^export\s+(?=(?:async\s+)?(?:function|class|const|let|var)\b)/gm, '');
      parts.push(`    // ---- 内联自 src/${entry.inline}（构建期去 import/export；请改源文件） ----\n` + stripped.replace(/^/gm, '    ').replace(/^ {4}$/gm, '') + '\n');
      continue;
    }
    let source = await readFile(join(pluginRoot, 'src', 'client', entry.file), 'utf8');
    if (entry.file === 'core/canvas/frame/01-variants.js') {
      // Base64 keeps vendor HTML-like sequences out of the srcdoc tokenizer.
      const vendors = [];
      for (const file of ['react-18.3.1.production.min.js', 'react-dom-18.3.1.production.min.js', 'excalidraw-0.17.6.production.min.js']) {
        vendors.push((await readFile(join(pluginRoot, 'vendor', file))).toString('base64'));
      }
      const marker = '__DSH_CANVAS_VENDOR_BASE64__';
      if (source.split(marker).length !== 2) throw new Error('Canvas vendor placeholder must occur exactly once');
      source = source.replace(marker, JSON.stringify(vendors));
    }
    parts.push(source);
  }
  const output = parts.join('');
  return { output, manifest, sha256: createHash('sha256').update(output).digest('hex'), bytes: Buffer.byteLength(output) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const built = await buildClient();
  const outIdx = args.indexOf('--out');
  const target = outIdx !== -1 ? resolve(args[outIdx + 1]) : join(pluginRoot, built.manifest.output);
  if (args.includes('--check')) {
    const current = await readFile(target, 'utf8').catch(() => null);
    const same = current === built.output;
    console.log(same ? `client build 一致：${built.bytes} bytes sha256 ${built.sha256.slice(0, 16)}…` : `client build 漂移：lib/client.js 与分段源码不一致（请运行 npm run build 或改分段而不是改产物）`);
    process.exit(same ? 0 : 1);
  }
  await writeFile(target, built.output);
  console.log(`已写入 ${target}（${built.bytes} bytes，${built.manifest.order.length} 段，sha256 ${built.sha256.slice(0, 16)}…）`);
}
