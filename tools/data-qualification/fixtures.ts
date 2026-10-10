// Synthetic values only. Size samples are lower bounds, never universal maxima.
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export const STAMP = '2026-10-04T00:00:00.000Z';
export function fixtureId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
}
export function sourceInput(index: number) {
  const prefix = `https://example.invalid/${index}/`;
  return {
    scope: 'page' as const,
    url: prefix + 'x'.repeat(2048 - prefix.length),
    name: '界'.repeat(200),
    userNote: '界'.repeat(2000),
    aiNote: '界'.repeat(2000),
    tags: Array.from({ length: 20 }, (_, i) => `${i}`.padEnd(32, '界')),
  };
}
export function appendSources(db: DatabaseSync, from: number, until: number): void {
  const source = db.prepare(`INSERT INTO sources
    (id, scope, canonical_key, url, name, user_note, ai_note, created_at, updated_at)
    VALUES (?, 'page', ?, ?, ?, ?, ?, ?, ?)`);
  const tag = db.prepare('INSERT OR IGNORE INTO source_tags(id,name,created_at) VALUES (?,?,?)');
  const link = db.prepare('INSERT INTO source_tag_links(source_id,tag_id) VALUES (?,?)');
  db.exec('BEGIN');
  try {
    for (let i = from; i < until; i++) {
      const value = sourceInput(i);
      source.run(
        fixtureId(i),
        value.url,
        value.url,
        value.name,
        value.userNote,
        value.aiNote,
        STAMP,
        STAMP,
      );
      for (let n = 0; n < value.tags.length; n++) {
        tag.run(fixtureId(n), value.tags[n]!, STAMP);
        link.run(fixtureId(i), fixtureId(n));
      }
    }
    db.exec("INSERT INTO sources_fts(sources_fts) VALUES ('rebuild')");
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function researchRows(index: number) {
  const id = fixtureId(index);
  const resultId = fixtureId(index + 100);
  return {
    task: {
      id,
      goal: '界'.repeat(2000),
      status: 'completed' as const,
      phase: null,
      created_at: STAMP,
      updated_at: STAMP,
      started_at: STAMP,
      finished_at: STAMP,
      interrupted_at: null,
      error_code: null,
      result_id: resultId,
      stats_json: JSON.stringify({
        candidateCount: 0,
        selectedCount: 0,
        captureCount: 0,
        failedReadCount: 0,
        evidenceCount: 0,
        rejectedEvidenceCount: 0,
        claimCount: 0,
        conflictCount: 0,
        stepsUsed: 0,
        roundsUsed: 0,
      }),
    },
    result: {
      result_id: resultId,
      task_id: id,
      title: '界'.repeat(120),
      summary: '界'.repeat(2000),
      blocks_json: JSON.stringify([
        ...Array.from({ length: 19 }, () => ({ kind: 'markdown', text: '界'.repeat(4000) })),
        { kind: 'uncertain', text: '界'.repeat(1000), reason: '界'.repeat(1000) },
      ]),
      evidence_map_json: '{}',
      conflicts_json: '[]',
      coverage_json: JSON.stringify({
        total: 0,
        multiSource: 0,
        singleSource: 0,
        vendor: 0,
        thirdParty: 0,
        community: 0,
      }),
      fetched_at: STAMP,
    },
  };
}
export function populateResearch(db: DatabaseSync): void {
  const task = db.prepare('INSERT INTO research_tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const result = db.prepare('INSERT INTO research_results VALUES (?,?,?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    for (let i = 0; i < 30; i++) {
      const rows = researchRows(i);
      task.run(...Object.values(rows.task));
      result.run(...Object.values(rows.result));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function watchRuleInput(index: number) {
  return {
    id: fixtureId(index),
    sourceId: fixtureId(index),
    kind: 'feed' as const,
    state: 'paused' as const,
    pauseReason: 'user' as const,
    desiredEnabled: false,
    muted: false,
    accessMode: 'public' as const,
    schedule: { kind: 'interval' as const, intervalMinutes: 15 as const },
    target: { type: 'feed' as const, feedUrl: sourceInput(index).url, format: 'rss2' as const },
    condition: null,
    notificationLevel: 'normal' as const,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: createHash('sha256')
      .update(
        `watch-locator-v1\0${fixtureId(index)}\0page\0${sourceInput(index).url}\0feed\0${sourceInput(index).url}`,
        'utf8',
      )
      .digest('hex'),
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: STAMP,
    updatedAt: STAMP,
    ruleVersion: 1,
    notificationShowDetails: false,
  };
}
export function populateWatch(db: DatabaseSync): void {
  const insert = db.prepare(`INSERT INTO watch_rules
    (id,source_id,kind,state,pause_reason,desired_enabled,muted,access_mode,schedule_json,
    target_json,notification_level,source_locator_fingerprint,created_at,updated_at)
    VALUES (?,?,'feed','paused','user',0,0,'public',?,?,'normal',?,?,?)`);
  db.exec('BEGIN');
  try {
    for (let i = 0; i < 200; i++) {
      const row = watchRuleInput(i);
      insert.run(
        row.id,
        row.sourceId,
        JSON.stringify(row.schedule),
        JSON.stringify(row.target),
        row.sourceLocatorFingerprint,
        STAMP,
        STAMP,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function conversationMessage(content: string) {
  return {
    id: fixtureId(0),
    role: 'assistant' as const,
    content,
    createdAt: 0,
    status: 'complete' as const,
  };
}
export function jsonShape(root: unknown) {
  const stack = [{ value: root, depth: 1 }];
  let depth = 0;
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    nodes++;
    depth = Math.max(depth, item.depth);
    if (item.value !== null && typeof item.value === 'object') {
      for (const value of Object.values(item.value)) stack.push({ value, depth: item.depth + 1 });
    }
  }
  return { depth, nodes };
}
