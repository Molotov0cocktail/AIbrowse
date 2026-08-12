import { useEffect, useRef, useState } from 'react';
import type { TabsState } from '../../../shared/types/browser';

// TabsState 订阅（§3.2）：tabs:updated 全量推送，渲染层幂等更新。
// 竞态防御：先注册订阅、再拉取初始快照；若期间已收到推送，丢弃较旧的 list 结果，
// 避免旧快照覆盖更新后的推送导致 UI 回退。卸载时经退订函数解除订阅。
export function useTabsState(): TabsState | null {
  const [state, setState] = useState<TabsState | null>(null);
  const receivedUpdate = useRef(false);

  useEffect(() => {
    const unsubscribe = window.aibrowse.tabs.onUpdated((next) => {
      receivedUpdate.current = true;
      setState(next);
    });
    window.aibrowse.tabs
      .list()
      .then((tabs) => {
        if (!receivedUpdate.current) {
          setState({ tabs, activeTabId: tabs.find((t) => t.active)?.id ?? null });
        }
      })
      .catch(() => {
        // list 失败保持 null（UI 显示空白状态）；后续任何 tabs:updated 推送会恢复正常
      });
    return unsubscribe;
  }, []);

  return state;
}
