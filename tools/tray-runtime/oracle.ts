import { isAbsolute, relative, sep } from 'node:path';

export const REQUEST_LIMIT = 64;

export interface RequestBudget {
  receivedRequests: number;
  rejectedRequests: number;
  budgetExceeded: boolean;
}

export function recordRequest(budget: RequestBudget): boolean {
  budget.receivedRequests += 1;
  if (budget.receivedRequests <= REQUEST_LIMIT) return true;
  budget.rejectedRequests += 1;
  budget.budgetExceeded = true;
  return false;
}

export function requestBudgetPassed(budget: RequestBudget): boolean {
  return (
    Number.isSafeInteger(budget.receivedRequests) &&
    budget.receivedRequests >= 0 &&
    budget.receivedRequests <= REQUEST_LIMIT &&
    budget.rejectedRequests === 0 &&
    budget.budgetExceeded === false
  );
}

export const REQUIRED_FACTS = {
  write: [
    'isolatedProfile',
    'orderlyShutdown',
    'defaultDisabled',
    'settingEnabledThroughUi',
    'nativeTrayCreated',
    'hiddenWindowPreserved',
    'scheduledEventWhileHidden',
    'laterScheduledEventWhileHidden',
    'sameWindowAndTabRestored',
    'menuQuitRequested',
    'nativeTrayDestroyed',
  ],
  reopen: [
    'isolatedProfile',
    'orderlyShutdown',
    'enabledPreferencePersisted',
    'hiddenAfterRestart',
    'disabledThroughUi',
    'disabledCloseRequested',
    'nativeTrayDestroyed',
  ],
  disabled: [
    'isolatedProfile',
    'orderlyShutdown',
    'disabledPreferencePersisted',
    'defaultCloseRequested',
  ],
} as const;

export function isStrictChild(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function validatePhase(
  value: unknown,
  expected: 'write' | 'reopen' | 'disabled' | 'resume-ui' | 'resume-reopen' | 'resume-disabled',
): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['报告形状非法'];
  const report = value as Record<string, unknown>;
  const failures: string[] = [];
  if (report['phase'] !== expected) failures.push('阶段身份不符');
  if (report['passed'] !== true || report['willQuit'] !== true) failures.push('未通过或未正常退出');
  if (report['error'] !== null) failures.push('存在运行错误');
  const facts = report['facts'];
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts))
    return [...failures, '缺少事实'];
  const required =
    expected === 'resume-ui'
      ? [
          'isolatedProfile',
          'orderlyShutdown',
          'nativeTrayDestroyed',
          'rulesPaused',
          'sameWindowAndTabRestored',
          'menuQuitRequested',
          'networkZero',
        ]
      : REQUIRED_FACTS[
          expected === 'resume-reopen'
            ? 'reopen'
            : expected === 'resume-disabled'
              ? 'disabled'
              : expected
        ];
  if (expected.startsWith('resume-') && (facts as Record<string, unknown>)['networkZero'] !== true)
    failures.push('新增网络请求或未观测');
  for (const name of required) {
    if ((facts as Record<string, unknown>)[name] !== true) failures.push(`缺少通过证据：${name}`);
  }
  return failures;
}

export function validateCoalescedCycle(value: unknown): string[] {
  try {
    if (value === null || typeof value !== 'object') throw new Error('形状非法');
    const data = value as Record<string, unknown>;
    const rows = (key: string): Record<string, unknown>[] => {
      const v = data[key];
      if (
        !Array.isArray(v) ||
        v.some((x) => x === null || typeof x !== 'object' || Array.isArray(x))
      )
        throw new Error('缺少行');
      return v as Record<string, unknown>[];
    };
    const rules = rows('rules'),
      runs = rows('runs'),
      events = rows('events'),
      observations = rows('observations'),
      evidence = rows('evidence'),
      baseline = rows('baseline');
    if (
      rules.length !== 1 ||
      runs.length !== 2 ||
      events.length !== 1 ||
      observations.length !== 2 ||
      evidence.length !== 2 ||
      baseline.length !== 1
    )
      throw new Error('事实数量不符');
    const ruleId = rules[0]!['id'],
      eventId = events[0]!['id'];
    if (typeof ruleId !== 'string' || typeof eventId !== 'string') throw new Error('身份非法');
    let previousAfterHash: string | null = null;
    for (let i = 0; i < 2; i++) {
      const run = runs[i]!;
      const outcome = JSON.parse(String(run['outcome_json'])) as Record<string, unknown>;
      if (
        run['rule_id'] !== ruleId ||
        run['trigger'] !== 'scheduled' ||
        run['status'] !== 'finished' ||
        outcome['eventId'] !== eventId ||
        outcome['kind'] !== (i === 0 ? 'event-created' : 'event-coalesced')
      )
        throw new Error('运行与事件不对应');
      const observation = observations.find((x) => x['sequence'] === i);
      if (!observation || observation['event_id'] !== eventId || observation['item_count'] !== 1)
        throw new Error('观察关系错误');
      const item = evidence.find((x) => x['observation_id'] === observation['id']);
      if (!item || item['event_id'] !== eventId) throw new Error('证据关系错误');
      const before = JSON.parse(String(item['before_value_json'])) as Record<string, unknown>;
      const after = JSON.parse(String(item['after_value_json'])) as Record<string, unknown>;
      if (
        typeof before['valueHash'] !== 'string' ||
        typeof after['valueHash'] !== 'string' ||
        (previousAfterHash !== null && before['valueHash'] !== previousAfterHash)
      )
        throw new Error('中间值哈希不连续');
      previousAfterHash = after['valueHash'];
      if (
        before['kind'] !== 'present' ||
        after['kind'] !== 'present' ||
        !String(before['excerpt']).includes(i === 0 ? '版本A' : '版本B') ||
        !String(after['excerpt']).includes(i === 0 ? '版本B' : '版本C')
      )
        throw new Error('typed pair不完整');
    }
    const projection = JSON.parse(String(baseline[0]!['projection_json'])) as Record<
      string,
      unknown
    >;
    const fields = projection['fields'];
    if (
      projection['type'] !== 'page' ||
      !Array.isArray(fields) ||
      !fields.some(
        (field) =>
          typeof field === 'object' &&
          field !== null &&
          typeof (field as Record<string, unknown>)['value'] === 'string' &&
          String((field as Record<string, unknown>)['value']).includes('版本C'),
      )
    )
      throw new Error('基线字段非法');
    if (
      events[0]!['rule_id'] !== ruleId ||
      events[0]!['item_count'] !== 2 ||
      baseline[0]!['rule_id'] !== ruleId ||
      baseline[0]!['version'] !== 3
    )
      throw new Error('最终事件或基线不符');
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : '回放形状非法'];
  }
}
