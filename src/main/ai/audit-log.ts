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

function truncate(text: string, max = ARGS_SUMMARY_MAX): string {
  if (text.length <= max) return text;
  return text.slice(0, max - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? String(value); // 防御：校验已拒嵌套结构
}

// B4 决议 #67：URL 形态字符串的敏感 query 值脱敏（凭据形态 ?token=/&key= 等零进入
// 审计）。URL 形态判定（保守）：trim 后以 http(s):// 开头；无 query → 原样；有 query
// → scheme://host/path + 「query 值已脱敏 + 长度」。非 URL 形态 → null（调用方按
// 普通文本处理）。不依赖 Sources 域模块（分层纪律：ai/ 不反向依赖 sources/）。
export function redactUrlQueryValue(value: string): string | null {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  const q = trimmed.indexOf('?');
  if (q === -1) return trimmed;
  return `${trimmed.slice(0, q)}?（query 值已脱敏，len=${trimmed.length - q - 1}）`;
}

// B4 决议 #67：source_apply_changes 审计摘要——操作计数/字段名/各字段长度/版本
// 确定性输出；note 正文与 URL 值零出现（仅长度）；有界（≤ SOURCE_ARGS_SUMMARY_MAX；
// 字段名集合有自然上界（change set 白名单），lens 截取前 10 项 + 截断标记，versions
// 先于 lens 保证不被截断——版本为乐观并发审计的关键字段）。幂等键由 ToolExecutor
// 在成功后追加（恰好一条审计纪律不变）。
export const SOURCE_ARGS_SUMMARY_MAX = 400;
const SOURCE_LENS_ENTRY_MAX = 10;

export function summarizeSourceChangeSet(ops: unknown): string {
  if (!Array.isArray(ops)) return 'ops=?';
  const counts = { add: 0, update: 0, disable: 0, restore: 0 };
  const fields = new Set<string>();
  const lens: string[] = [];
  const versions: unknown[] = [];
  for (const raw of ops) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const op = raw as Record<string, unknown>;
    const kind = typeof op['kind'] === 'string' ? op['kind'] : '?';
    if (kind === 'add' || kind === 'update' || kind === 'disable' || kind === 'restore') {
      counts[kind] += 1;
    }
    for (const [key, value] of Object.entries(op)) {
      if (key === 'kind') continue; // 计数已覆盖
      if (key === 'patch' && typeof value === 'object' && value !== null) {
        for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
          fields.add(pk);
          if (typeof pv === 'string') lens.push(`${pk}:${pv.length}`);
        }
        continue;
      }
      fields.add(key);
      if (typeof value === 'string') lens.push(`${key}:${value.length}`);
      if (key === 'expectedVersion') versions.push(value);
    }
  }
  const lensPart =
    lens.length <= SOURCE_LENS_ENTRY_MAX
      ? lens.join(',')
      : `${lens.slice(0, SOURCE_LENS_ENTRY_MAX).join(',')},…`;
  const summary =
    `ops=${ops.length} add=${counts.add} update=${counts.update} disable=${counts.disable} restore=${counts.restore};` +
    `fields=[${[...fields].sort().join(',')}];` +
    `versions=[${versions.join(',')}];` +
    `lens=[${lensPart}]`;
  return truncate(summary, SOURCE_ARGS_SUMMARY_MAX);
}

// 参数摘要：键排序确定性；browser_fill 的 text → len=N（不记原值）；url 全量
// （审计可追溯，校验上限 2048）；search_web 的 query 全量（T-03 外发审查可追溯，
// 校验上限 500 有界——决议 #32）；source_apply_changes → 结构化 change set 摘要
// （决议 #67）；source_search 的 query 全量 ≤500 但 URL 形态 query 值脱敏（决议 #67）；
// 其余值确定性截断 ≤ ARGS_SUMMARY_MAX。
export function summarizeArgs(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'source_apply_changes') {
    return summarizeSourceChangeSet(args['ops']);
  }
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
      if (toolName === 'source_search' && key === 'query' && typeof value === 'string') {
        const redacted = redactUrlQueryValue(value); // URL 形态 → 敏感 query 值脱敏
        return `${key}:${redacted ?? value}`;
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
