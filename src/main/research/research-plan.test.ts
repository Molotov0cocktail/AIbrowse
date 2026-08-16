// C5 research-plan tests (adjudication #133): the strict ResearchPlan
// discriminated parsing — every model field treated as untrusted (allowlist/
// type/length/count validation), groupId/candidateId may only reference
// program-provided collections, query/selection two-round semantics, the
// deterministic safe default plan (zero model output), and hostile-input
// matrices (never throws).
import { describe, expect, it } from 'vitest';
import {
  MAX_PLAN_WEB_QUERIES,
  MAX_SELECTED_SOURCES,
  type ResearchPlan,
} from '../../shared/types/research';
import type { SourceCandidate } from '../../shared/types/research';
import { buildDefaultPlan, parseResearchPlan, type PlanGroupRef } from './research-plan';

const G1 = '11111111-1111-4111-8111-111111111111';
const G2 = '22222222-2222-4222-8222-222222222222';

const GROUPS: readonly PlanGroupRef[] = [
  { groupId: G1, name: 'AI Benchmark' },
  { groupId: G2, name: '官方资料' },
];

function makeCandidate(id: string): SourceCandidate {
  return {
    id,
    url: `https://c.example/${id}`,
    displayUrl: `https://c.example/${id}`,
    title: '候选',
    canonicalKey: `https://c.example/${id}`,
    scope: 'page',
    discoveredVia: ['search'],
    sourceId: null,
    trust: null,
    priority: null,
    lastUsedAt: null,
    note: null,
    sortKey: `03|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|https://c.example/${id}|${id}`,
  };
}

// 轮 1（query 阶段）：sourceMode/sourceQuery/groupId/webQueries 生效；
// selectedCandidateIds 引用的候选集合尚不存在，必须空
describe('parseResearchPlan：query 阶段（决议 #133）', () => {
  it('search 模式合法计划（webQueries ≤1）', () => {
    const r = parseResearchPlan(
      JSON.stringify({
        sourceMode: 'search',
        sourceQuery: '主流模型 Agent 能力',
        groupId: null,
        webQueries: ['官方文档 Agent 对比'],
      }),
      { stage: 'query', groups: GROUPS },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan).toEqual({
        sourceMode: 'search',
        sourceQuery: '主流模型 Agent 能力',
        groupId: null,
        webQueries: ['官方文档 Agent 对比'],
        selectedCandidateIds: [],
      });
    }
  });

  it('group 模式：groupId 必须 ∈ 程序提供的 group 集合', () => {
    const ok = parseResearchPlan(
      JSON.stringify({ sourceMode: 'group', sourceQuery: '', groupId: G1, webQueries: [] }),
      { stage: 'query', groups: GROUPS },
    );
    expect(ok.ok).toBe(true);
    const bad = parseResearchPlan(
      JSON.stringify({
        sourceMode: 'group',
        sourceQuery: '',
        groupId: '99999999-9999-4999-8999-999999999999',
        webQueries: [],
      }),
      { stage: 'query', groups: GROUPS },
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBeTruthy();
  });

  it('group 模式必须提供 groupId；search 模式必须提供非空 sourceQuery', () => {
    expect(
      parseResearchPlan(
        JSON.stringify({ sourceMode: 'group', sourceQuery: '', groupId: null, webQueries: [] }),
        {
          stage: 'query',
          groups: GROUPS,
        },
      ).ok,
    ).toBe(false);
    expect(
      parseResearchPlan(
        JSON.stringify({ sourceMode: 'search', sourceQuery: '', groupId: null, webQueries: [] }),
        {
          stage: 'query',
          groups: GROUPS,
        },
      ).ok,
    ).toBe(false);
    expect(
      parseResearchPlan(
        JSON.stringify({ sourceMode: 'search', sourceQuery: 'q', groupId: G1, webQueries: [] }),
        {
          stage: 'query',
          groups: GROUPS,
        },
      ).ok,
    ).toBe(false); // search 模式 groupId 必须 null
  });

  it('webQueries 数量 ≤MAX_PLAN_WEB_QUERIES（1）；每项非空 ≤500 清洗后非空', () => {
    expect(
      parseResearchPlan(
        JSON.stringify({
          sourceMode: 'search',
          sourceQuery: 'q',
          groupId: null,
          webQueries: ['a', 'b'],
        }),
        { stage: 'query', groups: GROUPS },
      ).ok,
    ).toBe(false);
    expect(
      parseResearchPlan(
        JSON.stringify({
          sourceMode: 'search',
          sourceQuery: 'q',
          groupId: null,
          webQueries: ['   '],
        }),
        { stage: 'query', groups: GROUPS },
      ).ok,
    ).toBe(false);
    expect(
      parseResearchPlan(
        JSON.stringify({ sourceMode: 'search', sourceQuery: 'q', groupId: null, webQueries: [42] }),
        { stage: 'query', groups: GROUPS },
      ).ok,
    ).toBe(false);
  });

  it('query 阶段 selectedCandidateIds 必须空/缺省（引用尚不存在的集合）', () => {
    const r = parseResearchPlan(
      JSON.stringify({
        sourceMode: 'search',
        sourceQuery: 'q',
        groupId: null,
        webQueries: [],
        selectedCandidateIds: [G1],
      }),
      { stage: 'query', groups: GROUPS },
    );
    expect(r.ok).toBe(false);
    // 缺省合法（补全为空数组）
    const r2 = parseResearchPlan(
      JSON.stringify({ sourceMode: 'search', sourceQuery: 'q', groupId: null, webQueries: [] }),
      { stage: 'query', groups: GROUPS },
    );
    expect(r2.ok).toBe(true);
  });

  it('敌对输入矩阵：未知字段/非对象/非法 JSON/类型不符/超长 → 整体拒绝零 throw', () => {
    const cases: unknown[] = [
      'not-json',
      '[1,2]',
      null,
      42,
      '"str"',
      { sourceMode: 'search', sourceQuery: 'q', groupId: null, webQueries: [], evil: true },
      { sourceMode: 'both', sourceQuery: 'q', groupId: null, webQueries: [] },
      { sourceMode: 'search', sourceQuery: 42, groupId: null, webQueries: [] },
      { sourceMode: 'search', sourceQuery: 'q'.repeat(501), groupId: null, webQueries: [] },
      { sourceMode: 'search', sourceQuery: 'q', groupId: null, webQueries: {} },
    ];
    for (const c of cases) {
      const r = parseResearchPlan(JSON.stringify(c), { stage: 'query', groups: GROUPS });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(typeof r.reason).toBe('string');
    }
  });

  it('sourceQuery 清洗：NFC/trim/控制字符剔除后非空才合法', () => {
    expect(
      parseResearchPlan(
        JSON.stringify({
          sourceMode: 'search',
          sourceQuery: '  q\u0000  ',
          groupId: null,
          webQueries: [],
        }),
        { stage: 'query', groups: GROUPS },
      ).ok,
    ).toBe(true);
  });
});

// 轮 2（selection 阶段）：只读 selectedCandidateIds（⊆ 已合并候选集合）
describe('parseResearchPlan：selection 阶段（决议 #133(2)）', () => {
  const C1 = '33333333-3333-4333-8333-333333333333';
  const C2 = '44444444-4444-4444-8444-444444444444';
  const C3 = '55555555-5555-4555-8555-555555555555';
  const candidates = [makeCandidate(C1), makeCandidate(C2), makeCandidate(C3)];

  it('合法：id ⊆ 候选集合且 ≤MAX_SELECTED_SOURCES', () => {
    const r = parseResearchPlan(JSON.stringify({ selectedCandidateIds: [C2, C1] }), {
      stage: 'selection',
      candidates,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.selectedCandidateIds).toEqual([C2, C1]);
  });

  it('空数组合法（程序默认前 8）', () => {
    const r = parseResearchPlan(JSON.stringify({ selectedCandidateIds: [] }), {
      stage: 'selection',
      candidates,
    });
    expect(r.ok).toBe(true);
  });

  it('未命中候选集合的 id → 整体拒绝（不得重新发明 URL）', () => {
    const r = parseResearchPlan(
      JSON.stringify({ selectedCandidateIds: ['99999999-9999-4999-8999-999999999999'] }),
      { stage: 'selection', candidates },
    );
    expect(r.ok).toBe(false);
  });

  it('非 UUID 形状/重复 id/超 8 条/类型不符 → 拒绝', () => {
    for (const bad of [
      { selectedCandidateIds: ['not-a-uuid'] },
      { selectedCandidateIds: [C1, C1] },
      { selectedCandidateIds: [42] },
    ]) {
      expect(parseResearchPlan(JSON.stringify(bad), { stage: 'selection', candidates }).ok).toBe(
        false,
      );
    }
    const many = Array.from(
      { length: MAX_SELECTED_SOURCES + 1 },
      (_, i) => `66666666-6666-4666-8666-${String(i).padStart(12, '0')}`,
    );
    const wide = [C1, C2, C3, ...many.slice(0, 6)].map((id) => makeCandidate(id));
    expect(
      parseResearchPlan(
        JSON.stringify({ selectedCandidateIds: wide.slice(0, 9).map((c) => c.id) }),
        {
          stage: 'selection',
          candidates: wide,
        },
      ).ok,
    ).toBe(false);
  });

  it('selection 阶段其余字段忽略（但顶层必须为对象）', () => {
    const r = parseResearchPlan(
      JSON.stringify({
        sourceMode: 'group',
        sourceQuery: 'x',
        groupId: 'junk',
        webQueries: ['ignored'],
        selectedCandidateIds: [C1],
      }),
      { stage: 'selection', candidates },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan.selectedCandidateIds).toEqual([C1]);
  });
});

// 安全默认计划（决议 #133(7)）：不引用模型任何输出
describe('buildDefaultPlan：安全默认计划（决议 #133(7)）', () => {
  it('search 模式 + goal 确定性截断 ≤500 + 零 web 查询 + 零选择', () => {
    const goal = '研'.repeat(800);
    const plan = buildDefaultPlan(goal);
    expect(plan.sourceMode).toBe('search');
    expect(plan.sourceQuery.length).toBeLessThanOrEqual(500);
    expect(plan.sourceQuery.length).toBeGreaterThan(0);
    expect(plan.groupId).toBeNull();
    expect(plan.webQueries).toEqual([]);
    expect(plan.selectedCandidateIds).toEqual([]);
  });

  it('确定性：同输入同输出；不引用模型任何字段', () => {
    const a = buildDefaultPlan('比较主流模型');
    const b = buildDefaultPlan('比较主流模型');
    expect(a).toEqual(b);
  });

  it('默认计划本身恒合法（query 阶段解析通过）', () => {
    const plan = buildDefaultPlan('比较主流模型');
    const r = parseResearchPlan(JSON.stringify(plan), { stage: 'query', groups: GROUPS });
    expect(r.ok).toBe(true);
  });

  it('非法 goal（空/非串）安全返回（sourceQuery 空串——由调用方在 Sources 不可用时归一终态）', () => {
    expect(() => buildDefaultPlan('')).not.toThrow();
    expect(() => buildDefaultPlan(undefined as unknown as string)).not.toThrow();
  });
});

// MAX_PLAN_WEB_QUERIES 常量语义（决议 #133(1)）
describe('MAX_PLAN_WEB_QUERIES 编译期常量', () => {
  it('基线 = 1（小型编译期上限）', () => {
    expect(MAX_PLAN_WEB_QUERIES).toBe(1);
  });
});

// 类型形状收尾
describe('ResearchPlan 类型形状', () => {
  it('plan 形状为判别联合所需字段', () => {
    const plan: ResearchPlan = {
      sourceMode: 'search',
      sourceQuery: 'q',
      groupId: null,
      webQueries: [],
      selectedCandidateIds: [],
    };
    expect(plan.sourceMode).toBe('search');
  });
});
