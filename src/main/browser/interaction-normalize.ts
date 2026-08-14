// A3 交互脚本结果形状校验纯函数（零 Electron 依赖，可单测）：页面脚本返回值视为敌手，
// 逐字段验证——畸形返回/未知代码/原型篡改/渲染进程失效只能得到结构化失败；异常、堆栈
// 或页面原文不穿透到 ToolResult（reason 限额截断 + 空白折叠，error 的 reason 在脚本侧
// 已收缩为错误名）。任何输入（含 null）返回合法结果，不抛异常。
// 契约源：doc/stage3/detailed-design.md §5.1/§5.3 + Third_stage.md §5.2 + threat-model §3.2。
import type { ToolResultErrorCode } from '../../shared/types/agent';

export const INTERACTION_LIMITS = {
  reason: 200,
  text: 100,
  tag: 20,
  type: 100,
} as const;

export type InteractionAction = 'click' | 'fill' | 'scroll';

export interface NormalizedInteractionResult {
  ok: boolean;
  errorCode?: ToolResultErrorCode; // ok=false 时（闭合映射，见下）
  reason?: string; // 中文；ok=false 时
  tag?: string; // click/fill 成功时
  text?: string; // click 成功时（≤100）
  type?: string; // fill 成功时
  viewport?: { scrollX: number; scrollY: number; width: number; height: number }; // scroll 成功时
}

const GENERIC_FAILURE = '页面返回异常，交互结果不可用';

// 脚本 code → ToolResultErrorCode 闭合映射：not-found → element-not-found；
// not-interactable → not-interactable；其余一切（kind-mismatch/forbidden-type/
// not-fillable/bad-args/error/未知/缺失）→ execution-failed。
function mapCode(code: unknown): ToolResultErrorCode {
  if (code === 'not-found') return 'element-not-found';
  if (code === 'not-interactable') return 'not-interactable';
  return 'execution-failed';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function failure(errorCode: ToolResultErrorCode, reason: string): NormalizedInteractionResult {
  return { ok: false, errorCode, reason };
}

// 失败结果：code 映射 + reason 校验（字符串/空白折叠/≤200；缺失或非字符串 → 固定中文文案）
function readFailure(rec: Record<string, unknown>): NormalizedInteractionResult {
  const code = rec['code'];
  const errorCode = mapCode(code);
  const rawReason = asString(rec['reason']);
  const reason =
    rawReason !== null && rawReason !== ''
      ? collapseWhitespace(rawReason).slice(0, INTERACTION_LIMITS.reason)
      : code === 'not-found'
        ? '未找到目标元素'
        : code === 'not-interactable'
          ? '目标元素不可交互（不可见/禁用/只读）'
          : '页面交互执行失败';
  return failure(errorCode, reason);
}

function readViewport(rec: Record<string, unknown>): NormalizedInteractionResult['viewport'] {
  const viewport = asRecord(rec['viewport']);
  if (viewport === null) return undefined;
  const scrollX = asFiniteNumber(viewport['scrollX']);
  const scrollY = asFiniteNumber(viewport['scrollY']);
  const width = asFiniteNumber(viewport['width']);
  const height = asFiniteNumber(viewport['height']);
  if (scrollX === null || scrollY === null || width === null || height === null) return undefined;
  if (scrollX < 0 || scrollY < 0 || width < 0 || height < 0) return undefined;
  return { scrollX, scrollY, width, height };
}

export function normalizeInteractionResult(
  raw: unknown,
  action: InteractionAction,
): NormalizedInteractionResult {
  const rec = asRecord(raw);
  if (rec === null || rec['ok'] !== true) {
    if (rec !== null && rec['ok'] === false) return readFailure(rec);
    return failure('execution-failed', GENERIC_FAILURE);
  }

  if (action === 'scroll') {
    const viewport = readViewport(rec);
    return viewport === undefined
      ? failure('execution-failed', GENERIC_FAILURE)
      : { ok: true, viewport };
  }

  const tagValue = asString(rec['tag']);
  if (tagValue === null || tagValue === '') return failure('execution-failed', GENERIC_FAILURE);
  const tag = collapseWhitespace(tagValue).slice(0, INTERACTION_LIMITS.tag);

  if (action === 'click') {
    // text 必须为字符串（可为空串——图标按钮无文案）；非字符串 → 结构化失败
    const textRaw = rec['text'];
    if (typeof textRaw !== 'string') return failure('execution-failed', GENERIC_FAILURE);
    const text = collapseWhitespace(textRaw).slice(0, INTERACTION_LIMITS.text);
    return { ok: true, tag, text };
  }

  // fill：type 必须为非空字符串；结果不含输入值（脚本返回结构外无 value 通道）
  const typeRaw = rec['type'];
  if (typeof typeRaw !== 'string' || typeRaw.trim() === '') {
    return failure('execution-failed', GENERIC_FAILURE);
  }
  return { ok: true, tag, type: collapseWhitespace(typeRaw).slice(0, INTERACTION_LIMITS.type) };
}
