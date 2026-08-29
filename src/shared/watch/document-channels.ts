// Sixth Stage D6: DocumentChannels 严格运行时验证器（detailed-design §3.2/§8、
// FIXED DECISIONS 6）。纯函数、零 IO、零依赖（与 watch-targets/condition-engine
// 同纪律：exact own-key 白名单 + own-data 读取，getter/proxy/原型链/稀疏数组/
// 未知字段全部 fail-closed）。
//
// 语义：
// - 外层与 heading/table/link 子对象均 exact own keys + plain object +
//   own-data-property（零 getter/setter 副作用）；
// - 数组必须是稠密（无洞、无自定义额外属性、无 symbol）、长度受硬上限约束；
// - 字符串有界；进入 Projector 前先做 UTF-8 结构预算预检（总和 > 64 KiB
//   → fail-closed，防御纵深；最终预算以 canonical PageProjectionValue 为准）；
// - D3 PublicHtmlSaxReader 输出与 Session adapter 输出都必须经过本验证器，
//   不能因 TypeScript 类型而跳过运行时校验；不引入新 HTML parser。
import type { DocumentChannels } from '../types/watch';
import { MAX_PAGE_PROJECTION_BYTES } from '../types/watch';
import { utf8ByteLength } from './watch-budget';

export type DocumentChannelsValidationResult =
  { ok: true; channels: DocumentChannels } | { ok: false; reason: string };

const MAX_ARRAY_ITEMS = 4096; // 敌手数组长度硬上界（防 O(n²)/内存膨胀；实际通道远小于此）

// 单字符串 char 上界：不允许单个字符串超过整个投影字节预算的码元数
//（多字节文本由 UTF-8 总额预检兜底）
const MAX_STRING_CHARS = MAX_PAGE_PROJECTION_BYTES;

const HEADING_LEVELS = new Set<unknown>([1, 2, 3]);

function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  try {
    return Object.getPrototypeOf(raw) === Object.prototype;
  } catch {
    return false;
  }
}

function exactOwnKeys(raw: Record<string, unknown>, expected: readonly string[]): boolean {
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(raw);
  } catch {
    return false;
  }
  if (keys.length !== expected.length) return false;
  const set = new Set<string>(expected);
  for (const k of keys) {
    if (typeof k !== 'string' || !set.has(k)) return false;
  }
  return true;
}

// own-data-property 读取哨兵（不触发 getter；descriptor/Reflect 异常 fail-closed）
const NOT_OWN_DATA: unique symbol = Symbol('document-channels-not-own-data');

function ownDataValue(raw: Record<string, unknown>, key: string): unknown {
  let desc: PropertyDescriptor | undefined;
  try {
    desc = Object.getOwnPropertyDescriptor(raw, key);
  } catch {
    return NOT_OWN_DATA;
  }
  if (desc === undefined) return NOT_OWN_DATA;
  try {
    if (!Object.prototype.hasOwnProperty.call(desc, 'value')) return NOT_OWN_DATA;
    if (Object.prototype.hasOwnProperty.call(desc, 'get')) return NOT_OWN_DATA;
    if (Object.prototype.hasOwnProperty.call(desc, 'set')) return NOT_OWN_DATA;
    return desc.value;
  } catch {
    return NOT_OWN_DATA;
  }
}

// 稠密数组：只允许 length + 规范索引 own string keys，索引全覆盖、无自定义
// 额外属性、无 symbol（数组的其余内建只读属性不属于 own keys）。
function isDenseArray(raw: unknown, maxItems: number): raw is unknown[] {
  if (!Array.isArray(raw) || raw.length > maxItems) return false;
  const len = raw.length;
  let keys: (string | symbol)[];
  try {
    keys = Reflect.ownKeys(raw);
  } catch {
    return false;
  }
  let indexCount = 0;
  for (const k of keys) {
    if (k === 'length') continue;
    if (typeof k !== 'string') return false;
    const n = Number(k);
    if (!Number.isSafeInteger(n) || n < 0 || n >= len || String(n) !== k) return false;
    indexCount += 1;
  }
  return indexCount === len;
}

function isBoundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_STRING_CHARS;
}

function validateHeading(raw: unknown): { level: 1 | 2 | 3; text: string } | null {
  if (!isPlainRecord(raw) || !exactOwnKeys(raw, ['level', 'text'])) return null;
  const level = ownDataValue(raw, 'level');
  const text = ownDataValue(raw, 'text');
  if (level === NOT_OWN_DATA || text === NOT_OWN_DATA) return null;
  if (!HEADING_LEVELS.has(level)) return null;
  if (!isBoundedString(text)) return null;
  return { level: level as 1 | 2 | 3, text };
}

function validateStringArray(raw: unknown): string[] | null {
  if (!isDenseArray(raw, MAX_ARRAY_ITEMS)) return null;
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i] as unknown;
    if (!isBoundedString(item)) return null;
    out.push(item);
  }
  return out;
}

function validateTable(raw: unknown): { headers: string[]; rows: string[][] } | null {
  if (!isPlainRecord(raw) || !exactOwnKeys(raw, ['headers', 'rows'])) return null;
  const headers = ownDataValue(raw, 'headers');
  const rows = ownDataValue(raw, 'rows');
  if (headers === NOT_OWN_DATA || rows === NOT_OWN_DATA) return null;
  const headersOk = validateStringArray(headers);
  if (headersOk === null) return null;
  if (!isDenseArray(rows, MAX_ARRAY_ITEMS)) return null;
  const rowsOut: string[][] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] as unknown;
    const rowOut = validateStringArray(row);
    if (rowOut === null) return null;
    rowsOut.push(rowOut);
  }
  return { headers: headersOk, rows: rowsOut };
}

function validateLink(raw: unknown): { text: string; url: string } | null {
  if (!isPlainRecord(raw) || !exactOwnKeys(raw, ['text', 'url'])) return null;
  const text = ownDataValue(raw, 'text');
  const url = ownDataValue(raw, 'url');
  if (text === NOT_OWN_DATA || url === NOT_OWN_DATA) return null;
  if (!isBoundedString(text) || !isBoundedString(url)) return null;
  return { text, url };
}

/**
 * DocumentChannels 严格验证 + UTF-8 结构预算预检（详细设计 §8；== 预算接受、
 * +1 fail-closed）。输入必须是 plain object / exact own keys / own-data 属性 /
 * 稠密数组 / 有界字符串；任何 getter、symbol、原型链字段、未知字段、非法 level
 * 或非字符串一律拒绝。
 */
export function validateDocumentChannels(raw: unknown): DocumentChannelsValidationResult {
  if (!isPlainRecord(raw)) {
    return { ok: false, reason: 'not-plain-record' };
  }
  if (!exactOwnKeys(raw, ['mainText', 'headings', 'tables', 'links'])) {
    return { ok: false, reason: 'unexpected-keys' };
  }
  const mainTextRaw = ownDataValue(raw, 'mainText');
  const headingsRaw = ownDataValue(raw, 'headings');
  const tablesRaw = ownDataValue(raw, 'tables');
  const linksRaw = ownDataValue(raw, 'links');
  if (
    mainTextRaw === NOT_OWN_DATA ||
    headingsRaw === NOT_OWN_DATA ||
    tablesRaw === NOT_OWN_DATA ||
    linksRaw === NOT_OWN_DATA
  ) {
    return { ok: false, reason: 'accessor-or-missing' };
  }
  if (!isBoundedString(mainTextRaw)) {
    return { ok: false, reason: 'main-text-invalid' };
  }
  if (!isDenseArray(headingsRaw, MAX_ARRAY_ITEMS)) {
    return { ok: false, reason: 'headings-invalid' };
  }
  const headings = [];
  for (let i = 0; i < headingsRaw.length; i += 1) {
    const h = validateHeading(headingsRaw[i]);
    if (h === null) return { ok: false, reason: 'heading-item-invalid' };
    headings.push(h);
  }
  if (!isDenseArray(tablesRaw, MAX_ARRAY_ITEMS)) {
    return { ok: false, reason: 'tables-invalid' };
  }
  const tables = [];
  for (let i = 0; i < tablesRaw.length; i += 1) {
    const t = validateTable(tablesRaw[i]);
    if (t === null) return { ok: false, reason: 'table-item-invalid' };
    tables.push(t);
  }
  if (!isDenseArray(linksRaw, MAX_ARRAY_ITEMS)) {
    return { ok: false, reason: 'links-invalid' };
  }
  const links = [];
  for (let i = 0; i < linksRaw.length; i += 1) {
    const l = validateLink(linksRaw[i]);
    if (l === null) return { ok: false, reason: 'link-item-invalid' };
    links.push(l);
  }
  const channels: DocumentChannels = { mainText: mainTextRaw, headings, tables, links };
  // UTF-8 结构预算预检（防御纵深）：全部字符串总和 > 64 KiB → 拒绝。
  // normalizer 只做 NFC 组合/控制清除/空白折叠，不会使编码后字节显著膨胀；
  // 最终 ==/+1 预算 oracle 仍以 canonical PageProjectionValue 为准（page-projector）。
  let total = utf8ByteLength(channels.mainText);
  for (const h of headings) total += utf8ByteLength(h.text);
  for (const t of tables) {
    for (const h of t.headers) total += utf8ByteLength(h);
    for (const row of t.rows) {
      for (const cell of row) total += utf8ByteLength(cell);
    }
  }
  for (const l of links) {
    total += utf8ByteLength(l.text);
    total += utf8ByteLength(l.url);
  }
  if (total > MAX_PAGE_PROJECTION_BYTES) {
    return { ok: false, reason: 'utf8-budget-exceeded' };
  }
  return { ok: true, channels };
}
