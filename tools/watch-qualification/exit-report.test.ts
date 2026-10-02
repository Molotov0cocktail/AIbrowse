import { describe, expect, it } from 'vitest';
import { reportExit } from './exit-report.ts';
import type { RawObservation } from './read-evidence.ts';
import type { Window } from './resource-report.ts';

const window: Window = {
  mode: 'formal',
  beginQpc: '100000',
  endQpc: '3700000',
  qpcFrequency: 1000,
  processors: 4,
};
function fixture(): RawObservation[] {
  return Array.from({ length: 61 }, (_, slot) => {
    const base = {
      version: 1 as const,
      slot,
      phase: 'drain' as const,
      beginQpc: String(3700000 + slot * 10000),
      endQpc: String(3700000 + slot * 10000),
      status: 'ok' as const,
    };
    return [
      {
        ...base,
        kind: 'exit',
        rootExited: true,
        rootExitCode: 0,
        activeProcesses: 0,
        stdoutEof: true,
        stderrEof: true,
        telemetryEof: true,
      },
      {
        ...base,
        kind: 'files',
        tempEntries: 0,
        dbExists: true,
        dbExclusive: true,
        dbFileId: 'db-identity',
        walExists: false,
        shmExists: false,
      },
    ];
  }).flat();
}
describe('退出独立报告', () => {
  it('需要61点、真实Job零、双EOF及数据库独占释放', () => {
    expect(reportExit(window, fixture(), true).verdict).toBe('PASS');
    expect(reportExit(window, fixture(), false).verdict).toBe('BLOCKED/evidence-insufficient');
  });
  it('子进程/DB/临时文件残留六十秒后均判实际失败', () => {
    for (const mutate of [
      (rows: RawObservation[]) => {
        rows[20]!.activeProcesses = 1;
      },
      (rows: RawObservation[]) => {
        rows[21]!.dbExclusive = false;
      },
      (rows: RawObservation[]) => {
        rows[21]!.tempEntries = 1;
      },
    ]) {
      const rows = fixture();
      mutate(rows);
      expect(reportExit(window, rows, true).verdict).toBe('FAIL-product');
    }
  });
  it('最后观察越过drain边界、缺样、假删除不能通过', () => {
    const late = fixture();
    late.at(-1)!.endQpc = '4300001';
    expect(reportExit(window, late, true).verdict).toBe('BLOCKED/evidence-insufficient');
    const missing = fixture();
    missing.splice(15, 1);
    expect(reportExit(window, missing, true).verdict).toBe('BLOCKED/evidence-insufficient');
    const deleted = fixture();
    for (const row of deleted)
      if (row.kind === 'files') {
        row.dbExists = false;
        row.dbFileId = null;
      }
    expect(reportExit(window, deleted, true).verdict).toBe('BLOCKED/evidence-insufficient');
  });
  it('pipe残余只判协议缺证，不能冒充产品泄漏', () => {
    const rows = fixture();
    for (const row of rows) if (row.kind === 'exit') row.telemetryEof = false;
    expect(reportExit(window, rows, true).verdict).toBe('BLOCKED/evidence-insufficient');
    expect(reportExit(window, rows, true).violations).toEqual([]);
  });
  it('同slot另一指标缺证时仍报告已观测的残余进程或DB占用', () => {
    const process = fixture();
    process[20]!.activeProcesses = 1;
    process.splice(21, 1);
    expect(reportExit(window, process, true).verdict).toBe('FAIL-product');
    const db = fixture();
    db[21]!.dbExclusive = false;
    db.splice(20, 1);
    expect(reportExit(window, db, true).verdict).toBe('FAIL-product');
  });
  it('第一条形状无效不占据该slot的第一有效观察', () => {
    const rows = fixture();
    const invalid = { ...rows[20]! };
    delete invalid.activeProcesses;
    rows.splice(20, 0, invalid);
    expect(reportExit(window, rows, true).verdict).toBe('PASS');
  });
});
