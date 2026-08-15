// source-repository unit tests (B2): unique constraint (composite, adjudication #49),
// two-connection concurrency, optimistic version, idempotent group/tag upsert,
// FTS mirror sync (adjudication #54), injection strings as data only, bounded basic
// search. Test probe SQL confined to this file (adjudication #47).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type DbHandle } from '../db/sqlite-driver';
import { runMigrations } from '../db/migrations';
import {
  SourceRepository,
  rowToSource,
  type SourceFieldValues,
  type SourceRow,
} from './source-repository';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-repo-'));
const T0 = '2026-08-15T00:00:00.000Z';

let handle: DbHandle;
let repo: SourceRepository;

const makeRow = (over: Partial<SourceRow> & { id?: string } = {}): SourceRow => ({
  id: over.id ?? '11111111-1111-4111-8111-111111111111',
  scope: 'page',
  canonical_key: 'https://example.com/p',
  url: 'https://example.com/p',
  name: '示例页',
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
  version: 1,
  created_at: T0,
  updated_at: T0,
  deleted_at: null,
  last_used_at: null,
  last_usage_outcome: null,
  ...over,
});

const insertRow = (over: Partial<SourceRow> & { id?: string } = {}): SourceRow => {
  const row = makeRow(over);
  repo.insertSource(row);
  return row;
};

beforeEach(() => {
  handle = openDb(join(root, `repo-${Math.random().toString(36).slice(2)}.db`));
  runMigrations(handle);
  repo = new SourceRepository(handle);
});

afterEach(() => {
  closeDb(handle);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('CRUD 与读回', () => {
  it('insertSource → rowid > 0；getSourceById 全字段往返；rowToSource 映射', () => {
    const row = insertRow({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', priority: 5 });
    const got = repo.getSourceById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    expect(got).toEqual(row);
    expect(repo.getSourceRowid('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).toBeGreaterThan(0);
    const domain = rowToSource(row);
    expect(domain.priority).toBe(5);
    expect(domain.enabled).toBe(true);
    expect(domain.trust).toEqual({
      value: 'unknown',
      assertedBy: 'ai',
      verification: 'unverified',
    });
  });

  it('getSourceByCanonical 命中/未命中（复合键）', () => {
    insertRow({});
    expect(repo.getSourceByCanonical('page', 'https://example.com/p')?.id).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(repo.getSourceByCanonical('origin', 'https://example.com/p')).toBeNull(); // 键空间独立（决议 #49）
  });

  it('同 (scope, canonical_key) 双写 → 第二写 RepositoryError duplicate-source', () => {
    insertRow({});
    expect(() => insertRow({ id: '22222222-2222-4222-8222-222222222222' })).toThrowError(
      expect.objectContaining({ code: 'duplicate-source' }),
    );
  });

  it('不同 scope 同 canonical_key 并存（决议 #49 键空间独立）', () => {
    insertRow({});
    expect(() =>
      insertRow({ id: '33333333-3333-4333-8333-333333333333', scope: 'origin' }),
    ).not.toThrow();
  });

  it('两个独立连接写同一 canonical identity：恰一个成功（约束兜底，非先查后写）', () => {
    const dbPath = join(root, `concurrent-${Math.random().toString(36).slice(2)}.db`);
    const h1 = openDb(dbPath);
    runMigrations(h1);
    const h2 = openDb(dbPath); // 第二独立连接（同文件，各自事务）
    try {
      const r1 = new SourceRepository(h1);
      const r2 = new SourceRepository(h2);
      const rowA = makeRow({});
      // h1 直接写入同 canonical 并提交；h2 从未查询（不可能「先查后写」）——
      // 唯一约束在第二连接同样拦截（约束兜底证据；锁竞争等待语义已由 B1 ⑦ 实测）
      r1.insertSource({ ...rowA, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
      expect(() =>
        r2.insertSource({ ...rowA, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
      ).toThrowError(expect.objectContaining({ code: 'duplicate-source' }));
      expect(r2.getSourceById('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).not.toBeNull();
      expect(r2.getSourceById('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBeNull();
    } finally {
      closeDb(h2);
      closeDb(h1);
    }
  });
});

const fieldValues = (row: SourceRow, over: Partial<SourceFieldValues> = {}): SourceFieldValues => ({
  url: row.url,
  canonical_key: row.canonical_key,
  name: row.name,
  group_id: row.group_id,
  priority: row.priority,
  share_mode: row.share_mode,
  trust_value: row.trust_value,
  trust_asserted_by: row.trust_asserted_by,
  trust_verification: row.trust_verification,
  user_note: row.user_note,
  ai_note: row.ai_note,
  ...over,
});

describe('乐观并发与状态迁移（决议 #51）', () => {
  it('updateSourceFields：version 匹配恰 +1；过期 → version-mismatch 且行不变', () => {
    const row = insertRow({});
    repo.updateSourceFields(
      '11111111-1111-4111-8111-111111111111',
      1,
      fieldValues(row, { name: '新名' }),
      T0,
    );
    expect(repo.getSourceById('11111111-1111-4111-8111-111111111111')?.version).toBe(2);
    expect(() =>
      repo.updateSourceFields(
        '11111111-1111-4111-8111-111111111111',
        1,
        fieldValues(row, { name: '过期写' }),
        T0,
      ),
    ).toThrowError(expect.objectContaining({ code: 'version-mismatch' }));
    expect(repo.getSourceById('11111111-1111-4111-8111-111111111111')?.name).toBe('新名');
  });

  it('setSourceDisabled/Restored：enabled/deleted_at 联动 + version 恰 +1', () => {
    insertRow({});
    repo.setSourceDisabled('11111111-1111-4111-8111-111111111111', 1, T0, T0);
    let row = repo.getSourceById('11111111-1111-4111-8111-111111111111')!;
    expect(row.enabled).toBe(0);
    expect(row.deleted_at).toBe(T0);
    expect(row.version).toBe(2);
    repo.setSourceRestored('11111111-1111-4111-8111-111111111111', 2, T0);
    row = repo.getSourceById('11111111-1111-4111-8111-111111111111')!;
    expect(row.enabled).toBe(1);
    expect(row.deleted_at).toBeNull();
    expect(row.version).toBe(3);
  });
});

describe('group/tag 幂等 upsert 与 links', () => {
  it('upsertGroup 同名（含 NOCASE 折叠）→ 同 id，不产生重复条目', () => {
    const a = repo.upsertGroup('News', T0);
    const b = repo.upsertGroup('News', T0);
    const c = repo.upsertGroup('news', T0); // NOCASE
    expect(a.id).toBe(b.id);
    expect(a.id).toBe(c.id);
    expect(repo.getGroupByName('News')?.id).toBe(a.id);
  });

  it('upsertTag 同名 → 同 id；listTagsBySource 确定性排序', () => {
    const t1 = repo.upsertTag('beta', T0);
    const t2 = repo.upsertTag('alpha', T0);
    expect(repo.upsertTag('beta', T0).id).toBe(t1.id);
    insertRow({});
    repo.setSourceTags('11111111-1111-4111-8111-111111111111', [t1.id, t2.id]);
    expect(repo.listTagsBySource('11111111-1111-4111-8111-111111111111')).toEqual([
      'alpha',
      'beta',
    ]);
    repo.setSourceTags('11111111-1111-4111-8111-111111111111', [t2.id]); // 替换语义
    expect(repo.listTagsBySource('11111111-1111-4111-8111-111111111111')).toEqual(['alpha']);
  });
});

describe('FTS 镜像同步（决议 #54）', () => {
  const ftsCount = (): number =>
    (handle.prepare('SELECT COUNT(*) AS n FROM sources_fts').get() as { n: number }).n;
  const ftsHit = (q: string): boolean =>
    (
      handle.prepare('SELECT COUNT(*) AS n FROM sources_fts WHERE sources_fts MATCH ?').get(q) as {
        n: number;
      }
    ).n > 0;

  it('insert → FTS 命中；update（name/note 变化）→ 旧值不命中新值命中；行数恒等', () => {
    // 中文查询串 ≥3 字符（trigram 语义，B1 实测冻结：1–2 字符不命中）
    const rowid = repo.insertSource({
      ...makeRow({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }),
      name: '甲名站',
      user_note: '备注一',
    });
    repo.ftsInsert(rowid, '甲名站', 'https://example.com/p', '备注一', '');
    expect(ftsHit('甲名站')).toBe(true);
    expect(ftsHit('备注一')).toBe(true);
    expect(ftsCount()).toBe(1);
    repo.ftsDelete(rowid, '甲名站', 'https://example.com/p', '备注一', '');
    repo.ftsInsert(rowid, '乙名站', 'https://example.com/p', '备注二', '');
    expect(ftsHit('乙名站')).toBe(true);
    expect(ftsHit('备注二')).toBe(true);
    expect(ftsHit('甲名站')).toBe(false);
    expect(ftsCount()).toBe(1);
  });

  it('delete → FTS 行移除、行数恒等', () => {
    const rowid = repo.insertSource({
      ...makeRow({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }),
      name: '待删',
    });
    repo.ftsInsert(rowid, '待删', 'https://example.com/p', '', '');
    repo.ftsDelete(rowid, '待删', 'https://example.com/p', '', '');
    repo.deleteSource('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(ftsCount()).toBe(0);
    expect(repo.getSourceById('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')).toBeNull();
  });
});

describe('注入串仅作数据（prepared statements）', () => {
  it('SQL 注入/引号/通配符/控制字符只作数据：读回恒等、表完好', () => {
    const evil = "'; DROP TABLE sources;--";
    insertRow({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      name: evil,
      user_note: "' OR 1=1 --",
      ai_note: '%_\\',
    });
    const got = repo.getSourceById('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    expect(got?.name).toBe(evil);
    expect(got?.user_note).toBe("' OR 1=1 --");
    expect(got?.ai_note).toBe('%_\\');
    expect(
      (
        handle.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sources'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });

  it('searchBasic：LIKE 通配符按字面匹配（ESCAPE 转义，前缀语义）', () => {
    // 前缀语义：查询串中的 %/_ 只作数据——仅名称以字面 % 开头的行命中
    insertRow({
      id: '77777777-7777-4777-8777-777777777777',
      canonical_key: 'https://e.com/p1',
      url: 'https://e.com/p1',
      name: '%可靠站',
    });
    insertRow({
      id: '88888888-8888-4888-8888-888888888888',
      canonical_key: 'https://e.com/p2',
      url: 'https://e.com/p2',
      name: '100%可靠',
    });
    insertRow({
      id: '99999999-9999-4999-8999-999999999999',
      canonical_key: 'https://e.com/x',
      url: 'https://e.com/x',
      name: '其他',
    });
    expect(repo.searchBasic('%可靠', 10).map((r) => r.name)).toEqual(['%可靠站']); // 字面前缀 %可靠
    expect(repo.searchBasic('%', 10).map((r) => r.name)).toEqual(['%可靠站']); // 字面 % 前缀
    expect(repo.searchBasic('%可靠站x', 10)).toHaveLength(0);
  });

  it('searchBasic：name/tag/group/canonical 精确或前缀命中；软删行不命中；确定性排序', () => {
    const g = repo.upsertGroup('AI组', T0);
    const t = repo.upsertTag('benchmark', T0);
    const r1 = insertRow({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      name: 'Benchmark 站',
      group_id: g.id,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    repo.setSourceTags(r1.id, [t.id]);
    insertRow({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      canonical_key: 'https://e.com/other',
      url: 'https://e.com/other',
      name: '其他页',
      created_at: '2026-02-01T00:00:00.000Z',
    });
    expect(repo.searchBasic('benchmark', 10).map((r) => r.id)).toEqual([
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]);
    expect(repo.searchBasic('AI组', 10)).toHaveLength(1);
    expect(repo.searchBasic('Benchmark', 10)).toHaveLength(1); // name 前缀
    expect(repo.searchBasic('https://e.com/other', 10)).toHaveLength(1); // canonical 精确
    repo.setSourceDisabled('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 1, T0, T0);
    expect(repo.searchBasic('其他页', 10)).toHaveLength(0); // 软删行不命中（决议 #51）
  });
});

describe('list/count/usage', () => {
  it('listSources：deleted_at 过滤、enabledOnly、groupId、created_at DESC + id ASC 定序', () => {
    const g = repo.upsertGroup('组', T0);
    insertRow({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      group_id: g.id,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    insertRow({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      canonical_key: 'https://e.com/b',
      url: 'https://e.com/b',
      name: 'b',
      created_at: '2026-03-01T00:00:00.000Z',
    });
    insertRow({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      canonical_key: 'https://e.com/c',
      url: 'https://e.com/c',
      name: 'c',
      created_at: '2026-03-01T00:00:00.000Z',
    });
    expect(repo.listSources({ limit: 10, offset: 0 }).map((r) => r.id)).toEqual([
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', // created_at DESC + id ASC 全序
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ]);
    expect(repo.listSources({ limit: 10, offset: 0, groupId: g.id })).toHaveLength(1);
    expect(repo.countSources({})).toBe(3);
    expect(repo.countSources({ groupId: g.id })).toBe(1);
  });

  it('upsertUsage：REPLACE 语义（每 Source 仅最近一次）+ 读回', () => {
    insertRow({}); // FK 前置：usage_events 引用 sources
    repo.upsertUsage('11111111-1111-4111-8111-111111111111', 'reachable', T0);
    repo.upsertUsage('11111111-1111-4111-8111-111111111111', 'unreachable', T0);
    const row = handle
      .prepare('SELECT outcome, recorded_at FROM usage_events WHERE source_id = ?')
      .get('11111111-1111-4111-8111-111111111111') as { outcome: string };
    expect(row.outcome).toBe('unreachable');
  });

  it('deleteSource：行删除 + CASCADE 清 tag_links 与 usage_events', () => {
    const g = repo.upsertGroup('g', T0);
    const t = repo.upsertTag('t', T0);
    insertRow({ group_id: g.id });
    repo.setSourceTags('11111111-1111-4111-8111-111111111111', [t.id]);
    repo.upsertUsage('11111111-1111-4111-8111-111111111111', 'reachable', T0);
    repo.deleteSource('11111111-1111-4111-8111-111111111111');
    const count = (sql: string): number => (handle.prepare(sql).get() as { n: number }).n;
    expect(count('SELECT COUNT(*) AS n FROM source_tag_links')).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM usage_events')).toBe(0);
  });
});

// ---------- B5 扩展（决议 #71/#72）：有界 listGroups + findRelatedByOrigin ----------
// 测试探针 SQL 仅限本文件（决议 #47）。

describe('B5：listGroups / countGroups', () => {
  it('软删分组过滤 + 确定性排序（NOCASE）+ 分页', () => {
    repo.upsertGroup('Beta', T0);
    repo.upsertGroup('alpha', T0);
    repo.upsertGroup('Gamma', T0);
    // 测试探针：模拟已软删分组（产品无组删除路径；deleted_at IS NULL 过滤为纵深防御）
    const g = repo.upsertGroup('zzz-deleted', T0);
    handle.prepare('UPDATE source_groups SET deleted_at = ? WHERE id = ?').run(T0, g.id);
    expect(repo.countGroups()).toBe(3);
    const page0 = repo.listGroups(2, 0);
    expect(page0.map((x) => x.name)).toEqual(['alpha', 'Beta']);
    expect(page0.every((x) => x.deleted_at === null)).toBe(true);
    const page1 = repo.listGroups(2, 2);
    expect(page1.map((x) => x.name)).toEqual(['Gamma']);
  });

  it('limit/offset 边界：offset 超界 → 空结果（安全返回）', () => {
    repo.upsertGroup('only', T0);
    expect(repo.listGroups(20, 100)).toEqual([]);
    expect(repo.countGroups()).toBe(1);
  });
});

describe('B5：findRelatedByOrigin（有界同 origin 读取路径）', () => {
  it('origin 前缀匹配：origin 作用域条目（键=origin）+ page 条目（键=origin+路径）', () => {
    insertRow({
      scope: 'origin',
      canonical_key: 'https://example.com',
      url: 'https://example.com',
    });
    insertRow({
      id: '22222222-2222-4222-8222-222222222222',
      canonical_key: 'https://example.com/p1',
      url: 'https://example.com/p1',
    });
    insertRow({
      id: '33333333-3333-4333-8333-333333333333',
      canonical_key: 'https://example.org/p',
      url: 'https://example.org/p',
    });
    const rows = repo.findRelatedByOrigin('https://example.com', 'https://example.com/p1', 5);
    expect(rows.map((r) => r.canonical_key)).toEqual(['https://example.com']);
  });

  it('排除目标键 + 有界 LIMIT + 软删过滤 + 确定性排序（created_at DESC, id ASC）', () => {
    for (let i = 0; i < 6; i += 1) {
      insertRow({
        id: `44444444-4444-4444-8444-44444444444${i}`,
        canonical_key: `https://example.com/p-${i}`,
        url: `https://example.com/p-${i}`,
        created_at: `2026-08-15T00:00:0${i}.000Z`,
      });
    }
    insertRow({
      id: '55555555-5555-4555-8555-555555555555',
      canonical_key: 'https://example.com/deleted',
      url: 'https://example.com/deleted',
      deleted_at: T0,
    });
    const rows = repo.findRelatedByOrigin('https://example.com', 'https://example.com/p-0', 5);
    expect(rows.length).toBe(5);
    expect(rows.map((r) => r.canonical_key)).toEqual([
      'https://example.com/p-5',
      'https://example.com/p-4',
      'https://example.com/p-3',
      'https://example.com/p-2',
      'https://example.com/p-1',
    ]);
  });

  it('前缀转义：origin 中的 LIKE 通配符只作数据（未转义会误命中其他行）', () => {
    // origin 参数虽由服务层经 WHATWG URL 解析派生（不含通配符），Repository 仍须
    // 将入参只作数据（纵深防御）：含 %/_ 的 origin 不得按通配符语义误命中
    // （未转义时 'x%_/%' 会误命中 'xA/y'）。
    insertRow({
      canonical_key: 'https://example.com/x%_/y',
      url: 'https://example.com/x%_/y',
    });
    insertRow({
      id: '66666666-6666-4666-8666-666666666666',
      canonical_key: 'https://example.com/xA/y',
      url: 'https://example.com/xA/y',
    });
    const rows = repo.findRelatedByOrigin('https://example.com/x%_', 'https://example.com/none', 5);
    expect(rows.map((r) => r.canonical_key)).toEqual(['https://example.com/x%_/y']);
  });
});
