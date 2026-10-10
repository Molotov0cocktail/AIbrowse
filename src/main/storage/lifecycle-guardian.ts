import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { checkedStat } from './dataset-layout';
import { parseBoundedJson } from './bounded-json';

export interface LifecycleGuardianHandle {
  authorizeUtility(input: { pid: number; role: 'probe' | 'transfer' }): Promise<void>;
  confirmUtilityExit(pid: number): Promise<void>;
  requestRelaunch(): Promise<void>;
  finishShutdown(): Promise<void>;
  beginShutdown(): void;
  onFailure(listener: () => void): () => void;
}
const failure = () => new Error('数据进程退出状态无法确认，业务入口已关闭');
const MAX_FRAMES = 65_536;
const MAX_BYTES = 16 * 1024 * 1024;
const pidValid = (pid: number) => Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffff_ffff;

/** Main-private protocol. Native acknowledgement follows the durable writer record. */
export function createGuardianSession(options: {
  nonce: string;
  send(frame: string): void;
  timeoutMs?: number;
  readyTimeoutMs?: number;
}): {
  ready: Promise<void>;
  handle: LifecycleGuardianHandle;
  receive(frame: string): void;
  close(): void;
  assertCurrent(): void;
} {
  if (!/^[a-f0-9]{32}$/u.test(options.nonce)) throw failure();
  const timeout = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 10_000) throw failure();
  let failed = false,
    initialized = false,
    closing = false;
  let sequence = 0,
    frames = 0,
    bytes = 0;
  let pending: {
    sequence: number;
    resolve(): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
    deadline: number;
  } | null = null;
  const listeners = new Set<() => void>();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyResult = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const readyTimeout = options.readyTimeoutMs ?? timeout;
  if (!Number.isFinite(readyTimeout) || readyTimeout <= 0 || readyTimeout > timeout)
    throw failure();
  const readyDeadline = performance.now() + readyTimeout;
  const ready = readyResult.then(() => {
    requireTime(readyDeadline);
    assertCurrent();
  });
  const readyTimer = setTimeout(close, readyTimeout);
  function assertCurrent(): void {
    if (failed || !initialized) throw failure();
  }
  function requireTime(deadline: number): void {
    if (performance.now() >= deadline) {
      close();
      throw failure();
    }
  }
  function close(): void {
    if (failed) return;
    failed = true;
    clearTimeout(readyTimer);
    rejectReady(failure());
    const current = pending;
    pending = null;
    if (current) {
      clearTimeout(current.timer);
      current.reject(failure());
    }
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        /* Failure callbacks cannot reopen admission. */
      }
    }
  }
  function account(frame: string): void {
    frames++;
    bytes += Buffer.byteLength(frame);
    if (
      frame.length > 4096 ||
      frames > MAX_FRAMES ||
      bytes > MAX_BYTES ||
      /[^\x20-\x7e\n]/u.test(frame)
    )
      throw failure();
  }
  function command(parts: string[], requiresAdmission = false): Promise<void> {
    if (failed || !initialized || pending) return Promise.reject(failure());
    const current = ++sequence;
    const deadline = performance.now() + timeout;
    return new Promise<void>((resolve, reject) => {
      pending = { sequence: current, resolve, reject, deadline, timer: setTimeout(close, timeout) };
      try {
        const frame = ['1', options.nonce, String(current), ...parts].join('|') + '\n';
        account(frame);
        options.send(frame);
      } catch {
        close();
      }
    }).then(() => {
      requireTime(deadline);
      assertCurrent();
      if (requiresAdmission && closing) throw failure();
    });
  }
  const handle: LifecycleGuardianHandle = {
    authorizeUtility(input) {
      if (
        closing ||
        !pidValid(input.pid) ||
        !['probe', 'transfer'].includes(input.role) ||
        Object.keys(input).sort().join(',') !== 'pid,role'
      )
        return Promise.reject(failure());
      return command(['authorize', input.role, String(input.pid)], true);
    },
    confirmUtilityExit(pid) {
      return pidValid(pid) ? command(['retire', String(pid)]) : Promise.reject(failure());
    },
    requestRelaunch() {
      return command(['relaunch']);
    },
    finishShutdown() {
      closing = true;
      return command(['finish']);
    },
    beginShutdown() {
      closing = true;
    },
    onFailure(listener) {
      if (failed) listener();
      else listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    ready,
    handle,
    close,
    assertCurrent,
    receive(frame) {
      if (failed) return;
      try {
        account(frame);
        const parts = frame.split('|');
        if (
          parts.length !== 4 ||
          parts[0] !== '1' ||
          parts[1] !== options.nonce ||
          !/^(0|[1-9][0-9]{0,5})$/u.test(parts[2]!)
        )
          throw failure();
        const current = Number(parts[2]);
        if (!initialized) {
          if (current !== 0 || parts[3] !== 'ready') throw failure();
          requireTime(readyDeadline);
          initialized = true;
          clearTimeout(readyTimer);
          resolveReady();
          return;
        }
        if (!pending || pending.sequence !== current || parts[3] !== 'ok') throw failure();
        requireTime(pending.deadline);
        const complete = pending;
        pending = null;
        clearTimeout(complete.timer);
        complete.resolve();
      } catch {
        close();
      }
    },
  };
}

export interface LifecycleGuardianOptions {
  userDataRoot: string;
  executablePath: string;
  developmentAppRoot?: string;
}

async function verifiedHelper(options: LifecycleGuardianOptions): Promise<string> {
  if (
    process.platform !== 'win32' ||
    !isAbsolute(options.userDataRoot) ||
    !isAbsolute(options.executablePath) ||
    resolve(options.userDataRoot) !== options.userDataRoot
  )
    throw failure();
  if (
    !(await checkedStat(options.userDataRoot, 'directory')) ||
    !(await checkedStat(options.executablePath, 'file'))
  )
    throw failure();
  if (
    options.developmentAppRoot &&
    (!isAbsolute(options.developmentAppRoot) ||
      !(await checkedStat(options.developmentAppRoot, 'directory')))
  )
    throw failure();
  const manifestPath = join(__dirname, 'lifecycle-guardian-integrity.json');
  const helper = options.developmentAppRoot
    ? join(options.developmentAppRoot, 'out', 'lifecycle-guardian', 'guardian.exe')
    : join(dirname(options.executablePath), 'resources', 'lifecycle-guardian', 'guardian.exe');
  const manifestFd = await open(manifestPath, 'r');
  let manifest: unknown;
  try {
    const stat = await manifestFd.stat();
    if (!stat.isFile() || stat.size > 4096 || stat.size < 2) throw failure();
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await manifestFd.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    if (offset !== stat.size) throw failure();
    manifest = parseBoundedJson(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset)),
      { bytes: 4096, depth: 2, nodes: 8 },
    );
  } finally {
    await manifestFd.close();
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw failure();
  const record = manifest as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !== 'bytes,sha256,version' ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.bytes) ||
    Number(record.bytes) < 1 ||
    Number(record.bytes) > 512 * 1024 ||
    typeof record.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.sha256)
  )
    throw failure();
  const before = await checkedStat(helper, 'file');
  if (!before || before.size !== BigInt(Number(record.bytes))) throw failure();
  const fd = await open(helper, 'r');
  try {
    const opened = await fd.stat({ bigint: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      throw failure();
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await fd.read(buffer, offset, buffer.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await checkedStat(helper, 'file');
    if (
      offset !== Number(opened.size) ||
      !after ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      createHash('sha256').update(buffer.subarray(0, offset)).digest('hex') !== record.sha256
    )
      throw failure();
  } finally {
    await fd.close();
  }
  return helper;
}

/** Called before any Store or utility receives data access. No renderer-facing options. */
export async function startLifecycleGuardian(
  options: LifecycleGuardianOptions,
): Promise<LifecycleGuardianHandle> {
  const deadline = performance.now() + 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let helper: string;
  try {
    helper = await Promise.race([
      verifiedHelper(options),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure()), 10_000);
      }),
    ]);
    if (performance.now() >= deadline) throw failure();
  } catch {
    throw failure();
  } finally {
    clearTimeout(timer);
  }
  const nonce = randomBytes(16).toString('hex');
  const child = spawn(
    helper,
    [
      options.userDataRoot,
      String(process.pid),
      nonce,
      options.executablePath,
      options.developmentAppRoot ?? '',
    ],
    { windowsHide: true, detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const session = createGuardianSession({
    nonce,
    readyTimeoutMs: Math.max(1, deadline - performance.now()),
    send: (frame) => {
      if (!child.stdin.writable) throw failure();
      child.stdin.write(frame, (error) => {
        if (error) session.close();
      });
    },
  });
  let buffer = Buffer.alloc(0),
    errorBytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    if (buffer.length + chunk.length > 4096) {
      session.close();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    let end: number;
    while ((end = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, end);
      if (line.some((byte) => byte < 0x20 || byte > 0x7e)) {
        session.close();
        return;
      }
      session.receive(line.toString('ascii'));
      buffer = buffer.subarray(end + 1);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    errorBytes += chunk.length;
    if (errorBytes > 4096) session.close();
  });
  child.on('error', session.close);
  child.on('exit', session.close);
  child.stdout.on('error', session.close);
  child.stdin.on('error', session.close);
  // Closing stdin asks the guardian to terminate the Job. Its exit is never assumed.
  session.handle.onFailure(() => child.stdin.destroy());
  await session.ready;
  if (performance.now() >= deadline) {
    session.close();
    throw failure();
  }
  session.assertCurrent();
  return session.handle;
}
