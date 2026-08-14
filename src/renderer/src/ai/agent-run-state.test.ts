// agent-run-state 纯 reducer 单测（A6 红→绿先写）。契约源：doc/stage3/detailed-design.md §11
// + 用户开工要求（事件充分性核查结论）：状态按 requestId/sessionId 键控；step id 去重；
// 错误会话/错误 requestId/旧 run 事件忽略；run-done 幂等；终态后迟到事件忽略（不得把
// 终态改回 running）；新 run 不继承旧 run 的 pending/steps/终止理由；确认作废与 run
// 终态收敛；会话切换后后台 run 状态不串到当前会话。
import { describe, expect, it } from 'vitest';
import type {
  AgentConfirmRequest,
  AgentRunDoneEvent,
  AgentRunSummary,
  AgentStatusEvent,
  AgentStepEvent,
  ToolStep,
} from '../../../shared/types/agent';
import type { ConversationMessage } from '../../../shared/types/conversation';
import {
  INITIAL_AGENT_RUNS_STATE,
  globalPendingRequest,
  reduceAgentRuns,
  runForSession,
} from './agent-run-state';

const stepOf = (toolCallId: string, name = 'browser.read'): ToolStep => ({
  id: toolCallId,
  toolCallId,
  name,
  ok: true,
  contentPreview: `摘要-${toolCallId}`,
  decision: 'auto',
  createdAt: 1,
});

const statusEvent = (over: Partial<AgentStatusEvent> = {}): AgentStatusEvent => ({
  requestId: 'r1',
  sessionId: 's1',
  phase: 'thinking',
  ...over,
});

const stepEvent = (toolCallId: string, over: Partial<AgentStepEvent> = {}): AgentStepEvent => ({
  requestId: 'r1',
  sessionId: 's1',
  step: stepOf(toolCallId),
  argsSummary: '{}',
  ...over,
});

const confirmRequest = (toolCallId = 'c2'): AgentConfirmRequest => ({
  requestId: 'r1',
  sessionId: 's1',
  toolCallId,
  toolName: 'browser.click',
  summary: { url: 'https://example.com/form', elementText: '提交按钮', detail: '提交表单' },
  createdAt: 1,
});

const runSummary = (status: AgentRunSummary['status'] = 'done'): AgentRunSummary => ({
  requestId: 'r1',
  sessionId: 's1',
  status,
  stepsUsed: 2,
  maxSteps: 12,
  finalText: '最终回答',
  toolStepCount: 2,
});

const terminalMessage = (): ConversationMessage => ({
  id: 'm1',
  role: 'assistant',
  content: '最终回答',
  createdAt: 2,
  status: 'complete',
  agentRun: runSummary(),
});

const runDoneEvent = (over: Partial<AgentRunDoneEvent> = {}): AgentRunDoneEvent => ({
  requestId: 'r1',
  sessionId: 's1',
  status: 'complete',
  message: terminalMessage(),
  error: null,
  contextSource: {
    mode: 'none',
    tabId: null,
    url: null,
    title: null,
    capturedAt: null,
    degraded: false,
    thin: false,
    selectionExcerpt: null,
    warnings: [],
  },
  run: runSummary(),
  ...over,
});

describe('reduceAgentRuns — run 生命周期与键控', () => {
  it('start 建立 run（running、steps 空、无 pending/terminal）', () => {
    const state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'start',
      sessionId: 's1',
      requestId: 'r1',
    });
    expect(runForSession(state, 's1')).toMatchObject({
      requestId: 'r1',
      status: 'running',
      steps: [],
      pendingConfirm: null,
      terminal: null,
    });
  });

  it('start 同 requestId 幂等（已建立 run 不重置）', () => {
    let state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'start',
      sessionId: 's1',
      requestId: 'r1',
    });
    state = reduceAgentRuns(state, { type: 'status', event: statusEvent({ phase: 'executing' }) });
    state = reduceAgentRuns(state, { type: 'start', sessionId: 's1', requestId: 'r1' });
    expect(runForSession(state, 's1')?.phase).toBe('executing');
  });

  it('新 run 不继承旧 run 的 pending/steps/终止理由', () => {
    let state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'start',
      sessionId: 's1',
      requestId: 'r1',
    });
    state = reduceAgentRuns(state, { type: 'step', event: stepEvent('c1') });
    state = reduceAgentRuns(state, { type: 'confirm', event: confirmRequest() });
    state = reduceAgentRuns(state, { type: 'run-done', event: runDoneEvent() });
    state = reduceAgentRuns(state, { type: 'start', sessionId: 's1', requestId: 'r2' });
    const entry = runForSession(state, 's1');
    expect(entry).toMatchObject({
      requestId: 'r2',
      status: 'running',
      steps: [],
      pendingConfirm: null,
      terminal: null,
      terminalMessage: null,
      confirmOutcome: null,
    });
  });

  it('starting 状态事件先于本地 start 到达 → 收养建立 run（程序事实）', () => {
    const state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'status',
      event: statusEvent({ phase: 'starting', stepsUsed: 0, maxSteps: 12 }),
    });
    expect(runForSession(state, 's1')).toMatchObject({
      requestId: 'r1',
      status: 'running',
      phase: 'starting',
      stepsUsed: 0,
      maxSteps: 12,
    });
  });

  it('running 时 starting 携带不同 requestId → 忽略（每会话单在途防御）', () => {
    let state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'start',
      sessionId: 's1',
      requestId: 'r1',
    });
    state = reduceAgentRuns(state, {
      type: 'status',
      event: statusEvent({ phase: 'starting', requestId: 'r-other', stepsUsed: 0, maxSteps: 12 }),
    });
    expect(runForSession(state, 's1')?.requestId).toBe('r1');
  });

  it('终态后新 starting → 新 run（允许重跑，旧终态不残留）', () => {
    let state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'start',
      sessionId: 's1',
      requestId: 'r1',
    });
    state = reduceAgentRuns(state, { type: 'run-done', event: runDoneEvent() });
    state = reduceAgentRuns(state, {
      type: 'status',
      event: statusEvent({ phase: 'starting', requestId: 'r2', stepsUsed: 0, maxSteps: 12 }),
    });
    const entry = runForSession(state, 's1');
    expect(entry).toMatchObject({ requestId: 'r2', status: 'running', terminal: null, steps: [] });
  });
});

describe('reduceAgentRuns — status/step/confirm 合并与竞态', () => {
  const started = (): ReturnType<typeof reduceAgentRuns> =>
    reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, { type: 'start', sessionId: 's1', requestId: 'r1' });

  it('thinking/executing 合并 phase、toolName 与 stepsUsed/maxSteps（A5 实际计数）', () => {
    let state = started();
    state = reduceAgentRuns(state, {
      type: 'status',
      event: statusEvent({
        phase: 'executing',
        toolName: 'browser.read',
        stepsUsed: 3,
        maxSteps: 12,
      }),
    });
    expect(runForSession(state, 's1')).toMatchObject({
      phase: 'executing',
      toolName: 'browser.read',
      stepsUsed: 3,
      maxSteps: 12,
    });
  });

  it('confirm 事件建立 pending（phase → waiting-confirm，toolName 来自程序事实）', () => {
    let state = started();
    state = reduceAgentRuns(state, { type: 'confirm', event: confirmRequest('c2') });
    expect(runForSession(state, 's1')).toMatchObject({
      phase: 'waiting-confirm',
      toolName: 'browser.click',
      pendingConfirm: expect.objectContaining({ toolCallId: 'c2' }),
    });
  });

  it('confirm-resolved 清空 pending 并记录 outcome', () => {
    let state = started();
    state = reduceAgentRuns(state, { type: 'confirm', event: confirmRequest('c2') });
    state = reduceAgentRuns(state, {
      type: 'status',
      event: statusEvent({ phase: 'confirm-resolved', confirmOutcome: 'approved' }),
    });
    const entry = runForSession(state, 's1');
    expect(entry?.pendingConfirm).toBeNull();
    expect(entry?.confirmOutcome).toBe('approved');
  });

  it('step 按事件顺序渐进追加', () => {
    let state = started();
    state = reduceAgentRuns(state, { type: 'step', event: stepEvent('c1') });
    state = reduceAgentRuns(state, { type: 'step', event: stepEvent('c2') });
    expect(runForSession(state, 's1')?.steps.map((s) => s.step.toolCallId)).toEqual(['c1', 'c2']);
  });

  it('step id 去重（同 toolCallId 只出现一次）', () => {
    let state = started();
    state = reduceAgentRuns(state, { type: 'step', event: stepEvent('c1') });
    state = reduceAgentRuns(state, { type: 'step', event: stepEvent('c1') });
    expect(runForSession(state, 's1')?.steps).toHaveLength(1);
  });

  it('step 完成其 toolCallId 的 pending 时同步清空（纵深防御）', () => {
    let state = started();
    state = reduceAgentRuns(state, { type: 'confirm', event: confirmRequest('c2') });
    state = reduceAgentRuns(state, {
      type: 'step',
      event: stepEvent('c2', { step: stepOf('c2', 'browser.click') }),
    });
    expect(runForSession(state, 's1')?.pendingConfirm).toBeNull();
  });

  it('错误 requestId 的 step/confirm/status 忽略（旧 run 事件）', () => {
    let state = started();
    const wrong = { requestId: 'r-old', sessionId: 's1' };
    state = reduceAgentRuns(state, { type: 'step', event: { ...stepEvent('c1'), ...wrong } });
    state = reduceAgentRuns(state, { type: 'confirm', event: { ...confirmRequest(), ...wrong } });
    state = reduceAgentRuns(state, {
      type: 'status',
      event: statusEvent({ ...wrong, phase: 'executing', toolName: 'x' }),
    });
    const entry = runForSession(state, 's1');
    expect(entry?.steps).toHaveLength(0);
    expect(entry?.pendingConfirm).toBeNull();
    expect(entry?.phase).toBeNull();
  });

  it('未知会话的非 starting 事件忽略（无法证明归属）', () => {
    let state = started();
    state = reduceAgentRuns(state, {
      type: 'status',
      event: statusEvent({ sessionId: 's-other', phase: 'executing', toolName: 'x' }),
    });
    state = reduceAgentRuns(state, {
      type: 'step',
      event: stepEvent('c1', { sessionId: 's-other' }),
    });
    state = reduceAgentRuns(state, {
      type: 'run-done',
      event: runDoneEvent({ sessionId: 's-other' }),
    });
    expect(runForSession(state, 's-other')).toBeNull();
    expect(runForSession(state, 's1')?.steps).toHaveLength(0);
  });
});

describe('reduceAgentRuns — run-done 终态收敛与迟到事件', () => {
  const runningWithPending = (): ReturnType<typeof reduceAgentRuns> => {
    let state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'start',
      sessionId: 's1',
      requestId: 'r1',
    });
    state = reduceAgentRuns(state, { type: 'step', event: stepEvent('c1') });
    state = reduceAgentRuns(state, { type: 'confirm', event: confirmRequest('c2') });
    return state;
  };

  it('run-done 收敛终态（terminal/terminalMessage/错误文案；pending 作废）', () => {
    let state = runningWithPending();
    state = reduceAgentRuns(state, {
      type: 'run-done',
      event: runDoneEvent({
        error: {
          code: 'timeout',
          message: '任务总超时（420 秒）',
          retryable: false,
          providerId: null,
          model: null,
          requestId: 'r1',
        },
      }),
    });
    const entry = runForSession(state, 's1');
    expect(entry).toMatchObject({
      status: 'terminal',
      phase: null,
      pendingConfirm: null,
      terminal: expect.objectContaining({ status: 'done' }),
      terminalMessage: expect.objectContaining({ id: 'm1' }),
    });
    expect(entry?.errorMessage).toBe('任务总超时（420 秒）');
  });

  it('run-done 幂等（重复到达忽略，不重复收敛）', () => {
    let state = runningWithPending();
    state = reduceAgentRuns(state, { type: 'run-done', event: runDoneEvent() });
    const terminalOnce = runForSession(state, 's1');
    state = reduceAgentRuns(state, { type: 'run-done', event: runDoneEvent() });
    expect(runForSession(state, 's1')).toBe(terminalOnce);
  });

  it('终态后迟到 status/step/confirm 忽略（终态不被改回 running）', () => {
    let state = runningWithPending();
    state = reduceAgentRuns(state, { type: 'run-done', event: runDoneEvent() });
    state = reduceAgentRuns(state, {
      type: 'status',
      event: statusEvent({ phase: 'thinking' }),
    });
    state = reduceAgentRuns(state, { type: 'step', event: stepEvent('c9') });
    state = reduceAgentRuns(state, { type: 'confirm', event: confirmRequest('c8') });
    const entry = runForSession(state, 's1');
    expect(entry?.status).toBe('terminal');
    expect(entry?.phase).toBeNull();
    expect(entry?.steps).toHaveLength(1);
    expect(entry?.pendingConfirm).toBeNull();
  });

  it('旧 run 的 run-done（requestId 不匹配）忽略', () => {
    let state = runningWithPending();
    state = reduceAgentRuns(state, {
      type: 'run-done',
      event: runDoneEvent({ requestId: 'r-old' }),
    });
    expect(runForSession(state, 's1')?.status).toBe('running');
  });
});

describe('reduceAgentRuns — 停止与拒绝', () => {
  it('stop-requested → stopping（不伪装终态）；重复点击幂等', () => {
    let state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'start',
      sessionId: 's1',
      requestId: 'r1',
    });
    state = reduceAgentRuns(state, { type: 'stop-requested', sessionId: 's1' });
    expect(runForSession(state, 's1')?.status).toBe('stopping');
    const stopping = runForSession(state, 's1');
    state = reduceAgentRuns(state, { type: 'stop-requested', sessionId: 's1' });
    expect(runForSession(state, 's1')).toBe(stopping);
    // stopping 后 run-done 仍可收敛（停止不是终态）
    state = reduceAgentRuns(state, {
      type: 'run-done',
      event: runDoneEvent({ run: runSummary('cancelled') }),
    });
    expect(runForSession(state, 's1')?.status).toBe('terminal');
  });

  it('非 running 状态 stop-requested 忽略（旧请求/空闲/终态）', () => {
    let state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'start',
      sessionId: 's1',
      requestId: 'r1',
    });
    state = reduceAgentRuns(state, { type: 'run-done', event: runDoneEvent() });
    state = reduceAgentRuns(state, { type: 'stop-requested', sessionId: 's1' });
    expect(runForSession(state, 's1')?.status).toBe('terminal');
    state = reduceAgentRuns(state, { type: 'stop-requested', sessionId: 's-other' });
    expect(runForSession(state, 's-other')).toBeNull();
  });

  it('rejected：空闲/终态后记录文案；running 时忽略（竞态残留）', () => {
    let state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'rejected',
      sessionId: 's1',
      message: '上一条回答还在生成中',
    });
    expect(runForSession(state, 's1')).toMatchObject({
      status: 'idle',
      errorMessage: '上一条回答还在生成中',
    });
    state = reduceAgentRuns(state, { type: 'start', sessionId: 's1', requestId: 'r1' });
    state = reduceAgentRuns(state, { type: 'rejected', sessionId: 's1', message: '迟到拒绝' });
    expect(runForSession(state, 's1')?.status).toBe('running');
    expect(runForSession(state, 's1')?.errorMessage).toBeNull();
  });
});

describe('reduceAgentRuns — 会话隔离与全局选择器', () => {
  it('两个会话的 run 互不串扰（后台 run 状态不串到当前会话）', () => {
    let state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'start',
      sessionId: 's1',
      requestId: 'r1',
    });
    state = reduceAgentRuns(state, { type: 'step', event: stepEvent('c1') });
    state = reduceAgentRuns(state, { type: 'start', sessionId: 's2', requestId: 'r2' });
    expect(runForSession(state, 's1')?.steps).toHaveLength(1);
    expect(runForSession(state, 's2')?.steps).toHaveLength(0);
    // s2 的 run-done 不影响 s1
    state = reduceAgentRuns(state, {
      type: 'run-done',
      event: runDoneEvent({ requestId: 'r2', sessionId: 's2', run: runSummary('cancelled') }),
    });
    expect(runForSession(state, 's1')?.status).toBe('running');
    expect(runForSession(state, 's2')?.status).toBe('terminal');
  });

  it('runForSession 未知会话 → null；globalPendingRequest 全局跟随精确 pending', () => {
    let state = reduceAgentRuns(INITIAL_AGENT_RUNS_STATE, {
      type: 'start',
      sessionId: 's1',
      requestId: 'r1',
    });
    expect(runForSession(state, 's-x')).toBeNull();
    expect(globalPendingRequest(state)).toBeNull();
    state = reduceAgentRuns(state, { type: 'confirm', event: confirmRequest('c2') });
    expect(globalPendingRequest(state)?.toolCallId).toBe('c2');
    // pending 在后台会话（非当前选中）同样可被全局取到（确认 UI 不得因切会话不可达）
    state = reduceAgentRuns(state, {
      type: 'start',
      sessionId: 's2',
      requestId: 'r2',
    });
    expect(globalPendingRequest(state)?.toolCallId).toBe('c2');
  });
});
