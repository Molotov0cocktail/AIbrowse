// ConversationStore: session JSON persistence under <userData>/conversations/.
// Contract source: doc/stage2/detailed-design.md §9 — index.json (sessions, never
// ephemeral) + one <sessionId>.json per session (messages); atomic writes (tmp+rename);
// 50-session / 200-message limits (limit enforcement lives in the Service, §3.1);
// Stage 7: bounded reads and closed projection reject the whole damaged member.
// Missing files are empty; all other read failures preserve originals and seal writes.
// Pure format/validation/crop/title functions are exported for unit tests (分层纪律).
import {
  mkdirSync,
  openSync,
  fstatSync,
  fsyncSync,
  readSync,
  closeSync,
  renameSync,
  rmSync,
  writeFileSync,
  lstatSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { logWarn } from '../logger';
import type {
  ConversationMessage,
  ConversationSession,
  ConversationStorageStatus,
} from '../../shared/types/conversation';
import {
  LIMITS,
  UUID,
  ProjectionError,
  projectSession,
  projectIndex,
  projectMessage,
  projectSessionMetadata,
} from './conversation-transfer';
import { JsonReadError, parseBoundedJson } from '../storage/bounded-json';

// —— 上限常量（§9；SESSION_LIMIT 由 Service 在 createSession 时执行） ——

export const SESSION_LIMIT = 50;
export const MESSAGE_LIMIT = 200;
export const TITLE_MAX_CHARS = 30;

// —— 纯函数：title 推导（§2：首问截断 ≤ 30 字符） ——

export function deriveTitle(question: string): string {
  const single = question.trim().replace(/\s+/g, ' ');
  return single.length <= TITLE_MAX_CHARS ? single : single.slice(0, TITLE_MAX_CHARS);
}

// The projection module owns the one closed schema for disk and transfer.
export function validateMessageShape(raw: unknown): ConversationMessage | null {
  try {
    return projectMessage(raw);
  } catch {
    return null;
  }
}
export function validateSessionShape(raw: unknown): ConversationSession | null {
  try {
    return projectSessionMetadata(raw);
  } catch {
    return null;
  }
}
export function serializeMessagesFile(messages: ConversationMessage[]): string {
  return JSON.stringify(projectSession({ version: 2, messages }).value);
}
export function serializeIndexFile(sessions: ConversationSession[]): string {
  return JSON.stringify(projectIndex({ version: 1, sessions }).value);
}
export function parseMessagesFile(
  text: string,
): { messages: ConversationMessage[]; dropped: number } | null {
  try {
    return { messages: decodeMessages(text), dropped: 0 };
  } catch {
    return null;
  }
}
export function parseIndexFile(
  text: string,
): { sessions: ConversationSession[]; dropped: number } | null {
  try {
    return { sessions: decodeIndex(text), dropped: 0 };
  } catch {
    return null;
  }
}
function decodeMessages(text: string): ConversationMessage[] {
  const raw = parseBoundedJson(text, {
    bytes: LIMITS.sessionBytes,
    depth: LIMITS.inputDepth,
    nodes: LIMITS.nodes,
  });
  return projectSession(raw).value.messages as unknown as ConversationMessage[];
}
function decodeIndex(text: string): ConversationSession[] {
  const raw = parseBoundedJson(text, {
    bytes: LIMITS.indexBytes,
    depth: LIMITS.inputDepth,
    nodes: LIMITS.nodes,
  });
  return projectIndex(raw).value.sessions as unknown as ConversationSession[];
}
export class ConversationReadError extends Error {
  constructor(readonly code: 'invalid' | 'budget' | 'io') {
    super('会话数据无法读取，原文件已保留，请恢复备份');
  }
}

type WriteMember = 'index' | 'messages';
type WriteStage =
  | 'prepare'
  | 'validate-id'
  | 'project'
  | 'mkdir'
  | 'open'
  | 'inspect'
  | 'write'
  | 'sync'
  | 'close'
  | 'verify-temp'
  | 'check-target'
  | 'rename'
  | 'verify-target'
  | 'rollback-verify'
  | 'rollback-remove';

class WriteGuardError extends Error {
  constructor(readonly code: 'identity' | 'target-exists') {
    super('会话文件保护检查失败');
  }
}

function writeErrorCode(error: unknown): string {
  // Only fixed errno values are safe to record; never invoke a foreign code getter.
  let code: unknown;
  try {
    code =
      typeof error === 'object' && error !== null
        ? Object.getOwnPropertyDescriptor(error, 'code')?.value
        : undefined;
    if (typeof code !== 'string') return 'other';
    if (
      error instanceof ProjectionError &&
      ['shape', 'id', 'count', 'link', 'depth', 'nodes', 'bytes'].includes(code)
    )
      return `projection-${code}`;
    if (error instanceof WriteGuardError && ['identity', 'target-exists'].includes(code))
      return code;
    if (error instanceof ConversationReadError && code === 'invalid') return 'invalid-id';
  } catch {
    return 'other';
  }
  return typeof code === 'string' &&
    [
      'EACCES',
      'EPERM',
      'EEXIST',
      'ENOENT',
      'ENOTDIR',
      'EISDIR',
      'ENOSPC',
      'EDQUOT',
      'EMFILE',
      'ENFILE',
      'EIO',
      'EBUSY',
      'EINVAL',
      'EBADF',
      'EROFS',
      'ENAMETOOLONG',
      'ENOTEMPTY',
      'ELOOP',
      'EXDEV',
    ].includes(code)
    ? code
    : 'other';
}

class WriteOperationError extends Error {
  readonly category: 'invalid' | 'budget' | 'io';
  readonly code: string;

  constructor(
    readonly member: WriteMember,
    readonly stage: WriteStage,
    error: unknown,
  ) {
    super('会话写入操作失败');
    this.code = writeErrorCode(error);
    this.category = this.code.startsWith('projection-')
      ? ['projection-bytes', 'projection-count', 'projection-depth', 'projection-nodes'].includes(
          this.code,
        )
        ? 'budget'
        : 'invalid'
      : 'io';
  }
}

function writeStage<T>(member: WriteMember, stage: WriteStage, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new WriteOperationError(member, stage, error);
  }
}

function readBounded(path: string, limit: number): string {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new ConversationReadError('io');
    if (stat.size > limit) throw new ConversationReadError('budget');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (n === 0) throw new ConversationReadError('io');
      offset += n;
    }
    const extra = Buffer.alloc(1);
    if (readSync(fd, extra, 0, 1, offset) !== 0) throw new ConversationReadError('io');
    const after = fstatSync(fd);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      throw new ConversationReadError('io');
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ConversationReadError('invalid');
    }
  } finally {
    closeSync(fd);
  }
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
  private readFailure: ConversationReadError | null = null;
  private writeFailure: ConversationReadError | null = null;
  private promotionFiles: Array<{ path: string; dev: bigint; ino: bigint }> | null = null;

  private atomicWrite(target: string, payload: string, member: WriteMember): void {
    const temporary = `${target}.tmp`;
    const fd = writeStage(member, 'open', () => openSync(temporary, 'wx'));
    let identity: { dev: bigint; ino: bigint };
    try {
      identity = writeStage(member, 'inspect', () => {
        const created = fstatSync(fd, { bigint: true });
        if (!created.isFile() || created.nlink !== 1n) throw new WriteGuardError('identity');
        return { dev: created.dev, ino: created.ino };
      });
      this.promotionFiles?.push({ path: temporary, ...identity });
      writeStage(member, 'write', () => writeFileSync(fd, payload, 'utf8'));
      writeStage(member, 'sync', () => fsyncSync(fd));
    } catch (error) {
      try {
        closeSync(fd);
      } catch {
        // Closing still runs once, but must not replace the first write failure.
      }
      throw error;
    }
    writeStage(member, 'close', () => closeSync(fd));
    writeStage(member, 'verify-temp', () => this.verifyIdentity(temporary, identity));
    // The promotion's message target was absent. Bind its possible rollback
    // identity to the exclusive descriptor before publication, never to a
    // subsequently observed path that could already name a different object.
    if (this.promotionFiles && target !== this.indexPath) {
      writeStage(member, 'check-target', () => this.requireAbsent(target));
      this.promotionFiles.push({ path: target, ...identity });
    }
    writeStage(member, 'rename', () => renameSync(temporary, target));
    writeStage(member, 'verify-target', () => this.verifyIdentity(target, identity));
  }

  private requireAbsent(path: string): void {
    try {
      lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new WriteGuardError('target-exists');
  }

  private verifyIdentity(path: string, identity: { dev: bigint; ino: bigint }): void {
    const current = lstatSync(path, { bigint: true });
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1n ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw new WriteGuardError('identity');
  }

  getStorageStatus(): ConversationStorageStatus {
    const failure = this.readFailure ?? this.writeFailure;
    return failure === null
      ? { state: 'ready', code: null }
      : { state: 'recovery-required', code: failure.code };
  }

  private failedWrite(error: unknown, member: WriteMember): false {
    const failure =
      error instanceof WriteOperationError
        ? error
        : new WriteOperationError(member, 'prepare', error);
    this.writeFailure ??= new ConversationReadError(failure.category);
    logWarn(
      'conversation-store',
      `会话写入失败，已保存文件保留，后续写入已暂停（member=${failure.member}，stage=${failure.stage}，category=${failure.category}，code=${failure.code}）`,
    );
    return false;
  }

  private failedRead(error: unknown): never {
    const code =
      error instanceof ConversationReadError
        ? error.code
        : error instanceof JsonReadError
          ? error.code === 'budget-exceeded'
            ? 'budget'
            : 'invalid'
          : error instanceof ProjectionError
            ? ['bytes', 'count', 'depth', 'nodes'].includes(error.code)
              ? 'budget'
              : 'invalid'
            : 'io';
    this.readFailure ??= new ConversationReadError(code);
    logWarn('conversation-store', '会话数据读取失败，原文件已保留');
    throw this.readFailure;
  }

  constructor(userDataDir: string) {
    this.dirPath = join(userDataDir, 'conversations');
    this.indexPath = join(this.dirPath, 'index.json');
  }

  loadSessions(): ConversationSession[] {
    if (this.readFailure) throw this.readFailure;
    try {
      return decodeIndex(readBounded(this.indexPath, LIMITS.indexBytes));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return this.failedRead(error);
    }
  }

  // 写入前过滤 ephemeral（§9 红线：ephemeral 全程不落盘——此处为纵深防御，Service 亦不传入）
  saveSessions(sessions: ConversationSession[]): boolean {
    if (this.readFailure || this.writeFailure) return false;
    const persisted = sessions.filter((s) => !s.ephemeral);
    try {
      writeStage('index', 'mkdir', () => mkdirSync(this.dirPath, { recursive: true }));
      const payload = writeStage('index', 'project', () => serializeIndexFile(persisted));
      this.atomicWrite(this.indexPath, payload, 'index');
      return true;
    } catch (error) {
      return this.failedWrite(error, 'index');
    }
  }

  // Missing is empty; corrupt/over-budget members require explicit recovery.
  loadMessages(sessionId: string): ConversationMessage[] {
    if (this.readFailure) throw this.readFailure;
    try {
      return decodeMessages(readBounded(this.messagePath(sessionId), LIMITS.sessionBytes));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      return this.failedRead(error);
    }
  }

  saveMessages(sessionId: string, messages: ConversationMessage[]): boolean {
    if (this.readFailure || this.writeFailure) return false;
    try {
      const target = writeStage('messages', 'validate-id', () => this.messagePath(sessionId));
      writeStage('messages', 'mkdir', () => mkdirSync(dirname(target), { recursive: true }));
      const payload = writeStage('messages', 'project', () => serializeMessagesFile(messages));
      this.atomicWrite(target, payload, 'messages');
      return true;
    } catch (error) {
      return this.failedWrite(error, 'messages');
    }
  }

  // A previously ephemeral member has no owned files. Validate both payloads
  // before writing either, and roll back only files created by this synchronous
  // promotion if the index cannot be published. Existing remnants are preserved.
  promoteSession(
    sessionId: string,
    messages: ConversationMessage[],
    sessions: ConversationSession[],
  ): boolean {
    if (this.readFailure || this.writeFailure) return false;
    const created: Array<{ path: string; dev: bigint; ino: bigint }> = [];
    try {
      writeStage('messages', 'project', () => serializeMessagesFile(messages));
      writeStage('index', 'project', () =>
        serializeIndexFile(sessions.filter((session) => !session.ephemeral)),
      );
      const target = writeStage('messages', 'validate-id', () => this.messagePath(sessionId));
      for (const path of [target, `${target}.tmp`, `${this.indexPath}.tmp`]) {
        writeStage(path === `${this.indexPath}.tmp` ? 'index' : 'messages', 'check-target', () =>
          this.requireAbsent(path),
        );
      }
      this.promotionFiles = created;
      if (this.saveMessages(sessionId, messages) && this.saveSessions(sessions)) return true;
    } catch (error) {
      this.failedWrite(error, 'messages');
    } finally {
      this.promotionFiles = null;
    }
    for (const owned of created) {
      const member = owned.path === `${this.indexPath}.tmp` ? 'index' : 'messages';
      try {
        writeStage(member, 'rollback-verify', () => this.verifyIdentity(owned.path, owned));
        writeStage(member, 'rollback-remove', () => rmSync(owned.path));
      } catch (error) {
        if (!(error instanceof WriteOperationError && error.code === 'ENOENT'))
          this.failedWrite(error, member);
      }
    }
    return false;
  }

  // Remove message and interrupted-write files; report every deletion failure.
  deleteFiles(sessionId: string): boolean {
    if (this.readFailure || this.writeFailure || !UUID.test(sessionId)) return false;
    let removed = true;
    for (const path of [this.messagePath(sessionId), `${this.messagePath(sessionId)}.tmp`]) {
      try {
        rmSync(path, { force: true });
      } catch (error) {
        removed = false;
        logWarn('conversation-store', `会话文件删除失败（sessionId=${sessionId}）`, error);
      }
    }
    return removed;
  }

  private messagePath(sessionId: string): string {
    if (!UUID.test(sessionId)) throw new ConversationReadError('invalid');
    return join(this.dirPath, `${sessionId}.json`);
  }
}
