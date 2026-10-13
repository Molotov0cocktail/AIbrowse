import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  isUserScriptIdentifier,
  isUserScriptToggle,
  USER_SCRIPT_LIMITS,
} from '../../shared/userscripts';
import type { UserScriptResult, UserScriptSummary } from '../../shared/types/userscripts';
import { parseUserScript } from './metadata';
import {
  decodeUserScript,
  readBoundedRegularFile,
  UserScriptStore,
  type StoredUserScript,
} from './store';

export interface UserScriptServiceOptions {
  storeDirectory: string;
  dialogs: {
    chooseFile(): Promise<string | null>;
    confirmImport(summary: UserScriptSummary): Promise<boolean>;
  };
}

export class UserScriptService {
  private readonly store: UserScriptStore;
  private disposed = false;
  private importing = false;

  constructor(private readonly options: UserScriptServiceOptions) {
    this.store = new UserScriptStore(options.storeDirectory);
  }

  list(): UserScriptResult<UserScriptSummary[]> {
    const error = this.unavailable();
    return error ?? { ok: true, value: this.store.list().map((entry) => entry.summary) };
  }

  getEnabledScripts(): StoredUserScript[] {
    return this.disposed ? [] : this.store.list().filter((entry) => entry.summary.enabled);
  }

  async importScript(
    isCurrent: () => boolean,
  ): Promise<UserScriptResult<UserScriptSummary | null>> {
    const error = this.unavailable();
    if (error !== null) return error;
    if (this.importing)
      return { ok: false, code: 'unavailable', message: '已有脚本导入窗口，请先完成或取消。' };
    if (!isCurrent()) return this.stale();
    this.importing = true;
    try {
      const path = await this.options.dialogs.chooseFile();
      if (this.disposed || !isCurrent()) return this.stale();
      if (path === null) return { ok: true, value: null };
      if (!isAbsolute(path) || !path.toLowerCase().endsWith('.user.js'))
        return { ok: false, code: 'invalid-input', message: '请选择本地 .user.js 用户脚本文件。' };
      let source: string;
      try {
        source = decodeUserScript(readBoundedRegularFile(path, USER_SCRIPT_LIMITS.sourceBytes));
      } catch {
        return {
          ok: false,
          code: 'invalid-input',
          message: '脚本无法读取：必须是未变化的 UTF-8 普通文件，且不超过 256 KiB。',
        };
      }
      const parsed = parseUserScript(source);
      if (!parsed.ok) return parsed;
      const candidate: StoredUserScript = {
        source,
        summary: {
          ...parsed.value,
          id: randomUUID(),
          enabled: true,
          sourceBytes: Buffer.byteLength(source, 'utf8'),
          installedAt: new Date().toISOString(),
        },
      };
      const before = this.installationError(candidate);
      if (before !== null) return before;
      const confirmed = await this.options.dialogs.confirmImport(
        structuredClone(candidate.summary),
      );
      if (this.disposed || !isCurrent()) return this.stale();
      if (!confirmed) return { ok: true, value: null };
      const after = this.installationError(candidate);
      if (after !== null) return after;
      return this.save([...this.store.list(), candidate], candidate.summary);
    } catch {
      return { ok: false, code: 'unavailable', message: '无法完成脚本导入，请稍后重试。' };
    } finally {
      this.importing = false;
    }
  }

  setEnabled(input: unknown): UserScriptResult<UserScriptSummary> {
    if (!isUserScriptToggle(input))
      return { ok: false, code: 'invalid-input', message: '脚本开关参数无效。' };
    const error = this.unavailable();
    if (error !== null) return error;
    const scripts = this.store.list();
    const entry = scripts.find((item) => item.summary.id === input.id);
    if (entry === undefined) return { ok: false, code: 'not-found', message: '脚本不存在。' };
    entry.summary.enabled = input.enabled;
    return this.save(scripts, entry.summary);
  }

  remove(input: unknown): UserScriptResult<null> {
    if (!isUserScriptIdentifier(input))
      return { ok: false, code: 'invalid-input', message: '脚本删除参数无效。' };
    const error = this.unavailable();
    if (error !== null) return error;
    const scripts = this.store.list();
    if (!scripts.some((entry) => entry.summary.id === input.id))
      return { ok: false, code: 'not-found', message: '脚本不存在。' };
    return this.save(
      scripts.filter((entry) => entry.summary.id !== input.id),
      null,
    );
  }

  dispose(): void {
    this.disposed = true;
  }

  private unavailable(): UserScriptResult<never> | null {
    if (this.disposed) return { ok: false, code: 'unavailable', message: '脚本管理已关闭。' };
    const message = this.store.getError();
    return message === null ? null : { ok: false, code: 'storage-error', message };
  }

  private stale(): UserScriptResult<never> {
    return { ok: false, code: 'stale', message: '设置页面已关闭或更新，本次导入未保存。' };
  }

  private installationError(candidate: StoredUserScript): UserScriptResult<never> | null {
    const error = this.unavailable();
    if (error !== null) return error;
    const scripts = this.store.list();
    if (
      scripts.length >= USER_SCRIPT_LIMITS.count ||
      scripts.reduce(
        (sum, entry) => sum + entry.summary.sourceBytes,
        candidate.summary.sourceBytes,
      ) > USER_SCRIPT_LIMITS.totalSourceBytes
    )
      return {
        ok: false,
        code: 'limit-exceeded',
        message: '最多保存 50 个脚本，源码总量不得超过 8 MiB。',
      };
    if (scripts.some((entry) => entry.source === candidate.source))
      return { ok: false, code: 'invalid-input', message: '相同脚本已经安装，请在列表中启用。' };
    return null;
  }

  private save<T>(scripts: StoredUserScript[], value: T): UserScriptResult<T> {
    try {
      this.store.save(scripts);
      return { ok: true, value: structuredClone(value) };
    } catch {
      return {
        ok: false,
        code: 'storage-error',
        message: this.store.getError() ?? '用户脚本无法保存，原设置保持不变。',
      };
    }
  }
}
