import type { TabGroupColor } from './browser';

export interface BrowserHistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: string;
}

export interface BrowserBookmark {
  groupId: string | null;
  id: string;
  url: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserLibraryCursor {
  at: string;
  id: string;
}

export interface BrowserLibraryListRequest {
  query: string;
  cursor: BrowserLibraryCursor | null;
  limit: number;
}

export interface BrowserLibraryPage<T> {
  items: T[];
  nextCursor: BrowserLibraryCursor | null;
}

export type BrowserLibraryResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: 'invalid-input' | 'unavailable' | 'maintenance' | 'not-found' | 'storage-error';
      message: string;
    };

export interface BrowserBookmarkInput {
  url: string;
  title: string;
}

export interface BrowserBookmarkUpdate extends BrowserBookmarkInput {
  groupId?: string | null;
  id: string;
}

export interface BrowserVisitTitleUpdate extends BrowserBookmarkInput {
  id: string;
}

export interface BrowserLibraryStatus {
  state: 'initializing' | 'available' | 'unavailable' | 'maintenance' | 'storage-error';
  message: string;
}

export interface BrowserBookmarkGroup {
  id: string;
  name: string;
  color: TabGroupColor;
}
export interface BrowserBookmarkGroupInput {
  name: string;
  color: TabGroupColor;
  bookmarks: BrowserBookmarkInput[];
}

export interface BrowserBookmarkListRequest extends BrowserLibraryListRequest {
  groupId?: string | null;
}
