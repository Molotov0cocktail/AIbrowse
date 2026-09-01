// Sixth Stage D10: 有限真实 Watch 场景的 manifest、门控与安全台账纯逻辑。
// 默认确定性 smoke 不调用互联网或 Provider；真实 runner 只消费本文件定义的场景。

export type WatchLiveScenarioKind = 'public-network' | 'provider' | 'windows' | 'resource';

export interface WatchLiveScenario {
  id: string;
  kind: WatchLiveScenarioKind;
  purpose: string;
  targetClass: string;
  maxRequests: number;
}

export const WATCH_LIVE_SCENARIO_MANIFEST: readonly WatchLiveScenario[] = [
  {
    id: 'wl-public-rss',
    kind: 'public-network',
    purpose: '观察真实公开 RSS/Atom 兼容性与 Feed health',
    targetClass: 'public-rss-or-atom',
    maxRequests: 2,
  },
  {
    id: 'wl-robots',
    kind: 'public-network',
    purpose: '观察真实 robots 响应、边界与站点访问限制',
    targetClass: 'public-robots',
    maxRequests: 2,
  },
  {
    id: 'wl-redirect',
    kind: 'public-network',
    purpose: '观察真实公开重定向逐跳校验与 HTTP 分类',
    targetClass: 'public-redirect',
    maxRequests: 3,
  },
  {
    id: 'wl-provider-digest',
    kind: 'provider',
    purpose: '凭据可用时执行一次最小 Digest explanation 兼容性观察',
    targetClass: 'digest-provider',
    maxRequests: 1,
  },
  {
    id: 'wl-windows-notification',
    kind: 'windows',
    purpose: '条件满足时观察已打包 Windows identity 的通知资格',
    targetClass: 'packaged-windows-identity',
    maxRequests: 0,
  },
  {
    id: 'wl-resource-probe',
    kind: 'resource',
    purpose: '在固定采样窗口观察 CPU/内存/句柄/临时目录退出清理',
    targetClass: 'bounded-runtime-resource',
    maxRequests: 0,
  },
];

export type WatchLiveResultKind =
  | 'pass'
  | 'skipped-credential-unavailable'
  | 'skipped-not-packaged'
  | 'skipped-not-windows'
  | 'failed-network'
  | 'failed-provider'
  | 'failed-fixture'
  | 'failed-product'
  | 'not-run';

export interface WatchLiveLedgerEntry {
  scenario: string;
  requestCount: number;
  resultKind: WatchLiveResultKind;
  httpClass: string;
  purpose: string;
}

export function validateWatchLiveManifest(
  manifest: readonly WatchLiveScenario[] = WATCH_LIVE_SCENARIO_MANIFEST,
): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const scenario of manifest) {
    if (seen.has(scenario.id)) errors.push(`${scenario.id}：场景重复`);
    seen.add(scenario.id);
    if (scenario.id.trim() === '') errors.push('场景 id 不得为空');
    if (scenario.purpose.trim() === '') errors.push(`${scenario.id}：用途不得为空`);
    if (scenario.targetClass.trim() === '') errors.push(`${scenario.id}：目标类别不得为空`);
    if (!Number.isSafeInteger(scenario.maxRequests) || scenario.maxRequests < 0) {
      errors.push(`${scenario.id}：请求上限非法`);
    }
    if (
      scenario.kind !== 'public-network' &&
      scenario.kind !== 'provider' &&
      scenario.kind !== 'windows' &&
      scenario.kind !== 'resource'
    ) {
      errors.push(`${scenario.id}：场景类别非法`);
    }
  }
  return errors;
}

export function validateWatchLiveExecution(
  manifest: readonly WatchLiveScenario[],
  executedIds: readonly string[],
): string[] {
  const errors: string[] = [];
  const ids = new Set(manifest.map((scenario) => scenario.id));
  const seen = new Set<string>();
  for (const id of executedIds) {
    if (!ids.has(id)) errors.push(`${id}：未知场景`);
    if (seen.has(id)) errors.push(`${id}：重复执行`);
    seen.add(id);
  }
  for (const id of ids) if (!seen.has(id)) errors.push(`${id}：未执行`);
  return errors;
}

export function classifyWatchLiveFailure(input: {
  status?: number;
  errorCode?: string;
  credentialAvailable?: boolean;
  packaged?: boolean;
  windows?: boolean;
}): WatchLiveResultKind {
  if (input.credentialAvailable === false) return 'skipped-credential-unavailable';
  if (input.windows === false) return 'skipped-not-windows';
  if (input.packaged === false) return 'skipped-not-packaged';
  if (input.status === 401 || input.status === 403 || input.status === 402)
    return 'failed-provider';
  if (input.status !== undefined && input.status >= 400 && input.status < 500)
    return 'failed-network';
  if (input.status !== undefined && input.status >= 500) return 'failed-network';
  if (input.status !== undefined && input.status >= 200 && input.status < 300) return 'pass';
  if (input.errorCode === 'fixture-defect') return 'failed-fixture';
  if (input.errorCode === 'product-defect') return 'failed-product';
  if (input.errorCode === 'timeout' || input.errorCode === 'network') return 'failed-network';
  return 'not-run';
}

export function describeWatchLiveLedger(entries: readonly WatchLiveLedgerEntry[]): string {
  const total = entries.reduce((sum, entry) => sum + entry.requestCount, 0);
  const summary = entries
    .map(
      (entry) =>
        `${entry.scenario}：${entry.requestCount} 次（${entry.resultKind}；${entry.httpClass}）`,
    )
    .join('；');
  return `真实 Watch 场景 ${entries.length} 项；请求共 ${total} 次——${summary}`;
}

export function validateWatchLiveLedger(
  entries: readonly WatchLiveLedgerEntry[],
  manifest: readonly WatchLiveScenario[] = WATCH_LIVE_SCENARIO_MANIFEST,
): string[] {
  const errors: string[] = [];
  const byId = new Map(manifest.map((scenario) => [scenario.id, scenario]));
  const seen = new Set<string>();
  for (const entry of entries) {
    const scenario = byId.get(entry.scenario);
    if (scenario === undefined) {
      errors.push(`${entry.scenario}：不在 live manifest`);
      continue;
    }
    if (seen.has(entry.scenario)) errors.push(`${entry.scenario}：台账重复`);
    seen.add(entry.scenario);
    if (!Number.isSafeInteger(entry.requestCount) || entry.requestCount < 0) {
      errors.push(`${entry.scenario}：请求次数非法`);
    } else if (entry.requestCount > scenario.maxRequests) {
      errors.push(`${entry.scenario}：超过请求上限`);
    }
    if (entry.purpose.trim() === '' || entry.httpClass.trim() === '') {
      errors.push(`${entry.scenario}：台账字段不得为空`);
    }
  }
  return errors;
}
