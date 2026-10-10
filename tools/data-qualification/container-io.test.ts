import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTAINER_BYTES,
  REQUIRED_FREE_BYTES,
  TIME_BUDGET_MS,
  fixedPlan,
  validateRunId,
  writeAndVerifySyntheticFile,
} from './container-io.ts';

describe('E2候选容器流式I/O资格工具', () => {
  it('固定正式计划为5 GiB、300秒及额外磁盘余量', () => {
    expect(fixedPlan()).toMatchObject({
      fileBytes: 5 * 1024 ** 3,
      timeBudgetMs: 300_000,
    });
    expect(CONTAINER_BYTES).toBe(5 * 1024 ** 3);
    expect(REQUIRED_FREE_BYTES).toBeGreaterThan(CONTAINER_BYTES);
    expect(TIME_BUDGET_MS).toBeLessThanOrEqual(300_000);
  });

  it('拒绝路径或非固定格式runId', () => {
    expect(() => validateRunId('../outside')).toThrow(/runId/u);
    expect(() => validateRunId('A'.repeat(32))).toThrow(/runId/u);
    expect(validateRunId('0123456789abcdef0123456789abcdef')).toHaveLength(32);
  });

  it('小块非整除流写、fsync、回读字节和哈希闭合', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aibrowse-container-io-'));
    const filename = join(root, 'small.bin');
    try {
      const measurement = await writeAndVerifySyntheticFile(filename, {
        fileBytes: 2 * 1024 ** 2 + 113,
        chunkBytes: 256 * 1024,
        timeBudgetMs: 10_000,
      });
      expect(measurement.byteCountMatches).toBe(true);
      expect(measurement.hashMatches).toBe(true);
      expect(measurement.writtenBytes).toBe(2 * 1024 ** 2 + 113);
      expect(measurement.readBytes).toBe(measurement.writtenBytes);
      expect(measurement.writeSha256).toBe(measurement.readSha256);
      expect((await stat(filename)).size).toBe(measurement.expectedBytes);
      expect((await readFile(filename)).some((byte) => byte !== 0)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('预算耗尽时失败，不误报完成', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aibrowse-container-io-budget-'));
    try {
      await expect(
        writeAndVerifySyntheticFile(join(root, 'timeout.bin'), {
          fileBytes: 2 * 1024 ** 2,
          chunkBytes: 64 * 1024,
          timeBudgetMs: 1,
        }),
      ).rejects.toThrow(/期限/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
