// ToolRegistry：进程内单例注册表 + 确定性参数校验。契约源：doc/stage3/detailed-design.md §4.1。
// 工具集封闭（未注册 = 不存在）；listTools 只从注册表生成模型可见 schema（description 与
// parameters 全部来自程序常量——模型/网页无写入通道）；validateToolArgs 对任意非法输入
// 安全返回 {ok:false, reason} 不抛异常（越界安全返回）。
import type { ProviderTool } from '../../../shared/types/conversation';
import type { ToolDefinition } from './tool-types';

// 校验上限常量（§4.1）：字符串参数统一 ≤ 500（url 参数 ≤ 2048）；tabId=UUID 形状、
// elementId=el-N 形状（与 snapshot-normalize 同款正则）。
export const VALIDATION_LIMITS = {
  stringMax: 500,
  urlMax: 2048,
} as const;

const TAB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELEMENT_ID_PATTERN = /^el-\d{1,10}$/;

const registry = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  // 工具名唯一：重复注册为装配错误，确定性抛出（启动期失败比静默缺工具安全）
  if (registry.has(def.name)) {
    throw new Error(`工具重复注册：${def.name}`);
  }
  registry.set(def.name, def);
}

// 测试专用：清空注册表（进程内单例；单测文件间互不污染）
export function resetToolRegistry(): void {
  registry.clear();
}

export function getTool(name: string): ToolDefinition | null {
  return registry.get(name) ?? null;
}

// 序列化为模型可见 tools（§2.1 ProviderTool）：只输出 name/description/parameters，
// 按工具名排序保证输出顺序确定性；每次返回全新对象（调用方修改不影响注册表）。
export function listTools(): ProviderTool[] {
  return [...registry.values()]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((def) => ({
      type: 'function',
      function: {
        name: def.name,
        description: def.description,
        parameters: {
          type: 'object',
          properties: { ...def.parameters.properties },
          required: [...def.parameters.required],
        },
      },
    }));
}

// 确定性校验：JSON.parse 失败 / 未知工具 / 缺必填 / 类型不符 / enum 越界 / 未知键（拒绝）
// / 字符串长度超上限 / tabId、elementId 格式白名单 → {ok:false, reason}，不抛异常。
export function validateToolArgs(
  name: string,
  rawArgs: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  const def = registry.get(name);
  if (def === undefined) {
    return { ok: false, reason: `未知工具：${name}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return { ok: false, reason: '参数不是合法 JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: '参数必须是 JSON 对象' };
  }
  const args = parsed as Record<string, unknown>;

  for (const key of def.parameters.required) {
    if (!(key in args)) {
      return { ok: false, reason: `缺少必填参数：${key}` };
    }
  }
  for (const key of Object.keys(args)) {
    if (!(key in def.parameters.properties)) {
      return { ok: false, reason: `未知参数：${key}` };
    }
  }
  for (const [key, param] of Object.entries(def.parameters.properties)) {
    const value = args[key];
    if (value === undefined) continue; // 可选参数缺省
    if (param.type === 'string' && typeof value !== 'string') {
      return { ok: false, reason: `参数类型不符：${key} 应为字符串` };
    }
    if (param.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
      return { ok: false, reason: `参数类型不符：${key} 应为数字` };
    }
    if (param.type === 'boolean' && typeof value !== 'boolean') {
      return { ok: false, reason: `参数类型不符：${key} 应为布尔值` };
    }
    if (param.enum !== undefined && !param.enum.includes(value as string | number | boolean)) {
      return { ok: false, reason: `参数值越界：${key} 不在允许枚举内` };
    }
  }
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== 'string') continue;
    const max = key === 'url' ? VALIDATION_LIMITS.urlMax : VALIDATION_LIMITS.stringMax;
    if (value.length > max) {
      return { ok: false, reason: `参数超长：${key} 超过 ${max} 字符上限` };
    }
    if (key === 'tabId' && !TAB_ID_PATTERN.test(value)) {
      return { ok: false, reason: '参数格式不合法：tabId 必须为 UUID 形状' };
    }
    if (key === 'elementId' && !ELEMENT_ID_PATTERN.test(value)) {
      return { ok: false, reason: '参数格式不合法：elementId 必须为 el-N 形状' };
    }
  }

  return { ok: true, args };
}
