// Context budget constants + deterministic truncation/filling (pure, zero Electron deps).
// Contract source: doc/stage2/detailed-design.md §7.4–§7.7:
// char budget (no tokenizer — conservative proxy, §7.5), priority fill with per-section
// caps and total-budget stop, truncation marks, layout-table noise filter (§7.7),
// history trim/replay (§7.6). Any input safe-returns; never throws.

import type { PageSnapshot } from '../../shared/types/browser';
import type { ConversationMessage } from '../../shared/types/conversation';

// —— §7.5 budget table (single source of tunable constants; injectable via ContextBuildInput.budget) ——

export interface ContextBudget {
  webContentTotalChars: number; // 30000 — web block total budget (selection mode counts separately)
  selectionMaxChars: number; // 20000 — selection mode text cap
  sectionVisibleTextMax: number; // 12000
  sectionHeadingsMax: number; // 3000
  sectionTablesMax: number; // 6000
  sectionLinksMax: number; // 4000
  sectionButtonsMax: number; // 2000
  sectionInputsMax: number; // 2000
  questionMaxChars: number; // 16000
  historyMaxTurns: number; // 8 — most recent user+assistant pairs
  historyMaxChars: number; // 12000 — total replayed history chars (take-most-recent)
  replayMessageMaxChars: number; // 2000 — single replayed message cap (source line included)
  historySourceLineMaxChars: number; // 120 — 「该轮引用页面」line cap
  maxHeadings: number; // 200
  maxTables: number; // 5
  maxTableRows: number; // 50
  maxTableCellChars: number; // 200
  maxLinks: number; // 200
  maxLinkTextChars: number; // 100
  maxLinkHrefChars: number; // 500
  maxButtons: number; // 200
  maxInputs: number; // 100
}

export const CONTEXT_BUDGET: ContextBudget = {
  webContentTotalChars: 30_000,
  selectionMaxChars: 20_000,
  sectionVisibleTextMax: 12_000,
  sectionHeadingsMax: 3_000,
  sectionTablesMax: 6_000,
  sectionLinksMax: 4_000,
  sectionButtonsMax: 2_000,
  sectionInputsMax: 2_000,
  questionMaxChars: 16_000,
  historyMaxTurns: 8,
  historyMaxChars: 12_000,
  replayMessageMaxChars: 2_000,
  historySourceLineMaxChars: 120,
  maxHeadings: 200,
  maxTables: 5,
  maxTableRows: 50,
  maxTableCellChars: 200,
  maxLinks: 200,
  maxLinkTextChars: 100,
  maxLinkHrefChars: 500,
  maxButtons: 200,
  maxInputs: 100,
};

// §7.4 thin snapshot threshold; §2 ContextSource display excerpt cap; §7.5 truncation mark;
// §7.7 layout-table heuristic thresholds.
export const THIN_SNAPSHOT_THRESHOLD = 300;
export const SELECTION_EXCERPT_MAX_CHARS = 200;
export const TRUNCATION_MARK = '…[已截断]';
export const LAYOUT_TABLE_MIN_ROWS = 2;
export const LAYOUT_TABLE_MIN_CONTENT_CHARS = 100;

const WARNING_BUDGET_EXCEEDED = '页面内容超出预算，已确定性裁剪';

export type WebContentSectionName =
  'text' | 'headings' | 'tables' | 'links' | 'buttons' | 'inputs' | 'selection';

export interface WebContentSection {
  name: WebContentSectionName;
  content: string;
}

export interface WebContentFill {
  sections: WebContentSection[]; // Priority order; empty sections omitted (§7.1)
  warnings: string[]; // Chinese warnings (table skip / budget truncation)
  truncated: boolean; // Any budget truncation happened (item / section / total)
}

// ---------- 基础裁剪（§7.5：任何截断产生标记；标记不计入预算——预算为保守代理） ----------

export function truncateWithMark(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}${TRUNCATION_MARK}` : text;
}

// §7.4 正文合计：visibleText + headings 文本 + tables 单元格 + links/buttons/inputs 文本，
// 均 trim 后；selection / link href / input type 不计入。
export function countSnapshotBodyChars(snapshot: PageSnapshot): number {
  let total = 0;
  total += (snapshot.visibleText ?? '').trim().length;
  for (const heading of snapshot.headings) total += heading.text.trim().length;
  for (const link of snapshot.links) total += link.text.trim().length;
  for (const button of snapshot.buttons) total += button.text.trim().length;
  for (const input of snapshot.inputs ?? []) {
    total += (input.placeholder ?? '').trim().length;
    total += (input.value ?? '').trim().length;
  }
  for (const table of snapshot.tables ?? []) {
    for (const cell of table.headers) total += cell.trim().length;
    for (const row of table.rows) for (const cell of row) total += cell.trim().length;
  }
  return total;
}

// ---------- 布局表噪声过滤（§7.7，容忍设计：误删只少内容、误留只多冗余，均有 warnings） ----------

export function filterLayoutTables(tables: NonNullable<PageSnapshot['tables']>): {
  kept: NonNullable<PageSnapshot['tables']>;
  skipped: number;
} {
  const kept: NonNullable<PageSnapshot['tables']> = [];
  let skipped = 0;
  for (const table of tables) {
    const headersAllEmpty = table.headers.every((cell) => cell === '');
    if (!headersAllEmpty) {
      kept.push(table);
      continue;
    }
    const contentChars = [...table.headers, ...table.rows.flat()]
      .filter((cell) => cell !== '')
      .reduce((sum, cell) => sum + cell.length, 0);
    if (
      table.rows.length < LAYOUT_TABLE_MIN_ROWS ||
      contentChars < LAYOUT_TABLE_MIN_CONTENT_CHARS
    ) {
      skipped++;
      continue;
    }
    kept.push(table);
  }
  return { kept, skipped };
}

// ---------- web 块内容填充（§7.5 优先级 + 各节上限 + 总预算停止） ----------

export function fillWebContentSections(
  snapshot: PageSnapshot,
  mode: 'snapshot' | 'selection',
  budget: ContextBudget = CONTEXT_BUDGET,
): WebContentFill {
  const warnings: string[] = [];
  const addWarning = (text: string): void => {
    if (!warnings.includes(text)) warnings.push(text);
  };
  let truncated = false;

  if (mode === 'selection') {
    // §7.5：selection 模式独立预算；只送选中文本，正文不进入任何节（决议 Q9）
    const selection = (snapshot.selection ?? '').trim();
    if (selection.length > budget.selectionMaxChars) {
      truncated = true;
      addWarning(WARNING_BUDGET_EXCEEDED);
      return {
        sections: [
          { name: 'selection', content: truncateWithMark(selection, budget.selectionMaxChars) },
        ],
        warnings,
        truncated,
      };
    }
    return {
      sections: selection === '' ? [] : [{ name: 'selection', content: selection }],
      warnings,
      truncated,
    };
  }

  // —— snapshot 模式：布局表过滤先于预算计入（§7.7） ——
  const { kept: tables, skipped: skippedTables } = filterLayoutTables(snapshot.tables ?? []);
  if (skippedTables > 0) addWarning(`跳过 ${skippedTables} 个疑似布局表格`);

  interface BuiltSection {
    name: WebContentSectionName;
    content: string;
    cut: boolean;
  }
  const cap = (text: string, maxChars: number): { content: string; cut: boolean } =>
    text.length > maxChars
      ? { content: truncateWithMark(text, maxChars), cut: true }
      : { content: text, cut: false };
  // 计数型截断（条目超上限被丢弃）同样产生标记（§7.5「任何截断产生标记」）
  const withCountCutMark = (
    capped: { content: string; cut: boolean },
    countCut: boolean,
  ): { content: string; cut: boolean } =>
    countCut ? { content: `${capped.content}${TRUNCATION_MARK}`, cut: true } : capped;
  const built: BuiltSection[] = [];

  // text
  const bText = cap(snapshot.visibleText ?? '', budget.sectionVisibleTextMax);
  if (bText.content !== '') built.push({ name: 'text', ...bText });

  // headings（每条一行；normalize 已保证 text 非空）
  const headingsLines = snapshot.headings
    .slice(0, budget.maxHeadings)
    .map((heading) => `H${heading.level} ${heading.text}`);
  const bHeadings = withCountCutMark(
    cap(headingsLines.join('\n'), budget.sectionHeadingsMax),
    snapshot.headings.length > budget.maxHeadings,
  );
  if (bHeadings.content !== '') built.push({ name: 'headings', ...bHeadings });

  // tables（§7.7 序列化：表N（表头：a|b）行：x|y；复用 normalize 行列对齐语义）
  // dropped = 条目丢弃（表数/行数）→ 节尾标记；fieldCut = 字段级截断 → 行内自带标记
  let tablesDropped = tables.length > budget.maxTables;
  let tablesFieldCut = false;
  const tableBlocks: string[] = [];
  let tableIndex = 0;
  for (const table of tables.slice(0, budget.maxTables)) {
    tableIndex++;
    const rows = table.rows.slice(0, budget.maxTableRows);
    if (table.rows.length > budget.maxTableRows) tablesDropped = true;
    const cells = (cellsRow: string[]): string[] =>
      cellsRow.map((cell) => {
        if (cell.length <= budget.maxTableCellChars) return cell;
        tablesFieldCut = true;
        return truncateWithMark(cell, budget.maxTableCellChars);
      });
    const headerLine = table.headers.every((cell) => cell === '')
      ? `表${tableIndex}`
      : `表${tableIndex}（表头：${cells(table.headers).join('|')}）`;
    tableBlocks.push([headerLine, ...rows.map((row) => `行：${cells(row).join('|')}`)].join('\n'));
  }
  const bTables = withCountCutMark(
    cap(tableBlocks.join('\n'), budget.sectionTablesMax),
    tablesDropped,
  );
  if (bTables.content !== '')
    built.push({
      name: 'tables',
      content: bTables.content,
      cut: tablesDropped || tablesFieldCut || bTables.cut,
    });

  // links（text（href）；text 可为空）
  let linksFieldCut = false;
  const linkLines: string[] = [];
  for (const link of snapshot.links.slice(0, budget.maxLinks)) {
    let text = link.text;
    let href = link.href;
    if (text.length > budget.maxLinkTextChars) {
      linksFieldCut = true;
      text = truncateWithMark(text, budget.maxLinkTextChars);
    }
    if (href.length > budget.maxLinkHrefChars) {
      linksFieldCut = true;
      href = truncateWithMark(href, budget.maxLinkHrefChars);
    }
    linkLines.push(text === '' ? `（${href}）` : `${text}（${href}）`);
  }
  const bLinks = withCountCutMark(
    cap(linkLines.join('\n'), budget.sectionLinksMax),
    snapshot.links.length > budget.maxLinks,
  );
  if (bLinks.content !== '')
    built.push({
      name: 'links',
      content: bLinks.content,
      cut: snapshot.links.length > budget.maxLinks || linksFieldCut || bLinks.cut,
    });

  // buttons
  const bButtons = withCountCutMark(
    cap(
      snapshot.buttons
        .slice(0, budget.maxButtons)
        .map((button) => button.text)
        .join('\n'),
      budget.sectionButtonsMax,
    ),
    snapshot.buttons.length > budget.maxButtons,
  );
  if (bButtons.content !== '') built.push({ name: 'buttons', ...bButtons });

  // inputs（type（placeholder）=value，空段省略）
  const bInputs = withCountCutMark(
    cap(
      (snapshot.inputs ?? [])
        .slice(0, budget.maxInputs)
        .map((input) => {
          let line = input.type;
          if (input.placeholder !== undefined && input.placeholder !== '')
            line += `（${input.placeholder}）`;
          if (input.value !== undefined && input.value !== '') line += `=${input.value}`;
          return line;
        })
        .join('\n'),
      budget.sectionInputsMax,
    ),
    (snapshot.inputs ?? []).length > budget.maxInputs,
  );
  if (bInputs.content !== '') built.push({ name: 'inputs', ...bInputs });

  // 总预算：逐节累计，超限即停止（当前节裁到剩余预算，后续节省略）
  let spent = 0;
  const sections: WebContentSection[] = [];
  for (const item of built) {
    if (item.cut) {
      truncated = true;
      addWarning(WARNING_BUDGET_EXCEEDED);
    }
    if (spent >= budget.webContentTotalChars) break;
    const remaining = budget.webContentTotalChars - spent;
    if (item.content.length <= remaining) {
      sections.push({ name: item.name, content: item.content });
      spent += item.content.length;
    } else {
      sections.push({ name: item.name, content: truncateWithMark(item.content, remaining) });
      truncated = true;
      addWarning(WARNING_BUDGET_EXCEEDED);
      break;
    }
  }
  return { sections, warnings, truncated };
}

// ---------- 历史裁剪与重放（§7.6） ----------

// 单条历史消息的重放渲染（role + content；web 块不重放；user 条行首可加「该轮引用页面」
// 来源行 ≤ 120 字符，计入单条上限与总预算）。裁剪与重放共用同一函数保证长度一致。
export function renderHistoryMessageContent(
  message: ConversationMessage,
  budget: ContextBudget = CONTEXT_BUDGET,
): string {
  let line = '';
  if (message.role === 'user' && message.contextSource !== undefined) {
    const parts = [message.contextSource.title, message.contextSource.url].filter(
      (part): part is string => typeof part === 'string' && part !== '',
    );
    if (parts.length > 0) {
      line = truncateWithMark(
        `（该轮引用页面：${parts.join(' ')}）`,
        budget.historySourceLineMaxChars,
      );
    }
  }
  const content = truncateWithMark(
    message.content,
    Math.max(0, budget.replayMessageMaxChars - line.length),
  );
  return line === '' ? content : `${line}\n${content}`;
}

// 裁剪（S3 编排先调用再传入 buildContext；buildContext 内部亦防御性复用，幂等）：
// ① 最近 historyMaxTurns 对（从尾部回退成对截取；尾部不成对的单条 user 亦保留——防御）；
// ② 总字符预算（从最近往前累计，超限丢弃更早消息，整条丢弃不截断——单条截断在重放时发生）。
export function trimHistory(
  messages: ConversationMessage[],
  budget: ContextBudget = CONTEXT_BUDGET,
): ConversationMessage[] {
  const byTurns: ConversationMessage[] = [];
  let userTurns = 0;
  for (let i = messages.length - 1; i >= 0 && userTurns < budget.historyMaxTurns; i--) {
    const message = messages[i];
    if (message.role === 'user') userTurns++;
    byTurns.unshift(message);
  }
  const result: ConversationMessage[] = [];
  let chars = 0;
  for (let i = byTurns.length - 1; i >= 0; i--) {
    const length = renderHistoryMessageContent(byTurns[i], budget).length;
    if (chars + length > budget.historyMaxChars) break;
    chars += length;
    result.unshift(byTurns[i]);
  }
  return result;
}
