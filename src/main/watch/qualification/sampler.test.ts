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

function setup() {
  const frames: QualificationFrame[] = [];
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
      onResumed: () => {},
      shutdown,
      completed,
    },
    fail,
  );
  return { sampler, frames, registry, clock, shutdown, completed, closeAdmission };
}

describe('资格采样器：可控时钟协议单元验证（不代替native/OS资格）', () => {
  it('短诊断sample闭合前拒绝owner变化，保留连续sequence与同token', async () => {
    const h = setup();
    h.sampler.startHeartbeat();
    h.sampler.startDiagnostic();
    await vi.advanceTimersByTimeAsync(10000);
    const sample = h.frames.find((frame) => frame.kind === 'sample');
    expect(sample?.kind).toBe('sample');
    expect(h.sampler.isAdmissionOpen()).toBe(false);
    expect(() => h.registry.register({ registry: 'watch-store', detail: null })).toThrow(
      'barrier-mutation',
    );
    expect(h.frames.some((frame) => frame.kind === 'sample-closed')).toBe(false);
    await vi.advanceTimersByTimeAsync(1001);
    const closed = h.frames.find((frame) => frame.kind === 'sample-closed');
    const resumed = h.frames.find((frame) => frame.kind === 'sample-resumed');
    expect(closed?.kind).toBe('sample-closed');
    expect(resumed?.kind).toBe('sample-resumed');
    if (
      sample?.kind !== 'sample' ||
      closed?.kind !== 'sample-closed' ||
      resumed?.kind !== 'sample-resumed'
    )
      throw new Error('协议缺帧');
    expect(closed.payload.sampleToken).toBe(sample.payload.sampleToken);
    expect(resumed.payload.sampleToken).toBe(sample.payload.sampleToken);
    expect(closed.payload.registryPrefixSequence).toBe(sample.payload.registryPrefixSequence);
    expect(h.frames.map((frame) => frame.sequence)).toEqual(
      h.frames.map((_frame, index) => index + 1),
    );
    expect(h.sampler.isAdmissionOpen()).toBe(true);
    await vi.advanceTimersByTimeAsync(11000);
    expect(h.closeAdmission).toHaveBeenCalledOnce();
    expect(h.shutdown).toHaveBeenCalledOnce();
    expect(h.completed).toHaveBeenCalledOnce();
    expect(h.frames.at(-1)?.kind).toBe('complete');
    expect(h.sampler.isAdmissionOpen()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
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
  it('普通资格构建不能调用缩短窗口入口', () => {
    vi.stubGlobal('__WATCH_QUALIFICATION_DIAGNOSTIC__', false);
    expect(() => setup().sampler.startDiagnostic()).toThrow('diagnostic-build-required');
  });
});
