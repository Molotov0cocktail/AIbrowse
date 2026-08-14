// ConversationStore: session JSON persistence under <userData>/conversations/.
// Contract source: doc/stage2/detailed-design.md §9 — index.json (sessions, never
// ephemeral) + one <sessionId>.json per session (messages); atomic writes (tmp+rename);
// 50-session / 200-message limits (limit enforcement lives in the Service, §3.1);
// corruption tolerance is fail-closed (invalid entries dropped + warn; unparseable
// file → empty, the raw file content never reaches the renderer).
// Pure format/validation/crop/title functions are exported for unit tests (分层纪律).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logWarn } from '../logger';
import type { ConversationMessage, ConversationSession } from '../../shared/types/conversation';

// —— 上限常量（§9；SESSION_LIMIT 由 Service 在 createSession 时执行） ——

export const SESSION_LIMIT = 50;
export const MESSAGE_LIMIT = 200;
export const TITLE_MAX_CHARS = 30;

// —— 纯函数：title 推导（§2：首问截断 ≤ 30 字符） ——

export function deriveTitle(question: string): string {
  const single = question.trim().replace(/\s+/g, ' ');
  return single.length <= TITLE_MAX_CHARS ? single : single.slice(0, TITLE_MAX_CHARS);
}

// —— 纯函数：消息形状校验（§9 逐条校验；非法 → null，由调用方丢弃 + warn） ——
// A5 version 2 扩展（§9.3 + 决议 #33）：role 白名单增 'tool'（toolCallId/toolStep 必填，
// ToolStep 逐字段 fail-closed）；assistant 可选 toolCalls/agentRun 形状校验——非法扩展字段
// 丢弃该字段保留文本（内容仍可用）；内部能力字段（documentId/allowedKind/fill 原文）不出现在
// 任何校验通过的结构内（写入端脱敏纪律保证，读取端按形状 fail-closed）。

const TOOL_STEP_DECISIONS = new Set([
  'auto',
  'auto-visible',
  'confirmed',
  'denied',
  'forbidden',
  'invalid',
]);

const TOOL_RESULT_ERROR_CODES = new Set([
  'invalid-args',
  'tool-not-found',
  'element-not-found',
  'stale-element',
  'not-interactable',
  'forbidden',
  'denied-by-user',
  'execution-failed',
  'search-failed',
]);

const AGENT_RUN_STATUSES = new Set([
  'running',
  'waiting-confirm',
  'done',
  'cancelled',
  'step-limit',
  'timeout',
  'loop-detected',
  'no-progress',
  'error',
]);

function isToolStepShape(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const step = raw as Record<string, unknown>;
  if (typeof step.id !== 'string' || step.id === '') return false;
  if (typeof step.toolCallId !== 'string' || step.toolCallId === '') return false;
  if (typeof step.name !== 'string' || step.name === '') return false;
  if (typeof step.ok !== 'boolean') return false;
  if (typeof step.contentPreview !== 'string') return false;
  if (typeof step.decision !== 'string' || !TOOL_STEP_DECISIONS.has(step.decision)) return false;
  if (typeof step.createdAt !== 'number' || !Number.isFinite(step.createdAt)) return false;
  if (
    step.errorCode !== undefined &&
    (typeof step.errorCode !== 'string' || !TOOL_RESULT_ERROR_CODES.has(step.errorCode))
  ) {
    return false;
  }
  return true;
}

function isToolCallsShape(raw: unknown): boolean {
  if (!Array.isArray(raw)) return false;
  return raw.every(
    (call) =>
      typeof call === 'object' &&
      call !== null &&
      typeof (call as Record<string, unknown>).id === 'string' &&
      (call as Record<string, unknown>).id !== '' &&
      typeof (call as Record<string, unknown>).name === 'string' &&
      (call as Record<string, unknown>).name !== '' &&
      typeof (call as Record<string, unknown>).arguments === 'string',
  );
}

function isAgentRunShape(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const run = raw as Record<string, unknown>;
  if (typeof run.requestId !== 'string') return false;
  if (typeof run.sessionId !== 'string') return false;
  if (typeof run.status !== 'string' || !AGENT_RUN_STATUSES.has(run.status)) return false;
  if (typeof run.stepsUsed !== 'number' || !Number.isFinite(run.stepsUsed)) return false;
  if (typeof run.maxSteps !== 'number' || !Number.isFinite(run.maxSteps)) return false;
  if (typeof run.finalText !== 'string') return false;
  if (typeof run.toolStepCount !== 'number' || !Number.isFinite(run.toolStepCount)) return false;
  return true;
}

export function validateMessageShape(raw: unknown): ConversationMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  if (record.role !== 'user' && record.role !== 'assistant' && record.role !== 'tool') return null;
  if (typeof record.content !== 'string') return null;
  if (record.status !== 'complete' && record.status !== 'aborted' && record.status !== 'error') {
    return null;
  }
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return null;

  if (record.role === 'tool') {
    // tool 消息：toolCallId 非空 + ToolStep 逐字段 fail-closed（任一非法 → 整条丢弃）
    if (typeof record.toolCallId !== 'string' || record.toolCallId === '') return null;
    if (!isToolStepShape(record.toolStep)) return null;
    return {
      id: record.id,
      role: 'tool',
      content: record.content,
      createdAt: record.createdAt,
      status: record.status,
      toolCallId: record.toolCallId,
      toolStep: record.toolStep as unknown as ConversationMessage['toolStep'],
    };
  }

  // user/assistant：v1 宽容字段（contextSource/errorCode）原样保留；
  // A5 扩展字段形状非法 → 丢弃该字段（fail-closed 保留文本）
  const message = { ...record } as unknown as ConversationMessage;
  if (record.role === 'assistant') {
    if (record.toolCalls !== undefined && !isToolCallsShape(record.toolCalls)) {
      delete (message as { toolCalls?: unknown }).toolCalls;
    }
    if (record.agentRun !== undefined && !isAgentRunShape(record.agentRun)) {
      delete (message as { agentRun?: unknown }).agentRun;
    }
  }
  return message;
}

// —— 纯函数：会话形状校验（索引条目；ephemeral 条目由 parseIndexFile 统一丢弃） ——

export function validateSessionShape(raw: unknown): ConversationSession | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id === '') return null;
  if (typeof record.title !== 'string') return null;
  if (typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt)) return null;
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) return null;
  if (typeof record.ephemeral !== 'boolean') return null;
  return record as unknown as ConversationSession;
}

// —— 纯函数：文件格式（A5 起 version 2 写入恒 v2；读取兼容 v1——v1 文件按 v2 语义解析，
// 无迁移写回要求；未知 version/整体不可解析 → null = 按空处理 fail-closed） ——

export function serializeMessagesFile(messages: ConversationMessage[]): string {
  return JSON.stringify({ version: 2, messages }, null, 2);
}

export function parseMessagesFile(
  text: string,
): { messages: ConversationMessage[]; dropped: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if ((record.version !== 1 && record.version !== 2) || !Array.isArray(record.messages)) {
    return null;
  }
  const messages: ConversationMessage[] = [];
  const usedToolCallIds = new Set<string>();
  let dropped = 0;
  for (const entry of record.messages) {
    const valid = validateMessageShape(entry);
    if (valid === null) {
      dropped += 1;
      continue;
    }
    if (valid.role === 'tool') {
      // 孤立/重复 tool 消息安全处理（决议 #33③）：tool 消息必须紧跟前一条 assistant 且其
      // toolCalls 含该 toolCallId（同序组内），同一 toolCallId 不得重复使用——否则丢弃 + 计数
      const prev = messages.at(-1);
      const callId = valid.toolCallId ?? '';
      const linked =
        prev !== undefined &&
        prev.role === 'assistant' &&
        prev.toolCalls !== undefined &&
        prev.toolCalls.some((c) => c.id === callId) &&
        !usedToolCallIds.has(callId);
      if (!linked) {
        dropped += 1;
        continue;
      }
      usedToolCallIds.add(callId);
    }
    messages.push(valid);
  }
  return { messages, dropped };
}

export function serializeIndexFile(sessions: ConversationSession[]): string {
  return JSON.stringify({ version: 1, sessions }, null, 2);
}

// 存储不变式（§9）：索引不含 ephemeral —— 解析时同样丢弃（防御手工编辑/损坏）。
export function parseIndexFile(
  text: string,
): { sessions: ConversationSession[]; dropped: number } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.sessions)) return null;
  const sessions: ConversationSession[] = [];
  let dropped = 0;
  for (const entry of record.sessions) {
    const valid = validateSessionShape(entry);
    if (valid === null || valid.ephemeral) dropped += 1;
    else sessions.push(valid);
  }
  return { sessions, dropped };
}

// —— 纯函数：每会话消息上限裁剪（§9：超出确定性裁掉最早消息） ——
// A5 组感知（决议 #33③）：裁剪头部不得从孤立 tool 消息开始（其 assistant toolCalls 组已
// 被裁掉）——连续前导 tool 消息一并丢弃，不产生缺少对应 assistant toolCalls 的非法历史。
export function cropMessagesToLimit(
  messages: ConversationMessage[],
  limit: number = MESSAGE_LIMIT,
): { kept: ConversationMessage[]; dropped: number } {
  if (messages.length <= limit) return { kept: messages, dropped: 0 };
  const kept = messages.slice(messages.length - limit);
  let dropped = messages.length - limit;
  while (kept.length > 0 && kept[0].role === 'tool') {
    kept.shift();
    dropped += 1;
  }
  return { kept, dropped };
}

// —— 持久化类（运行时目录，不入库；原子写 tmp+rename；失败安全返回 false + warn） ——

export class ConversationStore {
  readonly dirPath: string; // <userData>/conversations/
  private readonly indexPath: string;

  constructor(userDataDir: string) {
    this.dirPath = join(userDataDir, 'conversations');
    this.indexPath = join(this.dirPath, 'index.json');
  }

  loadSessions(): ConversationSession[] {
    try {
      const text = readFileSync(this.indexPath, 'utf8');
      const parsed = parseIndexFile(text);
      if (parsed === null) {
        logWarn('conversation-store', '会话索引损坏，按空处理（fail-closed）');
        return [];
      }
      if (parsed.dropped > 0) {
        logWarn('conversation-store', `会话索引中 ${parsed.dropped} 条非法会话已忽略`);
      }
      return parsed.sessions;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn('conversation-store', '会话索引读取失败', error);
      }
      return [];
    }
  }

  // 写入前过滤 ephemeral（§9 红线：ephemeral 全程不落盘——此处为纵深防御，Service 亦不传入）
  saveSessions(sessions: ConversationSession[]): boolean {
    const persisted = sessions.filter((s) => !s.ephemeral);
    try {
      mkdirSync(this.dirPath, { recursive: true });
      const tmpPath = `${this.indexPath}.tmp`;
      writeFileSync(tmpPath, serializeIndexFile(persisted), 'utf8');
      renameSync(tmpPath, this.indexPath); // Atomic replace
      return true;
    } catch (error) {
      logWarn('conversation-store', '会话索引写入失败', error);
      return false;
    }
  }

  // 缺失/损坏 → 空数组（fail-closed，不把原始文件内容暴露给调用方）
  loadMessages(sessionId: string): ConversationMessage[] {
    try {
      const text = readFileSync(this.messagePath(sessionId), 'utf8');
      const parsed = parseMessagesFile(text);
      if (parsed === null) {
        logWarn('conversation-store', `会话消息文件损坏，按空处理（sessionId=${sessionId}）`);
        return [];
      }
      if (parsed.dropped > 0) {
        logWarn(
          'conversation-store',
          `会话消息文件有 ${parsed.dropped} 条非法消息已忽略（sessionId=${sessionId}）`,
        );
      }
      return parsed.messages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logWarn('conversation-store', `会话消息读取失败（sessionId=${sessionId}）`, error);
      }
      return [];
    }
  }

  saveMessages(sessionId: string, messages: ConversationMessage[]): boolean {
    try {
      mkdirSync(dirname(this.messagePath(sessionId)), { recursive: true });
      const target = this.messagePath(sessionId);
      const tmpPath = `${target}.tmp`;
      writeFileSync(tmpPath, serializeMessagesFile(messages), 'utf8');
      renameSync(tmpPath, target); // Atomic replace
      return true;
    } catch (error) {
      logWarn('conversation-store', `会话消息写入失败（sessionId=${sessionId}）`, error);
      return false;
    }
  }

  // 删除消息文件与残留 tmp（写入中断遗留；索引由 Service 更新后落盘）
  deleteFiles(sessionId: string): void {
    for (const path of [this.messagePath(sessionId), `${this.messagePath(sessionId)}.tmp`]) {
      try {
        rmSync(path, { force: true });
      } catch (error) {
        logWarn('conversation-store', `会话文件删除失败（sessionId=${sessionId}）`, error);
      }
    }
  }

  private messagePath(sessionId: string): string {
    return join(this.dirPath, `${sessionId}.json`);
  }
}
