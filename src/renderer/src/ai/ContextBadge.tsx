import { useEffect, useState } from 'react';
import { describeContextPreview } from './context-badge-format';
import { ContextPreviewRefresh, type ContextPreviewState } from './context-preview-refresh';

// 上下文徽标（§6.3）：conversation.preview 驱动（实时快照摘要，不含正文——快照正文
// 不跨 IPC）。触发时机：面板打开（挂载）、活动 Tab 变化（tabs:updated 即时）、
// 面板获得焦点（window focus，防抖 300ms）。文案由纯函数 describeContextPreview 映射。
const FOCUS_DEBOUNCE_MS = 300;

export function ContextBadge() {
  const [preview, setPreview] = useState<ContextPreviewState>(null);

  useEffect(() => {
    const refresher = new ContextPreviewRefresh({
      read: () => window.aibrowse.conversation.preview(),
      publish: setPreview,
    });
    let receivedUpdate = false;
    const unsubTabs = window.aibrowse.tabs.onUpdated((state) => {
      receivedUpdate = true;
      refresher.updateTabs(state);
    });
    // Subscribe before the initial list, so a late list cannot replace newer state.
    void window.aibrowse.tabs
      .list()
      .then((tabs) => {
        if (!receivedUpdate) {
          refresher.updateTabs({
            tabs,
            activeTabId: tabs.find((tab) => tab.active)?.id ?? null,
          });
        }
      })
      .catch(() => {
        refresher.initialStateUnavailable();
      });

    // 面板获得焦点 → 防抖 300ms 刷新（选中文本变化无 tabs:updated 事件）
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    const onFocus = (): void => {
      if (focusTimer !== null) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => refresher.refresh(), FOCUS_DEBOUNCE_MS);
    };
    window.addEventListener('focus', onFocus);

    return () => {
      refresher.dispose();
      unsubTabs();
      window.removeEventListener('focus', onFocus);
      if (focusTimer !== null) clearTimeout(focusTimer);
    };
  }, []);

  const text =
    preview === null
      ? { label: '正在获取上下文…', hint: null }
      : preview === 'unavailable'
        ? { label: '预览暂不可用，提问时实时采集', hint: null }
        : describeContextPreview(preview);

  return (
    <div className="ai-context-badge" aria-label="上下文徽标">
      <span className="ai-context-label">{text.label}</span>
      {text.hint !== null && <span className="ai-context-hint">{text.hint}</span>}
    </div>
  );
}
