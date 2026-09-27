// 聊天生图比例兜底：网关(与 dsh-codex 上游)对非标准 size 会静默忽略,
// 生成后用 Python 按目标比例居中裁切(cover,只裁不放大)。
// 模型给对比例(±0.5%)时为无操作;Python/Pillow 缺失或失败时返回原图——
// 比例是增强,不阻断生成。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { resolvePython } from '../../../lib/platform.js';

const CROP_SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../scripts', 'crop_to_ratio.py');

/**
 * 裁切用的 Python 候选:优先预置工具链的隔离环境(rembg/vtracer 环境必带 Pillow)。
 * 全新 Windows 机器的系统 Python 往往没有 Pillow——若只走系统 Python,
 * 裁切会静默降级为"不裁",比例失准且无报错(2026-09-28 Win 实机审出)。
 */
async function cropPythonCandidates(ctx) {
  const { dshHome } = await import('./image-engine-settings.js');
  const runtimeRoot = join(dshHome(), 'canvas-workbench');
  const venvPython = process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python';
  const candidates = [
    join(runtimeRoot, 'rembg-runtime', venvPython),
    join(runtimeRoot, 'vtracer-runtime', venvPython),
  ];
  const resolved = await resolvePython(ctx).catch(() => null);
  if (resolved && resolved.executable) candidates.push(resolved.executable);
  const { access } = await import('node:fs/promises');
  const usable = [];
  for (const candidate of candidates) {
    try { await access(candidate); usable.push(candidate); } catch {}
  }
  return usable;
}

export async function cropToRatio(ctx, buffer, imageSize) {
  const work = await mkdtemp(join(tmpdir(), 'dsh-crop-'));
  try {
    const input = join(work, 'in.png');
    const output = join(work, 'out.png');
    await writeFile(input, buffer);
    const pythons = await cropPythonCandidates(ctx);
    if (!pythons.length) return buffer;
    // 逐个候选执行,首个输出 ok 的即成功(缺 Pillow 的候选自然跳过,不报错)。
    for (const pythonExecutable of pythons) {
      const result = await new Promise((resolve) => {
        execFile(pythonExecutable, [CROP_SCRIPT, '--input', input, '--output', output, '--size', String(imageSize)], { timeout: 60000, cwd: dirname(CROP_SCRIPT) }, (err, stdout) => {
          resolve({ err, stdout: String(stdout || '') });
        });
      });
      if (!result.err && String(result.stdout).startsWith('ok')) {
        return Buffer.from(await readFile(output));
      }
    }
    return buffer;
  } catch {
    return buffer;
  } finally {
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
