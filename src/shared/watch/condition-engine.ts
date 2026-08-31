// D2 condition-engine: v1 确定性结构化条件校验与求值（detailed-design §5、
// threat-model §3.3；决策 13–19）。纯函数、零 IO、零依赖、零 AI/正则条件。
//
// 契约要点：
// - 仅一层 all/any、1..MAX_CONDITIONS_PER_RULE(10) 条、闭合 operator（决策 13）。
// - fieldKey 必须来自调用方闭合字段目录；拒绝 __proto__/prototype/constructor、
//   通配符、任意数组索引、嵌套路径和未知字段（决策 14）。
// - 数值只接受规范 ASCII 十进制（可有负号/小数），拒绝 NaN/Infinity/指数/单位/
//   locale 猜测及不存在值冒充 0（决策 15）。
// - 文本比较执行 NFC、控制/bidi 清除、空白折叠；contains 是线性字面匹配，零正则
//   （决策 16）。
// - 无 Condition 等价于有效 ChangeSet 全部匹配（决策 17）。
// - 输入/字段目录/ChangeSet 不得被修改（决策 18）。
// - exact own-key 形状验证；额外键、原型链字段及未来版本 fail-closed（决策 19）。
import {
  CONDITION_OPERATORS,
  WATCH_EVENT_KINDS,
  type CombineMode,
  type ConditionOperator,
  type ConditionPredicate,
  type ConditionWarningCode,
  type WatchEventKind,
} from '../types/watch';
import { MAX_CONDITIONS_PER_RULE } from '../types/watch';
import { normalizeWatchText } from './watch-budget';

// ---------------------------------------------------------------------------
// 闭合错误码 → 安全中文短句（≤200；零敌手正文回显）
// ---------------------------------------------------------------------------

export type ConditionErrorCode =
  | 'condition-shape-invalid'
  | 'condition-version-future'
  | 'condition-combine-invalid'
  | 'condition-predicates-range'
  | 'predicate-shape-invalid'
  | 'predicate-field-key-invalid'
  | 'predicate-operator-invalid'
  | 'predicate-operand-invalid'
  | 'predicate-case-invalid'
  | 'change-set-shape-invalid'
  | 'change-set-event-kind-invalid'
  | 'change-field-shape-invalid'
  | 'change-field-key-invalid'
  | 'change-value-invalid';

export const CONDITION_ERROR_REASONS: Record<ConditionErrorCode, string> = {
  'condition-shape-invalid': '条件格式非法（字段白名单或形状不合法）',
  'condition-version-future': '条件版本不受支持',
  'condition-combine-invalid': '组合方式必须是全部匹配或任一匹配',
  'condition-predicates-range': '条件数量必须在 1 到上限之间且禁止嵌套',
  'predicate-shape-invalid': '条件谓词格式非法',
  'predicate-field-key-invalid': '字段不在受支持目录内或含非法路径',
  'predicate-operator-invalid': '不支持的条件运算符',
  'predicate-operand-invalid': '条件比较值格式非法',
  'predicate-case-invalid': '大小写敏感标记必须为布尔值',
  'change-set-shape-invalid': '变更集格式非法',
  'change-set-event-kind-invalid': '变更事件种类不受支持',
  'change-field-shape-invalid': '变更字段格式非法',
  'change-field-key-invalid': '变更字段不在受支持目录内或含非法路径',
  'change-value-invalid': '变更值形状非法',
};

// ---------------------------------------------------------------------------
// 基础工具（fail-closed：任何反射/属性检查异常均转失败，绝不抛穿）
// ---------------------------------------------------------------------------

function isPlainRecord(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  try {
    return Object.getPrototypeOf(raw) === Object.prototype;
  } catch {
    return false;
  }
}

// exact own-key 集合比较（Reflect.ownKeys 含非枚举/Symbol；不按原型链读取）。
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

/** own-data-property 读取哨兵：字段缺失、accessor 或反射异常（fail-closed）。 */
const NOT_OWN_DATA: unique symbol = Symbol('not-own-data');

/**
 * 集中 own-data-property 读取（F2）：只接受普通对象上的自有数据属性；accessor、
 * 非自有、descriptor/Reflect/Proxy 异常一律返回 NOT_OWN_DATA（调用方按形状 fail-closed）。
 * 绝不触发 getter；不调用 getter 来"验证"getter。
 */
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

// 规范 ASCII 十进制（可有负号/小数）；拒绝指数/单位/locale 分隔/空。
const NUMERIC_DECIMAL_PATTERN = /^-?\d+(\.\d+)?$/;

const DANGEROUS_FIELD_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);
const ARRAY_INDEX_PATTERN = /^\d+$/;

/** 字段 key 合法：非空字符串、非危险键、无通配符/数组索引/嵌套路径、且 ∈ 闭合目录。 */
export function isValidFieldKey(key: unknown, fieldCatalog: ReadonlySet<string>): boolean {
  if (typeof key !== 'string' || key === '') return false;
  if (DANGEROUS_FIELD_KEYS.has(key)) return false;
  if (key.includes('*') || key.includes('?')) return false; // 通配符
  if (ARRAY_INDEX_PATTERN.test(key)) return false; // 任意数组索引
  if (key.includes('.') || key.includes('[') || key.includes(']')) return false; // 嵌套路径
  return fieldCatalog.has(key);
}

/** 把 string|number 解析为有限数值；非规范形态返回 null（不存在值不冒充 0）。 */
function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    if (!NUMERIC_DECIMAL_PATTERN.test(value)) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isValidNumericOperand(operand: unknown): boolean {
  if (typeof operand === 'string' && (operand.length < 1 || operand.length > 500)) return false;
  return parseFiniteNumber(operand) !== null;
}

// ---------------------------------------------------------------------------
// ChangeSet 契约（D2 定义；D7 生成有效 ChangeSet）
// ---------------------------------------------------------------------------

export type ChangeFieldValue = { kind: 'present'; value: string | number } | { kind: 'absent' };

export interface ChangeField {
  fieldKey: string; // 闭合目录内字段
  before: ChangeFieldValue;
  after: ChangeFieldValue;
}

export interface StructuredChangeSet {
  eventKind: WatchEventKind; // 整体事件种类（event-kind-is 求值）
  fields: ChangeField[];
}

function parseChangeValue(raw: unknown): ChangeFieldValue | null {
  if (!isPlainRecord(raw)) return null;
  const kind = ownDataValue(raw, 'kind');
  if (kind === NOT_OWN_DATA) return null;
  if (kind === 'absent') {
    if (!exactOwnKeys(raw, ['kind'])) return null;
    return { kind: 'absent' };
  }
  if (kind === 'present') {
    if (!exactOwnKeys(raw, ['kind', 'value'])) return null;
    const value = ownDataValue(raw, 'value');
    if (value === NOT_OWN_DATA) return null;
    if (typeof value === 'string') return { kind: 'present', value };
    if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'present', value };
    return null;
  }
  return null;
}

function validateChangeField(
  raw: unknown,
  fieldCatalog: ReadonlySet<string>,
): { ok: true; field: ChangeField } | { ok: false; reason: ConditionErrorCode } {
  if (!isPlainRecord(raw)) return { ok: false, reason: 'change-field-shape-invalid' };
  if (!exactOwnKeys(raw, ['fieldKey', 'before', 'after'])) {
    return { ok: false, reason: 'change-field-shape-invalid' };
  }
  const fieldKey = ownDataValue(raw, 'fieldKey');
  const beforeRaw = ownDataValue(raw, 'before');
  const afterRaw = ownDataValue(raw, 'after');
  if (fieldKey === NOT_OWN_DATA || beforeRaw === NOT_OWN_DATA || afterRaw === NOT_OWN_DATA) {
    return { ok: false, reason: 'change-field-shape-invalid' };
  }
  if (!isValidFieldKey(fieldKey, fieldCatalog)) {
    return { ok: false, reason: 'change-field-key-invalid' };
  }
  const before = parseChangeValue(beforeRaw);
  if (before === null) return { ok: false, reason: 'change-value-invalid' };
  const after = parseChangeValue(afterRaw);
  if (after === null) return { ok: false, reason: 'change-value-invalid' };
  return {
    ok: true,
    field: { fieldKey: fieldKey as string, before, after },
  };
}

export type ChangeSetValidationResult =
  { ok: true; changeSet: StructuredChangeSet } | { ok: false; reason: ConditionErrorCode };

export function validateChangeSet(
  raw: unknown,
  fieldCatalog: ReadonlySet<string>,
): ChangeSetValidationResult {
  if (!isPlainRecord(raw)) return { ok: false, reason: 'change-set-shape-invalid' };
  if (!exactOwnKeys(raw, ['eventKind', 'fields'])) {
    return { ok: false, reason: 'change-set-shape-invalid' };
  }
  const eventKind = ownDataValue(raw, 'eventKind');
  const fields = ownDataValue(raw, 'fields');
  if (eventKind === NOT_OWN_DATA || fields === NOT_OWN_DATA) {
    return { ok: false, reason: 'change-set-shape-invalid' };
  }
  if (
    typeof eventKind !== 'string' ||
    !(WATCH_EVENT_KINDS as readonly string[]).includes(eventKind)
  ) {
    return { ok: false, reason: 'change-set-event-kind-invalid' };
  }
  if (!Array.isArray(fields)) return { ok: false, reason: 'change-set-shape-invalid' };
  const parsed: ChangeField[] = [];
  try {
    for (const f of fields) {
      const r = validateChangeField(f, fieldCatalog);
      if (!r.ok) return r;
      parsed.push(r.field);
    }
  } catch {
    return { ok: false, reason: 'change-set-shape-invalid' };
  }
  return { ok: true, changeSet: { eventKind: eventKind as WatchEventKind, fields: parsed } };
}

// ---------------------------------------------------------------------------
// Condition 校验（exact own-key；未来版本 fail-closed）
// ---------------------------------------------------------------------------

function isValidOperand(operand: unknown, operator: ConditionOperator): boolean {
  switch (operator) {
    case 'changed':
      return operand === null; // changed 不使用 operand
    case 'event-kind-is':
      return (
        typeof operand === 'string' &&
        operand.length <= 500 &&
        (WATCH_EVENT_KINDS as readonly string[]).includes(operand)
      );
    case 'increased':
    case 'decreased':
    case 'crosses-above':
    case 'crosses-below':
      return isValidNumericOperand(operand);
    case 'contains':
    case 'not-contains':
      return typeof operand === 'string' && operand.length > 0 && operand.length <= 500;
    case 'equals':
    case 'not-equals':
      return (
        (typeof operand === 'string' && operand.length > 0 && operand.length <= 500) ||
        (typeof operand === 'number' && Number.isFinite(operand))
      );
    default:
      return false;
  }
}

function validatePredicate(
  raw: unknown,
  fieldCatalog: ReadonlySet<string>,
): { ok: true; predicate: ConditionPredicate } | { ok: false; reason: ConditionErrorCode } {
  if (!isPlainRecord(raw)) return { ok: false, reason: 'predicate-shape-invalid' };
  if (!exactOwnKeys(raw, ['fieldKey', 'operator', 'operand', 'caseSensitive'])) {
    return { ok: false, reason: 'predicate-shape-invalid' };
  }
  const fieldKey = ownDataValue(raw, 'fieldKey');
  const operator = ownDataValue(raw, 'operator');
  const caseSensitive = ownDataValue(raw, 'caseSensitive');
  const operand = ownDataValue(raw, 'operand');
  if (
    fieldKey === NOT_OWN_DATA ||
    operator === NOT_OWN_DATA ||
    caseSensitive === NOT_OWN_DATA ||
    operand === NOT_OWN_DATA
  ) {
    return { ok: false, reason: 'predicate-shape-invalid' };
  }
  if (!isValidFieldKey(fieldKey, fieldCatalog)) {
    return { ok: false, reason: 'predicate-field-key-invalid' };
  }
  if (
    typeof operator !== 'string' ||
    !(CONDITION_OPERATORS as readonly string[]).includes(operator)
  ) {
    return { ok: false, reason: 'predicate-operator-invalid' };
  }
  if (typeof caseSensitive !== 'boolean') return { ok: false, reason: 'predicate-case-invalid' };
  if (!isValidOperand(operand, operator as ConditionOperator)) {
    return { ok: false, reason: 'predicate-operand-invalid' };
  }
  return {
    ok: true,
    predicate: {
      fieldKey: fieldKey as string,
      operator: operator as ConditionOperator,
      operand: operand as string | number | null,
      caseSensitive,
    },
  };
}

export type ConditionValidationResult =
  | { ok: true; condition: { version: 1; combine: CombineMode; predicates: ConditionPredicate[] } }
  | { ok: false; reason: ConditionErrorCode };

export function validateStructuredCondition(
  raw: unknown,
  fieldCatalog: ReadonlySet<string>,
): ConditionValidationResult {
  if (!isPlainRecord(raw)) return { ok: false, reason: 'condition-shape-invalid' };
  if (!exactOwnKeys(raw, ['version', 'combine', 'predicates'])) {
    return { ok: false, reason: 'condition-shape-invalid' };
  }
  const version = ownDataValue(raw, 'version');
  const combine = ownDataValue(raw, 'combine');
  const predicates = ownDataValue(raw, 'predicates');
  if (version === NOT_OWN_DATA || combine === NOT_OWN_DATA || predicates === NOT_OWN_DATA) {
    return { ok: false, reason: 'condition-shape-invalid' };
  }
  if (version !== 1) return { ok: false, reason: 'condition-version-future' };
  if (combine !== 'all' && combine !== 'any') {
    return { ok: false, reason: 'condition-combine-invalid' };
  }
  if (!Array.isArray(predicates)) return { ok: false, reason: 'condition-predicates-range' };
  if (predicates.length < 1 || predicates.length > MAX_CONDITIONS_PER_RULE) {
    return { ok: false, reason: 'condition-predicates-range' };
  }
  const parsed: ConditionPredicate[] = [];
  try {
    for (const p of predicates) {
      const r = validatePredicate(p, fieldCatalog);
      if (!r.ok) return r;
      parsed.push(r.predicate);
    }
  } catch {
    return { ok: false, reason: 'condition-predicates-range' };
  }
  return {
    ok: true,
    condition: { version: 1, combine: combine as CombineMode, predicates: parsed },
  };
}

// ---------------------------------------------------------------------------
// 求值（纯函数；文本线性字面比较，零正则条件）
// ---------------------------------------------------------------------------
// D7 #S6-053/#S6-058：求值器必须遍历全部 predicate（不因 all/any 短路）并按 §5
// 闭合矩阵求值；同一 predicate 对同 fieldKey 的全部 ChangeField 先合并判定。
// - 不支持情形（字段缺失/数值不可用/typed operator 不适用）= no-match + 闭合
//   warning（unsupported/no-match），不是 error；
// - 任一可适用 pair 命中 → predicate=true；存在可适用 pair 但未命中 → false 且
//   不因不适用 sibling 产生 warning；全部 pair 均不适用 → false + 恰一个 warning
//   （优先级 numeric-value-unavailable 后 operator-not-applicable）；无同字段 pair
//   才是 field-absent；
// - Condition/ChangeSet 形状/版本/字段目录/值类型验证失败或求值器异常 → condition
//   error（ok:false + ConditionErrorCode）。

function numericOf(value: ChangeFieldValue): number | null {
  if (value.kind !== 'present') return null; // 不存在值不能冒充 0
  return parseFiniteNumber(value.value);
}

function numericOperand(operand: string | number | null): number | null {
  if (operand === null) return null;
  return parseFiniteNumber(operand);
}

function foldCase(text: string, caseSensitive: boolean): string {
  return caseSensitive ? text : text.toLowerCase();
}

function textOf(value: ChangeFieldValue): string {
  return value.kind === 'present' ? String(value.value) : '';
}

function equalsValue(
  value: ChangeFieldValue,
  operand: string | number,
  caseSensitive: boolean,
): boolean {
  if (typeof operand === 'number') {
    const n = numericOf(value);
    return n !== null && n === operand;
  }
  const a = foldCase(normalizeWatchText(textOf(value)), caseSensitive);
  const b = foldCase(normalizeWatchText(operand), caseSensitive);
  return a === b;
}

function containsText(value: ChangeFieldValue, operand: string, caseSensitive: boolean): boolean {
  const a = foldCase(normalizeWatchText(textOf(value)), caseSensitive);
  const b = foldCase(normalizeWatchText(operand), caseSensitive);
  return a.includes(b); // 线性字面匹配，零正则
}

function changedDiffers(before: ChangeFieldValue, after: ChangeFieldValue): boolean {
  if (before.kind !== after.kind) return true;
  if (before.kind === 'absent') return false; // 双 absent 无变化
  return normalizeWatchText(textOf(before)) !== normalizeWatchText(textOf(after));
}

// 每 operator 的可适用性判定（§5 矩阵）：返回 applicable=false 表示该 field 不适用
//（不参与命中判定，但参与 warning 优先级判定）；否则返回匹配结果。
function matchApplicable(
  field: ChangeField,
  predicate: ConditionPredicate,
): { applicable: true; matched: boolean } | { applicable: false; numericUnavailable: boolean } {
  switch (predicate.operator) {
    case 'changed':
      // 任何同 fieldKey 已验证 pair 都适用；按 typed before/after 判等
      return { applicable: true, matched: changedDiffers(field.before, field.after) };
    case 'equals': {
      if (field.after.kind !== 'present') return { applicable: false, numericUnavailable: false };
      return {
        applicable: true,
        matched: equalsValue(
          field.after,
          predicate.operand as string | number,
          predicate.caseSensitive,
        ),
      };
    }
    case 'not-equals': {
      if (field.after.kind !== 'present') return { applicable: false, numericUnavailable: false };
      return {
        applicable: true,
        matched: !equalsValue(
          field.after,
          predicate.operand as string | number,
          predicate.caseSensitive,
        ),
      };
    }
    case 'contains': {
      if (field.after.kind !== 'present') return { applicable: false, numericUnavailable: false };
      return {
        applicable: true,
        matched: containsText(field.after, predicate.operand as string, predicate.caseSensitive),
      };
    }
    case 'not-contains': {
      if (field.after.kind !== 'present') return { applicable: false, numericUnavailable: false };
      return {
        applicable: true,
        matched: !containsText(field.after, predicate.operand as string, predicate.caseSensitive),
      };
    }
    case 'increased':
    case 'decreased':
    case 'crosses-above':
    case 'crosses-below': {
      if (field.before.kind !== 'present' || field.after.kind !== 'present') {
        return { applicable: false, numericUnavailable: false };
      }
      const before = numericOf(field.before);
      const after = numericOf(field.after);
      if (before === null || after === null) {
        return { applicable: false, numericUnavailable: true };
      }
      switch (predicate.operator) {
        case 'increased':
          return { applicable: true, matched: after > before };
        case 'decreased':
          return { applicable: true, matched: after < before };
        case 'crosses-above': {
          const threshold = numericOperand(predicate.operand);
          return {
            applicable: true,
            matched: threshold !== null && before <= threshold && after > threshold,
          };
        }
        case 'crosses-below': {
          const threshold = numericOperand(predicate.operand);
          return {
            applicable: true,
            matched: threshold !== null && before >= threshold && after < threshold,
          };
        }
        default:
          return { applicable: true, matched: false };
      }
    }
    default:
      return { applicable: false, numericUnavailable: false };
  }
}

/**
 * 单 predicate 求值（§5 多 pair 合并语义）。
 * event-kind-is：只比较 ChangeSet.eventKind，永不产生 warning。
 * 返回 { matched, warning }；warning 为闭合码或 null。
 */
function matchPredicate(
  predicate: ConditionPredicate,
  cs: StructuredChangeSet,
): {
  matched: boolean;
  warning: ConditionWarningCode | null;
} {
  if (predicate.operator === 'event-kind-is') {
    return { matched: cs.eventKind === predicate.operand, warning: null };
  }
  let anyApplicable = false;
  let anyNumericUnavailable = false;
  for (const field of cs.fields) {
    if (field.fieldKey !== predicate.fieldKey) continue;
    const r = matchApplicable(field, predicate);
    if (r.applicable) {
      anyApplicable = true;
      if (r.matched) return { matched: true, warning: null };
    } else if (r.numericUnavailable) {
      anyNumericUnavailable = true;
    }
  }
  if (anyApplicable) return { matched: false, warning: null };
  // 全部 pair 均不适用（或无同字段 pair）：
  // 无同字段 pair → field-absent；否则按优先级 numeric-value-unavailable 后
  // operator-not-applicable 产生恰一个 warning。
  const hasField = cs.fields.some((f) => f.fieldKey === predicate.fieldKey);
  if (!hasField) return { matched: false, warning: 'field-absent' };
  return {
    matched: false,
    warning: anyNumericUnavailable ? 'numeric-value-unavailable' : 'operator-not-applicable',
  };
}

/** warning 编译期顺序（#S6-058：去重后按该顺序排序）。 */
const WARNING_ORDER: readonly ConditionWarningCode[] = [
  'field-absent',
  'numeric-value-unavailable',
  'operator-not-applicable',
];

export type ConditionEvaluationResult =
  | { ok: true; matched: boolean; warnings: ConditionWarningCode[] }
  | { ok: false; code: ConditionErrorCode };

export interface ConditionEvaluationInput {
  condition: unknown; // null/undefined = 无 Condition（全部匹配）
  changeSet: unknown;
  fieldCatalog: ReadonlySet<string>;
}

export function evaluateStructuredCondition(
  input: ConditionEvaluationInput,
): ConditionEvaluationResult {
  const cs = validateChangeSet(input.changeSet, input.fieldCatalog);
  if (!cs.ok) return { ok: false, code: cs.reason };
  if (input.condition === null || input.condition === undefined) {
    // 决策 17：无 Condition 等价于有效 ChangeSet 全部匹配
    return { ok: true, matched: true, warnings: [] };
  }
  const cond = validateStructuredCondition(input.condition, input.fieldCatalog);
  if (!cond.ok) return { ok: false, code: cond.reason };
  if (cond.condition.predicates.length === 0) {
    return { ok: false, code: 'condition-predicates-range' };
  }
  // 全部 predicate 求值（非短路），再按 all/any 组合；warning 去重排序。
  const results: Array<{ matched: boolean; warning: ConditionWarningCode | null }> = [];
  for (const p of cond.condition.predicates) {
    results.push(matchPredicate(p, cs.changeSet));
  }
  const warnings: ConditionWarningCode[] = [];
  const seen = new Set<ConditionWarningCode>();
  for (const code of WARNING_ORDER) {
    if (results.some((r) => r.warning === code)) {
      seen.add(code);
      warnings.push(code);
    }
  }
  void seen;
  const matched =
    cond.condition.combine === 'all'
      ? results.every((r) => r.matched)
      : results.some((r) => r.matched);
  return { ok: true, matched, warnings };
}
