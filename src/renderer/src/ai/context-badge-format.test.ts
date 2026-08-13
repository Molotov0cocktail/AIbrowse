// context-badge-format 纯函数单测（§6.3 徽标文案契约）：
// selection →「选中文本（N 字）」；snapshot →「当前网页」+ thin/degraded 提示；
// none →「无网页上下文」+ 原因。
import { describe, expect, it } from 'vitest';
import type { ContextPreview } from '../../../shared/types/conversation';
import { describeContextPreview } from './context-badge-format';

const preview = (overrides: Partial<ContextPreview>): ContextPreview => ({
  tabId: 't1',
  url: 'https://example.com/',
  title: '示例页',
  readyState: 'ready',
  mode: 'snapshot',
  hasSelection: false,
  selectionLength: 0,
  thin: false,
  degraded: false,
  ...overrides,
});

describe('describeContextPreview', () => {
  it('selection → 选中文本（N 字）', () => {
    const text = describeContextPreview(
      preview({ mode: 'selection', hasSelection: true, selectionLength: 42 }),
    );
    expect(text.label).toBe('选中文本（42 字）');
    expect(text.hint).toBeNull();
  });

  it('snapshot → 当前网页（无提示）', () => {
    expect(describeContextPreview(preview({ mode: 'snapshot' }))).toEqual({
      label: '当前网页',
      hint: null,
    });
  });

  it('snapshot + thin → 薄快照提示', () => {
    const text = describeContextPreview(preview({ mode: 'snapshot', thin: true }));
    expect(text.label).toBe('当前网页');
    expect(text.hint).toContain('稀薄');
  });

  it('snapshot + degraded → 降级提示', () => {
    const text = describeContextPreview(preview({ mode: 'snapshot', degraded: true }));
    expect(text.hint).toContain('降级');
  });

  it('snapshot + thin + degraded → 两条提示合并', () => {
    const text = describeContextPreview(preview({ mode: 'snapshot', thin: true, degraded: true }));
    expect(text.hint).toContain('稀薄');
    expect(text.hint).toContain('降级');
    expect(text.hint).toContain('；');
  });

  it('none → 无网页上下文 + 原因', () => {
    const text = describeContextPreview(
      preview({ mode: 'none', tabId: null, url: null, title: null }),
    );
    expect(text.label).toBe('无网页上下文');
    expect(text.hint).toBe('当前没有可用的网页内容');
  });
});
