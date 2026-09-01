import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { WatchIpcAdmission } from './smoke-watch-admission';
import { SourcesIpcAdmission } from './sources/source-ipc';

describe('Watch IPC shutdown admission', () => {
  it('shutdown 后拒绝迟到订阅并清空旧 sender', () => {
    const admission = new WatchIpcAdmission();
    const sender = {};
    expect(admission.subscribe(sender)).toBe(true);
    admission.beginShutdown();
    expect(admission.isOpen()).toBe(false);
    expect(admission.currentSender()).toBeNull();
    expect(admission.subscribe(sender)).toBe(false);
  });

  it('index.ts 必须先封闭 Watch IPC admission，再释放 repository', () => {
    const source = readFileSync('src/main/index.ts', 'utf8');
    const admissionIndex = source.indexOf('watchIpcAdmission.beginShutdown()');
    const disposeIndex = source.indexOf('watchRepo?.dispose()');
    expect(admissionIndex).toBeGreaterThanOrEqual(0);
    expect(disposeIndex).toBeGreaterThan(admissionIndex);
  });

  it('shutdown 必须等待已经获准的 Watch IPC 调用排水后再释放 repository', async () => {
    const admission = new WatchIpcAdmission();
    const release = admission.enter();
    expect(release).not.toBeNull();
    admission.beginShutdown();
    let drained = false;
    const pending = admission.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release?.();
    await pending;
    expect(drained).toBe(true);
  });

  it('Sources shutdown 必须等待已经获准的 IPC 调用排水后再释放 repository', async () => {
    const admission = new SourcesIpcAdmission();
    const release = admission.enter();
    expect(release).not.toBeNull();
    admission.beginShutdown();
    let drained = false;
    const pending = admission.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release?.();
    await pending;
    expect(drained).toBe(true);
  });
});
