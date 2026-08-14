// agent-history 纯函数（A5，零 Electron 依赖）：ToolStep 组装（不含 fill 原文/快照正文/
// documentId/allowedKind 等内部能力信息）、assistant toolCalls 脱敏持久化（browser.fill 的
// arguments.text →「（已输入 N 字符）」）、持久化消息组装（每轮文本恰好落盘一次，无重复拼接）、
// 完整交互组校验与跨 run 重放（tool 消息只重放摘要；不完整组/孤立 tool 消息整体过滤）。
// 契约源：doc/stage3/detailed-design.md §9.1/§9.3 + 决议 #33。
import type {
  ProviderMessage,
  ProviderToolCall,
  ConversationMessage,
  NormalizedErrorCode,
} from '../../../shared/types/conversation';
import type {
  AgentRunSummary,
  ToolResult,
  ToolResultErrorCode,
  ToolStep,
  ToolStepDecision,
} from '../../../shared/types/agent';
import {
  CONTEXT_BUDGET,
  TRUNCATION_MARK,
  renderHistoryMessageContent,
  truncateWithMark,
  type ContextBudget,
} from '../context-budget';

export const TOOL_STEP_PREVIEW_MAX = 200;

// fill 值脱敏形态（§9.3 隐私红线：只记长度，原文零落盘）
export function FILL_MASK(length: number): string {
  return `（已输入 ${length} 字符）`;
}

function truncatePreview(text: string): string {
  if (text.length <= TOOL_STEP_PREVIEW_MAX) return text;
  return text.slice(0, TOOL_STEP_PREVIEW_MAX - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

// ToolStep 组装（§2.2 精简版）：execution-failed 保留实际权限决策；内部能力参数零出现
// （call.arguments 仅为调用方兼容接受——绝不进入 ToolStep 结构）
export function buildToolStep(
  call: { id: string; name: string; arguments?: string },
  result: ToolResult,
  decision: ToolStepDecision,
  now: number,
): ToolStep {
  return {
    id: call.id, // 与 toolCallId 恒等（协议关联键）
    toolCallId: call.id,
    name: call.name,
    ok: result.ok,
    contentPreview: truncatePreview(result.content),
    ...(result.ok || result.errorCode === undefined
      ? {}
      : { errorCode: result.errorCode as ToolResultErrorCode }),
    decision,
    createdAt: now,
  };
}

// assistant toolCalls 脱敏（持久化前调用）：browser.fill 的 text → FILL_MASK(len)；
// 其余工具 arguments 原样（read 的 tabId/search 的 query 等为模型回显，属可持久化形态）；
// 非法 JSON 原样保留（不抛异常）。
export function sanitizeToolCallsForPersistence(toolCalls: ProviderToolCall[]): ProviderToolCall[] {
  return toolCalls.map((call) => {
    if (call.name !== 'browser.fill') return call;
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.arguments);
    } catch {
      return call;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return call;
    const record = parsed as Record<string, unknown>;
    if (typeof record.text === 'string') {
      record.text = FILL_MASK(record.text.length);
    }
    return { ...call, arguments: JSON.stringify(record) };
  });
}

// ---------- 持久化消息组装（每轮文本恰好落盘一次，无重复拼接） ----------

export function buildToolStepMessage(input: {
  id: string;
  step: ToolStep;
  now: number;
}): ConversationMessage {
  return {
    id: input.id,
    role: 'tool',
    toolCallId: input.step.toolCallId, // 协议关联键（对应轮次 assistant.toolCalls）
    content: input.step.contentPreview, // 持久化内容 = 摘要（决议 #26：跨 run 重放只回摘要）
    createdAt: input.now,
    status: 'complete',
    toolStep: input.step,
  };
}

export function buildRoundAssistantMessage(input: {
  id: string;
  text: string; // 该轮模型文本（过程性输出；可为空）
  toolCalls: ProviderToolCall[];
  now: number;
}): ConversationMessage {
  return {
    id: input.id,
    role: 'assistant',
    content: input.text,
    createdAt: input.now,
    status: 'complete',
    ...(input.toolCalls.length > 0
      ? { toolCalls: sanitizeToolCallsForPersistence(input.toolCalls) }
      : {}),
  };
}

// 终态 assistant 消息（§8.5）：finalText + AgentRunSummary；终止轮未执行的 toolCalls 可携带
// （脱敏；未执行调用不伪造结果——缺 tool 消息的不完整组由重放过滤器整体丢弃）
export function buildFinalAgentMessage(input: {
  id: string;
  text: string;
  status: 'complete' | 'aborted' | 'error';
  errorCode?: NormalizedErrorCode;
  toolCalls?: ProviderToolCall[];
  agentRun: AgentRunSummary;
  now: number;
}): ConversationMessage {
  const message: ConversationMessage = {
    id: input.id,
    role: 'assistant',
    content: input.text,
    createdAt: input.now,
    status: input.status,
    agentRun: input.agentRun,
  };
  if (input.status === 'error' && input.errorCode !== undefined) {
    message.errorCode = input.errorCode;
  }
  if (input.toolCalls !== undefined && input.toolCalls.length > 0) {
    message.toolCalls = sanitizeToolCallsForPersistence(input.toolCalls);
  }
  return message;
}

// ---------- 完整交互组校验（决议 #33：持久化/重放不允许孤立 tool 消息或残缺组） ----------

// 组 = assistant（toolCalls）+ 紧随其后的连续 tool 消息。组完整 = tool 消息恰好覆盖全部
// toolCallId 且同序、无重复。不完整组整组丢弃；孤立 tool 消息（无前导 assistant 组）丢弃。
export function filterIncompleteToolGroups(messages: ConversationMessage[]): {
  kept: ConversationMessage[];
  dropped: number;
} {
  const kept: ConversationMessage[] = [];
  let dropped = 0;
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      const ids = message.toolCalls.map((c) => c.id);
      let j = i + 1;
      const tools: ConversationMessage[] = [];
      while (j < messages.length && messages[j].role === 'tool') {
        tools.push(messages[j]);
        j += 1;
      }
      const complete =
        ids.length === tools.length && tools.every((t, k) => t.toolCallId === ids[k]);
      if (complete) {
        kept.push(message, ...tools);
      } else {
        dropped += 1 + tools.length; // 不完整组整组丢弃（fail-closed 不错误确认）
      }
      i = j;
    } else if (message.role === 'tool') {
      dropped += 1; // 孤立 tool 消息（无前导 assistant 组对应）
      i += 1;
    } else {
      kept.push(message);
      i += 1;
    }
  }
  return { kept, dropped };
}

// 跨 run 重放（§9.1 + 决议 #33）：① 完整交互组过滤；② 按完整组从最近裁剪到 historyMaxChars
// （不产生孤立/残缺组）；③ 映射 ProviderMessage——user 带来源行（renderHistoryMessageContent
// 同纪律）、assistant 文本 + toolCalls 重放（脱敏形态）、tool 只重放摘要（决议 #26）。
export function replayToProviderMessages(
  messages: ConversationMessage[],
  budget: ContextBudget = CONTEXT_BUDGET,
): ProviderMessage[] {
  const filtered = filterIncompleteToolGroups(messages);
  if (filtered.dropped > 0) {
    // 调用方（Store 解析/Service 重放）负责 warn；纯函数只保证结果合法
  }
  // 按完整组拆分（assistant toolCalls 与其 tool 消息同组；其余单条一组）
  const groups: ConversationMessage[][] = [];
  let i = 0;
  while (i < filtered.kept.length) {
    const message = filtered.kept[i];
    if (message.role === 'assistant' && message.toolCalls !== undefined) {
      let j = i + 1;
      while (j < filtered.kept.length && filtered.kept[j].role === 'tool') j += 1;
      groups.push(filtered.kept.slice(i, j));
      i = j;
    } else {
      groups.push([message]);
      i += 1;
    }
  }
  // 从最近保留完整组（字符预算；渲染长度与重放一致）
  const rendered = (m: ConversationMessage): string => renderHistoryMessageContent(m, budget);
  const keptGroups: ConversationMessage[][] = [];
  let chars = 0;
  for (let g = groups.length - 1; g >= 0; g--) {
    const groupChars = groups[g].reduce((sum, m) => sum + rendered(m).length, 0);
    if (chars + groupChars > budget.historyMaxChars) break;
    chars += groupChars;
    keptGroups.unshift(groups[g]);
  }
  const keptMessages = keptGroups.flat();
  return keptMessages.map((m) => {
    if (m.role === 'user') {
      return { role: 'user', content: rendered(m) };
    }
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: truncateWithMark(m.content, budget.replayMessageMaxChars),
        ...(m.toolCalls !== undefined ? { toolCalls: m.toolCalls } : {}),
      };
    }
    return {
      role: 'tool',
      toolCallId: m.toolCallId ?? '',
      content: truncateWithMark(m.content, budget.replayMessageMaxChars),
    };
  });
}
