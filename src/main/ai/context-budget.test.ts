// Context budget tests: deterministic truncation, §7.5 priority fill with per-section
// caps and total-budget stop, §7.7 layout-table noise filter, §7.6 history trim/replay.
// Contract source: doc/stage2/detailed-design.md §7.4–§7.7.
import { describe, expect, it } from 'vitest';
import type { PageSnapshot } from '../../shared/types/browser';
import type { ContextSource, ConversationMessage } from '../../shared/types/conversation';
import {
  CONTEXT_BUDGET,
  LAYOUT_TABLE_MIN_CONTENT_CHARS,
  TRUNCATION_MARK,
  countSnapshotBodyChars,
  fillWebContentSections,
  filterLayoutTables,
  renderHistoryMessageContent,
  trimHistory,
  truncateWithMark,
  type ContextBudget,
} from './context-budget';

function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/page',
    title: '示例页面',
    headings: [],
    links: [],
    buttons: [],
    meta: {
      documentId: 1,
      capturedAt: 1_752_000_000_000,
      readyState: 'complete',
      degraded: 'none',
      warnings: [],
    },
    ...overrides,
  };
}

function makeSource(overrides: Partial<ContextSource> = {}): ContextSource {
  return {
    mode: 'snapshot',
    tabId: 'tab-1',
    url: 'https://example.com/a',
    title: '页面A',
    capturedAt: 1_752_000_000_000,
    degraded: false,
    thin: false,
    selectionExcerpt: null,
    warnings: [],
    ...overrides,
  };
}

let messageSeq = 0;
function makeMessage(
  role: 'user' | 'assistant',
  content: string,
  contextSource?: ContextSource,
): ConversationMessage {
  messageSeq += 1;
  return {
    id: `msg-${messageSeq}`,
    role,
    content,
    createdAt: 1_752_000_000_000,
    status: 'complete',
    ...(contextSource !== undefined ? { contextSource } : {}),
  };
}

const BUDGET_WARNING = '页面内容超出预算，已确定性裁剪';

describe('truncateWithMark — 确定性截断标记', () => {
  it('未超限返回原文，无标记', () => {
    expect(truncateWithMark('abc', 5)).toBe('abc');
    expect(truncateWithMark('abc', 3)).toBe('abc');
    expect(truncateWithMark('', 0)).toBe('');
  });

  it('超限截断到 max 字符并追加标记', () => {
    expect(truncateWithMark('abcdef', 3)).toBe(`abc${TRUNCATION_MARK}`);
    expect(TRUNCATION_MARK).toBe('…[已截断]');
  });
});

describe('countSnapshotBodyChars — §7.4 正文合计（均 trim 后）', () => {
  it('空快照为 0', () => {
    expect(countSnapshotBodyChars(makeSnapshot())).toBe(0);
  });

  it('各字段计入：visibleText/headings/tables 单元格/links 文本/buttons 文本/inputs 占位与值', () => {
    const snapshot = makeSnapshot({
      visibleText: '  hello  world  ',
      headings: [{ level: 1, text: '  A  ' }],
      tables: [{ headers: [' x '], rows: [[' y ']] }],
      links: [{ id: 'el-1', text: ' t ', href: '  https://x  ' }],
      buttons: [{ id: 'el-2', text: ' b ' }],
      inputs: [{ id: 'el-3', type: 'text', placeholder: ' p ', value: ' v ' }],
    });
    // 12 + 1 + 2 + 1 + 1 + 2 = 19（href 与 input type 不计入）
    expect(countSnapshotBodyChars(snapshot)).toBe(19);
  });

  it('selection / link href / input type 不计入', () => {
    const snapshot = makeSnapshot({
      selection: 's'.repeat(500),
      links: [{ id: 'el-1', text: '', href: 'h'.repeat(500) }],
      inputs: [{ id: 'el-2', type: 'x'.repeat(50) }],
    });
    expect(countSnapshotBodyChars(snapshot)).toBe(0);
  });
});

describe('filterLayoutTables — §7.7 布局表启发式', () => {
  it('有表头 → 保留（哪怕无数据行）', () => {
    const { kept, skipped } = filterLayoutTables([{ headers: ['名', '值'], rows: [] }]);
    expect(kept).toHaveLength(1);
    expect(skipped).toBe(0);
  });

  it('表头全空且数据行 < 2 → 跳过', () => {
    const empty = filterLayoutTables([{ headers: ['', ''], rows: [] }]);
    const oneRow = filterLayoutTables([{ headers: ['', ''], rows: [['', '']] }]);
    expect(empty.kept).toHaveLength(0);
    expect(empty.skipped).toBe(1);
    expect(oneRow.kept).toHaveLength(0);
    expect(oneRow.skipped).toBe(1);
  });

  it('表头全空且内容字符合计 < 100 → 跳过；≥ 100 → 保留', () => {
    const thin = filterLayoutTables([
      {
        headers: ['', ''],
        rows: [
          ['a', ''],
          ['', ''],
        ],
      },
    ]);
    const dense = filterLayoutTables([
      {
        headers: ['', ''],
        rows: [
          ['a'.repeat(50), 'b'.repeat(50)],
          ['', ''],
        ],
      },
    ]);
    expect(thin.kept).toHaveLength(0);
    expect(thin.skipped).toBe(1);
    expect(dense.kept).toHaveLength(1);
    expect(dense.skipped).toBe(0);
  });

  it('边界值：内容 = 100 保留 / 99 跳过；行数不足最小行数跳过', () => {
    const dense = filterLayoutTables([
      {
        headers: ['', ''],
        rows: [
          ['a'.repeat(LAYOUT_TABLE_MIN_CONTENT_CHARS), ''],
          ['', ''],
        ],
      },
    ]);
    expect(dense.kept).toHaveLength(1);
    const justThin = filterLayoutTables([
      {
        headers: ['', ''],
        rows: [
          ['a'.repeat(LAYOUT_TABLE_MIN_CONTENT_CHARS - 1), ''],
          ['', ''],
        ],
      },
    ]);
    expect(justThin.kept).toHaveLength(0);
    const oneRow = filterLayoutTables([
      { headers: ['', ''], rows: [['a'.repeat(LAYOUT_TABLE_MIN_CONTENT_CHARS)]] },
    ]);
    expect(oneRow.kept).toHaveLength(0); // rows < LAYOUT_TABLE_MIN_ROWS
  });

  it('混合表：计数正确且顺序稳定', () => {
    const { kept, skipped } = filterLayoutTables([
      { headers: ['', ''], rows: [['', '']] },
      { headers: ['名'], rows: [['张三']] },
      { headers: ['', ''], rows: [] },
    ]);
    expect(skipped).toBe(2);
    expect(kept).toHaveLength(1);
    expect(kept[0].headers).toEqual(['名']);
  });
});

describe('fillWebContentSections — selection 模式（§7.5 独立预算）', () => {
  it('选中文本 trim 后原样进入 <selection> 节', () => {
    const fill = fillWebContentSections(makeSnapshot({ selection: '  选中的文本  ' }), 'selection');
    expect(fill.sections).toEqual([{ name: 'selection', content: '选中的文本' }]);
    expect(fill.truncated).toBe(false);
    expect(fill.warnings).toEqual([]);
  });

  it('超 20000 字符 → 截断 + 标记 + 警告', () => {
    const fill = fillWebContentSections(
      makeSnapshot({ selection: 's'.repeat(20_001) }),
      'selection',
    );
    expect(fill.sections).toEqual([
      { name: 'selection', content: 's'.repeat(20_000) + TRUNCATION_MARK },
    ]);
    expect(fill.truncated).toBe(true);
    expect(fill.warnings).toEqual([BUDGET_WARNING]);
  });

  it('空白/缺失 selection → 无节（块仍由 builder 闭合）', () => {
    expect(
      fillWebContentSections(makeSnapshot({ selection: '   ' }), 'selection').sections,
    ).toEqual([]);
    expect(fillWebContentSections(makeSnapshot(), 'selection').sections).toEqual([]);
  });

  it('selection 独占：正文不进入任何节', () => {
    const fill = fillWebContentSections(
      makeSnapshot({ selection: '选中', visibleText: '整页正文' }),
      'selection',
    );
    expect(fill.sections).toEqual([{ name: 'selection', content: '选中' }]);
  });
});

describe('fillWebContentSections — snapshot 模式优先级与序列化格式', () => {
  it('按 text → headings → tables → links → buttons → inputs 顺序填充', () => {
    const fill = fillWebContentSections(
      makeSnapshot({
        visibleText: '正文',
        headings: [{ level: 2, text: '标题' }],
        tables: [{ headers: ['a'], rows: [['x']] }],
        links: [{ id: 'el-1', text: '链接', href: 'https://a' }],
        buttons: [{ id: 'el-2', text: '按钮' }],
        inputs: [{ id: 'el-3', type: 'text' }],
      }),
      'snapshot',
    );
    expect(fill.sections.map((section) => section.name)).toEqual([
      'text',
      'headings',
      'tables',
      'links',
      'buttons',
      'inputs',
    ]);
    expect(fill.sections[0].content).toBe('正文');
    expect(fill.sections[1].content).toBe('H2 标题');
    expect(fill.sections[2].content).toBe('表1（表头：a）\n行：x');
    expect(fill.sections[3].content).toBe('链接（https://a）');
    expect(fill.sections[4].content).toBe('按钮');
    expect(fill.sections[5].content).toBe('text');
  });

  it('表格序列化：表头行 + 数据行（§7.7）', () => {
    const fill = fillWebContentSections(
      makeSnapshot({
        tables: [
          {
            headers: ['姓名', '年龄'],
            rows: [
              ['张三', '30'],
              ['李四', '25'],
            ],
          },
        ],
      }),
      'snapshot',
    );
    expect(fill.sections[0].content).toBe('表1（表头：姓名|年龄）\n行：张三|30\n行：李四|25');
  });

  it('无表头但内容充实的表 → 保留，仅编号', () => {
    const fill = fillWebContentSections(
      makeSnapshot({
        tables: [
          {
            headers: ['', ''],
            rows: [
              ['a'.repeat(60), ''],
              ['', 'b'.repeat(40)],
            ],
          },
        ],
      }),
      'snapshot',
    );
    expect(fill.sections[0].content.startsWith('表1\n行：')).toBe(true);
  });

  it('空文本的 link → 仅（href）；input 组合格式', () => {
    const fill = fillWebContentSections(
      makeSnapshot({
        links: [{ id: 'el-1', text: '', href: 'https://b' }],
        inputs: [
          { id: 'el-2', type: 'text', placeholder: '搜索', value: '关键词' },
          { id: 'el-3', type: 'password' },
        ],
      }),
      'snapshot',
    );
    expect(fill.sections[0].content).toBe('（https://b）');
    expect(fill.sections[1].content).toBe('text（搜索）=关键词\npassword');
  });

  it('空节省略；全空 → 无节无警告', () => {
    const onlyHeadings = fillWebContentSections(
      makeSnapshot({ headings: [{ level: 1, text: '唯一内容' }] }),
      'snapshot',
    );
    expect(onlyHeadings.sections.map((section) => section.name)).toEqual(['headings']);
    const empty = fillWebContentSections(makeSnapshot(), 'snapshot');
    expect(empty.sections).toEqual([]);
    expect(empty.warnings).toEqual([]);
    expect(empty.truncated).toBe(false);
  });

  it('布局表被过滤（先于预算计入）+ 聚合警告', () => {
    const fill = fillWebContentSections(
      makeSnapshot({
        visibleText: '正文',
        tables: [
          { headers: ['', ''], rows: [['', '']] },
          { headers: ['', ''], rows: [] },
          { headers: ['名'], rows: [['张三']] },
        ],
      }),
      'snapshot',
    );
    expect(fill.warnings).toEqual(['跳过 2 个疑似布局表格']);
    expect(fill.sections[1].content.startsWith('表1（表头：名）')).toBe(true);
  });
});

describe('fillWebContentSections — 各节上限与截断标记（§7.5）', () => {
  it('text 超节上限 → 截断 + 标记 + 警告', () => {
    const fill = fillWebContentSections(
      makeSnapshot({ visibleText: 'a'.repeat(12_001) }),
      'snapshot',
    );
    expect(fill.sections[0].content).toBe('a'.repeat(12_000) + TRUNCATION_MARK);
    expect(fill.truncated).toBe(true);
    expect(fill.warnings).toEqual([BUDGET_WARNING]);
  });

  it('headings 超 200 条 → 保留前 200 条 + 截断', () => {
    const fill = fillWebContentSections(
      makeSnapshot({
        headings: Array.from({ length: 201 }, (_, i) => ({ level: 1, text: `h${i}` })),
      }),
      'snapshot',
    );
    expect(fill.sections[0].content.split('\n')).toHaveLength(200);
    expect(fill.truncated).toBe(true);
  });

  it('links：超 200 条 → 计数截断 + 节尾标记', () => {
    const fill = fillWebContentSections(
      makeSnapshot({
        links: Array.from({ length: 201 }, (_, i) => ({
          id: `el-${i + 1}`,
          text: `t${i}`,
          href: 'https://x',
        })),
      }),
      'snapshot',
    );
    const lines = fill.sections[0].content.split('\n');
    expect(lines).toHaveLength(200);
    expect(lines[0]).toBe('t0（https://x）');
    expect(lines[199]).toContain(TRUNCATION_MARK);
    expect(fill.truncated).toBe(true);
  });

  it('links：text 超 100 / href 超 500 → 字段级截断标记', () => {
    const fill = fillWebContentSections(
      makeSnapshot({ links: [{ id: 'el-1', text: 't'.repeat(101), href: 'h'.repeat(501) }] }),
      'snapshot',
    );
    const lines = fill.sections[0].content.split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      't'.repeat(100) + TRUNCATION_MARK + '（' + 'h'.repeat(500) + TRUNCATION_MARK + '）',
    );
    expect(fill.truncated).toBe(true);
  });

  it('buttons 超 200 / inputs 超 100 → 截断', () => {
    const fill = fillWebContentSections(
      makeSnapshot({
        buttons: Array.from({ length: 201 }, (_, i) => ({ id: `el-${i + 1}`, text: `b${i}` })),
        inputs: Array.from({ length: 101 }, (_, i) => ({ id: `el-${i + 1}`, type: 'text' })),
      }),
      'snapshot',
    );
    expect(fill.sections[0].content.split('\n')).toHaveLength(200);
    expect(fill.sections[1].content.split('\n')).toHaveLength(100);
    expect(fill.truncated).toBe(true);
  });

  it('tables：超 5 张 / 行超 50 → 计数截断 + 节尾标记', () => {
    const fill = fillWebContentSections(
      makeSnapshot({
        tables: Array.from({ length: 6 }, (_, t) => ({
          headers: [`h${t}`],
          rows: Array.from({ length: 51 }, (_, r) => [`r${r}`]),
        })),
      }),
      'snapshot',
    );
    const content = fill.sections[0].content;
    expect(content.match(/表\d+/g)).toHaveLength(5);
    expect(content.split('\n')).toHaveLength(5 * 51);
    expect(content).toContain(TRUNCATION_MARK);
    expect(fill.truncated).toBe(true);
  });

  it('tables：单元格超 200 → 单元格级截断标记', () => {
    const fill = fillWebContentSections(
      makeSnapshot({ tables: [{ headers: ['h'], rows: [['c'.repeat(201)]] }] }),
      'snapshot',
    );
    expect(fill.sections[0].content).toContain('c'.repeat(200) + TRUNCATION_MARK);
    expect(fill.truncated).toBe(true);
  });

  it('布局表不占 5 张上限（过滤先于限量）', () => {
    const real = Array.from({ length: 5 }, (_, t) => ({ headers: [`h${t}`], rows: [['x']] }));
    const layout = { headers: ['', ''], rows: [] };
    const fill = fillWebContentSections(makeSnapshot({ tables: [...real, layout] }), 'snapshot');
    expect(fill.sections[0].content.match(/表\d+/g)).toHaveLength(5);
    expect(fill.warnings).toEqual(['跳过 1 个疑似布局表格']);
    expect(fill.truncated).toBe(false);
  });
});

describe('fillWebContentSections — 总预算停止（§7.5 累计超限即停）', () => {
  const small: ContextBudget = { ...CONTEXT_BUDGET, webContentTotalChars: 50 };

  it('当前节裁剪到剩余预算 + 标记，后续节省略', () => {
    const fill = fillWebContentSections(
      makeSnapshot({
        visibleText: 'a'.repeat(100),
        headings: [{ level: 1, text: '后续内容' }],
      }),
      'snapshot',
      small,
    );
    expect(fill.sections).toEqual([{ name: 'text', content: 'a'.repeat(50) + TRUNCATION_MARK }]);
    expect(fill.truncated).toBe(true);
    expect(fill.warnings).toEqual([BUDGET_WARNING]);
  });

  it('预算为 0 → 无节（确定性空输出）', () => {
    const fill = fillWebContentSections(makeSnapshot({ visibleText: '正文' }), 'snapshot', {
      ...CONTEXT_BUDGET,
      webContentTotalChars: 0,
    });
    expect(fill.sections).toEqual([]);
    expect(fill.truncated).toBe(false);
  });

  it('恰好放下的节计入累计，后续停止', () => {
    const fill = fillWebContentSections(
      makeSnapshot({ visibleText: 'x'.repeat(30), headings: [{ level: 1, text: '超出' }] }),
      'snapshot',
      { ...CONTEXT_BUDGET, webContentTotalChars: 30 },
    );
    expect(fill.sections).toEqual([{ name: 'text', content: 'x'.repeat(30) }]);
    expect(fill.truncated).toBe(false);
  });
});

describe('renderHistoryMessageContent — §7.6 单条上限与来源行', () => {
  it('短消息原样重放', () => {
    expect(renderHistoryMessageContent(makeMessage('assistant', '你好'))).toBe('你好');
  });

  it('超 2000 字符 → 截断 + 标记', () => {
    const rendered = renderHistoryMessageContent(makeMessage('user', 'a'.repeat(2_500)));
    expect(rendered).toBe('a'.repeat(2_000) + TRUNCATION_MARK);
  });

  it('user + contextSource → 行首来源行（≤ 120 字符），来源行计入单条上限', () => {
    const rendered = renderHistoryMessageContent(
      makeMessage('user', '第一问', makeSource({ title: '页面A', url: 'https://a' })),
    );
    expect(rendered).toBe('（该轮引用页面：页面A https://a）\n第一问');
    const capped = renderHistoryMessageContent(
      makeMessage('user', '第一问', makeSource({ title: 't'.repeat(200), url: null })),
    );
    expect(capped.startsWith('（该轮引用页面：')).toBe(true);
    expect(capped).toContain(TRUNCATION_MARK);
  });

  it('contextSource 无 title/url → 无来源行', () => {
    const rendered = renderHistoryMessageContent(
      makeMessage('user', '问题', makeSource({ title: null, url: null })),
    );
    expect(rendered).toBe('问题');
  });
});

describe('trimHistory — §7.6 轮数/字符裁剪', () => {
  const pairs = (n: number): ConversationMessage[] =>
    Array.from({ length: n }, (_, i) => [
      makeMessage('user', `u${i + 1}`),
      makeMessage('assistant', `a${i + 1}`),
    ]).flat();

  it('空历史 → 空数组', () => {
    expect(trimHistory([])).toEqual([]);
  });

  it('8 轮以内全保留（顺序不变）', () => {
    const history = pairs(8);
    const trimmed = trimHistory(history);
    expect(trimmed).toHaveLength(16);
    expect(trimmed[0].content).toBe('u1');
    expect(trimmed[15].content).toBe('a8');
  });

  it('超过 8 轮 → 保留最近 8 对（成对截取）', () => {
    const trimmed = trimHistory(pairs(10));
    expect(trimmed).toHaveLength(16);
    expect(trimmed[0].content).toBe('u3');
    expect(trimmed[15].content).toBe('a10');
  });

  it('尾部不成对的单条 user 保留（防御）', () => {
    const history = [...pairs(1), makeMessage('user', 'u2')];
    expect(trimHistory(history)).toHaveLength(3);
  });

  it('总字符预算：从最近往前累计，超限丢弃更早消息（整条丢弃）', () => {
    const history = [makeMessage('user', 'abcdef'), makeMessage('assistant', 'ghij')];
    expect(trimHistory(history, { ...CONTEXT_BUDGET, historyMaxChars: 10 })).toHaveLength(2);
    const dropped = trimHistory(history, { ...CONTEXT_BUDGET, historyMaxChars: 9 });
    expect(dropped).toHaveLength(1);
    expect(dropped[0].content).toBe('ghij');
  });

  it('来源行计入总预算（§7.6）', () => {
    // 渲染长度 = 来源行 12 + 换行 1 + 内容 1 = 14
    const history = [makeMessage('user', 'x', makeSource({ title: 't', url: 'u' }))];
    expect(trimHistory(history, { ...CONTEXT_BUDGET, historyMaxChars: 14 })).toHaveLength(1);
    expect(trimHistory(history, { ...CONTEXT_BUDGET, historyMaxChars: 13 })).toHaveLength(0);
  });

  it('裁剪不修改保留消息的原文（单条截断在重放时发生）', () => {
    const history = [makeMessage('assistant', 'a'.repeat(3_000))];
    const trimmed = trimHistory(history);
    expect(trimmed[0].content).toBe('a'.repeat(3_000));
  });
});
