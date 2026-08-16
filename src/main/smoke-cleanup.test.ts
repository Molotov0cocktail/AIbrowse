// C8 定向修复（2026-08-17）：Research factory smoke 临时库清理缺陷红测——
// 2026-08-16 23:30 生产冒烟机器证据：8.19-A 场景失败路径（assert 抛错）跳
// finally 时 research.db 句柄未关闭（service.shutdown 只在正常路径调用）→
// rmSync 在 Windows 上 EPERM → 系统 TEMP 遗留
// `aibrowse-research-factory-smoke-t0DXYo\research.db`（90112 字节，扫描零
// 敏感形态，已按既有流程精确清理）。修复契约：独立纯模块
// `smoke-cleanup.ts`（零 Electron import）提供带有限重试的目录删除——
// 冒烟场景 finally 必须先关闭全部句柄再删除，EPERM/EBUSY 有限重试吸收
// Windows 句柄延迟释放窗口；语义护栏：句柄未关闭时删除必须失败（不得
// 静默放弃/不得声称已清理）。
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb, closeDb } from './sources/db/sqlite-driver';
import { removeSmokeDirWithRetry } from './smoke-cleanup';

const gone = (dir: string): void => {
  expect(() => statSync(dir)).toThrow();
};

const roots: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 测试收尾尽力清理
    }
  }
});

describe('removeSmokeDirWithRetry（决议 #156 前置：工厂冒烟临时库清理修复）', () => {
  it('不存在的目录安全返回（force 语义，不抛异常）', async () => {
    await expect(
      removeSmokeDirWithRetry(
        join(tmpdir(), 'aibrowse-smoke-cleanup-does-not-exist-' + Date.now()),
        {
          attempts: 2,
          delayMs: 1,
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('空目录删除成功且目录零残留', async () => {
    const dir = makeDir('aibrowse-smoke-cleanup-empty-');
    await removeSmokeDirWithRetry(dir, { attempts: 3, delayMs: 1 });
    gone(dir);
  });

  it('含普通文件目录删除成功零残留', async () => {
    const dir = makeDir('aibrowse-smoke-cleanup-files-');
    writeFileSync(join(dir, 'a.txt'), 'x');
    writeFileSync(join(dir, 'b.csv'), '1,2');
    await removeSmokeDirWithRetry(dir, { attempts: 3, delayMs: 1 });
    gone(dir);
  });

  it('语义护栏：sqlite 句柄未关闭时删除必须失败（EPERM 等价——Windows 文件占用）', async () => {
    const dir = makeDir('aibrowse-smoke-cleanup-locked-');
    const dbPath = join(dir, 'research.db');
    const db = openDb(dbPath);
    try {
      // 修复前冒烟行为：句柄仍打开时直接 rmSync → 抛错（EPERM/EBUSY）——
      // 本护栏固化「必须先关闭句柄再删除」的契约，绝不静默放弃
      await expect(removeSmokeDirWithRetry(dir, { attempts: 2, delayMs: 1 })).rejects.toThrow();
    } finally {
      closeDb(db);
    }
    // 句柄关闭后删除成功零残留（修复后冒烟 finally 的行为）
    await removeSmokeDirWithRetry(dir, { attempts: 3, delayMs: 1 });
    gone(dir);
  });

  it('句柄关闭后立即删除成功（修复后冒烟 finally 路径：先 shutdown/closeDb 再删除）', async () => {
    const dir = makeDir('aibrowse-smoke-cleanup-closed-');
    const dbPath = join(dir, 'research.db');
    const db = openDb(dbPath);
    closeDb(db);
    await removeSmokeDirWithRetry(dir, { attempts: 5, delayMs: 1 });
    gone(dir);
  });

  it('重试参数有界：attempts 非正整数安全回退默认；delayMs 非负数安全回退默认', async () => {
    const dir = makeDir('aibrowse-smoke-cleanup-params-');
    writeFileSync(join(dir, 'x.txt'), 'x');
    await expect(
      removeSmokeDirWithRetry(dir, { attempts: -1, delayMs: -5 } as never),
    ).resolves.toBeUndefined();
  });
});
