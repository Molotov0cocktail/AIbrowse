import { randomUUID } from 'node:crypto';
import type { DbHandle } from '../sources/db/sqlite-driver';
import { MaintenanceAdmission } from '../storage/maintenance-admission';
import {
  isBrowserBookmarkInput,
  isBrowserBookmarkListRequest,
  isBrowserBookmarkGroupInput,
  isBrowserBookmarkUpdate,
  isBrowserLibraryId,
  isBrowserLibraryListRequest,
  isBrowserLibraryTime,
  normalizeBrowserLibraryUrl,
} from '../../shared/browser-library';
import type {
  BrowserBookmark,
  BrowserBookmarkListRequest,
  BrowserBookmarkGroup,
  BrowserBookmarkGroupInput,
  BrowserBookmarkInput,
  BrowserBookmarkUpdate,
  BrowserHistoryEntry,
  BrowserLibraryListRequest,
  BrowserLibraryPage,
  BrowserLibraryResult,
  BrowserLibraryStatus,
  BrowserVisitTitleUpdate,
} from '../../shared/types/browser-library';
import {
  BrowserLibraryRepository,
  BrowserBookmarkCapacityError,
} from './browser-library-repository';

const errors = {
  'invalid-input': '浏览数据请求无效',
  unavailable: '浏览历史与书签暂不可用',
  maintenance: '数据维护期间暂不可操作浏览历史与书签',
  'not-found': '记录已不存在，请刷新列表',
  'storage-error': '浏览数据保存或读取失败，部分新访问可能未保存；请检查本地数据',
} as const;

export class BrowserLibraryService {
  private readonly repository: BrowserLibraryRepository;
  private readonly admission = new MaintenanceAdmission();
  private storageError = false;

  constructor(
    private readonly db: DbHandle,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.repository = new BrowserLibraryRepository(db);
  }

  isOpen(): boolean {
    return this.db.isOpen;
  }

  getStatus(): BrowserLibraryStatus {
    if (!this.isOpen()) return { state: 'unavailable', message: errors.unavailable };
    if (!this.admission.isOpen()) return { state: 'maintenance', message: errors.maintenance };
    if (this.storageError) return { state: 'storage-error', message: errors['storage-error'] };
    return { state: 'available', message: '历史持续保留，直到手动删除或清空' };
  }

  private run<T>(valid: boolean, work: () => T): BrowserLibraryResult<T> {
    if (!valid) return { ok: false, code: 'invalid-input', message: errors['invalid-input'] };
    if (!this.db.isOpen) return { ok: false, code: 'unavailable', message: errors.unavailable };
    const release = this.admission.enter();
    if (release === null) return { ok: false, code: 'maintenance', message: errors.maintenance };
    try {
      return { ok: true, value: work() };
    } catch (error) {
      if (error instanceof BrowserBookmarkCapacityError)
        return {
          ok: false,
          code: 'invalid-input',
          message: '最多保存 100 个书签分组，请先移出或删除不再需要的成员',
        };
      this.storageError = true;
      return { ok: false, code: 'storage-error', message: errors['storage-error'] };
    } finally {
      release();
    }
  }

  private time(): string {
    const now = this.now();
    if (!isBrowserLibraryTime(now)) throw new Error('浏览数据时间无效');
    return now;
  }

  listHistory(
    request: BrowserLibraryListRequest,
  ): BrowserLibraryResult<BrowserLibraryPage<BrowserHistoryEntry>> {
    return this.run(isBrowserLibraryListRequest(request), () =>
      this.repository.listHistory(request),
    );
  }

  recordNavigation(input: BrowserBookmarkInput): BrowserLibraryResult<BrowserHistoryEntry> {
    return this.run(isBrowserBookmarkInput(input), () =>
      this.repository.recordNavigation(
        { ...input, url: normalizeBrowserLibraryUrl(input.url)! },
        randomUUID(),
        this.time(),
      ),
    );
  }

  updateVisitTitle(input: BrowserVisitTitleUpdate): BrowserLibraryResult<boolean> {
    return this.run(isBrowserBookmarkUpdate(input), () =>
      this.repository.updateVisitTitle({ ...input, url: normalizeBrowserLibraryUrl(input.url)! }),
    );
  }

  deleteHistory(id: string): BrowserLibraryResult<boolean> {
    return this.run(isBrowserLibraryId(id), () => this.repository.deleteHistory(id));
  }

  clearHistory(): BrowserLibraryResult<boolean> {
    return this.run(true, () => this.repository.clearHistory());
  }

  listBookmarkGroups(): BrowserLibraryResult<BrowserBookmarkGroup[]> {
    return this.run(true, () => this.repository.listBookmarkGroups());
  }
  saveBookmarkGroup(input: BrowserBookmarkGroupInput): BrowserLibraryResult<BrowserBookmarkGroup> {
    return this.run(isBrowserBookmarkGroupInput(input), () =>
      this.repository.saveBookmarkGroup(
        {
          name: input.name.trim(),
          color: input.color,
          bookmarks: input.bookmarks.map((item) => ({
            title: item.title,
            url: normalizeBrowserLibraryUrl(item.url)!,
          })),
        },
        this.time(),
      ),
    );
  }
  listBookmarks(
    request: BrowserBookmarkListRequest,
  ): BrowserLibraryResult<BrowserLibraryPage<BrowserBookmark>> {
    return this.run(isBrowserBookmarkListRequest(request), () =>
      this.repository.listBookmarks(request),
    );
  }

  getBookmarkForUrl(url: string): BrowserLibraryResult<BrowserBookmark | null> {
    const normalized = normalizeBrowserLibraryUrl(url);
    return this.run(normalized !== null, () => this.repository.getBookmarkForUrl(normalized!));
  }

  addBookmark(input: BrowserBookmarkInput): BrowserLibraryResult<BrowserBookmark> {
    return this.run(isBrowserBookmarkInput(input), () =>
      this.repository.addBookmark(
        { ...input, url: normalizeBrowserLibraryUrl(input.url)! },
        randomUUID(),
        this.time(),
      ),
    );
  }

  updateBookmark(input: BrowserBookmarkUpdate): BrowserLibraryResult<BrowserBookmark | null> {
    return this.run(isBrowserBookmarkUpdate(input), () =>
      this.repository.updateBookmark(
        { ...input, url: normalizeBrowserLibraryUrl(input.url)! },
        this.time(),
      ),
    );
  }

  removeBookmark(id: string): BrowserLibraryResult<boolean> {
    return this.run(isBrowserLibraryId(id), () => this.repository.removeBookmark(id));
  }
  pauseForMaintenance(generation: number): boolean {
    return this.admission.pauseForMaintenance(generation);
  }
  drainForMaintenance(generation: number): Promise<void> {
    return this.admission.drainForMaintenance(generation);
  }
  prepareResumeAfterMaintenance(generation: number): boolean {
    return this.isOpen() && this.admission.prepareResumeAfterMaintenance(generation);
  }
  resumeAfterMaintenance(generation: number): boolean {
    return this.isOpen() && this.admission.resumeAfterMaintenance(generation);
  }
  dispose(): void {
    this.admission.beginShutdown();
    this.db.close();
  }
}
