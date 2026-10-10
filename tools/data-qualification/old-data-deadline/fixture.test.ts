import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from './contract';
import {
  executeInitialScene,
  fixtureConstants,
  inspectCommittedFixture,
  inspectInterruptedFixture,
  reopenScene,
} from './fixture';

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true });
});
async function root(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'aibrowse-old-deadline-'));
  temporary.push(parent);
  return join(parent, name);
}

describe('旧集合期限文件协议', () => {
  it('正常控制沿同一DatasetSwitch流程提交新代', async () => {
    const sceneRoot = await root('normal');
    const result = await executeInitialScene(sceneRoot, 'normal', {
      wait: () => Promise.reject(new Error('正常控制不得等待')),
    });
    expect(result).toMatchObject({
      state: 'committed',
      code: 'ok',
      journalPhase: 'committed',
      selected: 0,
      rollbackCopyRemaining: 0,
      rollbackCopyBudget: 0,
    });
    await expect(inspectCommittedFixture(sceneRoot)).resolves.toBeUndefined();
  });

  it('inventory只在唯一257B旧Sources读取进度耗尽，重开不续租', async () => {
    let now = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const sceneRoot = await root('inventory');
    const initial = await executeInitialScene(sceneRoot, 'inventory', {
      now: () => now,
      wait: async () => {
        now += LIMITS.realDelayMs;
      },
    });
    expect(initial).toMatchObject({
      state: 'old-unchanged',
      code: 'interrupted',
      journalPhase: 'inventory',
      selected: 1,
      rollbackSpaceCalls: 0,
      rollbackCopyRemaining: 0,
      rollbackCopyBudget: 0,
    });
    expect(initial.waitedMs).toBe(LIMITS.realDelayMs);
    await expect(inspectInterruptedFixture(sceneRoot, 'inventory', false)).resolves.toEqual({
      oldMembers: 13,
      workMembers: 4,
      retainedRollbackCopies: 0,
    });
    const reopened = await reopenScene(sceneRoot, 'inventory');
    expect(reopened).toMatchObject({
      state: 'recovery-required',
      code: 'attempt-exhausted',
      journalPhase: 'inventory',
      rollbackSpaceCalls: 0,
      rollbackCopyRemaining: 0,
      rollbackCopyBudget: 0,
    });
    await expect(inspectInterruptedFixture(sceneRoot, 'inventory', true)).resolves.toBeTruthy();
  });

  it('backing-up只在首个真实flush后耗尽并由新实例识别完整旧代', async () => {
    let now = 500;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const sceneRoot = await root('backing-up');
    const selected: string[] = [];
    const initial = await executeInitialScene(sceneRoot, 'backing-up', {
      now: () => now,
      selected: (phase) => {
        selected.push(phase);
      },
      wait: async () => {
        now += LIMITS.realDelayMs;
      },
    });
    expect(selected).toEqual(['backing-up']);
    expect(initial).toMatchObject({
      state: 'old-unchanged',
      code: 'interrupted',
      journalPhase: 'backing-up',
      selected: 1,
      rollbackSpaceCalls: 1,
      rollbackCopyRemaining: 0,
      rollbackCopyBudget: 0,
    });
    await expect(inspectInterruptedFixture(sceneRoot, 'backing-up', false)).resolves.toEqual({
      oldMembers: 13,
      workMembers: 4,
      retainedRollbackCopies: 1,
    });
    const reopened = await reopenScene(sceneRoot, 'backing-up');
    expect(reopened).toMatchObject({
      state: 'old-restored',
      code: 'ok',
      journalPhase: 'rolled-back',
      rollbackSpaceCalls: 0,
      rollbackCopyRemaining: 0,
      rollbackCopyBudget: 0,
    });
    await expect(inspectInterruptedFixture(sceneRoot, 'backing-up', true)).resolves.toEqual({
      oldMembers: 13,
      workMembers: 4,
      retainedRollbackCopies: 1,
    });
  });

  it('固定哨兵长度唯一且已有scene根不能重用', async () => {
    expect(new Set(fixtureConstants.oldFileLengths).size).toBe(12);
    expect(fixtureConstants.oldFileLengths[0]).toBe(fixtureConstants.oldSourcesBytes);
    const sceneRoot = await root('reuse');
    await executeInitialScene(sceneRoot, 'normal', {
      wait: () => Promise.reject(new Error('不应等待')),
    });
    await expect(
      executeInitialScene(sceneRoot, 'normal', {
        wait: () => Promise.reject(new Error('不应等待')),
      }),
    ).rejects.toThrow('禁止复用');
  });
});
