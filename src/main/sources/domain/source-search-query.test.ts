// source-search-query 纯函数测试（B3，红→绿）：查询归一化与分流判定（决议 #60）、
// FTS 查询串构造（短语包裹 + 双引号转义，只作数据）、LIKE 模式构造、确定性档位
// 计算（决议 #61 档位不可跨档 + audience 规则）、排序器全序、note 摘录（≤200 码点 +
// 控制/bidi 剔除）。全部零环境依赖纯函数。
import { describe, expect, it } from 'vitest';
import {
  buildFtsQuery,
  buildNoteExcerpt,
  classifySearchQuery,
  compareSearchItems,
  computeMatchTier,
  countUnicodeChars,
  likePrefix,
  likeSubstring,
  normalizeSearchQuery,
  SEARCH_NOTE_EXCERPT_MAX,
  type SearchSortableItem,
  type SearchTierInput,
} from './source-search-query';

const tierInput = (over: Partial<SearchTierInput> = {}): SearchTierInput => ({
  name: '无关站点',
  url: 'https://neutral.example.com/x',
  canonicalKey: 'https://neutral.example.com/x',
  tags: [],
  groupName: null,
  userNote: '用户备注内容',
  aiNote: 'AI备注内容',
  shareMode: 'full',
  ...over,
});

describe('normalizeSearchQuery — 归一化（trim/NFC/控制字符剔除）', () => {
  it('trim 与 NFC；纯空白/全控制字符 → null；500 字符边界内不截断', () => {
    expect(normalizeSearchQuery('  benchmark  ')).toBe('benchmark');
    // NFC：组合形态 e + ́ 归一为 é（两者相等）
    const nfc = normalizeSearchQuery('é');
    expect(nfc).toBe('é');
    expect(normalizeSearchQuery('   ')).toBeNull();
    expect(normalizeSearchQuery('​‮')).toBeNull();
    expect(normalizeSearchQuery('a'.repeat(500))).toBe('a'.repeat(500));
  });
  it('查询串中的控制/bidi 字符剔除（只作数据）', () => {
    expect(normalizeSearchQuery('a⁦b⁩\n')).toBe('ab');
    expect(normalizeSearchQuery('x؜y')).toBe('xy');
  });
});

describe('countUnicodeChars — Unicode 码点计数（代理对算 1）', () => {
  it('ASCII/中文/日文/emoji 与代理对', () => {
    expect(countUnicodeChars('abc')).toBe(3);
    expect(countUnicodeChars('基准测试')).toBe(4);
    expect(countUnicodeChars('日本語')).toBe(3);
    expect(countUnicodeChars('😀')).toBe(1);
    expect(countUnicodeChars('a😀b')).toBe(3);
  });
});

describe('classifySearchQuery — 分流判定（决议 #60）', () => {
  it('1 字符 → short1；2 字符 → short2；≥3 字符 → fts（含 3 边界）', () => {
    expect(classifySearchQuery('a')).toBe('short1');
    expect(classifySearchQuery('站')).toBe('short1');
    expect(classifySearchQuery('ai')).toBe('short2');
    expect(classifySearchQuery('测试')).toBe('short2');
    expect(classifySearchQuery('日本')).toBe('short2');
    expect(classifySearchQuery('abc')).toBe('fts');
    expect(classifySearchQuery('基准测')).toBe('fts');
    expect(classifySearchQuery('AI benchmark')).toBe('fts');
  });
  it('URL 判定集合：normalizeSourceUrl 可解析 → url；http(s):// 前缀（即使解析失败）→ url', () => {
    expect(classifySearchQuery('https://example.com/a')).toBe('url');
    expect(classifySearchQuery('http://example.com')).toBe('url');
    expect(classifySearchQuery('https://user:pass@example.com')).toBe('url');
    expect(classifySearchQuery('not-a-url text')).toBe('fts');
    expect(classifySearchQuery('example.com/path')).toBe('fts');
  });
});

describe('buildFtsQuery — 短语包裹与转义（原始语法只作数据）', () => {
  it('逐 token 短语包裹；≥3 字符 token 才参与（短 token 过滤，trigram 语义）', () => {
    expect(buildFtsQuery('benchmark')).toEqual({ ok: true, query: '"benchmark"' });
    expect(buildFtsQuery('基准测 测试串')).toEqual({ ok: true, query: '"基准测" "测试串"' });
    expect(buildFtsQuery('AI benchmark')).toEqual({ ok: true, query: '"benchmark"' });
    expect(buildFtsQuery('AI 测试')).toEqual({ ok: false, reason: 'no-fts-token' });
  });
  it('内部双引号转义、通配符/操作符/数字/SQL 片段只作数据', () => {
    const q = buildFtsQuery('a"b');
    expect(q).toEqual({ ok: true, query: '"a""b"' });
    expect(buildFtsQuery('AND OR NOT NEAR * ^ 123')).toEqual({
      ok: true,
      query: '"AND" "NOT" "NEAR" "123"', // 'OR'（2 字符）与 * ^ 被短 token 过滤——不可能作为 FTS 操作符
    });
    expect(buildFtsQuery("'; DROP TABLE sources; --")).toEqual({
      ok: true,
      query: '"DROP" "TABLE" "sources;"', // SQL 片段只作数据（短 token '--'/"';" 被过滤）
    });
    expect(buildFtsQuery('foo-b"ar')).toEqual({ ok: true, query: '"foo-b""ar"' });
    // 输出恒被双引号包裹：原始语法不可能作为 FTS 操作符逃逸
    expect(q.ok && !/^\s*[^"]/.test(q.query)).toBe(true);
  });
  it('全空白/零 token → ok:false', () => {
    expect(buildFtsQuery('   ')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('LIKE 模式构造 — \\ % _ 转义', () => {
  it('前缀与子串形态；注入片段只作数据', () => {
    expect(likePrefix('100%')).toBe('100\\%%');
    expect(likePrefix('a_b')).toBe('a\\_b%');
    expect(likePrefix('a\\b')).toBe('a\\\\b%');
    expect(likeSubstring('%x_')).toBe('%\\%x\\_%');
  });
});

describe('computeMatchTier — 确定性档位（决议 #61：档位语义）', () => {
  it('fts 档位：精确 0 > 前缀 1 > tag/group 2 > name/domain 3 > note 4（取最高档）', () => {
    expect(computeMatchTier(tierInput({ name: 'benchmark' }), 'benchmark', 'fts', 'user')).toBe(0);
    // 注：canonicalKey/url 的精确档在实际分流中只经 url-kind 查询可达（完整 URL
    // 查询会归类为 'url'）；fts 档位下由 name/tag/group 精确覆盖（防御性保留判定）
    expect(computeMatchTier(tierInput({ tags: ['benchmark'] }), 'benchmark', 'fts', 'user')).toBe(
      0,
    );
    expect(
      computeMatchTier(tierInput({ groupName: 'benchmark' }), 'benchmark', 'fts', 'user'),
    ).toBe(0);
    expect(computeMatchTier(tierInput({ name: 'benchmarkx' }), 'benchmark', 'fts', 'user')).toBe(1);
    expect(
      computeMatchTier(tierInput({ tags: ['open-benchmark'] }), 'benchmark', 'fts', 'user'),
    ).toBe(2);
    expect(
      computeMatchTier(tierInput({ groupName: 'benchmark组' }), 'benchmark', 'fts', 'user'),
    ).toBe(2);
    expect(
      computeMatchTier(tierInput({ name: 'open-benchmark' }), 'benchmark', 'fts', 'user'),
    ).toBe(3);
    expect(
      computeMatchTier(
        tierInput({
          name: '无关',
          url: 'https://benchmark.example.com/x',
          canonicalKey: 'https://benchmark.example.com/x',
        }),
        'benchmark',
        'fts',
        'user',
      ),
    ).toBe(3); // 域名子串命中
    expect(
      computeMatchTier(tierInput({ userNote: '看 benchmark 数据' }), 'benchmark', 'fts', 'user'),
    ).toBe(4);
    // 多个域同时命中 → 取最高档（tag 精确 0 胜过 name 前缀 1）
    expect(
      computeMatchTier(
        tierInput({ name: 'benchmarkx', tags: ['benchmark'] }),
        'benchmark',
        'fts',
        'user',
      ),
    ).toBe(0);
  });
  it('agent 视角 note 档位受分享模式约束：metadata 的 note 不参与命中（丢弃），full 参与', () => {
    const metadata = tierInput({ shareMode: 'metadata', userNote: '包含大模型评测的字' });
    expect(computeMatchTier(metadata, '大模型评测', 'fts', 'agent')).toBeNull();
    expect(computeMatchTier(metadata, '大模型评测', 'fts', 'user')).toBe(4);
    const full = tierInput({ shareMode: 'full', userNote: '包含大模型评测的字' });
    expect(computeMatchTier(full, '大模型评测', 'fts', 'agent')).toBe(4);
  });
  it('short1：仅精确（name/url/canonicalKey）；tag/group 不参与；无其他档位', () => {
    expect(computeMatchTier(tierInput({ name: '站' }), '站', 'short1', 'user')).toBe(0);
    expect(computeMatchTier(tierInput({ name: 'A站' }), '站', 'short1', 'user')).toBeNull();
    expect(computeMatchTier(tierInput({ tags: ['站'] }), '站', 'short1', 'user')).toBeNull();
  });
  it('short2：精确 0 / 前缀 1 / tag-group 2 / name-host-url 3；无 note 档', () => {
    expect(computeMatchTier(tierInput({ name: '测试' }), '测试', 'short2', 'user')).toBe(0);
    expect(computeMatchTier(tierInput({ name: '测试站' }), '测试', 'short2', 'user')).toBe(1);
    expect(computeMatchTier(tierInput({ tags: ['测试集'] }), '测试', 'short2', 'user')).toBe(2);
    expect(computeMatchTier(tierInput({ name: '基准测试站' }), '测试', 'short2', 'user')).toBe(3);
    // note 不参与 short2 → 仅 note 命中的行应为 null（丢弃）
    expect(
      computeMatchTier(tierInput({ userNote: '包含测试' }), '测试', 'short2', 'user'),
    ).toBeNull();
  });
  it('url 档位：canonicalKey/url 精确 0 / 前缀 1', () => {
    expect(
      computeMatchTier(tierInput({ canonicalKey: 'https://x/y' }), 'https://x/y', 'url', 'agent'),
    ).toBe(0);
    expect(
      computeMatchTier(tierInput({ canonicalKey: 'https://x/y/z' }), 'https://x/y', 'url', 'agent'),
    ).toBe(1);
    expect(
      computeMatchTier(tierInput({ canonicalKey: 'https://a/b' }), 'https://x/y', 'url', 'agent'),
    ).toBeNull();
  });
  it('大小写语义：精确区分大小写（SQLite =）；前缀/子串 ASCII 不区分大小写（SQLite LIKE）', () => {
    expect(computeMatchTier(tierInput({ name: 'Benchmark' }), 'benchmark', 'fts', 'user')).toBe(1); // 前缀（ciStartsWith）
    expect(computeMatchTier(tierInput({ name: 'Benchmark' }), 'Benchmark', 'fts', 'user')).toBe(0);
    // 精确/前缀/子串都不匹配（含大小写不敏感的包含）→ null 丢弃
    expect(computeMatchTier(tierInput({ name: 'Benchmark' }), 'MARKX', 'fts', 'user')).toBeNull();
    expect(computeMatchTier(tierInput({ tags: ['Benchmark'] }), 'benchmark', 'fts', 'user')).toBe(
      2,
    );
    expect(computeMatchTier(tierInput({ name: 'xbenchmarky' }), 'BENCHMARK', 'fts', 'user')).toBe(
      3,
    );
  });
  it('like-long（FTS 不可用降级）与 fts 档位一致但 note 不可达（候选集中无 note 命中）', () => {
    expect(
      computeMatchTier(tierInput({ name: 'Benchmark 站点' }), 'Benchmark', 'like-long', 'user'),
    ).toBe(1);
    expect(
      computeMatchTier(tierInput({ tags: ['open-benchmark'] }), 'benchmark', 'like-long', 'user'),
    ).toBe(2);
  });
});

describe('compareSearchItems — 排序全序（决议 #61）', () => {
  const item = (over: Partial<SearchSortableItem> = {}): SearchSortableItem => ({
    tier: 3,
    priority: 3,
    lastUsedAt: null,
    scope: 'page',
    canonicalKey: 'https://example.com/a',
    id: '00000000-0000-4000-8000-000000000001',
    ...over,
  });
  it('档位优先且不可被 priority 反转；priority 仅同档内降序', () => {
    expect(
      compareSearchItems(item({ tier: 0, priority: 1 }), item({ tier: 3, priority: 5 })),
    ).toBeLessThan(0);
    expect(
      compareSearchItems(item({ tier: 3, priority: 5 }), item({ tier: 3, priority: 1 })),
    ).toBeLessThan(0);
    expect(
      compareSearchItems(item({ tier: 3, priority: 1 }), item({ tier: 3, priority: 5 })),
    ).toBeGreaterThan(0);
  });
  it('priority 上下界（1/5）与同档内 recency：lastUsedAt 降序、null 恒排最末', () => {
    expect(
      compareSearchItems(
        item({ priority: 1, lastUsedAt: '2026-08-15T00:00:00.000Z' }),
        item({ priority: 5, lastUsedAt: null }),
      ),
    ).toBeGreaterThan(0);
    expect(
      compareSearchItems(
        item({ lastUsedAt: '2026-08-15T00:00:00.000Z' }),
        item({ lastUsedAt: '2026-08-14T00:00:00.000Z' }),
      ),
    ).toBeLessThan(0);
    expect(
      compareSearchItems(
        item({ lastUsedAt: null }),
        item({ lastUsedAt: '2026-08-14T00:00:00.000Z' }),
      ),
    ).toBeGreaterThan(0);
  });
  it('origin/page 同 canonicalKey：scope ASC + canonicalKey ASC + id ASC 收尾（全序）', () => {
    const o = item({ scope: 'origin', canonicalKey: 'https://example.com', id: 'b' });
    const p = item({ scope: 'page', canonicalKey: 'https://example.com', id: 'a' });
    expect(compareSearchItems(o, p)).toBeLessThan(0); // origin < page
    const p2 = item({ scope: 'page', canonicalKey: 'https://example.com', id: 'c' });
    expect(compareSearchItems(p, p2)).toBeLessThan(0); // 同键 → id
    expect(
      compareSearchItems(
        item({ canonicalKey: 'https://a.com' }),
        item({ canonicalKey: 'https://b.com' }),
      ),
    ).toBeLessThan(0);
  });
  it('全等条目比较为 0；同输入同输出（确定性）', () => {
    const a = item();
    expect(compareSearchItems(a, item())).toBe(0);
    expect(compareSearchItems(a, item({ tier: 1 }))).toBeGreaterThan(0);
  });
});

describe('buildNoteExcerpt — 有界 note 摘录（≤200 码点 + 控制/bidi 剔除 + 字段分离 provenance）', () => {
  it('200/201 码点边界（代理对算 1 码点）；截断确定性', () => {
    const s200 = '中'.repeat(200);
    const ex = buildNoteExcerpt(s200, '');
    expect(ex?.userNote).toBe(s200);
    expect(ex?.aiNote).toBeNull();
    const s201 = '中'.repeat(201);
    const cut = buildNoteExcerpt(s201, '');
    expect(cut?.userNote).toBe('中'.repeat(SEARCH_NOTE_EXCERPT_MAX));
    expect(cut?.userNote?.length).toBe(200);
    const emoji = '😀'.repeat(201);
    const em = buildNoteExcerpt(emoji, '');
    expect(em?.userNote).toBe('😀'.repeat(200));
    expect([...em!.userNote!]).toHaveLength(200);
  });
  it('C0/换行/零宽/U+061C/U+202A–U+202E/U+2066–U+2069 剔除；双空 → null', () => {
    const ex = buildNoteExcerpt('a\nb⁦c⁩‮d؜e​f', '');
    expect(ex?.userNote).toBe('abcdef');
    expect(buildNoteExcerpt('', '')).toBeNull();
    expect(buildNoteExcerpt('', 'ai 备注')).toEqual({ userNote: null, aiNote: 'ai 备注' });
  });
  it('provenance 由字段分离承载：userNote/aiNote 互不混淆', () => {
    const ex = buildNoteExcerpt('用户备注', 'AI备注');
    expect(ex).toEqual({ userNote: '用户备注', aiNote: 'AI备注' });
  });
});
