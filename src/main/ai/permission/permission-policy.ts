// 权限分级确定性纯函数（A2）。契约源：doc/stage3/detailed-design.md §7.1 +
// threat-model §3.3（决策层）。核心原则（Third_stage.md §1）：AI 决定「需要做什么」，
// 确定性程序决定「是否允许」——同一输入同一决策，无随机、无模型/网页参与通道。
//
// click 确定性允许列表（决议 #29，2026-08-14 实施前校正）判定优先级：
//   1. isSubmit === true → L2 确认（升级优先于一切其他特征，不降回 L1）；
//   2. href 存在且 http/https → L1（导航链接）；href 存在但非 http/https → L3（危险特征不放行）；
//   3. ariaExpanded 字段存在（true 与 false 均为展开/折叠控件的结构化证明——
//      采集脚本显式声明才产出该字段，§5.4）→ L1；
//   4. inputType ∈ {checkbox, radio} → L1（切换控件）；
//   5. 其余（普通按钮/语义不明/其他输入类型）→ L3 fail-closed。
// 历史快照中无该 elementId 的语义元数据（elementSemantics === null）→ L3——不得回落到
// 基础 L1，也不得以「执行时再检查」代替权限层 fail-closed（执行器层复核是纵深防御）。
//
// fill：inputType ∈ {password, file} 恒 L3；语义元数据缺失 → L3（无法证明目标不是
// 密码/文件字段）。
// open/navigate：URL 非 http/https 恒 L3（scheme 白名单，与 Tab 导航白名单同源判定）。
import type {
  ClickAllowedKind,
  ElementSemantics,
  ToolPermissionLevel,
} from '../../../shared/types/agent';

// §7.1 权限矩阵基础级别（编译期常量——模型与网页无通道修改本矩阵，threat-model T-06）
export const TOOL_BASE_RISK: Readonly<Record<string, ToolPermissionLevel>> = {
  'browser.get_tabs': 0,
  'browser.get_active_tab': 0,
  'browser.read': 0,
  'browser.find': 0,
  'browser.scroll': 0,
  'search.web': 0,
  'browser.open': 1,
  'browser.navigate': 1,
  'browser.back': 1,
  'browser.forward': 1,
  'browser.reload': 1,
  'browser.click': 1,
  'browser.fill': 1,
};

export interface PermissionDecision {
  level: ToolPermissionLevel;
  reason: string; // 中文（审计与可见性展示用；程序文案，不经模型/网页）
}

// 仅 http/https（与 Tab will-navigate 白名单同源判定；大小写不敏感）
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function decide(
  toolName: string,
  args: Record<string, unknown>,
  elementSemantics: ElementSemantics | null,
): PermissionDecision {
  const base = TOOL_BASE_RISK[toolName];
  if (base === undefined) {
    // 防御性 fail-closed：正常流程注册表已先拒绝未知工具（tool-not-found）
    return { level: 3, reason: `未知工具「${toolName}」，权限层拒绝` };
  }

  if (toolName === 'browser.open' || toolName === 'browser.navigate') {
    const url = args.url;
    if (typeof url !== 'string' || !isHttpUrl(url)) {
      return { level: 3, reason: 'URL 非 http/https，禁止该导航操作' };
    }
    return { level: 1, reason: '导航到公开网页（自动显著展示）' };
  }
  if (toolName === 'browser.click') {
    return decideClick(elementSemantics);
  }
  if (toolName === 'browser.fill') {
    return decideFill(elementSemantics);
  }

  return base === 0
    ? { level: 0, reason: '只读/低风险操作（自动执行）' }
    : { level: 1, reason: '低风险操作（自动显著展示）' };
}

// A3：click 确定性允许列表的单一事实源（决议 #29 判定优先级）。权限级别（decideClick）
// 与执行器内部参数 allowedKind（ToolExecutor 派生、交互脚本复核）都必须由本函数结果
// 派生——不得在 ToolExecutor 或 interaction-script 中另写一套分类规则（A3 单测双表对照）。
export function classifyClickTarget(semantics: ElementSemantics | null): ClickAllowedKind | null {
  if (semantics === null) return null;
  if (semantics.isSubmit === true) return 'submit'; // 首先升级，不因并存特征降回
  if (semantics.href !== undefined) {
    return isHttpUrl(semantics.href) ? 'nav' : null; // href 存在但非 http/https → 不放行
  }
  if (semantics.ariaExpanded !== undefined) return 'expand'; // true/false 均为展开/折叠控件
  if (semantics.inputType === 'checkbox' || semantics.inputType === 'radio') return 'toggle';
  return null; // 普通按钮/语义不明 → 无 allowedKind（权限层 L3 无执行通道）
}

function decideClick(semantics: ElementSemantics | null): PermissionDecision {
  const kind = classifyClickTarget(semantics);
  if (kind === 'submit') return { level: 2, reason: '提交类元素：需用户确认' };
  if (kind === 'nav') return { level: 1, reason: '导航链接（http/https）' };
  if (kind === 'expand') {
    // true/false 均为展开/折叠控件（§5.4「显式声明展开状态」= 字段存在）
    return { level: 1, reason: '展开/折叠控件（显式声明 aria-expanded）' };
  }
  if (kind === 'toggle') return { level: 1, reason: '复选/单选切换控件' };
  if (semantics === null) {
    return { level: 3, reason: '历史快照中无该 elementId 的语义元数据，click 禁止' };
  }
  if (semantics.href !== undefined) {
    return { level: 3, reason: '链接目标非 http/https，click 禁止' };
  }
  return { level: 3, reason: '非允许列表目标或语义不明，click 禁止' };
}

function decideFill(semantics: ElementSemantics | null): PermissionDecision {
  if (semantics === null || semantics.inputType === undefined) {
    return { level: 3, reason: '历史快照中无该 elementId 的类型元数据，fill 禁止' };
  }
  if (semantics.inputType === 'password' || semantics.inputType === 'file') {
    return { level: 3, reason: '目标为密码/文件输入，fill 禁止' };
  }
  return { level: 1, reason: '填写普通输入字段（自动显著展示）' };
}
