// ConversationService tests (node env, injected seams): session lifecycle, per-session
// in-flight state machine (busy / idempotent abort), §6.1 ask orchestration order
// (real-time snapshot → buildContext → persist user message FIRST → provider stream →
// events → terminal persistence), previewContext, ephemeral never persisted.
// The store is the real ConversationStore on a temp dir (real persistence files);
// browser/config/credentials/provider-resolver are injected stubs per 分层纪律.
// Contract source: doc/stage2/detailed-design.md §3.1/§6/§8.3/§9.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initLogger } from '../logger';
import type { PageSnapshot, TabInfo } from '../../shared/types/browser';
import type {
  ContextPreview,
  ConversationMessage,
  ProviderEvent,
  StreamChunkEvent,
  TurnDoneEvent,
} from '../../shared/types/conversation';
import { ConfigStore, type ProviderInfo } from './config-store';
import type { SecureCredentialStore } from './credential-store';
import { ConversationStore, SESSION_LIMIT } from './conversation-store';
import { SYSTEM_PROMPT } from './context-builder';
import { TRUNCATION_MARK } from './context-budget';
import {
  FAKE_PROVIDER_METADATA,
  FakeProvider,
  type FakeProviderScript,
} from './provider/fake-provider';
import { registerProviderFactory, type LLMProvider } from './provider/llm-provider';
import {
  ConversationServiceImpl,
  selectRegisteredProviderInfo,
  type ConversationServiceOptions,
  type SnapshotSource,
} from './conversation-service';

// 'fake' kind 注册（测试进程内）：v1 Provider 选择契约（决议 #20）依赖已注册 kind 集合，
// 与生产 openai-compatible 同路径；工厂仅满足类型（流式实现由注入的 resolveProviderFn
// 提供，工厂不会被调用）。
registerProviderFactory({
  kind: 'fake',
  create: () => new FakeProvider({}),
});

let baseDir: string;
beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'aibrowse-svc-'));
  initLogger(join(baseDir, 'app'));
});
afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

// ---------- 测试替身 ----------

class StubBrowser implements SnapshotSource {
  activeTab: TabInfo | null = null;
  snapshot: PageSnapshot | null = null;
  snapshotCalls: string[] = [];

  async getActiveTab(): Promise<TabInfo | null> {
    return this.activeTab;
  }

  async getPageSnapshot(tabId: string): Promise<PageSnapshot | null> {
    this.snapshotCalls.push(tabId);
    return this.snapshot;
  }
}

const stubCredentials: SecureCredentialStore = {
  isAvailable: () => true,
  set: async () => false,
  get: async () => null,
  has: async () => true,
  delete: async () => false,
};

const FAKE_CONFIG = {
  providerId: 'fake',
  baseUrl: 'https://fake.example/v1/',
  model: 'fake-model',
};

function makeTab(overrides: Partial<TabInfo> = {}): TabInfo {
  return {
    id: 'tab-a',
    title: '页面A',
    url: 'https://example.com/a',
    active: true,
    state: 'ready',
    ...overrides,
  };
}

const PAGE_A_BODY = '这是页面 A 的正文内容，足够长以避免薄快照判定（300 字符阈值）。'.repeat(12);

function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/a',
    title: '页面A',
    visibleText: PAGE_A_BODY,
    headings: [{ level: 1, text: '主标题甲' }],
    links: [],
    buttons: [],
    inputs: [],
    tables: [],
    meta: {
      documentId: 1,
      capturedAt: 1_000,
      readyState: 'complete',
      degraded: 'none',
      warnings: [],
    },
    ...overrides,
  };
}

interface ServiceFixture {
  service: ConversationServiceImpl;
  chunks: StreamChunkEvent[];
  turns: TurnDoneEvent[];
  browser: StubBrowser;
  configStore: ConfigStore;
  store: ConversationStore;
  dir: string;
  lastFake: () => FakeProvider | null;
  resolverCalls: () => number;
  setScript: (script: FakeProviderScript) => void;
}

function makeService(overrides: Partial<ConversationServiceOptions> = {}): ServiceFixture {
  const dir = join(baseDir, `case-${Math.floor(Math.random() * 1e9)}`);
  const browser = new StubBrowser();
  const configStore = new ConfigStore(dir, stubCredentials);
  const store = new ConversationStore(dir);
  const chunks: StreamChunkEvent[] = [];
  const turns: TurnDoneEvent[] = [];
  let script: FakeProviderScript = {};
  let fake: FakeProvider | null = null;
  let resolverCalls = 0;
  const service = new ConversationServiceImpl({
    browser,
    store,
    configStore,
    credentials: stubCredentials,
    resolveProviderFn: async () => {
      resolverCalls += 1;
      fake = new FakeProvider(script);
      return fake;
    },
    onStreamChunk: (e) => chunks.push(e),
    onTurnDone: (e) => turns.push(e),
    ...overrides,
  });
  return {
    service,
    chunks,
    turns,
    browser,
    configStore,
    store,
    dir,
    lastFake: () => fake,
    resolverCalls: () => resolverCalls,
    setScript: (s) => {
      script = s;
    },
  };
}

async function waitForTurn(turns: TurnDoneEvent[], requestId: string): Promise<TurnDoneEvent> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = turns.find((t) => t.requestId === requestId);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`等待 turn-done 超时（requestId=${requestId}）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function askAndWait(f: ServiceFixture, sessionId: string, question: string) {
  const result = await f.service.ask({ sessionId, question });
  if (!result.ok) throw new Error(`ask 失败：${result.error.code} ${result.error.message}`);
  const turn = await waitForTurn(f.turns, result.requestId);
  return { result, turn };
}

// ---------- 会话生命周期（§3.1） ----------

describe('ConversationService — 会话生命周期', () => {
  it('createSession 生成会话（初始标题「新对话」，listSessions 可见，历史为空数组）', async () => {
    const f = makeService();
    const session = await f.service.createSession();
    expect(session).not.toBeNull();
    expect(session?.id).toBeTruthy();
    expect(session?.title).toBe('新对话');
    expect(session?.ephemeral).toBe(false);
    expect((await f.service.listSessions()).map((s) => s.id)).toEqual([session?.id]);
    expect(await f.service.getHistory(session?.id ?? '')).toEqual([]); // 存在但无消息 → 空数组
  });

  it('getHistory/listSessions/deleteSession/setEphemeral 对不存在会话安全返回（null/false）', async () => {
    const f = makeService();
    expect(await f.service.getHistory('no-such')).toBeNull();
    expect(await f.service.deleteSession('no-such')).toBe(false);
    expect(await f.service.setEphemeral('no-such', true)).toBe(false);
  });

  it('deleteSession 删除内存与落盘；重复删除返回 false（幂等安全）', async () => {
    const f = makeService();
    const session = await f.service.createSession();
    expect(await f.service.deleteSession(session?.id ?? '')).toBe(true);
    expect(await f.service.getHistory(session?.id ?? '')).toBeNull();
    expect(await f.service.listSessions()).toEqual([]);
    expect(await f.service.deleteSession(session?.id ?? '')).toBe(false);
  });

  it('listSessions 新→旧（磁盘加载按 createdAt 降序）', async () => {
    const dir = join(baseDir, 'case-order');
    const store = new ConversationStore(dir);
    store.saveSessions([
      { id: 's-old', title: '旧', createdAt: 1000, updatedAt: 1000, ephemeral: false },
      { id: 's-new', title: '新', createdAt: 2000, updatedAt: 2000, ephemeral: false },
    ]);
    const service = new ConversationServiceImpl({
      browser: new StubBrowser(),
      store,
      configStore: new ConfigStore(dir, stubCredentials),
      credentials: stubCredentials,
    });
    expect((await service.listSessions()).map((s) => s.id)).toEqual(['s-new', 's-old']);
  });

  it(`会话上限 ${SESSION_LIMIT}：达上限拒绝新建非 ephemeral（返回 null），ephemeral 不受限`, async () => {
    const f = makeService();
    for (let i = 0; i < SESSION_LIMIT; i += 1) {
      expect(await f.service.createSession()).not.toBeNull();
    }
    expect(await f.service.createSession()).toBeNull(); // 第 51 个非 ephemeral → 拒绝
    expect(await f.service.createSession({ ephemeral: true })).not.toBeNull(); // ephemeral 不占上限
  });
});

// ---------- v1 单 Provider 选择契约（决议 #20） ----------

describe('selectRegisteredProviderInfo — v1 单 Provider 选择（§6.1，决议 #20）', () => {
  const info = (providerId: string): ProviderInfo => ({
    providerId,
    label: providerId,
    baseUrl: 'https://x.example/v1',
    model: 'm',
    hasKey: true,
  });

  it('返回 providerId 属于已注册 kind 的配置（未注册条目在前仍被跳过）', () => {
    expect(selectRegisteredProviderInfo([info('unregistered'), info('fake')], ['fake'])).toEqual(
      info('fake'),
    );
  });

  it('选择与文件条目顺序无关：已注册 kind 配置在任意位置都被选中', () => {
    expect(selectRegisteredProviderInfo([info('fake')], ['fake'])?.providerId).toBe('fake');
    expect(
      selectRegisteredProviderInfo([info('a-x'), info('fake'), info('b-x')], ['fake'])?.providerId,
    ).toBe('fake');
  });

  it('无已注册 kind 配置 / 空列表 / 空 kinds → null（调用方 → not-configured）', () => {
    expect(selectRegisteredProviderInfo([], ['fake'])).toBeNull();
    expect(selectRegisteredProviderInfo([info('unregistered')], ['fake'])).toBeNull();
    expect(selectRegisteredProviderInfo([info('fake')], [])).toBeNull();
  });
});

// ---------- ask 编排（§6.1 时序即契约） ----------

describe('ConversationService — ask 编排时序（§6.1）', () => {
  it('端到端流式：delta 顺序转发、turn-done complete 恰好一次、终态持久化、请求 IR 正确', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot();
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const { result, turn } = await askAndWait(f, session?.id ?? '', '总结这个页面');

    expect(turn.requestId).toBe(result.requestId);
    expect(turn.sessionId).toBe(session?.id);
    expect(turn.status).toBe('complete');
    expect(turn.error).toBeNull();
    expect(f.chunks.map((c) => c.delta).join('')).toBe(
      '你好，这是来自 FakeProvider 的确定性回答。',
    );
    expect(turn.message.content).toBe('你好，这是来自 FakeProvider 的确定性回答。');
    expect(turn.message.role).toBe('assistant');
    expect(turn.contextSource.url).toBe('https://example.com/a');
    expect(turn.contextSource.mode).toBe('snapshot');

    // 历史与落盘：user（含 contextSource）在前、assistant 在后
    const history = await f.service.getHistory(session?.id ?? '');
    expect(history?.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history?.[0]?.content).toBe('总结这个页面');
    expect(history?.[0]?.contextSource?.url).toBe('https://example.com/a');
    expect(f.store.loadMessages(session?.id ?? '')).toHaveLength(2);

    // Provider 实际收到的请求：system 恒等、model 来自配置、requestId 一致、web 块进末条 user
    const request = f.lastFake()?.getLastRequest();
    expect(request?.system).toBe(SYSTEM_PROMPT);
    expect(request?.model).toBe('fake-model');
    expect(request?.requestId).toBe(result.requestId);
    const lastUser = request?.messages.at(-1);
    expect(lastUser?.role).toBe('user');
    expect(lastUser?.content).toContain('UNTRUSTED_WEB_CONTENT');
    expect(lastUser?.content).toContain('主标题甲');
  });

  it('先持久化 user 消息（引用链先于生成落地）：Provider 开始流式时 user 已在磁盘', async () => {
    // 探针 Provider：stream() 启动瞬间读取磁盘，验证 §6.1 第 4 步（先落盘后生成）
    class StoreProbeProvider implements LLMProvider {
      readonly metadata = FAKE_PROVIDER_METADATA;
      captured: ConversationMessage[] | null = null;
      constructor(
        private readonly store: ConversationStore,
        private readonly sessionId: string,
      ) {}
      async *stream(): AsyncIterable<ProviderEvent> {
        this.captured = this.store.loadMessages(this.sessionId);
        yield { type: 'done' };
      }
    }
    const dir = join(baseDir, 'case-persist-first');
    const browser = new StubBrowser();
    browser.activeTab = makeTab();
    browser.snapshot = makeSnapshot();
    const configStore = new ConfigStore(dir, stubCredentials);
    configStore.set(FAKE_CONFIG);
    const store = new ConversationStore(dir);
    let sessionId = '';
    const probeHolder: { current: StoreProbeProvider | null } = { current: null };
    const turns: TurnDoneEvent[] = [];
    const service = new ConversationServiceImpl({
      browser,
      store,
      configStore,
      credentials: stubCredentials,
      resolveProviderFn: async () => {
        probeHolder.current = new StoreProbeProvider(store, sessionId);
        return probeHolder.current;
      },
      onTurnDone: (e) => turns.push(e),
    });
    const session = await service.createSession();
    sessionId = session?.id ?? '';
    const result = await service.ask({ sessionId, question: '先落盘校验' });
    expect(result.ok).toBe(true);
    if (result.ok) await waitForTurn(turns, result.requestId);
    // Provider 启动流式时（resolver 之后）磁盘上已有 1 条 user 消息（含 contextSource）
    expect(probeHolder.current?.captured?.map((m) => m.role)).toEqual(['user']);
    expect(probeHolder.current?.captured?.[0]?.content).toBe('先落盘校验');
    expect(probeHolder.current?.captured?.[0]?.contextSource?.url).toBe('https://example.com/a');
    expect(store.loadMessages(sessionId).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('Provider 注入 401 → turn-done error invalid-key；user 消息仍在历史（含 contextSource）', async () => {
    const f = makeService();
    f.setScript({ error: { httpStatus: 401 } });
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot();
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const { turn } = await askAndWait(f, session?.id ?? '', '会失败的问题');
    expect(turn.status).toBe('error');
    expect(turn.error?.code).toBe('invalid-key');
    expect(turn.error?.httpStatus).toBe(401);
    expect(turn.error?.message).toBe('API Key 无效或无权限，请检查设置');
    expect(turn.error?.retryable).toBe(false);
    expect(turn.message.errorCode).toBe('invalid-key');
    const history = await f.service.getHistory(session?.id ?? '');
    expect(history?.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history?.[0]?.contextSource?.url).toBe('https://example.com/a');
    expect(history?.[1]?.status).toBe('error');
  });

  it('Provider 注入 timeout → turn-done error timeout（retryable，归一化文案）', async () => {
    const f = makeService();
    f.setScript({ error: { code: 'timeout' } });
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot();
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const { turn } = await askAndWait(f, session?.id ?? '', '超时问题');
    expect(turn.status).toBe('error');
    expect(turn.error?.code).toBe('timeout');
    expect(turn.error?.retryable).toBe(true);
    expect(turn.error?.message).toBe('请求超时，请稍后重试');
  });

  it('未配置 Provider → not-configured（不发起 Provider 调用），user 消息仍先落盘', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot();
    // 不 set 配置 → list() 为空
    const session = await f.service.createSession();
    const { turn } = await askAndWait(f, session?.id ?? '', '没有配置的问题');
    expect(turn.status).toBe('error');
    expect(turn.error?.code).toBe('not-configured');
    expect(turn.error?.message).toBe('尚未配置 AI Provider 或 API Key，请先在设置中配置');
    expect(f.resolverCalls()).toBe(0);
    // 终态 assistant 错误消息照常落盘（§6.1 第 7 步），引用链 user 在前
    const history = await f.service.getHistory(session?.id ?? '');
    expect(history?.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history?.[0]?.contextSource?.mode).toBe('snapshot');
    expect(history?.[1]?.status).toBe('error');
    expect(history?.[1]?.errorCode).toBe('not-configured');
  });

  it('多配置共存：选择已注册 kind 配置（决议 #20），未注册条目在文件顺序首位也不被选中', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot();
    // 先写入未注册 kind 配置（文件顺序在前），再写入已注册 kind 的 fake 配置
    f.configStore.set({
      providerId: 'unregistered',
      baseUrl: 'https://u.example/v1',
      model: 'm-u',
    });
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const { turn } = await askAndWait(f, session?.id ?? '', '选择契约校验');
    expect(turn.status).toBe('complete');
    expect(f.lastFake()?.getLastRequest()?.model).toBe('fake-model');
  });

  it('仅有未注册 kind 配置 → not-configured（不发起 Provider 调用）', async () => {
    const f = makeService();
    f.configStore.set({
      providerId: 'unregistered',
      baseUrl: 'https://u.example/v1',
      model: 'm-u',
    });
    const session = await f.service.createSession();
    const { turn } = await askAndWait(f, session?.id ?? '', '无可用 Provider 的问题');
    expect(turn.status).toBe('error');
    expect(turn.error?.code).toBe('not-configured');
    expect(f.resolverCalls()).toBe(0);
    const history = await f.service.getHistory(session?.id ?? '');
    expect(history?.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('参数/状态安全返回：会话不存在 → not-found；空串/非串问题 → internal；不抛异常', async () => {
    const f = makeService();
    const notFound = await f.service.ask({ sessionId: 'no-such', question: 'x' });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.error.code).toBe('not-found');
    const session = await f.service.createSession();
    const empty = await f.service.ask({ sessionId: session?.id ?? '', question: '   ' });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.code).toBe('internal');
    const nonString = await f.service.ask({
      sessionId: session?.id ?? '',
      question: 42 as unknown as string,
    });
    expect(nonString.ok).toBe(false);
    if (!nonString.ok) expect(nonString.error.code).toBe('internal');
    expect(f.turns).toHaveLength(0); // 无在途生成 → 无事件
  });
});

// ---------- 防串页 / 上下文模式（§6.2 / §7.2） ----------

describe('ConversationService — 实时快照防串页与上下文模式', () => {
  it('每次 ask 实时采集：切换页面后 contextSource 更新、请求不含旧页内容', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot();
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const first = await askAndWait(f, session?.id ?? '', '第一问');
    expect(first.turn.contextSource.url).toBe('https://example.com/a');

    // 切到页面 B（同一活动 Tab 导航后快照变化；Service 每次提问重新采集）
    f.browser.activeTab = makeTab({ id: 'tab-b', title: '页面B', url: 'https://example.com/b' });
    f.browser.snapshot = makeSnapshot({
      url: 'https://example.com/b',
      title: '页面B',
      visibleText: '这是页面 B 的正文内容，与 A 完全不同，足够长以超过薄快照阈值。'.repeat(6),
      headings: [{ level: 1, text: '主标题乙' }],
    });
    const second = await askAndWait(f, session?.id ?? '', '第二问');
    expect(second.turn.contextSource.url).toBe('https://example.com/b');
    expect(f.browser.snapshotCalls).toHaveLength(2); // 两次提问两次实时采集
    const request = f.lastFake()?.getLastRequest();
    const lastUser = request?.messages.at(-1)?.content ?? '';
    expect(lastUser).toContain('主标题乙');
    expect(lastUser).not.toContain('主标题甲'); // 旧页内容不出现在新轮请求
  });

  it('L3（快照 null）→ mode=none：请求仅为问题原文（无 web 块），无异常', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = null; // L3
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const { turn } = await askAndWait(f, session?.id ?? '', '页面不可用的问题');
    expect(turn.contextSource.mode).toBe('none');
    expect(turn.contextSource.url).toBeNull();
    expect(turn.status).toBe('complete');
    const lastUser = f.lastFake()?.getLastRequest()?.messages.at(-1)?.content ?? '';
    expect(lastUser).toContain('页面不可用的问题');
    expect(lastUser).not.toContain('UNTRUSTED_WEB_CONTENT');
  });

  it('selection 独占：只送选中文本 + 页面身份，不送页面正文', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot({ selection: '用户选中的这段文字' });
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const { turn } = await askAndWait(f, session?.id ?? '', '解释我选中的这段');
    expect(turn.contextSource.mode).toBe('selection');
    expect(turn.contextSource.selectionExcerpt).toBe('用户选中的这段文字');
    const lastUser = f.lastFake()?.getLastRequest()?.messages.at(-1)?.content ?? '';
    expect(lastUser).toContain('<selection>用户选中的这段文字</selection>');
    expect(lastUser).not.toContain('主标题甲'); // 页面正文不进入 selection 模式请求
  });

  it('薄快照：thin 标记进入 contextSource 与元数据，不改变模式', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot({ visibleText: '很短的正文' });
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const { turn } = await askAndWait(f, session?.id ?? '', '这个页面讲了什么');
    expect(turn.contextSource.thin).toBe(true);
    expect(turn.contextSource.mode).toBe('snapshot');
  });

  it('超长问题确定性截断（标记 + 请求内截断），持久化保留问题原文', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot();
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const longQuestion = '长'.repeat(17_000);
    await askAndWait(f, session?.id ?? '', longQuestion);
    const lastUser = f.lastFake()?.getLastRequest()?.messages.at(-1)?.content ?? '';
    expect(lastUser).toContain('…[已截断]');
    // 截断作用于问题部分（§7.5 QUESTION_MAX_CHARS 16000；S2 决议：标记不计入预算，
    // 即 16000 字符正文 + 标记）
    const questionPart = lastUser.split('\n\n<UNTRUSTED_WEB_CONTENT')[0] ?? '';
    expect(questionPart.length).toBe(16_000 + TRUNCATION_MARK.length);
    expect(questionPart).toContain('…[已截断]');
    const history = await f.service.getHistory(session?.id ?? '');
    expect(history?.[0]?.content).toBe(longQuestion); // 持久化为问题原文（§2）
  });

  it('历史重放：早轮 user 消息只带来源行、web 块只在当轮末条 user 消息', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot();
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    await askAndWait(f, session?.id ?? '', '第一问');
    await askAndWait(f, session?.id ?? '', '第二问');
    const request = f.lastFake()?.getLastRequest();
    const contents = request?.messages.map((m) => m.content) ?? [];
    // 当轮 user 由 buildContext 追加，历史为早前消息（第 1 轮 1 对）
    expect(contents).toHaveLength(3);
    expect(contents[0]).toContain('（该轮引用页面：页面A https://example.com/a）');
    expect(contents[0]).not.toContain('UNTRUSTED_WEB_CONTENT');
    expect(contents[1]).toBe('你好，这是来自 FakeProvider 的确定性回答。');
    expect(contents[2]).toContain('第二问');
    const webBlocks = contents.filter((c) => c.includes('UNTRUSTED_WEB_CONTENT'));
    expect(webBlocks).toHaveLength(1); // 仅当轮末条 user 含 web 块
  });
});

// ---------- 在途状态机与中止（§8.3，决议 Q7/Q8） ----------

describe('ConversationService — 每会话单在途与中止语义', () => {
  const SLOW_SCRIPT: FakeProviderScript = {
    chunks: ['第一段，', { text: '第二段，', delayMs: 400 }, { text: '第三段。', delayMs: 400 }],
  };

  it('在途时同会话再 ask → busy；不同会话互不影响', async () => {
    const f = makeService();
    f.setScript(SLOW_SCRIPT);
    f.configStore.set(FAKE_CONFIG);
    const s1 = await f.service.createSession();
    const s2 = await f.service.createSession();
    const first = await f.service.ask({ sessionId: s1?.id ?? '', question: '慢问题' });
    expect(first.ok).toBe(true);
    const busy = await f.service.ask({ sessionId: s1?.id ?? '', question: '再来一个' });
    expect(busy.ok).toBe(false);
    if (!busy.ok) {
      expect(busy.error.code).toBe('busy');
      expect(busy.error.message).toBe('上一条回答还在生成中');
    }
    // 另一会话不受影响（每会话单在途）
    const other = await f.service.ask({ sessionId: s2?.id ?? '', question: '别的问题' });
    expect(other.ok).toBe(true);
    if (first.ok) await waitForTurn(f.turns, first.requestId);
    if (other.ok) await waitForTurn(f.turns, other.requestId);
  });

  it('abort 保留部分回答 + status=aborted；turn-done 后 abort 幂等返回 false', async () => {
    const f = makeService();
    f.setScript(SLOW_SCRIPT);
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const result = await f.service.ask({ sessionId: session?.id ?? '', question: '中止我' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 等第一个 delta 到达后中止
    const deadline = Date.now() + 5000;
    while (f.chunks.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(f.chunks.length).toBeGreaterThan(0);
    expect(f.service.abort(result.requestId)).toBe(true);
    const turn = await waitForTurn(f.turns, result.requestId);
    expect(turn.status).toBe('aborted');
    expect(turn.error?.code).toBe('aborted'); // 事件携带归一化 aborted（status 为判定主字段）
    expect(turn.message.errorCode).toBeUndefined(); // §2：errorCode 仅 status=error 时携带
    expect(turn.message.content).toContain('第一段，');
    expect(turn.message.content).not.toContain('第三段。');
    expect(f.service.abort(result.requestId)).toBe(false); // 幂等：终态后无在途
    const history = await f.service.getHistory(session?.id ?? '');
    expect(history?.at(-1)?.status).toBe('aborted');
    expect(history?.at(-1)?.content).toBe(turn.message.content);
  });

  it('abort 未知 requestId → false（无副作用）', () => {
    const f = makeService();
    expect(f.service.abort('no-such-request')).toBe(false);
  });

  it('deleteSession 中止该会话在途生成：turn-done aborted 且不复活文件', async () => {
    const f = makeService();
    f.setScript(SLOW_SCRIPT);
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const result = await f.service.ask({ sessionId: session?.id ?? '', question: '将被删除' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await f.service.deleteSession(session?.id ?? '')).toBe(true);
    const turn = await waitForTurn(f.turns, result.requestId);
    expect(turn.status).toBe('aborted');
    expect(await f.service.listSessions()).toEqual([]);
    expect(existsSync(join(f.dir, 'conversations', `${session?.id}.json`))).toBe(false);
  });

  it('dispose 中止全部在途生成；dispose 后再 ask 安全返回 internal', async () => {
    const f = makeService();
    f.setScript(SLOW_SCRIPT);
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const result = await f.service.ask({ sessionId: session?.id ?? '', question: '慢问题' });
    expect(result.ok).toBe(true);
    f.service.dispose();
    if (result.ok) {
      const turn = await waitForTurn(f.turns, result.requestId);
      expect(turn.status).toBe('aborted');
    }
    const after = await f.service.ask({ sessionId: session?.id ?? '', question: '退出后的提问' });
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.error.code).toBe('internal');
  });
});

// ---------- 会话持久化 / 删除 / 不保存（§9） ----------

describe('ConversationService — 持久化与 ephemeral 不落盘', () => {
  it('ephemeral 会话提问全程不落盘；setEphemeral(false) 落盘、setEphemeral(true) 移除', async () => {
    const f = makeService();
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession({ ephemeral: true });
    const id = session?.id ?? '';
    await askAndWait(f, id, '不保存的提问');
    const storeDir = join(f.dir, 'conversations');
    expect(existsSync(join(storeDir, `${id}.json`))).toBe(false); // 不落盘红线
    // 内存中历史正常
    expect((await f.service.getHistory(id))?.map((m) => m.role)).toEqual(['user', 'assistant']);

    expect(await f.service.setEphemeral(id, false)).toBe(true);
    expect(existsSync(join(storeDir, `${id}.json`))).toBe(true);
    expect(f.store.loadMessages(id)).toHaveLength(2);
    const index = JSON.parse(readFileSync(join(storeDir, 'index.json'), 'utf8')) as {
      sessions: Array<{ id: string }>;
    };
    expect(index.sessions.map((s) => s.id)).toContain(id);

    expect(await f.service.setEphemeral(id, true)).toBe(true);
    expect(existsSync(join(storeDir, `${id}.json`))).toBe(false);
    expect((await f.service.listSessions()).map((s) => s.id)).toContain(id); // 仍在内存
  });

  it('删除即消失：deleteSession 后消息文件与索引条目一并移除', async () => {
    const f = makeService();
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const id = session?.id ?? '';
    await askAndWait(f, id, '会被删除的问题');
    const storeDir = join(f.dir, 'conversations');
    expect(existsSync(join(storeDir, `${id}.json`))).toBe(true);
    await f.service.deleteSession(id);
    expect(existsSync(join(storeDir, `${id}.json`))).toBe(false);
    const index = JSON.parse(readFileSync(join(storeDir, 'index.json'), 'utf8')) as {
      sessions: Array<{ id: string }>;
    };
    expect(index.sessions.map((s) => s.id)).not.toContain(id);
  });

  it('首问推导标题（≤30 字符）并持久化；后续提问不改标题', async () => {
    const f = makeService();
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const id = session?.id ?? '';
    await askAndWait(f, id, '帮我总结这个页面的内容');
    const listed = await f.service.listSessions();
    expect(listed.find((s) => s.id === id)?.title).toBe('帮我总结这个页面的内容');
    await askAndWait(f, id, '第二个问题完全不同');
    const after = (await f.service.listSessions()).find((s) => s.id === id);
    expect(after?.title).toBe('帮我总结这个页面的内容');
    const index = JSON.parse(readFileSync(join(f.dir, 'conversations', 'index.json'), 'utf8')) as {
      sessions: Array<{ id: string; title: string }>;
    };
    expect(index.sessions.find((s) => s.id === id)?.title).toBe('帮我总结这个页面的内容');
  });

  it('重启恢复：新 Service 实例从磁盘加载会话与历史（消息形状经校验）', async () => {
    const f = makeService();
    f.configStore.set(FAKE_CONFIG);
    const session = await f.service.createSession();
    const id = session?.id ?? '';
    await askAndWait(f, id, '重启前的提问');
    // 模拟重启：同一目录上构建全新 Service（新 store 实例重新读盘）
    const restarted = new ConversationServiceImpl({
      browser: new StubBrowser(),
      store: new ConversationStore(f.dir),
      configStore: new ConfigStore(f.dir, stubCredentials),
      credentials: stubCredentials,
    });
    expect((await restarted.listSessions()).map((s) => s.id)).toEqual([id]);
    expect((await restarted.getHistory(id))?.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('每会话消息上限 200：超出确定性裁掉最早消息并保留最近 200 条', async () => {
    const dir = join(baseDir, 'case-msg-limit');
    const store = new ConversationStore(dir);
    const id = 'sess-limit';
    store.saveSessions([{ id, title: '上限', createdAt: 1000, updatedAt: 1000, ephemeral: false }]);
    const seeded: ConversationMessage[] = Array.from({ length: 199 }, (_, i) => ({
      id: `seed-${i}`,
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `历史消息 ${i}`,
      createdAt: 1000 + i,
      status: 'complete' as const,
    }));
    store.saveMessages(id, seeded);
    const turns: TurnDoneEvent[] = [];
    const configStore = new ConfigStore(dir, stubCredentials);
    configStore.set(FAKE_CONFIG);
    const service = new ConversationServiceImpl({
      browser: new StubBrowser(),
      store,
      configStore,
      credentials: stubCredentials,
      resolveProviderFn: async () => new FakeProvider({}), // 离线替身（冒烟同款注入缝）
      onTurnDone: (e) => turns.push(e),
    });
    const result = await service.ask({ sessionId: id, question: '触发裁剪的问题' });
    expect(result.ok).toBe(true);
    const turn = await waitForTurn(turns, result.ok ? result.requestId : '');
    expect(turn.status).toBe('complete');
    const persisted = store.loadMessages(id);
    expect(persisted).toHaveLength(200);
    expect(persisted[0]?.id).toBe('seed-1'); // seed-0 被确定性裁掉
    expect(persisted.at(-1)?.role).toBe('assistant');
  });
});

// ---------- previewContext（§6.3：实时快照摘要，不含正文） ----------

describe('ConversationService — previewContext', () => {
  it('摘要字段正确且不含快照正文（正文不跨边界）', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot({ selection: '选中内容' });
    const preview = await f.service.previewContext();
    expect(preview.tabId).toBe('tab-a');
    expect(preview.url).toBe('https://example.com/a');
    expect(preview.title).toBe('页面A');
    expect(preview.readyState).toBe('complete');
    expect(preview.mode).toBe('selection');
    expect(preview.hasSelection).toBe(true);
    expect(preview.selectionLength).toBe(4);
    expect(preview.thin).toBe(false);
    expect(preview.degraded).toBe(false);
    expect(Object.hasOwn(preview, 'visibleText')).toBe(false);
    expect(Object.hasOwn(preview, 'headings')).toBe(false);
  });

  it('每次调用实时采集（不缓存）：页面变化后摘要随之变化；无活动 Tab → mode=none', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = makeSnapshot();
    expect((await f.service.previewContext()).url).toBe('https://example.com/a');
    f.browser.activeTab = makeTab({ id: 'tab-b', url: 'https://example.com/b' });
    f.browser.snapshot = makeSnapshot({ url: 'https://example.com/b', title: '页面B' });
    expect((await f.service.previewContext()).url).toBe('https://example.com/b');
    expect(f.browser.snapshotCalls).toHaveLength(2);
    f.browser.activeTab = null;
    const none = await f.service.previewContext();
    expect(none.tabId).toBeNull();
    expect(none.url).toBeNull();
    expect(none.mode).toBe('none');
    expect(none.hasSelection).toBe(false);
    expect(none.selectionLength).toBe(0);
  });

  it('L3（快照 null）→ mode=none + degraded=false，安全返回', async () => {
    const f = makeService();
    f.browser.activeTab = makeTab();
    f.browser.snapshot = null;
    const preview: ContextPreview = await f.service.previewContext();
    expect(preview.mode).toBe('none');
    expect(preview.url).toBeNull();
    expect(preview.readyState).toBeNull();
  });
});

// ---------- A5：agentAsk / confirmTool（Agent Runtime 接线） ----------

import type { BrowserController } from '../browser/browser-controller';
import type {
  AgentConfirmRequest,
  AgentRunDoneEvent,
  AgentStatusEvent,
  AgentStepEvent,
} from '../../shared/types/agent';
import type { AuditEntry } from './audit-log';
import { ConfirmManager } from './confirm-manager';
import { registerTool, resetToolRegistry } from './tools/tool-registry';
import type { ToolDefinition } from './tools/tool-types';
import type { AgentLoopLimits } from './agent/agent-loop';

function agentBrowser(overrides: Partial<BrowserController> = {}): BrowserController {
  return {
    createTab: async () => ({
      id: 't-new',
      title: '',
      url: 'about:blank',
      active: true,
      state: 'idle',
    }),
    closeTab: async () => false,
    activateTab: async () => false,
    navigate: async () => false,
    goBack: async () => false,
    goForward: async () => false,
    reload: async () => false,
    getTabs: async () => [],
    getActiveTab: async () => null,
    getPageSnapshot: async () => null,
    clickElement: async () => ({ ok: false, reason: '未接线', errorCode: 'execution-failed' }),
    fillElement: async () => ({ ok: false, reason: '未接线', errorCode: 'execution-failed' }),
    scrollTab: async () => ({ ok: false, reason: '未接线' }),
    dispose: () => {},
    ...overrides,
  };
}

const agentToolDefs: ToolDefinition[] = [
  {
    name: 'browser.get_tabs',
    description: '列出标签页',
    parameters: { properties: {}, required: [] },
    baseRisk: 0,
    executor: async ({ id }) => ({ toolCallId: id, ok: true, content: '标签页摘要' }),
  },
  {
    name: 'browser.read',
    description: '读取页面',
    parameters: {
      properties: { tabId: { type: 'string', description: '标签页 id（可选）' } },
      required: [],
    },
    baseRisk: 0,
    // 与真实 read 同语义：实时采集快照并登记语义（click 权限判定与 A6 确认摘要的语义来源）
    executor: async ({ id }, ctx) => {
      const tab = await ctx.browser.getActiveTab();
      if (tab !== null) {
        const snap = await ctx.browser.getPageSnapshot(tab.id);
        if (snap !== null) ctx.recordSnapshot?.(tab.id, snap);
      }
      return { toolCallId: id, ok: true, content: '页面摘要' };
    },
  },
  {
    name: 'browser.click',
    description: '点击页面元素',
    parameters: {
      properties: {
        elementId: { type: 'string', description: 'el-N' },
        tabId: { type: 'string', description: '标签页 id（可选）' },
      },
      required: ['elementId'],
    },
    baseRisk: 1,
    riskLift: { submitClick: 2 },
    executor: async ({ id }) => ({ toolCallId: id, ok: true, content: '已点击' }),
  },
];

interface AgentServiceFixture {
  service: ConversationServiceImpl;
  chunks: StreamChunkEvent[];
  turns: TurnDoneEvent[];
  runs: AgentRunDoneEvent[];
  steps: AgentStepEvent[];
  confirms: AgentConfirmRequest[];
  statuses: AgentStatusEvent[];
  browser: StubBrowser;
  configStore: ConfigStore;
  store: ConversationStore;
  dir: string;
  confirm: ConfirmManager;
  auditEntries: AuditEntry[];
  setScript: (script: FakeProviderScript) => void;
  lastFake: () => FakeProvider | null;
}

function makeAgentService(
  overrides: {
    limits?: Partial<AgentLoopLimits>;
    browser?: StubBrowser; // 会话上下文 SnapshotSource（goal 启动快照来源）
    agentBrowserOverride?: BrowserController; // Agent 运行时浏览器（工具执行通道）
    skipConfig?: boolean; // true = 不写配置（模拟 Provider 未配置）
  } = {},
): AgentServiceFixture {
  const dir = join(baseDir, `case-agent-${Math.floor(Math.random() * 1e9)}`);
  const browser = overrides.browser ?? new StubBrowser();
  const configStore = new ConfigStore(dir, stubCredentials);
  if (overrides.skipConfig !== true) configStore.set(FAKE_CONFIG);
  const store = new ConversationStore(dir);
  const chunks: StreamChunkEvent[] = [];
  const turns: TurnDoneEvent[] = [];
  const runs: AgentRunDoneEvent[] = [];
  const steps: AgentStepEvent[] = [];
  const confirms: AgentConfirmRequest[] = [];
  const statuses: AgentStatusEvent[] = [];
  const auditEntries: AuditEntry[] = [];
  const confirm = new ConfirmManager();
  let script: FakeProviderScript = {};
  let fake: FakeProvider | null = null;
  const service = new ConversationServiceImpl({
    browser,
    store,
    configStore,
    credentials: stubCredentials,
    resolveProviderFn: async () => {
      fake = new FakeProvider(script);
      return fake;
    },
    onStreamChunk: (e) => chunks.push(e),
    onTurnDone: (e) => turns.push(e),
    onAgentStep: (e) => steps.push(e),
    onAgentConfirmRequest: (e) => confirms.push(e),
    onAgentRunDone: (e) => runs.push(e),
    onAgentStatus: (e) => statuses.push(e),
    agent: {
      browser: overrides.agentBrowserOverride ?? agentBrowser(),
      confirmManager: confirm,
      audit: (entry) => auditEntries.push(entry),
      limits: overrides.limits,
    },
  });
  return {
    service,
    chunks,
    turns,
    runs,
    steps,
    confirms,
    statuses,
    browser,
    configStore,
    store,
    dir,
    confirm,
    auditEntries,
    setScript: (s) => {
      script = s;
    },
    lastFake: () => fake,
  };
}

async function agentAskAndWait(f: AgentServiceFixture, sessionId: string, goal: string) {
  const result = await f.service.agentAsk({ sessionId, goal });
  if (!result.ok) throw new Error(`agentAsk 失败：${result.error.code} ${result.error.message}`);
  const run = await waitForRun(f.runs, result.requestId);
  return { result, run };
}

async function waitForRun(
  runs: AgentRunDoneEvent[],
  requestId: string,
): Promise<AgentRunDoneEvent> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = runs.find((t) => t.requestId === requestId);
    if (found !== undefined) return found;
    if (Date.now() > deadline)
      throw new Error(`等待 agent-run-done 超时（requestId=${requestId}）`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

beforeAll(() => {
  for (const def of agentToolDefs) registerTool(def);
});
afterAll(() => {
  resetToolRegistry();
});

describe('ConversationService — agentAsk 参数校验与在途互斥', () => {
  it('goal 非字符串/空串 → internal 拒绝（安全返回不抛异常）', async () => {
    const f = makeAgentService();
    const session = await f.service.createSession();
    const sid = session?.id ?? '';
    const bad = await f.service.agentAsk({ sessionId: sid, goal: '   ' });
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.error.code === 'internal').toBe(true);
    const nonString = await f.service.agentAsk({ sessionId: sid, goal: 42 as never });
    expect(nonString.ok).toBe(false);
    expect(f.runs.length).toBe(0); // 零生成
  });

  it('goal 超 16000 字符 → 确定性截断 + 截断后仍执行（请求中 goal 带截断标记）', async () => {
    const f = makeAgentService();
    const session = await f.service.createSession();
    const long = '长'.repeat(17000);
    f.setScript({ rounds: [[{ text: '完成' }]] });
    const { run } = await agentAskAndWait(f, session?.id ?? '', long);
    expect(run.status).toBe('complete');
    const req = f.lastFake()?.getLastRequest();
    const goalMsg = req?.messages.find((m) => m.role === 'user');
    expect(goalMsg?.content).toContain(TRUNCATION_MARK);
    expect(goalMsg?.content.length).toBeLessThan(long.length);
  });

  it('共读 ask 与 agentAsk 共享每会话单在途（双向互斥 busy）', async () => {
    const f = makeAgentService();
    const session = await f.service.createSession();
    const sid = session?.id ?? '';
    // 慢脚本占用在途
    f.setScript({ rounds: [[{ text: 'a', delayMs: 300 }, { text: 'b' }]] });
    const first = await f.service.agentAsk({ sessionId: sid, goal: '任务甲' });
    expect(first.ok).toBe(true);
    const busyAsk = await f.service.ask({ sessionId: sid, question: '共读问题' });
    expect(busyAsk.ok).toBe(false);
    expect(busyAsk.ok === false && busyAsk.error.code === 'busy').toBe(true);
    const busyAgent = await f.service.agentAsk({ sessionId: sid, goal: '任务乙' });
    expect(busyAgent.ok).toBe(false);
    await waitForRun(f.runs, first.ok ? first.requestId : '');
  });

  it('会话不存在 → not-found', async () => {
    const f = makeAgentService();
    const result = await f.service.agentAsk({ sessionId: 'no-such', goal: '任务' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code === 'not-found').toBe(true);
  });
});

describe('ConversationService — agentAsk 编排（Provider 未配置/不支持工具 → 零工具执行）', () => {
  it('provider 未配置 → not-configured 终态，零工具执行零审计', async () => {
    const f = makeAgentService({ skipConfig: true }); // 无已注册 kind 配置 → not-configured
    const session = await f.service.createSession();
    const { run } = await agentAskAndWait(f, session?.id ?? '', '任务');
    expect(run.status).toBe('error');
    expect(run.error?.code).toBe('not-configured');
    expect(run.run?.stepsUsed).toBe(0);
    expect(f.auditEntries.length).toBe(0);
  });

  it('Provider 不支持 tool calling → 请求无 tools 字段、零工具执行；出现 toolCalls 事件 → fail-closed internal', async () => {
    // 子类覆盖 metadata（不得修改共享的 FAKE_PROVIDER_METADATA——模块级对象全实例共享）
    class NoToolsProvider extends FakeProvider {
      override readonly metadata = {
        ...FAKE_PROVIDER_METADATA,
        supportsToolCalling: false,
      };
    }
    const dir = join(baseDir, `case-agent-notools-${Math.floor(Math.random() * 1e9)}`);
    const browser = new StubBrowser();
    const configStore = new ConfigStore(dir, stubCredentials);
    configStore.set(FAKE_CONFIG);
    const runs: AgentRunDoneEvent[] = [];
    const auditEntries: AuditEntry[] = [];
    const noToolsProvider = new NoToolsProvider({ rounds: [[{ text: '直接回答' }]] });
    const service = new ConversationServiceImpl({
      browser,
      store: new ConversationStore(dir),
      configStore,
      credentials: stubCredentials,
      resolveProviderFn: async () => noToolsProvider,
      onAgentRunDone: (e) => runs.push(e),
      agent: {
        browser: agentBrowser(),
        confirmManager: new ConfirmManager(),
        audit: (entry) => auditEntries.push(entry),
      },
    });
    const session = await service.createSession();
    const result = await service.agentAsk({ sessionId: session?.id ?? '', goal: '任务' });
    expect(result.ok).toBe(true);
    const run = await waitForRun(runs, result.ok ? result.requestId : '');
    expect(run.status).toBe('complete'); // 无工具调用事件 → 正常回答
    const req = noToolsProvider.getLastRequest();
    expect('tools' in (req ?? {})).toBe(false); // 请求无 tools 字段（零工具执行）
    expect(auditEntries.length).toBe(0);
    service.dispose();

    // 不支持工具却产出 toolCalls 事件 → fail-closed internal（不把工具调用误当成功）
    const badProvider = new NoToolsProvider({
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [{ id: 'c1', name: 'browser.read', arguments: '{}' }] }],
      ],
    });
    const runs2: AgentRunDoneEvent[] = [];
    const service2 = new ConversationServiceImpl({
      browser,
      store: new ConversationStore(dir),
      configStore,
      credentials: stubCredentials,
      resolveProviderFn: async () => badProvider,
      onAgentRunDone: (e) => runs2.push(e),
      agent: {
        browser: agentBrowser(),
        confirmManager: new ConfirmManager(),
        audit: () => {},
      },
    });
    const session2 = await service2.createSession();
    const result2 = await service2.agentAsk({ sessionId: session2?.id ?? '', goal: '任务' });
    const run2 = await waitForRun(runs2, result2.ok ? result2.requestId : '');
    expect(run2.status).toBe('error');
    expect(run2.error?.code).toBe('internal');
    expect(run2.run?.stepsUsed).toBe(0); // 零工具执行
    service2.dispose();
  });
});

describe('ConversationService — agentAsk 多步编排与持久化', () => {
  it('多步 run：ToolStep 持久化 + 终态 assistant 恰好一次 + turn-done/agent-run-done 各恰好一次', async () => {
    const f = makeAgentService();
    f.setScript({
      rounds: [
        [
          { text: '先读取。' },
          { kind: 'toolCalls', toolCalls: [{ id: 'c1', name: 'browser.read', arguments: '{}' }] },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [{ id: 'c2', name: 'browser.get_tabs', arguments: '{}' }],
          },
        ],
        [{ text: '最终回答全文。' }],
      ],
    });
    const session = await f.service.createSession();
    const sid = session?.id ?? '';
    const { result, run } = await agentAskAndWait(f, sid, '帮我完成多步任务');
    expect(run.status).toBe('complete');
    expect(run.run).toMatchObject({ status: 'done', stepsUsed: 2, toolStepCount: 2 });
    expect(run.message.content).toBe('最终回答全文。');
    // 历史持久化：user → assistant(轮次+toolCalls) → tool → assistant(轮次) → tool → assistant(终态)
    const history = await f.service.getHistory(sid);
    expect(history?.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ]);
    const toolMessages = history?.filter((m) => m.role === 'tool') ?? [];
    expect(toolMessages.length).toBe(2);
    expect(toolMessages[0].toolStep?.toolCallId).toBe('c1');
    expect(toolMessages[0].toolCallId).toBe('c1');
    const final = history?.at(-1);
    expect(final?.agentRun?.status).toBe('done');
    expect(final?.agentRun?.finalText).toBe('最终回答全文。');
    // 事件恰好一次
    expect(f.turns.filter((t) => t.requestId === result.requestId).length).toBe(1);
    expect(f.runs.filter((t) => t.requestId === result.requestId).length).toBe(1);
    expect(f.steps.length).toBe(2); // 每步一次 step 事件
    expect(f.auditEntries.length).toBe(2); // 每步恰好一条审计
    // goal 消息先于工具轮持久化（引用链先落地）
    expect(history?.[0].content).toBe('帮我完成多步任务');
  });

  it('ephemeral 会话：goal/ToolStep/终态均不落盘（既有规则不回归）', async () => {
    const f = makeAgentService();
    f.setScript({
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [{ id: 'c1', name: 'browser.read', arguments: '{}' }] }],
        [{ text: '回答' }],
      ],
    });
    const session = await f.service.createSession({ ephemeral: true });
    const { run } = await agentAskAndWait(f, session?.id ?? '', '任务');
    expect(run.status).toBe('complete');
    expect(existsSync(join(f.dir, 'conversations', `${session?.id ?? ''}.json`))).toBe(false);
  });

  it('重启恢复（新 Service 实例同目录）：v2 历史完整读回（含 ToolStep）', async () => {
    const dir = join(baseDir, `case-agent-reload-${Math.floor(Math.random() * 1e9)}`);
    const browser = new StubBrowser();
    const configStore = new ConfigStore(dir, stubCredentials);
    configStore.set(FAKE_CONFIG);
    const runs1: AgentRunDoneEvent[] = [];
    let script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [{ id: 'c1', name: 'browser.read', arguments: '{}' }] }],
        [{ text: '回答甲' }],
      ],
    };
    const service1 = new ConversationServiceImpl({
      browser,
      store: new ConversationStore(dir),
      configStore,
      credentials: stubCredentials,
      resolveProviderFn: async () => new FakeProvider(script),
      onAgentRunDone: (e) => runs1.push(e),
      agent: { browser: agentBrowser(), confirmManager: new ConfirmManager(), audit: () => {} },
    });
    const session = await service1.createSession();
    const result = await service1.agentAsk({ sessionId: session?.id ?? '', goal: '任务' });
    await waitForRun(runs1, result.ok ? result.requestId : '');
    service1.dispose();
    // 新实例同目录
    script = { rounds: [[{ text: '第二次回答' }]] };
    const service2 = new ConversationServiceImpl({
      browser,
      store: new ConversationStore(dir),
      configStore,
      credentials: stubCredentials,
      resolveProviderFn: async () => new FakeProvider(script),
      agent: { browser: agentBrowser(), confirmManager: new ConfirmManager(), audit: () => {} },
    });
    const history = await service2.getHistory(session?.id ?? '');
    expect(history?.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(history?.find((m) => m.role === 'tool')?.toolStep?.name).toBe('browser.read');
    expect(history?.at(-1)?.agentRun?.status).toBe('done');
    service2.dispose();
  });

  it('abort：模型流/工具等待/pending 确认同时中止 → cancelled 终态 + pending 作废 + 部分保留', async () => {
    const f = makeAgentService();
    f.setScript({
      // 第一块立即可达（部分保留依据）；第二块 60s 延迟（慢流中止点）
      rounds: [[{ text: '第一块部分' }, { text: '更多', delayMs: 60_000 }]],
    });
    const session = await f.service.createSession();
    const sid = session?.id ?? '';
    const result = await f.service.agentAsk({ sessionId: sid, goal: '任务' });
    expect(result.ok).toBe(true);
    const requestId = result.ok ? result.requestId : '';
    // 等第一个 delta 后中止（中止感知睡眠即停——不依赖 60s 真实墙钟）
    const deadline = Date.now() + 2000;
    while (
      f.chunks.filter((c) => c.requestId === requestId).length === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(f.chunks.filter((c) => c.requestId === requestId).length).toBe(1);
    expect(f.service.abort(requestId)).toBe(true);
    const run = await waitForRun(f.runs, requestId);
    expect(run.status).toBe('aborted');
    expect(run.run?.status).toBe('cancelled');
    expect(run.message.content).toBe('第一块部分'); // 部分保留
    // 终态后再次 abort 幂等 false
    expect(f.service.abort(requestId)).toBe(false);
  });

  it('deleteSession 与 run 竞争：删除后不复活文件（存活守卫不回归）', async () => {
    const f = makeAgentService();
    f.setScript({
      rounds: [[{ text: 'a', delayMs: 200 }, { text: 'b' }]],
    });
    const session = await f.service.createSession();
    const sid = session?.id ?? '';
    const result = await f.service.agentAsk({ sessionId: sid, goal: '任务' });
    expect(result.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20)); // 生成进行中删除
    expect(await f.service.deleteSession(sid)).toBe(true);
    const messageFile = join(f.dir, 'conversations', `${sid}.json`);
    await new Promise((resolve) => setTimeout(resolve, 400)); // 等待在途编排终态
    expect(existsSync(messageFile)).toBe(false); // 不复活
    expect(await f.service.getHistory(sid)).toBeNull();
  });
});

describe('ConversationService — confirmTool 与确认事件', () => {
  it('confirmTool 转发确认状态机（deny → denied-by-user 步骤；重跑 approve → confirmed）', async () => {
    // 提交类 click 需语义元数据 → 本用例用「未知 id」验证转发语义 + 简单工具验证 approve/deny 通道
    const f = makeAgentService();
    expect(await f.service.confirmTool('no-such', true)).toBe(false); // 未知 id → false
    expect(await f.service.confirmTool('no-such', false)).toBe(false);
    // 真实 pending：直接经 confirmManager 建立后经 service 决议
    const p = f.confirm.requestConfirm('req-x', 'tc-x', 'browser.click', {
      url: 'https://example.com/',
      detail: '提交表单',
    });
    expect(await f.service.confirmTool('tc-x', false)).toBe(true);
    await expect(p).resolves.toBe('denied');
    const p2 = f.confirm.requestConfirm('req-x', 'tc-x2', 'browser.click', { detail: 'x' });
    expect(await f.service.confirmTool('tc-x2', true)).toBe(true);
    await expect(p2).resolves.toBe('approved');
    // 已终结 id 二次决议 → false（幂等）
    expect(await f.service.confirmTool('tc-x2', true)).toBe(false);
  });

  it('L2 确认请求事件映射：非在途 runId 不发出事件（防串 run）；作废后 pending 清空', async () => {
    // 事件映射依赖 in-flight requestId 查找（L2 事件全链路正向由 agent-loop 单测覆盖；
    // service 层验证防串 run 与 pending 清理）
    const f = makeAgentService();
    const requestId = 'evt-run-not-inflight';
    const p = f.confirm.requestConfirm(requestId, 'tc-evt', 'browser.click', {
      url: 'https://example.com/form',
      detail: '提交表单',
    });
    expect(f.confirms.length).toBe(0); // 无匹配在途 run → 不发出
    expect(f.confirm.isPending('tc-evt')).toBe(true);
    expect(await f.service.confirmTool('tc-evt', false)).toBe(true); // 经 service 决议
    await expect(p).resolves.toBe('denied');
    expect(f.confirm.getPending()).toBeNull();
  });
});

// ---------- A6：onAgentStatus 状态事件（实时可见性）与 step 参数摘要（审计同源） ----------

describe('ConversationService — A6 状态事件（onAgentStatus）与 step 参数摘要', () => {
  // L2 场景：agent 运行时浏览器返回含提交按钮的快照（read 工具登记语义 → click 提交类 → L2）
  const submitSnapshot: PageSnapshot = makeSnapshot({
    buttons: [{ id: 'el-1', text: '提交按钮', isSubmit: true }],
  });
  const agentL2Browser = agentBrowser({
    getActiveTab: async () => makeTab({ id: 't1', url: 'https://example.com/a' }),
    getPageSnapshot: async () => submitSnapshot,
  });
  const l2Rounds: FakeProviderScript = {
    rounds: [
      [{ kind: 'toolCalls', toolCalls: [{ id: 's-read', name: 'browser.read', arguments: '{}' }] }],
      [
        {
          kind: 'toolCalls',
          toolCalls: [{ id: 's-click', name: 'browser.click', arguments: '{"elementId":"el-1"}' }],
        },
      ],
      [{ text: '完成' }],
    ],
  };

  it('agentAsk 成功后发出 starting（stepsUsed=0/maxSteps=12，程序事实先于本地 start）', async () => {
    const f = makeAgentService();
    f.setScript({ rounds: [[{ text: '完成' }]] });
    const session = await f.service.createSession();
    const sid = session?.id ?? '';
    const { result } = await agentAskAndWait(f, sid, '任务');
    const starting = f.statuses.find((s) => s.phase === 'starting');
    expect(starting).toBeDefined();
    expect(starting).toMatchObject({
      requestId: result.requestId,
      sessionId: sid,
      phase: 'starting',
      stepsUsed: 0,
      maxSteps: 12,
    });
  });

  it('L2 pending 建立 → waiting-confirm；confirmTool approve → confirm-resolved(approved)', async () => {
    const f = makeAgentService({ agentBrowserOverride: agentL2Browser });
    f.setScript(l2Rounds);
    const session = await f.service.createSession();
    const sid = session?.id ?? '';
    const ask = await f.service.agentAsk({ sessionId: sid, goal: '任务' });
    expect(ask.ok).toBe(true);
    await vi.waitFor(
      () => {
        expect(f.statuses.some((s) => s.phase === 'waiting-confirm')).toBe(true);
      },
      { timeout: 5000 },
    );
    const waiting = f.statuses.find((s) => s.phase === 'waiting-confirm');
    expect(waiting?.toolName).toBe('browser.click');
    expect(f.confirms.some((c) => c.toolCallId === 's-click')).toBe(true);
    // 决议经 service.confirmTool（A6 IPC 转发入口）
    expect(await f.service.confirmTool('s-click', true)).toBe(true);
    await waitForRun(f.runs, ask.ok === true ? ask.requestId : '');
    const resolved = f.statuses.find((s) => s.phase === 'confirm-resolved');
    expect(resolved).toMatchObject({ confirmOutcome: 'approved' });
    // 顺序：starting → thinking → waiting-confirm → confirm-resolved → run-done
    const order = ['starting', 'thinking', 'waiting-confirm', 'confirm-resolved'].map((p) =>
      f.statuses.findIndex((s) => s.phase === p),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order.every((v, i, arr) => i === 0 || v > (arr[i - 1] ?? -1))).toBe(true);
  });

  it('confirmTool deny → confirm-resolved(denied)；步骤 denied 事件随后到达', async () => {
    const f = makeAgentService({ agentBrowserOverride: agentL2Browser });
    f.setScript(l2Rounds);
    const session = await f.service.createSession();
    const sid = session?.id ?? '';
    const ask = await f.service.agentAsk({ sessionId: sid, goal: '任务' });
    await vi.waitFor(
      () => {
        expect(f.statuses.some((s) => s.phase === 'waiting-confirm')).toBe(true);
      },
      { timeout: 5000 },
    );
    expect(await f.service.confirmTool('s-click', false)).toBe(true);
    await waitForRun(f.runs, ask.ok === true ? ask.requestId : '');
    expect(
      f.statuses.some((s) => s.phase === 'confirm-resolved' && s.confirmOutcome === 'denied'),
    ).toBe(true);
    const clickStep = f.steps.find((s) => s.step.toolCallId === 's-click');
    expect(clickStep?.step.decision).toBe('denied');
    expect(clickStep?.step.errorCode).toBe('denied-by-user');
  });

  it('abort 作废 pending → confirm-resolved(cancelled) + run-done cancelled', async () => {
    const f = makeAgentService({ agentBrowserOverride: agentL2Browser });
    f.setScript(l2Rounds);
    const session = await f.service.createSession();
    const sid = session?.id ?? '';
    const ask = await f.service.agentAsk({ sessionId: sid, goal: '任务' });
    await vi.waitFor(
      () => {
        expect(f.statuses.some((s) => s.phase === 'waiting-confirm')).toBe(true);
      },
      { timeout: 5000 },
    );
    expect(ask.ok === true && f.service.abort(ask.requestId)).toBe(true);
    const run = await waitForRun(f.runs, ask.ok === true ? ask.requestId : '');
    expect(run.run?.status).toBe('cancelled');
    expect(
      f.statuses.some((s) => s.phase === 'confirm-resolved' && s.confirmOutcome === 'cancelled'),
    ).toBe(true);
    // 作废后迟到 approve 无效（幂等 false）
    expect(await f.service.confirmTool('s-click', true)).toBe(false);
  });

  it('非在途 runId 的 pending/settled 不发出状态事件（防串 run）', async () => {
    const f = makeAgentService();
    const p = f.confirm.requestConfirm('evt-run-not-inflight', 'tc-evt', 'browser.click', {
      url: 'https://example.com/form',
      detail: '提交表单',
    });
    expect(f.statuses).toHaveLength(0);
    expect(await f.service.confirmTool('tc-evt', false)).toBe(true);
    await expect(p).resolves.toBe('denied');
    expect(f.statuses).toHaveLength(0); // settled 同样只对在途 run 发出
  });

  it('onAgentStep 事件携带 argsSummary（审计同源脱敏摘要，非持久化可见性字段）', async () => {
    const f = makeAgentService();
    f.setScript({
      rounds: [
        [
          {
            kind: 'toolCalls',
            toolCalls: [{ id: 's-read', name: 'browser.read', arguments: '{}' }],
          },
        ],
        [{ text: '完成' }],
      ],
    });
    const session = await f.service.createSession();
    const sid = session?.id ?? '';
    await agentAskAndWait(f, sid, '任务');
    expect(f.steps).toHaveLength(1);
    expect(f.steps[0]?.argsSummary).toBe('{}');
    expect(f.steps[0]?.argsSummary).toBe(f.auditEntries[0]?.argsSummary); // 与审计同源一致
  });
});

describe('ConversationService — A6 共享 ConfirmManager 多监听者（关闭 A5 计划内限制）', () => {
  it('两个 Service 共享同一 ConfirmManager：确认事件各只对自身在途 run 发出（互不覆盖/串扰）', async () => {
    // A5 计划内限制「回调所有权为最后构造的 Service 实例」的关闭验证：
    // ConfirmManager 多监听者 Set 分发 + 每 Service 按自身 in-flight 映射。
    const shared = new ConfirmManager();
    const f1 = makeAgentService();
    const f2 = makeAgentService();
    // 重新构造两个共享状态机的 Service（fixture 自带私有 manager，此处显式重建）
    const dir1 = join(baseDir, `case-shared-${Math.floor(Math.random() * 1e9)}`);
    const configStore1 = new ConfigStore(dir1, stubCredentials);
    configStore1.set(FAKE_CONFIG);
    const svc1 = new ConversationServiceImpl({
      browser: new StubBrowser(),
      store: new ConversationStore(dir1),
      configStore: configStore1,
      credentials: stubCredentials,
      resolveProviderFn: async () => new FakeProvider({ rounds: [[{ text: '完成' }]] }),
      onAgentConfirmRequest: (e) => f1.confirms.push(e),
      onAgentStatus: (e) => f1.statuses.push(e),
      agent: { browser: agentBrowser(), confirmManager: shared, audit: () => {} },
    });
    const dir2 = join(baseDir, `case-shared2-${Math.floor(Math.random() * 1e9)}`);
    const configStore2 = new ConfigStore(dir2, stubCredentials);
    configStore2.set(FAKE_CONFIG);
    const svc2 = new ConversationServiceImpl({
      browser: new StubBrowser(),
      store: new ConversationStore(dir2),
      configStore: configStore2,
      credentials: stubCredentials,
      resolveProviderFn: async () => new FakeProvider({ rounds: [[{ text: '完成' }]] }),
      onAgentConfirmRequest: (e) => f2.confirms.push(e),
      onAgentStatus: (e) => f2.statuses.push(e),
      agent: { browser: agentBrowser(), confirmManager: shared, audit: () => {} },
    });
    // 直接经共享状态机建立 pending（runId 模拟 svc1 的在途 run）→ 仅 svc1 收到事件
    const s1 = await svc1.createSession();
    const ask1 = await svc1.agentAsk({ sessionId: s1?.id ?? '', goal: '任务一' });
    expect(ask1.ok).toBe(true);
    const p = shared.requestConfirm(
      ask1.ok === true ? ask1.requestId : '',
      'tc-shared',
      'browser.click',
      {
        detail: '共享状态机',
      },
    );
    expect(f1.confirms.some((c) => c.toolCallId === 'tc-shared')).toBe(true);
    expect(f2.confirms.some((c) => c.toolCallId === 'tc-shared')).toBe(false);
    expect(await svc1.confirmTool('tc-shared', false)).toBe(true);
    await expect(p).resolves.toBe('denied');
    expect(
      f1.statuses.some((s) => s.phase === 'confirm-resolved' && s.confirmOutcome === 'denied'),
    ).toBe(true);
    expect(f2.statuses.some((s) => s.phase === 'confirm-resolved')).toBe(false);
    // 退订：svc1 dispose 后不再收到事件（多 Service 共享不泄漏）
    svc1.dispose();
    const p2 = shared.requestConfirm('no-run', 'tc-after', 'browser.click', { detail: 'x' });
    expect(shared.deny('tc-after')).toBe(true);
    await p2;
    const svc1StatusCount = f1.statuses.length;
    expect(f1.statuses.length).toBe(svc1StatusCount); // dispose 后退订，无新事件
    svc2.dispose();
  });
});
