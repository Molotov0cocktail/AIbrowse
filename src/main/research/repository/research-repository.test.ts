// C1 research-repository tests: real node:sqlite over migration v1 — full task
// CRUD, state-transition writes, child-row collections (7-table set, #101),
// transactions, CASCADE, injection strings as data only, JSON shape validation
// fail-closed (malformed rows dropped, never thrown through), verified-only
// Evidence (#102), cumulative UTF-8 persisted-budget enforcement (#103), and
// the MAX_STORED_TASKS oldest-finished pruning order (#104). Test probe SQL is
// confined to this file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, withTransaction, type DbHandle } from '../../sources/db/sqlite-driver';
import { runResearchMigrations } from '../db/research-migrations';
import {
  RepositoryError,
  ResearchRepository,
  parseLocatorJson,
  parseStatsJson,
  rowToEvidence,
  rowToTask,
  type ResearchCaptureRow,
  type ResearchCandidateRow,
  type ResearchEvidenceRow,
  type ResearchResultRow,
  type ResearchTaskRow,
} from './research-repository';
import { computeUtf8Bytes } from '../domain/research-budget';
import type { ResearchTask, ResearchTaskStats } from '../../../shared/types/research';
import { MAX_TASK_PERSISTED_CHARS } from '../../../shared/types/research';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-repo-'));
const T0 = '2026-08-16T00:00:00.000Z';
const T1 = '2026-08-16T00:01:00.000Z';

let handle: DbHandle;
let repo: ResearchRepository;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  handle = openDb(join(root, `repo-${Math.random().toString(36).slice(2)}.db`));
  runResearchMigrations(handle);
  repo = new ResearchRepository(handle);
});

afterEach(() => {
  closeDb(handle);
});

function makeTaskRow(over: Partial<ResearchTaskRow> = {}): ResearchTaskRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    goal: '比较主流模型能力',
    status: 'created',
    phase: null,
    created_at: T0,
    updated_at: T0,
    started_at: null,
    finished_at: null,
    interrupted_at: null,
    error_code: null,
    result_id: null,
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
    ...over,
  };
}

function makeCandidateRow(over: Partial<ResearchCandidateRow> = {}): ResearchCandidateRow {
  return {
    candidate_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    task_id: '11111111-1111-4111-8111-111111111111',
    url: 'https://example.com/p',
    display_url: 'https://example.com/p',
    title: '示例来源',
    canonical_key: 'https://example.com/p',
    scope: 'page',
    discovered_via_json: JSON.stringify(['sources']),
    source_id: null,
    trust_value: null,
    trust_asserted_by: null,
    trust_verification: null,
    priority: null,
    last_used_at: null,
    note: null,
    sort_key: '1|3|0000|https://example.com/p|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ...over,
  };
}

function makeCaptureRow(over: Partial<ResearchCaptureRow> = {}): ResearchCaptureRow {
  return {
    capture_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    task_id: '11111111-1111-4111-8111-111111111111',
    candidate_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    tab_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    url: 'https://example.com/p',
    title: '示例来源',
    access_time: T1,
    document_id: 'doc-1',
    content_hash: '0123456789abcdef0123456789abcdef',
    summary_json: JSON.stringify({
      sectionCount: 1,
      tableCount: 0,
      headingCount: 1,
      charCount: 100,
    }),
    failed: 0,
    failure_reason: null,
    ...over,
  };
}

function makeEvidenceRow(over: Partial<ResearchEvidenceRow> = {}): ResearchEvidenceRow {
  return {
    evidence_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    task_id: '11111111-1111-4111-8111-111111111111',
    candidate_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    source_id: null,
    capture_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    url: 'https://example.com/p',
    title: '示例来源',
    access_time: T1,
    document_id: 'doc-1',
    content_hash: '0123456789abcdef0123456789abcdef',
    type: 'quote',
    locator_json: JSON.stringify({ kind: 'text', excerpt: '摘录' }),
    excerpt: '摘录',
    value: null,
    verification: 'verified',
    ...over,
  };
}

function makeResultRow(over: Partial<ResearchResultRow> = {}): ResearchResultRow {
  return {
    result_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    task_id: '11111111-1111-4111-8111-111111111111',
    title: '结果标题',
    summary: '结果摘要',
    blocks_json: JSON.stringify([{ kind: 'markdown', text: '结论' }]),
    evidence_map_json: JSON.stringify({}),
    conflicts_json: JSON.stringify([]),
    coverage_json: JSON.stringify({
      total: 0,
      multiSource: 0,
      singleSource: 0,
      vendor: 0,
      thirdParty: 0,
      community: 0,
    }),
    fetched_at: T1,
    ...over,
  };
}

describe('任务 CRUD 与状态迁移写入', () => {
  it('insert + get 往返恒等（行→域→行）', () => {
    repo.insertTask(makeTaskRow());
    const task = repo.getTaskById('11111111-1111-4111-8111-111111111111');
    expect(task).not.toBeNull();
    expect(task!.goal).toBe('比较主流模型能力');
    expect(task!.status).toBe('created');
    expect(task!.phase).toBeNull();
    expect(task!.stats.candidateCount).toBe(0);
  });

  it('不存在的 id → null；getRunningTask 无 running 时 null', () => {
    repo.insertTask(makeTaskRow());
    expect(repo.getTaskById('ffffffff-ffff-4fff-8fff-ffffffffffff')).toBeNull();
    expect(repo.getRunningTask()).toBeNull();
  });

  it('状态迁移写方法矩阵（running/completed/failed/cancelled/interrupted）', () => {
    repo.insertTask(makeTaskRow());
    repo.setTaskRunning('11111111-1111-4111-8111-111111111111', {
      phase: 'planning',
      startedAt: T1,
      updatedAt: T1,
      stats: {
        candidateCount: 3,
        selectedCount: 1,
        captureCount: 0,
        failedReadCount: 0,
        evidenceCount: 0,
        rejectedEvidenceCount: 0,
        claimCount: 0,
        conflictCount: 0,
        stepsUsed: 0,
        roundsUsed: 0,
      },
    });
    let task = repo.getTaskById('11111111-1111-4111-8111-111111111111')!;
    expect(task.status).toBe('running');
    expect(task.phase).toBe('planning');
    expect(task.startedAt).toBe(T1);
    expect(task.stats.candidateCount).toBe(3);
    expect(repo.getRunningTask()?.id).toBe('11111111-1111-4111-8111-111111111111');

    repo.updateTaskPhase('11111111-1111-4111-8111-111111111111', 'reading', T1);
    expect(repo.getTaskById('11111111-1111-4111-8111-111111111111')!.phase).toBe('reading');

    repo.setTaskCompleted('11111111-1111-4111-8111-111111111111', {
      resultId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      finishedAt: T1,
      updatedAt: T1,
      stats: {
        candidateCount: 3,
        selectedCount: 1,
        captureCount: 1,
        failedReadCount: 0,
        evidenceCount: 1,
        rejectedEvidenceCount: 0,
        claimCount: 1,
        conflictCount: 0,
        stepsUsed: 4,
        roundsUsed: 3,
      },
    });
    task = repo.getTaskById('11111111-1111-4111-8111-111111111111')!;
    expect(task.status).toBe('completed');
    expect(task.resultId).toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(task.finishedAt).toBe(T1);

    repo.setTaskCancelled('11111111-1111-4111-8111-111111111111', {
      finishedAt: T1,
      updatedAt: T1,
      stats: {
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
      },
    });
    expect(repo.getTaskById('11111111-1111-4111-8111-111111111111')!.status).toBe('cancelled');

    repo.setTaskFailed('11111111-1111-4111-8111-111111111111', {
      errorCode: 'research-timeout',
      finishedAt: T1,
      updatedAt: T1,
      stats: {
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
      },
    });
    expect(repo.getTaskById('11111111-1111-4111-8111-111111111111')!.errorCode).toBe(
      'research-timeout',
    );

    repo.setTaskInterrupted('11111111-1111-4111-8111-111111111111', {
      interruptedAt: T1,
      updatedAt: T1,
    });
    task = repo.getTaskById('11111111-1111-4111-8111-111111111111')!;
    expect(task.status).toBe('interrupted');
    expect(task.interruptedAt).toBe(T1);
    expect(task.phase).toBeNull();
  });

  it('listTasks 分页与 status 过滤（新→旧 + id 收尾全序）', () => {
    for (let i = 1; i <= 5; i += 1) {
      repo.insertTask(
        makeTaskRow({
          id: `00000000-0000-4000-8000-00000000000${i}`,
          created_at: `2026-08-16T00:0${i}:00.000Z`,
          updated_at: `2026-08-16T00:0${i}:00.000Z`,
        }),
      );
    }
    const page1 = repo.listTasks({ page: 1, pageSize: 2 });
    expect(page1.items.map((r) => r.id)).toEqual([
      '00000000-0000-4000-8000-000000000005',
      '00000000-0000-4000-8000-000000000004',
    ]);
    const page3 = repo.listTasks({ page: 3, pageSize: 2 });
    expect(page3.items.map((r) => r.id)).toEqual(['00000000-0000-4000-8000-000000000001']);
    expect(repo.countTasks()).toBe(5);
    const filtered = repo.listTasks({ page: 1, pageSize: 10, status: 'created' });
    expect(filtered.items).toHaveLength(5);
  });
});

describe('注入串仅作数据（参数绑定）', () => {
  it('goal 携带 SQL 注入形态原样存取、表完好', () => {
    const evil = "'; DROP TABLE research_tasks; --";
    repo.insertTask(makeTaskRow({ goal: evil }));
    expect(repo.getTaskById('11111111-1111-4111-8111-111111111111')!.goal).toBe(evil);
    expect(repo.countTasks()).toBe(1);
    expect(
      handle.prepare('SELECT name FROM sqlite_master WHERE name = ?').get('research_tasks'),
    ).not.toBeUndefined();
  });

  it('candidate url/title 携带注入串原样存取', () => {
    repo.insertTask(makeTaskRow());
    const evil = "x' OR '1'='1";
    repo.insertCandidate(makeCandidateRow({ url: evil, title: evil }));
    const rows = repo.listCandidatesByTask('11111111-1111-4111-8111-111111111111');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.url).toBe(evil);
    expect(rows[0]!.title).toBe(evil);
  });
});

describe('JSON 形状校验 fail-closed（不抛穿）', () => {
  it('stats_json 畸形 → getTaskById 返回 null（整行丢弃）', () => {
    repo.insertTask(makeTaskRow());
    handle
      .prepare('UPDATE research_tasks SET stats_json = ? WHERE id = ?')
      .run('{oops', '11111111-1111-4111-8111-111111111111');
    expect(repo.getTaskById('11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('stats_json 形状非法（缺字段/错类型）→ null', () => {
    repo.insertTask(makeTaskRow());
    handle
      .prepare('UPDATE research_tasks SET stats_json = ? WHERE id = ?')
      .run(
        JSON.stringify({ candidateCount: 'not-a-number' }),
        '11111111-1111-4111-8111-111111111111',
      );
    expect(repo.getTaskById('11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('listTasks 跳过畸形行不抛异常（其余行正常返回）', () => {
    repo.insertTask(makeTaskRow({ id: '00000000-0000-4000-8000-000000000001' }));
    repo.insertTask(makeTaskRow({ id: '00000000-0000-4000-8000-000000000002' }));
    handle
      .prepare('UPDATE research_tasks SET stats_json = ? WHERE id = ?')
      .run('bad-json', '00000000-0000-4000-8000-000000000001');
    const items = repo.listTasks({ page: 1, pageSize: 10 }).items;
    expect(items.map((r) => r.id)).toEqual(['00000000-0000-4000-8000-000000000002']);
  });

  it('parseStatsJson 直接调用：非法输入 null（null/数组/数字/畸形对象）', () => {
    expect(parseStatsJson(null)).toBeNull();
    expect(parseStatsJson(42)).toBeNull();
    expect(parseStatsJson([])).toBeNull();
    expect(parseStatsJson('{}')).toBeNull();
    expect(parseStatsJson(JSON.stringify({ candidateCount: 'x' }))).toBeNull();
    expect(
      parseStatsJson(
        JSON.stringify({
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
      ),
    ).toEqual({
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
    });
  });

  it('capture summary_json 畸形 → listCapturesByTask 跳过该行', () => {
    repo.insertTask(makeTaskRow());
    repo.insertCapture(makeCaptureRow());
    handle
      .prepare('UPDATE research_captures SET summary_json = ? WHERE capture_id = ?')
      .run('nope', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    expect(repo.listCapturesByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
  });

  it('evidence locator_json 畸形 → listEvidenceByTask 跳过该行', () => {
    repo.insertTask(makeTaskRow());
    repo.insertCapture(makeCaptureRow());
    repo.insertEvidence(makeEvidenceRow());
    handle
      .prepare('UPDATE research_evidence SET locator_json = ? WHERE evidence_id = ?')
      .run('{bad', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(repo.listEvidenceByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
  });

  it('candidate discovered_via_json 畸形 → listCandidatesByTask 跳过该行', () => {
    repo.insertTask(makeTaskRow());
    repo.insertCandidate(makeCandidateRow());
    handle
      .prepare('UPDATE research_candidates SET discovered_via_json = ? WHERE candidate_id = ?')
      .run('null', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(repo.listCandidatesByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
  });

  it('result blocks_json 畸形 → getResultByTaskId 返回 null', () => {
    repo.insertTask(makeTaskRow());
    repo.insertResult(makeResultRow());
    handle
      .prepare('UPDATE research_results SET blocks_json = ? WHERE result_id = ?')
      .run('[', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(repo.getResultByTaskId('11111111-1111-4111-8111-111111111111')).toBeNull();
  });
});

describe('verified-only Evidence（决议 #102：Repository 层窄化）', () => {
  it('makeEvidenceRow 的 verification 类型仅接受 verified（编译期）', () => {
    // Runtime probe: the repository only ever writes the verified literal.
    repo.insertTask(makeTaskRow());
    repo.insertCapture(makeCaptureRow());
    repo.insertEvidence(makeEvidenceRow());
    const rows = repo.listEvidenceByTask('11111111-1111-4111-8111-111111111111');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.verification).toBe('verified');
    // 直接 SQL 插入 rejected 被 CHECK 拒绝（database 层兜底）已在
    // research-migrations.test.ts 覆盖
  });

  it('listEvidenceByTask 行转换 verification 恒 verified', () => {
    repo.insertTask(makeTaskRow());
    repo.insertCapture(makeCaptureRow());
    repo.insertEvidence(makeEvidenceRow());
    const evidence = repo.listEvidenceByTask('11111111-1111-4111-8111-111111111111')[0]!;
    expect(evidence.verification).toBe('verified');
    expect(evidence.excerpt).toBe('摘录');
    expect(evidence.locator).toEqual({ kind: 'text', excerpt: '摘录' });
  });
});

describe('累计持久化预算（决议 #103：UTF-8 字节、事务内前置检查）', () => {
  it('computeTaskPersistedBytes：任务行 + 全部子行 UTF-8 字节合计', () => {
    repo.insertTask(makeTaskRow());
    const taskBytes = repo.computeTaskPersistedBytes('11111111-1111-4111-8111-111111111111');
    expect(taskBytes).toBeGreaterThan(0);
    repo.insertCandidate(makeCandidateRow());
    repo.insertCapture(makeCaptureRow());
    repo.insertEvidence(makeEvidenceRow());
    const withChildren = repo.computeTaskPersistedBytes('11111111-1111-4111-8111-111111111111');
    expect(withChildren).toBeGreaterThan(taskBytes);
  });

  it('写入前置检查：超限抛 RepositoryError(task-persisted-budget-exceeded)，事务回滚零残留', () => {
    repo.insertTask(makeTaskRow());
    // 超大 Evidence 摘要：约 500k 字节的 UTF-8 多字节内容（> 预算上限）
    const huge = '中'.repeat(200_000); // 600k UTF-8 字节 > 500k 上限
    expect(() =>
      withTransaction(handle, () => {
        repo.insertEvidence(
          makeEvidenceRow({ excerpt: huge, evidence_id: '00000000-0000-4000-8000-000000000009' }),
        );
      }),
    ).toThrowError(RepositoryError);
    try {
      repo.insertEvidence(
        makeEvidenceRow({ excerpt: huge, evidence_id: '00000000-0000-4000-8000-000000000009' }),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(RepositoryError);
      expect((err as RepositoryError).code).toBe('task-persisted-budget-exceeded');
    }
    // 事务回滚：没有任何 Evidence 行残留
    expect(repo.listEvidenceByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
    expect(repo.computeTaskPersistedBytes('11111111-1111-4111-8111-111111111111')).toBeLessThan(
      600_000,
    );
  });

  it('多字节内容按 UTF-8 字节核算（中文 3 字节/字符触发预算）', () => {
    repo.insertTask(makeTaskRow());
    // 170k 中文字符 = 510k 字节 > 500k —— 单行即超限
    const tooMuch = '中'.repeat(170_000);
    expect(() => repo.insertEvidence(makeEvidenceRow({ excerpt: tooMuch }))).toThrowError(
      RepositoryError,
    );
  });

  it('边界内写入成功（UTF-8 字节 ≤ 500k）', () => {
    repo.insertTask(makeTaskRow());
    const fine = '中'.repeat(160_000); // 480k 字节 < 500k
    repo.insertEvidence(makeEvidenceRow({ excerpt: fine }));
    expect(repo.listEvidenceByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(1);
  });
});

describe('EvidenceLocator.table.header 形状（决议 #115：非法形态整体拒绝，fail-closed）', () => {
  it('合法形态：string / null / 缺省（undefined）→ locator 正常解析', () => {
    expect(
      parseLocatorJson(JSON.stringify({ kind: 'table', row: 0, col: 1, header: '列名' })),
    ).toEqual({
      kind: 'table',
      row: 0,
      col: 1,
      header: '列名',
    });
    expect(
      parseLocatorJson(JSON.stringify({ kind: 'table', row: 0, col: 1, header: null })),
    ).toEqual({
      kind: 'table',
      row: 0,
      col: 1,
      header: null,
    });
    expect(parseLocatorJson(JSON.stringify({ kind: 'table', row: 0, col: 1 }))).toEqual({
      kind: 'table',
      row: 0,
      col: 1,
      header: null,
    });
  });

  it.each([42, true, ['列名'], { name: '列名' }])(
    'header 非法形态 %j → 整个 locator 返回 null（不得静默转 null）',
    (bad) => {
      expect(
        parseLocatorJson(JSON.stringify({ kind: 'table', row: 0, col: 1, header: bad })),
      ).toBeNull();
    },
  );

  it('Repository 写入对应 Evidence fail-closed：非法 header 整体拒绝、零落库', () => {
    repo.insertTask(makeTaskRow());
    for (const bad of [42, true, { name: 'x' }]) {
      expect(() =>
        repo.insertEvidence(
          makeEvidenceRow({
            evidence_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            type: 'table-cell',
            locator_json: JSON.stringify({ kind: 'table', row: 0, col: 0, header: bad }),
            excerpt: '摘录',
            value: '单元格',
          }),
        ),
      ).toThrowError(RepositoryError);
    }
    expect(repo.listEvidenceByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
  });

  it('读取侧 fail-closed：库内非法 header 行被跳过（其余行正常）', () => {
    repo.insertTask(makeTaskRow());
    repo.insertCapture(makeCaptureRow());
    repo.insertEvidence(makeEvidenceRow());
    handle
      .prepare('UPDATE research_evidence SET locator_json = ? WHERE evidence_id = ?')
      .run(
        JSON.stringify({ kind: 'table', row: 0, col: 0, header: 42 }),
        'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      );
    expect(repo.listEvidenceByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
  });

  it('合法 header 的 table locator 写入/读回恒等', () => {
    repo.insertTask(makeTaskRow());
    repo.insertCapture(makeCaptureRow());
    repo.insertEvidence(
      makeEvidenceRow({
        type: 'table-cell',
        locator_json: JSON.stringify({ kind: 'table', row: 1, col: 2, header: '价格' }),
        value: '¥100',
      }),
    );
    const evidence = repo.listEvidenceByTask('11111111-1111-4111-8111-111111111111')[0]!;
    expect(evidence.locator).toEqual({ kind: 'table', row: 1, col: 2, header: '价格' });
  });
});

describe('任务状态更新路径的持久化预算（决议 #113：按更新后任务投影检查）', () => {
  const TASK_ID = '11111111-1111-4111-8111-111111111111';
  // 距 500k 上限仅剩 3 字节：任何状态/时间字段更新（增量 ≥5 字节）都会推过上限——
  // 红态证明当前更新路径无预算检查、可突破上限
  const HEADROOM = 3;

  const STATS: ResearchTaskStats = {
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
  };

  // 构造「距离 500000 UTF-8 字节上限仅剩少量空间」的任务：任务行 + 1 条大
  // Evidence（ASCII 1 字节/字符，字节精确可控）；返回构造后的持久化字节数
  function fillTaskNearBudget(taskOver: Partial<ResearchTaskRow> = {}): number {
    repo.insertTask(makeTaskRow(taskOver));
    const base = repo.computeTaskPersistedBytes(TASK_ID);
    const overhead = computeUtf8Bytes(
      JSON.stringify(
        rowToEvidence(
          makeEvidenceRow({
            evidence_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            excerpt: '',
          }),
        )!,
      ),
    );
    const filler = MAX_TASK_PERSISTED_CHARS - HEADROOM - base - overhead;
    expect(filler).toBeGreaterThan(0);
    repo.insertEvidence(
      makeEvidenceRow({
        evidence_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        excerpt: 'x'.repeat(filler),
      }),
    );
    const current = repo.computeTaskPersistedBytes(TASK_ID);
    expect(current).toBe(MAX_TASK_PERSISTED_CHARS - HEADROOM);
    return current;
  }

  it.each([
    [
      'setTaskRunning',
      () =>
        repo.setTaskRunning(TASK_ID, {
          phase: 'planning',
          startedAt: T1,
          updatedAt: T1,
          stats: STATS,
        }),
    ],
    [
      'setTaskCompleted',
      () =>
        repo.setTaskCompleted(TASK_ID, {
          resultId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          finishedAt: T1,
          updatedAt: T1,
          stats: STATS,
        }),
    ],
    [
      'setTaskFailed',
      () =>
        repo.setTaskFailed(TASK_ID, {
          errorCode: 'research-timeout',
          finishedAt: T1,
          updatedAt: T1,
          stats: STATS,
        }),
    ],
    [
      'setTaskCancelled',
      () => repo.setTaskCancelled(TASK_ID, { finishedAt: T1, updatedAt: T1, stats: STATS }),
    ],
    [
      'setTaskInterrupted',
      () => repo.setTaskInterrupted(TASK_ID, { interruptedAt: T1, updatedAt: T1 }),
    ],
    ['updateTaskPhase', () => repo.updateTaskPhase(TASK_ID, 'reading', T1)],
  ])('%s 会把近上限任务推过 500k → RepositoryError(budget) + 零写入', (_name, apply) => {
    fillTaskNearBudget();
    expect(apply).toThrowError(RepositoryError);
    try {
      apply();
    } catch (err) {
      expect(err).toBeInstanceOf(RepositoryError);
      expect((err as RepositoryError).code).toBe('task-persisted-budget-exceeded');
    }
    // 零写入：任务行未变、持久化投影未变（created 状态与字节数原样）
    expect(repo.getTaskById(TASK_ID)!.status).toBe('created');
    expect(repo.computeTaskPersistedBytes(TASK_ID)).toBe(MAX_TASK_PERSISTED_CHARS - HEADROOM);
  });

  it('更新后投影仍在预算内 → 成功写入且投影 ≤ 500k（替换写不得误算为完整新增）', () => {
    // 距上限 300 字节：状态更新只替换任务行字段——投影检查（子行字节 + 更新后
    // 任务行字节）必须放行；若把替换写误算为「当前 + 新增完整任务行」会假拒绝
    const headroomProbe = 300;
    repo.insertTask(makeTaskRow());
    const base = repo.computeTaskPersistedBytes(TASK_ID);
    const overhead = computeUtf8Bytes(
      JSON.stringify(
        rowToEvidence(
          makeEvidenceRow({ evidence_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', excerpt: '' }),
        )!,
      ),
    );
    const filler = MAX_TASK_PERSISTED_CHARS - headroomProbe - base - overhead;
    expect(filler).toBeGreaterThan(0);
    repo.insertEvidence(
      makeEvidenceRow({
        evidence_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        excerpt: 'x'.repeat(filler),
      }),
    );
    expect(repo.computeTaskPersistedBytes(TASK_ID)).toBe(MAX_TASK_PERSISTED_CHARS - headroomProbe);
    repo.setTaskCancelled(TASK_ID, { finishedAt: T1, updatedAt: T1, stats: STATS });
    expect(repo.getTaskById(TASK_ID)!.status).toBe('cancelled');
    expect(repo.computeTaskPersistedBytes(TASK_ID)).toBeLessThanOrEqual(MAX_TASK_PERSISTED_CHARS);
    // 更新只增大了 finished_at 等时间字段：投影仍远小于上限（未把任务行双重计入）
    expect(repo.computeTaskPersistedBytes(TASK_ID)).toBeLessThan(MAX_TASK_PERSISTED_CHARS - 200);
  });

  it('检查与写入处于调用方事务内：超限更新整体回滚、零残留', () => {
    repo.insertTask(makeTaskRow());
    expect(() =>
      withTransaction(handle, () => {
        repo.insertEvidence(
          makeEvidenceRow({
            evidence_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            excerpt: '中'.repeat(170_000), // 510k 字节——插入即超限（既有 #103 路径）
          }),
        );
        repo.setTaskRunning(TASK_ID, {
          phase: 'planning',
          startedAt: T1,
          updatedAt: T1,
          stats: STATS,
        });
      }),
    ).toThrowError(RepositoryError);
    // 事务回滚：Evidence 零残留、任务行零变化（setTaskRunning 未生效）
    expect(repo.listEvidenceByTask(TASK_ID)).toHaveLength(0);
    expect(repo.getTaskById(TASK_ID)!.status).toBe('created');
  });

  it('markAllRunningInterrupted：任一运行任务投影超限 → 整体拒绝 + 零写入', () => {
    fillTaskNearBudget({ status: 'running', phase: 'planning', started_at: T1 });
    repo.insertTask(
      makeTaskRow({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'running',
        phase: 'reading',
        started_at: T1,
      }),
    );
    expect(() => repo.markAllRunningInterrupted(T1, T1)).toThrowError(RepositoryError);
    try {
      repo.markAllRunningInterrupted(T1, T1);
    } catch (err) {
      expect((err as RepositoryError).code).toBe('task-persisted-budget-exceeded');
    }
    // 零写入：两个 running 任务均未被标记
    expect(repo.countTasksByStatus('running')).toBe(2);
    expect(repo.getTaskById(TASK_ID)!.status).toBe('running');
  });

  it('markAllRunningInterrupted：全部在预算内 → 原子标记成功', () => {
    repo.insertTask(makeTaskRow({ status: 'running', phase: 'planning', started_at: T1 }));
    repo.insertTask(
      makeTaskRow({
        id: '22222222-2222-4222-8222-222222222222',
        status: 'running',
        phase: 'reading',
        started_at: T1,
      }),
    );
    expect(repo.markAllRunningInterrupted(T1, T1)).toBe(2);
    expect(repo.countTasksByStatus('running')).toBe(0);
    expect(repo.getTaskById(TASK_ID)!.status).toBe('interrupted');
    expect(repo.getTaskById('22222222-2222-4222-8222-222222222222')!.status).toBe('interrupted');
  });
});

describe('MAX_STORED_TASKS 清理（决议 #104：最旧排序键）', () => {
  function insertFinished(id: string, finishedAt: string | null, interruptedAt: string | null) {
    repo.insertTask(
      makeTaskRow({
        id,
        status: interruptedAt === null ? 'completed' : 'interrupted',
        finished_at: finishedAt,
        interrupted_at: interruptedAt,
      }),
    );
  }

  it('最旧排序键 = COALESCE(finished_at, interrupted_at) DESC, created_at DESC, id ASC', () => {
    insertFinished('00000000-0000-4000-8000-000000000001', '2026-08-16T00:01:00.000Z', null);
    insertFinished('00000000-0000-4000-8000-000000000002', '2026-08-16T00:02:00.000Z', null);
    insertFinished('00000000-0000-4000-8000-000000000003', null, '2026-08-16T00:03:00.000Z');
    insertFinished('00000000-0000-4000-8000-000000000004', null, '2026-08-16T00:04:00.000Z');
    // 契约全序（决议 #104）：id4(00:04) > id3(00:03) > id2(00:02) > id1(00:01)——
    // 保最新 2 个（id3/id4）→ 清理列表 = 最旧 2 个（id2、id1）
    const beyond = repo.listFinishedTasksBeyond(2);
    expect(beyond.map((r) => r.id)).toEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ]);
    repo.deleteTasksByIds(beyond.map((r) => r.id));
    expect(repo.countFinishedTasks()).toBe(2);
    expect(repo.getTaskById('00000000-0000-4000-8000-000000000003')!.status).toBe('interrupted');
    expect(repo.getTaskById('00000000-0000-4000-8000-000000000004')!.status).toBe('interrupted');
  });

  it('created 任务永不被清理（仅终态为清理对象）', () => {
    repo.insertTask(makeTaskRow({ id: '00000000-0000-4000-8000-000000000001' })); // created
    insertFinished('00000000-0000-4000-8000-000000000002', T1, null);
    // 终态只有 1 个（< 保留上限）→ 清理列表为空；created 出现在任何清理列表中
    // 都是契约破坏——此处断言 listFinishedTasksBeyond 不含 created 且 count 正确
    const beyond = repo.listFinishedTasksBeyond(30);
    expect(beyond).toHaveLength(0);
    expect(repo.countFinishedTasks()).toBe(1);
    expect(repo.countTasks()).toBe(2); // created 计入总数（决议 #104）
  });

  it('CASCADE：deleteTask 删除任务清全部子行', () => {
    repo.insertTask(makeTaskRow());
    repo.insertCandidate(makeCandidateRow());
    repo.insertCapture(makeCaptureRow());
    repo.insertEvidence(makeEvidenceRow());
    repo.insertResult(makeResultRow());
    expect(repo.deleteTask('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(repo.getTaskById('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(repo.listCandidatesByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
    expect(repo.listCapturesByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
    expect(repo.listEvidenceByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
    expect(repo.getResultByTaskId('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(repo.deleteTask('11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('clearTaskRunData 清 6 张子表但保留任务行（restart 原子清理）', () => {
    repo.insertTask(makeTaskRow());
    repo.insertCandidate(makeCandidateRow());
    repo.insertCapture(makeCaptureRow());
    repo.insertEvidence(makeEvidenceRow());
    repo.insertResult(makeResultRow());
    repo.clearTaskRunData('11111111-1111-4111-8111-111111111111');
    expect(repo.getTaskById('11111111-1111-4111-8111-111111111111')).not.toBeNull();
    expect(repo.listCandidatesByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
    expect(repo.listCapturesByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
    expect(repo.listEvidenceByTask('11111111-1111-4111-8111-111111111111')).toHaveLength(0);
    expect(repo.getResultByTaskId('11111111-1111-4111-8111-111111111111')).toBeNull();
  });

  it('rowToTask 时间字段与域模型映射一致', () => {
    const row = makeTaskRow({
      status: 'failed',
      started_at: T0,
      finished_at: T1,
      interrupted_at: null,
      error_code: 'research-internal',
    });
    const task: ResearchTask = rowToTask(row)!;
    expect(task.status).toBe('failed');
    expect(task.startedAt).toBe(T0);
    expect(task.finishedAt).toBe(T1);
    expect(task.interruptedAt).toBeNull();
    expect(task.errorCode).toBe('research-internal');
    expect(task.updatedAt).toBe(T0);
  });
});
