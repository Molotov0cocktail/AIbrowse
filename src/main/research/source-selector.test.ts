// Fifth Stage C3: source-selector tests — pure-function merge of Sources +
// Search candidate feeds (detailed-design §4, adjudications #120–#123).
// Covers: three discovery tiers reachability & strict order; upstream input
// order preservation; same-identity merge rules; provenance inheritance
// (search-only candidates carry no trust assertion); note mapping with author
// labels; candidateId input contract (fail-closed on invalid/duplicate ids);
// sortKey ASCII encoding incl. real node:sqlite ORDER BY sort_key agreement;
// hostile-input matrix (no throw, no log bodies); bounded cropping (24/8).
// The SQLite agreement probe is confined to this file (test facility only).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import {
  ResearchRepository,
  type ResearchCandidateRow,
  type ResearchTaskRow,
} from './repository/research-repository';
import type { SourceCandidate, ResearchTaskStats } from '../../shared/types/research';
import {
  MAX_CANDIDATE_NOTE_CHARS,
  MAX_CANDIDATE_TITLE_CHARS,
  MAX_SELECTED_SOURCES,
  MAX_SOURCE_CANDIDATES,
} from '../../shared/types/research';
import type { SearchResult } from '../ai/search/search-provider';
import type { SourceListItem, SourceSearchItem, SourceTrust } from '../../shared/types/sources';

import {
  buildCandidateSortKey,
  mergeCandidates,
  selectCandidates,
  type MergeCandidatesInput,
  type SourcesCandidateFeed,
  type WebSearchCandidateEntry,
} from './source-selector';

// ---------- fixtures ----------

const U = {
  a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  c: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  d: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  e: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  f: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  g: '11111111-1111-4111-8111-111111111111',
  h: '22222222-2222-4222-8222-222222222222',
  i: '33333333-3333-4333-8333-333333333333',
  j: '44444444-4444-4444-8444-444444444444',
  k: '55555555-5555-4555-8555-555555555555',
  l: '66666666-6666-4666-8666-666666666666',
  m: '77777777-7777-4777-8777-777777777777',
  n: '88888888-8888-4888-8888-888888888888',
  o: '99999999-9999-4999-8999-999999999999',
  p: 'aaaa0000-0000-4000-8000-000000000000',
  q: 'bbbb0000-0000-4000-8000-000000000000',
  r: 'cccc0000-0000-4000-8000-000000000000',
  s: 'dddd0000-0000-4000-8000-000000000000',
  t: 'eeee0000-0000-4000-8000-000000000000',
  u: 'ffff0000-0000-4000-8000-000000000000',
  v: '11110000-0000-4000-8000-000000000000',
  w: '22220000-0000-4000-8000-000000000000',
  x: '33330000-0000-4000-8000-000000000000',
  y: '44440000-0000-4000-8000-000000000000',
  z: '55550000-0000-4000-8000-000000000000',
} as const;

const TASK_ID = '99999999-9999-4999-8999-999999999999';

const TRUST_AI_UNVERIFIED: SourceTrust = {
  value: 'unknown',
  assertedBy: 'ai',
  verification: 'unverified',
};
const TRUST_USER_ASSERTED: SourceTrust = {
  value: 'primary',
  assertedBy: 'user',
  verification: 'asserted',
};

function makeSearchItem(over: Partial<SourceSearchItem> = {}): SourceSearchItem {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    scope: 'page',
    canonicalKey: 'https://example.com/p',
    url: 'https://example.com/p',
    name: '示例来源',
    groupId: null,
    groupName: null,
    tags: [],
    priority: 3,
    enabled: true,
    trust: TRUST_AI_UNVERIFIED,
    shareMode: 'full',
    lastUsedAt: null,
    note: null,
    ...over,
  };
}

function makeListItem(over: Partial<SourceListItem> = {}): SourceListItem {
  return {
    id: '77777777-7777-4777-8777-777777777777',
    scope: 'page',
    canonicalKey: 'https://example.com/p',
    url: 'https://example.com/p',
    name: '示例来源',
    groupId: null,
    groupName: null,
    tags: [],
    priority: 3,
    enabled: true,
    trust: TRUST_AI_UNVERIFIED,
    shareMode: 'full',
    lastUsedAt: null,
    ...over,
  };
}

function makeSearchResult(over: Partial<SearchResult> = {}): SearchResult {
  return {
    title: '搜索结果标题',
    url: 'https://example.com/p',
    snippet: '',
    source: 'bing',
    ...over,
  };
}

function sourcesFeed(
  kind: 'source-search',
  entries: readonly { candidateId: string; item: SourceSearchItem }[],
): SourcesCandidateFeed;
function sourcesFeed(
  kind: 'group-list',
  entries: readonly { candidateId: string; item: SourceListItem }[],
): SourcesCandidateFeed;
function sourcesFeed(
  kind: SourcesCandidateFeed['kind'],
  entries: readonly {
    candidateId: string;
    item: SourceListItem | SourceSearchItem;
  }[],
): SourcesCandidateFeed {
  return { kind, entries } as SourcesCandidateFeed;
}

function sortCandidatesBinary(candidates: readonly SourceCandidate[]): SourceCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.sortKey < b.sortKey) return -1;
    if (a.sortKey > b.sortKey) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

const NULL_TIME_SENTINEL = '~~~~~~~~~~~~~~~~~~~~~~~~';

// ---------- A. 三档可达性 ----------

describe('A. 三档发现路径可达性（决议 #120）', () => {
  it('source-search feed 产生 tier 1 候选', () => {
    const input: MergeCandidatesInput = {
      sources: sourcesFeed('source-search', [{ candidateId: U.a, item: makeSearchItem() }]),
      search: [],
    };
    const r = mergeCandidates(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].sortKey.startsWith('01|')).toBe(true);
  });

  it('group-list feed 产生 tier 2 候选', () => {
    const input: MergeCandidatesInput = {
      sources: sourcesFeed('group-list', [{ candidateId: U.a, item: makeListItem() }]),
      search: [],
    };
    const r = mergeCandidates(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].sortKey.startsWith('02|')).toBe(true);
  });

  it('search-only 输入产生 tier 3 候选', () => {
    const input: MergeCandidatesInput = {
      sources: null,
      search: [{ candidateId: U.a, result: makeSearchResult() }],
    };
    const r = mergeCandidates(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].sortKey.startsWith('03|')).toBe(true);
  });

  it('档位严格不可跨档：tier 1 < tier 2 < tier 3', () => {
    const input: MergeCandidatesInput = {
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            url: 'https://tier1.example/p',
            canonicalKey: 'https://tier1.example/p',
          }),
        },
      ]),
      search: [{ candidateId: U.c, result: makeSearchResult({ url: 'https://tier3.example/p' }) }],
    };
    // tier 2 单独合入：同一 merge 只能有一个 sources feed kind——
    // 用两个 merge 结果联合断言排序（各档排序键前缀独立成立）。
    const tier2: MergeCandidatesInput = {
      sources: sourcesFeed('group-list', [
        {
          candidateId: U.b,
          item: makeListItem({
            url: 'https://tier2.example/p',
            canonicalKey: 'https://tier2.example/p',
          }),
        },
      ]),
      search: [],
    };
    const r1 = mergeCandidates(input);
    const r2 = mergeCandidates(tier2);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const all = sortCandidatesBinary([...r1.candidates, ...r2.candidates]);
    expect(all.map((c) => c.id)).toEqual([U.a, U.b, U.c]);
  });

  it('trust/priority 不反转档位：tier 2 priority=5 仍在 tier 1 priority=1 之后', () => {
    const r1 = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            priority: 1,
            url: 'https://t1.example/p',
            canonicalKey: 'https://t1.example/p',
          }),
        },
      ]),
      search: [],
    });
    const r2 = mergeCandidates({
      sources: sourcesFeed('group-list', [
        {
          candidateId: U.b,
          item: makeListItem({
            priority: 5,
            url: 'https://t2.example/p',
            canonicalKey: 'https://t2.example/p',
          }),
        },
      ]),
      search: [],
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const all = sortCandidatesBinary([...r1.candidates, ...r2.candidates]);
    expect(all.map((c) => c.id)).toEqual([U.a, U.b]);
  });

  it('官方+user+asserted 的收藏候选仍在 tier 1 且不洗白为「已核验」', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            trust: { value: 'official', assertedBy: 'user', verification: 'asserted' },
            url: 'https://official.example/p',
            canonicalKey: 'https://official.example/p',
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].sortKey.startsWith('01|')).toBe(true);
    // provenance 原样继承：user+asserted ≠ 程序已核验（无任何核验字段）
    expect(r.candidates[0].trust).toEqual({
      value: 'official',
      assertedBy: 'user',
      verification: 'asserted',
    });
  });
});

// ---------- B. 上游顺序 ----------

describe('B. 上游顺序保留（决议 #120）', () => {
  it('source-search 保留 SourceService 输入 rank', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ url: 'https://e.example/1', canonicalKey: 'https://e.example/1' }),
        },
        {
          candidateId: U.b,
          item: makeSearchItem({ url: 'https://e.example/2', canonicalKey: 'https://e.example/2' }),
        },
        {
          candidateId: U.c,
          item: makeSearchItem({ url: 'https://e.example/3', canonicalKey: 'https://e.example/3' }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.map((c) => c.id)).toEqual([U.a, U.b, U.c]);
    expect(r.candidates[0].sortKey).toContain('|00000|');
    expect(r.candidates[1].sortKey).toContain('|00001|');
    expect(r.candidates[2].sortKey).toContain('|00002|');
  });

  it('即使后项 priority 更高也不得反转 source-search 上游匹配顺序', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            priority: 1,
            url: 'https://e.example/1',
            canonicalKey: 'https://e.example/1',
          }),
        },
        {
          candidateId: U.b,
          item: makeSearchItem({
            priority: 5,
            url: 'https://e.example/2',
            canonicalKey: 'https://e.example/2',
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.map((c) => c.id)).toEqual([U.a, U.b]);
  });

  it('note 命中候选通过输入 rank 参与选择，note 文本不进入 sortKey', () => {
    const noteText = '敏感备注内容不应出现在排序键';
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            url: 'https://e.example/1',
            canonicalKey: 'https://e.example/1',
            lastUsedAt: '2026-08-16T00:00:00.000Z',
          }),
        },
        {
          candidateId: U.b,
          item: makeSearchItem({
            url: 'https://e.example/2',
            canonicalKey: 'https://e.example/2',
            note: { userNote: noteText, aiNote: null },
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // note 命中（上游 #61 档位靠后）保持在输入 rank 1 位置
    expect(r.candidates.map((c) => c.id)).toEqual([U.a, U.b]);
    expect(r.candidates[1].note).toContain('用户备注：');
    expect(r.candidates[1].sortKey).not.toContain('用户备注');
    expect(r.candidates[1].sortKey).not.toContain(noteText);
  });

  it('web-search 保留 Provider rank', () => {
    const r = mergeCandidates({
      sources: null,
      search: [
        { candidateId: U.a, result: makeSearchResult({ url: 'https://w.example/1' }) },
        { candidateId: U.b, result: makeSearchResult({ url: 'https://w.example/2' }) },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.map((c) => c.id)).toEqual([U.a, U.b]);
  });

  it('group-list 才按 priority 降序排序', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('group-list', [
        {
          candidateId: U.a,
          item: makeListItem({
            priority: 1,
            url: 'https://g.example/1',
            canonicalKey: 'https://g.example/1',
          }),
        },
        {
          candidateId: U.b,
          item: makeListItem({
            priority: 5,
            url: 'https://g.example/2',
            canonicalKey: 'https://g.example/2',
          }),
        },
        {
          candidateId: U.c,
          item: makeListItem({
            priority: 3,
            url: 'https://g.example/3',
            canonicalKey: 'https://g.example/3',
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.map((c) => c.id)).toEqual([U.b, U.c, U.a]);
    // rank 字段恒 99999
    for (const c of r.candidates) expect(c.sortKey).toContain('|99999|');
  });

  it('group-list 同 priority 按 lastUsedAt 降序、null 末位', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('group-list', [
        {
          candidateId: U.a,
          item: makeListItem({
            url: 'https://g.example/1',
            canonicalKey: 'https://g.example/1',
            lastUsedAt: null,
          }),
        },
        {
          candidateId: U.b,
          item: makeListItem({
            url: 'https://g.example/2',
            canonicalKey: 'https://g.example/2',
            lastUsedAt: '2026-08-14T00:00:00.000Z',
          }),
        },
        {
          candidateId: U.c,
          item: makeListItem({
            url: 'https://g.example/3',
            canonicalKey: 'https://g.example/3',
            lastUsedAt: '2026-08-16T00:00:00.000Z',
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.map((c) => c.id)).toEqual([U.c, U.b, U.a]);
  });
});

// ---------- C. 合并 ----------

describe('C. 同身份合并（决策 D6 + 决议 #120/#122）', () => {
  it('page Source + 同 page Search → 一个候选、Sources 字段、双 discoveredVia', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            trust: TRUST_USER_ASSERTED,
            priority: 4,
            lastUsedAt: '2026-08-10T00:00:00.000Z',
            note: { userNote: '用户写下的备注', aiNote: null },
          }),
        },
      ]),
      search: [{ candidateId: U.b, result: makeSearchResult({ title: '搜索标题' }) }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    const c = r.candidates[0];
    expect(c.id).toBe(U.a); // 采用 Sources candidateId
    expect(c.discoveredVia).toEqual(['sources', 'search']);
    expect(c.title).toBe('示例来源'); // 取 Sources 名称
    expect(c.sourceId).toBe('77777777-7777-4777-8777-777777777777');
    expect(c.trust).toEqual(TRUST_USER_ASSERTED);
    expect(c.priority).toBe(4);
    expect(c.lastUsedAt).toBe('2026-08-10T00:00:00.000Z');
    expect(c.note).toContain('用户备注：');
    expect(c.sortKey.startsWith('01|')).toBe(true); // 采用 Sources 档位
  });

  it('origin Source + 同根 Search page → 不合并', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            scope: 'origin',
            url: 'https://example.com',
            canonicalKey: 'https://example.com',
          }),
        },
      ]),
      search: [{ candidateId: U.b, result: makeSearchResult({ url: 'https://example.com/p' }) }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0].discoveredVia).toEqual(['sources']);
    expect(r.candidates[1].discoveredVia).toEqual(['search']);
  });

  it('同 URL 但不同 canonicalKey（query 不同）不合并', () => {
    const r = mergeCandidates({
      sources: null,
      search: [
        { candidateId: U.a, result: makeSearchResult({ url: 'https://example.com/p?a=1' }) },
        { candidateId: U.b, result: makeSearchResult({ url: 'https://example.com/p?a=2' }) },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(2);
  });

  it('fragment 不参与 page 身份（#frag 变体合并）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            url: 'https://example.com/p#one',
            canonicalKey: 'https://example.com/p',
          }),
        },
      ]),
      search: [
        { candidateId: U.b, result: makeSearchResult({ url: 'https://example.com/p#two' }) },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].discoveredVia).toEqual(['sources', 'search']);
    expect(r.candidates[0].canonicalKey).toBe('https://example.com/p');
  });

  it('default port 规范化后合并', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            url: 'https://example.com/p',
            canonicalKey: 'https://example.com/p',
          }),
        },
      ]),
      search: [
        { candidateId: U.b, result: makeSearchResult({ url: 'https://example.com:443/p' }) },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].discoveredVia).toEqual(['sources', 'search']);
  });

  it('host 大小写规范化后合并（Search 大写 host）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            url: 'https://example.com/p',
            canonicalKey: 'https://example.com/p',
          }),
        },
      ]),
      search: [{ candidateId: U.b, result: makeSearchResult({ url: 'https://EXAMPLE.com/p' }) }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].displayUrl).toBe('https://example.com/p');
  });

  it('IDN 域名 punycode 规范化后合并', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            url: 'https://xn--mnchen-3ya.de/p',
            canonicalKey: 'https://xn--mnchen-3ya.de/p',
          }),
        },
      ]),
      search: [{ candidateId: U.b, result: makeSearchResult({ url: 'https://münchen.de/p' }) }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].canonicalKey).toBe('https://xn--mnchen-3ya.de/p');
  });

  it('重复 Sources 输入：保留 rank 更前，重复计入 droppedCount', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        { candidateId: U.a, item: makeSearchItem({ name: '首个' }) },
        { candidateId: U.b, item: makeSearchItem({ name: '重复项' }) },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].id).toBe(U.a);
    expect(r.candidates[0].title).toBe('首个');
    expect(r.droppedCount).toBe(1);
  });

  it('重复 Search 输入：保留 rank 更前，重复计入 droppedCount', () => {
    const r = mergeCandidates({
      sources: null,
      search: [
        { candidateId: U.a, result: makeSearchResult({ title: '首次' }) },
        { candidateId: U.b, result: makeSearchResult({ title: '重复' }) },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].id).toBe(U.a);
    expect(r.candidates[0].title).toBe('首次');
    expect(r.droppedCount).toBe(1);
  });
});

// ---------- D. provenance ----------

describe('D. provenance 继承（FT-07 防洗白）', () => {
  it('user+asserted 原样继承', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            trust: { value: 'official', assertedBy: 'user', verification: 'asserted' },
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].trust).toEqual({
      value: 'official',
      assertedBy: 'user',
      verification: 'asserted',
    });
  });

  it('ai+unverified 原样继承', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            trust: { value: 'official', assertedBy: 'ai', verification: 'unverified' },
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].trust).toEqual({
      value: 'official',
      assertedBy: 'ai',
      verification: 'unverified',
    });
  });

  it('search-only 候选 trust/priority/lastUsedAt/note/sourceId 恒 null', () => {
    const r = mergeCandidates({
      sources: null,
      search: [{ candidateId: U.a, result: makeSearchResult() }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.candidates[0];
    expect(c.trust).toBeNull();
    expect(c.priority).toBeNull();
    expect(c.lastUsedAt).toBeNull();
    expect(c.note).toBeNull();
    expect(c.sourceId).toBeNull();
  });

  it('畸形 trust（非法枚举值）整体降级 null', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            trust: {
              value: 'verified',
              assertedBy: 'user',
              verification: 'asserted',
            } as unknown as SourceTrust,
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].trust).toBeNull();
  });

  it('畸形 trust（user+unverified / ai+asserted 组合）整体降级 null', () => {
    for (const trust of [
      { value: 'primary', assertedBy: 'user', verification: 'unverified' },
      { value: 'primary', assertedBy: 'ai', verification: 'asserted' },
    ] as unknown as SourceTrust[]) {
      const r = mergeCandidates({
        sources: sourcesFeed('source-search', [
          { candidateId: U.a, item: makeSearchItem({ trust }) },
        ]),
        search: [],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.candidates[0].trust).toBeNull();
    }
  });

  it('畸形 trust（非对象形态）整体降级 null 且不抛异常', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            trust: 'official' as unknown as SourceTrust,
          }) as unknown as SourceSearchItem,
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].trust).toBeNull();
  });

  it('收藏、priority、note 不产生 verified/可信度字段', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            priority: 5,
            note: { userNote: '重要备注', aiNote: 'AI 摘要' },
            trust: { value: 'official', assertedBy: 'ai', verification: 'unverified' },
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.candidates[0];
    const keys = new Set(Object.keys(c));
    expect(keys.has('verified')).toBe(false);
    expect(keys.has('score')).toBe(false);
    expect(keys.has('credibility')).toBe(false);
    expect(c.trust?.verification).toBe('unverified');
  });
});

// ---------- E. note 映射 ----------

describe('E. note 映射（决议 #121）', () => {
  it('仅 userNote → 「用户备注：」标签', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ note: { userNote: '重点看结论', aiNote: null } }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].note).toBe('用户备注：重点看结论');
  });

  it('仅 aiNote → 「AI 备注：」标签', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ note: { userNote: null, aiNote: '自动生成的摘要' } }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].note).toBe('AI 备注：自动生成的摘要');
  });

  it('两者同时 → 用户备注在前、AI 备注在后、换行连接', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ note: { userNote: '用户的话', aiNote: 'AI 的话' } }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].note).toBe('用户备注：用户的话\nAI 备注：AI 的话');
  });

  it('空值 → null（含空串与空白串）', () => {
    for (const note of [
      null,
      { userNote: null, aiNote: null },
      { userNote: '', aiNote: '' },
      { userNote: '   ', aiNote: '\t' },
    ] as const) {
      const r = mergeCandidates({
        sources: sourcesFeed('source-search', [
          { candidateId: U.a, item: makeSearchItem({ note }) },
        ]),
        search: [],
      });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.candidates[0].note).toBeNull();
    }
  });

  it('group-list 与 search-only 候选 note 恒 null', () => {
    const r1 = mergeCandidates({
      sources: sourcesFeed('group-list', [{ candidateId: U.a, item: makeListItem() }]),
      search: [],
    });
    const r2 = mergeCandidates({
      sources: null,
      search: [{ candidateId: U.b, result: makeSearchResult() }],
    });
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.candidates[0].note).toBeNull();
    expect(r2.candidates[0].note).toBeNull();
  });

  it('控制/bidi 字符清洗（U+202E/U+061C/U+2066 等剔除）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            note: { userNote: '好\u202e\u061c\u2066文\u2069\u2067本', aiNote: null },
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].note).toBe('用户备注：好文本');
  });

  it('中文与 emoji 原样保留', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ note: { userNote: '中文备注😀📊', aiNote: null } }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].note).toBe('用户备注：中文备注😀📊');
  });

  it('截断不拆 surrogate pair：恰好放下的 emoji 完整保留', () => {
    // '用户备注：' = 5 字符；193 'a' + 😀(2) = 195 正文 → 总长 200 恰好放下
    const userNote = `${'a'.repeat(193)}😀`;
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        { candidateId: U.a, item: makeSearchItem({ note: { userNote, aiNote: null } }) },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const note = r.candidates[0].note;
    expect(note).not.toBeNull();
    expect(note!.length).toBe(200);
    expect(note!.endsWith('😀')).toBe(true);
  });

  it('截断不拆 surrogate pair：跨边界 emoji 整对移除', () => {
    // 194 'a' + 😀(2) = 196 正文 → 段长 201 超上限；截断点落在 😀 高位代理
    const userNote = `${'a'.repeat(194)}😀`;
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        { candidateId: U.a, item: makeSearchItem({ note: { userNote, aiNote: null } }) },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const note = r.candidates[0].note;
    expect(note).not.toBeNull();
    expect(note!.length).toBeLessThanOrEqual(MAX_CANDIDATE_NOTE_CHARS);
    expect(note!.endsWith('a')).toBe(true);
    // 不残留孤立高位代理
    for (const ch of note!) {
      const cp = ch.codePointAt(0)!;
      expect(cp >= 0xd800 && cp <= 0xdfff).toBe(false);
    }
  });

  it('标签+正文总 String.length ≤ MAX_CANDIDATE_NOTE_CHARS', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            note: { userNote: 'u'.repeat(300), aiNote: 'a'.repeat(300) },
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].note!.length).toBeLessThanOrEqual(MAX_CANDIDATE_NOTE_CHARS);
  });

  it('剩余预算充足时 AI 段截断放置（用户段完整、AI 段有正文）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ note: { userNote: '短', aiNote: 'b'.repeat(300) } }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const note = r.candidates[0].note;
    expect(note).not.toBeNull();
    expect(note!.length).toBe(MAX_CANDIDATE_NOTE_CHARS);
    expect(note!.startsWith('用户备注：短\nAI 备注：')).toBe(true);
    expect(note!.endsWith('b')).toBe(true);
  });

  it('第二段预算不足时不得留下无正文的作者标签', () => {
    // 用户段占满全部预算（'用户备注：' + 195 字符 = 200）→ AI 段整体丢弃
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ note: { userNote: 'u'.repeat(196), aiNote: 'AI 的话' } }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const note = r.candidates[0].note;
    expect(note).not.toBeNull();
    expect(note).not.toContain('\n');
    expect(note).not.toContain('AI 备注');
    expect(note!.length).toBe(MAX_CANDIDATE_NOTE_CHARS);
  });

  it('剩余预算不足「AI 备注：」标签 + 1 正文时 AI 段整体丢弃', () => {
    // 用户段 = 5 + 194 = 199，剩余 1 < 6 → AI 段丢弃
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ note: { userNote: 'u'.repeat(194), aiNote: 'x' } }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const note = r.candidates[0].note;
    expect(note).not.toBeNull();
    expect(note).not.toContain('AI 备注');
    expect(note!.length).toBe(199);
  });

  it('note 不进 sortKey（含作者标签）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ note: { userNote: '特别标记', aiNote: '摘要' } }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const key = r.candidates[0].sortKey;
    expect(key).not.toContain('用户备注');
    expect(key).not.toContain('AI 备注');
    expect(key).not.toContain('特别标记');
    expect(key).not.toContain('摘要');
  });
});

// ---------- F. candidateId 输入契约 ----------

describe('F. candidateId 输入契约（决议 #122）', () => {
  it('小写 v4 UUID 正常', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [{ candidateId: U.a, item: makeSearchItem() }]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].id).toBe(U.a);
  });

  it.each([
    ['空串', ''],
    ['非 UUID 字符串', 'abc'],
    ['缺连字符', 'aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa'],
    ['v3 形状（非 v4）', 'aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa'],
    ['大写 UUID', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'],
  ])('%s → fail-closed（candidate-invalid-input）', (_label, id) => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [{ candidateId: id, item: makeSearchItem() }]),
      search: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('candidate-invalid-input');
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('非字符串 candidateId → fail-closed', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        { candidateId: 42 as unknown as string, item: makeSearchItem() },
      ]),
      search: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('candidate-invalid-input');
  });

  it('跨 feed 重复 candidateId → fail-closed（candidate-id-conflict）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ url: 'https://e.example/1', canonicalKey: 'https://e.example/1' }),
        },
      ]),
      search: [{ candidateId: U.a, result: makeSearchResult({ url: 'https://e.example/2' }) }],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('candidate-id-conflict');
  });

  it('同 feed 重复 candidateId → fail-closed（candidate-id-conflict）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ url: 'https://e.example/1', canonicalKey: 'https://e.example/1' }),
        },
        {
          candidateId: U.a,
          item: makeSearchItem({ url: 'https://e.example/2', canonicalKey: 'https://e.example/2' }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('candidate-id-conflict');
  });

  it('合并采用 Sources candidateId，未采用的 Search candidateId 安全丢弃', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [{ candidateId: U.a, item: makeSearchItem() }]),
      search: [{ candidateId: U.b, result: makeSearchResult() }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].id).toBe(U.a);
    expect(r.candidates[0].id).not.toBe(U.b);
  });

  it('candidate_id 恒等于输入 candidateId（绝不使用 canonicalKey）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            url: 'https://example.com/p',
            canonicalKey: 'https://example.com/p',
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].id).toBe(U.a);
    expect(r.candidates[0].id).not.toBe('https://example.com/p');
  });

  it('相同输入及相同预分配 ID → 输出完全确定', () => {
    const input = (): MergeCandidatesInput => ({
      sources: sourcesFeed('source-search', [
        { candidateId: U.a, item: makeSearchItem({ lastUsedAt: '2026-08-16T08:30:00.000Z' }) },
        {
          candidateId: U.c,
          item: makeSearchItem({ url: 'https://e.example/2', canonicalKey: 'https://e.example/2' }),
        },
      ]),
      search: [
        { candidateId: U.b, result: makeSearchResult({ url: 'https://w.example/1' }) },
        { candidateId: U.d, result: makeSearchResult({ url: 'https://e.example/2' }) },
      ],
    });
    const r1 = mergeCandidates(input());
    const r2 = mergeCandidates(input());
    expect(r1).toEqual(r2);
  });

  it('输入 ID 不同仅改变 id/sortKey 收尾，不改变逻辑身份与主要顺序', () => {
    const make = (idA: string): MergeCandidatesInput => ({
      sources: sourcesFeed('source-search', [
        { candidateId: idA, item: makeSearchItem() },
        {
          candidateId: U.c,
          item: makeSearchItem({ url: 'https://e.example/2', canonicalKey: 'https://e.example/2' }),
        },
      ]),
      search: [],
    });
    const r1 = mergeCandidates(make(U.a));
    const r2 = mergeCandidates(make(U.b));
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const strip = (c: SourceCandidate) => ({ ...c, id: '', sortKey: '' });
    expect(r1.candidates.map(strip)).toEqual(r2.candidates.map(strip));
    // sortKey 仅在 candidateId 收尾处不同（其余编码完全一致）
    const stripId = (key: string) => key.slice(0, key.lastIndexOf('|'));
    expect(r1.candidates.map((c) => stripId(c.sortKey))).toEqual(
      r2.candidates.map((c) => stripId(c.sortKey)),
    );
    // sortKey 以 candidateId 收尾
    expect(r1.candidates[0].sortKey.endsWith(U.a)).toBe(true);
    expect(r2.candidates[0].sortKey.endsWith(U.b)).toBe(true);
  });
});

// ---------- G. sortKey ----------

describe('G. sortKey 编码（决议 #123）', () => {
  it('priority 5 排在 1 前（补码编码）', () => {
    const p5 = buildCandidateSortKey({
      tier: 2,
      inputRank: 99999,
      priority: 5,
      lastUsedAt: null,
      scope: 'page',
      canonicalKey: 'https://example.com/a',
      candidateId: U.a,
    });
    const p1 = buildCandidateSortKey({
      tier: 2,
      inputRank: 99999,
      priority: 1,
      lastUsedAt: null,
      scope: 'page',
      canonicalKey: 'https://example.com/b',
      candidateId: U.b,
    });
    expect(p5 < p1).toBe(true);
  });

  it('新时间排在旧时间前（数字反转编码）', () => {
    const newer = buildCandidateSortKey({
      tier: 2,
      inputRank: 99999,
      priority: 3,
      lastUsedAt: '2026-08-16T00:00:00.000Z',
      scope: 'page',
      canonicalKey: 'https://example.com/a',
      candidateId: U.a,
    });
    const older = buildCandidateSortKey({
      tier: 2,
      inputRank: 99999,
      priority: 3,
      lastUsedAt: '2026-08-15T00:00:00.000Z',
      scope: 'page',
      canonicalKey: 'https://example.com/b',
      candidateId: U.b,
    });
    expect(newer < older).toBe(true);
  });

  it('null/非法 lastUsedAt 使用 sentinel 且排最后、字段降级 null', () => {
    const withTime = buildCandidateSortKey({
      tier: 2,
      inputRank: 99999,
      priority: 3,
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      scope: 'page',
      canonicalKey: 'https://example.com/a',
      candidateId: U.a,
    });
    const nullKey = buildCandidateSortKey({
      tier: 2,
      inputRank: 99999,
      priority: 3,
      lastUsedAt: null,
      scope: 'page',
      canonicalKey: 'https://example.com/b',
      candidateId: U.b,
    });
    const invalidKey = buildCandidateSortKey({
      tier: 2,
      inputRank: 99999,
      priority: 3,
      lastUsedAt: '2026-02-30T00:00:00.000Z', // 回滚日期非法
      scope: 'page',
      canonicalKey: 'https://example.com/c',
      candidateId: U.c,
    });
    expect(nullKey < withTime).toBe(false); // null 恒在时间之后
    expect(invalidKey < withTime).toBe(false);
    expect(nullKey).toContain(NULL_TIME_SENTINEL);
    expect(invalidKey).toContain(NULL_TIME_SENTINEL);
    expect(nullKey.length).toBe(invalidKey.length);
    // 字段降级
    const r = mergeCandidates({
      sources: sourcesFeed('group-list', [
        {
          candidateId: U.a,
          item: makeListItem({ lastUsedAt: 'not-a-date' }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].lastUsedAt).toBeNull();
  });

  it('origin 在 page 前；canonicalKey 全序；candidateId 收尾', () => {
    const origin = buildCandidateSortKey({
      tier: 2,
      inputRank: 99999,
      priority: 3,
      lastUsedAt: null,
      scope: 'origin',
      canonicalKey: 'https://example.com',
      candidateId: U.a,
    });
    const page = buildCandidateSortKey({
      tier: 2,
      inputRank: 99999,
      priority: 3,
      lastUsedAt: null,
      scope: 'page',
      canonicalKey: 'https://example.com/p',
      candidateId: U.b,
    });
    expect(origin < page).toBe(true);
    expect(page.endsWith(U.b)).toBe(true);
  });

  it('同输入同输出（sortKey 确定性）', () => {
    const args = {
      tier: 1 as const,
      inputRank: 3,
      priority: 2,
      lastUsedAt: '2026-08-16T08:30:45.123Z',
      scope: 'page' as const,
      canonicalKey: 'https://example.com/p',
      candidateId: U.a,
    };
    expect(buildCandidateSortKey(args)).toBe(buildCandidateSortKey({ ...args }));
  });

  it('binary 顺序：canonicalKey 中 ~ 按 ASCII 排在 z 之后（localeCompare 语义检测）', () => {
    // '~' = U+007E > 'z' = U+007A 按二元比较；部分 locale collation 会忽略标点
    // ——实现必须用原始 < 比较而非 localeCompare。
    const r = mergeCandidates({
      sources: sourcesFeed('group-list', [
        {
          candidateId: U.a,
          item: makeListItem({
            url: 'https://example.com/~x',
            canonicalKey: 'https://example.com/~x',
          }),
        },
        {
          candidateId: U.b,
          item: makeListItem({
            url: 'https://example.com/z',
            canonicalKey: 'https://example.com/z',
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].canonicalKey).toBe('https://example.com/z');
    expect(r.candidates[1].canonicalKey).toBe('https://example.com/~x');
  });
});

// ---------- 真实 node:sqlite 排序一致性 probe ----------

describe('SQLite 排序一致性 probe（决议 #123）', () => {
  const dbRoot = mkdtempSync(join(tmpdir(), 'aibrowse-source-selector-'));
  let handle: DbHandle;
  let repo: ResearchRepository;

  beforeEach(() => {
    handle = openDb(join(dbRoot, `sel-${Math.random().toString(36).slice(2)}.db`));
    runResearchMigrations(handle);
    repo = new ResearchRepository(handle);
  });

  afterEach(() => {
    closeDb(handle);
  });

  afterAll(() => {
    rmSync(dbRoot, { recursive: true, force: true });
  });

  function makeTaskRow(): ResearchTaskRow {
    const stats: ResearchTaskStats = {
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
    return {
      id: TASK_ID,
      goal: 'C3 排序一致性',
      status: 'created',
      phase: null,
      created_at: '2026-08-16T00:00:00.000Z',
      updated_at: '2026-08-16T00:00:00.000Z',
      started_at: null,
      finished_at: null,
      interrupted_at: null,
      error_code: null,
      result_id: null,
      stats_json: JSON.stringify(stats),
    };
  }

  it('插入真实 research.db 后 Repository 顺序与内存 binary 顺序逐元素一致', () => {
    const input: MergeCandidatesInput = {
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            url: 'https://a.example/1',
            canonicalKey: 'https://a.example/1',
            priority: 2,
            lastUsedAt: null,
          }),
        },
        {
          candidateId: U.b,
          item: makeSearchItem({
            url: 'https://a.example/2',
            canonicalKey: 'https://a.example/2',
            priority: 5,
            lastUsedAt: '2026-08-10T00:00:00.000Z',
            note: { userNote: '备注A', aiNote: null },
          }),
        },
        {
          candidateId: U.c,
          item: makeSearchItem({
            url: 'https://b.example/3',
            canonicalKey: 'https://b.example/3',
            scope: 'origin',
            priority: 1,
            lastUsedAt: '2026-08-16T00:00:00.000Z',
          }),
        },
      ]),
      search: [
        { candidateId: U.d, result: makeSearchResult({ url: 'https://w.example/1', title: 'W1' }) },
        { candidateId: U.e, result: makeSearchResult({ url: 'https://w.example/2', title: 'W2' }) },
        { candidateId: U.f, result: makeSearchResult({ url: 'https://a.example/2' }) },
      ],
    };
    const merged = mergeCandidates(input);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const tier2 = mergeCandidates({
      sources: sourcesFeed('group-list', [
        {
          candidateId: U.g,
          item: makeListItem({
            url: 'https://g.example/1',
            canonicalKey: 'https://g.example/1',
            priority: 4,
            lastUsedAt: '2026-08-12T00:00:00.000Z',
          }),
        },
        {
          candidateId: U.h,
          item: makeListItem({
            url: 'https://g.example/2',
            canonicalKey: 'https://g.example/2',
            priority: 4,
            lastUsedAt: null,
          }),
        },
        {
          candidateId: U.i,
          item: makeListItem({
            url: 'https://g.example/3',
            canonicalKey: 'https://g.example/3',
            priority: 1,
            lastUsedAt: '2026-08-15T00:00:00.000Z',
          }),
        },
      ]),
      search: [],
    });
    expect(tier2.ok).toBe(true);
    if (!tier2.ok) return;
    const all = sortCandidatesBinary([...merged.candidates, ...tier2.candidates]);

    repo.insertTask(makeTaskRow());
    const toRow = (c: SourceCandidate): ResearchCandidateRow => ({
      candidate_id: c.id,
      task_id: TASK_ID,
      url: c.url,
      display_url: c.displayUrl,
      title: c.title,
      canonical_key: c.canonicalKey,
      scope: c.scope,
      discovered_via_json: JSON.stringify(c.discoveredVia),
      source_id: c.sourceId,
      trust_value: c.trust?.value ?? null,
      trust_asserted_by: c.trust?.assertedBy ?? null,
      trust_verification: c.trust?.verification ?? null,
      priority: c.priority,
      last_used_at: c.lastUsedAt,
      note: c.note,
      sort_key: c.sortKey,
    });
    for (const c of all) repo.insertCandidate(toRow(c));

    const fromDb = repo.listCandidatesByTask(TASK_ID);
    expect(fromDb.length).toBe(all.length);
    expect(fromDb.map((c) => c.id)).toEqual(all.map((c) => c.id));
    expect(fromDb.map((c) => c.sortKey)).toEqual(all.map((c) => c.sortKey));
  });
});

// ---------- H. hostile input ----------

describe('H. hostile input（安全丢弃、零 throw、零日志正文）', () => {
  it('危险 scheme（javascript:/data:/file:/about:）→ 丢弃该条', () => {
    const r = mergeCandidates({
      sources: null,
      search: [
        { candidateId: U.a, result: makeSearchResult({ url: 'javascript:alert(1)' }) },
        { candidateId: U.b, result: makeSearchResult({ url: 'data:text/html,<script>' }) },
        { candidateId: U.c, result: makeSearchResult({ url: 'file:///C:/Windows/system.ini' }) },
        { candidateId: U.d, result: makeSearchResult({ url: 'about:blank' }) },
        { candidateId: U.e, result: makeSearchResult({ url: 'https://ok.example/p' }) },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].canonicalKey).toBe('https://ok.example/p');
    expect(r.droppedCount).toBe(4);
  });

  it('userinfo/控制字符/超长 URL → 丢弃该条', () => {
    const long = `https://example.com/${'a'.repeat(2100)}`;
    const r = mergeCandidates({
      sources: null,
      search: [
        { candidateId: U.a, result: makeSearchResult({ url: 'https://user:pass@example.com/p' }) },
        { candidateId: U.b, result: makeSearchResult({ url: 'https://example.com/ok\u0007bad' }) },
        { candidateId: U.c, result: makeSearchResult({ url: long }) },
        { candidateId: U.d, result: makeSearchResult({ url: 'https://ok.example/p2' }) },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].canonicalKey).toBe('https://ok.example/p2');
    expect(r.droppedCount).toBe(3);
  });

  it('canonicalKey 与重算不一致 → Sources 条目丢弃（同 URL Search 合法时保留 search-only）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            url: 'https://good.example/p',
            canonicalKey: 'https://evil.example/p', // 不一致
            trust: TRUST_USER_ASSERTED,
          }),
        },
      ]),
      search: [{ candidateId: U.b, result: makeSearchResult({ url: 'https://good.example/p' }) }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].id).toBe(U.b);
    expect(r.candidates[0].trust).toBeNull(); // 不继承已丢弃 Source 的 trust
    expect(r.candidates[0].canonicalKey).toBe('https://good.example/p');
    expect(r.droppedCount).toBe(1);
  });

  it('disabled 或 blocked Sources 条目 → 纵深防御丢弃', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            enabled: false,
            url: 'https://d.example/1',
            canonicalKey: 'https://d.example/1',
          }),
        },
        {
          candidateId: U.b,
          item: makeSearchItem({
            shareMode: 'blocked',
            url: 'https://d.example/2',
            canonicalKey: 'https://d.example/2',
          }),
        },
        {
          candidateId: U.c,
          item: makeSearchItem({ url: 'https://d.example/3', canonicalKey: 'https://d.example/3' }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].id).toBe(U.c);
    expect(r.droppedCount).toBe(2);
  });

  it('非法 scope → Sources 条目丢弃', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            scope: 'evil' as unknown as 'page',
            url: 'https://e.example/1',
            canonicalKey: 'https://e.example/1',
          }),
        },
        {
          candidateId: U.b,
          item: makeSearchItem({ url: 'https://e.example/2', canonicalKey: 'https://e.example/2' }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].id).toBe(U.b);
  });

  it('非法 sourceId → Sources 条目丢弃', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            id: 'not-a-uuid',
            url: 'https://e.example/1',
            canonicalKey: 'https://e.example/1',
          }),
        },
        {
          candidateId: U.b,
          item: makeSearchItem({ url: 'https://e.example/2', canonicalKey: 'https://e.example/2' }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].id).toBe(U.b);
  });

  it('非法 priority → null；非法 lastUsedAt → null（不抛异常）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('group-list', [
        {
          candidateId: U.a,
          item: makeListItem({
            priority: 99,
            lastUsedAt: 'garbage',
            url: 'https://e.example/1',
            canonicalKey: 'https://e.example/1',
          }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0].priority).toBeNull();
    expect(r.candidates[0].lastUsedAt).toBeNull();
  });

  it('超长/控制字符标题 → 清洗并截断至 MAX_CANDIDATE_TITLE_CHARS', () => {
    const evilTitle = `坏\u202e标题\u0007${'长'.repeat(400)}`;
    const r = mergeCandidates({
      sources: null,
      search: [{ candidateId: U.a, result: makeSearchResult({ title: evilTitle }) }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const t = r.candidates[0].title;
    expect(t.length).toBeLessThanOrEqual(MAX_CANDIDATE_TITLE_CHARS);
    expect(t).not.toContain('\u202e');
    expect(t).not.toContain('\u0007');
    for (const ch of t) {
      const cp = ch.codePointAt(0)!;
      expect(cp <= 0x1f || cp === 0x7f).toBe(false);
    }
  });

  it('Sources title 清洗后为空 → 用 Search title；Search title 也为空 → 用 host', () => {
    const r1 = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            name: '\u202e\u0007',
            url: 'https://h.example/p',
            canonicalKey: 'https://h.example/p',
          }),
        },
      ]),
      search: [
        {
          candidateId: U.b,
          result: makeSearchResult({ url: 'https://h.example/p', title: '搜索标题兜底' }),
        },
      ],
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.candidates).toHaveLength(1);
    expect(r1.candidates[0].title).toBe('搜索标题兜底');

    const r2 = mergeCandidates({
      sources: null,
      search: [{ candidateId: U.a, result: makeSearchResult({ title: '  \u202e  ' }) }],
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.candidates[0].title).toBe('example.com');
  });

  it('顶层结构非法 → 整次 fail-closed（candidate-invalid-input）', () => {
    // sources.kind 非法
    const r1 = mergeCandidates({
      sources: { kind: 'bogus', entries: [] } as unknown as SourcesCandidateFeed,
      search: [],
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.errorCode).toBe('candidate-invalid-input');
    // sources.entries 非数组
    const r2 = mergeCandidates({
      sources: { kind: 'source-search', entries: 'nope' } as unknown as SourcesCandidateFeed,
      search: [],
    });
    expect(r2.ok).toBe(false);
    // search 非数组
    const r3 = mergeCandidates({
      sources: null,
      search: 'nope' as unknown as WebSearchCandidateEntry[],
    });
    expect(r3.ok).toBe(false);
    // 条目缺 item
    const r4 = mergeCandidates({
      sources: sourcesFeed('source-search', [
        { candidateId: U.a } as unknown as { candidateId: string; item: SourceSearchItem },
      ]),
      search: [],
    });
    expect(r4.ok).toBe(false);
  });

  it('单条畸形安全丢弃、零 throw、结果不含畸形正文', () => {
    const hostile = 'https://user:secret@evil.example/p';
    let threw = false;
    let result: ReturnType<typeof mergeCandidates> | null = null;
    try {
      result = mergeCandidates({
        sources: sourcesFeed('source-search', [
          { candidateId: U.a, item: makeSearchItem({ url: hostile, canonicalKey: hostile }) },
          {
            candidateId: U.b,
            item: makeSearchItem({
              url: 'https://ok.example/p',
              canonicalKey: 'https://ok.example/p',
            }),
          },
        ]),
        search: [],
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(true);
    if (!result || !result.ok) return;
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.droppedCount).toBe(1);
  });

  it('合法 Search 兜底不会继承已丢弃 Source 的 trust', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({
            enabled: false, // 被丢弃
            trust: { value: 'official', assertedBy: 'user', verification: 'asserted' },
          }),
        },
      ]),
      search: [{ candidateId: U.b, result: makeSearchResult() }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0].trust).toBeNull();
    expect(r.candidates[0].priority).toBeNull();
    expect(r.candidates[0].discoveredVia).toEqual(['search']);
  });
});

// ---------- I. 预算 ----------

describe('I. 预算与有界裁剪（D12）', () => {
  it('25 条输入 → 24 候选 + 1 droppedCount（确定性）', () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      candidateId:
        Object.values(U)[i] ?? `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      item: makeSearchItem({
        url: `https://n.example/${i}`,
        canonicalKey: `https://n.example/${i}`,
      }),
    }));
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', entries),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(MAX_SOURCE_CANDIDATES);
    expect(r.droppedCount).toBe(1);
    // 溢出裁剪确定性：被裁的是排序后末位（输入 rank 24）
    expect(r.candidates.map((c) => c.id)).not.toContain(Object.values(U)[24]);
  });

  it('30 条输入 → 24 候选 + 6 droppedCount', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({
      candidateId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      item: makeSearchItem({
        url: `https://n.example/${i}`,
        canonicalKey: `https://n.example/${i}`,
      }),
    }));
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', entries),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates).toHaveLength(MAX_SOURCE_CANDIDATES);
    expect(r.droppedCount).toBe(6);
  });

  it('selectCandidates ≤ MAX_SELECTED_SOURCES（8）', () => {
    const entries = Array.from({ length: 24 }, (_, i) => ({
      candidateId: `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`,
      item: makeSearchItem({
        url: `https://n.example/${i}`,
        canonicalKey: `https://n.example/${i}`,
      }),
    }));
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', entries),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const selected = selectCandidates(r.candidates);
    expect(selected).toHaveLength(MAX_SELECTED_SOURCES);
    // 取排序前 8（rank 0-7）
    expect(selected[0].sortKey).toContain('|00000|');
    expect(selected[7].sortKey).toContain('|00007|');
  });

  it('selectCandidates 对副本排序（输入乱序也正确）', () => {
    const r = mergeCandidates({
      sources: sourcesFeed('source-search', [
        {
          candidateId: U.a,
          item: makeSearchItem({ url: 'https://n.example/0', canonicalKey: 'https://n.example/0' }),
        },
        {
          candidateId: U.b,
          item: makeSearchItem({ url: 'https://n.example/1', canonicalKey: 'https://n.example/1' }),
        },
        {
          candidateId: U.c,
          item: makeSearchItem({ url: 'https://n.example/2', canonicalKey: 'https://n.example/2' }),
        },
      ]),
      search: [],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const reversed = [...r.candidates].reverse();
    const selected = selectCandidates(reversed);
    expect(selected.map((c) => c.id)).toEqual([U.a, U.b, U.c]);
    // 不修改输入数组
    expect(reversed.map((c) => c.id)).toEqual([U.c, U.b, U.a]);
  });

  it('空输入成功返回空数组', () => {
    const r = mergeCandidates({ sources: null, search: [] });
    expect(r).toEqual({ ok: true, candidates: [], droppedCount: 0 });
    expect(selectCandidates([])).toEqual([]);
  });

  it('输入数组及深层对象零修改（深冻结下零 throw）', () => {
    const input = deepFreeze({
      sources: {
        kind: 'source-search',
        entries: [
          {
            candidateId: U.a,
            item: makeSearchItem({ note: { userNote: '冻结备注', aiNote: null } }),
          },
        ],
      },
      search: [{ candidateId: U.b, result: makeSearchResult({ url: 'https://w.example/1' }) }],
    });
    let threw = false;
    let result: ReturnType<typeof mergeCandidates> | null = null;
    try {
      result = mergeCandidates(input as unknown as MergeCandidatesInput);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.ok).toBe(true);
    if (!result || !result.ok) return;
    expect(result.candidates).toHaveLength(2);
  });
});
