// Pure history reducer for the AI panel (unit-tested; zero React/Electron deps).
// 历史镜像收敛规则（§6.1/§8.1）：ask 时乐观追加 user 消息（引用链先于生成落地，
// 生成失败时追溯卡片依然可见）；turn-done 时补全该 user 消息的 contextSource
// （TurnDoneEvent 携带该轮引用上下文）并追加终态 assistant 消息。
import type { ContextSource, ConversationMessage } from '../../../shared/types/conversation';

export type HistoryEvent =
  | { type: 'replace'; messages: ConversationMessage[] } // 切换会话时整体替换（getHistory）
  | { type: 'append-user'; message: ConversationMessage } // ask 乐观追加（无 contextSource）
  | { type: 'turn-done'; message: ConversationMessage; contextSource: ContextSource };

export function reduceHistory(
  history: ConversationMessage[],
  event: HistoryEvent,
): ConversationMessage[] {
  switch (event.type) {
    case 'replace':
      return event.messages;
    case 'append-user':
      return [...history, event.message];
    case 'turn-done': {
      // 补全乐观 user 消息的 contextSource（磁盘加载的历史已携带，跳过补全避免覆盖）
      const last = history[history.length - 1];
      const withSource =
        last !== undefined && last.role === 'user' && last.contextSource === undefined
          ? [...history.slice(0, -1), { ...last, contextSource: event.contextSource }]
          : history;
      return [...withSource, event.message];
    }
  }
}
