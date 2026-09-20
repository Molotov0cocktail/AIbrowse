import { describe, expect, it } from 'vitest';
import { formatQpcTicks, QualificationQpcClock } from './qpc';
import { QualificationRunTiming } from './run-timing';

function fixture() {
  const base = 1_000_000_000n;
  let ticks = base + 123n;
  const clock = new QualificationQpcClock(
    { readQpc: () => ({ ticks: formatQpcTicks(ticks), frequency: 10_000_000 }) },
    10_000_000,
    formatQpcTicks(base),
    100_000,
  );
  const timing = new QualificationRunTiming(clock, (code) => {
    throw new Error(code);
  });
  const entry = timing.begin('run');
  return {
    timing,
    clock,
    at: (ms: number) => {
      ticks = base + 123n + BigInt(Math.round(ms * 10_000));
    },
    tick: (ms: number) => formatQpcTicks(base + 123n + BigInt(Math.round(ms * 10_000))),
    entry,
  };
}

describe('raw QPC完整acquisition及既有预算（不替代OS真实时序证据）', () => {
  it('保留非整数毫秒entry，最早28秒，timer/二次校验共享同一500毫秒', () => {
    const h = fixture();
    expect(h.entry).toBe(formatQpcTicks(1_000_000_123n));
    h.at(27_999.9999);
    expect(() => h.timing.acquired('run')).toThrow('acquisition-settlement-deadline');
    h.at(28_100);
    h.timing.acquired('run');
    h.at(28_300);
    h.timing.revalidated('run');
    h.at(28_499);
    h.timing.entered('run', h.clock.now().toISOString(), null);
    h.at(28_998);
    h.timing.committed('run');
    h.timing.released('run', null);
  });
  it('迟到499毫秒之后的二次校验不得重新获得500毫秒预算', () => {
    const h = fixture();
    h.at(28_499);
    h.timing.acquired('run');
    h.timing.revalidated('run');
    h.at(28_501);
    expect(() => h.timing.entered('run', h.clock.now().toISOString(), null)).toThrow(
      'processing-entry-deadline',
    );
  });
  it('只有真正跨D的barrier补偿resume减D，Sessionclose也消耗同一预算', () => {
    const h = fixture();
    h.at(29_000);
    h.timing.barrierResumed(h.tick(27_990), h.tick(29_000));
    h.at(29_050);
    h.timing.sessionClosed('run');
    h.timing.acquired('run');
    h.at(29_499);
    h.timing.revalidated('run');
    h.timing.entered('run', h.clock.now().toISOString(), null);
    h.at(29_998);
    h.timing.committed('run');
    h.timing.released('run', null);
  });
  it.each([
    [27_000, 27_999],
    [10_000, 11_000],
  ])('跨27秒或更早的barrier不得额外补偿：%j', (pause, resume) => {
    const h = fixture();
    h.at(resume);
    h.timing.barrierResumed(h.tick(pause), h.tick(resume));
    h.at(28_501);
    expect(() => h.timing.acquired('run')).toThrow('acquisition-settlement-deadline');
  });
  it('普通late-close不重开预算，close已超500立即失败', () => {
    const h = fixture();
    h.at(28_499);
    h.timing.sessionClosed('run');
    h.at(28_501);
    expect(() => h.timing.sessionClosed('run')).toThrow('session-close-deadline');
  });
  it('原始barrier>2250毫秒、未来结束或重叠记录均拒绝', () => {
    const h = fixture();
    h.at(31_000);
    expect(() => h.timing.barrierResumed(h.tick(27_999), h.tick(30_250))).toThrow(
      'run-barrier-timing',
    );
    expect(() => h.timing.barrierResumed(h.tick(30_000), h.tick(31_001))).toThrow(
      'run-barrier-timing',
    );
    h.timing.barrierResumed(h.tick(29_000), h.tick(30_000));
    expect(() => h.timing.barrierResumed(h.tick(29_999), h.tick(31_000))).toThrow(
      'run-barrier-timing',
    );
  });
  it('Event相对release33500毫秒仍单独拒绝，不被entry或barrier补偿放宽', () => {
    const h = fixture();
    h.at(28_100);
    h.timing.acquired('run');
    h.timing.revalidated('run');
    expect(() => h.timing.entered('run', h.clock.now().toISOString(), 94_599)).toThrow(
      'event-observation-deadline',
    );
  });
  it('事务已提交也不得给slot释放重新获得500毫秒', () => {
    const h = fixture();
    h.at(28_000);
    h.timing.acquired('run');
    h.timing.revalidated('run');
    h.timing.entered('run', h.clock.now().toISOString(), null);
    h.at(28_100);
    h.timing.committed('run');
    h.at(28_501);
    expect(() => h.timing.released('run', null)).toThrow('processing-slot-release-deadline');
  });
});
