// AgentLoop 状态机全路径测试（A5，纯核心零 Electron 依赖）。契约源：
// doc/stage3/detailed-design.md §8.1/§8.2/§8.3 + threat-model §3.5 + 决议 #33：
// 多步任务/多工具轮次顺序/文本+工具同轮/L2 确认三路/step-limit 边界（绝不执行第 13 步）/
// 防循环在执行前阻断（触发次零副作用）/no-progress 两轮/总超时/取消/重复 toolCallId
// fail-closed/终态竞态与迟到事件忽略/协议历史合法序（assistant toolCalls → tool 消息）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PageSnapshot } from '../../../shared/types/browser';
import type {
  ProviderEvent,
  ProviderTool,
  ProviderToolCall,
} from '../../../shared/types/conversation';
import type { ToolStep } from '../../../shared/types/agent';
import type { SourceUsageContext } from '../../../shared/types/sources';
import type { AuditEntry } from '../audit-log';
import type { BrowserController } from '../../browser/browser-controller';
import { ConfirmManager } from '../confirm-manager';
import { registerTool, resetToolRegistry } from '../tools/tool-registry';
import type { ToolDefinition } from '../tools/tool-types';
import {
  FAKE_PROVIDER_METADATA,
  FakeProvider,
  type FakeProviderScript,
} from '../provider/fake-provider';
import type { LLMProvider } from '../provider/llm-provider';
import {
  AGENT_MAX_STEPS,
  AGENT_TOTAL_TIMEOUT_MS,
  AgentLoop,
  type AgentLoopLimits,
  verifyReasoningReplay,
} from './agent-loop';

const NOW = 1_700_000_000_000;
const TOOL_TAB = '00000000-0000-4000-8000-000000000001';

// ---------- 测试替身 ----------

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
    getActiveTab: async () => ({
      id: TOOL_TAB,
      title: '页',
      url: 'https://x/',
      active: true,
      state: 'ready',
    }),
    getPageSnapshot: async () => null,
    clickElement: async () => ({ ok: false, reason: '未接线', errorCode: 'execution-failed' }),
    fillElement: async () => ({ ok: false, reason: '未接线', errorCode: 'execution-failed' }),
    scrollTab: async () => ({
      ok: true,
      viewport: { scrollX: 0, scrollY: 0, width: 800, height: 600 },
    }),
    dispose: () => {},
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    url: 'https://example.com/',
    title: '测试页',
    headings: [],
    links: [],
    buttons: [{ id: 'el-1', text: '提交按钮', isSubmit: true, ariaExpanded: false }],
    inputs: [{ id: 'el-2', type: 'text', placeholder: '普通输入' }],
    meta: {
      documentId: 1,
      capturedAt: NOW,
      readyState: 'complete',
      degraded: 'none',
      warnings: [],
    },
    ...overrides,
  };
}

interface ToolLogEntry {
  name: string;
  args: Record<string, unknown>;
}

const toolLog: ToolLogEntry[] = [];

// 默认测试工具：真实工具名（权限矩阵判定生效）+ 注入式 executor（零 Electron）
function testToolDefs(): ToolDefinition[] {
  const snapshot = makeSnapshot();
  return [
    {
      name: 'browser_get_tabs',
      description: '列出标签页',
      parameters: { properties: {}, required: [] },
      baseRisk: 0,
      executor: async ({ id }) => {
        toolLog.push({ name: 'browser_get_tabs', args: {} });
        return { toolCallId: id, ok: true, content: '标签页摘要' };
      },
    },
    {
      name: 'browser_read',
      description: '读取页面',
      parameters: {
        properties: { tabId: { type: 'string', description: '标签页 id（可选）' } },
        required: [],
      },
      baseRisk: 0,
      executor: async ({ id, args }, ctx) => {
        const tabId =
          typeof args.tabId === 'string'
            ? args.tabId
            : ((await ctx.browser.getActiveTab())?.id ?? 't1');
        ctx.recordSnapshot?.(tabId, snapshot); // 登记点击语义（isSubmit 按钮 el-1）
        toolLog.push({ name: 'browser_read', args });
        return { toolCallId: id, ok: true, content: '页面章节摘要' };
      },
    },
    {
      name: 'browser_scroll',
      description: '滚动页面',
      parameters: {
        properties: { dy: { type: 'number', description: '像素' } },
        required: ['dy'],
      },
      paramRules: { dy: { integer: true, min: -50000, max: 50000 } },
      baseRisk: 0,
      executor: async ({ id, args }, ctx) => {
        const res = await ctx.browser.scrollTab(TOOL_TAB, Number(args.dy));
        toolLog.push({ name: 'browser_scroll', args });
        if (!res.ok) {
          return {
            toolCallId: id,
            ok: false,
            content: '滚动失败',
            errorCode: 'execution-failed' as const,
          };
        }
        return { toolCallId: id, ok: true, content: `已滚动 dy=${String(args.dy)}` };
      },
    },
    {
      name: 'browser_click',
      description: '点击元素',
      parameters: {
        properties: {
          elementId: { type: 'string', description: 'el-N' },
          tabId: { type: 'string', description: '标签页 id（可选）' },
        },
        required: ['elementId'],
      },
      baseRisk: 1,
      riskLift: { submitClick: 2 },
      executor: async ({ id, args }) => {
        toolLog.push({ name: 'browser_click', args });
        return { toolCallId: id, ok: true, content: `已点击 ${String(args.elementId)}` };
      },
    },
    {
      name: 'browser_fill',
      description: '填写输入框',
      parameters: {
        properties: {
          elementId: { type: 'string', description: 'el-N' },
          text: { type: 'string', description: '填写内容' },
        },
        required: ['elementId', 'text'],
      },
      baseRisk: 1,
      executor: async ({ id, args }) => {
        toolLog.push({ name: 'browser_fill', args });
        return { toolCallId: id, ok: true, content: `已填写 ${String(args.elementId)}` };
      },
    },
  ];
}

function toProviderTool(def: ToolDefinition): ProviderTool {
  return {
    type: 'function',
    function: {
      name: def.name,
      description: def.description,
      parameters: {
        type: 'object',
        properties: def.parameters.properties,
        required: def.parameters.required,
      },
    },
  };
}

let defaultTools: ProviderTool[] = [];

beforeEach(() => {
  resetToolRegistry();
  toolLog.length = 0;
  defaultTools = testToolDefs().map((def) => {
    registerTool(def);
    return toProviderTool(def);
  });
});
afterEach(() => {
  resetToolRegistry();
});

interface LoopFixture {
  loop: AgentLoop;
  provider: LLMProvider;
  confirm: ConfirmManager;
  auditEntries: AuditEntry[];
  deltas: string[];
  steps: ToolStep[];
  stepArgs: string[];
  statuses: Array<{ phase: string; toolName: string | null; stepsUsed: number; maxSteps: number }>;
  rounds: Array<{ roundText: string; toolCalls: ProviderToolCall[] }>;
  runSignal: AbortController;
}

function makeFixture(
  options: {
    script?: FakeProviderScript;
    provider?: LLMProvider;
    limits?: Partial<AgentLoopLimits>;
    tools?: ProviderTool[];
    browser?: BrowserController;
    sourceUsage?: SourceUsageContext;
  } = {},
): LoopFixture {
  const provider = options.provider ?? new FakeProvider(options.script ?? {});
  const confirm = new ConfirmManager();
  const auditEntries: AuditEntry[] = [];
  const deltas: string[] = [];
  const steps: ToolStep[] = [];
  const stepArgs: string[] = [];
  const statuses: LoopFixture['statuses'] = [];
  const rounds: Array<{ roundText: string; toolCalls: ProviderToolCall[] }> = [];
  const runSignal = new AbortController();
  const loop = new AgentLoop({
    requestId: 'run-1',
    goalMessage: { role: 'user', content: '帮我完成多步任务' },
    replayMessages: [],
    tools: options.tools ?? defaultTools,
    model: 'fake-model',
    providerResolver: async () => provider,
    confirmManager: confirm,
    browser: options.browser ?? fakeBrowser(),
    audit: (entry) => auditEntries.push(entry),
    now: () => NOW,
    limits: options.limits,
    ...(options.sourceUsage !== undefined ? { sourceUsage: options.sourceUsage } : {}),
    callbacks: {
      onStreamChunk: (delta) => deltas.push(delta),
      onAgentStep: (e) => {
        steps.push(e.step);
        stepArgs.push(e.argsSummary);
      },
      onAgentRound: (e) => rounds.push(e),
      onStatus: (e) => statuses.push(e),
    },
  });
  return {
    loop,
    provider,
    confirm,
    auditEntries,
    deltas,
    steps,
    stepArgs,
    statuses,
    rounds,
    runSignal,
  };
}

function tc(id: string, name: string, args: string): ProviderToolCall {
  return { id, name, arguments: args };
}

async function waitForPending(confirm: ConfirmManager, toolCallId: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(confirm.getPending()?.toolCallId).toBe(toolCallId);
    },
    { timeout: 5000 },
  );
}

// ---------- 多步任务与协议历史 ----------

describe('AgentLoop — 正常多步任务与协议历史', () => {
  it('多步：工具调用 → ToolResult → 模型继续 → 最终文本（done）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_read', '{}')] }],
        [{ kind: 'toolCalls', toolCalls: [tc('c2', 'browser_scroll', '{"dy":10}')] }],
        [{ text: '任务完成，这是最终回答。' }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('任务完成，这是最终回答。');
    expect(result.stepsUsed).toBe(2);
    expect(result.toolStepCount).toBe(2);
    expect(result.maxSteps).toBe(AGENT_MAX_STEPS);
    expect(f.steps.map((s) => s.name)).toEqual(['browser_read', 'browser_scroll']);
    expect(f.steps.every((s) => s.ok)).toBe(true);
    expect(f.deltas).toEqual(['任务完成，这是最终回答。']);
    expect(f.auditEntries.length).toBe(2); // 每步恰好一条审计
    expect(f.auditEntries[0].decision).toBe('auto');
  });

  it('协议历史合法序：每轮 assistant（toolCalls 按序）→ tool 消息同序精确关联', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          { text: '先做两件事。' },
          {
            kind: 'toolCalls',
            toolCalls: [
              tc('c-a', 'browser_scroll', '{"dy":1}'),
              tc('c-b', 'browser_get_tabs', '{}'),
            ],
          },
        ],
        [{ text: '完成' }],
      ],
    };
    const f = makeFixture({ script });
    await f.loop.run(f.runSignal.signal);
    const requests = (f.provider as FakeProvider).getRequests();
    expect(requests.length).toBe(2);
    const messages = requests[1].messages;
    // goal 恰好一次（首条）；后续 assistant → tool 相邻且顺序与 toolCalls 一致
    expect(messages[0].role).toBe('user');
    expect(messages.filter((m) => m.content === '帮我完成多步任务').length).toBe(1);
    const assistantIdx = messages.findIndex((m) => m.role === 'assistant');
    expect(messages[assistantIdx].content).toBe('先做两件事。');
    expect(messages[assistantIdx].toolCalls?.map((c) => c.id)).toEqual(['c-a', 'c-b']);
    expect(messages[assistantIdx + 1].role).toBe('tool');
    expect(messages[assistantIdx + 1].toolCallId).toBe('c-a');
    expect(messages[assistantIdx + 2].role).toBe('tool');
    expect(messages[assistantIdx + 2].toolCallId).toBe('c-b');
    // tool 消息内容为 UNTRUSTED_TOOL_RESULT 块（受控结构）
    expect(messages[assistantIdx + 1].content).toContain('<UNTRUSTED_TOOL_RESULT ok="true"');
    expect(messages[assistantIdx + 1].content).toContain('tool="browser_scroll"');
  });

  it('文本+toolCalls 同轮：文本为过程性输出（流事件转发、非最终回答），执行后继续模型轮', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          { text: '我先看一下页面。' },
          { kind: 'toolCalls', toolCalls: [tc('c1', 'browser_read', '{}')] },
        ],
        [{ text: '看完后的最终回答。' }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('看完后的最终回答。'); // 前导文本不是最终回答
    expect(f.deltas).toEqual(['我先看一下页面。', '看完后的最终回答。']); // 全部 delta 逐块转发
    expect(f.rounds[0]).toMatchObject({ roundText: '我先看一下页面。' });
  });

  it('多轮请求共享同一运行时 transcript：goal 不重复插入末条', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_read', '{}')] }],
        [{ kind: 'toolCalls', toolCalls: [tc('c2', 'browser_get_tabs', '{}')] }],
        [{ text: '完成' }],
      ],
    };
    const f = makeFixture({ script });
    await f.loop.run(f.runSignal.signal);
    const requests = (f.provider as FakeProvider).getRequests();
    expect(requests.length).toBe(3);
    const goalCount = requests[2].messages.filter((m) => m.role === 'user').length;
    expect(goalCount).toBe(1); // goal 只出现一次（不随轮次重复）
    expect(requests[2].messages.at(-1)?.role).toBe('tool'); // 末条为 tool 结果，不是 goal 重插
  });
});

// ---------- 错误路径与调整策略 ----------

describe('AgentLoop — 工具错误结构化回注与模型调整', () => {
  it('invalid-args 回注后模型调整策略成功（工具错误不以 ok:true 出现）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            kind: 'toolCalls',
            toolCalls: [tc('c1', 'browser_scroll', '{"tabId":"bad","dy":1}')], // 未知参数 → invalid-args
          },
        ],
        [{ kind: 'toolCalls', toolCalls: [tc('c2', 'browser_get_tabs', '{}')] }],
        [{ text: '调整后完成' }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    expect(result.stepsUsed).toBe(2);
    expect(f.steps[0].ok).toBe(false);
    expect(f.steps[0].errorCode).toBe('invalid-args');
    expect(f.steps[0].decision).toBe('invalid');
    expect(f.steps[1].ok).toBe(true);
    expect(result.finalText).toBe('调整后完成');
    // 错误结构化回注进块（模型可见错误码）
    const requests = (f.provider as FakeProvider).getRequests();
    const toolMsg = requests[1].messages.at(-1);
    expect(toolMsg?.content).toContain('error_code="invalid-args"');
  });

  it('tool-not-found 与 forbidden（L3）与 execution-failed 均结构化回注并继续', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              tc('c1', 'browser.nonexistent', '{}'),
              tc('c2', 'browser_click', '{"elementId":"el-9"}'), // 无语义 → L3
              tc('c3', 'browser_scroll', '{"dy":1,"unknownKey":2}'), // 校验失败（未知键）
            ],
          },
        ],
        [{ text: '都失败后的最终说明。' }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    expect(result.stepsUsed).toBe(3);
    expect(f.steps[0].errorCode).toBe('tool-not-found');
    expect(f.steps[1].errorCode).toBe('forbidden');
    expect(f.steps[2].errorCode).toBe('invalid-args');
    expect(f.auditEntries[0].decision).toBe('invalid');
    expect(f.auditEntries[1].decision).toBe('forbidden');
    expect(result.finalText).toBe('都失败后的最终说明。');
  });

  it('execution-failed 保留实际权限决策（L0 工具决策仍为 auto），每步审计恰好一条', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_scroll', '{"dy":1}')] }],
        [{ text: '结束' }],
      ],
    };
    const f = makeFixture({
      script,
      browser: fakeBrowser({ scrollTab: async () => ({ ok: false, reason: '滚动失败' }) }),
    });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    expect(f.steps[0].ok).toBe(false);
    expect(f.steps[0].errorCode).toBe('execution-failed');
    expect(f.steps[0].decision).toBe('auto'); // 实际权限决策保留（L0 自动）
    expect(f.auditEntries.length).toBe(1);
  });
});

// ---------- L2 确认状态机 ----------

describe('AgentLoop — L2 确认（approve/deny/取消/超时）', () => {
  const submitScript = (): FakeProviderScript => ({
    rounds: [
      [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_read', '{}')] }],
      [
        {
          kind: 'toolCalls',
          toolCalls: [tc('c2', 'browser_click', `{"elementId":"el-1","tabId":"${TOOL_TAB}"}`)],
        },
      ],
      [{ text: '确认流程完成。' }],
    ],
  });

  it('deny → denied-by-user 回注（decision=denied，无执行）；模型可继续', async () => {
    const f = makeFixture({ script: submitScript() });
    const promise = f.loop.run(f.runSignal.signal);
    await waitForPending(f.confirm, 'c2'); // pending 建立（L2 确认门）
    expect(f.confirm.deny('c2')).toBe(true);
    const result = await promise;
    expect(result.status).toBe('done');
    const clickStep = f.steps.find((s) => s.toolCallId === 'c2');
    expect(clickStep?.ok).toBe(false);
    expect(clickStep?.errorCode).toBe('denied-by-user');
    expect(clickStep?.decision).toBe('denied');
    expect(toolLog.filter((t) => t.name === 'browser_click').length).toBe(0); // 无执行
    expect(f.confirm.getPending()).toBeNull();
  });

  it('approve → 执行 + decision=confirmed', async () => {
    const f = makeFixture({ script: submitScript() });
    const promise = f.loop.run(f.runSignal.signal);
    await waitForPending(f.confirm, 'c2');
    expect(f.confirm.approve('c2')).toBe(true);
    const result = await promise;
    expect(result.status).toBe('done');
    const clickStep = f.steps.find((s) => s.toolCallId === 'c2');
    expect(clickStep?.ok).toBe(true);
    expect(clickStep?.decision).toBe('confirmed');
    expect(toolLog.filter((t) => t.name === 'browser_click').length).toBe(1);
  });

  it('取消（外部 abort）→ pending 作废 + cancelled 终态 + 无执行；终态后确认被忽略', async () => {
    const f = makeFixture({ script: submitScript() });
    const promise = f.loop.run(f.runSignal.signal);
    await waitForPending(f.confirm, 'c2');
    f.runSignal.abort(); // 用户停止
    const result = await promise;
    expect(result.status).toBe('cancelled');
    expect(f.confirm.getPending()).toBeNull(); // pending 全部作废
    expect(toolLog.filter((t) => t.name === 'browser_click').length).toBe(0); // 无执行
    // 终态后 approve/deny 幂等安全返回 false
    expect(f.confirm.approve('c2')).toBe(false);
    expect(f.confirm.deny('c2')).toBe(false);
  });

  it('总超时与确认等待竞争 → timeout 终态 + pending 作废 + 无执行', async () => {
    vi.useFakeTimers();
    try {
      const f = makeFixture({ script: submitScript(), limits: { totalTimeoutMs: 1000 } });
      const promise = f.loop.run(f.runSignal.signal);
      await vi.advanceTimersByTimeAsync(10); // 推进到 pending（微任务冲刷）
      expect(f.confirm.getPending()?.toolCallId).toBe('c2');
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result.status).toBe('timeout');
      expect(f.confirm.getPending()).toBeNull();
      expect(toolLog.filter((t) => t.name === 'browser_click').length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- 上限：step-limit ----------

describe('AgentLoop — step-limit 边界', () => {
  it('绝不超过 maxSteps（注入 2：一轮 3 调用只执行 2，未执行不伪造成功）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              tc('c1', 'browser_scroll', '{"dy":1}'),
              tc('c2', 'browser_scroll', '{"dy":2}'),
              tc('c3', 'browser_scroll', '{"dy":3}'),
            ],
          },
        ],
      ],
    };
    const f = makeFixture({ script, limits: { maxSteps: 2 } });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('step-limit');
    expect(result.stepsUsed).toBe(2);
    expect(result.maxSteps).toBe(2);
    expect(toolLog.filter((t) => t.name === 'browser_scroll').map((t) => t.args.dy)).toEqual([
      1, 2,
    ]);
    expect(f.steps.length).toBe(2);
    expect(f.auditEntries.length).toBe(2); // 未执行调用零审计零伪造
    expect(result.rounds[0].toolCalls.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']); // 完整轮记录
  });

  it('默认 12 步：绝不执行第 13 步（13 个不同签名调用 → 12 执行后 step-limit）', async () => {
    const calls = Array.from({ length: 13 }, (_, i) =>
      tc(`c${i}`, 'browser_scroll', `{"dy":${i + 1}}`),
    );
    const script: FakeProviderScript = { rounds: [[{ kind: 'toolCalls', toolCalls: calls }]] };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('step-limit');
    expect(result.stepsUsed).toBe(12);
    expect(toolLog.filter((t) => t.name === 'browser_scroll').length).toBe(12);
    expect(f.auditEntries.length).toBe(12);
  });

  it('步数用尽后下一轮若为最终回答 → done（不误判 step-limit）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_scroll', '{"dy":1}')] }],
        [{ text: '用尽步数后的回答。' }],
      ],
    };
    const f = makeFixture({ script, limits: { maxSteps: 1 } });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    expect(result.stepsUsed).toBe(1);
    expect(result.finalText).toBe('用尽步数后的回答。');
  });
});

// ---------- 防循环（执行前阻断） ----------

describe('AgentLoop — 防循环（触发次执行前阻断，零副作用）', () => {
  it('连续第三次同签名调用不执行（loop-detected；前两次已执行）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_scroll', '{"dy":5}')] }],
        [{ kind: 'toolCalls', toolCalls: [tc('c2', 'browser_scroll', '{"dy":5}')] }],
        [{ kind: 'toolCalls', toolCalls: [tc('c3', 'browser_scroll', '{"dy":5}')] }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('loop-detected');
    expect(result.stepsUsed).toBe(3); // 触发次也计入
    expect(toolLog.filter((t) => t.name === 'browser_scroll').length).toBe(2); // 第三次零副作用
    // 阻断步骤：decision=invalid + 恰好一条审计（无审计缺失/重复）
    expect(f.steps[2].ok).toBe(false);
    expect(f.steps[2].decision).toBe('invalid');
    expect(f.steps[2].contentPreview).toContain('循环');
    expect(f.auditEntries.length).toBe(3);
    expect(f.auditEntries[2].decision).toBe('invalid');
    expect(f.auditEntries[2].ok).toBe(false);
  });

  it('非连续累计第五次在执行前阻断（连续被其他签名打断）', async () => {
    const rounds: FakeProviderScript['rounds'] = [];
    for (let i = 1; i <= 4; i++) {
      rounds?.push([{ kind: 'toolCalls', toolCalls: [tc(`s${i}`, 'browser_scroll', '{"dy":7}')] }]);
      rounds?.push([{ kind: 'toolCalls', toolCalls: [tc(`r${i}`, 'browser_read', '{}')] }]);
    }
    rounds?.push([{ kind: 'toolCalls', toolCalls: [tc('s5', 'browser_scroll', '{"dy":7}')] }]);
    const f = makeFixture({ script: { rounds } });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('loop-detected');
    expect(toolLog.filter((t) => t.name === 'browser_scroll').length).toBe(4); // 第五次阻断
    expect(result.stepsUsed).toBe(9);
  });

  it('read 无白名单例外：连续第三次 read 阻断（决议 #24）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_read', '{}')] }],
        [{ kind: 'toolCalls', toolCalls: [tc('c2', 'browser_read', '{}')] }],
        [{ kind: 'toolCalls', toolCalls: [tc('c3', 'browser_read', '{}')] }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('loop-detected');
    expect(toolLog.filter((t) => t.name === 'browser_read').length).toBe(2);
  });

  it('invalid-args 的失败调用同样计签（键序变化不能逃避检测）', async () => {
    // 3 次同规范化签名（校验均失败 → invalid-args，但同样计签）→ 第三次在执行前阻断
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_scroll', '{"dy":1,"badKey":2}')] }],
        [{ kind: 'toolCalls', toolCalls: [tc('c2', 'browser_scroll', '{"badKey":2,"dy":1}')] }],
        [{ kind: 'toolCalls', toolCalls: [tc('c3', 'browser_scroll', '{"badKey":2,"dy":1}')] }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('loop-detected');
    expect(result.stepsUsed).toBe(3);
    expect(f.steps[0].errorCode).toBe('invalid-args');
    expect(f.steps[1].errorCode).toBe('invalid-args');
    expect(f.steps[2].decision).toBe('invalid'); // 安全阻断
    expect(toolLog.filter((t) => t.name === 'browser_scroll').length).toBe(0); // 全程零执行
  });
});

// ---------- no-progress ----------

describe('AgentLoop — no-progress 两轮终止', () => {
  it('连续两轮无文本无工具 → no-progress；第一轮空轮进入 transcript（重试痕迹）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_read', '{}')] }],
        [], // 空轮 1
        [], // 空轮 2 → 终止
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('no-progress');
    expect(result.stepsUsed).toBe(1);
    // 空轮 assistant 消息进入运行时 transcript（模型可见自身空轮 = 重试痕迹；
    // 连续两轮各留下一条空 assistant——终止轮同样有迹可查）
    const requests = (f.provider as FakeProvider).getRequests();
    const last = requests.at(-1)?.messages ?? [];
    expect(last.filter((m) => m.role === 'assistant' && m.content === '').length).toBe(2);
  });

  it('空轮被有内容的轮打断 → 不终止（连续计数语义）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [],
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_read', '{}')] }],
        [{ text: '恢复后的回答。' }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    expect(result.finalText).toBe('恢复后的回答。');
  });
});

// ---------- 超时 / 取消 / Provider 错误 ----------

describe('AgentLoop — 总超时 / Provider 错误 / 用户取消', () => {
  it('Provider 单轮错误（timeout）→ run 以 error 终止（错误直传，不重试）', async () => {
    const f = makeFixture({ script: { error: { code: 'timeout' } } });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('timeout');
    expect(result.stepsUsed).toBe(0);
  });

  it('Provider 解析异常（流抛出未协议异常）→ error 终态不挂起，部分文本保留', async () => {
    const badProvider: LLMProvider = {
      metadata: FAKE_PROVIDER_METADATA,
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: 'delta', text: '部分回答' };
        throw new Error('供应商流中断');
      },
    };
    const f = makeFixture({ provider: badProvider });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(result.finalText).toBe('部分回答');
  });

  it('用户取消（流中途 abort）→ cancelled + 部分文本保留', async () => {
    const script: FakeProviderScript = {
      rounds: [[{ text: '第一块' }, { text: '第二块', delayMs: 60_000 }, { text: '第三块' }]],
    };
    const f = makeFixture({ script });
    const promise = f.loop.run(f.runSignal.signal);
    await vi.waitFor(
      () => {
        expect(f.deltas.length).toBe(1);
      },
      { timeout: 5000 },
    );
    f.runSignal.abort();
    const result = await promise;
    expect(result.status).toBe('cancelled');
    expect(result.error?.code).toBe('aborted');
    expect(result.finalText).toBe('第一块');
  });

  it('Provider done 与用户 abort 竞态：先到者唯一所有权（done 后迟到 abort 被忽略）', async () => {
    const f = makeFixture({ script: { rounds: [[{ text: '快速回答' }]] } });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    f.runSignal.abort(); // 终态后 abort → 幂等忽略
    expect(result.status).toBe('done');
    expect(f.auditEntries.length).toBe(0);
  });

  it('provider done 被用户 abort 抢先（门闩流）→ cancelled 唯一终态；迟到 done 被忽略', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const gated: LLMProvider = {
      metadata: FAKE_PROVIDER_METADATA,
      async *stream(): AsyncIterable<ProviderEvent> {
        yield { type: 'delta', text: '部分' };
        await gate;
        yield { type: 'done' };
      },
    };
    const f = makeFixture({ provider: gated });
    const promise = f.loop.run(f.runSignal.signal);
    await vi.waitFor(
      () => {
        expect(f.deltas.length).toBe(1);
      },
      { timeout: 5000 },
    );
    f.runSignal.abort(); // abort 先于 done 到达
    const result = await promise;
    expect(result.status).toBe('cancelled');
    release(); // 释放门闩（迟到 done 被忽略）
  });

  it('总超时（注入时钟）→ timeout 终态；迟到工具结果被忽略', async () => {
    vi.useFakeTimers();
    try {
      const script: FakeProviderScript = {
        rounds: [
          [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_scroll', '{"dy":1}')] }],
          // 第二轮慢流（delay 远超总超时）→ 超时先于本轮完成（Provider 中止感知睡眠即停）
          [{ text: '慢', delayMs: 9_999_999 }],
        ],
      };
      const f = makeFixture({ script, limits: { totalTimeoutMs: 1000 } });
      const promise = f.loop.run(f.runSignal.signal);
      await vi.advanceTimersByTimeAsync(1000);
      const result = await promise;
      expect(result.status).toBe('timeout');
      expect(result.error?.code).toBe('timeout');
      expect(result.finalText).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------- 协议非法 fail-closed ----------

describe('AgentLoop — 工具调用协议非法 fail-closed', () => {
  it('空 toolCallId → error 终态，零执行零确认', async () => {
    const script: FakeProviderScript = {
      rounds: [[{ kind: 'toolCalls', toolCalls: [tc('', 'browser_scroll', '{"dy":1}')] }]],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('error');
    expect(result.error?.code).toBe('internal');
    expect(result.stepsUsed).toBe(0);
    expect(f.auditEntries.length).toBe(0); // 未进入管线：零审计零执行
  });

  it('同一轮内重复 toolCallId → error 终态（不重复执行/不错误确认）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              tc('dup', 'browser_scroll', '{"dy":1}'),
              tc('dup', 'browser_get_tabs', '{}'),
            ],
          },
        ],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('error');
    expect(toolLog.length).toBe(0);
  });

  it('跨轮重复 toolCallId → error 终态', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [tc('same', 'browser_scroll', '{"dy":1}')] }],
        [{ kind: 'toolCalls', toolCalls: [tc('same', 'browser_get_tabs', '{}')] }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('error');
    expect(toolLog.filter((t) => t.name === 'browser_scroll').length).toBe(1); // 第一轮已执行
    expect(toolLog.filter((t) => t.name === 'browser_get_tabs').length).toBe(0); // 第二轮零执行
  });
});

// ---------- 终态竞态与迟到事件 ----------

describe('AgentLoop — 终态竞态与迟到事件', () => {
  // 门闩工具：进入执行即置 started 标志，然后挂在 gate 上（模拟慢工具/不响应中止的工具）
  const slowScrollDef = (gate: Promise<void>, started: { value: boolean }): ToolDefinition => ({
    name: 'browser_scroll',
    description: '慢滚动',
    parameters: { properties: { dy: { type: 'number', description: 'x' } }, required: ['dy'] },
    paramRules: { dy: { integer: true, min: -50000, max: 50000 } },
    baseRisk: 0,
    executor: async ({ id }) => {
      started.value = true;
      await gate;
      toolLog.push({ name: 'browser_scroll', args: {} });
      return { toolCallId: id, ok: true, content: '迟到结果' };
    },
  });

  it('取消时工具 executor 尚未返回 → 迟到结果被忽略（无 step 事件、审计仍恰好一条）', async () => {
    let releaseTool: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTool = () => resolve();
    });
    const started = { value: false };
    resetToolRegistry();
    const def = slowScrollDef(gate, started);
    registerTool(def);
    const script: FakeProviderScript = {
      rounds: [[{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_scroll', '{"dy":1}')] }]],
    };
    const f = makeFixture({ script, tools: [toProviderTool(def)] });
    const promise = f.loop.run(f.runSignal.signal);
    await vi.waitFor(() => {
      expect(started.value).toBe(true); // 工具已进入执行（挂起中）
    });
    f.runSignal.abort();
    const result = await promise;
    expect(result.status).toBe('cancelled');
    releaseTool();
    await vi.waitFor(() => {
      expect(f.auditEntries.length).toBe(1); // 恰好一条（不重复）
    });
    expect(f.steps.length).toBe(0); // 迟到结果不产生 step 事件
  });

  it('终态后不再执行后续工具（步进循环检查终态）', async () => {
    let releaseTool: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseTool = () => resolve();
    });
    const started = { value: false };
    resetToolRegistry();
    const def = slowScrollDef(gate, started);
    registerTool(def);
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              tc('c1', 'browser_scroll', '{"dy":1}'),
              tc('c2', 'browser_scroll', '{"dy":2}'),
              tc('c3', 'browser_scroll', '{"dy":3}'),
            ],
          },
        ],
      ],
    };
    const f = makeFixture({ script, tools: [toProviderTool(def)] });
    const promise = f.loop.run(f.runSignal.signal);
    await vi.waitFor(
      () => {
        expect(started.value).toBe(true);
      },
      { timeout: 5000 },
    );
    f.runSignal.abort();
    const result = await promise;
    expect(result.status).toBe('cancelled');
    releaseTool();
    await vi.waitFor(() => {
      expect(f.auditEntries.length).toBe(1); // 第 2/3 个调用零审计（未进入管线）
    });
  });
});

// ---------- 常量 ----------

describe('AgentLoop — 上限常量', () => {
  it('AGENT_MAX_STEPS=12 / AGENT_TOTAL_TIMEOUT_MS=420s；limits 可注入', () => {
    expect(AGENT_MAX_STEPS).toBe(12);
    expect(AGENT_TOTAL_TIMEOUT_MS).toBe(420_000);
    const partial: Partial<AgentLoopLimits> = { maxSteps: 3 };
    expect(partial.maxSteps).toBe(3);
  });
});

// ---------- A6：状态事件（onStatus）与 step 参数摘要（argsSummary 审计同源） ----------

describe('AgentLoop — onStatus 阶段事件（A6 实时可见性，确定性运行事实）', () => {
  it('阶段序列：thinking → executing（工具名+计数）→ finalizing，与步数一致', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_read', '{}')] }],
        [{ kind: 'toolCalls', toolCalls: [tc('c2', 'browser_scroll', '{"dy":10}')] }],
        [{ text: '任务完成，这是最终回答。' }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    expect(f.statuses).toEqual([
      { phase: 'thinking', toolName: null, stepsUsed: 0, maxSteps: 12 },
      { phase: 'executing', toolName: 'browser_read', stepsUsed: 1, maxSteps: 12 },
      { phase: 'thinking', toolName: null, stepsUsed: 1, maxSteps: 12 },
      { phase: 'executing', toolName: 'browser_scroll', stepsUsed: 2, maxSteps: 12 },
      { phase: 'thinking', toolName: null, stepsUsed: 2, maxSteps: 12 },
      { phase: 'finalizing', toolName: null, stepsUsed: 2, maxSteps: 12 },
    ]);
  });

  it('executing 事件在执行管线前发出（stepsUsed 已计当前步，与 A5 计数一致）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            kind: 'toolCalls',
            toolCalls: [tc('c1', 'browser_get_tabs', '{}'), tc('c2', 'browser_read', '{}')],
          },
        ],
        [{ text: '完成' }],
      ],
    };
    const f = makeFixture({ script });
    await f.loop.run(f.runSignal.signal);
    const executing = f.statuses.filter((s) => s.phase === 'executing');
    expect(executing.map((s) => [s.toolName, s.stepsUsed])).toEqual([
      ['browser_get_tabs', 1],
      ['browser_read', 2],
    ]);
  });

  it('终态后无迟到状态事件（慢模型轮中取消——cancelled 且取消后零状态事件）', async () => {
    // 第二轮为慢模型轮（FakeProvider 延迟块）：thinking(2) 已发出后取消——终态后
    // 不得再有 thinking/executing/finalizing（迟到事件被忽略）
    const f = makeFixture({
      script: {
        rounds: [
          [
            {
              kind: 'toolCalls',
              toolCalls: [tc('c1', 'browser_read', '{}')],
            },
          ],
          [{ text: '慢速回答', delayMs: 10_000 }],
        ],
      },
    });
    const run = f.loop.run(f.runSignal.signal);
    await vi.waitFor(
      () => {
        expect(f.statuses.filter((s) => s.phase === 'thinking').length).toBe(2);
      },
      { timeout: 5000 },
    );
    f.runSignal.abort();
    const result = await run;
    expect(result.status).toBe('cancelled');
    expect(f.statuses.some((s) => s.phase === 'finalizing')).toBe(false); // done 不触发
    const afterCancel = f.statuses.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.statuses.length).toBe(afterCancel); // 终态后零状态事件
  });

  it('防循环阻断的调用不产生 executing 事件（触发次零副作用）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            kind: 'toolCalls',
            toolCalls: [tc('c1', 'browser_scroll', '{"dy":1}')],
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [tc('c2', 'browser_scroll', '{"dy":1}')],
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [tc('c3', 'browser_scroll', '{"dy":1}')],
          },
        ],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('loop-detected');
    expect(f.statuses.filter((s) => s.phase === 'executing')).toHaveLength(2); // 仅前两次真实执行
  });
});

describe('AgentLoop — onAgentStep argsSummary（审计同源脱敏摘要，A6 非持久化可见性）', () => {
  it('合法参数：argsSummary 与审计条目同源一致', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            kind: 'toolCalls',
            toolCalls: [tc('c1', 'browser_scroll', '{"dy":10}')],
          },
        ],
        [{ text: '完成' }],
      ],
    };
    const f = makeFixture({ script });
    await f.loop.run(f.runSignal.signal);
    expect(f.stepArgs).toEqual([f.auditEntries[0]?.argsSummary]);
    expect(f.stepArgs[0]).toBe('{dy:10}');
  });

  it('fill 参数：argsSummary 只记长度（原文零出现）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            kind: 'toolCalls',
            toolCalls: [tc('c1', 'browser_fill', '{"elementId":"el-9","text":"绝密输入值"}')],
          },
        ],
        [{ text: '完成' }],
      ],
    };
    const f = makeFixture({ script });
    await f.loop.run(f.runSignal.signal);
    expect(f.stepArgs.join('')).not.toContain('绝密输入值');
    expect(f.stepArgs[0]).toContain('text=len:');
  });

  it('防循环阻断路径：argsSummary 用原始参数截断（与审计一致）', async () => {
    const script: FakeProviderScript = {
      rounds: [1, 2, 3].map((i) => [
        { kind: 'toolCalls', toolCalls: [tc(`c${i}`, 'browser_scroll', '{"dy":1}')] },
      ]),
    };
    const f = makeFixture({ script });
    await f.loop.run(f.runSignal.signal);
    expect(f.steps).toHaveLength(3);
    const blocked = f.auditEntries[2];
    expect(blocked?.decision).toBe('invalid');
    expect(f.stepArgs[2]).toBe(blocked?.argsSummary);
    expect(f.stepArgs[2]).toBe('{"dy":1}');
  });
});

describe('reasoning 不透明回传（A7 补验校准：thinking 模式工具轮 reasoning 只进下一轮请求，不进结果/回调/审计）', () => {
  it('模型轮 reasoning 累积并在下一轮请求的 assistant 消息中原样回传；run 结果与回调零暴露', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          { kind: 'reasoning', text: '先读取页面再决定' },
          { kind: 'toolCalls', toolCalls: [tc('c1', 'browser_read', '{}')] },
        ],
        [{ kind: 'reasoning', text: '内容已足够，直接回答' }, { text: '任务完成' }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    const requests = (f.provider as FakeProvider).getRequests();
    expect(requests).toHaveLength(2);
    // 第二轮请求必须携带第一轮 assistant（toolCalls）的 reasoning_content 等价 IR 字段
    const assistantWithTools = requests[1].messages.find(
      (m) => m.role === 'assistant' && m.toolCalls !== undefined,
    );
    expect(assistantWithTools?.reasoning).toBe('先读取页面再决定');
    // 第二轮请求中的 assistant 只有工具轮一条（终态轮在其后才产生，不进入任何请求）
    expect(requests[1].messages.filter((m) => m.role === 'assistant')).toHaveLength(1);
    // run 结果与回调零暴露：rounds 记录无 reasoning 字段；round 回调载荷无 reasoning
    expect(JSON.stringify(result.rounds)).not.toContain('先读取页面再决定');
    expect(JSON.stringify(f.rounds)).not.toContain('先读取页面再决定');
    // 审计/步骤零暴露
    expect(JSON.stringify(f.auditEntries)).not.toContain('先读取页面再决定');
    expect(JSON.stringify(f.steps)).not.toContain('先读取页面再决定');
  });

  it('无 toolCalls 的空轮不携带 reasoning（Provider 只要求工具轮回传）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ kind: 'reasoning', text: '空想一轮' }],
        [{ kind: 'toolCalls', toolCalls: [tc('c1', 'browser_read', '{}')] }],
        [{ text: '完成' }],
      ],
    };
    const f = makeFixture({ script });
    const result = await f.loop.run(f.runSignal.signal);
    expect(result.status).toBe('done');
    const requests = (f.provider as FakeProvider).getRequests();
    const emptyAssistant = requests[1].messages.find(
      (m) => m.role === 'assistant' && m.content === '' && m.toolCalls === undefined,
    );
    expect(emptyAssistant?.reasoning).toBeUndefined();
  });
});

describe('verifyReasoningReplay — reasoning_content 回传内容相等校验纯函数（决议 #35）', () => {
  it('数量/顺序/内容全等 → true（空数组亦通过）', () => {
    expect(verifyReasoningReplay([], [])).toBe(true);
    expect(verifyReasoningReplay(['思考甲'], ['思考甲'])).toBe(true);
    expect(verifyReasoningReplay(['思考甲', '思考乙'], ['思考甲', '思考乙'])).toBe(true);
    expect(verifyReasoningReplay(['', '思考乙'], ['', '思考乙'])).toBe(true);
  });

  it('内容不符 → false（不得仅凭长度判定——同长度不同内容必须拒绝）', () => {
    expect(verifyReasoningReplay(['思考甲'], ['思考乙'])).toBe(false);
    expect(verifyReasoningReplay(['甲乙丙'], ['甲丙乙'])).toBe(false); // 同长度、内容错位
  });

  it('数量不符（缺失/多出/截断）→ false', () => {
    expect(verifyReasoningReplay(['思考甲'], [])).toBe(false); // 收到但未回传
    expect(verifyReasoningReplay([], ['思考甲'])).toBe(false); // 多出
    expect(verifyReasoningReplay(['思考甲', '思考乙'], ['思考甲'])).toBe(false); // 漏回传一轮
    expect(verifyReasoningReplay(['思考甲'], ['思考甲', '思考乙'])).toBe(false); // 多回传一轮
  });

  it('顺序错位 → false', () => {
    expect(verifyReasoningReplay(['思考甲', '思考乙'], ['思考乙', '思考甲'])).toBe(false);
  });
});

describe('B6 sourceUsage 桥（决议 #79/#81：run 级 hints 装配透传 + 终态清空）', () => {
  function usageSpy(): { context: SourceUsageContext; clearRun: ReturnType<typeof vi.fn> } {
    const clearRun = vi.fn();
    const context: SourceUsageContext = {
      recordSearchHits: () => {},
      onBrowserOpen: () => {},
      clearRun,
    };
    return { context, clearRun };
  }

  it('ctx 透传：executor 收到的 ctx.sourceUsage 为装配实例', async () => {
    let seen: unknown = null;
    const probe: ToolDefinition = {
      // 真实工具名（权限矩阵 TOOL_BASE_RISK 判定生效——探针名不可走 L3 拒绝路径）
      name: 'browser_read',
      description: '探针',
      parameters: { properties: {}, required: [] },
      baseRisk: 0,
      executor: async ({ id }, ctx) => {
        seen = ctx.sourceUsage ?? null;
        return { toolCallId: id, ok: true, content: 'ok' };
      },
    };
    resetToolRegistry();
    registerTool(probe);
    const usage = usageSpy();
    const f = makeFixture({
      script: {
        rounds: [
          [
            {
              kind: 'toolCalls',
              toolCalls: [{ id: 'c1', name: 'browser_read', arguments: '{}' }],
            },
          ],
          [{ text: '完成' }],
        ],
      },
      tools: [toProviderTool(probe)],
      sourceUsage: usage.context,
    });
    const res = await f.loop.run(f.runSignal.signal);
    expect(res.status).toBe('done');
    expect(seen).toBe(usage.context);
  });

  it('终态（done）→ clearRun 恰好一次', async () => {
    const usage = usageSpy();
    const f = makeFixture({
      script: { rounds: [[{ text: '直接回答' }]] },
      sourceUsage: usage.context,
    });
    const res = await f.loop.run(f.runSignal.signal);
    expect(res.status).toBe('done');
    expect(usage.clearRun).toHaveBeenCalledTimes(1);
  });

  it('终态（cancelled）→ clearRun 恰好一次', async () => {
    const usage = usageSpy();
    const f = makeFixture({
      // 首块立即可达（取消时机锚点）；第二块 60s 延迟（慢流中止点）
      script: { chunks: [{ text: '首块' }, { text: '慢', delayMs: 60_000 }] },
      sourceUsage: usage.context,
    });
    const runPromise = f.loop.run(f.runSignal.signal);
    await vi.waitFor(() => {
      expect(f.deltas.length).toBeGreaterThan(0);
    });
    f.runSignal.abort();
    const res = await runPromise;
    expect(res.status).toBe('cancelled');
    expect(usage.clearRun).toHaveBeenCalledTimes(1);
  });

  it('终态（timeout）→ clearRun 恰好一次', async () => {
    const usage = usageSpy();
    const f = makeFixture({
      script: { chunks: [{ text: '慢', delayMs: 60_000 }] },
      limits: { totalTimeoutMs: 20, maxSteps: 12 },
      sourceUsage: usage.context,
    });
    const res = await f.loop.run(f.runSignal.signal);
    expect(res.status).toBe('timeout');
    expect(usage.clearRun).toHaveBeenCalledTimes(1);
  });

  it('终态后迟到工具结果的 usage 回调发生在 clearRun 之后（hints 已清空，零写入）', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];
    const probe: ToolDefinition = {
      // 真实工具名（权限矩阵判定生效；探针名走 L3 拒绝路径则 executor 不执行）
      name: 'browser_read',
      description: '慢工具',
      parameters: { properties: {}, required: [] },
      baseRisk: 0,
      executor: async ({ id }, ctx) => {
        await gate; // 终态后才返回（迟到结果）
        ctx.sourceUsage?.onBrowserOpen('https://example.com/x', true);
        events.push('late-callback');
        return { toolCallId: id, ok: true, content: 'ok' };
      },
    };
    resetToolRegistry();
    registerTool(probe);
    const usage: SourceUsageContext = {
      recordSearchHits: () => {},
      onBrowserOpen: () => {},
      clearRun: () => events.push('clearRun'),
    };
    const f = makeFixture({
      script: {
        rounds: [
          [
            {
              kind: 'toolCalls',
              toolCalls: [{ id: 'c1', name: 'browser_read', arguments: '{}' }],
            },
          ],
        ],
      },
      tools: [toProviderTool(probe)],
      sourceUsage: usage,
    });
    const runPromise = f.loop.run(f.runSignal.signal);
    await vi.waitFor(() => {
      expect(f.statuses.some((s) => s.phase === 'executing')).toBe(true);
    });
    f.runSignal.abort();
    const res = await runPromise;
    expect(res.status).toBe('cancelled');
    release();
    await gate;
    await new Promise((resolve) => setTimeout(resolve, 0)); // 迟到回调微任务冲刷
    expect(events).toEqual(['clearRun', 'late-callback']);
  });
});
