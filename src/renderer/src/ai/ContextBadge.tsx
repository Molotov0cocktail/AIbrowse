import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContextPreview } from '../../../shared/types/conversation';
import { describeContextPreview } from './context-badge-format';

// 上下文徽标（§6.3）：conversation.preview 驱动（实时快照摘要，不含正文——快照正文
// 不跨 IPC）。触发时机：面板打开（挂载）、活动 Tab 变化（tabs:updated 即时）、
// 面板获得焦点（window focus，防抖 300ms）。文案由纯函数 describeContextPreview 映射。
const FOCUS_DEBOUNCE_MS = 300;

export function ContextBadge() {
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback((): void => {
    window.aibrowse.conversation
      .preview()
      .then((next) => {
        if (mountedRef.current) setPreview(next);
      })
      .catch(() => {
        // IPC 异常保持上次徽标（后续 tabs:updated/焦点事件会再次刷新）
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh(); // 面板打开即刷新

    // 活动 Tab 变化 → 即时刷新（与提问同一采集路径，不共享缓存）
    const unsubTabs = window.aibrowse.tabs.onUpdated(() => refresh());

    // 面板获得焦点 → 防抖 300ms 刷新（选中文本变化无 tabs:updated 事件）
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    const onFocus = (): void => {
      if (focusTimer !== null) clearTimeout(focusTimer);
      focusTimer = setTimeout(refresh, FOCUS_DEBOUNCE_MS);
    };
    window.addEventListener('focus', onFocus);

    return () => {
      mountedRef.current = false;
      unsubTabs();
      window.removeEventListener('focus', onFocus);
      if (focusTimer !== null) clearTimeout(focusTimer);
    };
  }, [refresh]);

  const text = preview === null ? null : describeContextPreview(preview);

  return (
    <div className="ai-context-badge" aria-label="上下文徽标">
      <span className="ai-context-label">{preview === null ? '正在获取上下文…' : text?.label}</span>
      {text?.hint !== null && text?.hint !== undefined && (
        <span className="ai-context-hint">{text.hint}</span>
      )}
    </div>
  );
}
