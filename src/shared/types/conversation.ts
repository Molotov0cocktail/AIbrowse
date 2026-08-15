// AI co-reading subsystem shared types (Second Stage, S1).
// Contract source: doc/stage2/detailed-design.md §2 (session/message/context/error codes)
// + §3.3 (provider request/event/metadata) + §3.5 (ProviderConfig). Pure type declarations,
// shared by main/preload/renderer. Note: PageSnapshot bodies are never persisted (§2).
// Provider data types live here (not in main/) so preload/renderer can import them in S4.

// A5：消息扩展字段的类型引用（ToolStep/AgentRunSummary 定义于 agent.ts §2.2）
import type { AgentRunSummary, ToolStep } from './agent';

export type ContextMode = 'selection' | 'snapshot' | 'none';

export interface ContextSource {
  mode: ContextMode;
  tabId: string | null; // Active tab id at capture time
  url: string | null; // Main-process-side url at capture time (never trust page clock/content)
  title: string | null;
  capturedAt: number | null; // Main-process epoch ms; null when no web context
  degraded: boolean; // L1/L2 degradation (meta.degraded !== 'none')
  thin: boolean; // Thin snapshot (§7.4)
  selectionExcerpt: string | null; // selection mode: excerpt ≤ 200 chars (display only)
  warnings: string[]; // Display-oriented Chinese warnings
}

export type ConversationMessageRole = 'user' | 'assistant' | 'tool'; // A5 扩展 role='tool'

export interface ConversationMessage {
  id: string; // crypto.randomUUID()，主进程生成
  role: ConversationMessageRole;
  content: string; // user=question text; assistant=answer text (including aborted part);
  // tool=精简结果摘要（= toolStep.contentPreview，跨 run 重放内容）
  createdAt: number; // Main-process stamp
  status: 'complete' | 'aborted' | 'error';
  errorCode?: NormalizedErrorCode; // assistant + status=error only
  contextSource?: ContextSource; // user messages only (web context referenced by that turn)
  // —— A5 扩展（doc/stage3/detailed-design.md §9.3 + 决议 #33）——
  toolCallId?: string; // role='tool' 必填：关联该轮 assistant.toolCalls 的调用 id
  toolStep?: ToolStep; // role='tool' 必填：精简步骤（§2.2 agent.ts）
  toolCalls?: ProviderToolCall[]; // role='assistant' 可选：该轮工具调用（脱敏持久化——
  // browser_fill 的 arguments.text 已替换；重放时按完整交互组裁剪）
  agentRun?: AgentRunSummary; // role='assistant' 可选：Agent run 终态摘要（§8.5）
}

export interface ConversationSession {
  id: string;
  title: string; // Derived from first question (≤ 30 chars, pure fn deriveTitle)
  createdAt: number;
  updatedAt: number;
  ephemeral: boolean; // 「不保存」：never persisted, dropped on exit
}

export type NormalizedErrorCode =
  | 'not-configured' // No provider/key configured
  | 'invalid-key' // 401/403
  | 'rate-limit' // 429
  | 'timeout' // Connect/idle/total timeout
  | 'network' // fetch network failure
  | 'context-too-long' // Provider explicitly reports context overflow
  | 'provider-error' // Other provider errors (incl. stream parse failure)
  | 'aborted' // User abort
  | 'busy' // Session already has an in-flight generation
  | 'not-found' // Session does not exist
  | 'internal'; // Unexpected internal exception

export interface NormalizedProviderError {
  code: NormalizedErrorCode;
  message: string; // Chinese, user-facing; never contains response body/headers/keys
  retryable: boolean;
  providerId: string | null;
  model: string | null;
  requestId: string; // Correlates with this turn's generation
  httpStatus?: number; // Status code only
}

// Context preview for the panel badge (no snapshot body ever crosses IPC).
export interface ContextPreview {
  tabId: string | null; // null = no active tab
  url: string | null;
  title: string | null;
  readyState: string | null;
  mode: ContextMode; // Same pure derivation as at ask time (§7.2)
  hasSelection: boolean;
  selectionLength: number;
  thin: boolean;
  degraded: boolean;
}

export type AskResult =
  { ok: true; requestId: string } | { ok: false; error: NormalizedProviderError }; // busy / not-found / invalid params

// —— 事件推送 payload（§3.1/§4.1；S3 主进程最小装配，S4 preload/renderer 直接复用） ——

export interface StreamChunkEvent {
  requestId: string;
  sessionId: string;
  delta: string;
}

export interface TurnDoneEvent {
  requestId: string;
  sessionId: string;
  status: ConversationMessage['status'];
  message: ConversationMessage; // 终态 assistant 消息（aborted/error 时含部分文本）
  error: NormalizedProviderError | null; // complete → null；aborted 携带归一化 aborted（status 为判定主字段）
  contextSource: ContextSource; // 该轮引用上下文（mode='none' 时为全空摘要）
}

// —— Provider abstraction (§3.3) ——

export interface ProviderMetadata {
  id: string;
  label: string;
  streaming: true;
  // A1 校准为真实端点能力（openai-compatible=true；fake=true），不再是 Second Stage 占位 false
  supportsToolCalling: boolean;
  defaultContextLimitTokens: number; // Display/budget reference only (real budget is char-based, §7.5)
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'; // Assigned by program literals only; web content lives
  content: string; // inside the user message's UNTRUSTED_WEB_CONTENT block (§7.3)
  toolCallId?: string; // role='tool' 时必填：关联 ProviderToolCall.id（A1 扩展）
  toolCalls?: ProviderToolCall[]; // role='assistant' 时可选：该轮工具调用（历史重放，A1 扩展）
  // A7 补验校准：供应商不透明思维内容（如 DeepSeek thinking 模式 delta.reasoning_content）。
  // 仅运行时 transcript 内用于工具轮的原样回传（mapMessages → reasoning_content）；
  // 禁止持久化/UI/日志（思维过程零暴露红线），跨 run 重放不携带（决议 #35）。
  reasoning?: string;
}

export interface ProviderRequest {
  requestId: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
  // A1 新增：模型可见工具集——由 ToolRegistry.listTools() 序列化（程序生成，
  // 模型/网页无写入通道）；undefined = 无工具（共读路径不变，请求不含 tools 字段）
  tools?: ProviderTool[];
}

export type ProviderUsage = { inputTokens?: number; outputTokens?: number };

// —— A1 扩展：tool calling 兼容层（doc/stage3/detailed-design.md §2.1） ——
// SSE delta.tool_calls 原始分片仅为 OpenAI-compatible 适配器内部解析状态（不在此
// 共享契约内）；对外 ProviderEvent.toolCalls 输出聚合校验完成的整组调用（决议 #30）。

export interface ProviderToolParameter {
  type: 'string' | 'number' | 'boolean' | 'object' | 'array'; // B4 决议 #64：最小递归扩展
  description?: string;
  enum?: Array<string | number | boolean>; // 枚举约束（仅基础类型；确定性校验用）
  // object 子结构（B4 决议 #64）：未知字段一律拒绝（additionalProperties=false，
  // 校验层与序列化层同语义——properties 即字段白名单）
  properties?: Record<string, ProviderToolParameter>;
  required?: string[];
  // array 子结构（B4 决议 #64）：逐项校验；maxItems 缺省 20（数组上限）
  items?: ProviderToolParameter;
  maxItems?: number;
}

export interface ProviderTool {
  type: 'function';
  function: {
    name: string;
    description: string; // 来自 ToolDefinition（程序注册，模型不可写）
    parameters: {
      type: 'object';
      properties: Record<string, ProviderToolParameter>;
      required: string[];
    };
  };
}

export interface ProviderToolCall {
  id: string; // 模型产出的调用 id；审计与结果关联键
  name: string; // 工具名（执行前经注册表校验，未知 → tool-not-found）
  arguments: string; // JSON 字符串（执行前经 schema 校验；解析失败 → invalid-args）
}

export type ProviderEvent =
  | { type: 'delta'; text: string }
  // 聚合完成、校验通过的整组工具调用——适配器在 finish_reason=tool_calls 末帧后按
  // index 升序产出，恰好在 done 之前；绝不携带半截 arguments。
  | { type: 'toolCalls'; toolCalls: ProviderToolCall[] }
  // A7 补验校准：供应商不透明思维增量（thinking 模式 reasoning_content）。
  // 调用方职责：Agent 循环累积并在工具轮后续请求原样回传；共读路径忽略；
  // 一律不进 UI/日志/持久化（思维过程零暴露红线，决议 #35）。
  | { type: 'reasoning'; text: string }
  | { type: 'done'; usage?: ProviderUsage }
  | { type: 'error'; error: NormalizedProviderError };

// —— Provider config (§3.5) ——

export interface ProviderConfig {
  providerId: string;
  baseUrl: string; // http/https only (file:/custom schemes rejected); trailing '/' stripped
  model: string; // Non-empty
  // apiKey is NOT part of this structure — SecureCredentialStore alone holds keys
}

// v1 唯一已注册 Provider kind（决议 #20）：S4 设置 UI 只配置该 kind，不新增多 Provider
// 选择 UI。常量放 shared：main（工厂注册）与 renderer（ProviderSettings）共用单一事实源。
export const PROVIDER_KIND_OPENAI_COMPATIBLE = 'openai-compatible';

// list() 条目（§3.5）：渲染层/设置 UI 可见的 Provider 摘要——hasKey 为布尔，
// 任何 Key 值都不在此结构内（Key 只写不读，§3.4/§4.2）。
export interface ProviderInfo {
  providerId: string;
  label: string;
  baseUrl: string;
  model: string;
  hasKey: boolean;
}
