// C8 决议 #158：大结果画布与 WebContentsView 可见性——仅 React 切 viewMode
// 不足以显示结果画布（原生 WebContentsView 覆盖 DOM）。BrowserControllerImpl
// 增加 contentVisible 状态与 setContentVisible(boolean)（仅供受信 UI 使用，
// 不进 AI BrowserController/Tool 能力接口——接口文件零 diff 断言）。可见性
// 决策提取为纯函数 resolveViewVisibility（零 Electron import）单测全矩阵；
// 集成行为（setVisible 实际调用）由冒烟 8.19-B 机器断言。
import { describe, expect, it } from 'vitest';
import { resolveViewVisibility } from './view-visibility';

describe('resolveViewVisibility（决议 #158(2)）', () => {
  const TABS = ['t1', 't2', 't3'];

  it('contentVisible=true（默认）：仅 active Tab 可见', () => {
    const map = resolveViewVisibility(TABS, 't2', true);
    expect(map.get('t1')).toBe(false);
    expect(map.get('t2')).toBe(true);
    expect(map.get('t3')).toBe(false);
  });

  it('contentVisible=false：全部 Tab 不可见（不泄漏任何可见 view）', () => {
    const map = resolveViewVisibility(TABS, 't2', false);
    for (const id of TABS) expect(map.get(id)).toBe(false);
  });

  it('contentVisible=false 时 activeTabId 任意（含 null）均全隐藏', () => {
    expect(resolveViewVisibility(TABS, null, false).get('t1')).toBe(false);
    expect(resolveViewVisibility(TABS, 't1', false).get('t1')).toBe(false);
  });

  it('contentVisible=true 且 activeTabId=null：全部隐藏（无 active 可显示）', () => {
    const map = resolveViewVisibility(TABS, null, true);
    for (const id of TABS) expect(map.get(id)).toBe(false);
  });

  it('空 Tab 集合 → 空映射', () => {
    expect(resolveViewVisibility([], null, true).size).toBe(0);
    expect(resolveViewVisibility([], null, false).size).toBe(0);
  });

  it('activeTabId 不在集合中 → 全部隐藏（纵深防御，不猜测）', () => {
    const map = resolveViewVisibility(TABS, 'unknown', true);
    for (const id of TABS) expect(map.get(id)).toBe(false);
  });

  it('恢复 true 后只显示 active Tab（往返切换不改变集合与 active 语义）', () => {
    const hidden = resolveViewVisibility(TABS, 't1', false);
    expect(hidden.get('t1')).toBe(false);
    const restored = resolveViewVisibility(TABS, 't1', true);
    expect(restored.get('t1')).toBe(true);
    expect(restored.get('t2')).toBe(false);
    expect(restored.get('t3')).toBe(false);
  });
});
