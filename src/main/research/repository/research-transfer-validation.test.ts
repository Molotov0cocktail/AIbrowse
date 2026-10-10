import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RESEARCH_MIGRATION_V1 } from '../db/research-migrations';
import { ZERO_TASK_STATS } from '../domain/research-task-state';
import { buildCandidateSortKey } from '../source-selector';
import { validate } from '../result-validator';
import { validateResearchTransfer } from './research-transfer-validation';
import {
  rowToCandidate,
  rowToCapture,
  rowToEvidence,
  rowToClaim,
  rowToConflict,
  type ResearchCandidateRow,
  type ResearchCaptureRow,
  type ResearchEvidenceRow,
  type ResearchClaimRow,
  type ResearchConflictRow,
} from './research-repository';
import { CAPTURE_EMPTY_CONTENT_HASH, type CaptureContent } from '../capture-service';
import { verifyEvidence } from '../evidence-validator';
import { processVerification } from '../synthesis/claim-model';

const TASK = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';
const CAPTURE = '33333333-3333-4333-8333-333333333333';
const EVIDENCE = '44444444-4444-4444-8444-444444444444';
const RESULT = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';
const NOW = '2026-10-01T00:00:00.000Z';
const URL = 'https://example.test/page';
const HASH = '0123456789abcdef0123456789abcdef';
let db: DatabaseSync;
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function context() {
  return {
    taskId: TASK,
    candidates: db
      .prepare('SELECT * FROM research_candidates')
      .all()
      .map((row) => rowToCandidate(row as unknown as ResearchCandidateRow)!),
    evidence: db
      .prepare('SELECT * FROM research_evidence')
      .all()
      .map((row) => rowToEvidence(row as unknown as ResearchEvidenceRow)!),
    claims: db
      .prepare('SELECT * FROM research_claims')
      .all()
      .map((row) => rowToClaim(row as unknown as ResearchClaimRow)!),
    conflicts: db
      .prepare('SELECT * FROM research_conflicts')
      .all()
      .map((row) => rowToConflict(row as unknown as ResearchConflictRow)!),
    verificationState: 'verified' as const,
    now: NOW,
    createId: () => RESULT,
  };
}

function complete(
  blocks: unknown[] = [{ kind: 'uncertain', text: '证据不足', reason: '需要核验' }],
): void {
  const checked = validate({ title: '研究结果', summary: '概述', blocks }, context());
  if (!checked.ok) throw new Error('结果夹具无效');
  const r = checked.result;
  db.prepare('INSERT INTO research_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    r.resultId,
    r.taskId,
    r.title,
    r.summary,
    JSON.stringify(r.blocks),
    JSON.stringify(r.evidenceMap),
    JSON.stringify(r.conflicts),
    JSON.stringify(r.coverage),
    r.fetchedAt,
  );
  db.prepare(
    "UPDATE research_tasks SET status='completed',phase=NULL,finished_at=?,result_id=?",
  ).run(NOW, RESULT);
  const ctx = context();
  const captures = db
    .prepare('SELECT count(*) AS total, sum(failed) AS failed FROM research_captures')
    .get()!;
  db.prepare('UPDATE research_tasks SET stats_json=?').run(
    JSON.stringify({
      ...ZERO_TASK_STATS,
      candidateCount: ctx.candidates.length,
      selectedCount: Math.min(8, ctx.candidates.length),
      captureCount: Number(captures.total),
      failedReadCount: Number(captures.failed),
      evidenceCount: ctx.evidence.length,
      claimCount: ctx.claims.length,
      conflictCount: ctx.conflicts.length,
    }),
  );
}

function full(): void {
  seed();
  const secondUrl = 'https://other.test/page';
  const sort = buildCandidateSortKey({
    tier: 3,
    inputRank: 1,
    priority: null,
    lastUsedAt: null,
    scope: 'page',
    canonicalKey: secondUrl,
    candidateId: id(1),
  });
  db.prepare(
    'INSERT INTO research_candidates SELECT ?,task_id,?,?,title,?,scope,discovered_via_json,source_id,trust_value,trust_asserted_by,trust_verification,priority,last_used_at,note,? FROM research_candidates',
  ).run(id(1), secondUrl, secondUrl, secondUrl, sort);
  db.prepare(
    'INSERT INTO research_captures SELECT ?,task_id,?,tab_id,?,title,access_time,document_id,content_hash,summary_json,failed,failure_reason FROM research_captures',
  ).run(id(2), id(1), secondUrl);
  db.prepare(
    'INSERT INTO research_evidence SELECT ?,task_id,?,source_id,?,?,title,access_time,document_id,content_hash,type,locator_json,excerpt,value,verification FROM research_evidence',
  ).run(id(3), id(1), id(2), secondUrl);
  let next = 10;
  const ctx = context();
  const checked = processVerification(
    JSON.stringify({
      vendorCandidateIds: [],
      claims: [
        { claimKey: 'a', text: '第一项', severity: 'high', evidenceIds: [EVIDENCE] },
        { claimKey: 'b', text: '第二项', severity: 'low', evidenceIds: [id(3)] },
      ],
      conflicts: [
        {
          topic: '说法不同',
          positions: [
            { positionText: '第一方', sourceRefs: [CANDIDATE] },
            { positionText: '第二方', sourceRefs: [id(1)] },
          ],
          claimKeys: ['a', 'b'],
        },
      ],
    }),
    { ...ctx, createId: () => id(next++) },
  );
  if (!checked.ok) throw new Error('结论夹具无效');
  for (const c of checked.claims)
    db.prepare('INSERT INTO research_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      c.claimId,
      c.taskId,
      c.text,
      c.severity,
      c.coverage,
      JSON.stringify(c.sourceTypes),
      JSON.stringify(c.evidenceIds),
      JSON.stringify(c.singleSourceFields),
      JSON.stringify(c.conflictIds),
    );
  for (const c of checked.conflicts)
    db.prepare('INSERT INTO research_conflicts VALUES (?, ?, ?, ?, ?, ?)').run(
      c.conflictId,
      c.taskId,
      c.topic,
      JSON.stringify(c.positions),
      JSON.stringify(c.claimIds),
      c.resolved,
    );
  complete();
}

function task(id = TASK): void {
  db.prepare('INSERT INTO research_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    '研究',
    'running',
    'reading',
    NOW,
    NOW,
    NOW,
    null,
    null,
    null,
    null,
    JSON.stringify(ZERO_TASK_STATS),
  );
}

function seed(): void {
  task();
  db.prepare(
    'INSERT INTO research_candidates VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    CANDIDATE,
    TASK,
    URL,
    URL,
    '来源',
    URL,
    'page',
    '["search"]',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    buildCandidateSortKey({
      tier: 3,
      inputRank: 0,
      priority: null,
      lastUsedAt: null,
      scope: 'page',
      canonicalKey: URL,
      candidateId: CANDIDATE,
    }),
  );
  db.prepare('INSERT INTO research_captures VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    CAPTURE,
    TASK,
    CANDIDATE,
    OTHER,
    URL,
    '网页',
    NOW,
    '1',
    HASH,
    JSON.stringify({ sectionCount: 1, tableCount: 0, headingCount: 0, charCount: 2 }),
    0,
    null,
  );
  db.prepare(
    'INSERT INTO research_evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    EVIDENCE,
    TASK,
    CANDIDATE,
    null,
    CAPTURE,
    URL,
    '网页',
    NOW,
    '1',
    HASH,
    'quote',
    JSON.stringify({ kind: 'text', excerpt: '事实' }),
    '事实',
    null,
    'verified',
  );
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  for (const sql of RESEARCH_MIGRATION_V1.statements) db.exec(sql);
});
afterEach(() => db.close());

describe('Research transfer semantic scan', () => {
  it('rejects oversized JSON before selecting any business row', () => {
    task();
    db.prepare('UPDATE research_tasks SET stats_json=?').run(' '.repeat(500001));
    const spy = vi.spyOn(db, 'prepare');
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false, code: 'budget-exceeded' });
    expect(spy).not.toHaveBeenCalledWith('SELECT * FROM research_tasks');
    spy.mockRestore();
  });
  it('rejects aggregate plain metadata over a task budget before selecting business values', () => {
    seed();
    const title = 'x'.repeat(260000);
    db.prepare('UPDATE research_captures SET title=?').run(title);
    db.prepare('UPDATE research_evidence SET title=?').run(title);
    const spy = vi.spyOn(db, 'prepare');
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false, code: 'budget-exceeded' });
    expect(spy).not.toHaveBeenCalledWith('SELECT * FROM research_tasks');
    spy.mockRestore();
  });
  it('preserves encoded long URLs in failed Capture sentinels', () => {
    seed();
    db.exec('DELETE FROM research_evidence');
    const raw = 'https://example.test/' + '界'.repeat(300);
    const display = new globalThis.URL(raw).href;
    const sort = buildCandidateSortKey({
      tier: 3,
      inputRank: 0,
      priority: null,
      lastUsedAt: null,
      scope: 'page',
      canonicalKey: display,
      candidateId: CANDIDATE,
    });
    db.prepare('UPDATE research_candidates SET url=?,display_url=?,canonical_key=?,sort_key=?').run(
      raw,
      display,
      display,
      sort,
    );
    db.prepare(
      "UPDATE research_captures SET url=?,title='来源',tab_id='unallocated',document_id='unavailable',content_hash=?,summary_json=?,failed=1,failure_reason='timeout'",
    ).run(
      display,
      CAPTURE_EMPTY_CONTENT_HASH,
      JSON.stringify({ sectionCount: 0, tableCount: 0, headingCount: 0, charCount: 0 }),
    );
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true });
  });
  it('rejects completed statistics that invent rows while preserving failed write-rollback counts', () => {
    task();
    complete();
    db.prepare('UPDATE research_tasks SET stats_json=?').run(
      JSON.stringify({ ...ZERO_TASK_STATS, candidateCount: 1 }),
    );
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false });
    db.exec(
      "DELETE FROM research_results; UPDATE research_tasks SET status='failed',result_id=NULL,error_code='research-internal'",
    );
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true });
  });
  it('accepts a complete seven-table graph made by the production validators', () => {
    full();
    expect(validateResearchTransfer(db)).toMatchObject({
      ok: true,
      counts: {
        tasks: 1,
        candidates: 2,
        captures: 2,
        evidence: 2,
        claims: 2,
        conflicts: 1,
        results: 1,
      },
    });
  });

  it.each([
    ['claim unnormalized text', "UPDATE research_claims SET text='  结论  '"],
    [
      'conflict identical positions',
      "UPDATE research_conflicts SET positions_json=json_set(positions_json,'$[1].positionText','第一方')",
    ],
    [
      'capture impossible summary',
      "UPDATE research_captures SET summary_json=json_set(summary_json,'$.sectionCount',60001)",
    ],
    ['claim severity', "UPDATE research_claims SET severity='invalid'"],
    ['claim coverage', "UPDATE research_claims SET coverage='multi-source'"],
    ['claim source types', 'UPDATE research_claims SET source_types_json=\'["vendor"]\''],
    ['claim missing reverse conflict', "UPDATE research_claims SET conflict_ids_json='[]'"],
    [
      'claim duplicate refs',
      `UPDATE research_claims SET evidence_ids_json='["${EVIDENCE}","${EVIDENCE}"]'`,
    ],
    [
      'conflict missing claim',
      `UPDATE research_conflicts SET claim_ids_json='["${OTHER}","${RESULT}"]'`,
    ],
    [
      'conflict one position',
      `UPDATE research_conflicts SET positions_json='[{"positionText":"x","sourceRefs":["${CANDIDATE}"]}]'`,
    ],
    [
      'conflict hidden field',
      "UPDATE research_conflicts SET positions_json=json_set(positions_json,'$[0].private','secret')",
    ],
    [
      'result hidden block field',
      "UPDATE research_results SET blocks_json=json_set(blocks_json,'$[0].private','secret')",
    ],
    ['result forged evidence map', "UPDATE research_results SET evidence_map_json='{}'"],
    [
      'result hidden evidence field',
      `UPDATE research_results SET evidence_map_json=json_set(evidence_map_json,'$."${EVIDENCE}".private','secret')`,
    ],
    ['result missing conflicts', "UPDATE research_results SET conflicts_json='[]'"],
    [
      'result invented conflict topic',
      "UPDATE research_results SET conflicts_json=json_set(conflicts_json,'$[0].topic','secret')",
    ],
    [
      'result bad fetched time',
      "UPDATE research_results SET fetched_at='2026-10-02T00:00:00.000Z'",
    ],
    ['result wrong task link', `UPDATE research_tasks SET result_id='${OTHER}'`],
    [
      'result unsafe markdown',
      `UPDATE research_results SET blocks_json='[{"kind":"markdown","text":"[x](javascript:alert)"}]'`,
    ],
    ['result silent normalization', "UPDATE research_results SET title='  结果  '"],
  ])('rejects %s in complete histories', (_label, sql) => {
    full();
    db.exec(sql);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false });
  });

  it.each([
    'DELETE FROM research_tasks',
    'DELETE FROM research_candidates',
    'DELETE FROM research_captures',
    'DELETE FROM research_evidence',
    'DELETE FROM research_claims',
    'DELETE FROM research_conflicts',
    'DELETE FROM research_results',
  ])('does not skip orphan graph edges: %s', (sql) => {
    full();
    db.exec(sql);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false, code: 'reference-invalid' });
  });

  it.each([
    "UPDATE research_tasks SET status='created',phase=NULL,started_at=NULL",
    "UPDATE research_tasks SET status='cancelled',phase=NULL,finished_at='2026-10-01T00:00:00Z'",
    "UPDATE research_tasks SET status='failed',phase=NULL,finished_at='2026-10-01T00:00:00+08:00',error_code='research-internal'",
    "UPDATE research_tasks SET status='interrupted',phase=NULL,interrupted_at='2026-10-01T00:00:00.000Z'",
  ])('preserves legitimate task states and accepted ISO forms: %s', (sql) => {
    task();
    db.exec(sql);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true });
  });

  it('accepts the failed Capture sentinel and rejects partial sentinel metadata', () => {
    seed();
    db.exec('DELETE FROM research_evidence');
    db.prepare(
      "UPDATE research_captures SET tab_id='unallocated',document_id='unavailable',content_hash=?,summary_json=?,failed=1,failure_reason='timeout',title='来源'",
    ).run(
      CAPTURE_EMPTY_CONTENT_HASH,
      JSON.stringify({ sectionCount: 0, tableCount: 0, headingCount: 0, charCount: 0 }),
    );
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true });
    db.exec("UPDATE research_captures SET summary_json=json_set(summary_json,'$.charCount',1)");
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false });
  });

  it('preserves Sources candidate metadata and historical timestamp offsets', () => {
    seed();
    const sourceId = OTHER.toUpperCase();
    const lastUsedAt = '2026-09-30T12:34:56+08:00';
    const sort = buildCandidateSortKey({
      tier: 1,
      inputRank: 0,
      priority: 5,
      lastUsedAt,
      scope: 'page',
      canonicalKey: URL,
      candidateId: CANDIDATE,
    });
    db.prepare(
      "UPDATE research_candidates SET discovered_via_json='[\"sources\",\"search\"]',source_id=?,trust_value='official',trust_asserted_by='user',trust_verification='asserted',priority=5,last_used_at=?,note=?,sort_key=?",
    ).run(sourceId, lastUsedAt, '备注'.repeat(100), sort);
    db.prepare('UPDATE research_evidence SET source_id=?').run(sourceId);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true });
  });

  it('validates ten conflicts without a Result and refuses the eleventh', () => {
    full();
    db.exec(
      "DELETE FROM research_results; UPDATE research_tasks SET status='running',phase='verifying',finished_at=NULL,result_id=NULL",
    );
    const conflictIds = [id(12)];
    for (let n = 1; n < 10; n++) {
      conflictIds.push(id(200 + n));
      db.prepare(
        'INSERT INTO research_conflicts SELECT ?,task_id,topic,positions_json,claim_ids_json,resolved FROM research_conflicts WHERE conflict_id=?',
      ).run(id(200 + n), id(12));
    }
    db.prepare('UPDATE research_claims SET conflict_ids_json=?').run(JSON.stringify(conflictIds));
    expect(validateResearchTransfer(db)).toMatchObject({
      ok: true,
      counts: { conflicts: 10, results: 0 },
    });
    db.prepare(
      'INSERT INTO research_conflicts SELECT ?,task_id,topic,positions_json,claim_ids_json,resolved FROM research_conflicts WHERE conflict_id=?',
    ).run(id(211), id(12));
    expect(validateResearchTransfer(db)).toMatchObject({
      ok: false,
      code: 'budget-exceeded',
      table: 'conflicts',
    });
  });

  it('checks conflict positions when no Result exists', () => {
    full();
    db.exec(
      "DELETE FROM research_results; UPDATE research_tasks SET status='running',phase='verifying',finished_at=NULL,result_id=NULL; UPDATE research_conflicts SET positions_json=json_set(positions_json,'$[1].positionText','第一方')",
    );
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false, table: 'conflicts' });
  });

  it.each([201, 500, 0])(
    'preserves existing Evidence field value shape (%i chars) generated by verifyEvidence',
    (size) => {
      seed();
      const ctx = context();
      const capture = rowToCapture(
        db.prepare('SELECT * FROM research_captures').get() as unknown as ResearchCaptureRow,
      )!;
      const value = 'a'.repeat(size);
      const content: CaptureContent = {
        captureId: CAPTURE,
        canonicalText: value,
        textSections: [value],
        tables: [],
        fields: { 'page.title': value },
      };
      const checked = verifyEvidence({
        proposal: {
          captureId: CAPTURE,
          candidateId: CANDIDATE,
          type: 'field',
          locator: { kind: 'field', fieldPath: 'page.title' },
          excerpt: value,
          value: null,
        },
        evidenceId: EVIDENCE,
        taskId: TASK,
        captures: [capture],
        candidates: ctx.candidates,
        contents: new Map([[CAPTURE, content]]),
      });
      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      db.prepare("UPDATE research_evidence SET type='field',locator_json=?,excerpt=?,value=?").run(
        JSON.stringify(checked.evidence.locator),
        checked.evidence.excerpt,
        checked.evidence.value,
      );
      expect(validateResearchTransfer(db)).toMatchObject({ ok: true });
    },
  );

  it('accepts omitted legacy table header without dropping unknown locator fields', () => {
    seed();
    db.exec("UPDATE research_captures SET summary_json=json_set(summary_json,'$.tableCount',1)");
    db.prepare("UPDATE research_evidence SET type='table-cell',locator_json=?,value=excerpt").run(
      JSON.stringify({ kind: 'table', tableIndex: 0, row: 0, col: 0 }),
    );
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true });
    db.exec("UPDATE research_evidence SET locator_json=json_set(locator_json,'$.private',1)");
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false });
  });

  it('accepts every Result block kind using the formal block schema', () => {
    seed();
    complete([
      { kind: 'markdown', text: '[资料](https://example.test/)' },
      { kind: 'table', columns: ['项'], rows: [['值']], sourceRefs: [CANDIDATE] },
      {
        kind: 'cards',
        items: [{ title: '卡片', subtitle: null, body: '内容', sourceRefs: [CANDIDATE] }],
      },
      {
        kind: 'ranking',
        items: [{ rank: 1, title: '条目', detail: '说明', sourceRefs: [CANDIDATE] }],
      },
      { kind: 'uncertain', text: '不确定', reason: '证据不足' },
    ]);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true });
  });

  it('rejects malformed/deep/oversized JSON before domain projection', () => {
    task();
    for (const raw of [
      '['.repeat(17) + '0' + ']'.repeat(17),
      ' '.repeat(500001),
      '[1e999]',
      '{"__proto__":{"polluted":1}}',
    ]) {
      db.prepare('UPDATE research_tasks SET stats_json=?').run(raw);
      expect(validateResearchTransfer(db)).toMatchObject({ ok: false });
      expect(Object.hasOwn({}, 'polluted')).toBe(false);
    }
  });

  it('keeps unknown database errors bounded and read-only', () => {
    db.exec('DROP TABLE research_results');
    expect(validateResearchTransfer(db)).toEqual({
      ok: false,
      code: 'sqlite-error',
      table: 'results',
    });
    expect(db.prepare('SELECT count(*) AS count FROM research_tasks').get()).toEqual({ count: 0 });
  });

  it('honors the existing 30 task admission limit without pruning input', () => {
    for (let n = 0; n < 30; n++) task(id(n));
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true, counts: { tasks: 30 } });
    task(id(30));
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false, code: 'budget-exceeded' });
    expect(db.prepare('SELECT count(*) AS count FROM research_tasks').get()).toEqual({ count: 31 });
  });

  it('rejects duplicate merged candidate identities even with different row IDs', () => {
    seed();
    const sort = buildCandidateSortKey({
      tier: 3,
      inputRank: 1,
      priority: null,
      lastUsedAt: null,
      scope: 'page',
      canonicalKey: URL,
      candidateId: id(1),
    });
    db.prepare(
      'INSERT INTO research_candidates SELECT ?,task_id,url,display_url,title,canonical_key,scope,discovered_via_json,source_id,trust_value,trust_asserted_by,trust_verification,priority,last_used_at,note,? FROM research_candidates',
    ).run(id(1), sort);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false });
  });

  it.each([
    ['candidates', 24],
    ['captures', 16],
    ['evidence', 60],
    ['claims', 30],
  ] as const)('enforces the per-task %s row budget at the boundary', (table, limit) => {
    seed();
    let existing = 1;
    if (table === 'claims') existing = 0;
    const insert = (n: number): void => {
      const nextId = id(n + 100);
      switch (table) {
        case 'candidates': {
          const url = `https://example.test/${n}`;
          const sort = buildCandidateSortKey({
            tier: 3,
            inputRank: n,
            priority: null,
            lastUsedAt: null,
            scope: 'page',
            canonicalKey: url,
            candidateId: nextId,
          });
          db.prepare(
            'INSERT INTO research_candidates SELECT ?,task_id,?,?,title,?,scope,discovered_via_json,source_id,trust_value,trust_asserted_by,trust_verification,priority,last_used_at,note,? FROM research_candidates WHERE candidate_id=?',
          ).run(nextId, url, url, url, sort, CANDIDATE);
          break;
        }
        case 'captures':
          db.prepare(
            'INSERT INTO research_captures SELECT ?,task_id,candidate_id,tab_id,url,title,access_time,document_id,content_hash,summary_json,failed,failure_reason FROM research_captures WHERE capture_id=?',
          ).run(nextId, CAPTURE);
          break;
        case 'evidence':
          db.prepare(
            'INSERT INTO research_evidence SELECT ?,task_id,candidate_id,source_id,capture_id,url,title,access_time,document_id,content_hash,type,locator_json,excerpt,value,verification FROM research_evidence WHERE evidence_id=?',
          ).run(nextId, EVIDENCE);
          break;
        case 'claims':
          db.prepare('INSERT INTO research_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
            nextId,
            TASK,
            '结论',
            'low',
            'single-source',
            '["third-party"]',
            JSON.stringify([EVIDENCE]),
            '["整条结论"]',
            '[]',
          );
          break;
      }
    };
    for (let n = existing; n < limit; n++) insert(n);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true, counts: { [table]: limit } });
    insert(limit);
    expect(validateResearchTransfer(db)).toMatchObject({
      ok: false,
      code: 'budget-exceeded',
      table,
    });
  });

  it('rejects duplicate JSON keys rather than discarding an invalid known value', () => {
    seed();
    db.prepare('UPDATE research_captures SET summary_json=?').run(
      '{"sectionCount":"invalid","sectionCount":1,"tableCount":0,"headingCount":0,"charCount":2}',
    );
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false, code: 'json-invalid' });
  });

  it('accepts the exact projected UTF8 task byte limit and rejects one more byte', () => {
    seed();
    const initial = validateResearchTransfer(db);
    if (!initial.ok) throw new Error('初始夹具无效');
    const room = 500000 - initial.persistedBytes;
    const original = '网页';
    // Two titles share provenance, so add an odd byte to the task goal first.
    const odd = room % 2;
    db.prepare('UPDATE research_tasks SET goal=?').run('研究' + 'a'.repeat(odd));
    const title = original + 'a'.repeat(Math.floor(room / 2));
    db.prepare('UPDATE research_captures SET title=?').run(title);
    db.prepare('UPDATE research_evidence SET title=?').run(title);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true, persistedBytes: 500000 });
    db.prepare('UPDATE research_tasks SET goal=?').run('研究' + 'a'.repeat(odd + 1));
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false, code: 'budget-exceeded' });
  });
  it('accepts empty and incomplete running history without mutating it', () => {
    expect(validateResearchTransfer(db)).toMatchObject({
      ok: true,
      counts: { tasks: 0, evidence: 0 },
    });
    seed();
    expect(validateResearchTransfer(db)).toMatchObject({
      ok: true,
      counts: { tasks: 1, candidates: 1, captures: 1, evidence: 1 },
    });
    expect(db.prepare('SELECT status FROM research_tasks').get()).toEqual({ status: 'running' });
  });

  it.each([
    ['task enum', "UPDATE research_tasks SET error_code='private-invalid'"],
    ['task date', "UPDATE research_tasks SET created_at='2026-02-30T00:00:00Z'"],
    ['nullable type', "UPDATE research_candidates SET priority='private-invalid'"],
    ['partial trust', "UPDATE research_candidates SET trust_value='official'"],
    ['capture flag', 'PRAGMA ignore_check_constraints=ON; UPDATE research_captures SET failed=2'],
    [
      'unverified evidence',
      "PRAGMA ignore_check_constraints=ON; UPDATE research_evidence SET verification='rejected'",
    ],
    [
      'locator hidden field',
      `UPDATE research_evidence SET locator_json='{"kind":"text","excerpt":"事实","private":"secret"}'`,
    ],
    [
      'stats hidden field',
      `UPDATE research_tasks SET stats_json=json_set(stats_json,'$.private','secret')`,
    ],
    ['invalid JSON', "UPDATE research_captures SET summary_json='private-invalid'"],
    ['foreign candidate', `UPDATE research_captures SET candidate_id='${OTHER}'`],
    ['evidence provenance', "UPDATE research_evidence SET title='伪造'"],
    ['missing capture', 'DELETE FROM research_captures'],
    ['missing candidate', 'DELETE FROM research_candidates'],
    ['orphan children without result', 'DELETE FROM research_tasks'],
    ['goal budget', "UPDATE research_tasks SET goal=replace(hex(zeroblob(1001)),'0','a')"],
  ])('rejects %s without returning private content', (_label, sql) => {
    seed();
    db.exec(sql);
    const outcome = validateResearchTransfer(db);
    expect(outcome).toMatchObject({ ok: false });
    expect(JSON.stringify(outcome)).not.toMatch(/private|secret|伪造|事实|example/);
  });

  it('rejects same-schema references into another task', () => {
    seed();
    task(OTHER);
    db.prepare('UPDATE research_candidates SET task_id=?').run(OTHER);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false, code: 'reference-invalid' });
  });

  it('validates result projections using the formal validator', () => {
    task();
    const checked = validate(
      {
        title: '结果',
        summary: '',
        blocks: [{ kind: 'uncertain', text: '证据不足', reason: '无来源' }],
      },
      {
        taskId: TASK,
        candidates: [],
        evidence: [],
        claims: [],
        conflicts: [],
        verificationState: 'verified',
        now: NOW,
        createId: () => RESULT,
      },
    );
    if (!checked.ok) throw new Error('合成夹具无效');
    const r = checked.result;
    db.prepare('INSERT INTO research_results VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      r.resultId,
      r.taskId,
      r.title,
      r.summary,
      JSON.stringify(r.blocks),
      JSON.stringify(r.evidenceMap),
      JSON.stringify(r.conflicts),
      JSON.stringify(r.coverage),
      r.fetchedAt,
    );
    db.prepare(
      "UPDATE research_tasks SET status='completed',phase=NULL,finished_at=?,result_id=?",
    ).run(NOW, RESULT);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: true });
    db.exec("UPDATE research_results SET coverage_json=json_set(coverage_json,'$.vendor',1)");
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false });
  });

  it('rejects orphan claims and conflicts even without a result', () => {
    seed();
    db.prepare('INSERT INTO research_claims VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      OTHER,
      TASK,
      '结论',
      'low',
      'single-source',
      '["third-party"]',
      JSON.stringify([RESULT]),
      '["整条结论"]',
      '[]',
    );
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false });
    db.exec('DELETE FROM research_claims');
    db.prepare('INSERT INTO research_conflicts VALUES (?, ?, ?, ?, ?, ?)').run(
      OTHER,
      TASK,
      '分歧',
      '[]',
      '[]',
      'unresolved',
    );
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false });
  });

  it('applies cumulative UTF8 bytes rather than character count', () => {
    seed();
    const long = '汉'.repeat(90000);
    db.prepare('UPDATE research_captures SET title=?').run(long);
    db.prepare('UPDATE research_evidence SET title=?').run(long);
    expect(validateResearchTransfer(db)).toMatchObject({ ok: false, code: 'budget-exceeded' });
  });
});
