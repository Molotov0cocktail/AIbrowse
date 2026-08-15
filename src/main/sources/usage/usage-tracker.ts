// Fourth Stage B6：usage/health 接线（决议 #79：SourceSearchHintStore 每 run 独立 +
// Agent 实际打开后的 usage 写入归 B6；B7 保留 UI 展示与存储运维边界）。契约源：
// doc/stage4/detailed-design.md §11 + high-level-design §4.4 + 决议 Q10。
// - SourceSearchHintStore：按 runId 键控的命中登记（source_search 成功后的结构化结果
//   由主进程侧登记；模型不可写）。确定性有界（MAX_HINTS_PER_RUN，FIFO 淘汰最旧）、
//   按 sourceId 去重（首现保持）、跨 run 隔离；禁止全局共享（唯一 Map 按 runId 分区）、
//   后台巡检（零 timer）与网络请求（零网络 import/调用）。
// - SourceUsageTracker：hint store + usage 写入的组装层（run 级 bridge 工厂）。比对用
//   既有 normalizeSourceUrl（origin/page 各自规范化后按 scope 匹配 canonicalKey；
//   一个 URL 同时命中 origin/page → 全部去重命中逐一记录）；成功 → reachable、
//   执行失败 → unreachable；无关 URL/先 open 后 search/跨 run/终态后清空 → 零写入。
//   写入失败仅脱敏告警（只记 sourceId，note/URL/query 零出现）并安全 no-op——绝不改变
//   browser_open 的 ToolResult/权限/Agent 终态。
import { normalizeSourceUrl } from '../domain/source-canonical';
import type {
  SourceUsageContext,
  SourceUsageHit,
  SourceUsageOutcome,
} from '../../../shared/types/sources';
import { logWarn } from '../../logger';

// 每 run 上限 = source_search 硬上限 10 × Agent 步数上限 12 的最坏情况（确定性有界）。
export const MAX_HINTS_PER_RUN = 120;

interface RunHints {
  hits: SourceUsageHit[]; // 按 sourceId 去重后的有序登记（首现保持）
}

export class SourceSearchHintStore {
  private readonly runs = new Map<string, RunHints>();

  // 同 run 累积登记（多轮 source_search 追加）；按 sourceId 去重（首现保持）；
  // 超限 FIFO 淘汰最旧（确定性上界，无未说明的无界增长）。
  recordHits(runId: string, hits: readonly SourceUsageHit[]): void {
    const run: RunHints = this.runs.get(runId) ?? { hits: [] };
    for (const hit of hits) {
      if (run.hits.some((h) => h.sourceId === hit.sourceId)) continue;
      run.hits.push(hit);
      if (run.hits.length > MAX_HINTS_PER_RUN) run.hits.shift();
    }
    if (run.hits.length > 0) this.runs.set(runId, run);
  }

  // 打开 URL 与同 run 命中比对：URL 分别按 page/origin 规范化后与对应 scope 的
  // canonicalKey 精确匹配（fragment/默认端口等规范化变体命中；query 差异不命中——
  // 保守规范化保留 query）。一个 URL 同时命中已命中的 origin/page Source → 返回
  // 全部去重命中；规范化失败/无关 URL/无命中/无该 run → 空数组（安全返回不抛异常）。
  matchOpenUrl(runId: string, rawUrl: string): SourceUsageHit[] {
    const run = this.runs.get(runId);
    if (run === undefined) return [];
    const page = normalizeSourceUrl(rawUrl, 'page');
    const origin = normalizeSourceUrl(rawUrl, 'origin');
    const pageKey = page.ok ? page.canonicalKey : null;
    const originKey = origin.ok ? origin.canonicalKey : null;
    const matched: SourceUsageHit[] = [];
    for (const hit of run.hits) {
      const key = hit.scope === 'page' ? pageKey : originKey;
      if (key !== null && hit.canonicalKey === key) matched.push(hit);
    }
    return matched;
  }

  // 终态清理（取消/超时/终态后 hints 清空——迟到工具结果零写入）。
  clearRun(runId: string): void {
    this.runs.delete(runId);
  }

  dispose(): void {
    this.runs.clear();
  }
}

export type SourceUsageWriter = (
  sourceId: string,
  outcome: SourceUsageOutcome,
) => void | Promise<void>;

export class SourceUsageTracker {
  private readonly store = new SourceSearchHintStore();

  // writer 为装配层注入（index.ts 传 SourceService.recordUsage 绑定；null = 无
  // SourceService → 零写入零抛出）。
  constructor(private readonly writer: SourceUsageWriter | null) {}

  // run 级桥（装配层每 run 创建一次，绑定 runId）——recordSearchHits/onBrowserOpen/
  // clearRun 为闭包，模型/工具无任何通道指定或跨 run；AgentLoop 终态调用 clearRun。
  bridge(runId: string): SourceUsageContext {
    return {
      recordSearchHits: (hits) => this.store.recordHits(runId, hits),
      onBrowserOpen: (url, ok) => this.handleOpen(runId, url, ok),
      clearRun: () => this.store.clearRun(runId),
    };
  }

  clearRun(runId: string): void {
    this.store.clearRun(runId);
  }

  dispose(): void {
    this.store.dispose();
  }

  private handleOpen(runId: string, url: string, ok: boolean): void {
    for (const hit of this.store.matchOpenUrl(runId, url)) {
      this.writeOutcome(hit.sourceId, ok ? 'reachable' : 'unreachable');
    }
  }

  // 写入失败（同步抛/异步 reject）仅脱敏告警并安全 no-op——绝不向调用方抛出
  // （不改变 browser_open 的 ToolResult/权限/Agent 终态）；日志只记 sourceId。
  private writeOutcome(sourceId: string, outcome: SourceUsageOutcome): void {
    if (this.writer === null) return;
    try {
      const result = this.writer(sourceId, outcome);
      if (typeof result === 'object' && result !== null && typeof result.then === 'function') {
        void result.catch((err: unknown) => {
          logWarn('sources', `usage 写入失败（已忽略，不影响工具结果；sourceId=${sourceId}）`, err);
        });
      }
    } catch (err) {
      logWarn('sources', `usage 写入失败（已忽略，不影响工具结果；sourceId=${sourceId}）`, err);
    }
  }
}
