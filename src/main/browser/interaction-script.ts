// A3 交互注入脚本源：固定模板（click/fill/scroll 三个动作分支），与 snapshot-script 同模式
// ——自安装函数经 .toString() 序列化，参数只经 JSON 字面量进入（buildInteractionSource），
// 无任何运行时代码拼接路径（红线：不允许 AI 直接构造任意 DOM JavaScript，threat-model §3.2）。
// click 按 allowedKind 对 DOM 实时属性逐一复核（执行器层不可达，§5.1/§5.2 + threat-model
// §3.3）：allowedKind 是权限决策派生、executor 注入的执行器内部参数——本脚本只做复核，
// 不自行分类；任何不符/未知 kind/定位失败/不可交互 → 结构化失败（ok:false + code），
// 绝不把异常、堆栈或页面原文穿透给主进程（error 的 reason 仅 err.name）。
// fill：只允许 input/textarea，password/file 执行层再次拒绝，原生 value setter + 冒泡
// input/change 事件（React 受控组件兼容）；返回不含输入值。
// scroll：window.scrollBy(0, dy)，dy 整数 ±50000，返回 viewport 摘要。
// 页面世界约束（threat-model §6）：无 preload、无 IPC、无 Node API，与采集脚本同等约束。
// 约束：函数必须自包含（不引用任何模块级标识符，序列化后独立运行）。
/// <reference lib="dom" />

import type { ClickAllowedKind } from '../../shared/types/agent';

// 主进程构造的交互参数（JSON 字面量注入；页面世界不可信原则下脚本仍逐字段防御校验）
export type InteractionScriptParams =
  | { action: 'click'; elementId: string; allowedKind: ClickAllowedKind }
  | { action: 'fill'; elementId: string; text: string }
  | { action: 'scroll'; dy: number };

function interact(params: InteractionScriptParams): unknown {
  'use strict';

  // 常量必须定义在函数内（.toString() 序列化自包含约束——与 snapshot-script 同规则，
  // 不引用任何模块级标识符）。elementId 格式与 snapshot-normalize 同款（el-<1–10 位数字）。
  const ELEMENT_ID_PATTERN = /^el-\d{1,10}$/;
  const ALLOWED_KINDS: ReadonlySet<string> = new Set(['nav', 'expand', 'toggle', 'submit']);
  const SCROLL_LIMIT = 50000;
  const TEXT_SUMMARY_MAX = 100;

  // ---------- 参数防御校验（主进程已校验，此处纵深防御；任何非法 → bad-args） ----------
  if (typeof params !== 'object' || params === null) {
    return { ok: false, code: 'bad-args', reason: '交互参数不合法' };
  }
  const action = (params as { action?: unknown }).action;
  if (action !== 'click' && action !== 'fill' && action !== 'scroll') {
    return { ok: false, code: 'bad-args', reason: '交互参数不合法' };
  }
  const elementId = (params as { elementId?: unknown }).elementId;
  const needsElement = action === 'click' || action === 'fill';
  if (needsElement && (typeof elementId !== 'string' || !ELEMENT_ID_PATTERN.test(elementId))) {
    return { ok: false, code: 'bad-args', reason: '交互参数不合法' };
  }
  if (action === 'click') {
    const kind = (params as { allowedKind?: unknown }).allowedKind;
    if (typeof kind !== 'string' || !ALLOWED_KINDS.has(kind)) {
      return { ok: false, code: 'bad-args', reason: '交互参数不合法' };
    }
  }
  if (action === 'fill' && typeof (params as { text?: unknown }).text !== 'string') {
    return { ok: false, code: 'bad-args', reason: '交互参数不合法' };
  }
  if (action === 'scroll') {
    const dy = (params as { dy?: unknown }).dy;
    if (
      typeof dy !== 'number' ||
      !Number.isInteger(dy) ||
      dy < -SCROLL_LIMIT ||
      dy > SCROLL_LIMIT
    ) {
      return { ok: false, code: 'bad-args', reason: '交互参数不合法' };
    }
  }

  const visibleTextOf = (el: Element): string => {
    const raw = el.tagName === 'INPUT' ? (el as HTMLInputElement).value : (el.textContent ?? '');
    const collapsed = raw.trim().replace(/\s+/g, ' ');
    return collapsed.length > TEXT_SUMMARY_MAX ? collapsed.slice(0, TEXT_SUMMARY_MAX) : collapsed;
  };

  const isHidden = (el: Element): boolean => {
    const html = el as HTMLElement;
    return html.offsetParent === null && el.getClientRects().length === 0;
  };

  try {
    // ---------- scroll：window.scrollBy(0, dy) + viewport 摘要 ----------
    if (action === 'scroll') {
      const dy = (params as { dy: number }).dy;
      window.scrollBy(0, dy);
      return {
        ok: true,
        viewport: {
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          width: window.innerWidth,
          height: window.innerHeight,
        },
      };
    }

    // ---------- 执行时刻实时重新定位（不信任快照时刻状态，§5.2） ----------
    // elementId 已过 el-N 格式校验；data-aibrowse-el 烙印值为纯数字（快照契约
    // el-N ↔ 属性 N），选择器使用数字部分——纯数字拼入属性选择器无注入面
    const brand = (elementId as string).slice(3);
    const el = document.querySelector(`[data-aibrowse-el="${brand}"]`);
    if (el === null) {
      return { ok: false, code: 'not-found', reason: '未找到目标元素' };
    }
    if ((el as HTMLElement & { disabled?: boolean }).disabled === true || isHidden(el)) {
      return { ok: false, code: 'not-interactable', reason: '目标元素不可交互（不可见或已禁用）' };
    }

    // ---------- click：按 allowedKind 复核 DOM 实时属性（不符 → kind-mismatch） ----------
    if (action === 'click') {
      const kind = (params as { allowedKind: ClickAllowedKind }).allowedKind;
      const tag = el.tagName;
      const typeAttr = el.getAttribute('type');
      let matches = false;
      if (kind === 'nav') {
        // A 标签 + 实时 href 解析为 http/https（不信任 el.href 属性——页面可篡改原型）
        const raw = el.getAttribute('href');
        if (tag === 'A' && raw !== null) {
          try {
            const resolved = new URL(raw, location.href);
            matches = resolved.protocol === 'http:' || resolved.protocol === 'https:';
          } catch {
            matches = false; // 无法解析的 href（如畸形协议）安全拒绝
          }
        }
      } else if (kind === 'expand') {
        matches = el.hasAttribute('aria-expanded'); // 属性存在即展开/折叠控件（值 true/false 均可）
      } else if (kind === 'toggle') {
        matches = tag === 'INPUT' && (typeAttr === 'checkbox' || typeAttr === 'radio');
      } else if (kind === 'submit') {
        // 与快照 isSubmit 判定同源：BUTTON type=submit 或（无显式 type 且位于 form 内）；
        // INPUT type=submit（type=reset 不是提交类）
        matches =
          (tag === 'BUTTON' &&
            (typeAttr === 'submit' ||
              ((typeAttr === null || typeAttr === '') && el.closest('form') !== null))) ||
          (tag === 'INPUT' && typeAttr === 'submit');
      }
      if (!matches) {
        return { ok: false, code: 'kind-mismatch', reason: '目标元素与允许的点击类别不符' };
      }
      (el as HTMLElement).click(); // 原生事件，最接近用户语义
      return { ok: true, tag: tag.toLowerCase(), text: visibleTextOf(el) };
    }

    // ---------- fill：只允许 input/textarea；password/file 执行层再次拒绝 ----------
    const tag = el.tagName;
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      return { ok: false, code: 'not-fillable', reason: '目标元素不是可填写的输入框' };
    }
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const type = tag === 'INPUT' ? (input.getAttribute('type') ?? 'text') : 'textarea';
    if (type === 'password' || type === 'file') {
      return { ok: false, code: 'forbidden-type', reason: '禁止填写密码/文件输入框' };
    }
    if (input.disabled === true || input.readOnly === true || isHidden(el)) {
      return {
        ok: false,
        code: 'not-interactable',
        reason: '目标元素不可交互（不可见/禁用/只读）',
      };
    }
    // 原生 value setter（绕过 React 实例 tracker 的正确驱动手法）+ 冒泡 input/change 事件
    const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor === undefined || typeof descriptor.set !== 'function') {
      // 页面篡改原型：fail-closed，不静默退化（直接赋值无法驱动 React 受控组件）
      return { ok: false, code: 'error', reason: '原生输入原型不可用' };
    }
    const text = (params as { text: string }).text;
    descriptor.set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    // 返回不含输入值（隐私最小化：结果/日志/审计零原文）
    return { ok: true, tag: tag.toLowerCase(), type };
  } catch (err) {
    // 页面异常（篡改原型/抛异常的 getter/节点被并发删除）→ 结构化失败；
    // reason 仅错误名，异常消息与堆栈只留在页面世界（不穿透 ToolResult）
    return { ok: false, code: 'error', reason: err instanceof Error ? err.name : 'Error' };
  }
}

// 自安装函数源：注入后在页面主世界立即执行；参数在 buildInteractionSource 经 JSON 字面量追加
export const INTERACTION_SCRIPT_SOURCE: string = `(${interact.toString()})`;

// 组装注入源：模板编译期固定 + 参数 JSON 字面量（JSON.stringify 保证字符串转义，
// 敌手参数无法逃逸模板——单测以 vm 真实执行证明）
export function buildInteractionSource(params: InteractionScriptParams): string {
  return `${INTERACTION_SCRIPT_SOURCE}(${JSON.stringify(params)})`;
}
