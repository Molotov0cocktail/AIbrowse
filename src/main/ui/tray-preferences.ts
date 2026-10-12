import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

type PreferencesFileSystem = Pick<
  typeof fs,
  | 'lstatSync'
  | 'openSync'
  | 'readSync'
  | 'closeSync'
  | 'writeFileSync'
  | 'fsyncSync'
  | 'renameSync'
  | 'unlinkSync'
>;

const MAX_BYTES = 1024;
const LOAD_ERROR = '应用偏好无法读取，原文件已保留。';
const SAVE_ERROR = '应用偏好无法保存，原设置保持不变。';

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export class TrayPreferences {
  private readonly path: string;
  private enabled = false;
  private loadError: string | null = null;

  constructor(
    userDataPath: string,
    private readonly io: PreferencesFileSystem = fs,
  ) {
    this.path = join(userDataPath, 'app-preferences.json');
    try {
      this.enabled = this.read();
    } catch {
      this.loadError = LOAD_ERROR;
    }
  }

  getEnabled(): boolean {
    return this.enabled;
  }

  getLoadError(): string | null {
    return this.loadError;
  }

  saveEnabled(enabled: boolean): void {
    if (this.loadError !== null || typeof enabled !== 'boolean') throw new Error(SAVE_ERROR);
    // Revalidate before replacement so a new unsupported file is not overwritten.
    try {
      this.read();
    } catch {
      this.loadError = LOAD_ERROR;
      throw new Error(SAVE_ERROR);
    }
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = this.io.openSync(temporary, 'wx', 0o600);
      created = true;
      this.io.writeFileSync(
        descriptor,
        `${JSON.stringify({ version: 1, runInTray: enabled })}\n`,
        'utf8',
      );
      this.io.fsyncSync(descriptor);
      this.io.closeSync(descriptor);
      descriptor = undefined;
      this.io.renameSync(temporary, this.path);
      this.enabled = enabled;
    } catch {
      throw new Error(SAVE_ERROR);
    } finally {
      if (descriptor !== undefined) {
        try {
          this.io.closeSync(descriptor);
        } catch {
          /* Preserve the original save failure. */
        }
      }
      if (created) {
        try {
          this.io.unlinkSync(temporary);
        } catch {
          /* The atomic rename normally consumed this file. */
        }
      }
    }
  }

  private read(): boolean {
    try {
      const stat = this.io.lstatSync(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error();
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
    const descriptor = this.io.openSync(this.path, 'r');
    let raw: string;
    try {
      // Bound allocation and reading even if the file changes after lstat.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const count = this.io.readSync(descriptor, buffer, total, buffer.length - total, null);
        if (count === 0) break;
        total += count;
      }
      if (total > MAX_BYTES) throw new Error();
      raw = buffer.toString('utf8', 0, total);
    } finally {
      this.io.closeSync(descriptor);
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    const object = parsed as Record<string, unknown>;
    if (
      Object.keys(object).length !== 2 ||
      object.version !== 1 ||
      typeof object.runInTray !== 'boolean'
    ) {
      throw new Error();
    }
    return object.runInTray;
  }
}
