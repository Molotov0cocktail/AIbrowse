// Sixth Stage D10: 有限真实 Watch 场景的 manifest、门控与安全台账纯逻辑。
// 默认确定性 smoke 不调用互联网或 Provider；真实 runner 只消费本文件定义的场景。

export type WatchLiveScenarioKind = 'public-network' | 'provider' | 'windows' | 'resource';

export interface WatchLiveScenario {
  id: string;
  kind: WatchLiveScenarioKind;
  purpose: string;
  targetClass: string;
  maxRequests: number;
  /** Required for public-network scenarios so the runner cannot silently test a fixture. */
  url?: string;
}

export const WATCH_LIVE_SCENARIO_MANIFEST: readonly WatchLiveScenario[] = [
  {
    id: 'wl-public-rss',
    kind: 'public-network',
    purpose: '观察真实公开 RSS/Atom 兼容性与 Feed health',
    targetClass: 'public-rss-or-atom',
    maxRequests: 2,
    url: 'https://feeds.bbci.co.uk/news/rss.xml',
  },
  {
    id: 'wl-robots',
    kind: 'public-network',
    purpose: '观察真实 robots 响应、边界与站点访问限制',
    targetClass: 'public-robots',
    maxRequests: 2,
    url: 'https://www.rfc-editor.org/robots.txt',
  },
  {
    id: 'wl-redirect',
    kind: 'public-network',
    purpose: '观察真实公开重定向逐跳校验与 HTTP 分类',
    targetClass: 'public-redirect',
    maxRequests: 3,
    url: 'https://httpbin.org/redirect/1',
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
  | 'skipped-windows-condition'
  | 'failed-network'
  | 'failed-provider'
  | 'failed-fixture'
  | 'failed-product'
  | 'blocked-environment'
  | 'not-run';

export type WatchLiveResourceMetricTrend = 'changed' | 'stable';

export interface WatchLiveResourceObservation {
  measurementStartedAtMs: number;
  measurementEndedAtMs: number;
  measurementWindowMs: number;
  drainStartedAtMs: number;
  drainEndedAtMs: number;
  drainWindowMs: number;
  metricSampleCount: number;
  metricTrend: WatchLiveResourceMetricTrend;
  residualSampleCount: number;
  batteryStatus: 'observed' | 'condition-unavailable';
  batterySampleCount: number;
}

export interface WatchLiveLedgerEntry {
  scenario: string;
  requestCount: number;
  resultKind: WatchLiveResultKind;
  httpClass: string;
  purpose: string;
  /** Only Windows probes carry the product/condition classification. */
  classification?: 'pass' | 'condition-unavailable' | 'product-defect';
  /** Resource PASS must carry the bounded pre-shutdown measurement evidence. */
  resourceObservation?: WatchLiveResourceObservation;
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
    if (scenario.kind === 'public-network') {
      if (scenario.url === undefined || !/^https:\/\//.test(scenario.url)) {
        errors.push(`${scenario.id}：公网场景必须提供 HTTPS 目标`);
      }
    }
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
  scenarioKind?: WatchLiveScenarioKind;
  status?: number;
  errorCode?: string;
  credentialAvailable?: boolean;
  packaged?: boolean;
  windows?: boolean;
}): WatchLiveResultKind {
  if (input.credentialAvailable === false) return 'skipped-credential-unavailable';
  if (input.windows === false) return 'skipped-not-windows';
  if (input.packaged === false) return 'skipped-not-packaged';
  if (
    (input.status === 401 || input.status === 403 || input.status === 402) &&
    input.scenarioKind !== 'public-network'
  )
    return 'failed-provider';
  if (input.status !== undefined && input.status >= 400 && input.status < 500)
    return 'failed-network';
  if (input.status !== undefined && input.status >= 500) return 'failed-network';
  if (input.status !== undefined && input.status >= 200 && input.status < 300) return 'pass';
  if (input.errorCode === 'fixture-defect') return 'failed-fixture';
  if (input.errorCode === 'product-defect') return 'failed-product';
  if (input.errorCode === 'provider' || input.errorCode === 'provider-error')
    return 'failed-provider';
  if (input.errorCode === 'environment-unavailable') return 'blocked-environment';
  if (input.errorCode === 'timeout' || input.errorCode === 'network') return 'failed-network';
  return 'not-run';
}

export function describeWatchLiveLedger(entries: readonly WatchLiveLedgerEntry[]): string {
  const total = entries.reduce((sum, entry) => sum + entry.requestCount, 0);
  const summary = entries
    .map(
      (entry) =>
        `${entry.scenario}：${entry.requestCount} 次（${entry.resultKind}；${entry.httpClass}${
          entry.resourceObservation === undefined
            ? ''
            : `；测量 ${entry.resourceObservation.measurementWindowMs}ms/${entry.resourceObservation.metricSampleCount} 样本；排水 ${entry.resourceObservation.drainWindowMs}ms；指标${entry.resourceObservation.metricTrend}；电池${entry.resourceObservation.batteryStatus}/${entry.resourceObservation.batterySampleCount} 样本`
        }）`,
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
    if (entry.resultKind === 'failed-product') {
      errors.push(`${entry.scenario}：产品路径失败，不得报告 live PASS`);
    }
    const requiredLiveObservation =
      scenario.kind === 'public-network' || scenario.kind === 'resource';
    if (requiredLiveObservation && entry.resultKind !== 'pass') {
      errors.push(`${entry.scenario}：真实场景未实际运行`);
    }
    if (
      scenario.kind === 'public-network' &&
      entry.resultKind === 'pass' &&
      entry.requestCount < 1
    ) {
      errors.push(`${entry.scenario}：产品请求台账为空`);
    }
    if (
      scenario.kind === 'provider' &&
      entry.resultKind === 'pass' &&
      entry.requestCount !== scenario.maxRequests
    ) {
      errors.push(`${entry.scenario}：Provider PASS 必须恰好一次真实请求`);
    }
    if (
      scenario.kind === 'provider' &&
      entry.resultKind !== 'pass' &&
      entry.resultKind !== 'skipped-credential-unavailable'
    ) {
      errors.push(`${entry.scenario}：凭据可用但 Provider 真实观察未成功`);
    }
    if (scenario.kind === 'windows') {
      if (entry.resultKind === 'not-run') {
        if (entry.classification !== 'condition-unavailable') {
          errors.push(`${entry.scenario}：Windows 未运行必须明确标记条件不可用`);
        }
      } else if (entry.classification === undefined) {
        errors.push(`${entry.scenario}：Windows 台账缺少产品/条件分类`);
      } else if (
        entry.resultKind === 'skipped-windows-condition' &&
        entry.classification !== 'condition-unavailable'
      ) {
        errors.push(`${entry.scenario}：只有条件不可用才允许 Windows 跳过`);
      } else if (
        entry.resultKind === 'failed-product' &&
        entry.classification !== 'product-defect'
      ) {
        errors.push(`${entry.scenario}：Windows 产品失败分类不一致`);
      } else if (entry.resultKind === 'pass' && entry.classification !== 'pass') {
        errors.push(`${entry.scenario}：Windows PASS 分类不一致`);
      }
    }
    if (scenario.kind === 'resource' && entry.resultKind === 'pass') {
      const observation = entry.resourceObservation;
      if (observation === undefined) {
        errors.push(`${entry.scenario}：资源 PASS 缺少可审计观察证据`);
      } else if (
        !Number.isSafeInteger(observation.measurementStartedAtMs) ||
        !Number.isSafeInteger(observation.measurementEndedAtMs) ||
        !Number.isSafeInteger(observation.measurementWindowMs) ||
        !Number.isSafeInteger(observation.drainStartedAtMs) ||
        !Number.isSafeInteger(observation.drainEndedAtMs) ||
        !Number.isSafeInteger(observation.drainWindowMs) ||
        !Number.isSafeInteger(observation.metricSampleCount) ||
        !Number.isSafeInteger(observation.residualSampleCount) ||
        !Number.isSafeInteger(observation.batterySampleCount) ||
        observation.measurementEndedAtMs < observation.measurementStartedAtMs ||
        observation.drainEndedAtMs < observation.drainStartedAtMs ||
        observation.measurementWindowMs !==
          observation.measurementEndedAtMs - observation.measurementStartedAtMs ||
        observation.drainWindowMs !== observation.drainEndedAtMs - observation.drainStartedAtMs ||
        observation.metricSampleCount < 2 ||
        observation.residualSampleCount < 2 ||
        observation.metricTrend !== 'changed' ||
        observation.batteryStatus !== 'observed' ||
        observation.batterySampleCount < 2
      ) {
        errors.push(`${entry.scenario}：资源 PASS 观察证据不完整或不可信`);
      }
    }
  }
  return errors;
}
