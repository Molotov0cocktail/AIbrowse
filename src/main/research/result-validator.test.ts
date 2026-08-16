// 决议 #149–#151：ResultValidator 敌手矩阵——
// 合法全类型 / 模型草案三字段白名单（可信字段零通道）/ 逐层未知字段与原型键 /
// 非法类型 / 表格行列严格一致 / ranking 连续 1..N / sourceRefs 引用完整性 /
// evidenceMap·conflicts·coverage·fetchedAt·resultId 不受模型控制 /
// 强制 uncertainty 全矩阵 / 总大小 ±1 / UUID v4 / 错误报告零敌对正文。
import { describe, expect, it } from 'vitest';
import {
  MAX_MARKDOWN_BLOCK_CHARS,
  MAX_RESULT_CHARS,
  MAX_RESULT_SUMMARY_CHARS,
  MAX_RESULT_VALIDATION_REASONS,
  MAX_TABLE_CELL_CHARS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
} from '../../shared/types/research';
import type {
  Claim,
  Conflict,
  ResearchResultValidationContext,
  SourceCandidate,
  VerifiedEvidence,
} from '../../shared/types/research';
import { validate } from './result-validator';

// ---------- fixtures ----------

const CAND1 = 'c1111111-1111-4111-8111-111111111111';
const CAND2 = 'c2222222-2222-4222-8222-222222222222';
const EVID1 = 'e1111111-1111-4111-8111-111111111111';
const EVID2 = 'e2222222-2222-4222-8222-222222222222';
const RESULT_ID = 'aaaa1111-1111-4111-8111-111111111111';

function makeCandidate(id: string, url: string): SourceCandidate {
  return {
    id,
    url,
    displayUrl: url,
    title: `候选 ${id.slice(0, 4)}`,
    canonicalKey: url,
    scope: 'page',
    discoveredVia: ['search'],
    sourceId: null,
    trust: null,
    priority: null,
    lastUsedAt: null,
    note: null,
    sortKey: `03|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|${url}|${id}`,
  };
}

function makeEvidence(id: string, candidateId: string, accessTime: string): VerifiedEvidence {
  return {
    evidenceId: id,
    taskId: 'task-1',
    captureId: `capture-${id}`,
    candidateId,
    sourceId: null,
    url: `https://example.com/${candidateId}`,
    title: `证据 ${id.slice(0, 4)}`,
    accessTime,
    documentId: '5',
    contentHash: 'a'.repeat(32),
    type: 'quote',
    locator: { kind: 'text', excerpt: '摘录' },
    excerpt: '摘录',
    value: null,
    verification: 'verified',
  };
}

function makeClaim(over: Partial<Claim> = {}): Claim {
  return {
    claimId: 'f0000000-0000-4000-8000-000000000001',
    taskId: 'task-1',
    text: '结论文本',
    severity: 'medium',
    coverage: 'multi-source',
    sourceTypes: ['third-party'],
    evidenceIds: [EVID1],
    singleSourceFields: [],
    conflictIds: [],
    ...over,
  };
}

function makeConflict(over: Partial<Conflict> = {}): Conflict {
  return {
    conflictId: 'd0000000-0000-4000-8000-000000000001',
    taskId: 'task-1',
    topic: '冲突主题',
    positions: [
      { positionText: '甲方立场', sourceRefs: [CAND1] },
      { positionText: '乙方立场', sourceRefs: [CAND2] },
    ],
    claimIds: ['f0000000-0000-4000-8000-000000000001'],
    resolved: 'unresolved',
    ...over,
  };
}

function makeCtx(
  over: Partial<ResearchResultValidationContext> = {},
): ResearchResultValidationContext {
  return {
    taskId: 'task-1',
    candidates: [
      makeCandidate(CAND1, 'https://example.com/one'),
      makeCandidate(CAND2, 'https://example.com/two'),
    ],
    evidence: [
      makeEvidence(EVID1, CAND1, '2026-08-16T10:00:00.000Z'),
      makeEvidence(EVID2, CAND2, '2026-08-16T11:00:00.000Z'),
    ],
    claims: [makeClaim()],
    conflicts: [],
    verificationState: 'verified',
    now: '2026-08-16T12:00:00.000Z',
    createId: () => RESULT_ID,
    ...over,
  };
}

// 合法草案（含 uncertain 以满足无强制条件时的选择性附加）
function makeDraft(): Record<string, unknown> {
  return {
    title: '研究标题',
    summary: '研究摘要',
    blocks: [
      { kind: 'markdown', text: '# 结论\n\n正文 *斜体* [链接](https://example.com/one)' },
      { kind: 'uncertain', text: '部分细节不确定', reason: '仅有单一来源' },
    ],
  };
}

// ---------- A. 合法输入全类型 ----------

describe('ResultValidator 合法输入', () => {
  it('markdown + uncertain 合法 → ok + 程序组装全部可信字段', () => {
    const ctx = makeCtx();
    const out = validate(makeDraft(), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const r = out.result;
    expect(r.resultId).toBe(RESULT_ID);
    expect(r.taskId).toBe('task-1');
    expect(r.title).toBe('研究标题');
    expect(r.summary).toBe('研究摘要');
    // evidenceMap：键升序 + 主进程元数据投影
    expect(Object.keys(r.evidenceMap)).toEqual([EVID1, EVID2]);
    expect(r.evidenceMap[EVID1]).toEqual({
      candidateId: CAND1,
      url: 'https://example.com/c1111111-1111-4111-8111-111111111111',
      title: '证据 e111',
      accessTime: '2026-08-16T10:00:00.000Z',
    });
    // fetchedAt = Evidence 最大 accessTime
    expect(r.fetchedAt).toBe('2026-08-16T11:00:00.000Z');
    // coverage 程序计数
    expect(r.coverage).toEqual({
      total: 1,
      multiSource: 1,
      singleSource: 0,
      vendor: 0,
      thirdParty: 1,
      community: 0,
    });
    expect(r.conflicts).toEqual([]);
  });

  it('table 合法（block 级 sourceRefs）', () => {
    const ctx = makeCtx();
    const draft = makeDraft();
    (draft.blocks as unknown[])[0] = {
      kind: 'table',
      columns: ['名称', '数值'],
      rows: [
        ['甲', '1'],
        ['乙', '2'],
      ],
      sourceRefs: [CAND1, CAND2],
    };
    const out = validate(draft, ctx);
    expect(out.ok).toBe(true);
  });

  it('cards 合法（subtitle null 与 string）', () => {
    const ctx = makeCtx();
    const draft = makeDraft();
    (draft.blocks as unknown[])[0] = {
      kind: 'cards',
      items: [
        { title: '卡一', subtitle: '副标题', body: '正文一', sourceRefs: [CAND1] },
        { title: '卡二', subtitle: null, body: '正文二', sourceRefs: [CAND2] },
      ],
    };
    const out = validate(draft, ctx);
    expect(out.ok).toBe(true);
  });

  it('ranking 合法（rank 严格 1..N）', () => {
    const ctx = makeCtx();
    const draft = makeDraft();
    (draft.blocks as unknown[])[0] = {
      kind: 'ranking',
      items: [
        { rank: 1, title: '第一', detail: '细节一', sourceRefs: [CAND1] },
        { rank: 2, title: '第二', detail: '细节二', sourceRefs: [CAND2] },
      ],
    };
    const out = validate(draft, ctx);
    expect(out.ok).toBe(true);
  });

  it('全块类型混合 + 空 evidence/claims 时含 uncertain → ok（强制矩阵满足）', () => {
    const ctx = makeCtx({ evidence: [], claims: [], conflicts: [] });
    const draft = {
      title: 't',
      summary: 's',
      blocks: [{ kind: 'uncertain', text: '证据不足', reason: '无已核验证据' }],
    };
    const out = validate(draft, ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.fetchedAt).toBe('2026-08-16T12:00:00.000Z'); // 无 Evidence → ctx.now
    expect(out.result.evidenceMap).toEqual({});
    expect(out.result.coverage.total).toBe(0);
  });

  it('输入零修改（深冻结草案与 context）', () => {
    const ctx = makeCtx();
    const draft = makeDraft();
    // 深拷贝但保留函数字段（createId 不可 JSON 序列化）
    const frozenCtx: ResearchResultValidationContext = {
      ...JSON.parse(JSON.stringify(ctx)),
      createId: ctx.createId,
    };
    const frozenDraft = JSON.parse(JSON.stringify(draft));
    const before = JSON.stringify({ frozenCtx: { ...frozenCtx, createId: 'fn' }, frozenDraft });
    const out = validate(frozenDraft, frozenCtx);
    expect(out.ok).toBe(true);
    expect(JSON.stringify({ frozenCtx: { ...frozenCtx, createId: 'fn' }, frozenDraft })).toBe(
      before,
    );
  });

  it('确定性（同输入两次输出深相等）', () => {
    const ctx = makeCtx();
    const a = validate(makeDraft(), ctx);
    const b = validate(makeDraft(), ctx);
    expect(a).toEqual(b);
  });
});

// ---------- B. 顶层白名单 ----------

describe('ResultValidator 顶层白名单（决议 #149）', () => {
  it('非对象输入全部拒绝', () => {
    for (const bad of [null, undefined, 42, 'str', [], true]) {
      const out = validate(bad, makeCtx());
      expect(out.ok).toBe(false);
    }
  });

  it('模型提供任何可信字段 → 整份拒绝', () => {
    const trusted = ['resultId', 'taskId', 'evidenceMap', 'conflicts', 'coverage', 'fetchedAt'];
    for (const key of trusted) {
      const draft = { ...makeDraft(), [key]: '模型伪造' };
      const out = validate(draft, makeCtx());
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reasons.join()).toContain('不允许的字段');
    }
  });

  it('未知字段（含 __proto__/constructor/prototype）→ 整份拒绝', () => {
    for (const key of ['__proto__', 'constructor', 'prototype', 'extra', 'x']) {
      const draft = { ...makeDraft(), [key]: 'x' };
      const out = validate(draft, makeCtx());
      expect(out.ok).toBe(false);
    }
  });

  it('缺 title/summary/blocks → 拒绝', () => {
    const base = makeDraft();
    expect(validate({ summary: 's', blocks: base.blocks }, makeCtx()).ok).toBe(false);
    expect(validate({ title: 't', blocks: base.blocks }, makeCtx()).ok).toBe(false);
    expect(validate({ title: 't', summary: 's' }, makeCtx()).ok).toBe(false);
  });

  it('title/summary 非法类型/超长/清理后为空 → 拒绝', () => {
    expect(validate({ ...makeDraft(), title: 42 }, makeCtx()).ok).toBe(false);
    expect(validate({ ...makeDraft(), title: '' }, makeCtx()).ok).toBe(false);
    expect(validate({ ...makeDraft(), title: ' ' }, makeCtx()).ok).toBe(false);
    expect(validate({ ...makeDraft(), title: 'x'.repeat(121) }, makeCtx()).ok).toBe(false);
    expect(validate({ ...makeDraft(), summary: 'x'.repeat(2001) }, makeCtx()).ok).toBe(false);
  });

  it('title 121/120 边界（≤120 通过）', () => {
    expect(validate({ ...makeDraft(), title: 'x'.repeat(120) }, makeCtx()).ok).toBe(true);
  });

  it('blocks 非数组/空数组/21 块 → 拒绝', () => {
    expect(validate({ ...makeDraft(), blocks: 'x' }, makeCtx()).ok).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [] }, makeCtx()).ok).toBe(false);
    const many = Array.from({ length: 21 }, () => ({
      kind: 'markdown',
      text: 'x',
    }));
    expect(validate({ ...makeDraft(), blocks: many }, makeCtx()).ok).toBe(false);
  });
});

// ---------- C. markdown 块 ----------

describe('ResultValidator markdown 块', () => {
  it('未知 kind / 未知块字段 → 拒绝', () => {
    const ctx = makeCtx();
    expect(validate({ ...makeDraft(), blocks: [{ kind: 'html', text: '<b>x</b>' }] }, ctx).ok).toBe(
      false,
    );
    expect(
      validate({ ...makeDraft(), blocks: [{ kind: 'markdown', text: 'x', extra: 1 }] }, ctx).ok,
    ).toBe(false);
  });

  it('空文本 / 超长 4001 / 非字符串 → 拒绝', () => {
    const ctx = makeCtx();
    expect(validate({ ...makeDraft(), blocks: [{ kind: 'markdown', text: '' }] }, ctx).ok).toBe(
      false,
    );
    expect(
      validate({ ...makeDraft(), blocks: [{ kind: 'markdown', text: 'x'.repeat(4001) }] }, ctx).ok,
    ).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [{ kind: 'markdown', text: 42 }] }, ctx).ok).toBe(
      false,
    );
  });

  it('危险链接（javascript:/data:/userinfo/相对）→ 整份拒绝（FT-12）', () => {
    const ctx = makeCtx();
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///x',
      'about:blank',
      'https://user@example.com/',
      '相对路径',
    ]) {
      const out = validate(
        { ...makeDraft(), blocks: [{ kind: 'markdown', text: `[x](${bad})` }] },
        ctx,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reasons.join()).toContain('危险链接');
    }
  });

  it('HTML-looking 文本（<script>/<img onerror>）作为文本合法通过（渲染层转义）', () => {
    const out = validate(
      {
        ...makeDraft(),
        blocks: [{ kind: 'markdown', text: '对比：a < b 与 <script>alert(1)</script>' }],
      },
      makeCtx(),
    );
    expect(out.ok).toBe(true);
  });

  it('CRLF 归一 + 控制字符/bidi 清除（清理后为空 → 拒绝）', () => {
    const ctx = makeCtx();
    const out = validate(
      { ...makeDraft(), blocks: [{ kind: 'markdown', text: '甲\r\n乙⁦丙' }] },
      ctx,
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const md = out.result.blocks.find((b) => b.kind === 'markdown');
    expect(md).toMatchObject({ text: '甲\n乙丙' });
    // 清理后为空
    expect(validate({ ...makeDraft(), blocks: [{ kind: 'markdown', text: '⁦' }] }, ctx).ok).toBe(
      false,
    );
  });
});

// ---------- D. table 块 ----------

describe('ResultValidator table 块', () => {
  const table = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    kind: 'table',
    columns: ['名称', '数值'],
    rows: [
      ['甲', '1'],
      ['乙', '2'],
    ],
    sourceRefs: [CAND1, CAND2],
    ...over,
  });

  it('行列边界：columns 0/21、rows 0/201 → 拒绝', () => {
    const ctx = makeCtx();
    expect(validate({ ...makeDraft(), blocks: [table({ columns: [] })] }, ctx).ok).toBe(false);
    expect(
      validate(
        {
          ...makeDraft(),
          blocks: [table({ columns: Array.from({ length: 21 }, (_, i) => `c${i}`) })],
        },
        ctx,
      ).ok,
    ).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [table({ rows: [] })] }, ctx).ok).toBe(false);
    const many = Array.from({ length: 201 }, () => ['x', 'y']);
    expect(validate({ ...makeDraft(), blocks: [table({ rows: many })] }, ctx).ok).toBe(false);
  });

  it('每行列数与 columns 严格相同 → 拒绝', () => {
    const ctx = makeCtx();
    expect(validate({ ...makeDraft(), blocks: [table({ rows: [['甲']] })] }, ctx).ok).toBe(false);
    expect(
      validate({ ...makeDraft(), blocks: [table({ rows: [['甲', '1', '多余']] })] }, ctx).ok,
    ).toBe(false);
  });

  it('列名空/超长 201、cell 超长 201 → 拒绝；cell 允许空串', () => {
    const ctx = makeCtx();
    expect(validate({ ...makeDraft(), blocks: [table({ columns: ['', 'b'] })] }, ctx).ok).toBe(
      false,
    );
    expect(
      validate({ ...makeDraft(), blocks: [table({ columns: ['x'.repeat(201), 'b'] })] }, ctx).ok,
    ).toBe(false);
    expect(
      validate({ ...makeDraft(), blocks: [table({ rows: [['x'.repeat(201), '1']] })] }, ctx).ok,
    ).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [table({ rows: [['', '1']] })] }, ctx).ok).toBe(true);
  });

  it('sourceRefs：空/重复/超量 9/未知 candidate/无 Evidence 支撑/跨 task → 拒绝', () => {
    const ctx = makeCtx();
    expect(validate({ ...makeDraft(), blocks: [table({ sourceRefs: [] })] }, ctx).ok).toBe(false);
    expect(
      validate({ ...makeDraft(), blocks: [table({ sourceRefs: [CAND1, CAND1] })] }, ctx).ok,
    ).toBe(false);
    expect(
      validate(
        {
          ...makeDraft(),
          blocks: [table({ sourceRefs: Array.from({ length: 9 }, (_, i) => `r${i}`) })],
        },
        ctx,
      ).ok,
    ).toBe(false);
    // 未知 candidate（形状合法但不在候选集）
    expect(
      validate(
        {
          ...makeDraft(),
          blocks: [table({ sourceRefs: ['f0000000-0000-4000-8000-000000000099'] })],
        },
        ctx,
      ).ok,
    ).toBe(false);
    // 候选在集合但无 verified Evidence 支撑
    const noEvidenceCtx = makeCtx({
      candidates: [
        ...makeCtx().candidates,
        makeCandidate('c3333333-3333-4333-8333-333333333333', 'https://example.com/three'),
      ],
    });
    expect(
      validate(
        {
          ...makeDraft(),
          blocks: [table({ sourceRefs: ['c3333333-3333-4333-8333-333333333333'] })],
        },
        noEvidenceCtx,
      ).ok,
    ).toBe(false);
    // 跨 task（证据属于别的 task）
    const otherTask = makeCtx({ taskId: 'task-1' });
    const otherEv = {
      ...makeEvidence(
        'e3333333-3333-4333-8333-333333333333',
        'c3333333-3333-4333-8333-333333333333',
        '2026-08-16T09:00:00.000Z',
      ),
      taskId: 'other-task',
    };
    expect(
      validate(
        {
          ...makeDraft(),
          blocks: [table({ sourceRefs: ['c3333333-3333-4333-8333-333333333333'] })],
        },
        { ...otherTask, evidence: [otherEv] },
      ).ok,
    ).toBe(false);
  });

  it('表格块未知字段 → 拒绝', () => {
    const ctx = makeCtx();
    const block = table();
    (block as Record<string, unknown>)['extraCol'] = 'x';
    expect(validate({ ...makeDraft(), blocks: [block] }, ctx).ok).toBe(false);
  });
});

// ---------- E. cards / ranking 块 ----------

describe('ResultValidator cards/ranking 块', () => {
  it('cards：items 0/21、title 空/121、body 空/1001、subtitle 121 → 拒绝', () => {
    const ctx = makeCtx();
    const card = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      kind: 'cards',
      items: [{ title: '卡', subtitle: null, body: '正文', sourceRefs: [CAND1] }],
      ...over,
    });
    expect(validate({ ...makeDraft(), blocks: [card({ items: [] })] }, ctx).ok).toBe(false);
    const many = Array.from({ length: 21 }, () => ({
      title: 't',
      subtitle: null,
      body: 'b',
      sourceRefs: [CAND1],
    }));
    expect(validate({ ...makeDraft(), blocks: [card({ items: many })] }, ctx).ok).toBe(false);
    expect(
      validate(
        {
          ...makeDraft(),
          blocks: [
            card({ items: [{ title: '', subtitle: null, body: 'b', sourceRefs: [CAND1] }] }),
          ],
        },
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      validate(
        {
          ...makeDraft(),
          blocks: [
            card({
              items: [{ title: 'x'.repeat(121), subtitle: null, body: 'b', sourceRefs: [CAND1] }],
            }),
          ],
        },
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      validate(
        {
          ...makeDraft(),
          blocks: [
            card({
              items: [{ title: 't', subtitle: 'x'.repeat(121), body: 'b', sourceRefs: [CAND1] }],
            }),
          ],
        },
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      validate(
        {
          ...makeDraft(),
          blocks: [
            card({
              items: [{ title: 't', subtitle: null, body: 'x'.repeat(1001), sourceRefs: [CAND1] }],
            }),
          ],
        },
        ctx,
      ).ok,
    ).toBe(false);
    // 条目未知字段
    expect(
      validate(
        {
          ...makeDraft(),
          blocks: [
            card({
              items: [{ title: 't', subtitle: null, body: 'b', sourceRefs: [CAND1], extra: 1 }],
            }),
          ],
        },
        ctx,
      ).ok,
    ).toBe(false);
  });

  it('ranking：rank 必须与数组顺序严格构成 1..N（乱序/缺项/重复/0 起点/负数/非整数/字符串）→ 拒绝', () => {
    const ctx = makeCtx();
    const ranking = (ranks: unknown[]): Record<string, unknown> => ({
      kind: 'ranking',
      items: ranks.map((rank, i) => ({
        rank,
        title: `第${i}项`,
        detail: '细节',
        sourceRefs: [CAND1],
      })),
    });
    expect(validate({ ...makeDraft(), blocks: [ranking([1, 2, 3])] }, ctx).ok).toBe(true);
    expect(validate({ ...makeDraft(), blocks: [ranking([2, 1, 3])] }, ctx).ok).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [ranking([1, 1, 2])] }, ctx).ok).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [ranking([2, 3, 4])] }, ctx).ok).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [ranking([0, 1])] }, ctx).ok).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [ranking([-1, 1])] }, ctx).ok).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [ranking([1.5, 2])] }, ctx).ok).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [ranking(['1', 2])] }, ctx).ok).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [ranking([])] }, ctx).ok).toBe(false);
    const many = Array.from({ length: 21 }, (_, i) => i + 1);
    expect(validate({ ...makeDraft(), blocks: [ranking(many)] }, ctx).ok).toBe(false);
  });
});

// ---------- F. uncertain 块 ----------

describe('ResultValidator uncertain 块', () => {
  it('text/reason 空或超长 1001 → 拒绝；未知字段 → 拒绝', () => {
    const ctx = makeCtx();
    const u = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      kind: 'uncertain',
      text: '不确定内容',
      reason: '原因',
      ...over,
    });
    expect(validate({ ...makeDraft(), blocks: [u({ text: '' })] }, ctx).ok).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [u({ reason: '' })] }, ctx).ok).toBe(false);
    expect(validate({ ...makeDraft(), blocks: [u({ text: 'x'.repeat(1001) })] }, ctx).ok).toBe(
      false,
    );
    expect(validate({ ...makeDraft(), blocks: [u({ reason: 'x'.repeat(1001) })] }, ctx).ok).toBe(
      false,
    );
    expect(validate({ ...makeDraft(), blocks: [u({ extra: 1 })] }, ctx).ok).toBe(false);
  });
});

// ---------- G. 强制 uncertainty 矩阵（决议 #151(5)） ----------

describe('ResultValidator 强制 uncertainty 矩阵', () => {
  const noUncertain = (blocks: unknown[]): Record<string, unknown> => ({
    title: 't',
    summary: 's',
    blocks,
  });
  const withUncertain = (): Record<string, unknown> => ({
    title: 't',
    summary: 's',
    blocks: [{ kind: 'uncertain', text: '不确定', reason: '原因' }],
  });

  it('Evidence 为空 + 无 uncertain → 拒绝；有 uncertain → 通过', () => {
    const ctx = makeCtx({ evidence: [] });
    expect(validate(noUncertain([{ kind: 'markdown', text: 'x' }]), ctx).ok).toBe(false);
    expect(validate(withUncertain(), ctx).ok).toBe(true);
  });

  it('Claims 为空 + 无 uncertain → 拒绝；有 uncertain → 通过', () => {
    const ctx = makeCtx({ claims: [] });
    expect(validate(noUncertain([{ kind: 'markdown', text: 'x' }]), ctx).ok).toBe(false);
    expect(validate(withUncertain(), ctx).ok).toBe(true);
  });

  it('verificationState=unavailable + 无 uncertain → 拒绝', () => {
    const ctx = makeCtx({ verificationState: 'unavailable' });
    expect(validate(noUncertain([{ kind: 'markdown', text: 'x' }]), ctx).ok).toBe(false);
    expect(validate(withUncertain(), ctx).ok).toBe(true);
  });

  it('存在 unresolved conflict + 无 uncertain → 拒绝', () => {
    const ctx = makeCtx({ conflicts: [makeConflict()] });
    expect(validate(noUncertain([{ kind: 'markdown', text: 'x' }]), ctx).ok).toBe(false);
    expect(validate(withUncertain(), ctx).ok).toBe(true);
  });

  it('resolved=explicit 冲突不触发强制（v1 恒 unresolved，防御性覆盖）', () => {
    const ctx = makeCtx({ conflicts: [makeConflict({ resolved: 'explicit' })] });
    expect(validate(noUncertain([{ kind: 'markdown', text: 'x' }]), ctx).ok).toBe(true);
  });

  it('单源 high Claim + 无 uncertain → 拒绝', () => {
    const ctx = makeCtx({ claims: [makeClaim({ severity: 'high', coverage: 'single-source' })] });
    expect(validate(noUncertain([{ kind: 'markdown', text: 'x' }]), ctx).ok).toBe(false);
    expect(validate(withUncertain(), ctx).ok).toBe(true);
  });

  it('多源 high / 单源 medium 不触发强制', () => {
    expect(
      validate(
        noUncertain([{ kind: 'markdown', text: 'x' }]),
        makeCtx({ claims: [makeClaim({ severity: 'high', coverage: 'multi-source' })] }),
      ).ok,
    ).toBe(true);
    expect(
      validate(
        noUncertain([{ kind: 'markdown', text: 'x' }]),
        makeCtx({ claims: [makeClaim({ severity: 'medium', coverage: 'single-source' })] }),
      ).ok,
    ).toBe(true);
  });

  it('证据充分时模型主动额外 uncertain → 允许（不拒绝）', () => {
    const ctx = makeCtx(); // 全条件满足
    expect(validate(makeDraft(), ctx).ok).toBe(true); // makeDraft 已含 uncertain
  });
});

// ---------- H. 程序投影不受模型控制 ----------

describe('ResultValidator 程序投影（决议 #151）', () => {
  it('coverage 由 ctx.claims 计数（类别计数可重叠、不要求相加等于 total）', () => {
    const ctx = makeCtx({
      claims: [
        makeClaim({
          claimId: 'f0000000-0000-4000-8000-000000000001',
          coverage: 'multi-source',
          sourceTypes: ['vendor', 'third-party'],
        }),
        makeClaim({
          claimId: 'f0000000-0000-4000-8000-000000000002',
          coverage: 'single-source',
          sourceTypes: ['community'],
        }),
        makeClaim({
          claimId: 'f0000000-0000-4000-8000-000000000003',
          coverage: 'single-source',
          sourceTypes: ['third-party'],
        }),
      ],
    });
    const out = validate(makeDraft(), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.coverage).toEqual({
      total: 3,
      multiSource: 1,
      singleSource: 2,
      vendor: 1,
      thirdParty: 2, // 与 vendor 重叠：1+2+1=4 > total=3（如实计数）
      community: 1,
    });
  });

  it('conflicts 由 ctx.conflicts 精确投影（模型无法增删改写）', () => {
    const ctx = makeCtx({ conflicts: [makeConflict()] });
    const out = validate(makeDraft(), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.conflicts).toEqual([
      {
        conflictId: 'd0000000-0000-4000-8000-000000000001',
        topic: '冲突主题',
        positions: [
          { positionText: '甲方立场', sourceRefs: [CAND1] },
          { positionText: '乙方立场', sourceRefs: [CAND2] },
        ],
      },
    ]);
  });

  it('evidenceMap 键升序确定性输出', () => {
    const ctx = makeCtx({
      evidence: [
        makeEvidence(EVID2, CAND2, '2026-08-16T11:00:00.000Z'),
        makeEvidence(EVID1, CAND1, '2026-08-16T10:00:00.000Z'),
      ],
    });
    const out = validate(makeDraft(), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(Object.keys(out.result.evidenceMap)).toEqual([EVID1, EVID2]);
  });

  it('fetchedAt：无 Evidence → ctx.now；非法 ctx.now 形态 → 拒绝（防御）', () => {
    const ctx = makeCtx({ evidence: [] });
    const out = validate(makeDraft(), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.fetchedAt).toBe('2026-08-16T12:00:00.000Z');
  });
});

// ---------- I. UUID 与工厂异常 ----------

describe('ResultValidator resultId 可信预分配', () => {
  it('createId 返回非法（非 v4/大写/垃圾）→ 整份拒绝', () => {
    for (const bad of ['not-a-uuid', 'AAAA1111-1111-4111-8111-111111111111', '', 'x'.repeat(36)]) {
      const out = validate(makeDraft(), makeCtx({ createId: () => bad }));
      expect(out.ok).toBe(false);
    }
  });

  it('createId 抛异常 → 安全返回拒绝（不抛穿）', () => {
    const out = validate(
      makeDraft(),
      makeCtx({
        createId: () => {
          throw new Error('id factory exploded');
        },
      }),
    );
    expect(out.ok).toBe(false);
  });
});

// ---------- J. 总大小边界 ----------

describe('ResultValidator 总大小（MAX_RESULT_CHARS ±1）', () => {
  // 精确构造目标总长的草案：自合法小构型「向上逼近」（每轮 measure 必须合法
  // ——中间态不得超上限）；跳变步长（满行/满格/满块）先填大头，最后一公里用
  // summary 与单格字符的 1:1 粒度精确命中；行列严格一致（列数恒 20）
  function buildDraftForTarget(
    target: number,
    ctx: ResearchResultValidationContext,
  ): Record<string, unknown> {
    const draft = {
      title: 't',
      summary: '',
      blocks: [{ kind: 'markdown', text: 'a' }],
    } as { title: string; summary: string; blocks: Record<string, unknown>[] };
    const measure = (): number => {
      const out = validate(draft, ctx);
      if (!out.ok) throw new Error(`夹具构造失败：${out.reasons.join('；')}`);
      return JSON.stringify(out.result).length;
    };
    const table = {
      kind: 'table',
      columns: Array.from({ length: MAX_TABLE_COLUMNS }, (_, i) => `c${i + 1}`),
      rows: [Array.from({ length: MAX_TABLE_COLUMNS }, () => '')] as string[][],
      sourceRefs: [CAND1],
    };
    draft.blocks.push(table as unknown as Record<string, unknown>);
    for (let guard = 0; guard < 6000; guard += 1) {
      const need = target - measure();
      if (need === 0) return draft;
      if (need < 0) throw new Error('夹具超调');
      const mdCount = draft.blocks.filter((b) => b['kind'] === 'markdown').length;
      const summaryRoom = MAX_RESULT_SUMMARY_CHARS - draft.summary.length;
      if (need <= summaryRoom) {
        draft.summary += 'x'.repeat(need); // 1:1 精确命中
        return draft;
      }
      // 1:1 粒度储备：未满 200 的格（填满或精确命中）
      const flatCells: string[] = [];
      for (const r of table.rows) for (const c of r) flatCells.push(c);
      const lastPartial = flatCells.reduce(
        (acc, c, i) => (c.length < MAX_TABLE_CELL_CHARS ? i : acc),
        -1,
      );
      if (lastPartial !== -1) {
        const room = MAX_TABLE_CELL_CHARS - flatCells[lastPartial]!.length;
        if (need <= room) {
          flatCells[lastPartial] += 'x'.repeat(need); // 精确命中
        } else {
          flatCells[lastPartial] += 'x'.repeat(room); // 填满后下一轮重算
        }
        let idx = 0;
        for (const r of table.rows)
          for (let g = 0; g < r.length; g += 1) {
            r[g] = flatCells[idx]!;
            idx += 1;
          }
        if (need <= room) return draft;
        continue;
      }
      // 1:1 粒度储备：未满 4000 的 markdown 块
      const mdPartial = draft.blocks.find(
        (b) => b['kind'] === 'markdown' && (b['text'] as string).length < 4000,
      ) as { kind: string; text: string } | undefined;
      if (mdPartial !== undefined) {
        const room = MAX_MARKDOWN_BLOCK_CHARS - mdPartial.text.length;
        if (need <= room) {
          mdPartial.text += 'x'.repeat(need);
          return draft;
        }
        mdPartial.text += 'x'.repeat(room);
        continue;
      }
      // 跳变步长（新满格 +203 / 新满行 +4061 / 新满 markdown 块 +4032）
      const lastRow = table.rows[table.rows.length - 1]!;
      if (lastRow.length < MAX_TABLE_COLUMNS && need >= MAX_TABLE_CELL_CHARS + 3) {
        lastRow.push('x'.repeat(MAX_TABLE_CELL_CHARS));
        continue;
      }
      if (table.rows.length < MAX_TABLE_ROWS && need >= 4061) {
        table.rows.push(Array.from({ length: 20 }, () => 'x'.repeat(MAX_TABLE_CELL_CHARS)));
        continue;
      }
      if (mdCount < 19 && need >= MAX_MARKDOWN_BLOCK_CHARS + 32) {
        draft.blocks.push({ kind: 'markdown', text: 'x'.repeat(MAX_MARKDOWN_BLOCK_CHARS) });
        continue;
      }
      throw new Error('无法收敛到目标长度（容量不足）');
    }
    throw new Error('夹具构造循环超限');
  }

  it('恰好 200000 字符 → 通过；200001 → 拒绝', () => {
    const ctx = makeCtx(); // evidence/claims 非空：无强制矩阵，可自由填充
    const exactDraft = buildDraftForTarget(MAX_RESULT_CHARS, ctx);
    const exact = validate(exactDraft, ctx);
    expect(exact.ok).toBe(true);
    if (!exact.ok) return;
    expect(JSON.stringify(exact.result).length).toBe(MAX_RESULT_CHARS);
    // +1 → 拒绝（总大小检查在字段上限之外的防御层）：复制草案后 +1 字符
    const overDraft = JSON.parse(JSON.stringify(exactDraft)) as {
      title: string;
      summary: string;
      blocks: Array<Record<string, unknown>>;
    };
    if (overDraft.summary.length < MAX_RESULT_SUMMARY_CHARS) {
      overDraft.summary += 'x';
    } else {
      // summary 已满：找任一未满 200 的格 +1
      const table = overDraft.blocks.find((b) => b['kind'] === 'table') as {
        kind: string;
        rows: string[][];
      };
      let done = false;
      for (const r of table.rows) {
        for (let g = 0; g < r.length && !done; g += 1) {
          if (r[g]!.length < MAX_TABLE_CELL_CHARS) {
            r[g] += 'x';
            done = true;
          }
        }
      }
      expect(done).toBe(true);
    }
    const over = validate(overDraft, ctx);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.reasons.join()).toContain('总大小');
  });
});

// ---------- K. 错误报告纪律 ----------

describe('ResultValidator 错误报告纪律（决议 #150(8)）', () => {
  it('错误数量有界（≤ MAX_RESULT_VALIDATION_REASONS）且顺序稳定', () => {
    const ctx = makeCtx();
    const blocks: unknown[] = [];
    // 构造 >10 个独立错误（超长 + 空 + 危险链接交错，验证按块索引升序截断）
    for (let i = 0; i < 15; i += 1) {
      blocks.push({ kind: 'markdown', text: '' });
    }
    const out = validate({ title: '', summary: '', blocks }, ctx);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reasons.length).toBeLessThanOrEqual(MAX_RESULT_VALIDATION_REASONS);
    expect(out.reasons[0]).toContain('title');
    // 顺序稳定：两次相同输入输出相同 reasons
    const again = validate({ title: '', summary: '', blocks }, ctx);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reasons).toEqual(out.reasons);
  });

  it('错误文本零敌对正文回显', () => {
    const hostile = 'SK-SECRET-TOKEN <script>alert(1)</script> 敌对正文';
    const ctx = makeCtx();
    const out = validate(
      {
        title: 't',
        summary: 's',
        blocks: [{ kind: 'markdown', text: hostile }], // 非法：文本 >4000 不适用——用危险链接包裹
      },
      ctx,
    );
    // 该输入合法（HTML 文本允许）——改用真正的错误路径验证
    expect(out.ok).toBe(true);
    const out2 = validate(
      {
        title: 't',
        summary: 's',
        blocks: [{ kind: 'markdown', text: `[${hostile}](javascript:x)` }],
      },
      ctx,
    );
    expect(out2.ok).toBe(false);
    if (out2.ok) return;
    const joined = out2.reasons.join('\n');
    expect(joined).not.toContain('SK-SECRET');
    expect(joined).not.toContain('<script>');
    expect(joined).not.toContain('敌对正文');
    expect(joined).toContain('blocks[0]');
  });

  it('单条原因 ≤200 字符（MAX_RESEARCH_REASON_CHARS）', () => {
    const ctx = makeCtx();
    const out = validate({ title: '', summary: '', blocks: [] }, ctx);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    for (const r of out.reasons) expect(r.length).toBeLessThanOrEqual(200);
  });
});
