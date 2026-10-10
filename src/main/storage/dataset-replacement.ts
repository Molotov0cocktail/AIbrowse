import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { mkdir, open, rename } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { readActiveDataset } from './dataset-active';
import {
  assertScope,
  checkedStat,
  datasetFailure,
  METADATA_BYTES,
  readDatasetScope,
  readMetadata,
  sameIdentity,
  type DatasetContext,
  type DatasetPhase,
  type DatasetScope,
} from './dataset-layout';

type Stamp = { dev: string; ino: string; bytes: number; mtimeNs: string; sha256: string };
export type RecoveryGate = Readonly<Stamp>;
export interface DatasetReplacementContext extends DatasetContext {
  /** Main-owned lifecycle/authority proof; an empty local process map is not a proof. */
  assertNoWriters(): void;
}
interface Replacement {
  version: 1;
  operationId: string;
  generation: string;
  gate: Stamp;
  previous: [Stamp | null, Stamp | null];
}
type Check = (bytes: number) => Promise<void>;
const PREVIOUS = ['active.json', 'active.json.tmp'] as const;
const GATE = 'recovery-gate';
const exact = (record: Record<string, unknown>, keys: string[]) =>
  Object.keys(record).sort().join(',') === keys.sort().join(',');
const unchanged = (a: BigIntStats, b: BigIntStats) =>
  sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const equal = (a: Stamp | null, b: Stamp | null): boolean =>
  a === null
    ? b === null
    : b !== null &&
      a.dev === b.dev &&
      a.ino === b.ino &&
      a.bytes === b.bytes &&
      a.mtimeNs === b.mtimeNs &&
      a.sha256 === b.sha256;

async function snapshot(path: string, check: Check): Promise<Stamp | null> {
  await check(0);
  const before = await checkedStat(path, 'file');
  if (before === null) return null;
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw datasetFailure();
  const fd = await open(path, 'r');
  try {
    await check(0);
    const opened = await fd.stat({ bigint: true });
    if (!unchanged(before, opened)) throw datasetFailure();
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      await check(bytes);
      const read = await fd.read(
        buffer,
        0,
        Math.min(buffer.length, Number(before.size) - bytes + 1),
        bytes,
      );
      await check(bytes);
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
      if (bytes > Number(before.size)) throw datasetFailure();
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    const after = await checkedStat(path, 'file');
    if (
      bytes !== Number(before.size) ||
      !after ||
      !unchanged(opened, after) ||
      !unchanged(opened, await fd.stat({ bigint: true }))
    )
      throw datasetFailure();
    await check(bytes);
    return {
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
      bytes,
      mtimeNs: opened.mtimeNs.toString(),
      sha256: hash.digest('hex'),
    };
  } finally {
    await fd.close();
  }
}

async function anchor(
  root: string,
  context: DatasetContext,
  create: boolean,
): Promise<{ path: string; check: Check }> {
  await context.check('register', 0);
  if (!isAbsolute(root) || resolve(root) !== root) throw datasetFailure();
  const rootStat = await checkedStat(root, 'directory');
  if (!rootStat) throw datasetFailure();
  const parent = join(root, 'data-transfer');
  if (!(await checkedStat(parent, 'directory')) && create) await mkdir(parent);
  const parentStat = await checkedStat(parent, 'directory');
  const check: Check = async (bytes) => {
    await context.check('register', bytes);
    const a = await checkedStat(root, 'directory');
    const b = await checkedStat(parent, 'directory');
    if (
      !a ||
      !sameIdentity(rootStat, a) ||
      (parentStat ? !b || !sameIdentity(parentStat, b) : b !== null)
    )
      throw datasetFailure();
    await context.check('register', bytes);
  };
  await check(0);
  return { path: join(parent, GATE), check };
}

/** Presence is a Store barrier, never an authority parsed from the marker's bytes. */
export async function readRecoveryGate(
  root: string,
  context: DatasetContext,
): Promise<RecoveryGate | null> {
  try {
    const value = await anchor(root, context, false);
    return await snapshot(value.path, value.check);
  } catch {
    throw datasetFailure();
  }
}

/** May precede partial-graph shutdown. It touches only the fixed Store barrier. */
export async function ensureRecoveryGate(
  root: string,
  context: DatasetContext,
): Promise<RecoveryGate> {
  try {
    const value = await anchor(root, context, true);
    const existing = await snapshot(value.path, value.check);
    if (existing) return existing;
    const fd = await open(value.path, 'wx');
    try {
      const created = await fd.stat({ bigint: true });
      await context.boundary?.('replacement-gate-created');
      await value.check(0);
      await fd.writeFile('AIbrowse recovery barrier\n');
      await fd.sync();
      await context.boundary?.('replacement-gate-flushed');
      await value.check(0);
      const current = await checkedStat(value.path, 'file');
      if (!current || !sameIdentity(created, current)) throw datasetFailure();
    } finally {
      await fd.close();
    }
    const result = await snapshot(value.path, value.check);
    if (!result) throw datasetFailure();
    return result;
  } catch {
    throw datasetFailure();
  }
}

function decodeStamp(value: unknown): Stamp {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw datasetFailure();
  const r = value as Record<string, unknown>;
  if (
    !exact(r, ['dev', 'ino', 'bytes', 'mtimeNs', 'sha256']) ||
    !['dev', 'ino'].every((k) => typeof r[k] === 'string' && /^[0-9]{1,40}$/u.test(r[k])) ||
    typeof r.mtimeNs !== 'string' ||
    !/^-?[0-9]{1,40}$/u.test(r.mtimeNs) ||
    !Number.isSafeInteger(r.bytes) ||
    Number(r.bytes) < 0 ||
    typeof r.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(r.sha256)
  )
    throw datasetFailure();
  return r as unknown as Stamp;
}

/** Fixed-file supersession only. Caller owns native confirmation, validated work,
 * the single-instance lock, phase budget and the absence of relevant writers.
 * This class never adopts the contents of an old pointer or deletes evidence.
 */
export class DatasetReplacement {
  private busy = false;
  private phase: DatasetPhase = 'register';
  constructor(
    private readonly scope: DatasetScope,
    private readonly context: DatasetReplacementContext,
  ) {}
  private async run(work: () => Promise<void>, phase: DatasetPhase = 'register'): Promise<void> {
    if (this.busy) throw datasetFailure();
    this.busy = true;
    this.phase = phase;
    try {
      await this.authenticate();
      await work();
    } catch {
      throw datasetFailure();
    } finally {
      this.busy = false;
    }
  }
  private async check(bytes = 0): Promise<void> {
    this.context.assertNoWriters();
    await this.context.check(this.phase, bytes);
    this.context.assertNoWriters();
    await assertScope(this.scope);
    this.context.assertNoWriters();
  }
  private async authenticate(): Promise<void> {
    await this.check();
    if (this.scope.purpose !== 'restore' || this.scope.identities.length !== 8)
      throw datasetFailure();
    const stored = await readDatasetScope(this.scope);
    if (
      stored.operationRoot !== this.scope.operationRoot ||
      JSON.stringify(stored.identities) !== JSON.stringify(this.scope.identities)
    )
      throw datasetFailure();
    await this.check();
  }
  private source(name: string): string {
    return join(this.scope.userDataRoot, 'data-transfer', name);
  }
  private evidence(name: string): string {
    return join(this.scope.operationRoot, 'evidence', name);
  }
  private async fingerprint(path: string): Promise<Stamp | null> {
    return snapshot(path, (bytes) => this.check(bytes));
  }
  private async load(): Promise<Replacement> {
    await this.check();
    if (await checkedStat(join(this.scope.operationRoot, 'replacement.json.tmp')))
      throw datasetFailure();
    const raw = await readMetadata(this.scope, 'replacement.json');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw datasetFailure();
    const r = raw as Record<string, unknown>;
    if (
      !exact(r, ['version', 'operationId', 'generation', 'gate', 'previous']) ||
      r.version !== 1 ||
      r.operationId !== this.scope.operationId ||
      r.generation !== this.scope.generation ||
      !Array.isArray(r.previous) ||
      r.previous.length !== 2
    )
      throw datasetFailure();
    const result: Replacement = {
      version: 1,
      operationId: this.scope.operationId,
      generation: this.scope.generation,
      gate: decodeStamp(r.gate),
      previous: r.previous.map((v) =>
        v === null ? null : decodeStamp(v),
      ) as Replacement['previous'],
    };
    await this.check();
    return result;
  }
  private async write(record: Replacement): Promise<void> {
    const payload = Buffer.from(JSON.stringify(record));
    if (payload.length > METADATA_BYTES) throw datasetFailure();
    const final = join(this.scope.operationRoot, 'replacement.json');
    const temp = final + '.tmp';
    await this.check();
    if (await checkedStat(final)) throw datasetFailure();
    const fd = await open(temp, 'wx');
    try {
      const created = await fd.stat({ bigint: true });
      await this.context.boundary?.('replacement-temp-created');
      await this.check();
      await fd.writeFile(payload);
      await this.context.boundary?.('replacement-temp-written');
      await this.check(payload.length);
      await fd.sync();
      await this.context.boundary?.('replacement-temp-flushed');
      const stamp = await this.fingerprint(temp);
      if (
        !stamp ||
        stamp.dev !== created.dev.toString() ||
        stamp.ino !== created.ino.toString() ||
        stamp.bytes !== payload.length ||
        stamp.sha256 !== createHash('sha256').update(payload).digest('hex') ||
        (await checkedStat(final))
      )
        throw datasetFailure();
      await this.check();
      await this.checkRenameSource(temp, stamp);
      this.context.assertNoWriters();
      await rename(temp, final);
      await this.context.boundary?.('replacement-record-published');
      if (!equal(stamp, await this.fingerprint(final))) throw datasetFailure();
    } finally {
      await fd.close();
    }
  }
  prepare(): Promise<void> {
    return this.run(async () => {
      const gate = await ensureRecoveryGate(this.scope.userDataRoot, {
        ...this.context,
        check: (_phase, bytes) => this.check(bytes),
      });
      if (
        (await checkedStat(join(this.scope.operationRoot, 'replacement.json'))) ||
        (await checkedStat(join(this.scope.operationRoot, 'replacement.json.tmp')))
      )
        throw datasetFailure();
      for (const name of [...PREVIOUS, GATE])
        if (await checkedStat(this.evidence(name))) throw datasetFailure();
      const previous: Replacement['previous'] = [
        await this.fingerprint(this.source(PREVIOUS[0])),
        await this.fingerprint(this.source(PREVIOUS[1])),
      ];
      if (!equal(gate, await this.fingerprint(this.source(GATE)))) throw datasetFailure();
      await this.write({
        version: 1,
        operationId: this.scope.operationId,
        generation: this.scope.generation,
        gate,
        previous,
      });
    });
  }
  private async placement(
    name: string,
    stamp: Stamp | null,
  ): Promise<'source' | 'archived' | 'absent'> {
    const source = await this.fingerprint(this.source(name));
    const target = await this.fingerprint(this.evidence(name));
    if (stamp === null) {
      if (source || target) throw datasetFailure();
      return 'absent';
    }
    if (equal(stamp, source) && target === null) return 'source';
    if (source === null && equal(stamp, target)) return 'archived';
    throw datasetFailure();
  }
  private async move(
    name: string,
    stamp: Stamp,
    boundary: string,
    assertAuthority?: () => void,
  ): Promise<void> {
    assertAuthority?.();
    if ((await this.placement(name, stamp)) !== 'source') throw datasetFailure();
    await this.context.boundary?.('before-' + boundary);
    await this.check();
    if ((await this.placement(name, stamp)) !== 'source') throw datasetFailure();
    // Target checks may await; recheck the exact source after every other await.
    await this.checkRenameSource(this.source(name), stamp);
    this.context.assertNoWriters();
    assertAuthority?.();
    await rename(this.source(name), this.evidence(name));
    await this.context.boundary?.(boundary);
    await this.check();
    if ((await this.placement(name, stamp)) !== 'archived') throw datasetFailure();
  }
  private async checkRenameSource(path: string, stamp: Stamp): Promise<void> {
    const finalSource = await checkedStat(path, 'file');
    if (
      !finalSource ||
      finalSource.dev.toString() !== stamp.dev ||
      finalSource.ino.toString() !== stamp.ino ||
      finalSource.size !== BigInt(stamp.bytes) ||
      finalSource.mtimeNs.toString() !== stamp.mtimeNs
    )
      throw datasetFailure();
  }
  archivePrevious(): Promise<void> {
    return this.run(async () => {
      const record = await this.load();
      if (!equal(record.gate, await this.fingerprint(this.source(GATE)))) throw datasetFailure();
      for (let i = 0; i < PREVIOUS.length; i++)
        await this.placement(PREVIOUS[i]!, record.previous[i]!);
      for (let i = 0; i < PREVIOUS.length; i++) {
        const stamp = record.previous[i]!;
        if ((await this.placement(PREVIOUS[i]!, stamp)) === 'source')
          await this.move(PREVIOUS[i]!, stamp!, `replacement-archived:${i}`);
        if (!equal(record.gate, await this.fingerprint(this.source(GATE)))) throw datasetFailure();
      }
    });
  }
  private async verify(record: Replacement, retired: boolean): Promise<void> {
    const active = await readActiveDataset(this.scope.userDataRoot);
    if (
      !active ||
      active.operationId !== this.scope.operationId ||
      active.generation !== this.scope.generation ||
      active.purpose !== 'restore'
    )
      throw datasetFailure();
    for (let i = 0; i < PREVIOUS.length; i++)
      if (!equal(record.previous[i]!, await this.fingerprint(this.evidence(PREVIOUS[i]!))))
        throw datasetFailure();
    const gate = await this.placement(GATE, record.gate);
    if (gate !== 'source' && !(retired && gate === 'archived')) throw datasetFailure();
    await this.check();
  }
  verifyActive(): Promise<void> {
    return this.run(async () => this.verify(await this.load(), false), 'recovery');
  }
  retireGateAfterCommit(assertCommitted: () => void): Promise<void> {
    return this.run(async () => {
      assertCommitted();
      const record = await this.load();
      await this.verify(record, true);
      if (await checkedStat(join(this.scope.operationRoot, 'journal.json.tmp')))
        throw datasetFailure();
      const raw = await readMetadata(this.scope, 'journal.json');
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw datasetFailure();
      const journal = raw as Record<string, unknown>;
      if (
        journal.version !== 1 ||
        journal.operationId !== this.scope.operationId ||
        journal.generation !== this.scope.generation ||
        journal.phase !== 'committed'
      )
        throw datasetFailure();
      assertCommitted();
      if ((await this.placement(GATE, record.gate)) === 'source') {
        // The synchronous guard is checked again at the final mutation boundary.
        assertCommitted();
        await this.move(GATE, record.gate, 'replacement-gate-retired', assertCommitted);
      }
      assertCommitted();
    }, 'health');
  }
}
