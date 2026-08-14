// 审计日志（A2）。契约源：doc/stage3/detailed-design.md §10.1 + threat-model §3.4：
// 每个工具调用恰好一条结构化审计（ToolExecutor 保证）；参数摘要确定性截断——
// fill 的 text 只记 len=N（原文零出现）、URL 全量、其余 ≤ 200 字符；审计内容不含
// API Key/请求头/响应体/错误堆栈（错误归一为枚举 errorCode）；输出经 logger
// sanitize 全量脱敏（既有规则，Key 零暴露）。
import { TRUNCATION_MARK } from './context-budget';
import { logInfo } from '../logger';
import type { ToolStepDecision } from '../../shared/types/agent';

// 决策枚举单一事实源（决议 #33）：shared/types/agent.ts 的 ToolStepDecision——
// ToolStep/审计/UI 将来消费同一枚举；此处为别名（A2 既有导入路径不变）。
// auto=L0 自动；auto-visible=L1 自动显著展示；confirmed=L2 用户批准；denied=确认被拒绝/作废；
// forbidden=L3 禁止；invalid=校验前失败（tool-not-found/invalid-args/防循环安全阻断）。
export type AuditDecision = ToolStepDecision;

export interface AuditEntry {
  requestId: string;
  toolCallId: string;
  tool: string;
  argsSummary: string; // 参数摘要（脱敏规则见 summarizeArgs）
  decision: AuditDecision;
  ok: boolean;
  errorCode: string | null;
  durationMs: number;
}

export const ARGS_SUMMARY_MAX = 200;

function truncate(text: string): string {
  if (text.length <= ARGS_SUMMARY_MAX) return text;
  return text.slice(0, ARGS_SUMMARY_MAX - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? String(value); // 防御：校验已拒嵌套结构
}

// 参数摘要：键排序确定性；browser_fill 的 text → len=N（不记原值）；url 全量
// （审计可追溯，校验上限 2048）；search_web 的 query 全量（T-03 外发审查可追溯，
// 校验上限 500 有界——决议 #32）；其余值确定性截断 ≤ ARGS_SUMMARY_MAX。
export function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  const parts = Object.keys(args)
    .sort()
    .map((key) => {
      const value = args[key];
      if (toolName === 'browser_fill' && key === 'text') {
        // 隐私红线（决议 #13）：fill 输入值只记长度——普通字段与未来扩展一致脱敏
        return `text=len:${String(value).length}`;
      }
      if (key === 'url' || (toolName === 'search_web' && key === 'query')) {
        return `${key}:${renderValue(value)}`;
      }
      return `${key}:${truncate(renderValue(value))}`;
    });
  return `{${parts.join('，')}}`;
}

// 解析失败路径：原始参数确定性截断（审计记录原文——§2.2 ToolCall.arguments 语义）
export function summarizeRawArgs(raw: string): string {
  return truncate(raw);
}

// §10.1 条目格式（中文确定性）：决策/结果/耗时/错误码全量可回溯
export function formatAuditMessage(entry: AuditEntry): string {
  return (
    `tool-call（requestId=${entry.requestId}，toolCallId=${entry.toolCallId}，tool=${entry.tool}，` +
    `args=${entry.argsSummary}，decision=${entry.decision}，ok=${entry.ok}，` +
    `耗时=${entry.durationMs}ms，errorCode=${entry.errorCode ?? '无'}）`
  );
}

// logger 薄封装（分层：工具实现与执行器不直接调用 logger，装配时注入）
export function createAuditLogger(
  log: (category: string, message: string) => void = logInfo,
): (entry: AuditEntry) => void {
  return (entry) => {
    log('audit', formatAuditMessage(entry));
  };
}

// A5：Agent run 开始/终止审计条目（§10.1「run 开始/终止各一条（status/步数/终止理由）」——
// 与工具调用条目同审计类目，消息前缀 agent-run 区分；不含参数/内容/Key）
export function formatAgentRunAuditMessage(run: {
  requestId: string;
  status: string;
  stepsUsed: number;
  maxSteps: number;
  reason?: string;
}): string {
  const reason = run.reason === undefined ? '' : `，理由=${run.reason}`;
  return (
    `agent-run（requestId=${run.requestId}，status=${run.status}，` +
    `步数=${run.stepsUsed}/${run.maxSteps}${reason}）`
  );
}
