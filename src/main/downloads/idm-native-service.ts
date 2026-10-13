import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { IdmToolResult, IdmToolStatus } from '../../shared/types/downloads';
import { normalizeIdmUrl } from './idm-service';

export interface IdmDownloadMetadata {
  readonly url: string;
  readonly referer: string;
  readonly cookie: string;
  readonly filename: string;
  readonly userAgent: string;
}

export interface IdmHelperIdentity {
  readonly helperPath: string;
  readonly expectedSha256: string;
  readonly expectedBytes: number;
}

type SpawnHelper = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
interface Dependencies {
  readonly isExecutableFile?: (file: string) => Promise<boolean>;
  readonly verifyHelper?: (identity: IdmHelperIdentity) => Promise<boolean>;
  readonly spawnHelper?: SpawnHelper;
  readonly timeoutMs?: number;
}

const FIELDS = ['url', 'referer', 'cookie', 'filename', 'userAgent'] as const;
const LIMITS = [12288, 12288, 16384, 768, 2048] as const;
const EXECUTABLES = [
  'C:\\Program Files\\Internet Download Manager\\IDMan.exe',
  'C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe',
];
const FAILED: IdmToolResult = { ok: false, code: 'failed', message: '无法在 IDM 中打开下载窗口' };
const CLOSED: IdmToolResult = { ok: false, code: 'closed', message: '下载操作已失效或服务已关闭' };
const BUSY: IdmToolResult = {
  ok: false,
  code: 'busy',
  message: '已有 IDM 请求正在发送，请稍后再试',
};
const UNAVAILABLE: IdmToolResult = {
  ok: false,
  code: 'unavailable',
  message: '未检测到可用的 IDM 或下载组件',
};

function allowed(check: () => boolean): boolean {
  try {
    return check() === true;
  } catch {
    return false;
  }
}

/** Closed, immutable fields; no caller-controlled getters are evaluated. */
export function normalizeIdmMetadata(value: unknown): IdmDownloadMetadata | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== FIELDS.length ||
    keys.some((key) => !FIELDS.includes(key as (typeof FIELDS)[number]))
  )
    return null;
  const values: string[] = [];
  for (const [index, field] of FIELDS.entries()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    const text: unknown = descriptor?.value;
    if (
      typeof text !== 'string' ||
      Buffer.from(text).toString('utf8') !== text ||
      /[\p{Cc}\p{Cf}]/u.test(text) ||
      Buffer.byteLength(text) > LIMITS[index]!
    )
      return null;
    values.push(text);
  }
  const [rawUrl, rawReferer, cookie, filename, userAgent] = values as [
    string,
    string,
    string,
    string,
    string,
  ];
  const url = normalizeIdmUrl(rawUrl);
  const referer = rawReferer === '' ? '' : normalizeIdmUrl(rawReferer);
  if (
    url === null ||
    referer === null ||
    filename.length > 255 ||
    /[<>:"/\\|?*]/u.test(filename) ||
    /[. ]$/u.test(filename) ||
    /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/iu.test(filename) ||
    filename === '.' ||
    filename === '..'
  )
    return null;
  return Object.freeze({ url, referer, cookie, filename, userAgent });
}

/** Five length-prefixed UTF-8 fields; never a command line or script. */
export function encodeIdmHandoff(metadata: IdmDownloadMetadata): Buffer {
  const chunks: Buffer[] = [Buffer.from('IDM1')];
  for (const field of FIELDS) {
    const data = Buffer.from(metadata[field]);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(data.length);
    chunks.push(length, data);
  }
  return Buffer.concat(chunks);
}

async function regularFile(file: string): Promise<boolean> {
  try {
    return (await lstat(file)).isFile();
  } catch {
    return false;
  }
}

export async function verifyIdmHelper(identity: IdmHelperIdentity): Promise<boolean> {
  try {
    if (
      !/^[a-f0-9]{64}$/u.test(identity.expectedSha256) ||
      !Number.isSafeInteger(identity.expectedBytes) ||
      identity.expectedBytes < 1 ||
      identity.expectedBytes > 512 * 1024
    )
      return false;
    const before = await lstat(identity.helperPath);
    if (!before.isFile() || before.size !== identity.expectedBytes) return false;
    const bytes = await readFile(identity.helperPath);
    const after = await lstat(identity.helperPath);
    return (
      after.isFile() &&
      before.ino === after.ino &&
      before.size === after.size &&
      before.mtimeMs === after.mtimeMs &&
      bytes.length === identity.expectedBytes &&
      createHash('sha256').update(bytes).digest('hex') === identity.expectedSha256
    );
  } catch {
    return false;
  }
}

/** Main-only COM handoff. Sensitive fields exist only in bounded memory/stdin. */
export class IdmNativeDownloadService {
  private readonly identity: IdmHelperIdentity;
  private readonly fileCheck: (file: string) => Promise<boolean>;
  private readonly verify: (identity: IdmHelperIdentity) => Promise<boolean>;
  private readonly launch: SpawnHelper;
  private readonly timeoutMs: number;
  private closed = false;
  private busy = false;
  private cancel: (() => void) | null = null;

  constructor(identity: IdmHelperIdentity, dependencies: Dependencies = {}) {
    this.identity = Object.freeze({ ...identity });
    this.fileCheck = dependencies.isExecutableFile ?? regularFile;
    this.verify = dependencies.verifyHelper ?? verifyIdmHelper;
    this.launch =
      dependencies.spawnHelper ?? ((file, args, options) => spawn(file, [...args], options));
    this.timeoutMs = Math.max(1, Math.min(15000, dependencies.timeoutMs ?? 10000));
  }

  async getStatus(): Promise<IdmToolStatus> {
    return { available: !this.closed && (await this.available(() => true)) && !this.closed };
  }

  async send(value: unknown, isCurrent: () => boolean = () => true): Promise<IdmToolResult> {
    if (this.closed || !allowed(isCurrent)) return CLOSED;
    const metadata = normalizeIdmMetadata(value);
    if (!metadata) return { ok: false, code: 'invalid-url', message: '下载地址或元数据不受支持' };
    if (this.busy) return BUSY;
    this.busy = true;
    try {
      const available = await this.available(isCurrent);
      if (this.closed || !allowed(isCurrent)) return CLOSED;
      if (!available) return UNAVAILABLE;
      let child: ChildProcess;
      try {
        child = this.launch(this.identity.helperPath, [], {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {
        return FAILED;
      }
      // Keep late launch errors handled after bounded cancellation.
      child.on('error', () => {});
      return await this.wait(child, metadata, isCurrent);
    } catch {
      return FAILED;
    } finally {
      this.busy = false;
      this.cancel = null;
    }
  }

  dispose(): void {
    this.closed = true;
    this.cancel?.();
    this.cancel = null;
  }

  private async available(isCurrent: () => boolean): Promise<boolean> {
    for (const executable of EXECUTABLES) {
      const exists = await this.fileCheck(executable);
      if (this.closed || !allowed(isCurrent)) return false;
      if (exists) return this.verify(this.identity);
    }
    return false;
  }

  private wait(
    child: ChildProcess,
    metadata: IdmDownloadMetadata,
    isCurrent: () => boolean,
  ): Promise<IdmToolResult> {
    return new Promise((resolve) => {
      let settled = false;
      let output = '';
      const finish = (result: IdmToolResult, terminate: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(leaseTimer);
        if (terminate) {
          try {
            child.kill();
          } catch {
            /* Only this helper is owned. */
          }
        }
        child.stdout?.removeListener('data', onData);
        child.removeListener('close', onClose);
        child.removeListener('error', onError);
        this.cancel = null;
        resolve(result);
      };
      const onData = (data: Buffer): void => {
        if (output.length + data.length > 16) return finish(FAILED, true);
        output += data.toString('ascii');
      };
      const onError = (): void => finish(FAILED, true);
      const onClose = (code: number | null): void =>
        finish(
          this.closed || !allowed(isCurrent)
            ? CLOSED
            : code === 0 && output === 'OK\n'
              ? { ok: true }
              : FAILED,
          false,
        );
      const timer = setTimeout(() => finish(FAILED, true), this.timeoutMs);
      const leaseTimer = setInterval(() => {
        if (this.closed || !allowed(isCurrent)) finish(CLOSED, true);
      }, 50);
      this.cancel = () => finish(CLOSED, true);
      child.stdout?.on('data', onData);
      child.once('close', onClose);
      child.once('error', onError);
      if (!child.stdin || !child.stdout || this.closed || !allowed(isCurrent))
        return finish(CLOSED, true);
      child.stdin.on('error', onError);
      const encoded = encodeIdmHandoff(metadata);
      try {
        child.stdin.end(encoded, () => encoded.fill(0));
      } catch {
        encoded.fill(0);
        finish(FAILED, true);
      }
    });
  }
}
