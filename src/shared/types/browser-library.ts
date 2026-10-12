export interface BrowserHistoryEntry {
  id: string;
  url: string;
  title: string;
  visitedAt: string;
}

export interface BrowserBookmark {
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
  id: string;
}

export interface BrowserVisitTitleUpdate extends BrowserBookmarkInput {
  id: string;
}

export interface BrowserLibraryStatus {
  state: 'available' | 'unavailable' | 'maintenance' | 'storage-error';
  message: string;
}
