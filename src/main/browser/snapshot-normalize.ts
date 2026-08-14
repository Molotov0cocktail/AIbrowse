// PageSnapshot 脚本输出校验纯函数（零 Electron 依赖，分层纪律，可单测）.
// Contract source: doc/detailed-design.md §2.6/§8.6（页面视为敌手：逐字段类型校验/
// 限额二次截断/非法条目丢弃/warnings 合并去重；任何输入都返回合法 PageSnapshot，不抛异常）.
// L2 形状（main-process-only）也由本模块产出：输入不可用（executeJavaScript 失败、
// 脚本异常或返回垃圾）时返回仅主进程侧 url/title + 空集合的快照。

import type { PageSnapshot, SnapshotDegradation, SnapshotMeta } from '../../shared/types/browser';

// 校验限额（与 §8.2 采集限额一致，作为第二道防线二次截断；测试用同源常量构造边界数据）
export const NORMALIZE_LIMITS = {
  text: 1000,
  href: 2000,
  selection: 10_000,
  visibleText: 100_000,
  headings: 1000,
  links: 2000,
  buttons: 2000,
  inputs: 500,
  inputType: 100,
  tables: 100,
  tableRows: 500,
  tableCols: 500,
  warnings: 20,
  warningText: 500,
  url: 2000,
  title: 1000,
} as const;

export interface SnapshotFallback {
  url: string;
  title: string;
  // A3：主进程侧导航世代（TabManager 维护，快照时刻盖章）——elementId 与可信文档绑定的
  // 唯一依据；脚本输出中的任何 documentId 字段一律忽略（页面不可伪造世代）。
  documentId: number;
}

// elementId 格式（§8.4）：el-<n>，n 为非负十进制整数（页面试图伪造格式会被整条丢弃）
const ELEMENT_ID_PATTERN = /^el-\d{1,10}$/;
const READY_STATES: ReadonlySet<string> = new Set(['loading', 'interactive', 'complete']);

// 截断警告文案（脚本标志与校验侧二次截断共用同一文案，去重合并为一条）
const TRUNCATED_WARNING: Record<string, string> = {
  headings: 'headings 超过采集限额，已截断',
  links: 'links 超过采集限额，已截断',
  buttons: 'buttons 超过采集限额，已截断',
  inputs: 'inputs 超过采集限额，已截断',
  tables: 'tables 超过采集限额，已截断',
  tableRows: '表格行数超过采集限额，已截断',
  visibleText: '可见文本超过采集限额，已截断',
  selection: '选中文本超过采集限额，已截断',
};

const L2_GENERIC_WARNING = '页面采集结果不可用，仅返回主进程侧数据';

// ---------- 基础校验工具（页面是敌手：任何字段都可能是任意类型） ----------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

// 文本字段：空白折叠 + 截断（§8.2「文本一律 textContent.trim()（空白折叠）」）
function textField(value: unknown, limit: number): string {
  const s = asString(value);
  return s === null ? '' : collapseWhitespace(s).slice(0, limit);
}

// 非文本字段（href/url/type）：仅 trim + 截断，不做空白折叠
function rawField(value: unknown, limit: number): string {
  const s = asString(value);
  return s === null ? '' : s.trim().slice(0, limit);
}

function isValidElementId(value: unknown): value is string {
  return typeof value === 'string' && ELEMENT_ID_PATTERN.test(value);
}

function readArrayField(value: unknown): unknown[] | null {
  return Array.isArray(value) ? (value as unknown[]) : null;
}

type AddWarning = (text: string) => void;

export function normalizeSnapshot(raw: unknown, fallback: SnapshotFallback): PageSnapshot {
  const warnings: string[] = [];
  const addWarning: AddWarning = (text) => {
    const trimmed = text.slice(0, NORMALIZE_LIMITS.warningText);
    if (trimmed !== '' && !warnings.includes(trimmed)) warnings.push(trimmed);
  };

  const fallbackUrl = rawField(fallback.url, NORMALIZE_LIMITS.url);
  const fallbackTitle = textField(fallback.title, NORMALIZE_LIMITS.title);

  const rawObj = asRecord(raw);
  if (rawObj === null || rawObj['ok'] !== true) {
    // L2：脚本未产出可用结果（executeJavaScript 失败 / 脚本异常 / 返回垃圾）→ 仅主进程侧数据
    const scriptError = asString(rawObj?.['error']);
    const l2Warnings: string[] = [];
    if (scriptError !== null && scriptError !== '') {
      l2Warnings.push(`采集脚本失败：${scriptError}`.slice(0, NORMALIZE_LIMITS.warningText));
    }
    l2Warnings.push(L2_GENERIC_WARNING);
    return {
      url: fallbackUrl,
      title: fallbackTitle,
      headings: [],
      links: [],
      buttons: [],
      meta: {
        capturedAt: Date.now(),
        documentId: fallback.documentId,
        readyState: 'unknown',
        degraded: 'main-process-only',
        warnings: l2Warnings,
      },
    };
  }

  // ---------- 基础字段 ----------

  const rawUrl = rawField(rawObj['url'], NORMALIZE_LIMITS.url);
  const url = rawUrl !== '' ? rawUrl : fallbackUrl;
  const rawTitle = textField(rawObj['title'], NORMALIZE_LIMITS.title);
  const title = rawTitle !== '' ? rawTitle : fallbackTitle;

  const readyStateValue = asString(rawObj['readyState']);
  const readyState: SnapshotMeta['readyState'] =
    readyStateValue !== null && READY_STATES.has(readyStateValue)
      ? (readyStateValue as SnapshotMeta['readyState'])
      : 'unknown';

  const viewport = readViewport(rawObj['viewport']);

  const selectionValue = textField(rawObj['selection'], NORMALIZE_LIMITS.selection);
  const selection = selectionValue !== '' ? selectionValue : undefined;
  const visibleTextValue = textField(rawObj['visibleText'], NORMALIZE_LIMITS.visibleText);
  const visibleText = visibleTextValue !== '' ? visibleTextValue : undefined;

  // ---------- iframe 统计（L1 判定依据，警告最先产出保持顺序稳定） ----------

  const iframes = readIframes(rawObj['iframes']);
  if (iframes.total > 0) {
    addWarning(`跳过 ${iframes.total} 个 iframe（其中 ${iframes.crossOrigin} 个跨域）`);
  }

  // ---------- 集合字段（限额二次截断 + 非法条目丢弃） ----------

  const headings = readHeadings(rawObj['headings'], addWarning);
  const links = readLinks(rawObj['links'], addWarning);
  const buttons = readButtons(rawObj['buttons'], addWarning);
  const inputs = readInputs(rawObj['inputs'], addWarning);
  const tables = readTables(rawObj['tables'], addWarning);

  // 脚本侧截断标志 → 对应中文警告（未知键/非字符串条目忽略）
  const truncatedRaw = readArrayField(rawObj['truncated']);
  if (truncatedRaw !== null) {
    for (const key of truncatedRaw) {
      const name = asString(key);
      if (name !== null && name in TRUNCATED_WARNING) addWarning(TRUNCATED_WARNING[name]);
    }
  }

  const degraded: SnapshotDegradation =
    readyState === 'complete' && iframes.total === 0 ? 'none' : 'partial';

  const snapshot: PageSnapshot = {
    url,
    title,
    headings,
    links,
    buttons,
    meta: {
      capturedAt: Date.now(),
      documentId: fallback.documentId, // A3：世代由主进程盖章，脚本输出中的 documentId 被忽略
      readyState,
      degraded,
      warnings: warnings.slice(0, NORMALIZE_LIMITS.warnings),
    },
  };
  if (viewport !== undefined) snapshot.viewport = viewport;
  if (selection !== undefined) snapshot.selection = selection;
  if (visibleText !== undefined) snapshot.visibleText = visibleText;
  if (inputs !== undefined) snapshot.inputs = inputs;
  if (tables !== undefined) snapshot.tables = tables;
  return snapshot;
}

// ---------- 各字段读取 ----------

function readViewport(value: unknown): PageSnapshot['viewport'] {
  const rec = asRecord(value);
  if (rec === null) return undefined;
  const scrollX = asFiniteNumber(rec['scrollX']);
  const scrollY = asFiniteNumber(rec['scrollY']);
  const width = asFiniteNumber(rec['width']);
  const height = asFiniteNumber(rec['height']);
  if (scrollX === null || scrollY === null || width === null || height === null) return undefined;
  if (scrollX < 0 || scrollY < 0 || width < 0 || height < 0) return undefined;
  return { scrollX, scrollY, width, height };
}

function readIframes(value: unknown): { total: number; crossOrigin: number } {
  const rec = asRecord(value);
  if (rec === null) return { total: 0, crossOrigin: 0 };
  let total = asFiniteNumber(rec['total']);
  let crossOrigin = asFiniteNumber(rec['crossOrigin']);
  if (total === null || total < 0 || !Number.isInteger(total)) total = 0;
  if (crossOrigin === null || crossOrigin < 0 || !Number.isInteger(crossOrigin)) crossOrigin = 0;
  // 收敛：跨域计数钳制在总数内（畸形数据不产生矛盾警告）
  return { total, crossOrigin: Math.min(crossOrigin, total) };
}

function readHeadings(value: unknown, addWarning: AddWarning): PageSnapshot['headings'] {
  const arr = readArrayField(value);
  if (arr === null) return [];
  const items = arr.slice(0, NORMALIZE_LIMITS.headings);
  if (arr.length > NORMALIZE_LIMITS.headings) addWarning(TRUNCATED_WARNING['headings']);
  const result: PageSnapshot['headings'] = [];
  let dropped = 0;
  for (const item of items) {
    const rec = asRecord(item);
    if (rec === null) {
      dropped++;
      continue;
    }
    const level = rec['level'];
    const text = textField(rec['text'], NORMALIZE_LIMITS.text);
    if (
      typeof level !== 'number' ||
      !Number.isInteger(level) ||
      level < 1 ||
      level > 6 ||
      text === ''
    ) {
      dropped++;
      continue;
    }
    result.push({ level, text });
  }
  if (dropped > 0) addWarning(`丢弃 ${dropped} 条无效 heading`);
  return result;
}

function readLinks(value: unknown, addWarning: AddWarning): PageSnapshot['links'] {
  const arr = readArrayField(value);
  if (arr === null) return [];
  const items = arr.slice(0, NORMALIZE_LIMITS.links);
  if (arr.length > NORMALIZE_LIMITS.links) addWarning(TRUNCATED_WARNING['links']);
  const result: PageSnapshot['links'] = [];
  let dropped = 0;
  for (const item of items) {
    const rec = asRecord(item);
    if (rec === null) {
      dropped++;
      continue;
    }
    const id = rec['id'];
    const href = rawField(rec['href'], NORMALIZE_LIMITS.href);
    const text = rec['text'];
    if (!isValidElementId(id) || href === '' || typeof text !== 'string') {
      dropped++;
      continue;
    }
    result.push({ id, text: textField(text, NORMALIZE_LIMITS.text), href });
  }
  if (dropped > 0) addWarning(`丢弃 ${dropped} 条无效 link`);
  return result;
}

function readButtons(value: unknown, addWarning: AddWarning): PageSnapshot['buttons'] {
  const arr = readArrayField(value);
  if (arr === null) return [];
  const items = arr.slice(0, NORMALIZE_LIMITS.buttons);
  if (arr.length > NORMALIZE_LIMITS.buttons) addWarning(TRUNCATED_WARNING['buttons']);
  const result: PageSnapshot['buttons'] = [];
  let dropped = 0;
  for (const item of items) {
    const rec = asRecord(item);
    if (rec === null) {
      dropped++;
      continue;
    }
    const id = rec['id'];
    const text = rec['text'];
    if (!isValidElementId(id) || typeof text !== 'string') {
      dropped++;
      continue;
    }
    const entry: PageSnapshot['buttons'][number] = {
      id,
      text: textField(text, NORMALIZE_LIMITS.text),
    };
    // A3（§5.4）：click 语义元数据——严格布尔校验，非布尔形状丢弃字段（敌手输入纪律；
    // 字段缺失 = 无法证明 → 权限层 fail-closed，不整条丢弃条目）
    if (typeof rec['isSubmit'] === 'boolean') entry.isSubmit = rec['isSubmit'];
    if (typeof rec['ariaExpanded'] === 'boolean') entry.ariaExpanded = rec['ariaExpanded'];
    result.push(entry);
  }
  if (dropped > 0) addWarning(`丢弃 ${dropped} 条无效 button`);
  return result;
}

function readInputs(value: unknown, addWarning: AddWarning): PageSnapshot['inputs'] {
  const arr = readArrayField(value);
  if (arr === null) return [];
  const items = arr.slice(0, NORMALIZE_LIMITS.inputs);
  if (arr.length > NORMALIZE_LIMITS.inputs) addWarning(TRUNCATED_WARNING['inputs']);
  const result: PageSnapshot['inputs'] = [];
  let dropped = 0;
  for (const item of items) {
    const rec = asRecord(item);
    if (rec === null) {
      dropped++;
      continue;
    }
    const id = rec['id'];
    const type = rawField(rec['type'], NORMALIZE_LIMITS.inputType);
    if (!isValidElementId(id) || type === '') {
      dropped++;
      continue;
    }
    const entry: NonNullable<PageSnapshot['inputs']>[number] = { id, type };
    // A3（§5.4）：inputs 提交类标志——严格布尔，非布尔丢弃字段（fail-closed）
    if (typeof rec['isSubmit'] === 'boolean') entry.isSubmit = rec['isSubmit'];
    const placeholder = textField(rec['placeholder'], NORMALIZE_LIMITS.text);
    if (placeholder !== '') entry.placeholder = placeholder;
    const valueValue = asString(rec['value']);
    if (valueValue !== null) {
      const value = collapseWhitespace(valueValue).slice(0, NORMALIZE_LIMITS.text);
      if (value !== '') entry.value = value;
    }
    result.push(entry);
  }
  if (dropped > 0) addWarning(`丢弃 ${dropped} 条无效 input`);
  return result.length > 0 ? result : undefined;
}

function readTables(value: unknown, addWarning: AddWarning): PageSnapshot['tables'] {
  const arr = readArrayField(value);
  if (arr === null) return [];
  const items = arr.slice(0, NORMALIZE_LIMITS.tables);
  if (arr.length > NORMALIZE_LIMITS.tables) addWarning(TRUNCATED_WARNING['tables']);
  const result: PageSnapshot['tables'] = [];
  let dropped = 0;
  for (const item of items) {
    const rec = asRecord(item);
    if (rec === null) {
      dropped++;
      continue;
    }
    const headersRaw = readArrayField(rec['headers']);
    const rowsRaw = readArrayField(rec['rows']);
    if (headersRaw === null || rowsRaw === null) {
      dropped++;
      continue;
    }
    const headers = headersRaw
      .slice(0, NORMALIZE_LIMITS.tableCols)
      .map((cell) => textField(cell, NORMALIZE_LIMITS.text));
    const rowItems = rowsRaw.slice(0, NORMALIZE_LIMITS.tableRows);
    if (rowsRaw.length > NORMALIZE_LIMITS.tableRows) addWarning(TRUNCATED_WARNING['tableRows']);
    const rows: string[][] = [];
    for (const row of rowItems) {
      const cells = readArrayField(row);
      if (cells === null) continue; // 非数组行丢弃（对齐以行为单位，无法修复）
      rows.push(
        cells
          .slice(0, NORMALIZE_LIMITS.tableCols)
          .map((cell) => textField(cell, NORMALIZE_LIMITS.text)),
      );
    }
    if (headers.length === 0 && rows.length === 0) {
      dropped++;
      continue;
    }
    // 行列对齐（§8.2「行列对齐由 normalize 补齐/截断」）：列数 = max(表头长, 各行长)
    const colCount = Math.min(
      NORMALIZE_LIMITS.tableCols,
      Math.max(headers.length, ...rows.map((row) => row.length), 0),
    );
    const pad = (cells: string[]): string[] => [
      ...cells.slice(0, colCount),
      ...Array.from({ length: Math.max(0, colCount - cells.length) }, () => ''),
    ];
    result.push({ headers: pad(headers), rows: rows.map(pad) });
  }
  if (dropped > 0) addWarning(`丢弃 ${dropped} 条无效 table`);
  return result.length > 0 ? result : undefined;
}
