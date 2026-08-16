// C6 claim-model tests (adjudications #142–#144/#147): VerificationDraft
// strict input protocol (pure JSON, whole-document rejection on unknown
// fields, local claimKeys), deterministic Claim assembly (Evidence/Candidate
// ownership, canonicalKey coverage, sourceTypes program classification with
// the vendor-origin adjudication, single-source disclosure, trusted v4 ID
// allocation after full validation, proposal order preserved, inputs never
// mutated), Conflict reference integrity (local claimKeys → program claimIds,
// distinct positions, sourceRefs ∈ candidates with VerifiedEvidence support
// and within the referenced claims' evidence union, ≥2 canonicalKeys,
// resolved always 'unresolved', bidirectional conflictIds), and the
// parseResultDraft hostile matrix (#147: structural parsing only, no C7
// semantics). processVerification/parseResultDraft safely return for ANY
// input and never throw.
import { describe, expect, it } from 'vitest';
import { RESEARCH_SYNTHESIS_PORT, parseResultDraft, processVerification } from './claim-model';
import type {
  Claim,
  Conflict,
  ResearchSynthesisContext,
  SourceCandidate,
  VerifiedEvidence,
} from '../../../shared/types/research';
import {
  MAX_CLAIM_EVIDENCE_REFS,
  MAX_CLAIM_KEY_CHARS,
  MAX_CLAIM_TEXT_CHARS,
  MAX_CLAIMS_PER_TASK,
  MAX_CONFLICT_CLAIM_REFS,
  MAX_CONFLICT_POSITION_CHARS,
  MAX_CONFLICT_POSITIONS,
  MAX_CONFLICT_POSITION_SOURCE_REFS,
  MAX_CONFLICT_TOPIC_CHARS,
  MAX_CONFLICTS_PER_TASK,
  MAX_RESEARCH_REASON_CHARS,
  MAX_VENDOR_CANDIDATE_IDS,
  MAX_VERIFICATION_DRAFT_CHARS,
} from '../../../shared/types/research';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

// —— 夹具 ——

function makeCandidate(
  over: Partial<SourceCandidate> & { id: string; url: string },
): SourceCandidate {
  return {
    id: over.id,
    url: over.url,
    displayUrl: over.displayUrl ?? over.url,
    title: '候选',
    canonicalKey: over.canonicalKey ?? over.url,
    scope: over.scope ?? 'page',
    discoveredVia: over.discoveredVia ?? ['search'],
    sourceId: over.sourceId ?? null,
    trust: over.trust ?? null,
    priority: over.priority ?? null,
    lastUsedAt: over.lastUsedAt ?? null,
    note: over.note ?? null,
    sortKey: over.sortKey ?? `0|00000|0|0|0|${over.url}|${over.id}`,
  };
}

function makeEvidence(
  over: Partial<VerifiedEvidence> & { evidenceId: string; candidateId: string },
): VerifiedEvidence {
  return {
    evidenceId: over.evidenceId,
    taskId: over.taskId ?? TASK_ID,
    captureId: over.captureId ?? 'cap-1',
    candidateId: over.candidateId,
    sourceId: over.sourceId ?? null,
    url: over.url ?? 'https://x.example/p',
    title: over.title ?? '标题',
    accessTime: over.accessTime ?? '2026-08-16T00:00:00.000Z',
    documentId: over.documentId ?? '1',
    contentHash: over.contentHash ?? 'a'.repeat(32),
    type: over.type ?? 'quote',
    locator: over.locator ?? { kind: 'text', excerpt: '摘录' },
    excerpt: over.excerpt ?? '摘录',
    value: over.value ?? null,
    verification: 'verified',
  };
}

const IDS = {
  candA: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
  candB: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
  candC: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000003',
  evA: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001',
  evB: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000002',
  evC: 'bbbbbbbb-bbbb-4bbb-8bbb-000000000003',
};

function makeSeqFactory(ids: string[]): () => string {
  const queue = [...ids];
  let n = 0;
  return () => {
    const next = queue.shift();
    if (next !== undefined) return next;
    n += 1;
    return `f0000000-0000-4f00-8f00-${String(n).padStart(12, '0')}`;
  };
}

// 默认双来源上下文（不同 canonicalKey；search 命中 trust=null）
function defaultCtx(): {
  ctx: ResearchSynthesisContext;
  candidates: SourceCandidate[];
  evidence: VerifiedEvidence[];
} {
  const candidates = [
    makeCandidate({
      id: IDS.candA,
      url: 'https://a.example/p1',
      canonicalKey: 'https://a.example/p1',
    }),
    makeCandidate({
      id: IDS.candB,
      url: 'https://a.example/p2',
      canonicalKey: 'https://a.example/p2',
    }),
  ];
  const evidence = [
    makeEvidence({ evidenceId: IDS.evA, candidateId: IDS.candA, url: 'https://a.example/p1' }),
    makeEvidence({ evidenceId: IDS.evB, candidateId: IDS.candB, url: 'https://a.example/p2' }),
  ];
  return {
    ctx: { taskId: TASK_ID, candidates, evidence, createId: makeSeqFactory([]) },
    candidates,
    evidence,
  };
}

function draftJson(vendor: unknown = [], claims: unknown = [], conflicts: unknown = []): string {
  return JSON.stringify({ vendorCandidateIds: vendor, claims, conflicts });
}

function claimItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    claimKey: 'c1',
    text: '结论一',
    severity: 'high',
    evidenceIds: [IDS.evA],
    ...over,
  };
}

function conflictItem(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    topic: '冲突主题',
    positions: [
      { positionText: '立场甲', sourceRefs: [IDS.candA] },
      { positionText: '立场乙', sourceRefs: [IDS.candB] },
    ],
    claimKeys: ['c1', 'c2'],
    ...over,
  };
}

// 两条结论 + 一个冲突的合法草稿（双来源）
function validDraft(): string {
  return draftJson(
    [],
    [
      { claimKey: 'c1', text: '结论一', severity: 'high', evidenceIds: [IDS.evA, IDS.evB] },
      { claimKey: 'c2', text: '结论二', severity: 'low', evidenceIds: [IDS.evA] },
    ],
    [
      {
        topic: '冲突主题',
        positions: [
          { positionText: '立场甲', sourceRefs: [IDS.candA] },
          { positionText: '立场乙', sourceRefs: [IDS.candB] },
        ],
        claimKeys: ['c1', 'c2'],
      },
    ],
  );
}

// —— 一、VerificationDraft 严格输入协议（决议 #142） ——

describe('VerificationDraft 严格输入协议（决议 #142）', () => {
  it('raw 非字符串（null/undefined/数字/对象/数组）→ 安全拒绝不抛异常', () => {
    const { ctx } = defaultCtx();
    for (const raw of [null, undefined, 42, { a: 1 }, ['x'], true]) {
      const outcome = processVerification(raw as never, ctx);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(typeof outcome.reason).toBe('string');
        expect(outcome.reason.length).toBeGreaterThan(0);
        expect(outcome.reason.length).toBeLessThanOrEqual(MAX_RESEARCH_REASON_CHARS);
      }
    }
  });

  it('非纯 JSON（普通文本/损坏 JSON）→ 整份拒绝', () => {
    const { ctx } = defaultCtx();
    for (const raw of ['不是JSON', '{claims: []}', '{"claims": [}', '']) {
      expect(processVerification(raw, ctx).ok).toBe(false);
    }
  });

  it('Markdown fence 包裹 / 前后说明文字 → 整份拒绝（不得宽松修复）', () => {
    const { ctx } = defaultCtx();
    const body = draftJson([], [], []);
    const hostile = [
      `\`\`\`json\n${body}\n\`\`\``,
      `以下是核验结果：\n${body}`,
      `${body}\n以上是核验结果。`,
      `好的，输出如下 ${body} 谢谢`,
    ];
    for (const raw of hostile) {
      const outcome = processVerification(raw, ctx);
      expect(outcome.ok).toBe(false);
    }
  });

  it('顶层不是对象（数组/字符串/数字）→ 拒绝', () => {
    const { ctx } = defaultCtx();
    for (const raw of ['[]', '"x"', '42', 'null']) {
      expect(processVerification(raw, ctx).ok).toBe(false);
    }
  });

  it('顶层未知字段/缺失字段 → 整份拒绝（严格白名单）', () => {
    const { ctx } = defaultCtx();
    // 未知顶层字段
    expect(
      processVerification(
        JSON.stringify({ vendorCandidateIds: [], claims: [], conflicts: [], extra: 1 }),
        ctx,
      ).ok,
    ).toBe(false);
    // 缺失 conflicts
    expect(
      processVerification(JSON.stringify({ vendorCandidateIds: [], claims: [] }), ctx).ok,
    ).toBe(false);
    // 缺失 vendorCandidateIds
    expect(processVerification(JSON.stringify({ claims: [], conflicts: [] }), ctx).ok).toBe(false);
  });

  it('raw 超过 MAX_VERIFICATION_DRAFT_CHARS → 拒绝', () => {
    const { ctx } = defaultCtx();
    const pad = 'x'.repeat(MAX_VERIFICATION_DRAFT_CHARS + 1);
    const outcome = processVerification(
      JSON.stringify({ claims: [claimItem({ text: pad })] }),
      ctx,
    );
    expect(outcome.ok).toBe(false);
  });

  it('vendorCandidateIds：非数组/超上限/非字符串项/未知候选 ID → 拒绝；重复去重', () => {
    const { ctx, candidates } = defaultCtx();
    expect(processVerification(draftJson('x'), ctx).ok).toBe(false);
    expect(
      processVerification(draftJson(Array(MAX_VENDOR_CANDIDATE_IDS + 1).fill(IDS.candA)), ctx).ok,
    ).toBe(false);
    expect(processVerification(draftJson([42]), ctx).ok).toBe(false);
    expect(processVerification(draftJson(['not-a-candidate-id']), ctx).ok).toBe(false);
    // 重复去重：vendorCandidateIds 含重复 ID → 仍然装配成功（程序侧去重）
    const outcome = processVerification(
      draftJson(
        [IDS.candA, IDS.candA],
        [{ claimKey: 'c1', text: '结论一', severity: 'high', evidenceIds: [IDS.evA] }],
      ),
      { ...ctx, candidates },
    );
    expect(outcome.ok).toBe(true);
  });

  it('claims 非数组/超上限 → 拒绝；空数组合法（零结论为有效语义）', () => {
    const { ctx } = defaultCtx();
    expect(processVerification(draftJson([], 'x'), ctx).ok).toBe(false);
    expect(
      processVerification(draftJson([], Array(MAX_CLAIMS_PER_TASK + 1).fill(claimItem())), ctx).ok,
    ).toBe(false);
    expect(processVerification(draftJson([], []), ctx).ok).toBe(true);
  });

  it('claim 项未知字段（coverage/sourceTypes/claimId/conflictIds/resolved/taskId）→ 整份拒绝', () => {
    const { ctx } = defaultCtx();
    const injected: unknown[] = [
      claimItem({ coverage: 'multi-source' }),
      claimItem({ sourceTypes: ['vendor'] }),
      claimItem({ claimId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000099' }),
      claimItem({ conflictIds: ['x'] }),
      claimItem({ resolved: 'unresolved' }),
      claimItem({ taskId: TASK_ID }),
      claimItem({ singleSourceFields: ['整条结论'] }),
    ];
    for (const item of injected) {
      expect(processVerification(draftJson([], [item]), ctx).ok).toBe(false);
    }
  });

  it('claim 项缺失字段 → 拒绝', () => {
    const { ctx } = defaultCtx();
    for (const item of [
      { text: 't', severity: 'low', evidenceIds: [IDS.evA] }, // 缺 claimKey
      { claimKey: 'c1', severity: 'low', evidenceIds: [IDS.evA] }, // 缺 text
      { claimKey: 'c1', text: 't', evidenceIds: [IDS.evA] }, // 缺 severity
      { claimKey: 'c1', text: 't', severity: 'low' }, // 缺 evidenceIds
    ]) {
      expect(processVerification(draftJson([], [item]), ctx).ok).toBe(false);
    }
  });

  it('claimKey：非串/空/超长/重复/未规范化（控制字符/空白）→ 拒绝', () => {
    const { ctx } = defaultCtx();
    for (const key of [42, '', 'x'.repeat(MAX_CLAIM_KEY_CHARS + 1), ' c1', 'c1 ', 'c l']) {
      expect(processVerification(draftJson([], [claimItem({ claimKey: key })]), ctx).ok).toBe(
        false,
      );
    }
    // 重复 claimKey
    expect(
      processVerification(draftJson([], [claimItem(), claimItem({ evidenceIds: [IDS.evB] })]), ctx)
        .ok,
    ).toBe(false);
  });

  it('claim text：非串/清理后为空/清理后超长 → 拒绝；控制字符/bidi 清除', () => {
    const { ctx } = defaultCtx();
    expect(processVerification(draftJson([], [claimItem({ text: 42 })]), ctx).ok).toBe(false);
    expect(processVerification(draftJson([], [claimItem({ text: '  \n​؜ ' })]), ctx).ok).toBe(
      false,
    );
    expect(
      processVerification(
        draftJson([], [claimItem({ text: 'x'.repeat(MAX_CLAIM_TEXT_CHARS + 1) })]),
        ctx,
      ).ok,
    ).toBe(false);
    // 控制字符/bidi 被清除后的装配结果
    const outcome = processVerification(draftJson([], [claimItem({ text: ' 结 论‮一 ' })]), ctx);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.claims[0]!.text).toBe('结 论一');
  });

  it('severity 非法值 → 拒绝', () => {
    const { ctx } = defaultCtx();
    for (const severity of ['HIGH', 'critical', '', 42, null]) {
      expect(processVerification(draftJson([], [claimItem({ severity })]), ctx).ok).toBe(false);
    }
  });

  it('evidenceIds：非数组/空/超上限/重复/非字符串项 → 拒绝', () => {
    const { ctx } = defaultCtx();
    expect(processVerification(draftJson([], [claimItem({ evidenceIds: 'x' })]), ctx).ok).toBe(
      false,
    );
    expect(processVerification(draftJson([], [claimItem({ evidenceIds: [] })]), ctx).ok).toBe(
      false,
    );
    expect(
      processVerification(
        draftJson(
          [],
          [claimItem({ evidenceIds: Array(MAX_CLAIM_EVIDENCE_REFS + 1).fill(IDS.evA) })],
        ),
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      processVerification(draftJson([], [claimItem({ evidenceIds: [IDS.evA, IDS.evA] })]), ctx).ok,
    ).toBe(false);
    expect(processVerification(draftJson([], [claimItem({ evidenceIds: [42] })]), ctx).ok).toBe(
      false,
    );
  });

  it('conflicts 非数组/超上限 → 拒绝；空数组合法', () => {
    const { ctx } = defaultCtx();
    expect(processVerification(draftJson([], [], 'x'), ctx).ok).toBe(false);
    expect(
      processVerification(
        draftJson([], [], Array(MAX_CONFLICTS_PER_TASK + 1).fill(conflictItem())),
        ctx,
      ).ok,
    ).toBe(false);
    expect(processVerification(draftJson([], [], []), ctx).ok).toBe(true);
  });

  it('conflict 项未知字段（conflictId/resolved/claimIds）→ 整份拒绝', () => {
    const { ctx } = defaultCtx();
    const claims = [
      { claimKey: 'c1', text: '结论一', severity: 'high', evidenceIds: [IDS.evA] },
      { claimKey: 'c2', text: '结论二', severity: 'low', evidenceIds: [IDS.evB] },
    ];
    for (const item of [
      conflictItem({ conflictId: 'x' }),
      conflictItem({ resolved: 'explicit' }),
      conflictItem({ claimIds: ['x'] }),
      conflictItem({ positions: [] }), // 与 claimIds 同字段名的真实字段（不可提交）
    ]) {
      expect(processVerification(draftJson([], claims, [item]), ctx).ok).toBe(false);
    }
  });

  it('conflict 缺失字段/嵌套未知字段 → 拒绝', () => {
    const { ctx } = defaultCtx();
    const claims = [
      { claimKey: 'c1', text: '结论一', severity: 'high', evidenceIds: [IDS.evA] },
      { claimKey: 'c2', text: '结论二', severity: 'low', evidenceIds: [IDS.evB] },
    ];
    expect(
      processVerification(
        draftJson([], claims, [{ positions: conflictItem().positions, claimKeys: ['c1', 'c2'] }]),
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      processVerification(
        draftJson([], claims, [
          {
            topic: 't',
            positions: [{ positionText: 'x', sourceRefs: [IDS.candA], extra: 1 }],
            claimKeys: ['c1', 'c2'],
          },
        ]),
        ctx,
      ).ok,
    ).toBe(false);
  });

  it('topic/positionText：非串/清理后为空/超长 → 拒绝', () => {
    const { ctx } = defaultCtx();
    const claims = [
      { claimKey: 'c1', text: '结论一', severity: 'high', evidenceIds: [IDS.evA] },
      { claimKey: 'c2', text: '结论二', severity: 'low', evidenceIds: [IDS.evB] },
    ];
    expect(
      processVerification(
        draftJson([], claims, [conflictItem({ topic: 'x'.repeat(MAX_CONFLICT_TOPIC_CHARS + 1) })]),
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      processVerification(draftJson([], claims, [conflictItem({ topic: '  ' })]), ctx).ok,
    ).toBe(false);
    const badPosition = {
      topic: 't',
      positions: [
        { positionText: 'x'.repeat(MAX_CONFLICT_POSITION_CHARS + 1), sourceRefs: [IDS.candA] },
        { positionText: '立场乙', sourceRefs: [IDS.candB] },
      ],
      claimKeys: ['c1', 'c2'],
    };
    expect(processVerification(draftJson([], claims, [badPosition]), ctx).ok).toBe(false);
  });

  it('positions/sourceRefs/claimKeys 数量边界 → 拒绝', () => {
    const { ctx } = defaultCtx();
    const claims = [
      { claimKey: 'c1', text: '结论一', severity: 'high', evidenceIds: [IDS.evA] },
      { claimKey: 'c2', text: '结论二', severity: 'low', evidenceIds: [IDS.evB] },
    ];
    const mkPositions = (n: number): unknown[] =>
      Array.from({ length: n }, (_, i) => ({
        positionText: `立场${i}`,
        sourceRefs: [IDS.candA],
      }));
    // positions 少于 2 / 超上限
    expect(
      processVerification(draftJson([], claims, [conflictItem({ positions: mkPositions(1) })]), ctx)
        .ok,
    ).toBe(false);
    expect(
      processVerification(
        draftJson([], claims, [
          conflictItem({ positions: mkPositions(MAX_CONFLICT_POSITIONS + 1) }),
        ]),
        ctx,
      ).ok,
    ).toBe(false);
    // sourceRefs 空/超上限
    const emptyRefs = conflictItem();
    (emptyRefs.positions as Record<string, unknown>[])[0]!['sourceRefs'] = [];
    expect(processVerification(draftJson([], claims, [emptyRefs]), ctx).ok).toBe(false);
    const overRefs = conflictItem();
    (overRefs.positions as Record<string, unknown>[])[0]!['sourceRefs'] = Array(
      MAX_CONFLICT_POSITION_SOURCE_REFS + 1,
    ).fill(IDS.candA);
    expect(processVerification(draftJson([], claims, [overRefs]), ctx).ok).toBe(false);
    // claimKeys 少于 2/超上限/重复
    expect(
      processVerification(draftJson([], claims, [conflictItem({ claimKeys: ['c1'] })]), ctx).ok,
    ).toBe(false);
    expect(
      processVerification(
        draftJson([], claims, [
          conflictItem({ claimKeys: Array(MAX_CONFLICT_CLAIM_REFS + 1).fill('c1') }),
        ]),
        ctx,
      ).ok,
    ).toBe(false);
    expect(
      processVerification(draftJson([], claims, [conflictItem({ claimKeys: ['c1', 'c1'] })]), ctx)
        .ok,
    ).toBe(false);
  });
});

// —— 二、Claim 确定性装配（决议 #143） ——

describe('Claim 确定性装配（决议 #143）', () => {
  it('coverage 按不同 canonicalKey 数计算：≥2 → multi-source；同 key/同候选多证据仍是 single-source', () => {
    // 双 canonicalKey → multi-source
    const a = defaultCtx();
    const multi = processVerification(
      draftJson([], [claimItem({ evidenceIds: [IDS.evA, IDS.evB] })]),
      a.ctx,
    );
    expect(multi.ok).toBe(true);
    if (multi.ok) expect(multi.claims[0]!.coverage).toBe('multi-source');

    // 同一 canonicalKey 的不同候选（origin+page 同键）→ single-source
    const sameKey = [
      makeCandidate({
        id: IDS.candA,
        url: 'https://a.example/p',
        canonicalKey: 'https://a.example/p',
      }),
      makeCandidate({
        id: IDS.candB,
        url: 'https://a.example/p',
        canonicalKey: 'https://a.example/p',
      }),
    ];
    const evs = [
      makeEvidence({ evidenceId: IDS.evA, candidateId: IDS.candA }),
      makeEvidence({ evidenceId: IDS.evB, candidateId: IDS.candB }),
    ];
    const out = processVerification(
      draftJson([], [claimItem({ evidenceIds: [IDS.evA, IDS.evB] })]),
      { taskId: TASK_ID, candidates: sameKey, evidence: evs, createId: makeSeqFactory([]) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.claims[0]!.coverage).toBe('single-source');

    // 同一候选两条证据 → single-source（不得按 Evidence 条数冒充多源）
    const sameCand = [
      makeCandidate({
        id: IDS.candA,
        url: 'https://a.example/p',
        canonicalKey: 'https://a.example/p',
      }),
    ];
    const evsSame = [
      makeEvidence({ evidenceId: IDS.evA, candidateId: IDS.candA }),
      makeEvidence({ evidenceId: IDS.evB, candidateId: IDS.candA, captureId: 'cap-2' }),
    ];
    const out2 = processVerification(
      draftJson([], [claimItem({ evidenceIds: [IDS.evA, IDS.evB] })]),
      { taskId: TASK_ID, candidates: sameCand, evidence: evsSame, createId: makeSeqFactory([]) },
    );
    expect(out2.ok).toBe(true);
    if (out2.ok) expect(out2.claims[0]!.coverage).toBe('single-source');
  });

  it('evidenceIds 不存在于 ctx.evidence / 属于其他任务 → 整份拒绝', () => {
    const { ctx } = defaultCtx();
    expect(
      processVerification(draftJson([], [claimItem({ evidenceIds: ['no-such-ev'] })]), ctx).ok,
    ).toBe(false);
    const otherTask = [
      makeEvidence({ evidenceId: IDS.evA, candidateId: IDS.candA, taskId: 'other-task' }),
    ];
    const out = processVerification(draftJson([], [claimItem({ evidenceIds: [IDS.evA] })]), {
      ...ctx,
      evidence: otherTask,
    });
    expect(out.ok).toBe(false);
  });

  it('Evidence 关联的候选不在 ctx.candidates → 整份拒绝（错绑）', () => {
    const { ctx, evidence } = defaultCtx();
    const brokenEvidence = [
      makeEvidence({ evidenceId: IDS.evA, candidateId: 'no-such-candidate' }),
    ];
    const out = processVerification(draftJson([], [claimItem({ evidenceIds: [IDS.evA] })]), {
      ...ctx,
      evidence: brokenEvidence,
    });
    expect(out.ok).toBe(false);
    void evidence;
  });

  it('sourceTypes 判定矩阵：trust null → third-party；community → community', () => {
    const t = defaultCtx();
    // search 命中 trust=null → third-party
    const outNull = processVerification(
      draftJson([], [claimItem({ evidenceIds: [IDS.evA] })]),
      t.ctx,
    );
    expect(outNull.ok).toBe(true);
    if (outNull.ok) expect(outNull.claims[0]!.sourceTypes).toEqual(['third-party']);

    // community → community
    const cands = [
      makeCandidate({
        id: IDS.candA,
        url: 'https://forum.example/t/1',
        trust: { value: 'community', assertedBy: 'user', verification: 'asserted' },
      }),
    ];
    const evs = [makeEvidence({ evidenceId: IDS.evA, candidateId: IDS.candA })];
    const out = processVerification(draftJson([], [claimItem({ evidenceIds: [IDS.evA] })]), {
      taskId: TASK_ID,
      candidates: cands,
      evidence: evs,
      createId: makeSeqFactory([]),
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.claims[0]!.sourceTypes).toEqual(['community']);
  });

  it('vendor 判定：official 且 origin 命中 vendorCandidateIds 推导集合 → vendor', () => {
    const cands = [
      makeCandidate({
        id: IDS.candA,
        url: 'https://vendor.example/docs/a',
        canonicalKey: 'https://vendor.example/docs/a',
        trust: { value: 'official', assertedBy: 'user', verification: 'asserted' },
      }),
    ];
    const evs = [makeEvidence({ evidenceId: IDS.evA, candidateId: IDS.candA })];
    const out = processVerification(
      draftJson([IDS.candA], [claimItem({ evidenceIds: [IDS.evA] })]),
      { taskId: TASK_ID, candidates: cands, evidence: evs, createId: makeSeqFactory([]) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.claims[0]!.sourceTypes).toEqual(['vendor']);
  });

  it('official 但不在 vendorCandidateIds / origin 未命中 → 保守 third-party（不洗白 trust）', () => {
    const official = (id: string, url: string): SourceCandidate =>
      makeCandidate({
        id,
        url,
        canonicalKey: url,
        trust: { value: 'official', assertedBy: 'user', verification: 'asserted' },
      });
    const cands = [official(IDS.candA, 'https://v.example/a')];
    const evs = [makeEvidence({ evidenceId: IDS.evA, candidateId: IDS.candA })];
    // official 但模型未提议任何厂商候选 → third-party
    const out1 = processVerification(draftJson([], [claimItem({ evidenceIds: [IDS.evA] })]), {
      taskId: TASK_ID,
      candidates: cands,
      evidence: evs,
      createId: makeSeqFactory([]),
    });
    expect(out1.ok).toBe(true);
    if (out1.ok) expect(out1.claims[0]!.sourceTypes).toEqual(['third-party']);

    // 厂商候选 origin 与证据来源 origin 不同 → third-party
    const vendorCand = official(IDS.candB, 'https://other.example/b');
    const out2 = processVerification(
      draftJson([IDS.candB], [claimItem({ evidenceIds: [IDS.evA] })]),
      {
        taskId: TASK_ID,
        candidates: [...cands, vendorCand],
        evidence: evs,
        createId: makeSeqFactory([]),
      },
    );
    expect(out2.ok).toBe(true);
    if (out2.ok) expect(out2.claims[0]!.sourceTypes).toEqual(['third-party']);
  });

  it('origin 判定按 origin 而非候选 ID：同厂商 origin 不同页面（未提议的官方页）→ vendor', () => {
    const official = (id: string, url: string): SourceCandidate =>
      makeCandidate({
        id,
        url,
        canonicalKey: url,
        trust: { value: 'official', assertedBy: 'user', verification: 'asserted' },
      });
    const cands = [
      official(IDS.candA, 'https://v.example/a'),
      official(IDS.candB, 'https://v.example/b'),
    ];
    const evs = [makeEvidence({ evidenceId: IDS.evB, candidateId: IDS.candB })];
    // 只提议 candA，但 candB 同 origin → vendor
    const out = processVerification(
      draftJson([IDS.candA], [claimItem({ evidenceIds: [IDS.evB] })]),
      {
        taskId: TASK_ID,
        candidates: cands,
        evidence: evs,
        createId: makeSeqFactory([]),
      },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.claims[0]!.sourceTypes).toEqual(['vendor']);
  });

  it('primary/secondary/unknown → third-party；多类别固定顺序 vendor→third-party→community 去重', () => {
    const cands = [
      makeCandidate({
        id: IDS.candA,
        url: 'https://v.example/a',
        trust: { value: 'official', assertedBy: 'user', verification: 'asserted' },
      }),
      makeCandidate({
        id: IDS.candB,
        url: 'https://t.example/b',
        trust: { value: 'primary', assertedBy: 'user', verification: 'asserted' },
      }),
      makeCandidate({
        id: IDS.candC,
        url: 'https://f.example/c',
        trust: { value: 'community', assertedBy: 'user', verification: 'asserted' },
      }),
    ];
    const evs = [
      makeEvidence({ evidenceId: IDS.evA, candidateId: IDS.candA }),
      makeEvidence({ evidenceId: IDS.evB, candidateId: IDS.candB }),
      makeEvidence({ evidenceId: IDS.evC, candidateId: IDS.candC }),
    ];
    // candA official 未提议 → third-party；顺序固定 vendor→third-party→community
    const out = processVerification(
      draftJson([], [claimItem({ evidenceIds: [IDS.evA, IDS.evB, IDS.evC] })]),
      { taskId: TASK_ID, candidates: cands, evidence: evs, createId: makeSeqFactory([]) },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.claims[0]!.sourceTypes).toEqual(['third-party', 'community']);

    // 提议 candA 为厂商 → vendor + community（固定顺序）
    const out2 = processVerification(
      draftJson([IDS.candA], [claimItem({ evidenceIds: [IDS.evA, IDS.evC] })]),
      { taskId: TASK_ID, candidates: cands, evidence: evs, createId: makeSeqFactory([]) },
    );
    expect(out2.ok).toBe(true);
    if (out2.ok) expect(out2.claims[0]!.sourceTypes).toEqual(['vendor', 'community']);
  });

  it('单源 high 保持 severity=high；coverage=single-source；singleSourceFields 程序标记「整条结论」', () => {
    const { ctx } = defaultCtx();
    const out = processVerification(
      draftJson([], [claimItem({ severity: 'high', evidenceIds: [IDS.evA] })]),
      ctx,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.claims[0]!.severity).toBe('high');
      expect(out.claims[0]!.coverage).toBe('single-source');
      expect(out.claims[0]!.singleSourceFields).toEqual(['整条结论']);
    }
    // 多源 → singleSourceFields 空
    const multi = processVerification(
      draftJson([], [claimItem({ severity: 'high', evidenceIds: [IDS.evA, IDS.evB] })]),
      ctx,
    );
    expect(multi.ok).toBe(true);
    if (multi.ok) {
      expect(multi.claims[0]!.coverage).toBe('multi-source');
      expect(multi.claims[0]!.singleSourceFields).toEqual([]);
    }
  });

  it('ID 分配：小写 v4 校验；非 v4/大写/重复/createId 抛错 → 整份拒绝且零半成品', () => {
    const { ctx } = defaultCtx();
    const claims = [claimItem({ evidenceIds: [IDS.evA] })];
    // 非 v4
    expect(
      processVerification(draftJson([], claims), { ...ctx, createId: () => 'not-a-uuid' }).ok,
    ).toBe(false);
    // 大写 v4
    expect(
      processVerification(draftJson([], claims), {
        ...ctx,
        createId: () => 'AAAAAAAA-AAAA-4AAA-8AAA-000000000001',
      }).ok,
    ).toBe(false);
    // 重复 ID
    const dup = makeSeqFactory([IDS.candA, IDS.candA]);
    expect(
      processVerification(
        draftJson([], [claims[0], claimItem({ claimKey: 'c2', evidenceIds: [IDS.evB] })]),
        {
          ...ctx,
          createId: dup,
        },
      ).ok,
    ).toBe(false);
    // createId 抛错 → 安全拒绝
    expect(
      processVerification(draftJson([], claims), {
        ...ctx,
        createId: () => {
          throw new Error('boom');
        },
      }).ok,
    ).toBe(false);
    // claim 与 conflict ID 互相重复
    const claimConflictDup = makeSeqFactory([
      'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
      'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
      'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', // conflict 复用 claim2 的 ID
    ]);
    const out = processVerification(validDraft(), { ...ctx, createId: claimConflictDup });
    expect(out.ok).toBe(false);
  });

  it('返回顺序保持模型 proposal 顺序；输入零修改；同输入输出确定性', () => {
    const { ctx, candidates, evidence } = defaultCtx();
    const raw = draftJson(
      [],
      [
        { claimKey: 'second', text: '第二条', severity: 'low', evidenceIds: [IDS.evB] },
        { claimKey: 'first', text: '第一条', severity: 'high', evidenceIds: [IDS.evA, IDS.evB] },
      ],
    );
    const candidatesBefore = JSON.stringify(candidates);
    const evidenceBefore = JSON.stringify(evidence);
    const ctxBefore = JSON.stringify({ ...ctx, createId: undefined });
    const makeCtx = () => ({
      taskId: TASK_ID,
      candidates,
      evidence,
      createId: makeSeqFactory([
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000002',
      ]),
    });
    const out1 = processVerification(raw, makeCtx());
    const out2 = processVerification(raw, makeCtx());
    expect(out1.ok && out2.ok).toBe(true);
    if (out1.ok && out2.ok) {
      expect(out1.claims.map((c) => c.text)).toEqual(['第二条', '第一条']);
      expect(out1.claims.map((c) => c.claimId)).toEqual(out2.claims.map((c) => c.claimId));
      expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
    }
    // 输入零修改
    expect(JSON.stringify(candidates)).toBe(candidatesBefore);
    expect(JSON.stringify(evidence)).toBe(evidenceBefore);
    expect(JSON.stringify({ ...ctx, createId: undefined })).toBe(ctxBefore);
  });
});

// —— 三、Conflict 引用完整性（决议 #144） ——

describe('Conflict 引用完整性（决议 #144）', () => {
  it('局部 claimKeys → 程序 claimIds；resolved 恒 unresolved；双向 conflictIds 一致', () => {
    const { ctx } = defaultCtx();
    const out = processVerification(validDraft(), {
      ...ctx,
      createId: makeSeqFactory([
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000001', // claim1
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000002', // claim2
        'aaaaaaaa-aaaa-4aaa-8aaa-000000000003', // conflict1
      ]),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [c1, c2] = out.claims as [Claim, Claim];
    const [conflict] = out.conflicts as [Conflict];
    expect(conflict.claimIds).toEqual([c1.claimId, c2.claimId]);
    expect(conflict.resolved).toBe('unresolved');
    expect(conflict.taskId).toBe(TASK_ID);
    expect(c1.conflictIds).toEqual([conflict.conflictId]);
    expect(c2.conflictIds).toEqual([conflict.conflictId]);
    // sourceRefs 与 positions 保留模型顺序
    expect(conflict.positions.map((p) => p.sourceRefs[0])).toEqual([IDS.candA, IDS.candB]);
  });

  it('悬空 claimKey → 整份拒绝', () => {
    const { ctx } = defaultCtx();
    const raw = JSON.parse(validDraft()) as {
      conflicts: Array<{ claimKeys: string[] }>;
    };
    raw.conflicts[0]!.claimKeys = ['c1', 'no-such-key'];
    expect(processVerification(JSON.stringify(raw), ctx).ok).toBe(false);
  });

  it('同一位置复制（规范化后重复 positionText）→ 整份拒绝', () => {
    const { ctx } = defaultCtx();
    const raw = JSON.parse(validDraft()) as {
      conflicts: Array<{ positions: Array<Record<string, unknown>> }>;
    };
    raw.conflicts[0]!.positions = [
      { positionText: '立场甲', sourceRefs: [IDS.candA] },
      { positionText: ' 立场甲 ', sourceRefs: [IDS.candB] }, // 规范化后与前者相同
    ];
    expect(processVerification(JSON.stringify(raw), ctx).ok).toBe(false);
  });

  it('sourceRefs 引用未知候选 → 拒绝；候选无 VerifiedEvidence 支撑 → 拒绝', () => {
    const { ctx } = defaultCtx();
    // 未知候选
    const unknown = JSON.parse(validDraft()) as {
      conflicts: Array<{ positions: Array<{ sourceRefs: string[] }> }>;
    };
    unknown.conflicts[0]!.positions[0]!['sourceRefs'] = ['no-such-candidate'];
    expect(processVerification(JSON.stringify(unknown), ctx).ok).toBe(false);

    // 候选存在但无 VerifiedEvidence 支撑（candB 的 Evidence 移除）
    const noSupportCtx = {
      ...ctx,
      evidence: ctx.evidence.filter((e) => e.candidateId !== IDS.candB),
    };
    expect(processVerification(validDraft(), noSupportCtx).ok).toBe(false);
  });

  it('sourceRefs 必须落在引用 Claims 的 Evidence 来源并集内 → 越界拒绝', () => {
    // 三个候选：candC 有 Evidence，但 conflict 引用的 claims 只用 candA/candB 的证据
    const candidates = [
      makeCandidate({
        id: IDS.candA,
        url: 'https://a.example/p1',
        canonicalKey: 'https://a.example/p1',
      }),
      makeCandidate({
        id: IDS.candB,
        url: 'https://a.example/p2',
        canonicalKey: 'https://a.example/p2',
      }),
      makeCandidate({
        id: IDS.candC,
        url: 'https://a.example/p3',
        canonicalKey: 'https://a.example/p3',
      }),
    ];
    const evidence = [
      makeEvidence({ evidenceId: IDS.evA, candidateId: IDS.candA }),
      makeEvidence({ evidenceId: IDS.evB, candidateId: IDS.candB }),
      makeEvidence({ evidenceId: IDS.evC, candidateId: IDS.candC }),
    ];
    const raw = JSON.parse(validDraft()) as {
      conflicts: Array<{ positions: Array<{ sourceRefs: string[] }> }>;
    };
    raw.conflicts[0]!.positions[1]!['sourceRefs'] = [IDS.candC]; // 不在 {candA,candB} 并集内
    const out = processVerification(JSON.stringify(raw), {
      taskId: TASK_ID,
      candidates,
      evidence,
      createId: makeSeqFactory([]),
    });
    expect(out.ok).toBe(false);
  });

  it('整个 Conflict 至少覆盖两个不同 canonicalKey → 单源拒绝', () => {
    const { ctx } = defaultCtx();
    // 两个 claim 都只引用 candA 的证据（单 canonicalKey）
    const raw = draftJson(
      [],
      [
        { claimKey: 'c1', text: '结论一', severity: 'high', evidenceIds: [IDS.evA] },
        { claimKey: 'c2', text: '结论二', severity: 'low', evidenceIds: [IDS.evA] },
      ],
      [
        {
          topic: '冲突主题',
          positions: [
            { positionText: '立场甲', sourceRefs: [IDS.candA] },
            { positionText: '立场乙', sourceRefs: [IDS.candA] },
          ],
          claimKeys: ['c1', 'c2'],
        },
      ],
    );
    expect(processVerification(raw, ctx).ok).toBe(false);
  });

  it('跨任务 Evidence：sourceRefs 的支撑 Evidence 必须属于当前任务', () => {
    const { ctx } = defaultCtx();
    const otherTaskEvidence = [
      makeEvidence({ evidenceId: IDS.evA, candidateId: IDS.candA, taskId: 'other-task' }),
      makeEvidence({ evidenceId: IDS.evB, candidateId: IDS.candB }),
    ];
    expect(processVerification(validDraft(), { ...ctx, evidence: otherTaskEvidence }).ok).toBe(
      false,
    );
  });
});

// —— 四、processVerification 健壮性（FT-17） ——

describe('processVerification 健壮性（FT-17）', () => {
  it('任意 hostile input 安全返回不抛异常（深嵌套/原型链键/超长嵌套数组）', () => {
    const { ctx } = defaultCtx();
    const deep = (n: number): unknown => (n === 0 ? 'x' : { a: deep(n - 1) });
    const hostile: string[] = [
      JSON.stringify({ __proto__: { claims: [] }, claims: [], conflicts: [] }),
      JSON.stringify({ vendorCandidateIds: [], claims: [deep(30)], conflicts: [] }),
      JSON.stringify({ vendorCandidateIds: [deep(20)], claims: [], conflicts: [] }),
      JSON.stringify(draftJson([], [], [Array(MAX_CONFLICT_POSITIONS).fill(deep(10))])),
      '{"vendorCandidateIds":[],"claims":[],"conflicts":[],"x":1,"y":2}',
      JSON.stringify({ vendorCandidateIds: [], claims: Array(100).fill(null), conflicts: [] }),
    ];
    for (const raw of hostile) {
      let threw = false;
      let result: { ok: boolean; reason?: string } | null = null;
      try {
        result = processVerification(raw, ctx) as { ok: boolean; reason?: string };
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(result).not.toBeNull();
      if (result !== null && !result.ok) {
        expect(typeof result.reason).toBe('string');
        expect(result.reason!.length).toBeLessThanOrEqual(MAX_RESEARCH_REASON_CHARS);
      }
    }
  });
});

// —— 五、parseResultDraft（决议 #147） ——

describe('parseResultDraft（决议 #147）', () => {
  it('合法：{result:…} → ok 且 draft = parsed.result（含任意值形态）', () => {
    const resultObj = { title: '结果', blocks: [] };
    const out = parseResultDraft(JSON.stringify({ result: resultObj }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.draft).toStrictEqual(resultObj);
    for (const value of [null, 'str', 42, [1, 2]]) {
      const o = parseResultDraft(JSON.stringify({ result: value }));
      expect(o.ok).toBe(true);
      if (o.ok) expect(o.draft).toStrictEqual(value);
    }
  });

  it('拒绝：非串/非 JSON/fence/前后文本', () => {
    for (const raw of [
      '',
      'x',
      '{',
      '```json\n{"result":{}}\n```',
      '好的 {"result":{}}',
      '{"result":{}} 完成',
      '{"result":{}'.slice(0, 14),
    ]) {
      expect(parseResultDraft(raw as never).ok).toBe(false);
    }
  });

  it('拒绝：顶层非对象/未知顶层字段/缺失 result', () => {
    for (const raw of ['[]', '"x"', '42', '{"result":{},"extra":1}', '{}', '{"other":1}']) {
      expect(parseResultDraft(raw).ok).toBe(false);
    }
  });

  it('hostile 超长 raw 安全拒绝；reason ≤ MAX_RESEARCH_REASON_CHARS 中文', () => {
    const huge = JSON.stringify({ result: { pad: 'x'.repeat(400_000) } });
    const out = parseResultDraft(huge);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason.length).toBeGreaterThan(0);
      expect(out.reason.length).toBeLessThanOrEqual(MAX_RESEARCH_REASON_CHARS);
      expect(out.reason).not.toContain('xxxx');
    }
  });
});

// —— 六、端口对象（决议 #142/#147 形状） ——

describe('RESEARCH_SYNTHESIS_PORT（决议 #134 形状）', () => {
  it('冻结只读；processVerification/parseResultDraft 为模块纯函数', () => {
    expect(Object.isFrozen(RESEARCH_SYNTHESIS_PORT)).toBe(true);
    expect(RESEARCH_SYNTHESIS_PORT.processVerification).toBe(processVerification);
    expect(RESEARCH_SYNTHESIS_PORT.parseResultDraft).toBe(parseResultDraft);
  });
});
