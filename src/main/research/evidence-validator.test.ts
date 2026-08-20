// C4 evidence-validator tests（决议 #129/#130）：不可信 proposal 六字段白名单、
// 归属/来源/内容验证顺序、多表 tableIndex 精确区分、header 程序生成与一致性、
// 闭合字段路径白名单（原型链键/通配符恒拒绝）、rejected 不产生 Evidence、幂等。
import { describe, expect, it } from 'vitest';
import type { Capture, SourceCandidate, VerifiedEvidence } from '../../shared/types/research';
import {
  MAX_EVIDENCE_EXCERPT_CHARS,
  MAX_EVIDENCE_FIELD_VALUE_CHARS,
} from '../../shared/types/research';
import type { PageSnapshot } from '../../shared/types/browser';
import { normalizeSnapshot } from '../browser/snapshot-normalize';
import { verifyEvidence, REJECTION_REASONS, type EvidenceVerifyInput } from './evidence-validator';
import {
  buildCaptureContent,
  normalizeCaptureText,
  type CaptureContent,
  type CaptureTable,
} from './capture-service';

const TASK_ID = 'task-00000000-0000-4000-8000-000000000001';
const EVIDENCE_ID = 'evid-00000000-0000-4000-8000-000000000001';
const CAPTURE_ID = 'capt-00000000-0000-4000-8000-000000000001';
const CANDIDATE_ID = 'cand-00000000-0000-4000-8000-000000000001';
const DOCUMENT_ID = '7';

function makeCapture(over: Partial<Capture> = {}): Capture {
  return {
    captureId: CAPTURE_ID,
    taskId: TASK_ID,
    candidateId: CANDIDATE_ID,
    tabId: 'tab-1',
    url: 'https://example.com/article',
    title: '文章标题',
    accessTime: '2026-08-16T08:30:00.000Z',
    documentId: DOCUMENT_ID,
    contentHash: 'hash-0123456789abcdef0123456789abcdef',
    summary: { sectionCount: 3, tableCount: 2, headingCount: 1, charCount: 200 },
    failed: false,
    failureReason: null,
    ...over,
  };
}

function makeCandidate(over: Partial<SourceCandidate> = {}): SourceCandidate {
  return {
    id: CANDIDATE_ID,
    url: 'https://example.com/article',
    displayUrl: 'https://example.com/article',
    title: '候选标题',
    canonicalKey: 'https://example.com/article',
    scope: 'page',
    discoveredVia: ['sources'],
    sourceId: 'source-1',
    trust: { value: 'unknown', assertedBy: 'ai', verification: 'unverified' },
    priority: null,
    lastUsedAt: null,
    note: null,
    sortKey:
      '01|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|https://example.com/article|cand-00000000-0000-4000-8000-000000000001',
    ...over,
  };
}

function makeTable(headers: string[], rows: string[][]): CaptureTable {
  return { headers, rows };
}

// 两个表格的 [0][0] 相同（甲/丙），唯 tableIndex 可区分——决议 #129 核心场景
function makeContent(over: Partial<CaptureContent> = {}): CaptureContent {
  return {
    captureId: CAPTURE_ID,
    canonicalText:
      '[text] 第一段正文。\n[text] 第二段正文。\n[heading] 主标题\n[table] 名称|价格|甲|100|乙|200\n[table] 名称|价格|丙|300|丁|400\n[link] 示例链接 https://example.com/other\n[field] page.url=https://example.com/article\n',
    textSections: ['第一段正文。', '第二段正文。', '主标题'],
    tables: [
      makeTable(
        ['名称', '价格'],
        [
          ['甲', '100'],
          ['乙', '200'],
        ],
      ),
      makeTable(
        ['名称', '价格'],
        [
          ['丙', '300'],
          ['丁', '400'],
        ],
      ),
    ],
    fields: {
      'page.url': 'https://example.com/article',
      'page.title': '文章标题',
      'headings[0].text': '主标题',
      'links[0].text': '示例链接',
      'links[0].href': 'https://example.com/other',
      'tables[0].cell[0][0]': '甲',
      'tables[0].cell[0][1]': '100',
      'tables[1].cell[0][0]': '丙',
      'tables[1].cell[0][1]': '300',
    },
    ...over,
  };
}

function makeInput(
  over: {
    proposal?: unknown;
    evidenceId?: string;
    taskId?: string;
    captures?: Capture[];
    candidates?: SourceCandidate[];
    contents?: Map<string, CaptureContent>;
  } = {},
): EvidenceVerifyInput {
  return {
    // null 提案是合法敌手输入（不得被 ?? 替换为默认提案）
    proposal:
      over.proposal !== undefined
        ? over.proposal
        : {
            captureId: CAPTURE_ID,
            candidateId: CANDIDATE_ID,
            type: 'quote',
            locator: { kind: 'text', excerpt: '第一段正文。' },
            excerpt: '第一段正文。',
            value: null,
          },
    evidenceId: over.evidenceId ?? EVIDENCE_ID,
    taskId: over.taskId ?? TASK_ID,
    captures: over.captures ?? [makeCapture()],
    candidates: over.candidates ?? [makeCandidate()],
    contents: over.contents ?? new Map([[CAPTURE_ID, makeContent()]]),
  };
}

function expectRejected(result: ReturnType<typeof verifyEvidence>, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason.length).toBeLessThanOrEqual(200);
    expect('evidence' in result).toBe(false); // rejected 不是 Evidence
  }
}

describe('EvidenceValidator.verify（决议 #130 校验顺序）', () => {
  it('quote 正确引用 → verified；evidenceId 取可信上下文、provenance 全部从 Capture/候选取', () => {
    const result = verifyEvidence(makeInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ev: VerifiedEvidence = result.evidence;
    expect(ev.evidenceId).toBe(EVIDENCE_ID);
    expect(ev.taskId).toBe(TASK_ID);
    expect(ev.captureId).toBe(CAPTURE_ID);
    expect(ev.candidateId).toBe(CANDIDATE_ID);
    expect(ev.sourceId).toBe('source-1'); // 从候选取
    expect(ev.url).toBe('https://example.com/article'); // 从 Capture 取（模型不可伪造）
    expect(ev.title).toBe('文章标题');
    expect(ev.accessTime).toBe('2026-08-16T08:30:00.000Z');
    expect(ev.documentId).toBe(DOCUMENT_ID);
    expect(ev.contentHash).toBe('hash-0123456789abcdef0123456789abcdef');
    expect(ev.type).toBe('quote');
    expect(ev.locator).toEqual({ kind: 'text', excerpt: '第一段正文。' });
    expect(ev.excerpt).toBe('第一段正文。');
    expect(ev.value).toBeNull();
    expect(ev.verification).toBe('verified');
  });

  it('summary-point 同 quote 语义（text locator，value 必须 null）', () => {
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'summary-point',
          locator: { kind: 'text', excerpt: '第二段正文。' },
          excerpt: '第二段正文。',
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('规范化等价：proposal 摘录含空白/控制/bidi 字符 → 规范化后与 locator/内容一致 → verified', () => {
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: '‮第一段正文。‍  ' },
          excerpt: '\t第一段正文。\n',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 落库摘录为规范化片段
    expect(result.evidence.excerpt).toBe('第一段正文。');
  });

  it('伪造摘录（不在捕获内容）→ excerpt-not-in-content', () => {
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: '不存在的文本' },
          excerpt: '不存在的文本',
        },
      }),
    );
    expectRejected(result, 'excerpt-not-in-content');
  });

  it('超预算正文尾部不可作为证据（未进入 contentHash 覆盖）', () => {
    // visibleText: the first 60k are "长", the last 10k are "尾" — the "尾" run exists in the raw input but is beyond the 60k budget
    const visibleText = '长'.repeat(60_000) + '尾'.repeat(10_000);
    const snapshot: PageSnapshot = {
      url: 'https://example.com/article',
      title: '标题',
      visibleText,
      headings: [],
      links: [],
      tables: [],
      buttons: [],
      meta: {
        capturedAt: Date.parse('2026-08-16T08:30:00.000Z'),
        documentId: 7,
        readyState: 'complete',
        degraded: 'none',
        warnings: [],
      },
    };
    const content = buildCaptureContent(snapshot, CAPTURE_ID);
    // tailExcerpt is the "尾" character run from the raw snapshot (outside the budget); the old implementation wrongly accepted it
    const tailExcerpt = '尾'.repeat(100);
    const result = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, content]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: tailExcerpt },
          excerpt: tailExcerpt,
        },
      }),
    );
    expectRejected(result, 'excerpt-not-in-content');
  });

  it('跨 section 拼接摘录 → excerpt-not-in-content（禁拼接）', () => {
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: '第一段正文。第二段正文。' }, // 两 section 拼接
          excerpt: '第一段正文。第二段正文。',
        },
      }),
    );
    expectRejected(result, 'excerpt-not-in-content');
  });

  it('空摘录 → excerpt-invalid', () => {
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: '   ' },
          excerpt: '   ',
        },
      }),
    );
    expectRejected(result, 'excerpt-invalid');
  });

  it('超长摘录（>MAX_EVIDENCE_EXCERPT_CHARS）→ proposal-invalid（形状阶段拒绝）', () => {
    const long = '文'.repeat(MAX_EVIDENCE_EXCERPT_CHARS + 1);
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: long },
          excerpt: long,
        },
      }),
    );
    expectRejected(result, 'proposal-invalid');
  });

  it('locator.excerpt 与 proposal.excerpt 不一致 → excerpt-invalid', () => {
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: '第一段正文。' },
          excerpt: '第二段正文。',
        },
      }),
    );
    expectRejected(result, 'excerpt-invalid');
  });

  it('错 task（capture.taskId ≠ taskId）→ capture-not-found（跨任务引用拒绝）', () => {
    const result = verifyEvidence(
      makeInput({
        taskId: 'task-other',
        captures: [makeCapture()],
      }),
    );
    expectRejected(result, 'capture-not-found');
  });

  it('captureId 不存在 → capture-not-found', () => {
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: 'capture-9999',
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: '第一段正文。' },
          excerpt: '第一段正文。',
        },
      }),
    );
    expectRejected(result, 'capture-not-found');
  });

  it('failed capture → capture-failed（sentinel 先拒，绝不组装进 Evidence）', () => {
    const failedCapture = makeCapture({
      failed: true,
      failureReason: 'page-load-failed',
      tabId: 'unallocated',
      documentId: 'unavailable',
    });
    const result = verifyEvidence(
      makeInput({
        captures: [failedCapture],
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: 'unallocated' }, // 内容匹配也拒绝
          excerpt: 'unallocated',
        },
      }),
    );
    expectRejected(result, 'capture-failed');
  });

  it('candidateId 不存在 → candidate-mismatch', () => {
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: 'candidate-9999',
          type: 'quote',
          locator: { kind: 'text', excerpt: '第一段正文。' },
          excerpt: '第一段正文。',
        },
      }),
    );
    expectRejected(result, 'candidate-mismatch');
  });

  it('capture.candidateId 与 proposal.candidateId 不一致 → candidate-mismatch（错绑）', () => {
    const otherCandidate = makeCandidate({ id: 'cand-other' });
    const result = verifyEvidence(
      makeInput({
        candidates: [otherCandidate],
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: 'cand-other',
          type: 'quote',
          locator: { kind: 'text', excerpt: '第一段正文。' },
          excerpt: '第一段正文。',
        },
      }),
    );
    expectRejected(result, 'candidate-mismatch');
  });

  it('CaptureContent 缺失 → content-missing', () => {
    const result = verifyEvidence(makeInput({ contents: new Map() }));
    expectRejected(result, 'content-missing');
  });

  it('内容绑定错位（map 里 captureId 不匹配）→ content-missing', () => {
    const result = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, makeContent({ captureId: 'capture-other' })]]),
      }),
    );
    expectRejected(result, 'content-missing');
  });

  it('模型伪造 trusted metadata（proposal 带 taskId/url/verification/evidenceId 等未知字段）→ proposal-invalid', () => {
    for (const extra of [
      { taskId: TASK_ID },
      { url: 'https://evil.example.com/' },
      { verification: 'verified' },
      { evidenceId: EVIDENCE_ID },
      { accessTime: '2026-01-01T00:00:00.000Z' },
    ]) {
      const result = verifyEvidence(
        makeInput({
          proposal: {
            captureId: CAPTURE_ID,
            candidateId: CANDIDATE_ID,
            type: 'quote',
            locator: { kind: 'text', excerpt: '第一段正文。' },
            excerpt: '第一段正文。',
            ...extra,
          },
        }),
      );
      expectRejected(result, 'proposal-invalid');
    }
  });

  it('type-locator 组合非法 → proposal-invalid（quote+table / table-cell+text / quote+value 非 null）', () => {
    const cases: unknown[] = [
      {
        captureId: CAPTURE_ID,
        candidateId: CANDIDATE_ID,
        type: 'quote',
        locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: null },
        value: '甲',
      },
      {
        captureId: CAPTURE_ID,
        candidateId: CANDIDATE_ID,
        type: 'table-cell',
        locator: { kind: 'text', excerpt: '第一段正文。' },
        excerpt: '第一段正文。',
      },
      {
        captureId: CAPTURE_ID,
        candidateId: CANDIDATE_ID,
        type: 'quote',
        locator: { kind: 'text', excerpt: '第一段正文。' },
        excerpt: '第一段正文。',
        value: '不该有 value',
      },
      { captureId: CAPTURE_ID, candidateId: CANDIDATE_ID, type: 'unknown-kind' },
      'not-an-object',
      null,
    ];
    for (const proposal of cases) {
      expectRejected(verifyEvidence(makeInput({ proposal })), 'proposal-invalid');
    }
  });
});

describe('EvidenceValidator 多表 tableIndex（决议 #129）', () => {
  function tableProposal(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      captureId: CAPTURE_ID,
      candidateId: CANDIDATE_ID,
      type: 'table-cell',
      locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: null },
      excerpt: '甲',
      value: '甲',
      ...over,
    };
  }

  it('多表相同 row/col 由 tableIndex 精确区分（tableIndex=0 → 甲；tableIndex=1 → 丙）', () => {
    const r0 = verifyEvidence(
      makeInput({ proposal: tableProposal({ excerpt: '甲', value: '甲' }) }),
    );
    expect(r0.ok).toBe(true);
    if (r0.ok)
      expect(r0.evidence.locator).toEqual({
        kind: 'table',
        tableIndex: 0,
        row: 0,
        col: 0,
        header: '名称',
      });
    const r1 = verifyEvidence(
      makeInput({
        proposal: tableProposal({
          locator: { kind: 'table', tableIndex: 1, row: 0, col: 0, header: null },
          excerpt: '丙',
          value: '丙',
        }),
      }),
    );
    expect(r1.ok).toBe(true);
    if (r1.ok)
      expect(r1.evidence.locator).toEqual({
        kind: 'table',
        tableIndex: 1,
        row: 0,
        col: 0,
        header: '名称',
      });
  });

  it('tableIndex 越界/负数/非整数/字符串/缺失 → 拒绝', () => {
    const cases: Array<[unknown, string]> = [
      [{ kind: 'table', tableIndex: 2, row: 0, col: 0, header: null }, 'table-coordinate-invalid'],
      [{ kind: 'table', tableIndex: -1, row: 0, col: 0, header: null }, 'proposal-invalid'],
      [{ kind: 'table', tableIndex: 1.5, row: 0, col: 0, header: null }, 'proposal-invalid'],
      [{ kind: 'table', tableIndex: '0', row: 0, col: 0, header: null }, 'proposal-invalid'],
      [{ kind: 'table', row: 0, col: 0, header: null }, 'proposal-invalid'],
      [{ kind: 'table', tableIndex: true, row: 0, col: 0, header: null }, 'proposal-invalid'],
    ];
    for (const [locator, code] of cases) {
      expectRejected(
        verifyEvidence(
          makeInput({ proposal: tableProposal({ locator, excerpt: '甲', value: '甲' }) }),
        ),
        code,
      );
    }
  });

  it('row/col 越界（row 指数据行不含 header）→ table-coordinate-invalid', () => {
    for (const [row, col] of [
      [2, 0],
      [0, 2],
      [5, 5],
    ] as const) {
      expectRejected(
        verifyEvidence(
          makeInput({
            proposal: tableProposal({
              locator: { kind: 'table', tableIndex: 0, row, col, header: null },
              excerpt: '甲',
              value: '甲',
            }),
          }),
        ),
        'table-coordinate-invalid',
      );
    }
  });

  it('单元格真实值与 proposal 不一致 → table-value-mismatch（value 与 excerpt 分别校验）', () => {
    expectRejected(
      verifyEvidence(
        makeInput({ proposal: tableProposal({ excerpt: '甲', value: '乙' }) }), // value 与真实值不一致
      ),
      'table-value-mismatch',
    );
    expectRejected(
      verifyEvidence(makeInput({ proposal: tableProposal({ excerpt: '乙', value: '甲' }) })),
      'table-value-mismatch',
    );
  });

  it('value/excerpt 二选一均可（另一个为 null）→ verified；输出 excerpt/value 均为受控真实值', () => {
    const r1 = verifyEvidence(
      makeInput({
        proposal: tableProposal({
          locator: { kind: 'table', tableIndex: 1, row: 1, col: 1, header: null },
          excerpt: '400',
          value: null,
        }),
      }),
    );
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.evidence.excerpt).toBe('400');
      expect(r1.evidence.value).toBe('400'); // 程序取真实单元格值
    }
  });

  it('proposal 提供非空 header 与真实表头一致 → verified；不一致 → table-header-mismatch', () => {
    const ok = verifyEvidence(
      makeInput({
        proposal: tableProposal({
          locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: '名称' },
          excerpt: '甲',
          value: '甲',
        }),
      }),
    );
    expect(ok.ok).toBe(true);
    expectRejected(
      verifyEvidence(
        makeInput({
          proposal: tableProposal({
            locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: '伪造表头' },
            excerpt: '甲',
            value: '甲',
          }),
        }),
      ),
      'table-header-mismatch',
    );
  });

  it('header 非法形状（数字/布尔/对象/数组）→ proposal-invalid（决议 #115 保持）', () => {
    for (const bad of [42, true, { name: 'x' }, ['名称']]) {
      expectRejected(
        verifyEvidence(
          makeInput({
            proposal: tableProposal({
              locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: bad },
              excerpt: '甲',
              value: '甲',
            }),
          }),
        ),
        'proposal-invalid',
      );
    }
  });

  it('无表头表格 → 输出 header 为 null', () => {
    const content = makeContent({
      tables: [
        makeTable([], [['无表头单元格']]),
        makeTable(
          ['名称', '价格'],
          [
            ['丙', '300'],
            ['丁', '400'],
          ],
        ),
      ],
      fields: {
        ...makeContent().fields,
        'tables[0].cell[0][0]': '无表头单元格',
      },
    });
    const result = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, content]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'table-cell',
          locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: null },
          excerpt: '无表头单元格',
          value: '无表头单元格',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.evidence.locator).toEqual({
        kind: 'table',
        tableIndex: 0,
        row: 0,
        col: 0,
        header: null,
      });
  });
});

describe('EvidenceValidator 字段路径（决议 #128/#130 闭合白名单）', () => {
  function fieldProposal(fieldPath: string, value: string): Record<string, unknown> {
    return {
      captureId: CAPTURE_ID,
      candidateId: CANDIDATE_ID,
      type: 'field',
      locator: { kind: 'field', fieldPath },
      excerpt: value,
      value,
    };
  }

  it('正确字段 → verified（value 与真实值一致）', () => {
    const result = verifyEvidence(makeInput({ proposal: fieldProposal('page.title', '文章标题') }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.excerpt).toBe('文章标题');
      expect(result.evidence.value).toBe('文章标题');
      expect(result.evidence.locator).toEqual({ kind: 'field', fieldPath: 'page.title' });
    }
  });

  it('固定索引表格字段路径 → verified', () => {
    const result = verifyEvidence(
      makeInput({ proposal: fieldProposal('tables[1].cell[0][1]', '300') }),
    );
    expect(result.ok).toBe(true);
  });

  it('fieldPath 不存在于闭合 map → field-path-invalid', () => {
    for (const path of [
      'page.author',
      'headings[1].text',
      'links[5].href',
      'tables[1].cell[9][9]',
      'arbitrary.path',
    ]) {
      expectRejected(
        verifyEvidence(makeInput({ proposal: fieldProposal(path, '文章标题') })),
        'field-path-invalid',
      );
    }
  });

  it('通配符/动态路径/原型链键 → field-path-invalid（恒拒绝）', () => {
    for (const path of [
      'tables[*].cell[0][0]',
      'tables[${i}].cell[0][0]',
      '__proto__',
      'constructor',
      'prototype',
      '__proto__.polluted',
      'constructor.prototype.polluted',
      'page.url.__proto__',
    ]) {
      expectRejected(
        verifyEvidence(makeInput({ proposal: fieldProposal(path, '任意') })),
        'field-path-invalid',
      );
    }
  });

  it('字段真实值与 proposal 不一致 → field-value-mismatch', () => {
    expectRejected(
      verifyEvidence(makeInput({ proposal: fieldProposal('page.title', '伪造标题') })),
      'field-value-mismatch',
    );
  });

  it('value 超预算（>MAX_EVIDENCE_FIELD_VALUE_CHARS）→ value-invalid', () => {
    const longValue = '值'.repeat(MAX_EVIDENCE_FIELD_VALUE_CHARS + 1);
    expectRejected(
      verifyEvidence(
        makeInput({
          proposal: fieldProposal('page.title', longValue),
        }),
      ),
      'value-invalid',
    );
  });
});

describe('EvidenceValidator 通用（决议 #130）', () => {
  it('rejected 结果不是 Evidence：不进集合语义（无 evidence 字段、无落库对象）', () => {
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: '伪造' },
          excerpt: '伪造',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result)).not.toContain('evidence');
      // reason 不回显正文/URL query/敌对字段
      expect(result.reason).not.toContain('伪造');
      expect(result.reason).not.toContain('example.com');
    }
  });

  it('幂等：相同上下文、相同可信 evidenceId、相同 proposal → 输出恒等', () => {
    const input = makeInput();
    const a = verifyEvidence(input);
    const b = verifyEvidence(input);
    expect(a).toEqual(b);
    const rejected = makeInput({
      proposal: {
        captureId: CAPTURE_ID,
        candidateId: CANDIDATE_ID,
        type: 'quote',
        locator: { kind: 'text', excerpt: '伪造' },
        excerpt: '伪造',
      },
    });
    expect(verifyEvidence(rejected)).toEqual(verifyEvidence(rejected));
  });

  it('reason 映射表完整：每个闭合错误码都有 ≤200 安全中文短句', () => {
    const keys = Object.keys(REJECTION_REASONS);
    expect(keys).toHaveLength(13);
    for (const value of Object.values(REJECTION_REASONS)) {
      expect(value.length).toBeGreaterThan(0);
      expect(value.length).toBeLessThanOrEqual(200);
    }
  });

  it('search 命中候选（sourceId=null）→ evidence.sourceId=null；Sources 命中 → 继承 sourceId', () => {
    const searchCandidate = makeCandidate({
      sourceId: null,
      discoveredVia: ['search'],
      trust: null,
    });
    const r1 = verifyEvidence(makeInput({ candidates: [searchCandidate] }));
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.evidence.sourceId).toBeNull();
    const r2 = verifyEvidence(makeInput());
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.evidence.sourceId).toBe('source-1');
  });

  it('摘录规范化等价后仍需是 section 连续子串（大小写不折叠、不模糊）', () => {
    const result = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'quote',
          locator: { kind: 'text', excerpt: '第一段正文' }, // 少了句号 → 仍是子串但 locator 与 excerpt 需一致
          excerpt: '第一段正文',
        },
      }),
    );
    expect(result.ok).toBe(true); // 子串成立
  });

  it('normalizeCaptureText 幂等性（校验依赖：规范化函数可复用于摘录比较）', () => {
    expect(normalizeCaptureText(normalizeCaptureText(' ‮文本‍  '))).toBe(
      normalizeCaptureText(' ‮文本‍  '),
    );
  });
});

describe('C4 Replan：跨 block 相同字面碰撞（canonical 子串不能伪造 table/field Evidence）', () => {
  it('R-EVIDENCE-COLLISION canonicalText 含 table 格式字面但无真实表格 → table Evidence 拒绝', () => {
    // visibleText literally contains '[table] 名称|价格|甲|100|乙|200' (entering
    // textSections as plain text), but the snapshot has no real tables →
    // content.tables is empty. A proposal referencing tableIndex=0 is rejected.
    const snap = normalizeSnapshot(
      {
        ok: true,
        url: 'https://example.com/article',
        title: '文章标题',
        visibleText: '[table] 名称|价格|甲|100|乙|200',
        headings: [],
        links: [],
        buttons: [],
        tables: [],
      },
      { url: 'https://example.com/article', title: '文章标题', documentId: 7 },
    );
    const content = buildCaptureContent(snap, CAPTURE_ID);
    // the literal did enter textSections (the canonical substring holds), but tables is empty
    expect(content.textSections.some((s) => s.includes('甲'))).toBe(true);
    expect(content.tables).toHaveLength(0);
    const result = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, content]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'table-cell',
          locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: null },
          excerpt: '甲',
          value: '甲',
        },
      }),
    );
    expectRejected(result, 'table-coordinate-invalid');
  });

  it('R-EVIDENCE-FIELD-COLLISION canonicalText 含 [field] 字面但 fields map 无该项 → field Evidence 拒绝', () => {
    // the snapshot has no heading/link and an empty title → fields has no
    // page.title; the page body happens to contain the literal
    // '[field] page.title=伪造标题' → field Evidence cannot be forged from a
    // canonical substring.
    const snap = normalizeSnapshot(
      {
        ok: true,
        url: 'https://example.com/article',
        title: ' ',
        visibleText: '[field] page.title=伪造标题',
        headings: [],
        links: [],
        buttons: [],
        tables: [],
      },
      { url: 'https://example.com/article', title: ' ', documentId: 7 },
    );
    const content = buildCaptureContent(snap, CAPTURE_ID);
    expect(content.textSections.some((s) => s.includes('page.title=伪造标题'))).toBe(true);
    expect('page.title' in content.fields).toBe(false);
    const result = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, content]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'field',
          locator: { kind: 'field', fieldPath: 'page.title' },
          excerpt: '伪造标题',
          value: '伪造标题',
        },
      }),
    );
    expectRejected(result, 'field-path-invalid');
  });
});

describe("C4 Repair B: empty table-cell fail-closed（决议 #173，realCell === '' → value-invalid）", () => {
  // Red-state oracle (baseline f38fb4d is fail-open): when the trusted real
  // cell normalizes to '' at valid coordinates, every excerpt/value combination
  // (including both null) must be value-invalid and no VerifiedEvidence may be
  // assembled. The empty-cell check happens before proposal matching.

  // A meaningful table with an explicitly empty cell (geometry kept, no field,
  // geometry covered by canonical).
  function emptyCellContent(): CaptureContent {
    return {
      captureId: CAPTURE_ID,
      canonicalText: '[table] A|B|x|\n',
      textSections: [],
      tables: [makeTable(['A', 'B'], [['x', '']])],
      fields: { 'tables[0].cell[0][0]': 'x' }, // empty cell: no field entry
    };
  }

  // Real normalize path: a short row is padded with '' by normalize
  function paddingCellContent(): CaptureContent {
    const snap = normalizeSnapshot(
      {
        ok: true,
        url: 'https://example.com/article',
        title: '文章标题',
        visibleText: '',
        headings: [],
        links: [],
        buttons: [],
        tables: [{ headers: ['A', 'B'], rows: [['x']] }], // short row → col1 padded with ''
      },
      { url: 'https://example.com/article', title: '文章标题', documentId: 7 },
    );
    return buildCaptureContent(snap, CAPTURE_ID);
  }

  // whitespace/control/bidi normalizes to empty (explicitly blank on the page)
  function normalizedEmptyCellContent(): CaptureContent {
    const snap = normalizeSnapshot(
      {
        ok: true,
        url: 'https://example.com/article',
        title: '文章标题',
        visibleText: '',
        headings: [],
        links: [],
        buttons: [],
        tables: [{ headers: ['A', 'B'], rows: [['x', ' \t ​‮ ']] }],
      },
      { url: 'https://example.com/article', title: '文章标题', documentId: 7 },
    );
    return buildCaptureContent(snap, CAPTURE_ID);
  }

  const EMPTY = { kind: 'table', tableIndex: 0, row: 0, col: 1, header: null };
  const PADDING = { kind: 'table', tableIndex: 0, row: 0, col: 1, header: null };

  function cellInput(content: CaptureContent, locator: unknown): EvidenceVerifyInput {
    return makeInput({
      contents: new Map([[CAPTURE_ID, content]]),
      proposal: {
        captureId: CAPTURE_ID,
        candidateId: CANDIDATE_ID,
        type: 'table-cell',
        locator,
        excerpt: '',
        value: '',
      },
    });
  }

  it("E1 explicit empty cell：excerpt:'' + value:'' → value-invalid", () => {
    const r = verifyEvidence(cellInput(emptyCellContent(), EMPTY));
    expectRejected(r, 'value-invalid');
  });

  it("E2 explicit empty cell：excerpt:'' + value:null → value-invalid", () => {
    const r = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, emptyCellContent()]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'table-cell',
          locator: EMPTY,
          excerpt: '',
          value: null,
        },
      }),
    );
    expectRejected(r, 'value-invalid');
  });

  it("E3 explicit empty cell：excerpt:null + value:'' → value-invalid", () => {
    const r = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, emptyCellContent()]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'table-cell',
          locator: EMPTY,
          excerpt: null,
          value: '',
        },
      }),
    );
    expectRejected(r, 'value-invalid');
  });

  it('E4 explicit empty cell：excerpt:null + value:null → value-invalid', () => {
    const r = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, emptyCellContent()]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'table-cell',
          locator: EMPTY,
          excerpt: null,
          value: null,
        },
      }),
    );
    expectRejected(r, 'value-invalid');
  });

  it("E5 real normalize 短行 padding cell（col1 补齐 ''）→ value-invalid", () => {
    const content = paddingCellContent();
    // fixture check: normalize pads the short row with ''
    expect(content.tables[0]!.rows[0]).toEqual(['x', '']);
    const r = verifyEvidence(cellInput(content, PADDING));
    expectRejected(r, 'value-invalid');
  });

  it('E6 whitespace/control/bidi 规范化为空 cell → value-invalid', () => {
    const content = normalizedEmptyCellContent();
    // fixture check: the cell normalizes to empty
    expect(content.tables[0]!.rows[0]![1]).toBe('');
    const r = verifyEvidence(cellInput(content, PADDING));
    expectRejected(r, 'value-invalid');
  });

  it('E7 value-invalid 使用安全中性中文 reason（table/field 均适用，不回显正文）', () => {
    const reason = REJECTION_REASONS['value-invalid'];
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThanOrEqual(200);
    // safely neutral: applies to both table/field, no empty-value body echo
    expect(reason).toMatch(/值/);
    expect(reason).not.toMatch(/字段|单元格/); // not specific to a single channel
    const r = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, emptyCellContent()]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'table-cell',
          locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: null },
          excerpt: 'x',
          value: 'x',
        },
      }),
    );
    expect(r.ok).toBe(true); // non-empty cell still verified (control group, no over-reach)
    const rejected = verifyEvidence(cellInput(emptyCellContent(), EMPTY));
    if (!rejected.ok) {
      expect(rejected.reason).not.toContain('example.com');
      expect(rejected.reason).not.toContain('x');
    }
  });

  it('E8 empty cell field path 恒 field-path-invalid（空 cell 不上 fields）', () => {
    const r = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, emptyCellContent()]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'field',
          locator: { kind: 'field', fieldPath: 'tables[0].cell[0][1]' }, // empty-cell path
          excerpt: '',
          value: '',
        },
      }),
    );
    expectRejected(r, 'field-path-invalid');
  });

  it('E9 empty header + nonempty cell → verified 且 header:null（几何占位保留，不受空 cell 收紧影响）', () => {
    const snap = normalizeSnapshot(
      {
        ok: true,
        url: 'https://example.com/article',
        title: '文章标题',
        visibleText: '',
        headings: [],
        links: [],
        buttons: [],
        tables: [{ headers: ['  '], rows: [['非空单元格']] }],
      },
      { url: 'https://example.com/article', title: '文章标题', documentId: 7 },
    );
    const content = buildCaptureContent(snap, CAPTURE_ID);
    const r = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, content]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'table-cell',
          locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: null },
          excerpt: '非空单元格',
          value: '非空单元格',
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evidence.locator).toEqual({
        kind: 'table',
        tableIndex: 0,
        row: 0,
        col: 0,
        header: null,
      });
    }
  });

  it('E10 nonempty table-cell 保持 verified（正常路径不回归）', () => {
    const r = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'table-cell',
          locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: null },
          excerpt: '甲',
          value: '甲',
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.evidence.excerpt).toBe('甲');
      expect(r.evidence.value).toBe('甲');
    }
  });

  it('E11 nonempty field 保持 verified（field 通道不受影响）', () => {
    const r = verifyEvidence(
      makeInput({
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'field',
          locator: { kind: 'field', fieldPath: 'page.title' },
          excerpt: '文章标题',
          value: '文章标题',
        },
      }),
    );
    expect(r.ok).toBe(true);
  });
});

describe('C4 Replan：normalize 后空 header 占位 → Evidence header null', () => {
  it('R-EVIDENCE-EMPTY-HEADER 真实 normalize 空表头 → VerifiedEvidence.locator.header = null', () => {
    // An empty header + non-empty data row through the real
    // snapshot-normalize + buildCaptureContent: the table is kept (it has a
    // non-empty cell) with headers as the [''] placeholder → the Evidence
    // output header must be null
    const snap = normalizeSnapshot(
      {
        ok: true,
        url: 'https://example.com/article',
        title: '文章标题',
        visibleText: '',
        headings: [],
        links: [],
        buttons: [],
        tables: [{ headers: ['  '], rows: [['无表头单元格']] }],
      },
      { url: 'https://example.com/article', title: '文章标题', documentId: 7 },
    );
    const content = buildCaptureContent(snap, CAPTURE_ID);
    expect(content.tables).toHaveLength(1);
    expect(content.tables[0]!.headers).toEqual(['']);
    const result = verifyEvidence(
      makeInput({
        contents: new Map([[CAPTURE_ID, content]]),
        proposal: {
          captureId: CAPTURE_ID,
          candidateId: CANDIDATE_ID,
          type: 'table-cell',
          locator: { kind: 'table', tableIndex: 0, row: 0, col: 0, header: null },
          excerpt: '无表头单元格',
          value: '无表头单元格',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.evidence.locator).toEqual({
        kind: 'table',
        tableIndex: 0,
        row: 0,
        col: 0,
        header: null,
      });
    }
  });
});
