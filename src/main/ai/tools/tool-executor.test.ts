// ToolExecutor 管线测试（红→绿，A2）：注册表查找/参数校验 → 权限判定 → 确认状态机 →
// executor → 结构化 ToolResult → 审计（每次调用恰好一条）。任何错误不得以 ok:true 返回
// （Third_stage.md §8）。契约源：doc/stage3/detailed-design.md §4.1/§7.2/§8.4/§10.1。
// 注：本文件以测试专用 stub 注册 browser_click/browser_open 走真实 decide 分支——生产
// 注册表（index.ts 装配）只含 A2 首批 8 工具，交互工具不注册不实现（A3 红线）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserController } from '../../browser/browser-controller';
import type { ElementSemantics } from '../../../shared/types/agent';
import type { AuditEntry } from '../audit-log';
import { ConfirmManager, type PendingChange } from '../confirm-manager';
import { registerTool, resetToolRegistry } from './tool-registry';
import type { ToolExecutionContext, ToolDefinition } from './tool-types';
import type { ToolPermissionLevel } from '../../../shared/types/agent';
import { ToolExecutor, TOOL_RESULT_CONTENT_MAX } from './tool-executor';

// 管线异常路径会 logWarn——单测环境下 logger 未初始化（logDir=''），避免向 CWD 写
// 根目录日志文件（测试基础设施卫生；生产路径 logger 由 index.ts 初始化，行为不变）
vi.mock('../../logger', () => ({
  logDebug: () => {},
  logInfo: () => {},
  logWarn: () => {},
  logError: () => {},
}));

function fakeBrowser(overrides: Partial<BrowserController> = {}): BrowserController {
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

function makeDef(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    name: 'test_ok',
    description: '',
    parameters: { properties: {}, required: [] },
    baseRisk: 0,
    executor: async ({ id }) => ({ toolCallId: id, ok: true, content: '完成' }),
    ...overrides,
  };
}

describe('ToolExecutor 管线', () => {
  let audits: AuditEntry[];
  let executor: ToolExecutor;
  let confirm: ConfirmManager;
  let openCalls: number;

  // 注：管线经 decide（§7.1 编译期矩阵）判定权限——矩阵外工具名 fail-closed L3，
  // 故本文件全部使用矩阵内真实工具名（工具集封闭契约）；测试用 browser_click 为
  // 测试专用 stub（走真实 decide 分支），生产注册表不含交互工具（A3 红线）。
  beforeEach(() => {
    resetToolRegistry();
    audits = [];
    confirm = new ConfirmManager();
    executor = new ToolExecutor(confirm, (entry) => {
      audits.push(entry);
    });
    openCalls = 0;
    registerTool(
      makeDef({
        name: 'browser_get_tabs',
        parameters: { properties: {}, required: [] },
        baseRisk: 0,
      }),
    );
    registerTool(
      makeDef({
        name: 'browser_get_active_tab',
        parameters: { properties: {}, required: [] },
        baseRisk: 0,
        executor: async ({ id }) => ({ toolCallId: id, ok: true, content: '长'.repeat(3000) }),
      }),
    );
    registerTool(
      makeDef({
        name: 'browser_back',
        parameters: { properties: { tabId: { type: 'string' } }, required: [] },
        baseRisk: 1,
        // 测试 stub：委托注入的 BrowserController.goBack（异常经管线归一化验证）
        executor: async ({ id, args }, toolCtx) => {
          const tabId =
            typeof args.tabId === 'string'
              ? args.tabId
              : (await toolCtx.browser.getActiveTab())?.id;
          if (tabId === undefined) {
            return {
              toolCallId: id,
              ok: false,
              content: '无活动标签页',
              errorCode: 'execution-failed',
            };
          }
          const done = await toolCtx.browser.goBack(tabId);
          return done
            ? { toolCallId: id, ok: true, content: '已后退' }
            : { toolCallId: id, ok: false, content: '后退失败', errorCode: 'execution-failed' };
        },
      }),
    );
    registerTool(
      makeDef({
        name: 'browser_reload',
        parameters: { properties: { tabId: { type: 'string' } }, required: [] },
        baseRisk: 1,
        executor: async ({ id }) => ({
          toolCallId: id,
          ok: false,
          content: '目标元素不可用',
          errorCode: 'execution-failed',
        }),
      }),
    );
    registerTool(
      makeDef({
        name: 'browser_open',
        parameters: { properties: { url: { type: 'string' } }, required: ['url'] },
        baseRisk: 1,
        executor: async ({ id }) => {
          openCalls += 1;
          return { toolCallId: id, ok: true, content: '已打开' };
        },
      }),
    );
    registerTool(
      makeDef({
        name: 'browser_click',
        parameters: {
          properties: { elementId: { type: 'string' } },
          required: ['elementId'],
        },
        baseRisk: 1,
        riskLift: { submitClick: 2 },
      }),
    );
  });

  // A3：getElementSemantics 返回语义与文档世代绑定（tabId 由管线解析后传入——
  // A5 历史提取可忽略 tabId；A3 快照语义源按 Tab 键控）。测试替身以 documentId=1 简化。
  const ctx = (semantics?: ElementSemantics | null): ToolExecutionContext => ({
    browser: fakeBrowser(),
    runId: 'run-1',
    getElementSemantics: () => (semantics == null ? null : { semantics, documentId: 1 }),
  });
  const signal = new AbortController().signal;

  it('成功路径（L0）：执行 + 审计恰好一条（decision=auto，argsSummary 确定性）', async () => {
    const r = await executor.execute(
      { id: 'c1', name: 'browser_get_tabs', arguments: '{}' },
      ctx(),
      signal,
    );
    expect(r).toEqual({ toolCallId: 'c1', ok: true, content: '完成' });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      requestId: 'run-1',
      toolCallId: 'c1',
      tool: 'browser_get_tabs',
      argsSummary: '{}',
      decision: 'auto',
      ok: true,
      errorCode: null,
    });
    expect(typeof audits[0]?.durationMs).toBe('number');
  });

  it('L1 路径：decision=auto-visible（open 合法 URL 执行）', async () => {
    const r = await executor.execute(
      { id: 'c1', name: 'browser_open', arguments: '{"url":"https://example.com/"}' },
      ctx(),
      signal,
    );
    expect(r.ok).toBe(true);
    expect(openCalls).toBe(1);
    expect(audits[0]?.decision).toBe('auto-visible');
  });

  it('未知工具 → tool-not-found + 审计恰好一条（不执行）', async () => {
    const r = await executor.execute(
      { id: 'c1', name: 'browser.nope', arguments: '{}' },
      ctx(),
      signal,
    );
    expect(r).toMatchObject({ ok: false, errorCode: 'tool-not-found' });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.decision).toBe('invalid');
    expect(audits[0]?.argsSummary).toBe('{}');
  });

  it('参数校验失败 → invalid-args + 审计恰好一条（executor 不被调用）', async () => {
    const r = await executor.execute(
      { id: 'c1', name: 'browser_open', arguments: '{}' },
      ctx(),
      signal,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('invalid-args');
    expect(openCalls).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.decision).toBe('invalid');
  });

  it('L3 禁止 → forbidden + 审计恰好一条（executor 不被调用，即使参数合法）', async () => {
    const r = await executor.execute(
      { id: 'c1', name: 'browser_open', arguments: '{"url":"javascript:alert(1)"}' },
      ctx(),
      signal,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('forbidden');
    expect(openCalls).toBe(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ decision: 'forbidden', ok: false, errorCode: 'forbidden' });
    expect(audits[0]?.argsSummary).toContain('javascript:alert(1)');
  });

  it('L2 确认：deny → denied-by-user + 审计 decision=denied（executor 不执行）', async () => {
    const p = executor.execute(
      { id: 'c2', name: 'browser_click', arguments: '{"elementId":"el-2"}' },
      ctx({ isSubmit: true }),
      signal,
    );
    await vi.waitFor(() => expect(confirm.getPending()?.toolCallId).toBe('c2'));
    expect(confirm.deny('c2')).toBe(true);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('denied-by-user');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ decision: 'denied', ok: false, errorCode: 'denied-by-user' });
  });

  it('L2 确认：approve → 执行 + decision=confirmed', async () => {
    const p = executor.execute(
      { id: 'c2', name: 'browser_click', arguments: '{"elementId":"el-2"}' },
      ctx({ isSubmit: true }),
      signal,
    );
    await vi.waitFor(() => expect(confirm.getPending()?.toolCallId).toBe('c2'));
    expect(confirm.approve('c2')).toBe(true);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.decision).toBe('confirmed');
  });

  it('L2 确认：cancelAll 作废 → denied-by-user（fail-closed 不执行）', async () => {
    const p = executor.execute(
      { id: 'c2', name: 'browser_click', arguments: '{"elementId":"el-2"}' },
      ctx({ isSubmit: true }),
      signal,
    );
    await vi.waitFor(() => expect(confirm.getPending()?.toolCallId).toBe('c2'));
    confirm.cancelAll('run-1');
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('denied-by-user');
    expect(audits[0]?.decision).toBe('denied');
  });

  it('L2 确认 summary 含 elementText（页面提供的目标文本，经语义 binding 程序组装，A6）', async () => {
    const changes: PendingChange[] = [];
    confirm.addPendingChangeListener((change) => {
      changes.push(change);
    });
    const p = executor.execute(
      { id: 'c2', name: 'browser_click', arguments: '{"elementId":"el-2"}' },
      ctx({ isSubmit: true, text: '提交按钮' }),
      signal,
    );
    await vi.waitFor(() => expect(changes.length).toBe(1));
    const first = changes[0];
    expect(first?.kind).toBe('pending');
    if (first?.kind !== 'pending') throw new Error('应建立 pending');
    expect(first.request.toolName).toBe('browser_click');
    expect(first.request.summary.elementText).toBe('提交按钮');
    expect(first.request.summary.detail).toContain('browser_click');
    // 决议 → settled 判别联合（A6 confirm-resolved 状态事件源）
    expect(confirm.approve('c2')).toBe(true);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(changes.at(-1)).toEqual({
      kind: 'settled',
      runId: 'run-1',
      toolCallId: 'c2',
      outcome: 'approved',
    });
  });

  it('L2 确认 summary 无元素语义文本时不含 elementText（宁缺勿错，不伪造）', async () => {
    const changes: PendingChange[] = [];
    confirm.addPendingChangeListener((change) => {
      changes.push(change);
    });
    const p = executor.execute(
      { id: 'c2', name: 'browser_click', arguments: '{"elementId":"el-2"}' },
      ctx({ isSubmit: true }), // 无 text 字段（如 input[type=submit]，inputs 不采集可见文本）
      signal,
    );
    await vi.waitFor(() => expect(changes.length).toBe(1));
    const first = changes[0];
    if (first?.kind !== 'pending') throw new Error('应建立 pending');
    expect('elementText' in first.request.summary).toBe(false);
    confirm.deny('c2');
    await p;
  });

  it('L2 确认 summary 含目标站点 URL（参数无 url 的工具取目标 Tab 的 URL——主进程可信信息，A6）', async () => {
    const changes: PendingChange[] = [];
    confirm.addPendingChangeListener((change) => {
      changes.push(change);
    });
    const tabCtx = (semantics?: ElementSemantics | null): ToolExecutionContext => ({
      browser: fakeBrowser({
        getActiveTab: async () => ({
          id: 'tab-x',
          title: '表单页',
          url: 'https://page.example/form',
          active: true,
          state: 'ready',
        }),
        getTabs: async () => [
          {
            id: 'tab-x',
            title: '表单页',
            url: 'https://page.example/form',
            active: true,
            state: 'ready',
          },
        ],
      }),
      runId: 'run-1',
      getElementSemantics: () => (semantics == null ? null : { semantics, documentId: 1 }),
    });
    const p = executor.execute(
      { id: 'c2', name: 'browser_click', arguments: '{"elementId":"el-2"}' },
      tabCtx({ isSubmit: true }),
      signal,
    );
    await vi.waitFor(() => expect(changes.length).toBe(1));
    const first = changes[0];
    if (first?.kind !== 'pending') throw new Error('应建立 pending');
    expect(first.request.summary.url).toBe('https://page.example/form');
    confirm.deny('c2');
    await p;
  });

  it('click 无语义元数据 → L3 forbidden（fail-closed 不回落到基础 L1）', async () => {
    const r = await executor.execute(
      { id: 'c3', name: 'browser_click', arguments: '{"elementId":"el-9"}' },
      ctx(null),
      signal,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('forbidden');
    expect(audits[0]?.decision).toBe('forbidden');
  });

  it('click 非允许列表目标（普通按钮）→ L3 forbidden', async () => {
    const r = await executor.execute(
      { id: 'c3', name: 'browser_click', arguments: '{"elementId":"el-3"}' },
      ctx({ isSubmit: false, inputType: 'button' }),
      signal,
    );
    expect(r.errorCode).toBe('forbidden');
  });

  it('执行层异常 → execution-failed + 审计恰好一条（不抛给调用方）', async () => {
    const throwingBrowser = fakeBrowser({
      getActiveTab: async () => ({
        id: 't1',
        title: '',
        url: 'about:blank',
        active: true,
        state: 'ready',
      }),
      goBack: async () => {
        throw new Error('boom');
      },
    });
    const r = await executor.execute(
      { id: 'c3', name: 'browser_back', arguments: '{}' },
      { browser: throwingBrowser, runId: 'run-1' },
      signal,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('execution-failed');
    expect(audits).toHaveLength(1);
    expect(audits[0]?.ok).toBe(false);
  });

  it('ok 结果确定性截断 2000（内容 + 截断标记 + warnings）', async () => {
    const r = await executor.execute(
      { id: 'c4', name: 'browser_get_active_tab', arguments: '{}' },
      ctx(),
      signal,
    );
    expect(r.ok).toBe(true);
    expect(r.content.length).toBe(TOOL_RESULT_CONTENT_MAX);
    expect(r.content.endsWith('…[已截断]')).toBe(true);
    expect(r.warnings).toEqual(['工具结果超过长度预算，已确定性截断']);
  });

  it('executor 返回 ok:false 保持 ok:false（错误永不以 ok:true 出现）', async () => {
    const r = await executor.execute(
      { id: 'c5', name: 'browser_reload', arguments: '{}' },
      ctx(),
      signal,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('execution-failed');
    expect(r.content).toBe('目标元素不可用');
  });

  it('已中止信号 → execution-failed（不执行工具）+ 审计恰好一条', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await executor.execute(
      { id: 'c6', name: 'browser_get_tabs', arguments: '{}' },
      ctx(),
      ac.signal,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('execution-failed');
    expect(audits).toHaveLength(1);
  });
});

// —— A3 扩展：derived 执行参数（allowedKind/documentId 由权限决策同源派生，模型不可写） ——
describe('A3 derived 执行参数（allowedKind/documentId 权限决策派生）', () => {
  const signal = new AbortController().signal;
  let executor: ToolExecutor;
  let audits: AuditEntry[];
  let confirm: ConfirmManager;
  let captured: Array<{
    name: string;
    derived: { allowedKind?: string; documentId?: number } | undefined;
  }>;

  beforeEach(() => {
    resetToolRegistry();
    audits = [];
    confirm = new ConfirmManager();
    executor = new ToolExecutor(confirm, (entry) => {
      audits.push(entry);
    });
    captured = [];
    const captureDef = (
      name: string,
      executorFn: ToolDefinition['executor'],
      baseRisk: ToolPermissionLevel = 1,
    ): void => {
      registerTool({
        name,
        description: '',
        parameters: {
          properties: {
            elementId: { type: 'string' },
            tabId: { type: 'string' },
            text: { type: 'string' },
          },
          required: name === 'browser_click' ? ['elementId'] : ['elementId', 'text'],
        },
        baseRisk,
        riskLift: name === 'browser_click' ? { submitClick: 2 } : undefined,
        executor: async (call, toolCtx, signalArg) => {
          captured.push({
            name,
            derived: call.derived === undefined ? undefined : { ...call.derived },
          });
          return executorFn(call, toolCtx, signalArg);
        },
      });
    };
    captureDef('browser_click', async ({ id }) => ({
      toolCallId: id,
      ok: true,
      content: '已点击',
    }));
    captureDef('browser_fill', async ({ id }) => ({ toolCallId: id, ok: true, content: '已填写' }));
  });

  it('click L1（nav 链接）→ executor 收到与 classifyClickTarget 同源派生的 {allowedKind:nav, documentId}', async () => {
    const binding = { semantics: { href: 'https://example.com/' }, documentId: 7 };
    const r = await executor.execute(
      { id: 'c1', name: 'browser_click', arguments: '{"elementId":"el-0"}' },
      { browser: fakeBrowser(), runId: 'run-1', getElementSemantics: () => binding },
      signal,
    );
    expect(r.ok).toBe(true);
    expect(captured[0]?.derived).toEqual({ allowedKind: 'nav', documentId: 7 });
  });

  it('click L2（提交类）approve 后 → derived 携带 allowedKind:submit（不降为其他类别）', async () => {
    const binding = { semantics: { isSubmit: true, href: 'https://example.com/' }, documentId: 2 };
    const p = executor.execute(
      { id: 'c2', name: 'browser_click', arguments: '{"elementId":"el-1"}' },
      { browser: fakeBrowser(), runId: 'run-1', getElementSemantics: () => binding },
      signal,
    );
    await vi.waitFor(() => expect(confirm.getPending()?.toolCallId).toBe('c2'));
    confirm.approve('c2');
    const r = await p;
    expect(r.ok).toBe(true);
    expect(captured[0]?.derived).toEqual({ allowedKind: 'submit', documentId: 2 });
  });

  it('fill L1（普通输入）→ derived 携带 documentId（无 allowedKind）', async () => {
    const binding = { semantics: { inputType: 'text' }, documentId: 5 };
    const r = await executor.execute(
      { id: 'c3', name: 'browser_fill', arguments: '{"elementId":"el-2","text":"x"}' },
      { browser: fakeBrowser(), runId: 'run-1', getElementSemantics: () => binding },
      signal,
    );
    expect(r.ok).toBe(true);
    expect(captured[0]?.derived).toEqual({ documentId: 5 });
  });

  it('click L3（非允许列表/语义缺失）→ 不执行、无 derived（执行器层无任何通道）', async () => {
    const r = await executor.execute(
      { id: 'c4', name: 'browser_click', arguments: '{"elementId":"el-3"}' },
      {
        browser: fakeBrowser(),
        runId: 'run-1',
        getElementSemantics: () => ({ semantics: {}, documentId: 1 }),
      },
      signal,
    );
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('forbidden');
    expect(captured).toHaveLength(0);
  });

  it('getElementSemantics 收到解析后的 tabId（args.tabId 优先，缺省解析活动 Tab id）', async () => {
    const seen: Array<string | null> = [];
    const browser = fakeBrowser({
      getActiveTab: async () => ({
        id: 't-active',
        title: '',
        url: 'about:blank',
        active: true,
        state: 'ready',
      }),
    });
    const binding = { semantics: { href: 'https://example.com/' }, documentId: 1 };
    await executor.execute(
      {
        id: 'c5',
        name: 'browser_click',
        arguments: '{"elementId":"el-0","tabId":"00000000-0000-4000-8000-000000000001"}',
      },
      {
        browser,
        runId: 'run-1',
        getElementSemantics: (tabId) => {
          seen.push(tabId);
          return binding;
        },
      },
      signal,
    );
    await executor.execute(
      { id: 'c6', name: 'browser_click', arguments: '{"elementId":"el-0"}' },
      {
        browser,
        runId: 'run-1',
        getElementSemantics: (tabId) => {
          seen.push(tabId);
          return binding;
        },
      },
      signal,
    );
    expect(seen).toEqual(['00000000-0000-4000-8000-000000000001', 't-active']);
  });
});
