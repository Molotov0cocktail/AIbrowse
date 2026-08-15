// ToolRegistry：进程内单例注册表 + 确定性参数校验。契约源：doc/stage3/detailed-design.md §4.1。
// 工具集封闭（未注册 = 不存在）；listTools 只从注册表生成模型可见 schema（description 与
// parameters 全部来自程序常量——模型/网页无写入通道）；validateToolArgs 对任意非法输入
// 安全返回 {ok:false, reason} 不抛异常（越界安全返回）。
import type { ProviderTool, ProviderToolParameter } from '../../../shared/types/conversation';
import type { ToolDefinition } from './tool-types';

// wire 名称契约（A7 补验校准，决议 #35）：OpenAI 兼容端点对 function.name 的通行约束为
// 字母/数字/下划线/连字符、1–64 位（DeepSeek 官方契约明确拒绝点号等字符并整组 400——
// 既有 13 工具名全部带点即为真实 Provider 首轮 400 的根因）。内部名 = wire 名（无映射层，
// 冲突不可能性由本契约 + 注册唯一性保证）；注册与序列化双阶段确定性拒绝，防止未来再把
// 非法工具名发给任何 Provider。
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// 校验上限常量（§4.1）：字符串参数统一 ≤ 500（url 参数 ≤ 2048）；tabId=UUID 形状、
// elementId=el-N 形状（与 snapshot-normalize 同款正则）。
export const VALIDATION_LIMITS = {
  stringMax: 500,
  urlMax: 2048,
} as const;

// B4 决议 #64：递归 object/array schema 的防御性边界——数组上限（缺省）与嵌套深度
// 上限（顶层字段值 = 第 1 层容器；覆盖 ops→op→patch/tags→叶容器四层形态）。
export const MAX_ARRAY_ITEMS = 20;
export const MAX_NESTING_DEPTH = 4;

// 递归参数值校验（B4 决议 #64）：object 一律 additionalProperties=false（properties
// 即字段白名单，未知键拒绝）；array 逐项校验 + maxItems（缺省 MAX_ARRAY_ITEMS）；
// 嵌套深度有界；任意非法输入安全返回中文错误串（不抛异常）。基础类型路径与既有
// 行为逐字一致（零回归——既有 13 工具无 object/array 参数，走原分支语义）。
function validateParamValue(
  param: ProviderToolParameter,
  value: unknown,
  path: string,
  depth: number,
): string | null {
  switch (param.type) {
    case 'string':
      if (typeof value !== 'string') return `参数类型不符：${path} 应为字符串`;
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `参数类型不符：${path} 应为数字`;
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') return `参数类型不符：${path} 应为布尔值`;
      break;
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `参数类型不符：${path} 应为对象`;
      }
      if (depth > MAX_NESTING_DEPTH) {
        return `参数嵌套过深：${path} 超过 ${MAX_NESTING_DEPTH} 层上限`;
      }
      const record = value as Record<string, unknown>;
      const properties = param.properties ?? {};
      for (const key of Object.keys(record)) {
        if (!(key in properties)) return `未知参数：${path}.${key}`;
      }
      for (const key of param.required ?? []) {
        if (!(key in record)) return `缺少必填参数：${path}.${key}`;
      }
      for (const [key, sub] of Object.entries(properties)) {
        const subValue = record[key];
        if (subValue === undefined) continue; // 可选字段缺省
        const err = validateParamValue(sub, subValue, `${path}.${key}`, depth + 1);
        if (err !== null) return err;
      }
      break;
    }
    case 'array': {
      if (!Array.isArray(value)) return `参数类型不符：${path} 应为数组`;
      if (depth > MAX_NESTING_DEPTH) {
        return `参数嵌套过深：${path} 超过 ${MAX_NESTING_DEPTH} 层上限`;
      }
      const maxItems = param.maxItems ?? MAX_ARRAY_ITEMS;
      if (value.length > maxItems) return `参数超限：${path} 超过 ${maxItems} 项上限`;
      if (param.items !== undefined) {
        for (let i = 0; i < value.length; i += 1) {
          const err = validateParamValue(param.items, value[i], `${path}[${i}]`, depth + 1);
          if (err !== null) return err;
        }
      }
      break;
    }
  }
  if (param.enum !== undefined && !param.enum.includes(value as string | number | boolean)) {
    return `参数值越界：${path} 不在允许枚举内`;
  }
  return null;
}

const TAB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELEMENT_ID_PATTERN = /^el-\d{1,10}$/;

const registry = new Map<string, ToolDefinition>();

export function registerTool(def: ToolDefinition): void {
  // wire 名称契约（决议 #35）：注册阶段确定性拒绝非法名——违反契约的工具名会导致
  // Provider 侧整组 tools 请求被拒（HTTP 400），装配期失败比运行时失败安全
  if (!TOOL_NAME_PATTERN.test(def.name)) {
    throw new Error(
      `工具名违反 wire 名称契约（仅允许字母/数字/下划线/连字符，1–64 位）：${def.name}`,
    );
  }
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
    .map((def) => {
      // 序列化阶段纵深防御（决议 #35）：注册期已拒绝非法名，此处为第二道确定性闸门
      // （防止未来绕过 registerTool 直改注册表的路径把非法名发给 Provider）
      if (!TOOL_NAME_PATTERN.test(def.name)) {
        throw new Error(`工具名违反 wire 名称契约（序列化阶段拒绝）：${def.name}`);
      }
      return {
        type: 'function' as const,
        function: {
          name: def.name,
          description: def.description,
          parameters: {
            type: 'object' as const,
            properties: { ...def.parameters.properties },
            required: [...def.parameters.required],
          },
        },
      };
    });
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
    // 递归校验（B4 决议 #64）：基础类型行为与既有实现逐字一致；object/array 走
    // additionalProperties=false + maxItems + 深度上限的最小递归扩展
    const typeErr = validateParamValue(param, value, key, 1);
    if (typeErr !== null) {
      return { ok: false, reason: typeErr };
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const rule = def.paramRules?.[key];
    if (typeof value === 'string') {
      const max =
        rule?.maxLength ?? (key === 'url' ? VALIDATION_LIMITS.urlMax : VALIDATION_LIMITS.stringMax);
      if (value.length > max) {
        return { ok: false, reason: `参数超长：${key} 超过 ${max} 字符上限` };
      }
      if (rule?.nonEmpty === true && value.trim() === '') {
        return { ok: false, reason: `参数不能为空：${key}` };
      }
      if (key === 'tabId' && !TAB_ID_PATTERN.test(value)) {
        return { ok: false, reason: '参数格式不合法：tabId 必须为 UUID 形状' };
      }
      if (key === 'elementId' && !ELEMENT_ID_PATTERN.test(value)) {
        return { ok: false, reason: '参数格式不合法：elementId 必须为 el-N 形状' };
      }
    }
    if (typeof value === 'number' && rule !== undefined) {
      // A3：数字规则（整数/范围）——任意非法输入安全返回不抛异常
      if (rule.integer === true && !Number.isInteger(value)) {
        return { ok: false, reason: `参数必须为整数：${key}` };
      }
      if (rule.min !== undefined && value < rule.min) {
        return { ok: false, reason: `参数越界：${key} 不得小于 ${rule.min}` };
      }
      if (rule.max !== undefined && value > rule.max) {
        return { ok: false, reason: `参数越界：${key} 不得超过 ${rule.max}` };
      }
    }
  }

  return { ok: true, args };
}
