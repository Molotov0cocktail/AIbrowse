import type { TabInfo, TabsState } from '../../../shared/types/browser';

export function isStartPageTab(tab: TabInfo | null, state: TabsState | null): boolean {
  return (
    tab !== null &&
    state?.userTabIds?.includes(tab.id) === true &&
    (tab.url === '' || tab.url === 'about:blank') &&
    tab.state !== 'loading' &&
    tab.state !== 'error'
  );
}

export interface StartWatchItem {
  id: string;
  sourceName: string;
  state: 'enabled' | 'paused';
  health: 'healthy' | 'degraded' | 'paused';
}

export function startWatchItems(value: unknown): StartWatchItem[] | null {
  if (typeof value !== 'object' || value === null || !('items' in value)) return null;
  if (!Array.isArray(value.items) || value.items.length > 4) return null;
  const items: StartWatchItem[] = [];
  for (const item of value.items as unknown[]) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('id' in item) ||
      typeof item.id !== 'string' ||
      !('sourceName' in item) ||
      typeof item.sourceName !== 'string' ||
      !('state' in item) ||
      (item.state !== 'enabled' && item.state !== 'paused') ||
      !('health' in item) ||
      !['healthy', 'degraded', 'paused'].includes(String(item.health))
    )
      return null;
    items.push({
      id: item.id,
      sourceName: item.sourceName,
      state: item.state,
      health: item.health as StartWatchItem['health'],
    });
  }
  return items;
}
