import {
  snapshotHashes,
  verifySmallSnapshot,
  type Mode,
  type Snapshot,
} from '../product-restore-fixtures/oracle';
import type { Variant } from '../product-restore-fixtures/seed';
import { need } from './contract';

export interface RuntimeAudit {
  id: string;
  rule_id: null;
  kind: 'reconciliation';
  reason_code: 'complete';
  created_at: string;
}
/** Ordinary startup and maintenance drain each add one reconciliation audit.
 * Verified-transfer health assembly does not reconcile again.
 * Validate that narrow projection separately; every other table still uses the
 * unchanged frozen oracle, including H's interrupted/uncertain history.
 */
export function verifyRuntimeSnapshot(
  snapshot: Snapshot,
  variant: Variant,
  mode: Mode,
  count: number,
  startedAt: number,
  endedAt: number,
  inherited: readonly RuntimeAudit[] = [],
): { hashes: Record<string, string>; audits: RuntimeAudit[] } {
  const rows = snapshot.watch_audits;
  need(Array.isArray(rows) && rows.length === count, '生命周期审计数量不符');
  const audits: RuntimeAudit[] = [];
  for (const item of rows) {
    need(item !== null && typeof item === 'object' && !Array.isArray(item));
    const row = item as Record<string, unknown>;
    need(Object.keys(row).sort().join('|') === 'created_at|id|kind|reason_code|rule_id');
    need(
      typeof row.id === 'string' &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(row.id),
    );
    need(row.rule_id === null && row.kind === 'reconciliation' && row.reason_code === 'complete');
    need(typeof row.created_at === 'string');
    const instant = Date.parse(row.created_at);
    need(
      Number.isFinite(instant) &&
        new Date(instant).toISOString() === row.created_at &&
        instant >= startedAt &&
        instant <= endedAt,
      '生命周期审计时间不符',
    );
    need(
      audits.every((audit) => audit.id !== row.id),
      '生命周期审计身份重复',
    );
    audits.push(row as unknown as RuntimeAudit);
  }
  for (const old of inherited)
    need(
      audits.some((row) =>
        Object.keys(old).every(
          (key) => row[key as keyof RuntimeAudit] === old[key as keyof RuntimeAudit],
        ),
      ),
      '既有生命周期审计丢失或改变',
    );
  const canonical = { ...snapshot, watch_audits: [] };
  verifySmallSnapshot(canonical, variant, mode);
  return { hashes: snapshotHashes(canonical), audits };
}
