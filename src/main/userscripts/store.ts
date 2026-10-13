import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isUserScriptId, USER_SCRIPT_LIMITS } from '../../shared/userscripts';
import type { UserScriptSummary } from '../../shared/types/userscripts';
import { parseUserScript } from './metadata';

export interface StoredUserScript {
  summary: UserScriptSummary;
  source: string;
}

type StoreIo = Pick<
  typeof fs,
  | 'lstatSync'
  | 'fstatSync'
  | 'openSync'
  | 'closeSync'
  | 'mkdirSync'
  | 'writeFileSync'
  | 'fsyncSync'
  | 'renameSync'
  | 'unlinkSync'
> & {
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: null): number;
};
const MAX_STORE_BYTES = 12 * 1024 * 1024;
const LOAD_ERROR =
  '用户脚本配置无法读取或已被外部修改，原文件已保留；本次运行已停用脚本并拒绝覆盖。';
const SAVE_ERROR = '用户脚本无法保存，原设置保持不变。';

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function closed(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function digest(buffer: Buffer | null): string | null {
  return buffer === null ? null : createHash('sha256').update(buffer).digest('hex');
}

export function readBoundedRegularFile(path: string, maximum: number, io: StoreIo = fs): Buffer {
  const before = io.lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum)
    throw new Error('文件不是受支持的普通文件。');
  const descriptor = io.openSync(path, 'r');
  try {
    const opened = io.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs
    )
      throw new Error('文件在读取前已变化。');
    const buffer = Buffer.alloc(maximum + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = io.readSync(descriptor, buffer, total, buffer.length - total, null);
      if (count === 0) break;
      total += count;
    }
    const after = io.fstatSync(descriptor);
    const target = io.lstatSync(path);
    if (
      total > maximum ||
      total !== opened.size ||
      !target.isFile() ||
      target.isSymbolicLink() ||
      target.dev !== opened.dev ||
      target.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      target.size !== after.size ||
      target.mtimeMs !== after.mtimeMs
    )
      throw new Error('文件在读取期间已变化或超过预算。');
    return buffer.subarray(0, total);
  } finally {
    io.closeSync(descriptor);
  }
}

export function decodeUserScript(buffer: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function clone(entry: StoredUserScript): StoredUserScript {
  return { source: entry.source, summary: structuredClone(entry.summary) };
}

export class UserScriptStore {
  private readonly path: string;
  private scripts: StoredUserScript[] = [];
  private loadedDigest: string | null = null;
  private error: string | null = null;

  constructor(
    private readonly directory: string,
    private readonly io: StoreIo = fs,
  ) {
    this.path = join(directory, 'scripts.json');
    try {
      this.checkDirectory();
      const raw = this.readRaw();
      this.scripts = raw === null ? [] : this.decode(raw);
      this.loadedDigest = digest(raw);
    } catch {
      this.error = LOAD_ERROR;
    }
  }

  getError(): string | null {
    return this.error;
  }

  list(): StoredUserScript[] {
    return this.error === null ? this.scripts.map(clone) : [];
  }

  save(next: StoredUserScript[]): void {
    if (this.error !== null) throw new Error(SAVE_ERROR);
    let raw: Buffer;
    try {
      this.checkDirectory();
      if (digest(this.readRaw()) !== this.loadedDigest) throw new Error();
    } catch {
      this.error = LOAD_ERROR;
      throw new Error(SAVE_ERROR);
    }
    try {
      raw = Buffer.from(
        `${JSON.stringify({ version: 1, scripts: next.map((entry) => ({ id: entry.summary.id, enabled: entry.summary.enabled, installedAt: entry.summary.installedAt, sourceBase64: Buffer.from(entry.source, 'utf8').toString('base64') })) })}\n`,
        'utf8',
      );
      if (raw.length > MAX_STORE_BYTES) throw new Error();
      // Re-derive summaries from the exact persisted source; metadata is never trusted from callers.
      this.decode(raw);
    } catch {
      throw new Error(SAVE_ERROR);
    }
    const temporary = join(this.directory, `scripts.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let created = false;
    try {
      this.io.mkdirSync(this.directory, { recursive: true });
      this.checkDirectory();
      descriptor = this.io.openSync(temporary, 'wx', 0o600);
      created = true;
      this.io.writeFileSync(descriptor, raw);
      this.io.fsyncSync(descriptor);
      this.io.closeSync(descriptor);
      descriptor = undefined;
      // A second check also catches replacement during a slow write/fsync.
      this.checkDirectory();
      if (digest(this.readRaw()) !== this.loadedDigest) {
        this.error = LOAD_ERROR;
        throw new Error();
      }
      this.io.renameSync(temporary, this.path);
      this.scripts = this.decode(raw);
      this.loadedDigest = digest(raw);
    } catch {
      throw new Error(SAVE_ERROR);
    } finally {
      if (descriptor !== undefined) {
        try {
          this.io.closeSync(descriptor);
        } catch {
          /* Preserve the save failure. */
        }
      }
      if (created) {
        try {
          this.io.unlinkSync(temporary);
        } catch {
          /* Successful rename consumed the temporary file. */
        }
      }
    }
  }

  private checkDirectory(): void {
    try {
      const stat = this.io.lstatSync(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  private readRaw(): Buffer | null {
    try {
      return readBoundedRegularFile(this.path, MAX_STORE_BYTES, this.io);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  private decode(raw: Buffer): StoredUserScript[] {
    const parsed: unknown = JSON.parse(decodeUserScript(raw));
    if (
      !closed(parsed, ['version', 'scripts']) ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.scripts) ||
      parsed.scripts.length > USER_SCRIPT_LIMITS.count
    )
      throw new Error();
    const ids = new Set<string>();
    let total = 0;
    return parsed.scripts.map((value: unknown) => {
      if (
        !closed(value, ['id', 'enabled', 'installedAt', 'sourceBase64']) ||
        !isUserScriptId(value.id) ||
        ids.has(value.id) ||
        typeof value.enabled !== 'boolean' ||
        typeof value.installedAt !== 'string' ||
        value.installedAt.length !== 24 ||
        new Date(value.installedAt).toISOString() !== value.installedAt ||
        typeof value.sourceBase64 !== 'string' ||
        value.sourceBase64.length > Math.ceil(USER_SCRIPT_LIMITS.sourceBytes / 3) * 4
      )
        throw new Error();
      const bytes = Buffer.from(value.sourceBase64, 'base64');
      if (
        bytes.toString('base64') !== value.sourceBase64 ||
        bytes.length > USER_SCRIPT_LIMITS.sourceBytes
      )
        throw new Error();
      const source = decodeUserScript(bytes);
      const metadata = parseUserScript(source);
      if (!metadata.ok) throw new Error();
      total += bytes.length;
      if (total > USER_SCRIPT_LIMITS.totalSourceBytes) throw new Error();
      ids.add(value.id);
      return {
        source,
        summary: {
          ...metadata.value,
          id: value.id,
          enabled: value.enabled,
          sourceBytes: bytes.length,
          installedAt: value.installedAt,
        },
      };
    });
  }
}
