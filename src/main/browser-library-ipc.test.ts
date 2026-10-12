import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openBrowserLibraryStore } from './browser-library/browser-library-store';
import type { BrowserLibraryService } from './browser-library/browser-library-service';
import { dispatchBrowserLibrary, browserPageForLibrary } from './browser-library-ipc';
import { IPC } from '../shared/types/ipc';

const opened: Array<{ path: string; service: BrowserLibraryService }> = [];
afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.service.dispose();
    rmSync(entry.path, { recursive: true, force: true });
  }
});
function store() {
  const path = mkdtempSync(join(tmpdir(), 'browser-library-ipc-'));
  const outcome = openBrowserLibraryStore({ dbPath: join(path, 'browser.db') });
  if (outcome.mode !== 'normal') throw new Error('夹具打开失败');
  opened.push({ path, service: outcome.service });
  return outcome.service;
}
it('收藏当前页取主进程真实已提交网址，空白或任务页不能收藏', () => {
  const service = store();
  const current = () => ({ url: 'https://example.com/?private=value#section', title: '标题' });
  const result = dispatchBrowserLibrary(IPC.BrowserBookmarkAddCurrent, undefined, service, current);
  expect(result).toMatchObject({ ok: true, value: current() });
  expect(
    dispatchBrowserLibrary(IPC.BrowserBookmarkGetCurrent, undefined, service, current),
  ).toEqual(result);
  expect(
    dispatchBrowserLibrary(IPC.BrowserBookmarkAddCurrent, undefined, service, () => null),
  ).toMatchObject({ ok: false });
  expect(browserPageForLibrary({ url: 'file:///C:/secret', title: 'secret' })).toBeNull();
  expect(
    browserPageForLibrary({ url: 'https://name:secret@example.com/', title: 'secret' }),
  ).toBeNull();
  expect(
    browserPageForLibrary({ url: 'https://example.com/', title: '\u0000' + '中'.repeat(1100) })
      ?.title,
  ).toHaveLength(1000);
});
it('维护与关闭期间不读取或写入资料，状态仍可见', async () => {
  const service = store();
  expect(service.pauseForMaintenance(1)).toBe(true);
  await service.drainForMaintenance(1);
  const get = () => ({ url: 'https://example.com/', title: 'test' });
  expect(
    dispatchBrowserLibrary(IPC.BrowserBookmarkAddCurrent, undefined, service, get),
  ).toMatchObject({ ok: false, code: 'maintenance' });
  expect(dispatchBrowserLibrary(IPC.BrowserLibraryStatus, undefined, service, get)).toMatchObject({
    state: 'maintenance',
  });
  service.dispose();
  expect(dispatchBrowserLibrary(IPC.BrowserLibraryStatus, undefined, service, get)).toMatchObject({
    state: 'unavailable',
  });
});
