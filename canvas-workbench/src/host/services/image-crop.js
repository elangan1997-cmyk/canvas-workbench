// 聊天生图比例兜底：网关(与 dsh-codex 上游)对非标准 size 会静默忽略,
// 生成后用自带 Python 运行时按目标比例居中裁切(cover,只裁不放大)。
// 模型给对比例(±0.5%)时为无操作;Python/Pillow 缺失或失败时返回原图——
// 比例是增强,不阻断生成。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { resolvePython } from '../../../lib/platform.js';

const CROP_SCRIPT = join(fileURLToPath(new URL('.', import.meta.url)), '../../../scripts', 'crop_to_ratio.py');

export async function cropToRatio(ctx, buffer, imageSize) {
  const work = await mkdtemp(join(tmpdir(), 'dsh-crop-'));
  try {
    const input = join(work, 'in.png');
    const output = join(work, 'out.png');
    await writeFile(input, buffer);
    const python = await resolvePython(ctx);
    const result = await new Promise((resolve) => {
      execFile(python.executable, [...python.prefixArgs, CROP_SCRIPT, '--input', input, '--output', output, '--size', String(imageSize)], { timeout: 60000, cwd: dirname(CROP_SCRIPT) }, (err, stdout) => {
        resolve({ err, stdout: String(stdout || '') });
      });
    });
    if (result.err || !String(result.stdout).startsWith('ok')) return buffer;
    return Buffer.from(await readFile(output));
  } catch {
    return buffer;
  } finally {
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
