import { describe, expect, it } from 'vitest';
import { readEvidence } from './read-evidence.ts';
import { reportResources } from './resource-report.ts';

function raw(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [
    {
      version: 1,
      kind: 'meta',
      runId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      qpcFrequency: 1000,
      processors: 4,
      m0: '100000',
      m1: '3700000',
      mode: 'formal',
      powerNotifications: true,
    },
  ];
  for (let slot = 0; slot <= 360; ++slot) {
    const base = {
      version: 1,
      phase: 'measurement',
      slot,
      beginQpc: String(100000 + slot * 10000),
      endQpc: String(100000 + slot * 10000),
      status: 'ok',
    };
    rows.push(
      { ...base, kind: 'attempt', powerTransitionCount: 0, tickCount64: String(slot * 10000) },
      { ...base, kind: 'cpu', total100ns: String(slot * 4000000) },
      { ...base, kind: 'members', before: [], after: [], members: [], stable: true },
    );
  }
  rows.push({
    version: 1,
    kind: 'attempt',
    phase: 'drain',
    slot: 0,
    beginQpc: '3700000',
    endQpc: '3700000',
    status: 'ok',
    powerTransitionCount: 0,
    tickCount64: '3600000',
  });
  return rows;
}
const parse = (rows: Record<string, unknown>[]): ReturnType<typeof readEvidence> =>
  readEvidence(rows.map((row) => JSON.stringify(row)).join('\n'), '');
describe('原始JSONL的资源证据门', () => {
  it('缺少暂停订阅不能授资源PASS', () => {
    const rows = raw();
    rows[0]!.powerNotifications = false;
    expect(reportResources(parse(rows).resources).verdict).toBe('BLOCKED/evidence-insufficient');
  });
  it('缺暂停计数的attempt不能先加入有效节拍', () => {
    const rows = raw();
    for (const row of rows) if (row.kind === 'attempt') delete row.powerTransitionCount;
    const evidence = parse(rows);
    expect(evidence.resources.attempts).toHaveLength(0);
    expect(reportResources(evidence.resources).verdict).toBe('BLOCKED/evidence-insufficient');
  });
  it('实际暂停通知改变使持续窗口无效', () => {
    const rows = raw();
    for (const row of rows)
      if (row.kind === 'attempt' && Number(row.slot) >= 100) row.powerTransitionCount = 1;
    expect(reportResources(parse(rows).resources).verdict).toBe('BLOCKED/evidence-insufficient');
  });
  it('不把观测器成本从产品CPU扣除', () => {
    const rows = raw();
    rows.push({
      version: 1,
      kind: 'observer-summary',
      parentCpu100ns: '900000000',
      workerCpu100ns: '900000000',
    });
    const evidence = parse(rows);
    expect(evidence.issues).toEqual([]);
    expect(reportResources(evidence.resources).cpuPercent.statistics!.median).toBe(1);
  });
  it('末次measurement之后到M1的未知暂停不能放过', () => {
    const rows = raw();
    rows.at(-1)!.powerTransitionCount = 1;
    expect(reportResources(parse(rows).resources).verdict).toBe('BLOCKED/evidence-insufficient');
  });
});
