import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  QualificationFrame,
  QualificationNativeBridge,
  QualificationRuntimeCapability,
} from './native-contract';
import { QualificationQpcClock, formatQpcTicks } from './qpc';
import { QualificationPausableClock } from './pausable-clock';
import { QualificationRegistry } from './registry';
import { QualificationSequencer } from './telemetry';
import { QualificationSampler } from './sampler';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100000);
  vi.stubGlobal('__WATCH_QUALIFICATION_DIAGNOSTIC__', true);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(holdWrites = false) {
  const frames: QualificationFrame[] = [];
  const pendingWrites: (() => void)[] = [];
  const readQpc = () => ({ ticks: formatQpcTicks(BigInt(Date.now()) * 1000n), frequency: 1000000 });
  const native: QualificationNativeBridge = {
    readQpc,
    prepareLaunchIsolation: () => {
      throw new Error('本单元测试不产生native授权');
    },
    authenticateLaunchAndConnectTelemetry: async () => {
      throw new Error('本单元测试不产生native授权');
    },
    closeTelemetry: async () => {},
    writeTelemetryFrame: async (_capability, frame) => {
      frames.push(frame);
      if (holdWrites) await new Promise<void>((resolve) => pendingWrites.push(resolve));
      return { sequence: frame.sequence, writeCompletedQpcTicks: readQpc().ticks };
    },
  };
  const fail = (code: string): never => {
    throw new Error(code);
  };
  const qpc = new QualificationQpcClock(native, 1000000, readQpc().ticks, Date.now());
  const sequencer = new QualificationSequencer(
    native,
    {} as QualificationRuntimeCapability,
    'UNIT-TEST',
    fail,
  );
  const registry = new QualificationRegistry((kind, event) => {
    void sequencer.send(kind, event);
  }, fail);
  const clock = new QualificationPausableClock(qpc, registry);
  const shutdown = vi.fn(async () => {});
  const completed = vi.fn(async () => {});
  const closeAdmission = vi.fn();
  const sampler = new QualificationSampler(
    qpc,
    clock,
    registry,
    sequencer,
    {
      snapshot: () => ({
        mainHeapUsedBytes: 1,
        nodeActiveByType: [],
        taskTabBindings: [],
        watchLogicalDbBytes: 0,
        webContentsIds: [],
      }),
      closeAdmission,
      shutdown,
      completed,
    },
    fail,
  );
  return { sampler, frames, registry, clock, shutdown, completed, closeAdmission, pendingWrites };
}

describe('资格采样器：可控时钟协议单元验证（不代替native/OS资格）', () => {
  it('writer未完成时照常采样，业务timer不重排，registry后续变化不污染已取prefix', async () => {
    const h = setup(true);
    const fired: string[] = [];
    h.clock.forOwner('qualification-fixture').setTimeout(() => fired.push('fixture'), 10001);
    h.clock.forOwner('digest-scheduler').setTimeout(() => fired.push('digest'), 10001);
    h.sampler.startHeartbeat();
    h.sampler.startDiagnostic();
    await vi.advanceTimersByTimeAsync(10000);
    const sample = h.frames.find((frame) => frame.kind === 'sample');
    expect(sample?.kind).toBe('sample');
    expect(h.sampler.isAdmissionOpen()).toBe(true);
    const owner = h.registry.register({ registry: 'watch-store', detail: null });
    h.registry.unregister(owner);
    expect(h.frames.some((frame) => frame.kind === 'sample-closed')).toBe(false);
    expect(h.frames.some((frame) => frame.kind === 'sample-resumed')).toBe(false);
    if (sample?.kind !== 'sample') throw new Error('协议缺帧');
    expect(sample.payload.registryPrefixSequence).toBe(sample.sequence - 1);
    expect(
      sample.payload.registryLive.find((row) => row.registry === 'watch-store')?.identities,
    ).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toEqual(['fixture', 'digest']);
    const timerRegistrations = h.frames.filter(
      (frame) =>
        frame.kind === 'register' &&
        (frame.payload.registry === 'watch-owner-timer' ||
          frame.payload.registry === 'digest-timer'),
    );
    expect(timerRegistrations).toHaveLength(2);
    expect(h.frames.map((frame) => frame.sequence)).toEqual(
      h.frames.map((_frame, index) => index + 1),
    );
    await vi.advanceTimersByTimeAsync(9999);
    expect(h.closeAdmission).toHaveBeenCalledOnce();
    expect(h.shutdown).toHaveBeenCalledOnce();
    for (const resolve of h.pendingWrites) resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.completed).toHaveBeenCalledOnce();
    expect(h.frames.at(-1)?.kind).toBe('complete');
    expect(h.sampler.isAdmissionOpen()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('正式末点在M1之前，M1独立停止不等待writer，shutdown后的快照只归drain', async () => {
    const h = setup();
    const m0 = Date.now() + 600000;
    h.sampler.start(m0);
    await vi.advanceTimersByTimeAsync(4199000);
    const formal = h.frames.filter(
      (frame) => frame.kind === 'sample' && frame.payload.phase === 'measurement',
    );
    expect(formal).toHaveLength(361);
    const last = formal.at(-1);
    if (last?.kind !== 'sample') throw new Error('协议缺帧');
    expect(last.slotIndex).toBe(360);
    expect(last.payload.timing.snapshotQpcTicks < last.payload.timing.slotQpcTicks).toBe(true);
    expect(h.sampler.isAdmissionOpen()).toBe(true);
    expect(h.closeAdmission).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.closeAdmission).toHaveBeenCalledOnce();
    expect(h.shutdown).toHaveBeenCalledOnce();
    const stop = h.frames.find((frame) => frame.kind === 'stop');
    expect(stop?.kind).toBe('stop');
    expect(
      h.frames.filter(
        (frame) =>
          frame.kind === 'sample' &&
          frame.payload.phase === 'measurement' &&
          frame.sequence > stop!.sequence,
      ),
    ).toEqual([]);
    expect(
      h.frames.some(
        (frame) =>
          frame.kind === 'sample' && frame.payload.phase === 'drain' && frame.slotIndex === 0,
      ),
    ).toBe(true);
  });
  it('即使stop定时器尚未回调，M1时刻也拒绝新admission', () => {
    const h = setup();
    const m0 = Date.now() + 1440000;
    h.sampler.start(m0);
    vi.setSystemTime(m0 + 3600000 - 1);
    expect(h.sampler.isAdmissionOpen()).toBe(true);
    vi.setSystemTime(m0 + 3600000);
    expect(h.sampler.isAdmissionOpen()).toBe(false);
    expect(h.closeAdmission).not.toHaveBeenCalled();
  });
  it('迟到快照保留实际QPC，继续固定slot，不补零或重定目标洗掉缺样', async () => {
    const h = setup();
    h.sampler.startDiagnostic();
    vi.setSystemTime(Date.now() + 3000);
    await vi.advanceTimersByTimeAsync(10000);
    const sample = h.frames.find((frame) => frame.kind === 'sample');
    if (sample?.kind !== 'sample') throw new Error('协议缺帧');
    expect(sample.payload.timing.slotQpcTicks).toBe(formatQpcTicks(110000000n));
    expect(sample.payload.timing.linearizedQpcTicks).toBe(formatQpcTicks(113000000n));
    expect(h.sampler.isAdmissionOpen()).toBe(true);
    await vi.advanceTimersByTimeAsync(6000);
    expect(h.frames.filter((frame) => frame.kind === 'sample')).toHaveLength(2);
  });
  it('普通资格构建不能调用缩短窗口入口', () => {
    vi.stubGlobal('__WATCH_QUALIFICATION_DIAGNOSTIC__', false);
    expect(() => setup().sampler.startDiagnostic()).toThrow('diagnostic-build-required');
  });
});
