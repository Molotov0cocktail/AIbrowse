// 确认状态机（A2）。契约源：doc/stage3/detailed-design.md §7.2 + threat-model §3.3：
// L2 动作进入 pending → 用户 approve/deny；每 run 同时至多一个 pending（步进式状态机
// 天然保证）；未知/已终结 id 安全返回 false；cancelAll 作废（run 取消/超时）；幂等；
// 无自动批准（确认等待计入 Agent 总超时由 A5 执行）。
import type { AgentConfirmOutcome } from '../../shared/types/agent';

export interface ConfirmSummary {
  url?: string;
  elementText?: string; // 页面提供的目标文本（不可信输入，A6 确认 UI 纯文本渲染 + 清理）
  detail: string; // 确定性事实（程序组装，文案不来自模型或网页）
}

export interface ConfirmRequest {
  runId: string; // A5 传 requestId
  toolCallId: string;
  toolName: string;
  summary: ConfirmSummary;
  createdAt: number; // 主进程盖章
}

// 决议结果单一事实源在 shared/types/agent.ts（renderer 事件 payload 复用）
export type ConfirmOutcome = AgentConfirmOutcome;

// pending 变化判别联合（A5 可见性事件源 + A6 扩展）：'pending'=请求建立（可见性 UI
// 打开确认框）；'settled'=决议/作废（携带 outcome——approve/deny/cancelled），供
// confirm-resolved 状态事件与确认框自动关闭使用。
export type PendingChange =
  | { kind: 'pending'; request: ConfirmRequest }
  | { kind: 'settled'; runId: string; toolCallId: string; outcome: ConfirmOutcome };

export class ConfirmManager {
  private pending: ConfirmRequest | null = null;
  private settle: ((outcome: ConfirmOutcome) => void) | null = null;
  // A6：多监听者 Set（关闭 A5 计划内限制——「回调所有权为最后构造的 Service 实例」）：
  // 每个 ConversationService 注册自己的监听（映射 runId → sessionId 后经事件出口下发，
  // 各 Service 只对自身在途 run 发出事件，互不串扰）；退订函数支持 dispose 清理。
  // 单 pending 设计下同一时刻至多一个确认请求可见。
  private readonly listeners = new Set<(change: PendingChange) => void>();

  addPendingChangeListener(listener: (change: PendingChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: PendingChange): void {
    for (const listener of this.listeners) listener(change);
  }

  // 建立 pending 并返回决议 Promise。同步段内即建立 pending（调用方随后可 approve/deny）。
  // 单 pending：已有 pending 时新请求立即决议 'denied'（fail-closed 不执行、不覆盖既有
  // pending——正常流程由 A5 步进式状态机保证不并发，此处为防御）。
  requestConfirm(
    runId: string,
    toolCallId: string,
    toolName: string,
    summary: ConfirmSummary,
  ): Promise<ConfirmOutcome> {
    if (this.pending !== null) {
      return Promise.resolve('denied');
    }
    this.pending = { runId, toolCallId, toolName, summary, createdAt: Date.now() };
    this.emit({ kind: 'pending', request: this.pending });
    return new Promise<ConfirmOutcome>((resolve) => {
      this.settle = resolve;
    });
  }

  approve(toolCallId: string): boolean {
    return this.settlePending(toolCallId, 'approved');
  }

  deny(toolCallId: string): boolean {
    return this.settlePending(toolCallId, 'denied');
  }

  // run 取消/超时：作废该 run 的全部 pending（决议 cancelled）。幂等。
  cancelAll(runId: string): void {
    if (this.pending !== null && this.pending.runId === runId) {
      this.emitSettled(this.pending, 'cancelled');
      this.pending = null;
      this.settle = null;
    }
  }

  getPending(): ConfirmRequest | null {
    return this.pending;
  }

  isPending(toolCallId: string): boolean {
    return this.pending !== null && this.pending.toolCallId === toolCallId;
  }

  // 未知 id / 已终结 id → 安全返回 false（不抛异常）；同一 id 二次决议 → false（幂等，
  // 不触发 settled 回调）
  private settlePending(toolCallId: string, outcome: ConfirmOutcome): boolean {
    if (this.pending === null || this.pending.toolCallId !== toolCallId) {
      return false;
    }
    const pending = this.pending;
    this.pending = null;
    this.emitSettled(pending, outcome);
    return true;
  }

  private emitSettled(pending: ConfirmRequest, outcome: ConfirmOutcome): void {
    const settle = this.settle;
    this.settle = null;
    settle?.(outcome);
    this.emit({
      kind: 'settled',
      runId: pending.runId,
      toolCallId: pending.toolCallId,
      outcome,
    });
  }
}
