// agent-history 纯函数测试（A5）：ToolStep 组装（不含 fill 原文/快照正文/documentId/
// allowedKind 等内部能力信息）、assistant toolCalls 脱敏持久化、完整交互组校验、
// 跨 run 重放（tool 消息只重放摘要；不完整组/孤立 tool 消息整体过滤）。
// 契约源：doc/stage3/detailed-design.md §9.1/§9.3 + 决议 #33。
import { describe, expect, it } from 'vitest';
import type { ConversationMessage } from '../../../shared/types/conversation';
import type { ToolStepDecision } from '../../../shared/types/agent';
import { CONTEXT_BUDGET } from '../context-budget';
import {
  FILL_MASK,
  TOOL_STEP_PREVIEW_MAX,
  buildFinalAgentMessage,
  buildRoundAssistantMessage,
  buildToolStep,
  buildToolStepMessage,
  filterIncompleteToolGroups,
  replayToProviderMessages,
  sanitizeToolCallsForPersistence,
} from './agent-history';

const NOW = 1_700_000_000_000;

describe('buildToolStep（精简步骤组装）', () => {
  it('成功步骤：id/toolCallId/name/ok/contentPreview/decision/createdAt；不含内部能力字段', () => {
    const step = buildToolStep(
      { id: 'tc-1', name: 'browser.read', arguments: '{}' },
      { toolCallId: 'tc-1', ok: true, content: '页面章节摘要' },
      'auto',
      NOW,
    );
    expect(step).toEqual({
      id: 'tc-1',
      toolCallId: 'tc-1',
      name: 'browser.read',
      ok: true,
      contentPreview: '页面章节摘要',
      decision: 'auto',
      createdAt: NOW,
    });
    // 内部能力信息零出现（documentId/allowedKind/原始 arguments 不入步骤）
    const json = JSON.stringify(step);
    expect(json).not.toContain('documentId');
    expect(json).not.toContain('allowedKind');
    expect(json).not.toContain('arguments');
  });

  it('失败步骤：ok=false + errorCode + 决策保留（execution-failed 保留实际权限决策）', () => {
    const step = buildToolStep(
      { id: 'tc-2', name: 'browser.click', arguments: '{"elementId":"el-1"}' },
      {
        toolCallId: 'tc-2',
        ok: false,
        content: '元素不可交互',
        errorCode: 'execution-failed',
      },
      'auto-visible',
      NOW,
    );
    expect(step.ok).toBe(false);
    expect(step.errorCode).toBe('execution-failed');
    expect(step.decision).toBe('auto-visible'); // L1 自动显著展示 + 执行失败 → 决策不变
  });

  it('contentPreview 确定性截断 ≤ 200；fill 值以「（已输入 N 字符）」形态出现（原文零出现）', () => {
    const long = '长'.repeat(300);
    const step = buildToolStep(
      { id: 'tc-3', name: 'browser.read', arguments: '{}' },
      { toolCallId: 'tc-3', ok: true, content: long },
      'auto',
      NOW,
    );
    expect(step.contentPreview.length).toBeLessThanOrEqual(TOOL_STEP_PREVIEW_MAX);
    expect(step.contentPreview).toContain('…[已截断]');
    // fill 步骤：content 为 executor 摘要（不含原文）；FILL_MASK 为脱敏形态
    expect(FILL_MASK(5)).toBe('（已输入 5 字符）');
  });

  it('decision 枚举闭合：invalid 用于校验前失败/安全阻断（决议 #33 单一事实源）', () => {
    const decisions: ToolStepDecision[] = [
      'auto',
      'auto-visible',
      'confirmed',
      'denied',
      'forbidden',
      'invalid',
    ];
    for (const decision of decisions) {
      const step = buildToolStep(
        { id: 't', name: 'browser.read', arguments: '{}' },
        { toolCallId: 't', ok: false, content: 'x' },
        decision,
        NOW,
      );
      expect(step.decision).toBe(decision);
    }
  });
});

describe('sanitizeToolCallsForPersistence（assistant toolCalls 脱敏）', () => {
  it('browser.fill 的 arguments 中 text 替换为「（已输入 N 字符）」；其余工具原样', () => {
    const out = sanitizeToolCallsForPersistence([
      { id: 'c1', name: 'browser.fill', arguments: '{"elementId":"el-1","text":"机密值XYZ"}' },
      { id: 'c2', name: 'browser.read', arguments: '{"tabId":"t1"}' },
    ]);
    expect(out[0].name).toBe('browser.fill');
    const args = JSON.parse(out[0].arguments) as Record<string, unknown>;
    expect(args.text).toBe('（已输入 6 字符）'); // 机密值XYZ → 6 字符
    expect(out[0].arguments).not.toContain('机密值XYZ');
    expect(args.elementId).toBe('el-1');
    expect(out[1]).toEqual({ id: 'c2', name: 'browser.read', arguments: '{"tabId":"t1"}' });
  });

  it('fill arguments 非法 JSON → 原样保留（不抛异常；已存在的原文形态属模型输入回显）', () => {
    const raw = '{"text":"x"';
    const out = sanitizeToolCallsForPersistence([
      { id: 'c1', name: 'browser.fill', arguments: raw },
    ]);
    expect(out[0].arguments).toBe(raw);
  });

  it('返回全新数组（不修改入参）', () => {
    const input = [{ id: 'c1', name: 'browser.fill', arguments: '{"text":"abc"}' }];
    const out = sanitizeToolCallsForPersistence(input);
    expect(out).not.toBe(input);
    expect(input[0].arguments).toBe('{"text":"abc"}');
  });
});

describe('持久化消息组装（每轮文本恰好落盘一次，无重复拼接）', () => {
  it('工具轮 assistant 消息：轮次文本 + 脱敏 toolCalls（status=complete）', () => {
    const message = buildRoundAssistantMessage({
      id: 'm1',
      text: '我先读取页面。',
      toolCalls: [{ id: 'c1', name: 'browser.fill', arguments: '{"text":"秘密"}' }],
      now: NOW,
    });
    expect(message.role).toBe('assistant');
    expect(message.content).toBe('我先读取页面。');
    expect(message.status).toBe('complete');
    expect(message.toolCalls?.[0].arguments).not.toContain('秘密');
    expect(message.agentRun).toBeUndefined();
  });

  it('tool 消息：toolCallId 精确关联 + content = 摘要 + toolStep 携带精简步骤', () => {
    const step = buildToolStep(
      { id: 'tc-1', name: 'browser.read' },
      { toolCallId: 'tc-1', ok: true, content: '摘要内容' },
      'auto',
      NOW,
    );
    const message = buildToolStepMessage({ id: 'mt-1', step, now: NOW });
    expect(message.role).toBe('tool');
    expect(message.toolCallId).toBe('tc-1');
    expect(message.content).toBe('摘要内容');
    expect(message.toolStep).toEqual(step);
    expect(message.status).toBe('complete');
    // 快照正文/documentId/fill 原文零出现
    const json = JSON.stringify(message);
    expect(json).not.toContain('documentId');
  });

  it('终态 assistant 消息：finalText + agentRun 摘要（终止轮 toolCalls 可携带）', () => {
    const message = buildFinalAgentMessage({
      id: 'mf-1',
      text: '最终回答全文',
      status: 'complete',
      agentRun: {
        requestId: 'r1',
        sessionId: 's1',
        status: 'done',
        stepsUsed: 3,
        maxSteps: 12,
        finalText: '最终回答全文',
        toolStepCount: 3,
      },
      now: NOW,
    });
    expect(message.role).toBe('assistant');
    expect(message.content).toBe('最终回答全文');
    expect(message.status).toBe('complete');
    expect(message.agentRun).toMatchObject({ status: 'done', stepsUsed: 3 });
  });

  it('终止轮 assistant 消息可携带脱敏 toolCalls（step-limit 边界：未执行调用不伪造结果）', () => {
    const message = buildFinalAgentMessage({
      id: 'mf-2',
      text: '',
      status: 'error',
      errorCode: 'internal',
      toolCalls: [{ id: 'c9', name: 'browser.fill', arguments: '{"text":"未执行的秘密"}' }],
      agentRun: {
        requestId: 'r1',
        sessionId: 's1',
        status: 'step-limit',
        stepsUsed: 12,
        maxSteps: 12,
        finalText: '',
        toolStepCount: 12,
      },
      now: NOW,
    });
    expect(message.toolCalls?.[0].arguments).not.toContain('未执行的秘密');
    expect(message.content).toBe('');
  });
});

describe('filterIncompleteToolGroups（完整交互组校验）', () => {
  const assistant = (id: string, ids: string[]): ConversationMessage => ({
    id,
    role: 'assistant',
    content: '',
    createdAt: NOW,
    status: 'complete',
    toolCalls: ids.map((tc) => ({ id: tc, name: 'browser.read', arguments: '{}' })),
  });
  const tool = (id: string, tc: string): ConversationMessage => ({
    id,
    role: 'tool',
    toolCallId: tc,
    content: '摘要',
    createdAt: NOW,
    status: 'complete',
    toolStep: {
      id: tc,
      toolCallId: tc,
      name: 'browser.read',
      ok: true,
      contentPreview: '摘要',
      decision: 'auto',
      createdAt: NOW,
    },
  });
  const user = (id: string): ConversationMessage => ({
    id,
    role: 'user',
    content: '目标',
    createdAt: NOW,
    status: 'complete',
  });

  it('完整组（assistant toolCalls 全覆盖 + 同序 tool 消息）保留', () => {
    const kept = filterIncompleteToolGroups([
      user('u1'),
      assistant('a1', ['c1', 'c2']),
      tool('t1', 'c1'),
      tool('t2', 'c2'),
    ]);
    expect(kept.kept.map((m) => m.id)).toEqual(['u1', 'a1', 't1', 't2']);
    expect(kept.dropped).toBe(0);
  });

  it('孤立 tool 消息（无前导 assistant toolCalls 对应）丢弃', () => {
    const out = filterIncompleteToolGroups([user('u1'), tool('t1', 'c1')]);
    expect(out.kept.map((m) => m.id)).toEqual(['u1']);
    expect(out.dropped).toBe(1);
  });

  it('不完整组（toolCalls 缺 tool 消息）→ 整组丢弃（assistant + 其 tool 消息）', () => {
    const out = filterIncompleteToolGroups([
      user('u1'),
      assistant('a1', ['c1', 'c2']),
      tool('t1', 'c1'),
    ]);
    expect(out.kept.map((m) => m.id)).toEqual(['u1']);
    expect(out.dropped).toBe(2); // assistant + 1 条 tool 消息
  });

  it('toolCallId 不匹配（错误关联）→ 整组丢弃（fail-closed 不错误确认）', () => {
    const out = filterIncompleteToolGroups([
      user('u1'),
      assistant('a1', ['c1']),
      tool('t1', 'OTHER'),
    ]);
    expect(out.kept.map((m) => m.id)).toEqual(['u1']);
    expect(out.dropped).toBe(2);
  });

  it('组间独立：前一坏组丢弃不影响后续完整组', () => {
    const out = filterIncompleteToolGroups([
      user('u1'),
      assistant('a1', ['c1']),
      tool('t1', 'c1'),
      assistant('a2', ['c2']), // 坏组
      assistant('a3', ['c3']),
      tool('t3', 'c3'),
    ]);
    expect(out.kept.map((m) => m.id)).toEqual(['u1', 'a1', 't1', 'a3', 't3']);
  });

  it('无 toolCalls 的 assistant/user 消息不受影响', () => {
    const plain: ConversationMessage = {
      id: 'p1',
      role: 'assistant',
      content: '纯文本回答',
      createdAt: NOW,
      status: 'complete',
    };
    const out = filterIncompleteToolGroups([user('u1'), plain]);
    expect(out.kept.length).toBe(2);
  });
});

describe('replayToProviderMessages（跨 run 重放：摘要 + 预算 + 合法分组）', () => {
  const user = (id: string, content = '目标'): ConversationMessage => ({
    id,
    role: 'user',
    content,
    createdAt: NOW,
    status: 'complete',
  });
  const assistantRound = (id: string, text: string): ConversationMessage => ({
    id,
    role: 'assistant',
    content: text,
    createdAt: NOW,
    status: 'complete',
    toolCalls: [{ id: `${id}-c`, name: 'browser.read', arguments: '{}' }],
  });
  const toolMsg = (id: string): ConversationMessage => ({
    id,
    role: 'tool',
    toolCallId: `${id}-c`,
    content: '页面摘要（≤200）',
    createdAt: NOW,
    status: 'complete',
    toolStep: {
      id: `${id}-c`,
      toolCallId: `${id}-c`,
      name: 'browser.read',
      ok: true,
      contentPreview: '页面摘要（≤200）',
      decision: 'auto',
      createdAt: NOW,
    },
  });

  it('tool 消息重放内容 = 摘要（非全文）；assistant toolCalls 重放；role 程序字面量', () => {
    const messages = [user('u1'), assistantRound('a1', '轮次文本'), toolMsg('a1')];
    const out = replayToProviderMessages(messages);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(out[1].content).toBe('轮次文本');
    expect(out[1].toolCalls?.[0].id).toBe('a1-c');
    expect(out[2].toolCallId).toBe('a1-c');
    expect(out[2].content).toBe('页面摘要（≤200）');
  });

  it('重放预算：按完整交互组从最近裁剪（不产生孤立 tool 消息/残缺组）', () => {
    // 每组约 15 字符；小预算只留最近若干完整组
    const smallBudget = { ...CONTEXT_BUDGET, historyMaxChars: 60 };
    const groups: ConversationMessage[] = [user('u1')];
    for (let i = 1; i <= 5; i++) {
      groups.push(assistantRound(`a${i}`, `轮次${i}文本`), toolMsg(`a${i}`));
    }
    const out = replayToProviderMessages(groups, smallBudget);
    // 组（assistant+tool）必须成对保留
    const roles = out.map((m) => m.role);
    expect(roles.filter((r) => r === 'tool').length).toBe(
      roles.filter((r) => r === 'assistant').length,
    );
    expect(out.length).toBeLessThan(groups.length);
    for (let i = 0; i < out.length; i++) {
      if (out[i].role === 'assistant' && out[i].toolCalls !== undefined) {
        expect(out[i + 1]?.role).toBe('tool');
      }
    }
  });

  it('不完整组/孤立 tool 消息在重放前被过滤（fail-closed）', () => {
    const messages = [
      user('u1'),
      assistantRound('a1', 'x'), // 缺 tool 消息 → 整组丢弃
      { ...toolMsg('orphan'), id: 'orphan-1', toolCallId: 'no-such' }, // 孤立 → 丢弃
      assistantRound('a2', 'y'),
      toolMsg('a2'),
    ];
    const out = replayToProviderMessages(messages);
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(out[1].content).toBe('y');
  });
});
