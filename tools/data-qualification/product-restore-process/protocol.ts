import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { join, resolve, win32 } from 'node:path';
import { parseBoundedJson } from '../../../src/main/storage/bounded-json.ts';
import { verifyProfileIsolationJournal } from '../../release/profile-isolation-policy.ts';

export type Scene = 'R' | 'P';
export interface Identity {
  pid: number;
  created: string;
  image: string;
}
export interface HeldIdentity extends Identity {
  imageIdentity: string;
  parentPid: number;
  role: 'main' | 'guardian' | 'utility';
  session: string | null;
  registeredWriter: boolean;
  signaled: boolean;
  exitCode: number | null;
  exitFileTime: string | null;
}
export interface Scope {
  runId: string;
  scene: Scene;
  initial: Identity;
  executableSha256: string;
  guardianSha256: string;
  bindingSha256: string;
  manifestSha256: string;
  markerSha256: string;
  fileId128: string;
  volumeSerial64: string;
}
export interface Frame {
  version: 1;
  runId: string;
  scene: Scene;
  transition: number;
  sequence: number;
  state:
    'ready' | 'armed' | 'approved' | 'cancelled' | 'accepted' | 'current' | 'finished' | 'failed';
  elapsedMs: number;
  receiptSha256: string | null;
  current: Identity;
  failure: string | null;
}
export interface Approval {
  version: 1;
  runId: string;
  scene: Scene;
  transition: number;
  actionSequence: number;
  purpose: 'restore' | 'partial';
  result: 'approved' | 'cancelled';
  nativeReceiptSha256: string;
}
interface Writer {
  pid: number;
  created: string;
  image: string;
}
interface Ledger {
  version: 1;
  root: string;
  session: string;
  main: Writer | null;
  utility: (Writer & { role: 'probe' | 'transfer' }) | null;
}
export interface TransitionProof {
  identity: Identity;
  guardian: HeldIdentity;
  successorSeenMs: number;
  receiptSha256: string;
  utilityCoverage: 'held-observations-plus-guardian-retirement';
}
export interface AcceptedSuccessor extends TransitionProof {
  /** Conservative absolute deadline for the caller's first successor UI qualification. */
  bootDeadline: number;
}

function need(condition: unknown): asserts condition {
  if (!condition) throw new Error('恢复身份协议或证据不一致');
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  need(typeof value === 'object' && value !== null && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  need(keys.length === fields.length && keys.every((key) => fields.includes(key)));
  return record;
}
function string(value: unknown): string {
  need(typeof value === 'string' && value.length > 0 && value.length <= 32768);
  return value;
}
function hex(value: unknown, length = 64): string {
  const text = string(value);
  need(new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(text));
  return text;
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number {
  need(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= minimum &&
      value <= maximum,
  );
  return value;
}
function time(value: unknown): string {
  const text = string(value);
  need(/^[1-9][0-9]{0,18}$/u.test(text) && BigInt(text) <= 9223372036854775807n);
  return text;
}
function json(bytes: Buffer, maximum: number): unknown {
  need(bytes.length <= maximum);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return parseBoundedJson(text, { bytes: maximum, depth: 12, nodes: 8192 });
}
export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
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
export function identity(value: unknown): Identity {
  const v = object(value, ['pid', 'created', 'image']);
  return { pid: integer(v.pid, 1, 4294967295), created: time(v.created), image: string(v.image) };
}
function same(a: Identity, b: Identity): boolean {
  return (
    a.pid === b.pid && a.created === b.created && a.image.toLowerCase() === b.image.toLowerCase()
  );
}
function held(value: unknown): HeldIdentity {
  const v = object(value, [
    'pid',
    'created',
    'image',
    'imageIdentity',
    'parentPid',
    'role',
    'session',
    'registeredWriter',
    'signaled',
    'exitCode',
    'exitFileTime',
  ]);
  need(v.role === 'main' || v.role === 'guardian' || v.role === 'utility');
  need(typeof v.signaled === 'boolean' && typeof v.registeredWriter === 'boolean');
  const result: HeldIdentity = {
    pid: integer(v.pid, 1, 4294967295),
    created: time(v.created),
    image: string(v.image),
    imageIdentity: hex(v.imageIdentity),
    parentPid: integer(v.parentPid, 1, 4294967295),
    role: v.role,
    session: v.session === null ? null : hex(v.session, 32),
    registeredWriter: v.registeredWriter,
    signaled: v.signaled,
    exitCode: v.exitCode === null ? null : integer(v.exitCode, 0, 4294967295),
    exitFileTime: v.exitFileTime === null ? null : time(v.exitFileTime),
  };
  need(
    result.signaled
      ? result.exitCode !== null && result.exitFileTime !== null
      : result.exitCode === null && result.exitFileTime === null,
  );
  need(result.role === 'guardian' ? result.session !== null : result.session === null);
  return result;
}
function writer(value: unknown): Writer | null {
  if (value === null) return null;
  const v = object(value, ['pid', 'created', 'image']);
  return { pid: integer(v.pid, 1, 4294967295), created: time(v.created), image: hex(v.image) };
}
export function decodeLedger(value: unknown): Ledger {
  const v = object(value, ['version', 'root', 'session', 'main', 'utility']);
  need(v.version === 1);
  let utility: Ledger['utility'] = null;
  if (v.utility !== null) {
    const u = object(v.utility, ['role', 'pid', 'created', 'image']);
    need(u.role === 'probe' || u.role === 'transfer');
    utility = { ...writer({ pid: u.pid, created: u.created, image: u.image })!, role: u.role };
  }
  const main = writer(v.main);
  need(
    utility === null ||
      (main !== null &&
        utility.pid !== main.pid &&
        BigInt(utility.created) >= BigInt(main.created) &&
        utility.image === main.image),
  );
  return { version: 1, root: hex(v.root), session: hex(v.session, 32), main, utility };
}
export function decodeFrame(bytes: Buffer): Frame {
  const v = object(json(bytes, 4096), [
    'version',
    'runId',
    'scene',
    'transition',
    'sequence',
    'state',
    'elapsedMs',
    'receiptSha256',
    'current',
    'failure',
  ]);
  need(v.version === 1 && (v.scene === 'R' || v.scene === 'P'));
  const states = [
    'ready',
    'armed',
    'approved',
    'cancelled',
    'accepted',
    'current',
    'finished',
    'failed',
  ] as const;
  need(states.some((state) => state === v.state));
  const state = v.state as Frame['state'];
  need(state === 'failed' ? v.failure === 'observation-failed' : v.failure === null);
  need(
    state === 'accepted' || state === 'finished'
      ? typeof v.receiptSha256 === 'string'
      : v.receiptSha256 === null,
  );
  return {
    version: 1,
    runId: hex(v.runId, 32),
    scene: v.scene,
    transition: integer(v.transition, 0, v.scene === 'R' ? 1 : 2),
    sequence: integer(v.sequence, 0, 32),
    state,
    elapsedMs: integer(v.elapsedMs),
    receiptSha256: v.receiptSha256 === null ? null : hex(v.receiptSha256),
    current: identity(v.current),
    failure: v.failure as string | null,
  };
}
export function decodeApproval(
  bytes: Buffer,
  scope: Scope,
  transition: number,
  action: number,
  result: Approval['result'],
): Approval {
  const v = object(json(bytes, 4096), [
    'version',
    'runId',
    'scene',
    'transition',
    'actionSequence',
    'purpose',
    'result',
    'nativeReceiptSha256',
  ]);
  const purpose = scope.scene === 'P' && transition === 1 ? 'partial' : 'restore';
  need(
    v.version === 1 &&
      v.runId === scope.runId &&
      v.scene === scope.scene &&
      v.transition === transition &&
      v.actionSequence === action &&
      v.purpose === purpose &&
      v.result === result,
  );
  return {
    version: 1,
    runId: scope.runId,
    scene: scope.scene,
    transition,
    actionSequence: action,
    purpose,
    result,
    nativeReceiptSha256: hex(v.nativeReceiptSha256),
  };
}
function receipt(
  bytes: Buffer,
  scope: Scope,
  transition: number,
  kind: 'transition' | 'final',
  expectedSha: string,
) {
  need(sha256(bytes) === expectedSha);
  const v = object(json(bytes, 65536), [
    'version',
    'runId',
    'scene',
    'transition',
    'kind',
    'elapsedMs',
    'budgetMs',
    'manifestSha256',
    'markerSha256',
    'bindingSha256',
    'executableSha256',
    'guardianSha256',
    'profile',
    'limits',
    'sample',
    'facts',
  ]);
  need(
    v.version === 1 &&
      v.runId === scope.runId &&
      v.scene === scope.scene &&
      v.transition === transition &&
      v.kind === kind,
  );
  for (const key of [
    'manifestSha256',
    'markerSha256',
    'bindingSha256',
    'executableSha256',
    'guardianSha256',
  ] as const)
    need(v[key] === scope[key]);
  const profile = object(v.profile, ['fileId128', 'volumeSerial64', 'guardianRootHash']);
  need(profile.fileId128 === scope.fileId128 && profile.volumeSerial64 === scope.volumeSerial64);
  hex(profile.guardianRootHash);
  const limits = object(v.limits, ['flags', 'total', 'held', 'records', 'bytes']);
  need(limits.flags === 0x2008 && limits.total === 24);
  integer(limits.held, 1, 128);
  integer(limits.records, 0, 512);
  integer(limits.bytes, 0, 2097152);
  const sample = object(v.sample, ['main', 'guardian', 'chromium', 'utility', 'tools', 'members']);
  const maxima = { main: 1, guardian: 2, chromium: 16, utility: 2, tools: 4 } as const;
  need(Array.isArray(sample.members) && sample.members.length <= 24);
  const members = sample.members.map((value) => {
    const m = object(value, ['pid', 'created', 'role']);
    need(
      m.role === 'main' ||
        m.role === 'guardian' ||
        m.role === 'chromium' ||
        m.role === 'utility' ||
        m.role === 'tool',
    );
    return { pid: integer(m.pid, 1, 4294967295), created: time(m.created), role: m.role };
  });
  need(new Set(members.map((m) => m.pid)).size === members.length);
  for (const [role, max] of Object.entries(maxima))
    need(
      integer(sample[role], 0, max) ===
        members.filter((m) => m.role === (role === 'tools' ? 'tool' : role)).length,
    );
  const elapsed = integer(v.elapsedMs),
    budget = integer(v.budgetMs, 1, 3600000);
  need(elapsed < budget);
  return { v, root: profile.guardianRootHash, elapsed, members };
}
function exited(p: HeldIdentity): void {
  need(
    p.signaled &&
      p.exitCode === 0 &&
      p.exitFileTime !== null &&
      BigInt(p.exitFileTime) >= BigInt(p.created),
  );
}
function alive(p: HeldIdentity): void {
  need(!p.signaled && p.exitCode === null && p.exitFileTime === null);
}
function retiredUtility(p: HeldIdentity): void {
  need(
    p.signaled &&
      p.exitCode !== null &&
      p.exitFileTime !== null &&
      BigInt(p.exitFileTime) >= BigInt(p.created),
  );
  if (p.registeredWriter) exited(p);
}
export function verifyTransition(
  bytes: Buffer,
  scope: Scope,
  transition: number,
  before: Identity,
  action: number,
  approvalSha: string,
  expectedSha: string,
): TransitionProof {
  const { v, root, elapsed, members } = receipt(
    bytes,
    scope,
    transition,
    'transition',
    expectedSha,
  );
  const f = object(v.facts, [
    'oldMain',
    'oldGuardian',
    'newMain',
    'newGuardian',
    'heldUtilities',
    'uncaptured',
    'utilityCoverage',
    'oldSession',
    'newSession',
    'ledger',
    'ledgerSha256',
    'approval',
    'successorSeenMs',
  ]);
  const old = held(f.oldMain),
    guardian = held(f.oldGuardian),
    next = held(f.newMain),
    nextGuardian = held(f.newGuardian);
  need(
    old.role === 'main' &&
      guardian.role === 'guardian' &&
      next.role === 'main' &&
      nextGuardian.role === 'guardian',
  );
  need(same(old, before) && !same(old, next) && old.pid !== next.pid && next.pid !== guardian.pid);
  need(
    guardian.image.toLowerCase() ===
      win32
        .join(win32.dirname(scope.initial.image), 'resources', 'lifecycle-guardian', 'guardian.exe')
        .toLowerCase(),
  );
  exited(old);
  exited(guardian);
  alive(next);
  alive(nextGuardian);
  for (const [role, p] of [
    ['main', next],
    ['guardian', nextGuardian],
  ] as const) {
    const active = members.filter((m) => m.role === role);
    need(active.length === 1 && active[0]!.pid === p.pid && active[0]!.created === p.created);
  }
  need(
    next.image.toLowerCase() === old.image.toLowerCase() &&
      next.imageIdentity === old.imageIdentity &&
      nextGuardian.image.toLowerCase() === guardian.image.toLowerCase() &&
      nextGuardian.imageIdentity === guardian.imageIdentity,
  );
  need(
    guardian.parentPid === old.pid &&
      next.parentPid === guardian.pid &&
      nextGuardian.parentPid === next.pid,
  );
  need(
    BigInt(guardian.created) >= BigInt(old.created) &&
      BigInt(next.created) > BigInt(old.exitFileTime!) &&
      BigInt(next.created) >= BigInt(guardian.created) &&
      BigInt(next.created) <= BigInt(guardian.exitFileTime!) &&
      BigInt(nextGuardian.created) >= BigInt(next.created),
  );
  const oldSession = hex(f.oldSession, 32),
    newSession = hex(f.newSession, 32);
  need(
    guardian.session === oldSession &&
      nextGuardian.session === newSession &&
      oldSession !== newSession,
  );
  need(Array.isArray(f.heldUtilities) && f.heldUtilities.length <= 128);
  const utilities = f.heldUtilities.map(held),
    keys = new Set<string>();
  for (const u of utilities) {
    need(
      u.role === 'utility' &&
        u.parentPid === old.pid &&
        u.imageIdentity === old.imageIdentity &&
        u.image.toLowerCase() === old.image.toLowerCase(),
    );
    retiredUtility(u);
    need(
      BigInt(u.created) >= BigInt(old.created) &&
        BigInt(u.exitFileTime!) <= BigInt(next.created) &&
        !keys.has(`${u.pid}:${u.created}`),
    );
    keys.add(`${u.pid}:${u.created}`);
  }
  need(Array.isArray(f.uncaptured) && f.uncaptured.length <= 128);
  for (const item of f.uncaptured) {
    const u = object(item, ['pid', 'created', 'role', 'classification', 'exitCode']);
    integer(u.pid, 1, 4294967295);
    time(u.created);
    need(
      (u.role === 'probe' || u.role === 'transfer') &&
        u.classification === 'not-held' &&
        u.exitCode === null,
    );
  }
  need(f.utilityCoverage === 'held-observations-plus-guardian-retirement');
  const ledger = decodeLedger(f.ledger);
  hex(f.ledgerSha256);
  need(
    ledger.root === root &&
      ledger.session === newSession &&
      ledger.main?.pid === next.pid &&
      ledger.main.created === next.created &&
      ledger.main.image === next.imageIdentity,
  );
  const approval = object(f.approval, ['sequence', 'sha256']);
  need(approval.sequence === action && approval.sha256 === approvalSha);
  const seen = integer(f.successorSeenMs);
  need(seen <= elapsed && elapsed - seen < 60000);
  return {
    identity: { pid: next.pid, created: next.created, image: next.image },
    guardian: nextGuardian,
    successorSeenMs: seen,
    receiptSha256: expectedSha,
    utilityCoverage: f.utilityCoverage,
  };
}
export function verifyFinal(
  bytes: Buffer,
  scope: Scope,
  transition: number,
  current: Identity,
  expectedGuardian: HeldIdentity,
  expectedSha: string,
): void {
  const { v, root, members } = receipt(bytes, scope, transition, 'final', expectedSha);
  need(members.every((m) => m.role !== 'main' && m.role !== 'guardian' && m.role !== 'utility'));
  const f = object(v.facts, [
    'currentMain',
    'currentGuardian',
    'ledger',
    'ledgerSha256',
    'held',
    'utilityCoverage',
  ]);
  const main = held(f.currentMain),
    guardian = held(f.currentGuardian);
  need(
    same(main, current) &&
      main.role === 'main' &&
      guardian.role === 'guardian' &&
      guardian.parentPid === main.pid,
  );
  need(
    same(guardian, expectedGuardian) &&
      guardian.imageIdentity === expectedGuardian.imageIdentity &&
      guardian.session === expectedGuardian.session,
  );
  exited(main);
  exited(guardian);
  const ledger = decodeLedger(f.ledger);
  hex(f.ledgerSha256);
  need(
    ledger.root === root &&
      ledger.session === guardian.session &&
      ledger.main === null &&
      ledger.utility === null,
  );
  need(
    f.utilityCoverage === 'held-observations-plus-guardian-retirement' &&
      Array.isArray(f.held) &&
      f.held.length <= 128,
  );
  for (const p of f.held.map(held)) {
    if (p.role === 'utility') retiredUtility(p);
    else exited(p);
  }
}

export interface Transport {
  send(frame: string): Promise<void>;
  onFrame(listener: (frame: Buffer) => void): () => void;
  closed: Promise<number | null>;
}
export interface Ports {
  transport: Transport;
  readEvidence(name: string): Promise<Buffer>;
  now(): number;
  deadline: number;
  stop(): void;
  initialFrame?: string;
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Logical cancellation never settles original transport, receipt IO or child-close work. */
export class SuccessorClient {
  private readonly pending = new Set<Promise<unknown>>();
  private readonly readyValue = deferred<Identity>();
  private readonly successorValue = new Map<number, Deferred<AcceptedSuccessor>>();
  private readonly requests = new Map<number, { state: Frame['state']; value: Deferred<Frame> }>();
  private sequence = 0;
  private transition = 0;
  private action = 0;
  private state: Frame['state'] | 'starting' = 'starting';
  private current: Identity;
  private currentGuardian: HeldIdentity | null = null;
  private approvedSha: string | null = null;
  private deciding = false;
  private stopped = false;
  private elapsed = -1;
  private receivedFrames = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly detach: () => void;
  private readonly started: number;
  readonly closed: Promise<number | null>;
  constructor(
    readonly scope: Scope,
    private readonly ports: Ports,
  ) {
    this.started = ports.now();
    this.current = identity(scope.initial);
    this.detach = ports.transport.onFrame((bytes) => {
      if (++this.receivedFrames > 40) {
        this.fail();
        return;
      }
      this.queue = this.queue.then(() => this.consume(bytes));
      void this.own(this.queue).catch(() => this.fail());
    });
    this.closed = this.own(
      ports.transport.closed.then(async (code) => {
        await this.queue.catch(() => undefined);
        this.detach();
        if (this.state !== 'finished' || code !== 0) this.fail();
        const error = new Error('观察器已关闭');
        this.readyValue.reject(error);
        for (const r of this.requests.values()) r.value.reject(error);
        for (const r of this.successorValue.values()) r.reject(error);
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
  get identity(): Identity {
    return { ...this.current };
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
    this.ports.stop();
  }
  private logical<T>(original: Promise<T>): Promise<T> {
    this.own(original);
    return new Promise<T>((resolveValue, reject) => {
      const timer = setTimeout(
        () => {
          this.fail();
          reject(new Error('恢复身份观察期限耗尽'));
        },
        Math.max(0, this.ports.deadline - this.ports.now()),
      );
      void original.then(
        (value) => {
          clearTimeout(timer);
          try {
            this.check();
            resolveValue(value);
          } catch {
            this.fail();
            reject(new Error('恢复身份观察已停止'));
          }
        },
        (error: unknown) => {
          clearTimeout(timer);
          this.fail();
          reject(error);
        },
      );
    });
  }
  ready(): Promise<Identity> {
    return this.logical(this.readyValue.promise);
  }
  private request(
    command: string,
    state: Frame['state'],
    action = 0,
    sha: string | null = null,
  ): Promise<Frame> {
    this.check();
    need(this.requests.size === 0);
    const sequence = ++this.sequence,
      value = deferred<Frame>();
    this.requests.set(sequence, { state, value });
    const frame = JSON.stringify({
      version: 1,
      runId: this.scope.runId,
      scene: this.scope.scene,
      transition: this.transition,
      sequence,
      command,
      actionSequence: action,
      receiptSha256: sha,
    });
    const original = this.ports.transport.send(frame).then(() => value.promise);
    return this.logical(original);
  }
  arm(actionSequence: number): Promise<Frame> {
    this.check();
    need(
      this.requests.size === 0 &&
        (this.state === 'ready' || this.state === 'accepted' || this.state === 'current') &&
        this.transition < (this.scope.scene === 'R' ? 1 : 2),
    );
    const action = integer(actionSequence, this.action + 1);
    this.transition++;
    this.action = action;
    this.approvedSha = null;
    this.successorValue.set(this.transition, deferred<AcceptedSuccessor>());
    return this.request('arm', 'armed', this.action);
  }
  async decide(result: Approval['result']): Promise<Frame> {
    this.check();
    need(this.state === 'armed' && !this.deciding);
    this.deciding = true;
    try {
      const bytes = await this.logical(
        this.ports.readEvidence(
          `../restore-native/${this.scope.scene}-t${this.transition}-a${this.action}.json`,
        ),
      );
      decodeApproval(bytes, this.scope, this.transition, this.action, result);
      this.check();
      const sha = sha256(bytes);
      if (result === 'approved') this.approvedSha = sha;
      return await this.request(result, result, this.action, sha);
    } catch (error) {
      this.fail();
      throw error;
    } finally {
      this.deciding = false;
    }
  }
  waitSuccessor(): Promise<AcceptedSuccessor> {
    this.check();
    need(this.state === 'approved' || this.state === 'accepted');
    const value = this.successorValue.get(this.transition);
    need(value);
    return this.logical(value.promise);
  }
  assertCurrent(): Promise<Frame> {
    this.check();
    need(this.state === 'ready' || this.state === 'accepted' || this.state === 'current');
    return this.request('assert-current', 'current');
  }
  async finish(): Promise<void> {
    this.check();
    need(
      (this.state === 'accepted' || this.state === 'current') &&
        this.transition === (this.scope.scene === 'R' ? 1 : 2),
    );
    await this.request('finish', 'finished');
    need((await this.logical(this.closed)) === 0);
  }
  cancelObservation(): void {
    this.fail();
  }
  private async consume(bytes: Buffer): Promise<void> {
    const frame = decodeFrame(bytes);
    need(
      frame.runId === this.scope.runId &&
        frame.scene === this.scope.scene &&
        frame.transition === this.transition &&
        frame.sequence === this.sequence &&
        frame.elapsedMs >= this.elapsed,
    );
    this.elapsed = frame.elapsedMs;
    if (frame.state === 'failed') {
      this.fail();
      return;
    }
    this.check();
    if (frame.state === 'ready') {
      need(this.state === 'starting' && same(frame.current, this.current));
      this.state = 'ready';
      this.readyValue.resolve(this.identity);
      return;
    }
    if (frame.state === 'accepted') {
      need(this.state === 'approved' && this.approvedSha !== null && frame.receiptSha256 !== null);
      const raw = await this.own(this.ports.readEvidence(`t${this.transition}-transition.json`));
      this.check();
      const proof = verifyTransition(
        raw,
        this.scope,
        this.transition,
        this.current,
        this.action,
        this.approvedSha,
        frame.receiptSha256,
      );
      need(same(proof.identity, frame.current));
      const bootDeadline = Math.min(
        this.ports.deadline,
        this.started + proof.successorSeenMs + 60000,
      );
      need(this.ports.now() < bootDeadline);
      const accepted = this.successorValue.get(this.transition);
      need(accepted);
      // Publish only after every identity, evidence and deadline check succeeds.
      this.current = proof.identity;
      this.currentGuardian = proof.guardian;
      this.state = 'accepted';
      accepted.resolve({ ...proof, bootDeadline });
      return;
    }
    const request = this.requests.get(frame.sequence);
    need(request && request.state === frame.state && same(frame.current, this.current));
    if (frame.state === 'finished') {
      need(frame.receiptSha256 !== null);
      const raw = await this.own(this.ports.readEvidence(`t${this.transition}-final.json`));
      this.check();
      need(this.currentGuardian !== null);
      verifyFinal(
        raw,
        this.scope,
        this.transition,
        this.current,
        this.currentGuardian,
        frame.receiptSha256,
      );
    }
    this.state = frame.state;
    this.requests.delete(frame.sequence);
    request.value.resolve(frame);
  }
}

export interface StartOptions {
  journal: string;
  appData: string;
  scene: Scene;
  initial: Identity;
  deadline: number;
  executableSha256: string;
  guardianSha256: string;
  bindingSha256: string;
  stop(): void;
}
/** Returns ownership before native admission; the caller separately awaits ready(). */
export async function startObserver(options: StartOptions): Promise<SuccessorClient> {
  need(process.platform === 'win32');
  const journal = resolve(options.journal),
    profile = verifyProfileIsolationJournal(resolve(options.appData), journal);
  need(profile.version === 2 && options.deadline > performance.now());
  const manifestBytes = await readBounded(join(journal, 'manifest.json'), 32768);
  const manifest = object(json(manifestBytes, 32768), [
    'Version',
    'RunId',
    'DeclaredProfile',
    'ResolvedProfile',
    'PackageExecutable',
    'BindingJournal',
    'RootIdentity',
  ]);
  const root = string(manifest.ResolvedProfile);
  const rootIdentity = object(manifest.RootIdentity, [
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
      string(manifest.PackageExecutable).toLowerCase() === options.initial.image.toLowerCase(),
  );
  const source = await readBounded(resolve('native/lifecycle-guardian/Guardian.cs'), 262144);
  need(sha256(source) === '2276d8adef3405f485257d21f297aebe6dc8897763b38b0435fe9d6cbd43811e');
  const scope: Scope = {
    runId: profile.runId,
    scene: options.scene,
    initial: identity(options.initial),
    executableSha256: hex(options.executableSha256),
    guardianSha256: hex(options.guardianSha256),
    bindingSha256: hex(options.bindingSha256),
    manifestSha256: sha256(manifestBytes),
    markerSha256: sha256(await readBounded(join(root, '.aibrowse-e1-synthetic-owner.json'), 4096)),
    fileId128: hex(string(rootIdentity.FileId128).toLowerCase(), 32),
    volumeSerial64: hex(string(rootIdentity.VolumeSerial64).toLowerCase(), 16),
  };
  const remainingMs = Math.floor(options.deadline - performance.now());
  need(remainingMs > 0 && remainingMs <= 3600000);
  const child = spawn(
    'pwsh.exe',
    [
      '-NoProfile',
      '-File',
      resolve('tools/data-qualification/product-restore-process/observe.ps1'),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const listeners = new Set<(bytes: Buffer) => void>();
  let buffer = Buffer.alloc(0),
    broken = false;
  const stop = () => {
    if (!broken) {
      broken = true;
      options.stop();
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (broken) return;
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
  const closed = new Promise<number | null>((resolveClosed) => {
    child.once('error', stop);
    child.once('close', (code) => {
      if (buffer.length !== 0) stop();
      resolveClosed(code);
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
        child.stdin.write(frame + '\n', (error) => (error ? fail(error) : done()));
      });
    },
  };
  const output = join(journal, 'runner-output', `restore-process-${options.scene}`);
  const client = new SuccessorClient(scope, {
    transport,
    readEvidence: (name) =>
      readBounded(join(output, name), name.startsWith('../restore-native/') ? 4096 : 65536),
    now: () => performance.now(),
    deadline: options.deadline,
    stop,
    initialFrame: JSON.stringify({
      version: 1,
      runId: scope.runId,
      scene: scope.scene,
      journal,
      runnerPid: process.pid,
      initial: scope.initial,
      remainingMs,
      executableSha256: scope.executableSha256,
      guardianSha256: scope.guardianSha256,
      bindingSha256: scope.bindingSha256,
    }),
  });
  return client;
}
