// Fifth Stage C1: research error table — the single source of truth for
// error-code validation and Chinese user-facing messages (adjudication #108:
// 11 codes including research-timeout and research-task-limit; adjudication
// #109: repository→service error mapping). Messages are user-facing
// diagnostics, never embedding user/model/web text.
import { RESEARCH_ERROR_CODES, type ResearchErrorCode } from '../../../shared/types/research';

// 决议 #108：中文文案单一事实源（UI/IPC/日志同源；不含用户/模型/网页文本）
export const RESEARCH_ERROR_MESSAGES: Record<ResearchErrorCode, string> = {
  'research-invalid-goal': '研究目标为空或格式非法（请输入有效的研究目标）',
  'research-busy': '已有研究任务正在运行，请等待完成或停止后再启动新任务',
  'research-not-found': '研究任务不存在或已被删除',
  'research-invalid-state': '当前任务状态不允许执行该操作',
  'research-unavailable': '研究数据库不可用（浏览器与信源功能不受影响）',
  'research-sources-unavailable': '信源数据库当前不可用，研究任务无法启动',
  'research-provider-unavailable': 'AI 服务未配置或当前服务不支持工具调用，研究任务无法启动',
  'research-budget-exhausted': '研究预算已用尽（任务以正式失败终态结束，已收集证据保留）',
  'research-timeout': '研究总时长超限（任务以失败终态结束，已收集证据保留）',
  'research-task-limit': '研究任务数量已达上限（请删除历史任务后重试）',
  'research-internal': '研究服务内部错误（详见日志）',
};

export function isResearchErrorCode(value: unknown): value is ResearchErrorCode {
  return typeof value === 'string' && (RESEARCH_ERROR_CODES as readonly string[]).includes(value);
}

export function researchErrorMessage(code: ResearchErrorCode): string {
  return RESEARCH_ERROR_MESSAGES[code];
}

// 决议 #109：Repository 错误码 → 服务层错误码映射（其余归一化 research-internal，
// 不把底层异常细节抛穿给调用方）
export type ResearchRepositoryErrorCode = 'task-persisted-budget-exceeded' | 'sqlite-error';

export function mapRepositoryErrorCode(code: unknown): ResearchErrorCode {
  if (code === 'task-persisted-budget-exceeded') return 'research-budget-exhausted';
  return 'research-internal';
}
