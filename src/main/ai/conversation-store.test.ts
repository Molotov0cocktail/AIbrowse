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
import { sanitizeToolCallsForPersistence } from './agent/agent-history';
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
    // A5 契约校准：version 2 为写入版本（合法）；未知 version 3 → null
    expect(parseMessagesFile(JSON.stringify({ version: 3, messages: [] }))).toBeNull();
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

// ---------- A5：version 2 扩展（ToolStep 消息/读兼容 v1/零持久化断言） ----------

function makeToolStepMessage(overrides: Record<string, unknown> = {}): ConversationMessage {
  const step = {
    id: 'tc-1',
    toolCallId: 'tc-1',
    name: 'browser_read',
    ok: true,
    contentPreview: '页面摘要',
    decision: 'auto',
    createdAt: 2000,
    ...overrides,
  };
  return {
    id: 'msg-tool',
    role: 'tool',
    toolCallId: 'tc-1',
    content: '页面摘要',
    createdAt: 2000,
    status: 'complete',
    toolStep: step as never,
  };
}

function makeAssistantWithCalls(): ConversationMessage {
  return {
    id: 'msg-assist',
    role: 'assistant',
    content: '我先读取页面。',
    createdAt: 1500,
    status: 'complete',
    toolCalls: [{ id: 'tc-1', name: 'browser_read', arguments: '{}' }],
  };
}

describe('conversation-store v2 — 消息形状校验（role=tool / toolCalls / agentRun）', () => {
  it('role=tool 合法消息通过（toolStep 必填、toolCallId 非空）', () => {
    expect(validateMessageShape(makeToolStepMessage())).not.toBeNull();
  });

  it('tool 消息缺 toolStep / toolCallId → 丢弃（fail-closed）', () => {
    expect(validateMessageShape({ ...makeToolStepMessage(), toolStep: undefined })).toBeNull();
    expect(validateMessageShape({ ...makeToolStepMessage(), toolCallId: undefined })).toBeNull();
    expect(validateMessageShape({ ...makeToolStepMessage(), toolCallId: '' })).toBeNull();
  });

  it('ToolStep 逐字段校验：id/name/ok/contentPreview/decision/createdAt 非法 → 丢弃', () => {
    const bad = (step: Record<string, unknown>): void => {
      expect(validateMessageShape(makeToolStepMessage(step))).toBeNull();
    };
    bad({ id: 42 });
    bad({ toolCallId: '' });
    bad({ name: '' });
    bad({ ok: 'yes' });
    bad({ contentPreview: 42 });
    bad({ decision: 'auto-approve' }); // 不在闭合枚举
    bad({ createdAt: 'yesterday' });
    bad({ errorCode: 'not-a-code' }); // errorCode 枚举闭合
  });

  it('decision 闭合枚举六值（含 A2 遗留的 invalid，决议 #33 单一事实源）', () => {
    for (const decision of [
      'auto',
      'auto-visible',
      'confirmed',
      'denied',
      'forbidden',
      'invalid',
    ]) {
      expect(
        validateMessageShape(makeToolStepMessage({ decision })),
        `decision=${decision}`,
      ).not.toBeNull();
    }
  });

  it('assistant 合法 toolCalls（id/name/arguments 全字符串）通过', () => {
    expect(validateMessageShape(makeAssistantWithCalls())).not.toBeNull();
  });

  it('assistant toolCalls 形状非法 → 丢弃该字段保留文本（内容仍可用）', () => {
    const bad = { ...makeAssistantWithCalls(), toolCalls: [{ id: '' }] };
    const valid = validateMessageShape(bad);
    expect(valid).not.toBeNull();
    expect(valid?.toolCalls).toBeUndefined(); // 非法扩展字段被丢弃（fail-closed）
  });

  it('assistant agentRun 形状非法 → 丢弃该字段；合法则保留', () => {
    const withRun = {
      ...makeAssistantWithCalls(),
      agentRun: {
        requestId: 'r1',
        sessionId: 's1',
        status: 'done',
        stepsUsed: 1,
        maxSteps: 12,
        finalText: '',
        toolStepCount: 1,
      },
    };
    expect(validateMessageShape(withRun)?.agentRun?.status).toBe('done');
    const badRun = { ...makeAssistantWithCalls(), agentRun: { status: 'flying' } };
    expect(validateMessageShape(badRun)?.agentRun).toBeUndefined();
  });

  it('未知 role 仍丢弃（v1 纪律不回归）', () => {
    expect(validateMessageShape(makeMessage({ role: 'system' as never }))).toBeNull();
  });
});

describe('conversation-store v2 — 文件格式（写入恒 v2，读取兼容 v1）', () => {
  it('serializeMessagesFile 写入 version: 2', () => {
    const text = serializeMessagesFile([makeMessage()]);
    const parsed = JSON.parse(text) as { version: number; messages: unknown[] };
    expect(parsed.version).toBe(2);
    expect(parsed.messages.length).toBe(1);
  });

  it('parseMessagesFile 读 v1 文件（无迁移写回要求）', () => {
    const v1 = JSON.stringify({ version: 1, messages: [makeMessage()] });
    const parsed = parseMessagesFile(v1);
    expect(parsed).not.toBeNull();
    expect(parsed?.messages).toEqual([makeMessage()]);
    expect(parsed?.dropped).toBe(0);
  });

  it('parseMessagesFile 读 v2 文件（完整工具组：user → assistant toolCalls → tool）', () => {
    const v2 = JSON.stringify({
      version: 2,
      messages: [makeMessage(), makeAssistantWithCalls(), makeToolStepMessage()],
    });
    const parsed = parseMessagesFile(v2);
    expect(parsed?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(parsed?.dropped).toBe(0);
  });

  it('未知 version → null（fail-closed 按空处理）', () => {
    expect(parseMessagesFile(JSON.stringify({ version: 3, messages: [] }))).toBeNull();
  });

  it('孤立 tool 消息（无前导 assistant toolCalls 对应）→ 解析时丢弃 + dropped 计数', () => {
    const v2 = JSON.stringify({ version: 2, messages: [makeMessage(), makeToolStepMessage()] });
    const parsed = parseMessagesFile(v2);
    expect(parsed).not.toBeNull();
    expect(parsed?.messages.map((m) => m.role)).toEqual(['user']);
    expect(parsed?.dropped).toBe(1);
  });

  it('toolCallId 重复的 tool 消息 → 后续丢弃', () => {
    const v2 = JSON.stringify({
      version: 2,
      messages: [
        makeAssistantWithCalls(),
        makeToolStepMessage(),
        { ...makeToolStepMessage(), id: 'msg-tool-2' },
      ],
    });
    const parsed = parseMessagesFile(v2);
    expect(parsed?.messages.filter((m) => m.role === 'tool').length).toBe(1);
    expect(parsed?.dropped).toBe(1);
  });

  it('完整工具组（assistant toolCalls + 同序 tool 消息）保留', () => {
    const v2 = JSON.stringify({
      version: 2,
      messages: [makeMessage(), makeAssistantWithCalls(), makeToolStepMessage()],
    });
    const parsed = parseMessagesFile(v2);
    expect(parsed?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('v1 文件整体损坏 → null（既有纪律不回归）', () => {
    expect(parseMessagesFile('{version:1')).toBeNull();
  });
});

describe('cropMessagesToLimit — 200 条裁剪组感知（不产生孤立 tool 消息）', () => {
  it('裁剪边界切过工具组时整组保留（assistant toolCalls 与其 tool 消息同生共死）', () => {
    const group = (n: number): ConversationMessage[] => [
      {
        id: `a${n}`,
        role: 'assistant',
        content: '',
        createdAt: n,
        status: 'complete',
        toolCalls: [{ id: `c${n}`, name: 'browser_read', arguments: '{}' }],
      },
      {
        id: `t${n}`,
        role: 'tool',
        toolCallId: `c${n}`,
        content: '摘要',
        createdAt: n,
        status: 'complete',
        toolStep: {
          id: `c${n}`,
          toolCallId: `c${n}`,
          name: 'browser_read',
          ok: true,
          contentPreview: '摘要',
          decision: 'auto',
          createdAt: n,
        },
      },
    ];
    // 5 组（10 条）+ 首条 user；limit 8 → 裁掉 user + 第一组 → 剩余 4 组整组
    const messages = [
      makeMessage({ id: 'u1' }),
      ...group(1),
      ...group(2),
      ...group(3),
      ...group(4),
      ...group(5),
    ];
    const cropped = cropMessagesToLimit(messages, 8);
    expect(cropped.dropped).toBe(3);
    expect(cropped.kept[0].role).toBe('assistant'); // 不从 tool 消息开始（组完整）
    expect(cropped.kept[0].id).toBe('a2');
  });

  it('裁剪头部恰为孤立 tool（历史缺陷数据）→ 一并丢弃，不产生新孤立', () => {
    const messages: ConversationMessage[] = [
      makeToolStepMessage(),
      makeAssistantWithCalls(),
      makeToolStepMessage(),
    ];
    const cropped = cropMessagesToLimit(messages, 2);
    expect(cropped.kept[0].role).toBe('assistant');
    expect(cropped.kept.map((m) => m.role)).toEqual(['assistant', 'tool']);
  });

  it('不超限时不裁剪（既有行为不回归）', () => {
    const cropped = cropMessagesToLimit([makeMessage()], MESSAGE_LIMIT);
    expect(cropped).toEqual({ kept: [makeMessage()], dropped: 0 });
  });
});

describe('conversation-store v2 — 零持久化红线（真实文件字节断言）', () => {
  it('fill 原文/快照正文/Key 形态/documentId 零落盘（经 agent-history 脱敏管线落盘）', () => {
    const dir = join(baseDir, 'case-v2-redline');
    const store = new ConversationStore(dir);
    const fillSecret = '机密填写值A5-9f3k';
    const snapshotBody = '页面快照正文内容';
    // 走真实持久化管线：assistant toolCalls 经 sanitizeToolCallsForPersistence 脱敏；
    // user 消息只携带 ContextSource 摘要（url/title——快照正文按契约永不进入持久化结构）
    const roundAssistant = {
      id: 'a1',
      role: 'assistant' as const,
      content: '',
      createdAt: 1500,
      status: 'complete' as const,
      toolCalls: sanitizeToolCallsForPersistence([
        {
          id: 'c-fill',
          name: 'browser_fill',
          arguments: JSON.stringify({ elementId: 'el-1', text: fillSecret }),
        },
      ]),
    };
    const toolStep = {
      id: 'c-fill',
      toolCallId: 'c-fill',
      name: 'browser_fill',
      ok: true,
      contentPreview: `已填写元素 [el-1]（<input> type=text，输入 ${fillSecret.length} 个字符）`,
      decision: 'auto-visible' as const,
      createdAt: 2000,
    };
    const messages: ConversationMessage[] = [
      makeMessage({
        content: '目标',
        contextSource: {
          mode: 'snapshot',
          tabId: null,
          url: 'https://example.com/page',
          title: '示例页',
          capturedAt: 1000,
          degraded: false,
          thin: false,
          selectionExcerpt: null,
          warnings: [],
        },
      }),
      roundAssistant,
      {
        id: 't1',
        role: 'tool',
        toolCallId: 'c-fill',
        content: toolStep.contentPreview,
        createdAt: 2000,
        status: 'complete',
        toolStep,
      },
      {
        id: 'a2',
        role: 'assistant',
        content: '任务完成（不含页面原文的回答摘要）',
        createdAt: 2500,
        status: 'complete',
      },
    ];
    expect(store.saveMessages('sess-red', messages)).toBe(true);
    const bytes = readFileSync(join(dir, 'conversations', 'sess-red.json'), 'utf8');
    expect(bytes).not.toContain(fillSecret); // fill 原文零落盘
    expect(bytes).not.toContain(snapshotBody); // 快照正文零落盘
    expect(bytes).not.toContain('sk-'); // Key 形态零落盘
    expect(bytes).not.toContain('documentId'); // 内部能力字段零落盘
    expect(bytes).not.toContain('allowedKind'); // 执行器内部参数零落盘
    // 脱敏形态存在（len 形式）
    expect(bytes).toContain(`输入 ${fillSecret.length} 个字符`);
  });

  it('saveMessages 写入恒 v2（原子写/tmp 无残留不回归）', () => {
    const dir = join(baseDir, 'case-v2-atomic');
    const store = new ConversationStore(dir);
    expect(store.saveMessages('sess-x', [makeMessage()])).toBe(true);
    const text = readFileSync(join(dir, 'conversations', 'sess-x.json'), 'utf8');
    expect((JSON.parse(text) as { version: number }).version).toBe(2);
    expect(existsSync(join(dir, 'conversations', 'sess-x.json.tmp'))).toBe(false);
  });
});
