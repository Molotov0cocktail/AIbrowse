// A3 交互语义来源：快照 → ElementSemantics 确定性构建 + 按 Tab 存储 + 与可信文档世代
// （PageSnapshot.meta.documentId，主进程盖章）绑定。click/fill 权限判定经
// ToolExecutionContext.getElementSemantics 取本存储；read/find 工具实时采集快照后经
// recordSnapshot 更新（A5 接线为 Agent 历史提取时可整体替换本模块）。
// 契约源：doc/stage3/detailed-design.md §5.2/§5.4 + threat-model §3.2/§3.3。
// 世代信息只来自主进程盖章的快照 meta——模型/网页不可提供或修改，也不依赖页面中的
// data-aibrowse-el（纯属性可被新文档重新分配，探针已实证）。
import type { ElementSemantics, ElementSemanticsBinding } from '../../../shared/types/agent';
import type { PageSnapshot } from '../../../shared/types/browser';

// 快照结构化条目 → ElementSemantics 确定性映射（纯函数，可单测）：
// links → href/text；buttons → text/isSubmit/ariaExpanded；inputs → inputType/isSubmit
// （inputs 不产生 text——placeholder/value 非可见文本证据，宁缺勿错，A6 确认摘要源）。
// 字段存在 = 采集脚本显式证明（§5.4）；普通按钮得到仅 text 的语义对象（权限层 L3 fail-closed）。
export function buildSnapshotSemantics(snapshot: PageSnapshot): Map<string, ElementSemantics> {
  const map = new Map<string, ElementSemantics>();
  const entryOf = (id: string): ElementSemantics => map.get(id) ?? {};
  const merge = (id: string, fields: ElementSemantics): void => {
    const existing = entryOf(id);
    const merged: ElementSemantics = { ...existing };
    if (fields.href !== undefined) merged.href = fields.href;
    if (fields.text !== undefined) merged.text = fields.text;
    if (fields.ariaExpanded !== undefined) merged.ariaExpanded = fields.ariaExpanded;
    if (fields.inputType !== undefined) merged.inputType = fields.inputType;
    if (fields.isSubmit === true) merged.isSubmit = true; // 任一集合证明提交类即升级（跨集合同元素）
    map.set(id, merged);
  };
  for (const link of snapshot.links) merge(link.id, { href: link.href, text: link.text });
  for (const button of snapshot.buttons) {
    const fields: ElementSemantics = { text: button.text };
    if (button.isSubmit !== undefined) fields.isSubmit = button.isSubmit;
    if (button.ariaExpanded !== undefined) fields.ariaExpanded = button.ariaExpanded;
    merge(button.id, fields);
  }
  for (const input of snapshot.inputs ?? []) {
    const fields: ElementSemantics = { inputType: input.type };
    if (input.isSubmit !== undefined) fields.isSubmit = input.isSubmit;
    merge(input.id, fields);
  }
  return map;
}

// 按 Tab 存储最近一次工具采集快照的语义（含世代）。查找返回 null = 无法证明 →
// 权限层 fail-closed（不得回落到基础 L1 或执行时定位兜底）。
export class InteractionSemanticsStore {
  private readonly byTab = new Map<
    string,
    { documentId: number; elements: Map<string, ElementSemantics> }
  >();

  updateFromSnapshot(tabId: string, snapshot: PageSnapshot): void {
    this.byTab.set(tabId, {
      documentId: snapshot.meta.documentId,
      elements: buildSnapshotSemantics(snapshot),
    });
  }

  lookup(tabId: string | null, elementId: string): ElementSemanticsBinding | null {
    if (tabId === null) return null;
    const entry = this.byTab.get(tabId);
    if (entry === undefined) return null;
    const semantics = entry.elements.get(elementId);
    if (semantics === undefined) return null;
    return { semantics, documentId: entry.documentId };
  }

  clearTab(tabId: string): void {
    this.byTab.delete(tabId);
  }

  clearAll(): void {
    this.byTab.clear();
  }
}
