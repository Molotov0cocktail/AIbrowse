// ConversationStore tests: pure parts (message shape validation / limit crop / title
// derivation) + real JSON file I/O on a temp dir (atomic write, corruption tolerance,
// ephemeral never persisted, delete incl. residual tmp).
// Contract source: doc/stage2/detailed-design.md §9.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLogger } from '../logger';
import type { ConversationMessage, ConversationSession } from '../../shared/types/conversation';
import {
  ConversationStore,
  MESSAGE_LIMIT,
  TITLE_MAX_CHARS,
  cropMessagesToLimit,
  deriveTitle,
  parseIndexFile,
  parseMessagesFile,
  serializeIndexFile,
  serializeMessagesFile,
  validateMessageShape,
  validateSessionShape,
} from './conversation-store';

let baseDir: string;
beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'aibrowse-conv-'));
  // Route logger output to the temp dir so tests never write log files into the repo.
  initLogger(join(baseDir, 'app'));
});
afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function makeMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: 'msg-1',
    role: 'user',
    content: '你好',
    createdAt: 1000,
    status: 'complete',
    ...overrides,
  };
}

function makeSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    id: 'sess-1',
    title: '标题',
    createdAt: 1000,
    updatedAt: 1000,
    ephemeral: false,
    ...overrides,
  };
}

describe('deriveTitle — 首问截断（§9，≤ 30 字符纯函数）', () => {
  it('空串/纯空白 → 空标题（安全返回）', () => {
    expect(deriveTitle('')).toBe('');
    expect(deriveTitle('   \n\t  ')).toBe('');
  });

  it('短问题保留原文（trim 后）', () => {
    expect(deriveTitle('  总结这个页面  ')).toBe('总结这个页面');
  });

  it('超长问题确定性截断到恰好 30 字符（无标记，按 §9 只要求 ≤30）', () => {
    const long = '一'.repeat(100);
    const title = deriveTitle(long);
    expect(title).toHaveLength(TITLE_MAX_CHARS);
    expect(title).toBe('一'.repeat(TITLE_MAX_CHARS));
  });

  it('多行问题折叠为单行（换行/连续空白 → 单个空格）', () => {
    expect(deriveTitle('第一行\n第二行\t第三行')).toBe('第一行 第二行 第三行');
  });
});

describe('validateMessageShape — 消息形状校验（§9 逐条校验，非法丢弃）', () => {
  it('合法 user/assistant 消息通过（含 contextSource / errorCode 附加字段）', () => {
    expect(validateMessageShape(makeMessage())).toEqual(makeMessage());
    expect(
      validateMessageShape(
        makeMessage({
          role: 'assistant',
          status: 'error',
          errorCode: 'invalid-key',
        }),
      ),
    ).toEqual(
      makeMessage({
        role: 'assistant',
        status: 'error',
        errorCode: 'invalid-key',
      }),
    );
  });

  it('非对象（null/数组/字符串）→ null', () => {
    expect(validateMessageShape(null)).toBeNull();
    expect(validateMessageShape([])).toBeNull();
    expect(validateMessageShape('x')).toBeNull();
    expect(validateMessageShape(42)).toBeNull();
  });

  it('role 非 user/assistant → null（角色只由程序字面量产生，持久层同守）', () => {
    expect(validateMessageShape(makeMessage({ role: 'system' as never }))).toBeNull();
    expect(validateMessageShape(makeMessage({ role: 'tool' as never }))).toBeNull();
  });

  it('content 非 string → null（防重放注入非文本）', () => {
    expect(validateMessageShape(makeMessage({ content: 123 as never }))).toBeNull();
  });

  it('status 非法 → null', () => {
    expect(validateMessageShape(makeMessage({ status: 'pending' as never }))).toBeNull();
  });

  it('id 非 string → null', () => {
    expect(validateMessageShape(makeMessage({ id: 7 as never }))).toBeNull();
  });
});

describe('serialize/parseMessagesFile — 消息文件纯格式', () => {
  it('序列化/解析往返一致（version 1）', () => {
    const messages = [makeMessage(), makeMessage({ id: 'msg-2', role: 'assistant' })];
    const parsed = parseMessagesFile(serializeMessagesFile(messages));
    expect(parsed).not.toBeNull();
    expect(parsed?.messages).toEqual(messages);
    expect(parsed?.dropped).toBe(0);
  });

  it('整体不可解析 → null（非法 JSON / 非对象 / 版本不符 / messages 缺失或非数组）', () => {
    expect(parseMessagesFile('{not json')).toBeNull();
    expect(parseMessagesFile('42')).toBeNull();
    expect(parseMessagesFile(JSON.stringify({ version: 2, messages: [] }))).toBeNull();
    expect(parseMessagesFile(JSON.stringify({ version: 1 }))).toBeNull();
    expect(parseMessagesFile(JSON.stringify({ version: 1, messages: 'x' }))).toBeNull();
  });

  it('逐条形状校验：非法条目丢弃并计数，合法条目保留', () => {
    // 损坏文件手工构造（不经过类型化的 serializer——模拟磁盘损坏/手工编辑）
    const text = JSON.stringify({
      version: 1,
      messages: [
        makeMessage(),
        { role: 'user', content: 1, createdAt: 2, status: 'complete' },
        makeMessage({ id: 'msg-3', role: 'assistant' }),
        'garbage',
        null,
      ],
    });
    const parsed = parseMessagesFile(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.messages.map((m) => m.id)).toEqual(['msg-1', 'msg-3']);
    expect(parsed?.dropped).toBe(3);
  });
});

describe('serialize/parseIndexFile — 会话索引纯格式（不含 ephemeral）', () => {
  it('序列化/解析往返一致', () => {
    const sessions = [makeSession(), makeSession({ id: 'sess-2', title: '乙' })];
    const parsed = parseIndexFile(serializeIndexFile(sessions));
    expect(parsed).not.toBeNull();
    expect(parsed?.sessions).toEqual(sessions);
    expect(parsed?.dropped).toBe(0);
  });

  it('整体不可解析 → null', () => {
    expect(parseIndexFile('x')).toBeNull();
    expect(parseIndexFile(JSON.stringify({ version: 2, sessions: [] }))).toBeNull();
    expect(parseIndexFile(JSON.stringify({ version: 1 }))).toBeNull();
  });

  it('ephemeral 条目在索引中一律丢弃（存储不变式：索引不含 ephemeral）', () => {
    const text = serializeIndexFile([
      makeSession(),
      makeSession({ id: 'sess-ep', ephemeral: true }),
    ]);
    const parsed = parseIndexFile(text);
    expect(parsed?.sessions.map((s) => s.id)).toEqual(['sess-1']);
    expect(parsed?.dropped).toBe(1);
  });

  it('形状非法条目（id 非串/title 非串/时间戳非数/ephemeral 非布尔）丢弃并计数', () => {
    const text = JSON.stringify({
      version: 1,
      sessions: [
        makeSession(),
        { ...makeSession({ id: 'sess-x' }), createdAt: 'bad' },
        { ...makeSession({ id: 'sess-y' }), ephemeral: 1 },
        null,
      ],
    });
    const parsed = parseIndexFile(text);
    expect(parsed?.sessions.map((s) => s.id)).toEqual(['sess-1']);
    expect(parsed?.dropped).toBe(3);
  });
});

describe('validateSessionShape — 会话形状校验', () => {
  it('合法会话通过；缺字段/类型错误 → null', () => {
    expect(validateSessionShape(makeSession())).toEqual(makeSession());
    expect(validateSessionShape(makeSession({ id: '' }))).toBeNull();
    expect(validateSessionShape(makeSession({ title: 5 as never }))).toBeNull();
    expect(validateSessionShape(makeSession({ createdAt: Number.NaN }))).toBeNull();
    expect(validateSessionShape(makeSession({ ephemeral: 'yes' as never }))).toBeNull();
    expect(validateSessionShape(null)).toBeNull();
  });
});

describe('cropMessagesToLimit — 每会话消息上限裁剪（§9：确定性裁掉最早消息）', () => {
  it('未超限原样返回（同引用、零丢弃）', () => {
    const messages = [makeMessage()];
    const result = cropMessagesToLimit(messages);
    expect(result.kept).toBe(messages);
    expect(result.dropped).toBe(0);
  });

  it('超限保留最近 N 条，丢弃最早消息并计数', () => {
    const messages = Array.from({ length: MESSAGE_LIMIT + 3 }, (_, i) =>
      makeMessage({ id: `msg-${i}` }),
    );
    const result = cropMessagesToLimit(messages);
    expect(result.kept).toHaveLength(MESSAGE_LIMIT);
    expect(result.dropped).toBe(3);
    expect(result.kept[0]?.id).toBe('msg-3');
    expect(result.kept.at(-1)?.id).toBe(`msg-${MESSAGE_LIMIT + 2}`);
  });

  it('自定义上限生效', () => {
    const messages = Array.from({ length: 5 }, (_, i) => makeMessage({ id: `m-${i}` }));
    const result = cropMessagesToLimit(messages, 2);
    expect(result.kept.map((m) => m.id)).toEqual(['m-3', 'm-4']);
    expect(result.dropped).toBe(3);
  });
});

describe('ConversationStore — JSON 文件读写（§9：原子写/损坏容错/删除含残留 tmp）', () => {
  it('saveSessions/loadSessions 往返；ephemeral 不落盘（写入前过滤）', () => {
    const dir = join(baseDir, 'case-roundtrip');
    const store = new ConversationStore(dir);
    expect(
      store.saveSessions([makeSession(), makeSession({ id: 'sess-ep', ephemeral: true })]),
    ).toBe(true);
    expect(store.loadSessions()).toEqual([makeSession()]);
    // 落盘内容同样不含 ephemeral（序列化层面再核对）
    const fileText = readFileSync(join(dir, 'conversations', 'index.json'), 'utf8');
    expect(fileText).not.toContain('sess-ep');
  });

  it('原子写：成功写入后无 .tmp 残留，文件可解析', () => {
    const dir = join(baseDir, 'case-atomic');
    const store = new ConversationStore(dir);
    store.saveSessions([makeSession()]);
    const storeDir = join(dir, 'conversations');
    expect(existsSync(join(storeDir, 'index.json.tmp'))).toBe(false);
    expect(parseIndexFile(readFileSync(join(storeDir, 'index.json'), 'utf8'))).not.toBeNull();
  });

  it('索引损坏容错（fail-closed）：缺失目录/整体不可解析/非法条目 → 安全返回，不抛异常', () => {
    const dir = join(baseDir, 'case-corrupt-index');
    const store = new ConversationStore(dir);
    expect(store.loadSessions()).toEqual([]); // 目录缺失
    mkdirSync(join(dir, 'conversations'), { recursive: true });
    writeFileSync(join(dir, 'conversations', 'index.json'), '### not json ###', 'utf8');
    expect(store.loadSessions()).toEqual([]);
    const valid = makeSession();
    const bad = { ...makeSession({ id: 'sess-x' }), title: 9 };
    writeFileSync(
      join(dir, 'conversations', 'index.json'),
      serializeIndexFile([valid, bad as never]),
      'utf8',
    );
    expect(store.loadSessions()).toEqual([valid]);
  });

  it('saveMessages/loadMessages 往返；原子写无 tmp 残留', () => {
    const dir = join(baseDir, 'case-messages');
    const store = new ConversationStore(dir);
    const messages = [makeMessage(), makeMessage({ id: 'msg-2', role: 'assistant' })];
    expect(store.saveMessages('sess-1', messages)).toBe(true);
    expect(store.loadMessages('sess-1')).toEqual(messages);
    expect(existsSync(join(dir, 'conversations', 'sess-1.json.tmp'))).toBe(false);
  });

  it('消息文件损坏容错：缺失 → 空；整体不可解析 → 空；非法条目丢弃保留合法条目', () => {
    const dir = join(baseDir, 'case-corrupt-messages');
    const store = new ConversationStore(dir);
    expect(store.loadMessages('missing')).toEqual([]);
    mkdirSync(join(dir, 'conversations'), { recursive: true });
    writeFileSync(join(dir, 'conversations', 'sess-1.json'), 'garbage', 'utf8');
    expect(store.loadMessages('sess-1')).toEqual([]);
    const valid = makeMessage();
    writeFileSync(
      join(dir, 'conversations', 'sess-1.json'),
      JSON.stringify({ version: 1, messages: [{ role: 'tool' }, valid] }),
      'utf8',
    );
    expect(store.loadMessages('sess-1')).toEqual([valid]);
  });

  it('deleteFiles 删除消息文件与残留 tmp（写入中断遗留）', () => {
    const dir = join(baseDir, 'case-delete');
    const store = new ConversationStore(dir);
    store.saveMessages('sess-1', [makeMessage()]);
    const storeDir = join(dir, 'conversations');
    writeFileSync(join(storeDir, 'sess-1.json.tmp'), 'half-written', 'utf8'); // 模拟中断残留
    expect(existsSync(join(storeDir, 'sess-1.json'))).toBe(true);
    store.deleteFiles('sess-1');
    expect(existsSync(join(storeDir, 'sess-1.json'))).toBe(false);
    expect(existsSync(join(storeDir, 'sess-1.json.tmp'))).toBe(false);
  });
});
