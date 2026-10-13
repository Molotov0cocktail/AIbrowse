import { useEffect, useRef, useState } from 'react';
import type { TabsState } from '../../../shared/types/browser';

interface TabsStateSource {
  getState?: () => Promise<TabsState>;
  list?: () => Promise<TabsState['tabs']>;
  onUpdated(listener: (state: TabsState) => void): () => void;
}

export function subscribeTabsState(
  source: TabsStateSource,
  onState: (state: TabsState) => void,
): () => void {
  let receivedUpdate = false;
  let disposed = false;
  const unsubscribe = source.onUpdated((next) => {
    if (disposed) return;
    receivedUpdate = true;
    onState(next);
  });
  const initialState =
    source.getState?.() ??
    source.list?.().then((tabs) => ({
      tabs,
      activeTabId: tabs.find((tab) => tab.active)?.id ?? null,
    }));
  if (initialState === undefined) return unsubscribe;
  void initialState
    .then((initial) => {
      if (!disposed && !receivedUpdate) onState(initial);
    })
    .catch(() => {
      // Keep the empty state after an initial read failure; a later push can recover it.
    });
  return () => {
    disposed = true;
    unsubscribe();
  };
}

// Subscribe before reading the full initial state so a late read cannot overwrite a newer push.
export function useTabsState(): TabsState | null {
  const [state, setState] = useState<TabsState | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeTabsState(window.aibrowse.tabs, (next) => {
      if (mounted.current) setState(next);
    });
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, []);

  return state;
}
