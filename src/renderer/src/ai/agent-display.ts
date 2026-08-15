// Agent 可见性展示纯函数（A6，unit-tested；零 React/Electron 依赖）。
// 契约源：doc/stage3/detailed-design.md §11.2 + threat-model §3.3/§5 + 用户开工要求
// （强制核查三——确认信息信任边界）：确认对话框只展示程序确定的确定性事实；elementText
// 与 URL 为页面/不可信来源文本 → 纯文本渲染（禁止 HTML/Markdown 解析）+ 不可见控制字符
// 与双向文本控制符剔除 + 截断；文案不来自模型/网页。状态栏只显示确定性运行事实。
import type { AgentRunEntry } from './agent-run-state';
import type { AgentRunStatus, ToolStepDecision } from '../../../shared/types/agent';

// 确认框展示上限（elementText/URL 等不可信文本；中文 UI 元素文本短，上限取保守值）
export const CONFIRM_TEXT_MAX = 120;

// 剔除不可见控制字符（C0/C1 控制区、DEL、双向文本控制符、零宽字符、BOM）——
// 防「已允许/已拒绝」等视觉欺骗与方向控制；其余字符原样保留（React 文本节点天然
// 无 HTML 语义，dangerouslySetInnerHTML/Markdown 一律不出现）。
// eslint-disable-next-line no-control-regex -- 控制字符区间本身即过滤目标
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

export function sanitizeConfirmText(text: unknown, max = CONFIRM_TEXT_MAX): string {
  if (typeof text !== 'string') return '';
  const cleaned = text.replace(CONTROL_CHARS, '');
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max)}…`;
}

// ToolStepDecision 六值中文文案（单一事实源；failed/denied/forbidden/invalid 由组件层
// 红色样式呈现，文案不伪装成功）
export const TOOL_DECISION_LABELS: Record<ToolStepDecision, string> = {
  auto: '自动执行',
  'auto-visible': '自动执行（显著）',
  confirmed: '已确认',
  denied: '已拒绝',
  forbidden: '已禁止',
  invalid: '无效调用',
};

// 工具错误码中文文案（ToolStep.errorCode 展示用；闭合枚举 ToolResultErrorCode）
export const TOOL_ERROR_LABELS: Record<string, string> = {
  'invalid-args': '参数无效',
  'tool-not-found': '未知工具',
  'element-not-found': '未找到目标元素',
  'stale-element': '页面已变化，目标元素失效',
  'not-interactable': '目标元素不可交互',
  forbidden: '操作被禁止',
  'denied-by-user': '用户未批准',
  'execution-failed': '执行失败',
  'search-failed': '搜索失败',
  // B4：Source 工具错误码中文文案（ToolResultErrorCode 扩展 8 值同步）
  'source-invalid-change': '信源变更无效',
  'source-version-conflict': '信源版本冲突（已被修改）',
  'source-duplicate': '信源已存在',
  'source-not-found': '信源不存在',
  'source-forbidden': '信源不可访问',
  'source-limit': '超出信源数量上限',
  'source-unavailable': '信源服务不可用',
  'source-conflict': '信源变更冲突',
};

// AgentRunStatus 中文文案（run.status 为终止理由权威来源，§11.2/决议 #33⑤——UI 不以
// 外层通用 error 替代）
export const AGENT_RUN_STATUS_LABELS: Record<AgentRunStatus, string> = {
  running: '进行中',
  'waiting-confirm': '等待确认',
  done: '已完成',
  cancelled: '已停止',
  'step-limit': '超过最大步数',
  timeout: '任务超时',
  'loop-detected': '检测到重复操作（防循环）',
  'no-progress': '连续无进展',
  error: '内部错误',
};

// 程序确定的动作类型文案（工具名为程序事实；未知工具不解析模型/页面文本）
export function toolActionLabel(toolName: string): string {
  switch (toolName) {
    case 'browser_click':
      return '点击页面元素';
    case 'browser_fill':
      return '填写输入框';
    case 'browser_open':
      return '打开页面';
    case 'browser_navigate':
      return '导航到页面';
    case 'search_web':
      return '网页搜索';
    // B4：Source 工具动作类型（确认对话框展示用）
    case 'source_search':
      return '搜索信源';
    case 'source_list':
      return '列出信源';
    case 'source_get':
      return '查看信源';
    case 'source_apply_changes':
      return '变更信源（需确认）';
    default:
      return '执行浏览器操作';
  }
}

// 状态栏确定性中文文案（覆盖：思考中/执行工具 N/12/等待确认/已完成/已停止/全部终止理由；
// 「正在停止」为 UI 事实非终态伪装）
export function describeAgentStatus(entry: AgentRunEntry): string {
  if (entry.status === 'idle') return '暂无任务';
  if (entry.status === 'stopping') return '正在停止…';
  if (entry.status === 'terminal') {
    const status = entry.terminal?.status;
    if (status === 'done') return '已完成';
    if (status === 'cancelled') return '已停止';
    if (status === 'step-limit') return '已终止：超过最大步数';
    if (status === 'timeout') return '已终止：任务超时';
    if (status === 'loop-detected') return '已终止：检测到重复操作（防循环）';
    if (status === 'no-progress') return '已终止：连续无进展';
    // error：权威理由在 run.status；携带归一化错误文案时展示具体理由
    return entry.errorMessage !== null ? `已终止：${entry.errorMessage}` : '已终止：内部错误';
  }
  switch (entry.phase) {
    case 'starting':
      return '任务已启动';
    case 'thinking':
      return '思考中';
    case 'executing':
      return entry.toolName !== null
        ? `执行工具 ${entry.toolName}（第 ${entry.stepsUsed}/${entry.maxSteps} 步）`
        : '执行工具中';
    case 'waiting-confirm':
      return entry.toolName !== null ? `等待确认：${entry.toolName}` : '等待确认';
    case 'confirm-resolved':
      if (entry.confirmOutcome === 'approved') return '已批准，继续执行';
      if (entry.confirmOutcome === 'denied') return '已拒绝，任务继续';
      return '确认已作废';
    case 'finalizing':
      return '正在整理最终回答';
    default:
      return '任务进行中';
  }
}
