// 宿主侧操作日志(v1.9.36):Python 调用、工具链状态迁移、桥接与自更新等关键事件
// 逐条 JSONL 落盘 ~/.dsh/canvas-workbench/logs/ops.jsonl,供 /dsh-canvas/toolchain-log
// 与 client-debug 读取。写日志本身绝不抛错——诊断工具不能成为新的故障源。
import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG_DIR = () => join(homedir(), '.dsh', 'canvas-workbench', 'logs');
const LOG_FILE = () => join(LOG_DIR(), 'ops.jsonl');
const MAX_BYTES = 4 * 1024 * 1024;

let writeChain = Promise.resolve();

export async function logOp(event, data = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data }) + '\n';
  // 串行化写入,避免并发 append 交错;失败静默。
  writeChain = writeChain.then(async () => {
    try {
      await mkdir(LOG_DIR(), { recursive: true });
      const info = await stat(LOG_FILE()).catch(() => null);
      // 超过 4MB 截半:保留最近的一半,防止长期运行无限增长。
      if (info && info.size > MAX_BYTES) {
        const raw = await readFile(LOG_FILE(), 'utf8').catch(() => '');
        const lines = raw.split('\n').filter(Boolean);
        await appendFile(LOG_FILE(), '', 'utf8').catch(() => {});
        const { writeFile } = await import('node:fs/promises');
        await writeFile(LOG_FILE(), lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n', 'utf8');
      }
      await appendFile(LOG_FILE(), line, 'utf8');
    } catch {}
  });
  return writeChain;
}

/** 读取尾部若干行(诊断路由用)。 */
export async function readOpTail(maxLines = 60) {
  try {
    const raw = await readFile(LOG_FILE(), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-maxLines).join('\n');
  } catch {
    return '';
  }
}
