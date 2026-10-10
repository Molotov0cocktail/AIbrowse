import type { DatabaseSync } from 'node:sqlite';
import {
  MAX_DIGEST_SCHEDULE_SOURCES,
  MAX_WATCH_DB_BYTES,
  MAX_WATCH_RULES_TOTAL,
} from '../../../shared/types/watch';
import { computeSourceLocatorFingerprint } from '../../../shared/watch/watch-rule-state';
import { parseBoundedJson } from '../../storage/bounded-json';
import { validateRuleRow } from '../watch-row-validation';

const SQL = {
  unresolvedIntent:
    "SELECT 1 FROM source_cleanup_intents WHERE state IN ('prepared','source-committed') LIMIT 1",
  ruleCount: 'SELECT count(*) AS count FROM watch_rules',
  rules: 'SELECT * FROM watch_rules',
  source: 'SELECT version,enabled,deleted_at,scope,canonical_key FROM sources WHERE id = ?',
  schedules: 'SELECT source_ids_json FROM digest_schedules',
} as const;

export interface WatchSourceTransferCounts {
  rules: number;
  missingRuleSources: number;
  historicalRules: number;
  schedules: number;
  scheduleMembers: number;
  missingScheduleMembers: number;
}

export type WatchSourceTransferError =
  | 'unresolved-source-intent'
  | 'rule-source-missing'
  | 'rule-source-disabled'
  | 'rule-source-locator'
  | 'rule-source-version'
  | 'budget-exceeded'
  | 'snapshot-invalid';

export type WatchSourceTransferResult =
  { ok: true; counts: WatchSourceTransferCounts } | { ok: false; code: WatchSourceTransferError };

/**
 * Call only after both current-schema domain scanners pass on the same frozen
 * backup batch. The caller owns read-only handles, snapshot isolation, physical
 * limits, deadline and disposal. This is not an external-file reader.
 *
 * No Source collection is materialized: each lookup uses the primary key and
 * each schedule is released before advancing. Existing domain JSON/byte limits
 * remain prerequisites; the 200-rule limit is not a Source row-count limit.
 * No reconciliation, scheduling, Session authorization or repair runs here.
 */
export function validateWatchSourceTransfer(
  sources: DatabaseSync,
  watch: DatabaseSync,
): WatchSourceTransferResult {
  try {
    if (watch.prepare(SQL.unresolvedIntent).get()) {
      return { ok: false, code: 'unresolved-source-intent' };
    }
    const count = watch.prepare(SQL.ruleCount).get()?.count;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
      return { ok: false, code: 'snapshot-invalid' };
    }
    if (count > MAX_WATCH_RULES_TOTAL) return { ok: false, code: 'budget-exceeded' };
    const counts: WatchSourceTransferCounts = {
      rules: 0,
      missingRuleSources: 0,
      historicalRules: 0,
      schedules: 0,
      scheduleMembers: 0,
      missingScheduleMembers: 0,
    };
    const lookup = sources.prepare(SQL.source);
    for (const row of watch.prepare(SQL.rules).iterate()) {
      const validated = validateRuleRow(row);
      if (!validated.ok || validated.value === null) return { ok: false, code: 'snapshot-invalid' };
      const rule = validated.value;
      counts.rules++;
      if (counts.rules > MAX_WATCH_RULES_TOTAL) return { ok: false, code: 'budget-exceeded' };
      // Deleted rules are historical and coordination deliberately leaves them alone.
      if (rule.state === 'deleted') {
        counts.historicalRules++;
        continue;
      }
      const source = lookup.get(rule.sourceId);
      if (!source) {
        if (rule.state === 'enabled') return { ok: false, code: 'rule-source-missing' };
        // Unexpected missing Sources may retain paused rules and local Event history.
        counts.missingRuleSources++;
        continue;
      }
      if (source.version !== rule.sourceRowVersion) {
        return { ok: false, code: 'rule-source-version' };
      }
      // Coordination preserves an existing pause reason and an old locator until
      // rebaseline. It still observes the current Source version when one exists.
      if (rule.state === 'paused') continue;
      if (source.enabled !== 1 || source.deleted_at !== null) {
        return { ok: false, code: 'rule-source-disabled' };
      }
      if (
        (source.scope !== 'page' && source.scope !== 'origin') ||
        typeof source.canonical_key !== 'string'
      ) {
        return { ok: false, code: 'snapshot-invalid' };
      }
      const current = computeSourceLocatorFingerprint({
        sourceId: rule.sourceId,
        scope: source.scope,
        canonicalKey: source.canonical_key,
        kind: rule.kind,
        canonicalTargetUrl: rule.target.type === 'feed' ? rule.target.feedUrl : rule.target.pageUrl,
      });
      if (current !== rule.sourceLocatorFingerprint) {
        return { ok: false, code: 'rule-source-locator' };
      }
    }
    for (const row of watch.prepare(SQL.schedules).iterate()) {
      if (typeof row.source_ids_json !== 'string') {
        return { ok: false, code: 'snapshot-invalid' };
      }
      const ids = parseBoundedJson(row.source_ids_json, {
        bytes: MAX_WATCH_DB_BYTES,
        depth: 16,
        nodes: MAX_DIGEST_SCHEDULE_SOURCES + 1,
      });
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > MAX_DIGEST_SCHEDULE_SOURCES ||
        !ids.every((id): id is string => typeof id === 'string' && id.length > 0)
      ) {
        return { ok: false, code: 'snapshot-invalid' };
      }
      counts.schedules++;
      counts.scheduleMembers += ids.length;
      // Schedule membership is a fixed historical selection, even when active.
      // A completed hard delete scrubs Digest evidence, not these member IDs.
      for (const id of ids) if (!lookup.get(id)) counts.missingScheduleMembers++;
      if (!Number.isSafeInteger(counts.scheduleMembers)) {
        return { ok: false, code: 'budget-exceeded' };
      }
    }
    return { ok: true, counts };
  } catch {
    // SQLite, parsing and handle failures never expose stored text or identifiers.
    return { ok: false, code: 'snapshot-invalid' };
  }
}
