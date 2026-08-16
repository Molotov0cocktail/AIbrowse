// C8 定向修复（2026-08-17）：Research factory smoke 临时库清理缺陷——2026-08-16
// 23:30 生产冒烟机器证据：8.19-A 场景失败路径（assert 抛错）跳 finally 时
// research.db 句柄未关闭（service.shutdown 只在正常路径调用）→ rmSync 在
// Windows 上 EPERM → 系统 TEMP 遗留 `aibrowse-research-factory-smoke-*\research.db`。
// 本模块（零 Electron import，纯 node:fs）提供带有限重试的目录删除：
// 冒烟场景 finally 必须先关闭全部句柄再删除；EPERM/EBUSY 有限重试吸收
// Windows 句柄延迟释放窗口；句柄未关闭时删除必须失败（语义护栏——不得
// 静默放弃、不得声称已清理）。重试参数有界（attempts/delayMs 非正安全回退
// 默认），与既有越界安全返回纪律一致。
import { rmSync } from 'node:fs';

export interface RemoveSmokeDirOptions {
  attempts?: number; // 总尝试次数（≥1；非法值回退默认 5）
  delayMs?: number; // 重试间隔毫秒（≥0；非法值回退默认 100）
}

export const REMOVE_SMOKE_DIR_DEFAULT_ATTEMPTS = 5;
export const REMOVE_SMOKE_DIR_DEFAULT_DELAY_MS = 100;

// Windows 文件占用错误族（node:fs rmSync 抛出的系统错误码）
const RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function removeSmokeDirWithRetry(
  dir: string,
  options?: RemoveSmokeDirOptions,
): Promise<void> {
  const attempts =
    typeof options?.attempts === 'number' &&
    Number.isInteger(options.attempts) &&
    options.attempts >= 1
      ? options.attempts
      : REMOVE_SMOKE_DIR_DEFAULT_ATTEMPTS;
  const delayMs =
    typeof options?.delayMs === 'number' && Number.isFinite(options.delayMs) && options.delayMs >= 0
      ? options.delayMs
      : REMOVE_SMOKE_DIR_DEFAULT_DELAY_MS;
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const isLast = i === attempts - 1;
      if (!RETRYABLE_CODES.has(code) || isLast) throw err;
      await sleep(delayMs);
    }
  }
}
