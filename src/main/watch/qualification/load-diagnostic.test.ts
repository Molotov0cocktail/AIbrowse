import { afterEach, expect, it, vi } from 'vitest';
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

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('独立load诊断固定10/20/30/40秒四个barrier，40秒谓词先于callback关闭准入', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  vi.stubGlobal('__WATCH_QUALIFICATION_DIAGNOSTIC__', true);
  vi.stubGlobal('__WATCH_QUALIFICATION_LOAD_DIAGNOSTIC__', true);
  const frames: QualificationFrame[] = [];
  const readQpc = () => ({
    ticks: formatQpcTicks(BigInt(Date.now()) * 1000n),
    frequency: 1_000_000,
  });
  const unused = (): never => {
    throw new Error('诊断单元测试不产生native授权');
  };
  const native: QualificationNativeBridge = {
    readQpc,
    prepareLaunchIsolation: unused,
    authenticateLaunchAndConnectTelemetry: unused,
    closeTelemetry: async () => {},
    writeTelemetryFrame: async (_cap, frame) => {
      frames.push(frame);
      return { sequence: frame.sequence, writeCompletedQpcTicks: readQpc().ticks };
    },
  };
  const fail = (code: string): never => {
    throw new Error(code);
  };
  const qpc = new QualificationQpcClock(native, 1_000_000, readQpc().ticks, Date.now());
  const sequencer = new QualificationSequencer(
    native,
    {} as QualificationRuntimeCapability,
    'TEST',
    fail,
  );
  const registry = new QualificationRegistry((kind, row) => {
    void sequencer.send(kind, row);
  }, fail);
  const shutdown = vi.fn(async () => {});
  const sampler = new QualificationSampler(
    qpc,
    new QualificationPausableClock(qpc, registry),
    registry,
    sequencer,
    {
      snapshot: () => ({
        mainHeapUsedBytes: 0,
        nodeActiveByType: [],
        taskTabBindings: [],
        watchLogicalDbBytes: 0,
        webContentsIds: [],
      }),
      closeAdmission: () => {},
      onResumed: () => {},
      shutdown,
      completed: async () => {},
    },
    fail,
  );
  sampler.startLoadDiagnostic();
  await vi.advanceTimersByTimeAsync(31_001);
  expect(frames.filter((row) => row.kind === 'sample')).toHaveLength(3);
  expect(frames.filter((row) => row.kind === 'sample-closed')).toHaveLength(3);
  const current = Date.now();
  vi.setSystemTime(140_000);
  expect(sampler.isAdmissionOpen()).toBe(false);
  expect(shutdown).not.toHaveBeenCalled();
  vi.setSystemTime(current);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(frames.filter((row) => row.kind === 'sample')).toHaveLength(4);
  expect(frames.filter((row) => row.kind === 'sample-resumed')).toHaveLength(4);
  expect(frames.at(-1)?.kind).toBe('complete');
  expect(shutdown).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it('独立load入口拒绝普通及原空载诊断编译模式', () => {
  vi.stubGlobal('__WATCH_QUALIFICATION_DIAGNOSTIC__', true);
  vi.stubGlobal('__WATCH_QUALIFICATION_LOAD_DIAGNOSTIC__', false);
  expect(() =>
    QualificationSampler.prototype.startLoadDiagnostic.call({
      fail: (code: string) => {
        throw new Error(code);
      },
    } as unknown as QualificationSampler),
  ).toThrow('diagnostic-build-required');
});
