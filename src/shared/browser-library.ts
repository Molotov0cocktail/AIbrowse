import { isTabGroupName, TAB_GROUP_COLORS } from './tab-groups';
import type {
  BrowserBookmarkInput,
  BrowserBookmarkListRequest,
  BrowserBookmarkGroupInput,
  BrowserBookmarkUpdate,
  BrowserLibraryListRequest,
} from './types/browser-library';

export const BROWSER_LIBRARY_LIMITS = Object.freeze({
  url: 8192,
  title: 1000,
  query: 200,
  page: 100,
});

export function isBrowserLibraryId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
}

export function isBrowserLibraryTime(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function normalizeBrowserLibraryUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > BROWSER_LIBRARY_LIMITS.url)
    return null;
  if (
    Array.from(value).some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
    )
  )
    return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.username === '' &&
      url.password === '' &&
      url.href.length <= BROWSER_LIBRARY_LIMITS.url
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isBrowserLibraryTitle(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= BROWSER_LIBRARY_LIMITS.title &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
    })
  );
}

export function isBrowserLibraryListRequest(value: unknown): value is BrowserLibraryListRequest {
  return (
    closed(value, ['query', 'cursor', 'limit']) &&
    typeof value.query === 'string' &&
    value.query.length <= BROWSER_LIBRARY_LIMITS.query &&
    !Array.from(value.query).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    Number.isInteger(value.limit) &&
    Number(value.limit) >= 1 &&
    Number(value.limit) <= BROWSER_LIBRARY_LIMITS.page &&
    (value.cursor === null ||
      (closed(value.cursor, ['at', 'id']) &&
        isBrowserLibraryTime(value.cursor.at) &&
        isBrowserLibraryId(value.cursor.id)))
  );
}

export function isBrowserBookmarkInput(value: unknown): value is BrowserBookmarkInput {
  return (
    closed(value, ['url', 'title']) &&
    normalizeBrowserLibraryUrl(value.url) !== null &&
    isBrowserLibraryTitle(value.title)
  );
}

export function isBrowserBookmarkUpdate(value: unknown): value is BrowserBookmarkUpdate {
  return (
    (closed(value, ['id', 'url', 'title']) ||
      (closed(value, ['id', 'url', 'title', 'groupId']) &&
        (value.groupId === null || isBrowserLibraryId(value.groupId)))) &&
    isBrowserLibraryId(value.id) &&
    normalizeBrowserLibraryUrl(value.url) !== null &&
    isBrowserLibraryTitle(value.title)
  );
}

export function isBrowserBookmarkGroupInput(value: unknown): value is BrowserBookmarkGroupInput {
  return (
    closed(value, ['name', 'color', 'bookmarks']) &&
    isTabGroupName(value.name) &&
    TAB_GROUP_COLORS.some((color) => color === value.color) &&
    Array.isArray(value.bookmarks) &&
    value.bookmarks.length >= 1 &&
    value.bookmarks.length <= 100 &&
    value.bookmarks.every(isBrowserBookmarkInput)
  );
}

export function isBrowserBookmarkListRequest(value: unknown): value is BrowserBookmarkListRequest {
  if (isBrowserLibraryListRequest(value)) return true;
  return (
    closed(value, ['query', 'cursor', 'limit', 'groupId']) &&
    (value.groupId === null || isBrowserLibraryId(value.groupId)) &&
    isBrowserLibraryListRequest({ query: value.query, cursor: value.cursor, limit: value.limit })
  );
}
