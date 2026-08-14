// change-journal unit tests (B2): durable Undo data layer — record/replay lookup,
// partial unique index (adjudication #53), bounded prune (count/age, injected clock),
// exact source removal for hard delete (adjudication #55), malformed payload safety.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type DbHandle } from '../db/sqlite-driver';
import { runMigrations } from '../db/migrations';
import type { SourceRow } from './source-repository';
import {
  ChangeJournal,
  JOURNAL_MAX_AGE_MS,
  JOURNAL_MAX_ENTRIES,
  parseSnapshotMap,
  serializeSnapshotMap,
  type JournalEntry,
} from './change-journal';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-journal-'));
const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0); // 2026-01-01T00:00:00Z

let handle: DbHandle;
let nowMs: number;
let journal: ChangeJournal;

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
  idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
  runId: null,
  toolCallId: null,
  changeType: 'manual',
  beforePayload: '{}',
  afterPayload: '{}',
  sourceIds: [],
  requestFingerprint: null,
  resultPayload: null,
  appliedAt: new Date(nowMs).toISOString(),
  ...over,
});

const snapshotMap = (rows: Record<string, unknown>): string => JSON.stringify(rows);

const rowOf = (id: string, version: number): SourceRow => ({
  id,
  scope: 'page',
  canonical_key: 'https://e.com/p',
  url: 'https://e.com/p',
  name: 'n',
  group_id: null,
  priority: 3,
  enabled: 1,
  share_mode: 'metadata',
  trust_value: 'unknown',
  trust_asserted_by: 'ai',
  trust_verification: 'unverified',
  user_note: '',
  ai_note: '',
  created_by: 'ai',
  version,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  deleted_at: null,
  last_used_at: null,
  last_usage_outcome: null,
});

beforeEach(() => {
  nowMs = BASE_MS;
  handle = openDb(join(root, `journal-${Math.random().toString(36).slice(2)}.db`));
  runMigrations(handle);
  journal = new ChangeJournal(handle, () => nowMs);
});

afterEach(() => {
  closeDb(handle); // 每用例关闭句柄（Windows 文件锁；重复关闭幂等）
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('record / 查询', () => {
  it('record → findByKey 全字段往返（sourceIds 数组持久化）', () => {
    const e = entry({
      idempotencyKey: 'k-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      changeType: 'agent-change-set',
      sourceIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
      requestFingerprint: 'fp',
      resultPayload: '{"ok":true}',
      beforePayload: snapshotMap({ a: 1 }),
      afterPayload: snapshotMap({ b: 2 }),
    });
    journal.record(e);
    const got = journal.findByKey('k-1');
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      idempotencyKey: 'k-1',
      runId: 'run-1',
      toolCallId: 'tool-1',
      changeType: 'agent-change-set',
      requestFingerprint: 'fp',
      resultPayload: '{"ok":true}',
      sourceIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'],
    });
  });

  it('findByRunTool 命中/未命中', () => {
    journal.record(entry({ runId: 'r', toolCallId: 't', changeType: 'agent-change-set' }));
    expect(journal.findByRunTool('r', 't')?.idempotencyKey).toBeDefined();
    expect(journal.findByRunTool('r', 'other')).toBeNull();
    expect(journal.findByRunTool('other', 't')).toBeNull();
  });

  it('部分唯一索引：同 (run, tool) 第二次 record → duplicate-journal-run-tool', () => {
    journal.record(entry({ runId: 'r1', toolCallId: 't1', changeType: 'agent-change-set' }));
    expect(() =>
      journal.record(entry({ runId: 'r1', toolCallId: 't1', changeType: 'agent-change-set' })),
    ).toThrowError(expect.objectContaining({ code: 'duplicate-journal-run-tool' }));
  });

  it('manual 行 (run,tool)=NULL 不受部分唯一索引约束（多条 NULL 并存）', () => {
    journal.record(entry({ changeType: 'manual' }));
    journal.record(entry({ changeType: 'manual' }));
    expect(journal.listRecent().length).toBe(2);
  });

  it('idempotencyKey 主键冲突 → duplicate-journal-key', () => {
    journal.record(entry({ idempotencyKey: 'dup' }));
    expect(() => journal.record(entry({ idempotencyKey: 'dup' }))).toThrowError(
      expect.objectContaining({ code: 'duplicate-journal-key' }),
    );
  });

  it('listRecent 按 applied_at 降序、默认有界 100', () => {
    journal.record(entry({ appliedAt: '2026-01-01T00:00:00.000Z' }));
    journal.record(entry({ appliedAt: '2026-01-02T00:00:00.000Z' }));
    journal.record(entry({ appliedAt: '2026-01-03T00:00:00.000Z' }));
    const list = journal.listRecent();
    expect(list.map((e) => e.appliedAt)).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
  });
});

describe('有界清理（100 条 / 30 天双上限，注入时钟）', () => {
  it('101 条边界：第 101 条触发清理，最旧被删、保留恰好 100 条', () => {
    for (let i = 0; i < 100; i += 1) {
      journal.record(entry({ appliedAt: new Date(BASE_MS + i * 1000).toISOString() }));
    }
    expect(journal.listRecent(JOURNAL_MAX_ENTRIES + 10).length).toBe(100);
    nowMs = BASE_MS + 200 * 1000;
    journal.record(entry({ appliedAt: new Date(nowMs).toISOString() })); // 第 101 条
    const list = journal.listRecent(JOURNAL_MAX_ENTRIES + 10);
    expect(list.length).toBe(100);
    expect(list.some((e) => e.appliedAt === new Date(BASE_MS).toISOString())).toBe(false); // 最旧已清
  });

  it('恰好 100 条不触发清理', () => {
    for (let i = 0; i < 100; i += 1) {
      journal.record(entry({ appliedAt: new Date(BASE_MS + i * 1000).toISOString() }));
    }
    expect(journal.listRecent(JOURNAL_MAX_ENTRIES + 10).length).toBe(100);
  });

  it('30 天边界：恰好 30 天保留、超过 30 天清理', () => {
    journal.record(entry({ appliedAt: new Date(BASE_MS).toISOString() }));
    nowMs = BASE_MS + JOURNAL_MAX_AGE_MS; // 恰好 30 天
    journal.record(entry({ appliedAt: new Date(nowMs).toISOString() }));
    expect(journal.listRecent().length).toBe(2); // 恰好 30 天未被清理
    nowMs = BASE_MS + JOURNAL_MAX_AGE_MS + 1000; // 超过 30 天
    journal.record(entry({ appliedAt: new Date(nowMs).toISOString() }));
    const list = journal.listRecent();
    expect(list.some((e) => e.appliedAt === new Date(BASE_MS).toISOString())).toBe(false);
  });

  it('prune 幂等（重复调用无副作用）', () => {
    journal.record(entry({}));
    journal.prune();
    journal.prune();
    expect(journal.listRecent().length).toBe(1);
  });
});

describe('hard delete 精确清理（决议 #55）', () => {
  const sourceA = '11111111-1111-4111-8111-111111111111';
  const sourceALike = '11111111-1111-4111-8111-111111111111-longer';

  it('removeSource：移除目标条目与快照、其余 source 保留', () => {
    const before = serializeSnapshotMap({
      [sourceA]: { row: rowOf(sourceA, 1), tags: [] },
      '22222222-2222-4222-8222-222222222222': {
        row: rowOf('22222222-2222-4222-8222-222222222222', 2),
        tags: ['x'],
      },
    });
    const after = serializeSnapshotMap({
      [sourceA]: { row: rowOf(sourceA, 2), tags: [] },
      '22222222-2222-4222-8222-222222222222': {
        row: rowOf('22222222-2222-4222-8222-222222222222', 2),
        tags: ['x'],
      },
    });
    journal.record(
      entry({
        idempotencyKey: 'k-rm',
        sourceIds: [sourceA, '22222222-2222-4222-8222-222222222222'],
        beforePayload: before,
        afterPayload: after,
      }),
    );
    journal.removeSource('k-rm', sourceA);
    const got = journal.findByKey('k-rm');
    expect(got).not.toBeNull();
    expect(got?.sourceIds).toEqual(['22222222-2222-4222-8222-222222222222']);
    const beforeMap = parseSnapshotMap(got?.beforePayload ?? '');
    expect(beforeMap).not.toBeNull();
    expect(beforeMap![sourceA]).toBeUndefined();
    expect(beforeMap!['22222222-2222-4222-8222-222222222222']).toBeDefined();
  });

  it('UUID 全串相等匹配：相似 id 不误伤（无子串误匹配）', () => {
    journal.record(
      entry({
        idempotencyKey: 'k-exact',
        sourceIds: [sourceA, sourceALike],
        beforePayload: serializeSnapshotMap({
          [sourceA]: { row: null, tags: [] },
          [sourceALike]: { row: null, tags: [] },
        }),
        afterPayload: serializeSnapshotMap({
          [sourceA]: { row: null, tags: [] },
          [sourceALike]: { row: null, tags: [] },
        }),
      }),
    );
    journal.removeSource('k-exact', sourceA);
    const got = journal.findByKey('k-exact');
    expect(got?.sourceIds).toEqual([sourceALike]); // 相似 id 保留
  });

  it('移除后 sourceIds 为空 → 删除整条 journal 行', () => {
    journal.record(
      entry({
        idempotencyKey: 'k-last',
        sourceIds: [sourceA],
        beforePayload: serializeSnapshotMap({ [sourceA]: { row: null, tags: [] } }),
        afterPayload: serializeSnapshotMap({ [sourceA]: { row: null, tags: [] } }),
      }),
    );
    journal.removeSource('k-last', sourceA);
    expect(journal.findByKey('k-last')).toBeNull();
  });

  it('deleteByKey：存在删除返回 true、不存在 false', () => {
    journal.record(entry({ idempotencyKey: 'k-del' }));
    expect(journal.deleteByKey('k-del')).toBe(true);
    expect(journal.deleteByKey('k-del')).toBe(false);
  });
});

describe('payload 形状校验（损坏/畸形安全失败）', () => {
  it('serialize/parse 往返恒等；畸形输入返回 null（不抛）', () => {
    const map = {
      '11111111-1111-4111-8111-111111111111': {
        row: rowOf('11111111-1111-4111-8111-111111111111', 1),
        tags: ['a'],
      },
    };
    expect(parseSnapshotMap(serializeSnapshotMap(map))).toEqual(map);
    expect(parseSnapshotMap('not-json')).toBeNull();
    expect(parseSnapshotMap('null')).toBeNull();
    expect(parseSnapshotMap('{"a": 1}')).toBeNull(); // 非映射形状
    expect(parseSnapshotMap('{"a": {"tags": "x"}}')).toBeNull(); // tags 非数组
    expect(parseSnapshotMap('{"a": {"row": 42, "tags": []}}')).toBeNull(); // row 非对象/null
    expect(parseSnapshotMap('{"a": {"row": {"id": 1}, "tags": []}}')).toBeNull(); // row 必填字段形状非法
  });
});
