import { lstat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { logInfo, logWarn } from '../logger';
import type { IdmToolResult, IdmToolStatus } from '../../shared/types/downloads';

const MAX_IDM_URL_LENGTH = 4096;
const HANDOFF_TIMEOUT_MS = 2_000;
const IDM_EXECUTABLE_CANDIDATES = Object.freeze([
  'C:\\Program Files\\Internet Download Manager\\IDMan.exe',
  'C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe',
]);

const INVALID_URL: IdmToolResult = {
  ok: false,
  code: 'invalid-url',
  message: '仅支持不含凭据的 HTTP(S) 下载链接',
};
const UNAVAILABLE: IdmToolResult = {
  ok: false,
  code: 'unavailable',
  message: '未检测到 Internet Download Manager',
};
const BUSY: IdmToolResult = {
  ok: false,
  code: 'busy',
  message: '已有 IDM 请求正在发送，请稍后再试',
};
const FAILED: IdmToolResult = {
  ok: false,
  code: 'failed',
  message: '无法将下载请求发送到 Internet Download Manager',
};
const CLOSED: IdmToolResult = {
  ok: false,
  code: 'closed',
  message: 'IDM 下载服务已关闭',
};

type SpawnIdm = (
  executable: string,
  args: readonly string[],
  options: Readonly<SpawnOptions>,
) => ChildProcess;

interface IdmDownloadServiceDependencies {
  isExecutableFile?: (candidate: string) => Promise<boolean>;
  spawnIdm?: SpawnIdm;
  handoffTimeoutMs?: number;
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    return (await lstat(candidate)).isFile();
  } catch {
    return false;
  }
}

function spawnIdm(
  executable: string,
  args: readonly string[],
  options: Readonly<SpawnOptions>,
): ChildProcess {
  const child = spawn(executable, [...args], options);
  // A handoff may be cancelled during shutdown before Node reports a late
  // launch failure. Keep that failure from becoming an unhandled EventEmitter
  // error after the service has removed its own bounded-wait listeners.
  child.once('error', () => {});
  return child;
}

function guardAllows(isCurrent: () => boolean): boolean {
  try {
    return isCurrent() === true;
  } catch {
    return false;
  }
}

/**
 * Accept an explicit HTTP(S) URL only. This function never coerces objects and
 * therefore cannot invoke attacker-controlled getters or toString methods.
 */
export function normalizeIdmUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDM_URL_LENGTH ||
    value !== value.trim() ||
    /\s/u.test(value) ||
    /[\p{Cc}\p{Cf}]/u.test(value) ||
    value.includes('\\') ||
    !/^https?:\/\//iu.test(value)
  ) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname === ''
  ) {
    return null;
  }

  const normalized = parsed.toString();
  return normalized.length <= MAX_IDM_URL_LENGTH ? normalized : null;
}

/** Main-process-only handoff to a locally installed IDM executable. */
export class IdmDownloadService {
  private readonly fileCheck: (candidate: string) => Promise<boolean>;
  private readonly launch: SpawnIdm;
  private readonly timeoutMs: number;
  private closed = false;
  private busy = false;
  private cancelPending: (() => void) | null = null;

  constructor(dependencies: IdmDownloadServiceDependencies = {}) {
    this.fileCheck = dependencies.isExecutableFile ?? isExecutableFile;
    this.launch = dependencies.spawnIdm ?? spawnIdm;
    this.timeoutMs = Math.max(1, dependencies.handoffTimeoutMs ?? HANDOFF_TIMEOUT_MS);
  }

  async getStatus(): Promise<IdmToolStatus> {
    if (this.closed) return { available: false };
    return { available: (await this.findExecutable()) !== null && !this.closed };
  }

  async send(value: unknown, isCurrent: () => boolean = () => true): Promise<IdmToolResult> {
    if (this.closed || !guardAllows(isCurrent)) return CLOSED;
    const url = normalizeIdmUrl(value);
    if (url === null) return INVALID_URL;
    if (this.busy) return BUSY;

    this.busy = true;
    try {
      const executable = await this.findExecutable(isCurrent);
      if (this.closed || !guardAllows(isCurrent)) return CLOSED;
      if (executable === null) {
        logWarn('idm-download', '未检测到可用的 IDM 默认安装程序');
        return UNAVAILABLE;
      }

      let child: ChildProcess;
      try {
        if (this.closed || !guardAllows(isCurrent)) return CLOSED;
        child = this.launch(executable, ['/d', url], {
          shell: false,
          stdio: 'ignore',
          windowsHide: false,
        });
      } catch {
        logWarn('idm-download', 'IDM 下载请求启动失败');
        return FAILED;
      }

      const result = await this.waitForHandoff(child);
      if (this.closed || !guardAllows(isCurrent)) return CLOSED;
      if (!result.ok) logWarn('idm-download', 'IDM 下载请求交接失败');
      else logInfo('idm-download', '已将下载请求发送到 IDM，等待用户在 IDM 中确认');
      return result;
    } finally {
      this.cancelPending = null;
      this.busy = false;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelPending?.();
    this.cancelPending = null;
  }

  private async findExecutable(isCurrent: () => boolean = () => true): Promise<string | null> {
    for (const candidate of IDM_EXECUTABLE_CANDIDATES) {
      let exists: boolean;
      try {
        exists = await this.fileCheck(candidate);
      } catch {
        exists = false;
      }
      if (this.closed || !guardAllows(isCurrent)) return null;
      if (exists) return candidate;
    }
    return null;
  }

  private waitForHandoff(child: ChildProcess): Promise<IdmToolResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: IdmToolResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
        child.removeListener('exit', onExit);
        if (this.cancelPending === cancel) this.cancelPending = null;
        resolve(result);
      };
      const onSpawn = (): void => {
        child.unref();
        finish({ ok: true });
      };
      const onError = (): void => finish(FAILED);
      const onExit = (): void => finish(FAILED);
      const cancel = (): void => {
        child.unref();
        finish(CLOSED);
      };
      const timer = setTimeout(() => {
        child.unref();
        finish(FAILED);
      }, this.timeoutMs);
      this.cancelPending = cancel;
      child.once('spawn', onSpawn);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  }
}
