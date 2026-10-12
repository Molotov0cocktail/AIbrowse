import type { BrowserLibraryService } from './browser-library/browser-library-service';
import type {
  BrowserBookmarkInput,
  BrowserBookmarkUpdate,
  BrowserLibraryListRequest,
  BrowserLibraryResult,
} from '../shared/types/browser-library';
import { normalizeBrowserLibraryUrl } from '../shared/browser-library';
import { IPC } from '../shared/types/ipc';

export function browserPageForLibrary(
  page: BrowserBookmarkInput | null,
): BrowserBookmarkInput | null {
  if (page === null) return null;
  const url = normalizeBrowserLibraryUrl(page.url);
  if (url === null) return null;
  // Page titles are untrusted display metadata, never an error or diagnostic payload.
  const title = Array.from(page.title)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join('')
    .slice(0, 1000);
  return { url, title };
}

const unavailable = (): BrowserLibraryResult<never> => ({
  ok: false,
  code: 'unavailable',
  message: '浏览历史与书签暂不可用，请查看设置中的本地数据',
});

/** Call only after current UI document authorization and strict payload validation. */
export function dispatchBrowserLibrary(
  channel: string,
  payload: unknown,
  service: BrowserLibraryService | null,
  currentPage: () => BrowserBookmarkInput | null,
): unknown {
  if (channel === IPC.BrowserLibraryStatus)
    return (
      service?.getStatus() ?? {
        state: 'unavailable',
        message: '浏览历史与书签暂不可用，请查看设置中的本地数据',
      }
    );
  if (service === null) return unavailable();
  switch (channel) {
    case IPC.BrowserHistoryList:
      return service.listHistory(payload as BrowserLibraryListRequest);
    case IPC.BrowserHistoryDelete:
      return service.deleteHistory((payload as { id: string }).id);
    case IPC.BrowserHistoryClear:
      return service.clearHistory();
    case IPC.BrowserBookmarksList:
      return service.listBookmarks(payload as BrowserLibraryListRequest);
    case IPC.BrowserBookmarkUpdate:
      return service.updateBookmark(payload as BrowserBookmarkUpdate);
    case IPC.BrowserBookmarkRemove:
      return service.removeBookmark((payload as { id: string }).id);
    case IPC.BrowserBookmarkGetCurrent:
    case IPC.BrowserBookmarkAddCurrent: {
      const page = browserPageForLibrary(currentPage());
      if (page === null)
        return channel === IPC.BrowserBookmarkGetCurrent
          ? { ok: true, value: null }
          : { ok: false, code: 'invalid-input', message: '请先打开可以收藏的网页' };
      return channel === IPC.BrowserBookmarkGetCurrent
        ? service.getBookmarkForUrl(page.url)
        : service.addBookmark(page);
    }
    default:
      return unavailable();
  }
}
