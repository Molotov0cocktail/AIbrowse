// D2 watch-rule-state: WatchRule 状态迁移 + Source 生命周期状态协调 + WatchSchedule
// 精确校验（detailed-design §3.1/§4/§10.3；决策 3–12、19）。纯函数、零 IO、零 DB。
// 语义契约：
// - state ∈ enabled/paused/deleted；deleted 为终态，任何动作不得复活（决策 12）。
// - muted 不在状态字段内：只抑制即时通知，不改变 state/nextDueAt/调度资格（决策 6）。
// - 用户 pause → paused/user/desiredEnabled=false（决策 7）；用户 enable →
//   desiredEnabled=true，仅依赖允许时进入 enabled（决策 8）。
// - Source 生命周期 pause 不覆盖 desiredEnabled（决策 9）；source-restore 只在
//   desiredEnabled=true 且非用户暂停、locator 未变化、其他依赖满足时自动 enabled
//   （决策 10）。
// - rowVersion 与 locator fingerprint 完全分离：rowVersion 只记录最后观察到的行
//   版本；locator fingerprint 才决定 locator 是否变化（决策 11）。
// 所有非法/敌手输入安全返回失败结果或输入副本，绝不抛穿、绝不读取原型链字段。
import { createHash } from 'node:crypto';
import type { SourceScope } from '../types/sources';
import {
  PAUSE_REASONS,
  WATCH_ACCESS_MODES,
  WATCH_INTERVAL_MINUTES,
  WATCH_RULE_KINDS,
  WATCH_RULE_STATES,
  type PauseReason,
  type WatchIntervalMinutes,
  type WatchRuleKind,
  type WatchRuleState,
  type WatchSchedule,
} from '../types/watch';
import { isValidLocalTime, isValidTimeZone } from './clock';

// ---------------------------------------------------------------------------
// WatchSchedule 精确校验（exact own-key；未来 kind/版本 fail-closed，决策 19）
// ---------------------------------------------------------------------------

export type ScheduleErrorCode =
  | 'schedule-shape-invalid' // 非对象/数组/额外键/缺键/错误类型/原型链字段
  | 'schedule-kind-invalid' // kind ∉ {interval, daily}（含未来 kind，如 cron/weekly）
  | 'schedule-interval-invalid' // intervalMinutes ∉ {15,60,360,1440}
  | 'schedule-time-invalid' // daily localTime 非严格 HH:mm
  | 'schedule-timezone-invalid'; // daily timeZone 非合法 IANA id

/** 闭合 schedule 错误 → 安全中文短句（≤200；不回显敌手正文）。 */
export const SCHEDULE_ERROR_REASONS: Record<ScheduleErrorCode, string> = {
  'schedule-shape-invalid': '计划格式非法（字段白名单或形状不合法）',
  'schedule-kind-invalid': '不支持的调度类型（仅支持固定间隔或每日本地时间）',
  'schedule-interval-invalid': '间隔分钟不在允许预设内（15/60/360/1440）',
  'schedule-time-invalid': '每日时刻必须为 HH:mm（00:00..23:59）',
  'schedule-timezone-invalid': '时区不是受支持的 IANA 标识',
};

export type ScheduleValidationResult =
  { ok: true; schedule: WatchSchedule } | { ok: false; reason: ScheduleErrorCode };

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

export function validateWatchSchedule(raw: unknown): ScheduleValidationResult {
  if (!isPlainRecord(raw)) return { ok: false, reason: 'schedule-shape-invalid' };
  const kind = raw['kind'];
  if (kind === 'interval') {
    if (!exactOwnKeys(raw, ['kind', 'intervalMinutes'])) {
      return { ok: false, reason: 'schedule-shape-invalid' };
    }
    const m = raw['intervalMinutes'];
    if (typeof m !== 'number' || !Number.isFinite(m)) {
      return { ok: false, reason: 'schedule-interval-invalid' };
    }
    if (!(WATCH_INTERVAL_MINUTES as readonly number[]).includes(m)) {
      return { ok: false, reason: 'schedule-interval-invalid' };
    }
    return { ok: true, schedule: { kind: 'interval', intervalMinutes: m as WatchIntervalMinutes } };
  }
  if (kind === 'daily') {
    if (!exactOwnKeys(raw, ['kind', 'localTime', 'timeZone'])) {
      return { ok: false, reason: 'schedule-shape-invalid' };
    }
    const localTime = raw['localTime'];
    const timeZone = raw['timeZone'];
    if (typeof localTime !== 'string' || !isValidLocalTime(localTime)) {
      return { ok: false, reason: 'schedule-time-invalid' };
    }
    if (typeof timeZone !== 'string' || !isValidTimeZone(timeZone)) {
      return { ok: false, reason: 'schedule-timezone-invalid' };
    }
    return {
      ok: true,
      schedule: { kind: 'daily', localTime: localTime as `${string}:${string}`, timeZone },
    };
  }
  return { ok: false, reason: 'schedule-kind-invalid' };
}

// ---------------------------------------------------------------------------
// kind/accessMode 组合：feed 仅 public；session 仅 page（决策 4）
// ---------------------------------------------------------------------------

export function validateRuleAccessMode(
  kind: unknown,
  accessMode: unknown,
): { ok: true } | { ok: false } {
  if (
    typeof kind !== 'string' ||
    !(WATCH_RULE_KINDS as readonly string[]).includes(kind) ||
    typeof accessMode !== 'string' ||
    !(WATCH_ACCESS_MODES as readonly string[]).includes(accessMode)
  ) {
    return { ok: false };
  }
  if (kind === 'feed' && accessMode !== 'public') return { ok: false };
  if (accessMode === 'session' && kind !== 'page') return { ok: false };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 状态机（决策 6–12）
// ---------------------------------------------------------------------------

/** 状态机只操作这三个字段；muted 正交、不在此列。 */
export interface WatchRuleStateFields {
  state: WatchRuleState;
  pauseReason: PauseReason | null;
  desiredEnabled: boolean;
}

/** 依赖条件（由调用方按真实 Sources/当前 fingerprint 提供，本模块不推断）。 */
export interface RuleDependencyStatus {
  sourceExists: boolean;
  sourceEnabled: boolean;
  locatorUnchanged: boolean; // 重算 fingerprint === rule.sourceLocatorFingerprint
}

/** 健康/依赖暂停原因（user 与 source 三原因之外的闭合成因）。 */
export type HealthPauseReason = Extract<
  PauseReason,
  | 'login-required'
  | 'captcha'
  | 'parse-changed'
  | 'robots-disallowed'
  | 'security-rejected'
  | 'dependency-unavailable'
>;

export type RuleStateAction =
  | { kind: 'user-pause' }
  | { kind: 'user-enable' }
  | { kind: 'source-disable' }
  | { kind: 'source-delete' }
  | { kind: 'source-locator-change' }
  | { kind: 'source-restore' }
  | { kind: 'health-pause'; reason: HealthPauseReason }
  | { kind: 'delete' };

const SOURCE_RECOVERABLE_REASONS: ReadonlySet<PauseReason> = new Set([
  'source-disabled',
  'source-deleted',
]);

function depsOk(deps: RuleDependencyStatus): boolean {
  return deps.sourceExists && deps.sourceEnabled && deps.locatorUnchanged;
}

/**
 * 状态迁移（纯函数）。deleted 为终态：任何 action 一律返回输入本身（安全 no-op）。
 * 返回值是新对象，绝不修改输入。
 */
export function transitionRuleState(
  rule: WatchRuleStateFields,
  action: RuleStateAction,
  deps: RuleDependencyStatus,
): WatchRuleStateFields {
  if (rule.state === 'deleted') return rule;
  switch (action.kind) {
    case 'user-pause':
      return { state: 'paused', pauseReason: 'user', desiredEnabled: false };
    case 'user-enable': {
      if (rule.state === 'enabled') return rule;
      // 只从用户暂停（或空原因）恢复：健康/依赖原因（login-required/captcha/
      // robots-disallowed/security-rejected/parse-changed/依赖不可用）需专门恢复
      // 流程（§7 立即暂停、用户无 override 语义），普通 enable 不解除。
      const recoverable = rule.pauseReason === 'user' || rule.pauseReason === null;
      if (depsOk(deps) && recoverable) {
        return { state: 'enabled', pauseReason: null, desiredEnabled: true };
      }
      if (!depsOk(deps)) {
        // 依赖不满足：不得进入 enabled；记录用户意图并标出实际阻断原因
        const reason: PauseReason = deps.locatorUnchanged ? 'source-disabled' : 'source-changed';
        return { state: 'paused', pauseReason: reason, desiredEnabled: true };
      }
      // deps 满足但当前是健康/依赖原因：只记录用户意图，保持阻断原因
      return { ...rule, desiredEnabled: true };
    }
    case 'source-disable':
      // 已在暂停（用户/健康/其他）不覆盖原因；desiredEnabled 永不被覆盖（决策 9）
      return rule.state === 'paused'
        ? rule
        : { state: 'paused', pauseReason: 'source-disabled', desiredEnabled: rule.desiredEnabled };
    case 'source-delete':
      return rule.state === 'paused'
        ? rule
        : { state: 'paused', pauseReason: 'source-deleted', desiredEnabled: rule.desiredEnabled };
    case 'source-locator-change':
      return rule.state === 'paused'
        ? rule
        : { state: 'paused', pauseReason: 'source-changed', desiredEnabled: rule.desiredEnabled };
    case 'source-restore': {
      // 决策 10：仅 desiredEnabled=true 且非用户暂停、locator 未变化、其他依赖满足
      if (!rule.desiredEnabled) return rule;
      if (!SOURCE_RECOVERABLE_REASONS.has(rule.pauseReason ?? 'user')) return rule;
      if (!depsOk(deps)) return rule;
      return { state: 'enabled', pauseReason: null, desiredEnabled: true };
    }
    case 'health-pause':
      return {
        state: 'paused',
        pauseReason: action.reason,
        desiredEnabled: rule.desiredEnabled,
      };
    case 'delete':
      return { state: 'deleted', pauseReason: null, desiredEnabled: false };
    default:
      // 未来 action 安全 no-op（防御；type 闭合下不可达）
      return rule;
  }
}

// ---------------------------------------------------------------------------
// Source 生命周期协调（§10.3 步骤 4/5；决策 9–12）
// ---------------------------------------------------------------------------

export interface WatchRuleCoordinationFields extends WatchRuleStateFields {
  sourceRowVersion: number;
  sourceLocatorFingerprint: string;
}

/**
 * locator 身份（§10.3 公式）：
 * SHA-256(utf8("watch-locator-v1\0" + sourceId + "\0" + scope + "\0" + canonicalKey
 *             + "\0" + kind + "\0" + canonicalTargetUrl))
 * 确定性、零 IO。canonicalTargetUrl 为 FeedTarget.feedUrl 或 Page Rule 建立时的
 * 规范化目标 URL；fragment/display-only 变化不改变身份。
 */
export function computeSourceLocatorFingerprint(input: {
  sourceId: string;
  scope: SourceScope;
  canonicalKey: string;
  kind: WatchRuleKind;
  canonicalTargetUrl: string;
}): string {
  const raw =
    'watch-locator-v1\u0000' +
    input.sourceId +
    '\u0000' +
    input.scope +
    '\u0000' +
    input.canonicalKey +
    '\u0000' +
    input.kind +
    '\u0000' +
    input.canonicalTargetUrl;
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * 提交后/运行前协调（§10.3 步骤 4/5 的确定性状态部分）：用实际 Source 窄投影 +
 * 重算的 currentLocatorFingerprint 协调 Rule。
 * - deleted 恒 no-op；
 * - fingerprint 不同 → 暂停 source-changed（保留旧指纹等待 rebaseline，不可自动恢复）；
 * - fingerprint 相同 → 只更新 sourceRowVersion；Source disabled → 暂停 source-disabled；
 *   Source enabled → 走 source-restore（desiredEnabled=true 且 source 原因自动 enabled，
 *   用户 pause 永不自动恢复）；
 * - Source 不存在 → 暂停 source-deleted。
 */
export function coordinateSourceRule(
  rule: WatchRuleCoordinationFields,
  source: { exists: boolean; enabled: boolean; rowVersion: number },
  currentLocatorFingerprint: string,
): WatchRuleCoordinationFields {
  if (rule.state === 'deleted') return rule;
  if (!source.exists) {
    return {
      ...transitionRuleState(
        rule,
        { kind: 'source-delete' },
        {
          sourceExists: false,
          sourceEnabled: false,
          locatorUnchanged: true,
        },
      ),
      sourceRowVersion: rule.sourceRowVersion,
      sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
    };
  }
  const locatorChanged = currentLocatorFingerprint !== rule.sourceLocatorFingerprint;
  if (locatorChanged) {
    return {
      ...transitionRuleState(
        rule,
        { kind: 'source-locator-change' },
        {
          sourceExists: true,
          sourceEnabled: source.enabled,
          locatorUnchanged: false,
        },
      ),
      // 记录最后观察到的行版本；旧 fingerprint 保留，等待 rebaseline 更新
      sourceRowVersion: source.rowVersion,
      sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
    };
  }
  const base: WatchRuleCoordinationFields = {
    ...rule,
    sourceRowVersion: source.rowVersion,
  };
  const keepCoordination = (next: WatchRuleStateFields): WatchRuleCoordinationFields => ({
    ...next,
    sourceRowVersion: base.sourceRowVersion,
    sourceLocatorFingerprint: base.sourceLocatorFingerprint,
  });
  if (!source.enabled) {
    return keepCoordination(
      transitionRuleState(
        base,
        { kind: 'source-disable' },
        { sourceExists: true, sourceEnabled: false, locatorUnchanged: true },
      ),
    );
  }
  return keepCoordination(
    transitionRuleState(
      base,
      { kind: 'source-restore' },
      { sourceExists: true, sourceEnabled: true, locatorUnchanged: true },
    ),
  );
}

// 导出闭合枚举（供上层/测试直接引用，避免魔法字符串）。
export const VALID_RULE_STATES: readonly WatchRuleState[] = WATCH_RULE_STATES;
export const VALID_PAUSE_REASONS: readonly PauseReason[] = PAUSE_REASONS;
