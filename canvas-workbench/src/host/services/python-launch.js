// Python 脚本统一启动器(v1.9.21):官方桌面的沙箱 runner 在 Windows 上传递含空格
// 参数不可靠(实测项目路径带空格时 argparse 直接 usage 报错;PowerShell 单参数通道正常)。
// 因此所有脚本调用改为「单参数规格文件」:真实参数写入临时 JSON(argv 只剩一个 ASCII
// tmpdir 路径),脚本端 --spec 读取。顺带对齐 macOS 行为(该模式下完全一致)。
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { logOp } from './op-log.js';

/**
 * 以规格文件模式运行 python 脚本。
 * @param runOne (executable, argsArray, cwd, timeoutMs) => Promise<{exitCode, stdout, stderr, timedOut?}>
 * @param python { executable, prefixArgs }
 * @param scriptPath 脚本绝对路径
 * @param argsObject 各参数(值仅限字符串/数字,路径可为任意含空格/中文)
 */
export async function runPythonSpec(runOne, python, scriptPath, argsObject, { cwd, timeoutMs } = {}) {
  const startedAt = Date.now();
  const work = await mkdtemp(join(tmpdir(), 'dsh-pyspec-'));
  try {
    const specPath = join(work, 'spec.json');
    const resultPath = join(work, 'result.json');
    await writeFile(specPath, JSON.stringify({ ...argsObject, result_output: resultPath }), 'utf8');
    const result = await runOne(
      python.executable,
      [...(python.prefixArgs || []), scriptPath, '--spec', specPath],
      cwd || tmpdir(),
      timeoutMs,
    );
    // 结果优先取文件:脚本显式 UTF-8 落盘,绕开沙箱 runner 管道在 Windows 上的编码劣化(乱码实测)。
    let final = result;
    try {
      const { readFile } = await import('node:fs/promises');
      const fileResult = await readFile(resultPath, 'utf8');
      if (fileResult && fileResult.trim()) final = { ...result, stdout: fileResult };
    } catch {}
    await logOp('python', {
      script: basename(scriptPath),
      exitCode: final.exitCode,
      ms: Date.now() - startedAt,
      stderrTail: final.stderr ? String(final.stderr).slice(-240) : undefined,
    });
    return final;
  } catch (error) {
    await logOp('python', { script: basename(scriptPath), error: String((error && error.message) || error).slice(0, 240), ms: Date.now() - startedAt });
    throw error;
  } finally {
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
