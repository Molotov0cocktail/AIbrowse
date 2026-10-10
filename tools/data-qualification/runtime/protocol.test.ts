import { describe, expect, it } from 'vitest';
import { BUDGET, FIXTURE, STAGES, isBuildId, validateUiPhase } from './contract';
import {
  FrameBudget,
  ScanOperation,
  parseMainFrame,
  parseWorkerFrame,
  type ScanResult,
} from './protocol';

const id = 'a'.repeat(32);
const frame = (value: object) => JSON.stringify({ version: 1, operationId: id, ...value });
const result: ScanResult = {
  counts: [5000, 30, 200, 2800, 8400, 1030, 50],
  stageMs: STAGES.map(() => 1),
  rssPeakBytes: 1024,
  migrationCases: FIXTURE.migrationCases,
  versions: [1, 1, 5],
  sourceIndexRebuilt: true,
  inputsUnchanged: true,
};

function completedMessages() {
  const gate = new ScanOperation(id);
  expect(gate.send('init')).not.toBeNull();
  expect(gate.receive(frame({ kind: 'ready' }))).not.toBeNull();
  for (const [index, stage] of STAGES.entries())
    expect(gate.receive(frame({ kind: 'stage', stage, elapsedMs: index + 1 }))).not.toBeNull();
  expect(gate.receive(frame({ kind: 'result', result }))).not.toBeNull();
  return gate;
}

describe('固定语义扫描协议', () => {
  it('完整8阶段且真实exit0才接受；完整结果适合4KiB帧', () => {
    const gate = completedMessages();
    expect(gate.accepted()).toBe(false);
    expect(gate.budget.count).toBe(11);
    expect(Buffer.byteLength(frame({ kind: 'result', result }))).toBeLessThan(BUDGET.frameBytes);
    gate.confirmExit(0);
    expect(gate.accepted()).toBe(true);
  });

  it('4096字节恰好计费，4097字节拒绝且不保留正文', () => {
    const ledger = new FrameBudget();
    expect(ledger.record('x'.repeat(4096))).toBe(true);
    expect(ledger.record('x'.repeat(4097))).toBe(false);
    expect(parseWorkerFrame('x'.repeat(4097), id)).toBeNull();
  });

  it('16帧/64KiB恰好计费，第17帧拒绝且预算不可重置', () => {
    const ledger = new FrameBudget();
    for (let i = 0; i < 16; i++) expect(ledger.record('x'.repeat(4096))).toBe(true);
    expect(ledger.bytes).toBe(65536);
    expect(ledger.record('')).toBe(false);
    expect(ledger.record('')).toBe(false);
    expect(ledger.count).toBe(17);
  });

  it('预算按UTF-8字节计，不按JS字符数', () => {
    expect(new FrameBudget().record('界'.repeat(1366))).toBe(false);
  });

  it.each([
    { kind: 'init', path: 'C:/private' },
    { kind: 'init', sql: 'SELECT 1' },
    { kind: 'init', command: 'run' },
    { kind: 'other' },
  ])('控制帧没有任意路径/SQL/动作通道 %j', (value) => {
    expect(parseMainFrame(frame(value), id)).toBeNull();
  });

  it('错operation、重复键及结果中的额外字段一律拒绝', () => {
    expect(parseWorkerFrame(frame({ kind: 'ready' }), 'b'.repeat(32))).toBeNull();
    expect(
      parseWorkerFrame(`{"version":0,"version":1,"operationId":"${id}","kind":"ready"}`, id),
    ).toBeNull();
    expect(
      parseWorkerFrame(frame({ kind: 'result', result: { ...result, path: 'private' } }), id),
    ).toBeNull();
    expect(
      parseWorkerFrame(
        frame({
          kind: 'result',
          result: { ...result, counts: [5000, 0, 200, 2800, 8400, 1030, 50] },
        }),
        id,
      ),
    ).toBeNull();
  });

  it('取消后的迟到成功和exit0不能复活', () => {
    const gate = new ScanOperation(id);
    gate.send('init');
    gate.receive(frame({ kind: 'ready' }));
    expect(gate.send('cancel')).not.toBeNull();
    expect(gate.receive(frame({ kind: 'result', result }))).toBeNull();
    gate.confirmExit(0);
    expect(gate.accepted()).toBe(false);
    expect(gate.result).toBeNull();
    expect(gate.late).toBe(1);
  });

  it('缺失/错序阶段、重复终态及非零退出均拒绝', () => {
    const missing = new ScanOperation(id);
    missing.send('init');
    missing.receive(frame({ kind: 'ready' }));
    expect(missing.receive(frame({ kind: 'stage', stage: STAGES[1], elapsedMs: 1 }))).toBeNull();
    const duplicate = completedMessages();
    expect(duplicate.receive(frame({ kind: 'result', result }))).toBeNull();
    duplicate.confirmExit(0);
    expect(duplicate.accepted()).toBe(false);
    const nonzero = completedMessages();
    nonzero.confirmExit(1);
    expect(nonzero.accepted()).toBe(false);
  });
});

describe('真实UI样本判定及固定入口', () => {
  const samples = Array.from({ length: 6 }, (_, index) => ({
    sequence: index + 1,
    observedAt: index * 150 + 100,
    roundTripMs: 750,
  }));
  it('恰好阈值保留，两端空隙也计入', () => {
    expect(validateUiPhase(0, 1000, samples)).toEqual({
      ok: true,
      maxRoundTripMs: 750,
      maxGapMs: 150,
    });
    expect(validateUiPhase(0, 1851, samples).ok).toBe(false);
  });
  it('不足1秒/6样本、RTT超限、序号重放或非单调观测均失败', () => {
    expect(validateUiPhase(0, 999, samples).ok).toBe(false);
    expect(validateUiPhase(0, 1000, samples.slice(1)).ok).toBe(false);
    expect(
      validateUiPhase(
        0,
        1000,
        samples.map((s) => ({ ...s, roundTripMs: 751 })),
      ).ok,
    ).toBe(false);
    expect(
      validateUiPhase(
        0,
        1000,
        samples.map((s) => ({ ...s, sequence: 1 })),
      ).ok,
    ).toBe(false);
    expect(validateUiPhase(0, 1000, [...samples].reverse()).ok).toBe(false);
  });
  it('BuildId只接受固定名字；不是路径或命令入口', () => {
    expect(isBuildId(`runtime-${id}`)).toBe(true);
    for (const input of [
      'runtime-../private',
      `utility-${id}`,
      `runtime-${id}/data`,
      `runtime-${id};command`,
    ])
      expect(isBuildId(input)).toBe(false);
  });
});
