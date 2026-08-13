// AI co-reading subsystem shared types (Second Stage, S1).
// Contract source: doc/stage2/detailed-design.md §2 (session/message/context/error codes)
// + §3.3 (provider request/event/metadata) + §3.5 (ProviderConfig). Pure type declarations,
// shared by main/preload/renderer. Note: PageSnapshot bodies are never persisted (§2).
// Provider data types live here (not in main/) so preload/renderer can import them in S4.

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

export type ConversationMessageRole = 'user' | 'assistant';

export interface ConversationMessage {
  id: string; // crypto.randomUUID()，主进程生成
  role: ConversationMessageRole;
  content: string; // user=question text; assistant=answer text (including aborted part)
  createdAt: number; // Main-process stamp
  status: 'complete' | 'aborted' | 'error';
  errorCode?: NormalizedErrorCode; // assistant + status=error only
  contextSource?: ContextSource; // user messages only (web context referenced by that turn)
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

// —— Provider abstraction (§3.3) ——

export interface ProviderMetadata {
  id: string;
  label: string;
  streaming: true;
  supportsToolCalling: false; // Second Stage has no tools; metadata reserved for Third Stage
  defaultContextLimitTokens: number; // Display/budget reference only (real budget is char-based, §7.5)
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant'; // Assigned by program literals only; web content lives
  content: string; // inside the user message's UNTRUSTED_WEB_CONTENT block (§7.3)
}

export interface ProviderRequest {
  requestId: string;
  model: string;
  system: string;
  messages: ProviderMessage[];
}

export type ProviderUsage = { inputTokens?: number; outputTokens?: number };

export type ProviderEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; usage?: ProviderUsage }
  | { type: 'error'; error: NormalizedProviderError };

// —— Provider config (§3.5) ——

export interface ProviderConfig {
  providerId: string;
  baseUrl: string; // http/https only (file:/custom schemes rejected); trailing '/' stripped
  model: string; // Non-empty
  // apiKey is NOT part of this structure — SecureCredentialStore alone holds keys
}
