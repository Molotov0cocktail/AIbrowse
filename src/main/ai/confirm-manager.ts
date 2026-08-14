// 确认状态机（A2）。契约源：doc/stage3/detailed-design.md §7.2 + threat-model §3.3：
// L2 动作进入 pending → 用户 approve/deny；每 run 同时至多一个 pending（步进式状态机
// 天然保证）；未知/已终结 id 安全返回 false；cancelAll 作废（run 取消/超时）；幂等；
// 无自动批准（确认等待计入 Agent 总超时由 A5 执行）。
export interface ConfirmSummary {
  url?: string;
  elementText?: string;
  detail: string; // 确定性事实（程序组装，文案不来自模型或网页）
}

export interface ConfirmRequest {
  runId: string; // A5 传 requestId
  toolCallId: string;
  toolName: string;
  summary: ConfirmSummary;
  createdAt: number; // 主进程盖章
}

export type ConfirmOutcome = 'approved' | 'denied' | 'cancelled';

export class ConfirmManager {
  private pending: ConfirmRequest | null = null;
  private settle: ((outcome: ConfirmOutcome) => void) | null = null;

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
      const settle = this.settle;
      this.settle = null;
      this.pending = null;
      settle?.('cancelled');
    }
  }

  getPending(): ConfirmRequest | null {
    return this.pending;
  }

  isPending(toolCallId: string): boolean {
    return this.pending !== null && this.pending.toolCallId === toolCallId;
  }

  // 未知 id / 已终结 id → 安全返回 false（不抛异常）；同一 id 二次决议 → false（幂等）
  private settlePending(toolCallId: string, outcome: ConfirmOutcome): boolean {
    if (this.pending === null || this.pending.toolCallId !== toolCallId) {
      return false;
    }
    const settle = this.settle;
    this.settle = null;
    this.pending = null;
    settle?.(outcome);
    return true;
  }
}
