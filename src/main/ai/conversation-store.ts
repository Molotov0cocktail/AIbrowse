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

export function validateMessageShape(raw: unknown): ConversationMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  if (record.role !== 'user' && record.role !== 'assistant') return null;
  if (typeof record.content !== 'string') return null;
  if (record.status !== 'complete' && record.status !== 'aborted' && record.status !== 'error') {
    return null;
  }
  return record as unknown as ConversationMessage;
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

// —— 纯函数：文件格式（version 1；整体不可解析 → null = 按空处理 fail-closed） ——

export function serializeMessagesFile(messages: ConversationMessage[]): string {
  return JSON.stringify({ version: 1, messages }, null, 2);
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
  if (record.version !== 1 || !Array.isArray(record.messages)) return null;
  const messages: ConversationMessage[] = [];
  let dropped = 0;
  for (const entry of record.messages) {
    const valid = validateMessageShape(entry);
    if (valid === null) dropped += 1;
    else messages.push(valid);
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

export function cropMessagesToLimit(
  messages: ConversationMessage[],
  limit: number = MESSAGE_LIMIT,
): { kept: ConversationMessage[]; dropped: number } {
  if (messages.length <= limit) return { kept: messages, dropped: 0 };
  return { kept: messages.slice(messages.length - limit), dropped: messages.length - limit };
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
