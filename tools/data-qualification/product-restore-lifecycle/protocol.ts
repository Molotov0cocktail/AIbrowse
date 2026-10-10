import { spawn } from 'node:child_process';
import { lstat, open } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { parseBoundedJson } from '../../../src/main/storage/bounded-json.ts';
import { verifyProfileIsolationJournal } from '../../release/profile-isolation-policy.ts';
import { decodeLedger, identity, sha256 } from '../product-restore-process/protocol.ts';
import type { Identity, Transport } from '../product-restore-process/protocol.ts';

function need(value: unknown): asserts value {
  if (!value) throw new Error('普通退出身份或证据不一致');
}
function obj(value: unknown, keys: string[]): Record<string, unknown> {
  need(typeof value === 'object' && value !== null && !Array.isArray(value));
  const v = value as Record<string, unknown>;
  need(Object.keys(v).length === keys.length && Object.keys(v).every((key) => keys.includes(key)));
  return v;
}
function str(value: unknown): string {
  need(typeof value === 'string' && value.length > 0 && value.length <= 32768);
  return value;
}
function hex(value: unknown, length = 64): string {
  const v = str(value);
  need(new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(v));
  return v;
}
function num(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  need(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max);
  return value;
}
function json(bytes: Buffer, max: number): unknown {
  need(bytes.length > 0 && bytes.length <= max);
  return parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), {
    bytes: max,
    depth: 12,
    nodes: 8192,
  });
}
function same(a: Identity, b: Identity): boolean {
  return (
    a.pid === b.pid && a.created === b.created && a.image.toLowerCase() === b.image.toLowerCase()
  );
}
export interface Held extends Identity {
  imageIdentity: string;
  parentPid: number;
  role: 'main' | 'guardian';
  session: string | null;
  signaled: boolean;
  exitCode: number | null;
  exitFileTime: string | null;
}
function held(value: unknown): Held {
  const v = obj(value, [
    'pid',
    'created',
    'image',
    'imageIdentity',
    'parentPid',
    'role',
    'session',
    'signaled',
    'exitCode',
    'exitFileTime',
  ]);
  need(v.role === 'main' || v.role === 'guardian');
  need(typeof v.signaled === 'boolean');
  const id = identity({ pid: v.pid, created: v.created, image: v.image });
  const exited = v.exitFileTime === null ? null : str(v.exitFileTime);
  if (exited !== null)
    need(
      /^[1-9][0-9]{0,18}$/u.test(exited) &&
        BigInt(exited) >= BigInt(id.created) &&
        BigInt(exited) <= 9223372036854775807n,
    );
  need(v.signaled ? v.exitCode === 0 && exited !== null : v.exitCode === null && exited === null);
  need(v.role === 'guardian' ? v.session !== null : v.session === null);
  return {
    ...id,
    imageIdentity: hex(v.imageIdentity),
    parentPid: num(v.parentPid, 1, 4294967295),
    role: v.role,
    session: v.session === null ? null : hex(v.session, 32),
    signaled: v.signaled,
    exitCode: v.exitCode === null ? null : num(v.exitCode, 0, 4294967295),
    exitFileTime: exited,
  };
}
export interface Scope {
  runId: string;
  initial: Identity;
  manifestSha256: string;
  markerSha256: string;
  bindingSha256: string;
  executableSha256: string;
  guardianSha256: string;
  fileId128: string;
  volumeSerial64: string;
}
function pair(main: Held, guardian: Held, initial: Identity): void {
  need(main.role === 'main' && guardian.role === 'guardian' && same(main, initial));
  need(
    guardian.pid !== main.pid &&
      guardian.parentPid === main.pid &&
      BigInt(guardian.created) >= BigInt(main.created),
  );
  need(
    guardian.image.toLowerCase() ===
      win32
        .join(win32.dirname(main.image), 'resources', 'lifecycle-guardian', 'guardian.exe')
        .toLowerCase(),
  );
}
export function verifyRetired(
  bytes: Buffer,
  scope: Scope,
  readyMain: Held,
  readyGuardian: Held,
  expectedSha: string,
): void {
  need(sha256(bytes) === expectedSha);
  const v = obj(json(bytes, 65536), [
    'version',
    'runId',
    'initial',
    'elapsedMs',
    'budgetMs',
    'manifestSha256',
    'markerSha256',
    'bindingSha256',
    'executableSha256',
    'guardianSha256',
    'profile',
    'limits',
    'main',
    'guardian',
    'ledger',
    'ledgerSha256',
    'members',
  ]);
  need(v.version === 1 && v.runId === scope.runId && same(identity(v.initial), scope.initial));
  for (const key of [
    'manifestSha256',
    'markerSha256',
    'bindingSha256',
    'executableSha256',
    'guardianSha256',
  ] as const)
    need(v[key] === scope[key]);
  need(num(v.elapsedMs) < num(v.budgetMs, 1, 30000));
  const profile = obj(v.profile, ['fileId128', 'volumeSerial64', 'guardianRootHash']);
  need(profile.fileId128 === scope.fileId128 && profile.volumeSerial64 === scope.volumeSerial64);
  hex(profile.guardianRootHash);
  const limits = obj(v.limits, ['flags', 'total', 'held', 'records', 'bytes']);
  need(limits.flags === 0x2008 && limits.total === 24);
  num(limits.held, 2, 128);
  num(limits.records, 0, 512);
  num(limits.bytes, 0, 2097152);
  const main = held(v.main),
    guardian = held(v.guardian);
  pair(main, guardian, scope.initial);
  need(main.signaled && guardian.signaled);
  for (const [now, before] of [
    [main, readyMain],
    [guardian, readyGuardian],
  ]) {
    need(
      now &&
        before &&
        same(now, before) &&
        now.imageIdentity === before.imageIdentity &&
        now.parentPid === before.parentPid &&
        now.session === before.session,
    );
  }
  const ledger = decodeLedger(v.ledger);
  hex(v.ledgerSha256);
  need(
    ledger.root === profile.guardianRootHash &&
      ledger.session === guardian.session &&
      ledger.main === null &&
      ledger.utility === null,
  );
  need(Array.isArray(v.members) && v.members.length >= 1 && v.members.length <= 4);
  const pids = new Set<number>();
  for (const member of v.members) {
    const m = obj(member, ['pid', 'created', 'role']);
    const id = identity({ pid: m.pid, created: m.created, image: scope.initial.image });
    need(m.role === 'tool' && !pids.has(id.pid) && id.pid !== main.pid && id.pid !== guardian.pid);
    pids.add(id.pid);
  }
}

export interface LeasePorts {
  transport: Transport;
  readReceipt(): Promise<Buffer>;
  now(): number;
  deadline: number;
  stop(): void;
  initialFrame?: string;
}
function deferred<T>() {
  let resolveValue!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolveValue = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolveValue, reject };
}
export class OrdinaryLease {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly readiness = deferred<void>();
  private readonly retirement = deferred<void>();
  private queue: Promise<void> = Promise.resolve();
  private state: 'starting' | 'ready' | 'retired' = 'starting';
  private main: Held | null = null;
  private guardian: Held | null = null;
  private stopped = false;
  private count = 0;
  private elapsed = -1;
  readonly closed: Promise<number | null>;
  constructor(
    readonly scope: Scope,
    private readonly ports: LeasePorts,
  ) {
    const detach = ports.transport.onFrame((bytes) => {
      if (++this.count > 2) {
        this.fail();
        return;
      }
      this.queue = this.queue.then(() => this.consume(bytes));
      void this.own(this.queue).catch(() => this.fail());
    });
    this.closed = this.own(
      ports.transport.closed.then(async (code) => {
        await this.queue.catch(() => undefined);
        detach();
        if (code !== 0 || this.state !== 'retired' || this.stopped) this.fail();
        return code;
      }),
    );
    void this.closed.catch(() => this.fail());
    if (ports.initialFrame !== undefined)
      void this.own(ports.transport.send(ports.initialFrame)).catch(() => this.fail());
  }
  get pendingOwned(): number {
    return this.pending.size;
  }
  private own<T>(promise: Promise<T>): Promise<T> {
    this.pending.add(promise);
    void promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  private check(): void {
    need(!this.stopped && this.ports.now() < this.ports.deadline);
  }
  private fail(): void {
    if (this.stopped) return;
    this.stopped = true;
    const error = new Error('普通退出观察已停止');
    this.readiness.reject(error);
    this.retirement.reject(error);
    this.ports.stop();
  }
  private logical<T>(original: Promise<T>): Promise<T> {
    this.own(original);
    return new Promise<T>((yes, no) => {
      const timer = setTimeout(
        () => {
          this.fail();
          no(new Error('普通退出观察期限耗尽'));
        },
        Math.max(0, this.ports.deadline - this.ports.now()),
      );
      void original.then(
        (value) => {
          clearTimeout(timer);
          try {
            this.check();
            yes(value);
          } catch (error) {
            this.fail();
            no(error);
          }
        },
        (error: unknown) => {
          clearTimeout(timer);
          this.fail();
          no(error);
        },
      );
    });
  }
  ready(): Promise<void> {
    return this.logical(this.readiness.promise);
  }
  retired(): Promise<void> {
    return this.logical(
      this.retirement.promise.then(async () => {
        need((await this.closed) === 0);
        this.check();
      }),
    );
  }
  private async consume(bytes: Buffer): Promise<void> {
    this.check();
    const v = obj(json(bytes, 4096), [
      'version',
      'runId',
      'state',
      'elapsedMs',
      'main',
      'guardian',
      'receiptSha256',
    ]);
    need(v.version === 1 && v.runId === this.scope.runId && num(v.elapsedMs) >= this.elapsed);
    this.elapsed = num(v.elapsedMs, 0, 29999);
    const main = held(v.main),
      guardian = held(v.guardian);
    pair(main, guardian, this.scope.initial);
    if (v.state === 'ready') {
      need(
        this.state === 'starting' &&
          !main.signaled &&
          !guardian.signaled &&
          v.receiptSha256 === null,
      );
      this.main = main;
      this.guardian = guardian;
      this.state = 'ready';
      this.readiness.resolve();
      return;
    }
    need(
      v.state === 'retired' &&
        this.state === 'ready' &&
        this.main !== null &&
        this.guardian !== null &&
        main.signaled &&
        guardian.signaled,
    );
    const receipt = await this.own(this.ports.readReceipt());
    this.check();
    verifyRetired(receipt, this.scope, this.main, this.guardian, hex(v.receiptSha256));
    need(same(main, this.main) && same(guardian, this.guardian));
    this.state = 'retired';
    this.retirement.resolve();
  }
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
  const entry = await lstat(path, { bigint: true });
  need(
    entry.isFile() &&
      !entry.isSymbolicLink() &&
      entry.nlink === 1n &&
      entry.size > 0n &&
      entry.size <= BigInt(maximum),
  );
  const file = await open(path, 'r');
  try {
    const before = await file.stat({ bigint: true });
    need(before.dev === entry.dev && before.ino === entry.ino && before.size === entry.size);
    const result = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < result.length) {
      const { bytesRead } = await file.read(result, offset, result.length - offset, offset);
      need(bytesRead > 0);
      offset += bytesRead;
    }
    need((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead === 0);
    const after = await file.stat({ bigint: true });
    need(
      after.dev === before.dev &&
        after.ino === before.ino &&
        after.size === before.size &&
        after.mtimeNs === before.mtimeNs &&
        after.nlink === 1n,
    );
    return result;
  } finally {
    await file.close();
  }
}
export interface StartOptions {
  journal: string;
  appData: string;
  initial: Identity;
  deadline: number;
  executableSha256: string;
  guardianSha256: string;
  bindingSha256: string;
  stop(): void;
}
/** Capture before UI Close; no command or renewed allowance is needed after ready. */
export async function startOrdinaryLease(options: StartOptions): Promise<OrdinaryLease> {
  try {
    return await start(options);
  } catch (error) {
    options.stop();
    throw error;
  }
}
async function start(options: StartOptions): Promise<OrdinaryLease> {
  const deadline = Math.min(options.deadline, performance.now() + 30000);
  need(process.platform === 'win32');
  const journal = resolve(options.journal),
    profile = verifyProfileIsolationJournal(resolve(options.appData), journal);
  need(profile.version === 2);
  const raw = await readBounded(join(journal, 'manifest.json'), 32768);
  const manifest = obj(json(raw, 32768), [
    'Version',
    'RunId',
    'DeclaredProfile',
    'ResolvedProfile',
    'PackageExecutable',
    'BindingJournal',
    'RootIdentity',
  ]);
  const root = str(manifest.ResolvedProfile);
  const rootIdentity = obj(manifest.RootIdentity, [
    'Requested',
    'FinalDos',
    'FinalGuid',
    'FinalNt',
    'VolumeSerial64',
    'FileId128',
    'Sddl',
    'FileSystem',
    'Attributes',
  ]);
  need(
    manifest.RunId === profile.runId &&
      manifest.Version === 2 &&
      str(manifest.PackageExecutable).toLowerCase() === options.initial.image.toLowerCase(),
  );
  need(
    sha256(await readBounded(resolve('native/lifecycle-guardian/Guardian.cs'), 262144)) ===
      '2276d8adef3405f485257d21f297aebe6dc8897763b38b0435fe9d6cbd43811e',
  );
  const scope: Scope = {
    runId: profile.runId,
    initial: identity(options.initial),
    manifestSha256: sha256(raw),
    markerSha256: sha256(await readBounded(join(root, '.aibrowse-e1-synthetic-owner.json'), 4096)),
    bindingSha256: hex(options.bindingSha256),
    executableSha256: hex(options.executableSha256),
    guardianSha256: hex(options.guardianSha256),
    fileId128: hex(str(rootIdentity.FileId128).toLowerCase(), 32),
    volumeSerial64: hex(str(rootIdentity.VolumeSerial64).toLowerCase(), 16),
  };
  const remainingMs = Math.floor(deadline - performance.now());
  need(remainingMs > 0);
  const child = spawn(
    'pwsh.exe',
    [
      '-NoProfile',
      '-File',
      resolve('tools/data-qualification/product-restore-lifecycle/observe.ps1'),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let buffer = Buffer.alloc(0),
    broken = false;
  const listeners = new Set<(bytes: Buffer) => void>();
  const stop = () => {
    if (!broken) {
      broken = true;
      options.stop();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (broken) return;
    if (chunk.length > 8192 || buffer.length + chunk.length > 8192) {
      stop();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const index = buffer.indexOf(10);
      if (index < 0) break;
      const line = buffer.subarray(0, index);
      buffer = buffer.subarray(index + 1);
      if (line.length > 4096) {
        stop();
        return;
      }
      for (const listener of listeners) listener(line);
    }
    if (buffer.length > 4096) stop();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (chunk.length > 0) stop();
  });
  child.stdout.on('error', stop);
  child.stderr.on('error', stop);
  child.stdin.on('error', stop);
  let exited = false,
    exitCode: number | null = null;
  child.once('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  const closed = new Promise<number | null>((done) => {
    child.once('error', stop);
    child.once('close', (code) => {
      if (buffer.length !== 0 || !exited || code !== exitCode) stop();
      done(broken ? null : code);
    });
  });
  const transport: Transport = {
    closed,
    onFrame(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send(frame) {
      need(Buffer.byteLength(frame) <= 4096);
      return new Promise<void>((done, fail) => {
        child.stdin.end(frame + '\n', (error?: Error | null) => (error ? fail(error) : done()));
      });
    },
  };
  return new OrdinaryLease(scope, {
    transport,
    readReceipt: () =>
      readBounded(
        join(
          journal,
          'runner-output',
          `ordinary-${scope.initial.pid}-${scope.initial.created}`,
          'retired.json',
        ),
        65536,
      ),
    now: () => performance.now(),
    deadline,
    stop,
    initialFrame: JSON.stringify({
      version: 1,
      runId: scope.runId,
      journal,
      runnerPid: process.pid,
      initial: scope.initial,
      remainingMs,
      executableSha256: scope.executableSha256,
      guardianSha256: scope.guardianSha256,
      bindingSha256: scope.bindingSha256,
    }),
  });
}
