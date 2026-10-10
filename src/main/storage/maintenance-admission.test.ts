import { describe, expect, it } from 'vitest';
import { SourcesIpcAdmission } from '../sources/source-ipc';
import { WatchIpcAdmission } from '../watch/ipc-admission';

describe.each([
  ['Sources', () => new SourcesIpcAdmission()],
  ['Watch', () => new WatchIpcAdmission()],
] as const)('%s 维护准入', (_name, create) => {
  it('先同步关闭入口，再等已准入调用真实释放；排水前不能恢复', async () => {
    const gate = create();
    const release = gate.enter();
    expect(release).not.toBeNull();
    expect(gate.pauseForMaintenance(1)).toBe(true);
    expect(gate.enter()).toBeNull();
    expect(gate.isOpen()).toBe(false);
    let settled = false;
    const drain = gate.drainForMaintenance(1).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(gate.resumeAfterMaintenance(1)).toBe(false);
    release?.();
    release?.();
    await drain;
    expect(gate.resumeAfterMaintenance(2)).toBe(false);
    expect(gate.resumeAfterMaintenance(1)).toBe(true);
    expect(gate.isOpen()).toBe(true);
  });

  it('旧世代、错误世代和非法世代不能关闭或恢复新业务', async () => {
    const gate = create();
    for (const invalid of [0, -1, 1.5, NaN, Infinity]) {
      expect(gate.pauseForMaintenance(invalid)).toBe(false);
    }
    expect(gate.isOpen()).toBe(true);
    expect(gate.pauseForMaintenance(3)).toBe(true);
    expect(gate.pauseForMaintenance(3)).toBe(true);
    expect(gate.pauseForMaintenance(4)).toBe(false);
    await expect(gate.drainForMaintenance(2)).rejects.toThrow('维护世代');
    expect(gate.resumeAfterMaintenance(3)).toBe(false);
    await gate.drainForMaintenance(3);
    expect(gate.resumeAfterMaintenance(3)).toBe(true);
    expect(gate.pauseForMaintenance(3)).toBe(false);
    expect(gate.pauseForMaintenance(2)).toBe(false);
    expect(gate.pauseForMaintenance(4)).toBe(true);
    expect(gate.resumeAfterMaintenance(3)).toBe(false);
  });

  it('即使随后恢复，维护前捕获的导出或预览世代也永久过期', async () => {
    const gate = create();
    const epoch = gate.captureEpoch();
    expect(gate.isCurrent(epoch)).toBe(true);
    gate.pauseForMaintenance(1);
    expect(gate.isCurrent(epoch)).toBe(false);
    await gate.drainForMaintenance(1);
    gate.resumeAfterMaintenance(1);
    expect(gate.isCurrent(epoch)).toBe(false);
    expect(gate.isCurrent(gate.captureEpoch())).toBe(true);
  });

  it('永久退出优先于在途维护排水，迟到释放不能重新开放', async () => {
    const gate = create();
    const release = gate.enter();
    gate.pauseForMaintenance(1);
    const pending = gate.drainForMaintenance(1);
    gate.beginShutdown();
    release?.();
    await expect(pending).rejects.toThrow('维护世代');
    expect(gate.resumeAfterMaintenance(1)).toBe(false);
    expect(gate.pauseForMaintenance(2)).toBe(false);
    expect(gate.enter()).toBeNull();
  });
});

it('Watch维护撤销订阅，恢复后仍需重新订阅', async () => {
  const gate = new WatchIpcAdmission();
  const sender = {};
  expect(gate.subscribe(sender)).toBe(true);
  gate.pauseForMaintenance(1);
  expect(gate.currentSender()).toBeNull();
  expect(gate.subscribe(sender)).toBe(false);
  await gate.drainForMaintenance(1);
  gate.resumeAfterMaintenance(1);
  expect(gate.currentSender()).toBeNull();
  expect(gate.subscribe(sender)).toBe(true);
});
