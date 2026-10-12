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

export function validatePhase(value: unknown, expected: 'write' | 'reopen' | 'disabled'): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ['报告形状非法'];
  const report = value as Record<string, unknown>;
  const failures: string[] = [];
  if (report['phase'] !== expected) failures.push('阶段身份不符');
  if (report['passed'] !== true || report['willQuit'] !== true) failures.push('未通过或未正常退出');
  if (report['error'] !== null) failures.push('存在运行错误');
  const facts = report['facts'];
  if (facts === null || typeof facts !== 'object' || Array.isArray(facts))
    return [...failures, '缺少事实'];
  for (const name of REQUIRED_FACTS[expected]) {
    if ((facts as Record<string, unknown>)[name] !== true) failures.push(`缺少通过证据：${name}`);
  }
  return failures;
}
