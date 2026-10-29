import type { TabsState, TabGroupColor } from '../shared/types/browser';
import type { BrowserBookmarkInput } from '../shared/types/browser-library';
import { browserPageForLibrary } from './browser-library-ipc';

/** Resolve trusted user-owned group metadata without accepting renderer URLs. */
export function browserBookmarkGroupFromTabs(
  state: TabsState | null,
  groupId: string,
): { name: string; color: TabGroupColor; bookmarks: BrowserBookmarkInput[] } | null {
  const group = state?.groups?.find((candidate) => candidate.id === groupId);
  if (!state || !group || group.tabIds.length === 0 || group.tabIds.length > 100) return null;
  const bookmarks: BrowserBookmarkInput[] = [];
  for (const tabId of group.tabIds) {
    if (state.userTabIds?.includes(tabId) !== true) return null;
    const tab = state.tabs.find((candidate) => candidate.id === tabId);
    const page = browserPageForLibrary(tab ?? null);
    if (page === null) return null;
    bookmarks.push(page);
  }
  return { name: group.name, color: group.color, bookmarks };
}
