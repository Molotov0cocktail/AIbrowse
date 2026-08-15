// agent-display 纯函数单测（A6 红→绿先写）：确认对话框与状态栏的中文文案/脱敏展示。
// 契约源：doc/stage3/detailed-design.md §11.2 + threat-model §3.3/§5（确认 UI 只展示
// 确定性事实、elementText 为页面提供的不可信文本）+ 用户开工要求（强制核查三）：
// 控制字符/双向文本控制符剔除、截断、纯文本；deny 默认高亮在组件层（Enter 走焦点按钮）。
import { describe, expect, it } from 'vitest';
import type { AgentRunEntry } from './agent-run-state';
import {
  AGENT_RUN_STATUS_LABELS,
  TOOL_DECISION_LABELS,
  TOOL_ERROR_LABELS,
  describeAgentStatus,
  sanitizeConfirmText,
  toolActionLabel,
} from './agent-display';

describe('sanitizeConfirmText（页面/URL 提供的不可信文本 → 纯文本展示）', () => {
  it('普通文本原样保留', () => {
    expect(sanitizeConfirmText('提交按钮')).toBe('提交按钮');
  });

  it('剔除不可见控制字符（\\u0000-\\u001F、\\u007F）', () => {
    expect(sanitizeConfirmText('提\u0000交\u0007按\u001f钮\u007f')).toBe('提交按钮');
  });

  it('剔除双向文本控制符与零宽字符（防显示欺骗）', () => {
    const hostile = '\u202e\u202d\u202c\u202b\u202a\u2066\u2067\u2068\u2069\u200e\u200f\ufeff';
    expect(sanitizeConfirmText(`按${hostile}钮`)).toBe('按钮');
  });

  it('默认截断 120 字符（超出加省略标记）', () => {
    const long = '长'.repeat(200);
    const out = sanitizeConfirmText(long);
    expect(out).toBe(`${'长'.repeat(120)}…`);
  });

  it('自定义上限截断', () => {
    expect(sanitizeConfirmText('一二三四五六', 3)).toBe('一二三…');
  });

  it('非字符串安全返回空串（不抛异常）', () => {
    expect(sanitizeConfirmText(null as never)).toBe('');
    expect(sanitizeConfirmText(undefined as never)).toBe('');
    expect(sanitizeConfirmText(42 as never)).toBe('');
  });

  it('空串原样返回', () => {
    expect(sanitizeConfirmText('')).toBe('');
  });
});

describe('TOOL_DECISION_LABELS（六值 ToolStepDecision 中文文案，含 invalid）', () => {
  it('六值全覆盖且文案不伪装失败为成功', () => {
    expect(TOOL_DECISION_LABELS).toEqual({
      auto: '自动执行',
      'auto-visible': '自动执行（显著）',
      confirmed: '已确认',
      denied: '已拒绝',
      forbidden: '已禁止',
      invalid: '无效调用',
    });
  });
});

describe('AGENT_RUN_STATUS_LABELS（run.status 权威终止理由文案源）', () => {
  it('九值全覆盖', () => {
    expect(AGENT_RUN_STATUS_LABELS).toEqual({
      running: '进行中',
      'waiting-confirm': '等待确认',
      done: '已完成',
      cancelled: '已停止',
      'step-limit': '超过最大步数',
      timeout: '任务超时',
      'loop-detected': '检测到重复操作（防循环）',
      'no-progress': '连续无进展',
      error: '内部错误',
    });
  });
});

describe('TOOL_ERROR_LABELS（ToolResultErrorCode 中文文案，闭合枚举）', () => {
  it('十七值全覆盖（9 既有 + B4 8 个 source 错误码）', () => {
    expect(TOOL_ERROR_LABELS).toEqual({
      'invalid-args': '参数无效',
      'tool-not-found': '未知工具',
      'element-not-found': '未找到目标元素',
      'stale-element': '页面已变化，目标元素失效',
      'not-interactable': '目标元素不可交互',
      forbidden: '操作被禁止',
      'denied-by-user': '用户未批准',
      'execution-failed': '执行失败',
      'search-failed': '搜索失败',
      'source-invalid-change': '信源变更无效',
      'source-version-conflict': '信源版本冲突（已被修改）',
      'source-duplicate': '信源已存在',
      'source-not-found': '信源不存在',
      'source-forbidden': '信源不可访问',
      'source-limit': '超出信源数量上限',
      'source-unavailable': '信源服务不可用',
      'source-conflict': '信源变更冲突',
    });
  });
});

describe('toolActionLabel（程序确定的动作类型文案）', () => {
  it('已知工具映射', () => {
    expect(toolActionLabel('browser_click')).toBe('点击页面元素');
    expect(toolActionLabel('browser_fill')).toBe('填写输入框');
    expect(toolActionLabel('browser_open')).toBe('打开页面');
    expect(toolActionLabel('browser_navigate')).toBe('导航到页面');
    expect(toolActionLabel('search_web')).toBe('网页搜索');
  });

  it('未知工具兜底文案（不解析模型/页面文本）', () => {
    expect(toolActionLabel('browser_scroll')).toBe('执行浏览器操作');
    expect(toolActionLabel('')).toBe('执行浏览器操作');
  });
});

describe('describeAgentStatus（状态栏确定性中文文案）', () => {
  const entry = (over: Partial<AgentRunEntry> = {}): AgentRunEntry => ({
    sessionId: 's1',
    requestId: 'r1',
    status: 'running',
    phase: null,
    toolName: null,
    stepsUsed: 0,
    maxSteps: 12,
    confirmOutcome: null,
    pendingConfirm: null,
    steps: [],
    terminal: null,
    terminalMessage: null,
    errorMessage: null,
    ...over,
  });

  it('空闲 → 暂无任务', () => {
    expect(describeAgentStatus(entry({ status: 'idle', requestId: null }))).toBe('暂无任务');
  });

  it('starting → 任务已启动', () => {
    expect(describeAgentStatus(entry({ phase: 'starting' }))).toBe('任务已启动');
  });

  it('thinking → 思考中', () => {
    expect(describeAgentStatus(entry({ phase: 'thinking' }))).toBe('思考中');
  });

  it('executing → 执行工具 + 当前工具名 + stepsUsed/maxSteps（A5 实际计数）', () => {
    expect(
      describeAgentStatus(
        entry({ phase: 'executing', toolName: 'browser_read', stepsUsed: 3, maxSteps: 12 }),
      ),
    ).toBe('执行工具 browser_read（第 3/12 步）');
  });

  it('waiting-confirm → 等待确认 + 工具名', () => {
    expect(
      describeAgentStatus(entry({ phase: 'waiting-confirm', toolName: 'browser_click' })),
    ).toBe('等待确认：browser_click');
  });

  it('confirm-resolved：批准/拒绝/作废三态', () => {
    expect(
      describeAgentStatus(entry({ phase: 'confirm-resolved', confirmOutcome: 'approved' })),
    ).toBe('已批准，继续执行');
    expect(
      describeAgentStatus(entry({ phase: 'confirm-resolved', confirmOutcome: 'denied' })),
    ).toBe('已拒绝，任务继续');
    expect(
      describeAgentStatus(entry({ phase: 'confirm-resolved', confirmOutcome: 'cancelled' })),
    ).toBe('确认已作废');
  });

  it('finalizing → 正在整理最终回答', () => {
    expect(describeAgentStatus(entry({ phase: 'finalizing' }))).toBe('正在整理最终回答');
  });

  it('stopping → 正在停止（不伪装 cancelled）', () => {
    expect(describeAgentStatus(entry({ status: 'stopping' }))).toBe('正在停止…');
  });

  it('终态 done → 已完成；cancelled → 已停止', () => {
    expect(
      describeAgentStatus(entry({ status: 'terminal', terminal: { status: 'done' } as never })),
    ).toBe('已完成');
    expect(
      describeAgentStatus(
        entry({ status: 'terminal', terminal: { status: 'cancelled' } as never }),
      ),
    ).toBe('已停止');
  });

  it('终态终止理由五种全覆盖（run.status 权威，非外层通用 error）', () => {
    expect(
      describeAgentStatus(
        entry({ status: 'terminal', terminal: { status: 'step-limit' } as never }),
      ),
    ).toBe('已终止：超过最大步数');
    expect(
      describeAgentStatus(entry({ status: 'terminal', terminal: { status: 'timeout' } as never })),
    ).toBe('已终止：任务超时');
    expect(
      describeAgentStatus(
        entry({ status: 'terminal', terminal: { status: 'loop-detected' } as never }),
      ),
    ).toBe('已终止：检测到重复操作（防循环）');
    expect(
      describeAgentStatus(
        entry({ status: 'terminal', terminal: { status: 'no-progress' } as never }),
      ),
    ).toBe('已终止：连续无进展');
    expect(
      describeAgentStatus(entry({ status: 'terminal', terminal: { status: 'error' } as never })),
    ).toBe('已终止：内部错误');
  });

  it('终态 error 携带归一化错误文案时展示具体理由', () => {
    expect(
      describeAgentStatus(
        entry({
          status: 'terminal',
          terminal: { status: 'error' } as never,
          errorMessage: '未配置可用的 AI 服务',
        }),
      ),
    ).toBe('已终止：未配置可用的 AI 服务');
  });
});

// —— B4：Source 工具错误码中文文案 + 动作类型（ToolResultErrorCode 扩展同步）——
describe('B4 Source 工具文案（TOOL_ERROR_LABELS / toolActionLabel）', () => {
  it('8 个 source 错误码中文文案齐备（闭合枚举全覆盖）', () => {
    expect(TOOL_ERROR_LABELS['source-invalid-change']).toBeTruthy();
    expect(TOOL_ERROR_LABELS['source-version-conflict']).toBeTruthy();
    expect(TOOL_ERROR_LABELS['source-duplicate']).toBeTruthy();
    expect(TOOL_ERROR_LABELS['source-not-found']).toBeTruthy();
    expect(TOOL_ERROR_LABELS['source-forbidden']).toBeTruthy();
    expect(TOOL_ERROR_LABELS['source-limit']).toBeTruthy();
    expect(TOOL_ERROR_LABELS['source-unavailable']).toBeTruthy();
    expect(TOOL_ERROR_LABELS['source-conflict']).toBeTruthy();
  });

  it('四工具动作类型中文文案（确认对话框展示）', () => {
    expect(toolActionLabel('source_search')).not.toBe('执行浏览器操作');
    expect(toolActionLabel('source_list')).not.toBe('执行浏览器操作');
    expect(toolActionLabel('source_get')).not.toBe('执行浏览器操作');
    expect(toolActionLabel('source_apply_changes')).not.toBe('执行浏览器操作');
  });
});
