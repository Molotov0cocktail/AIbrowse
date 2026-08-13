// Pure ContextPreview → 徽标文案映射（§6.3，unit-tested；零 React/Electron 依赖）。
// selection →「选中文本（N 字）」；snapshot →「当前网页」+ thin/degraded 提示；
// none →「无网页上下文」+ 原因（页面不可用/无活动网页）。
import type { ContextPreview } from '../../../shared/types/conversation';

export interface ContextBadgeText {
  label: string;
  hint: string | null; // 展示用中文提示（thin/degraded/无上下文原因）
}

export function describeContextPreview(preview: ContextPreview): ContextBadgeText {
  if (preview.mode === 'selection') {
    return { label: `选中文本（${preview.selectionLength} 字）`, hint: null };
  }
  if (preview.mode === 'snapshot') {
    const hints: string[] = [];
    if (preview.thin) hints.push('页面可读内容稀薄，回答可能缺少依据');
    if (preview.degraded) hints.push('页面采集部分降级');
    return { label: '当前网页', hint: hints.length > 0 ? hints.join('；') : null };
  }
  return { label: '无网页上下文', hint: '当前没有可用的网页内容' };
}
