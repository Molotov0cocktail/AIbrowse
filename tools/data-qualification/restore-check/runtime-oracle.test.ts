import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSmallFixture } from '../product-restore-fixtures/seed';
import { readSmallSnapshot, verifySmallSnapshot } from '../product-restore-fixtures/oracle';
import { verifyRuntimeSnapshot } from './runtime-oracle';

const parent = mkdtempSync(join(tmpdir(), 'aibrowse-runtime-oracle-'));
const root = join(parent, 'A');
createSmallFixture(root, 'A');
const baseline = readSmallSnapshot(root, 'A').snapshot;
const instant = Date.parse('2026-10-10T12:00:00.000Z');
const audit = {
  id: '00000000-0000-4000-8000-000000000001',
  rule_id: null,
  kind: 'reconciliation',
  reason_code: 'complete',
  created_at: new Date(instant).toISOString(),
};
const second = {
  ...audit,
  id: '00000000-0000-4000-8000-000000000002',
  created_at: new Date(instant + 1).toISOString(),
};
const value = () => ({ ...structuredClone(baseline), watch_audits: [{ ...audit }, { ...second }] });
describe('恢复检查保留正常生命周期审计事实', () => {
  it('旧纯夹具oracle拒绝正常新增审计，新分层oracle逐字段接受精确两条', () => {
    expect(() => verifySmallSnapshot(value(), 'A', 'source')).toThrow();
    const result = verifyRuntimeSnapshot(value(), 'A', 'source', 2, instant - 1, instant + 2);
    expect(result.audits).toEqual([audit, second]);
  });
  it.each([
    { kind: 'source-disabled' },
    { reason_code: 'aborted' },
    { rule_id: 'A-rule' },
    { id: second.id },
    { created_at: new Date(instant - 2).toISOString() },
    { created_at: new Date(instant + 3).toISOString() },
    { arbitrary: true },
  ])('拒绝审计污染%j', (mutation) => {
    const changed = value();
    Object.assign(changed.watch_audits[0]!, mutation);
    expect(() =>
      verifyRuntimeSnapshot(changed, 'A', 'source', 2, instant - 1, instant + 2),
    ).toThrow();
  });
  it('拒绝多条或少条审计', () => {
    for (const count of [1, 3])
      expect(() =>
        verifyRuntimeSnapshot(value(), 'A', 'source', count, instant - 1, instant + 2),
      ).toThrow();
  });
  it.each([0, 1])('拒绝任一继承审计身份被替换（%i）', (index) => {
    const old = verifyRuntimeSnapshot(value(), 'A', 'source', 2, instant - 1, instant + 2).audits;
    const changed = value();
    changed.watch_audits[index]!.id = '00000000-0000-4000-8000-000000000099';
    expect(() =>
      verifyRuntimeSnapshot(changed, 'A', 'source', 2, instant - 1, instant + 2, old),
    ).toThrow();
  });
  it('正常审计不能掩盖其它业务数据被修改', () => {
    const changed = value() as Record<string, unknown>;
    changed.watch_rules = [];
    expect(() =>
      verifyRuntimeSnapshot(changed, 'A', 'source', 2, instant - 1, instant + 2),
    ).toThrow();
  });
});
