import { mkdir, open, rename, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import {
  TRANSFER_PHASE_MS,
  TRANSFER_WORK_MS,
  type TransferBudgetState,
  type TransferPhase,
} from './transfer-budget';
import {
  DATASET_MEMBERS,
  METADATA_BYTES,
  assertPath,
  assertScope,
  checkedStat,
  datasetFailure,
  fingerprintPath,
  readMetadata,
  sameIdentity,
  type DatasetContext,
  type DatasetFingerprint,
  type DatasetPhase,
  type DatasetScope,
  type NewDatasetFingerprints,
} from './dataset-layout';

type Stamp = [number, string] | null;
type Phase =
  | 'handoff'
  | 'inventory'
  | 'backing-up'
  | 'prepared'
  | 'switching'
  | 'checking-health'
  | 'awaiting-health'
  | 'rolling-back'
  | 'rolled-back'
  | 'committed';
interface Journal {
  version: 1;
  operationId: string;
  generation: string;
  seq: number;
  phase: Phase;
  old: Stamp[] | null;
  next: Stamp[];
  attempts: [number, number, number];
  remaining: [number, number, number, number];
  budget: TransferBudgetState;
}
const BUDGETS = [
  TRANSFER_PHASE_MS.rollbackCopy,
  TRANSFER_PHASE_MS.publish / 2,
  TRANSFER_PHASE_MS.publish / 2,
  TRANSFER_PHASE_MS.boot,
] as const;
const PHASES: readonly Phase[] = [
  'handoff',
  'inventory',
  'backing-up',
  'prepared',
  'switching',
  'checking-health',
  'awaiting-health',
  'rolling-back',
  'rolled-back',
  'committed',
];
const NEXT_PHASES: Record<Phase, readonly Phase[]> = {
  handoff: ['inventory'],
  inventory: ['backing-up'],
  'backing-up': ['prepared', 'rolling-back'],
  prepared: ['switching', 'rolling-back'],
  switching: ['switching', 'checking-health', 'rolling-back'],
  'checking-health': ['awaiting-health', 'rolling-back'],
  'awaiting-health': ['committed', 'rolling-back'],
  'rolling-back': ['rolling-back', 'rolled-back'],
  'rolled-back': [],
  committed: [],
};
export type DatasetSwitchState =
  | 'handoff'
  | 'new-awaiting-health'
  | 'old-restored'
  | 'old-unchanged'
  | 'committed'
  | 'recovery-required';
export type DatasetSwitchCode = 'ok' | 'invalid-state' | 'interrupted' | 'attempt-exhausted';
export interface DatasetSwitchResult {
  state: DatasetSwitchState;
  code: DatasetSwitchCode;
  message: string;
}
const MESSAGES: Record<DatasetSwitchState, string> = {
  handoff: '恢复已登记，正常退出后继续',
  'new-awaiting-health': '新数据已安放，等待服务健康确认',
  'old-restored': '完整旧数据已恢复，失败现场已保留',
  'old-unchanged': '切换未开始，旧数据保持不变',
  committed: '新数据已确认并提交',
  'recovery-required': '无法确认数据一致性，已停止业务写入并保留现场',
};
const outcome = (
  state: DatasetSwitchState,
  code: DatasetSwitchCode = 'ok',
): DatasetSwitchResult => ({ state, code, message: MESSAGES[state] });
const stamp = (value: DatasetFingerprint | null): Stamp =>
  value ? [value.bytes, value.sha256] : null;
const equal = (a: Stamp, b: Stamp): boolean =>
  a === null ? b === null : b !== null && a[0] === b[0] && a[1] === b[1];
const stampsEqual = (a: Stamp[], b: Stamp[]): boolean =>
  a.length === b.length && a.every((s, i) => equal(s, b[i]!));
const keys = (r: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(r).sort().join(',') === expected.sort().join(',');

function budgetState(raw: unknown): TransferBudgetState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw datasetFailure();
  const r = raw as Record<string, unknown>;
  if (
    !keys(r, ['version', 'totalRemainingMs', 'phaseRemainingMs']) ||
    r.version !== 1 ||
    typeof r.totalRemainingMs !== 'number' ||
    !Number.isFinite(r.totalRemainingMs) ||
    r.totalRemainingMs < 0 ||
    r.totalRemainingMs > TRANSFER_WORK_MS ||
    typeof r.phaseRemainingMs !== 'object' ||
    r.phaseRemainingMs === null ||
    Array.isArray(r.phaseRemainingMs)
  )
    throw datasetFailure();
  const phases = r.phaseRemainingMs as Record<string, unknown>;
  if (!keys(phases, Object.keys(TRANSFER_PHASE_MS))) throw datasetFailure();
  const phaseRemainingMs = {} as Record<TransferPhase, number>;
  let rawPhaseTotal = 0;
  for (const name of Object.keys(TRANSFER_PHASE_MS) as TransferPhase[]) {
    const value = phases[name];
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > TRANSFER_PHASE_MS[name]
    )
      throw datasetFailure();
    phaseRemainingMs[name] = Math.floor(value);
    rawPhaseTotal += value;
  }
  // Match TransferBudget's clock-rounding tolerance, then clamp downward below.
  if (r.totalRemainingMs > rawPhaseTotal + 0.000001) throw datasetFailure();
  // Rounding only removes allowance; it never creates time across a process handoff.
  return {
    version: 1,
    totalRemainingMs: Math.min(
      Math.floor(r.totalRemainingMs),
      Object.values(phaseRemainingMs).reduce((a, b) => a + b, 0),
    ),
    phaseRemainingMs,
  };
}

function validStamp(value: unknown): value is Stamp {
  return (
    value === null ||
    (Array.isArray(value) &&
      value.length === 2 &&
      Number.isSafeInteger(value[0]) &&
      value[0] >= 0 &&
      typeof value[1] === 'string' &&
      /^[a-f0-9]{64}$/u.test(value[1]))
  );
}
function validStamps(value: unknown): value is Stamp[] {
  return Array.isArray(value) && value.length === DATASET_MEMBERS.length && value.every(validStamp);
}
function nextStamps(value: unknown): Stamp[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw datasetFailure();
  const r = value as Record<string, unknown>;
  if (!keys(r, ['sources', 'research', 'watch', 'conversations'])) throw datasetFailure();
  const caps = {
    sources: 512 * 1024 ** 2,
    research: 64 * 1024 ** 2,
    watch: 512 * 1024 ** 2,
    conversations: 3201 * 1024 ** 2,
  };
  return DATASET_MEMBERS.map(([id, , name]) => {
    if (!name) return null;
    const v = r[id];
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw datasetFailure();
    const f = v as Record<string, unknown>;
    const s = [f.bytes, f.sha256];
    if (!keys(f, ['bytes', 'sha256']) || !validStamp(s) || !s || s[0] > caps[id])
      throw datasetFailure();
    return s;
  });
}

function decodeJournal(raw: unknown, scope: DatasetScope): Journal {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw datasetFailure();
  const r = raw as Record<string, unknown>;
  if (
    !keys(r, [
      'version',
      'operationId',
      'generation',
      'seq',
      'phase',
      'old',
      'next',
      'attempts',
      'remaining',
      'budget',
    ]) ||
    r.version !== 1 ||
    r.operationId !== scope.operationId ||
    r.generation !== scope.generation ||
    !Number.isSafeInteger(r.seq) ||
    (r.seq as number) < 0 ||
    (r.seq as number) > 256 ||
    !PHASES.includes(r.phase as Phase) ||
    (r.old !== null && !validStamps(r.old)) ||
    !validStamps(r.next) ||
    !Array.isArray(r.attempts) ||
    r.attempts.length !== 3 ||
    !r.attempts.every((v) => v === 0 || v === 1) ||
    !Array.isArray(r.remaining) ||
    r.remaining.length !== 4 ||
    !r.remaining.every((v, i) => v === 0 || v === BUDGETS[i])
  )
    throw datasetFailure();
  const j = r as unknown as Journal;
  const budget = budgetState(j.budget);
  if (JSON.stringify(budget) !== JSON.stringify(j.budget)) throw datasetFailure();
  for (let i = 0; i < DATASET_MEMBERS.length; i++)
    if ((DATASET_MEMBERS[i]![2] === null) !== (j.next[i] === null)) throw datasetFailure();
  nextStamps(
    Object.fromEntries(
      DATASET_MEMBERS.flatMap(([id, , name], i) =>
        name ? [[id, { bytes: j.next[i]![0], sha256: j.next[i]![1] }]] : [],
      ),
    ),
  );
  if (
    j.phase === 'handoff' &&
    (j.old !== null ||
      j.attempts.some((v) => v !== 0) ||
      j.remaining.some((v, i) => v !== BUDGETS[i]))
  )
    throw datasetFailure();
  if (j.phase !== 'handoff' && (j.attempts[0] !== 1 || j.remaining[0] !== 0))
    throw datasetFailure();
  if (!['handoff', 'inventory'].includes(j.phase) && j.old === null) throw datasetFailure();
  if (
    ['checking-health', 'awaiting-health', 'committed'].includes(j.phase) &&
    (j.attempts[1] !== 1 || j.remaining[3] !== 0)
  )
    throw datasetFailure();
  if (j.phase === 'rolling-back' && (j.attempts[2] !== 1 || j.remaining[2] !== 0))
    throw datasetFailure();
  return j;
}

/** Main-only coordinator. Caller holds the application instance lock and keeps
 * all database handles closed and business admission shut during startup/recovery.
 * Registration alone is safe while live stores still exist: it never reads them.
 * Path checks detect links/replacements; they are not an OS sandbox against a
 * concurrent same-account filesystem adversary. Physical power-loss is not proven.
 */
export class DatasetSwitch {
  private journal: Journal | null = null;
  private healthOwned = false;
  private healthContext: DatasetContext | null = null;
  private busy = false;
  private oldUnchangedOnStop = false;
  private stopped = false;
  constructor(
    readonly scope: DatasetScope,
    readonly context: DatasetContext,
  ) {}

  private async run(work: () => Promise<DatasetSwitchResult>): Promise<DatasetSwitchResult> {
    if (this.busy) return outcome('recovery-required', 'invalid-state');
    this.busy = true;
    this.stopped = false;
    this.oldUnchangedOnStop = false;
    try {
      await assertScope(this.scope);
      const result = await work();
      if (result.state !== 'new-awaiting-health') {
        this.healthOwned = false;
        this.healthContext = null;
      }
      return result;
    } catch {
      this.healthOwned = false;
      this.healthContext = null;
      return this.oldUnchangedOnStop && this.stopped
        ? outcome('old-unchanged', 'interrupted')
        : outcome('recovery-required', 'invalid-state');
    } finally {
      this.busy = false;
    }
  }
  private path(index: number, area: 'live' | 'work' | 'rollback' | 'retired'): string {
    const [id, live, work] = DATASET_MEMBERS[index]!;
    if (area === 'live') return join(this.scope.userDataRoot, live);
    if (area === 'work') {
      if (work === null) throw datasetFailure();
      return join(this.scope.operationRoot, area, work);
    }
    return join(this.scope.operationRoot, area, id);
  }
  private timed(phase: DatasetPhase, ms: number): DatasetContext {
    const deadline = performance.now() + ms;
    return {
      check: async (p, bytes) => {
        try {
          if (p !== phase || performance.now() >= deadline) throw datasetFailure();
          await this.context.check(p, bytes);
          if (performance.now() >= deadline) throw datasetFailure();
        } catch {
          this.stopped = true;
          throw datasetFailure();
        }
      },
      boundary: this.context.boundary,
      requireRollbackSpace: async (bytes) => {
        try {
          await this.context.requireRollbackSpace(bytes);
        } catch {
          this.stopped = true;
          throw datasetFailure();
        }
      },
    };
  }
  private reserve(
    index: number,
    phase: TransferPhase,
  ): { grant: number; budget: TransferBudgetState; remaining: Journal['remaining'] } {
    if (!this.journal) throw datasetFailure();
    const budget = budgetState(this.journal.budget);
    const grant = Math.min(
      this.journal.remaining[index]!,
      budget.totalRemainingMs,
      budget.phaseRemainingMs[phase],
    );
    if (grant <= 0) throw datasetFailure();
    budget.totalRemainingMs -= grant;
    budget.phaseRemainingMs[phase] -= grant;
    const remaining: Journal['remaining'] = [...this.journal.remaining];
    remaining[index] = 0;
    return { grant, budget, remaining };
  }
  async readBudgetState(): Promise<TransferBudgetState | null> {
    const journal = await this.load();
    return journal ? budgetState(journal.budget) : null;
  }
  private async load(): Promise<Journal | null> {
    await assertScope(this.scope);
    const raw = await readMetadata(this.scope, 'journal.json');
    let journal = raw === null ? null : decodeJournal(raw, this.scope);
    const temporary = await readMetadata(this.scope, 'journal.json.tmp');
    if (temporary !== null) {
      const next = decodeJournal(temporary, this.scope);
      if (
        journal === null
          ? next.seq !== 0 || next.phase !== 'handoff'
          : next.seq !== journal.seq + 1 ||
            !stampsEqual(next.next, journal.next) ||
            (journal.old !== null && (next.old === null || !stampsEqual(journal.old, next.old))) ||
            next.remaining.some((v, i) => v > journal!.remaining[i]!) ||
            next.attempts.some((v, i) => v < journal!.attempts[i]!) ||
            !NEXT_PHASES[journal.phase].includes(next.phase) ||
            next.budget.totalRemainingMs > journal.budget.totalRemainingMs ||
            (Object.keys(TRANSFER_PHASE_MS) as TransferPhase[]).some(
              (p) => next.budget.phaseRemainingMs[p] > journal!.budget.phaseRemainingMs[p],
            )
      )
        throw datasetFailure();
      const tempPath = join(this.scope.operationRoot, 'journal.json.tmp');
      await assertPath(this.scope, tempPath);
      const before = await checkedStat(tempPath, 'file');
      const oldPath = join(this.scope.operationRoot, 'journal.json');
      const oldIdentity = await checkedStat(oldPath, 'file');
      if (!before) throw datasetFailure();
      const fd = await open(tempPath, 'r+');
      try {
        if (!sameIdentity(before, await fd.stat({ bigint: true }))) throw datasetFailure();
        await fd.sync();
        await assertPath(this.scope, tempPath);
        const now = await checkedStat(oldPath, 'file');
        const tempNow = await checkedStat(tempPath, 'file');
        if (
          !tempNow ||
          !sameIdentity(before, tempNow) ||
          (oldIdentity ? !now || !sameIdentity(oldIdentity, now) : now !== null)
        )
          throw datasetFailure();
        await rename(tempPath, oldPath);
      } finally {
        await fd.close();
      }
      journal = next;
    }
    this.journal = journal;
    return journal;
  }
  private async write(next: Journal, context: DatasetContext, phase: DatasetPhase): Promise<void> {
    await context.check(phase, 0);
    decodeJournal(next, this.scope);
    const payload = Buffer.from(JSON.stringify(next));
    if (payload.length > METADATA_BYTES) throw datasetFailure();
    const path = join(this.scope.operationRoot, 'journal.json');
    const temp = path + '.tmp';
    await assertPath(this.scope, path);
    const previous = await checkedStat(path, 'file');
    if ((previous === null) !== (this.journal === null)) throw datasetFailure();
    const stored = await readMetadata(this.scope, 'journal.json');
    if (JSON.stringify(stored) !== JSON.stringify(this.journal)) throw datasetFailure();
    const fd = await open(temp, 'wx');
    try {
      const created = await fd.stat({ bigint: true });
      await fd.writeFile(payload);
      await context.boundary?.(`journal-temp-written:${next.seq}`);
      await context.check(phase, payload.length);
      await fd.sync();
      await context.boundary?.(`journal-temp-flushed:${next.seq}`);
      await context.check(phase, payload.length);
      await assertPath(this.scope, path);
      const now = await checkedStat(path, 'file');
      const tempNow = await checkedStat(temp, 'file');
      if (
        !tempNow ||
        !sameIdentity(created, tempNow) ||
        (previous ? !now || !sameIdentity(previous, now) : now !== null)
      )
        throw datasetFailure();
      await rename(temp, path);
      const published = await checkedStat(path, 'file');
      if (!published || !sameIdentity(created, published)) throw datasetFailure();
      this.journal = next;
      await context.boundary?.(`journal-published:${next.seq}`);
      await context.check(phase, payload.length);
    } finally {
      await fd.close();
    }
  }
  private async update(
    change: Partial<Omit<Journal, 'version' | 'operationId' | 'generation' | 'next' | 'seq'>>,
    context: DatasetContext,
    phase: DatasetPhase,
  ): Promise<void> {
    if (!this.journal) throw datasetFailure();
    await this.write({ ...this.journal, ...change, seq: this.journal.seq + 1 }, context, phase);
  }
  private async inspect(
    area: 'live' | 'work' | 'rollback' | 'retired',
    context: DatasetContext,
    phase: DatasetPhase,
    account?: (bytes: number, directory: boolean) => void,
  ): Promise<Stamp[]> {
    const values: Stamp[] = [];
    for (let i = 0; i < DATASET_MEMBERS.length; i++) {
      if (area === 'work' && DATASET_MEMBERS[i]![2] === null) {
        values.push(null);
        continue;
      }
      const path = this.path(i, area);
      await assertPath(this.scope, path);
      await checkedStat(path, i === 12 ? 'directory' : 'file');
      values.push(
        stamp(await fingerprintPath(this.scope, path, context, phase, undefined, 0, account)),
      );
    }
    return values;
  }
  private async move(
    source: string,
    target: string,
    expected: Stamp,
    point: string,
    context: DatasetContext,
    phase: DatasetPhase,
  ): Promise<void> {
    if (expected === null) throw datasetFailure();
    await context.boundary?.(`before-${point}`);
    await context.check(phase, 0);
    await assertPath(this.scope, source);
    await assertPath(this.scope, target);
    const before = await checkedStat(source);
    if (
      !before ||
      (await checkedStat(target)) ||
      !equal(stamp(await fingerprintPath(this.scope, source, context, phase)), expected)
    )
      throw datasetFailure();
    const ready = await checkedStat(source);
    if (!ready || !sameIdentity(before, ready) || (await checkedStat(target)))
      throw datasetFailure();
    this.oldUnchangedOnStop = false;
    await rename(source, target);
    await context.boundary?.(point);
    await context.check(phase, expected[0]);
    const after = await checkedStat(target);
    if (!after || !sameIdentity(before, after) || (await checkedStat(source)))
      throw datasetFailure();
  }
  async registerHandoff(
    expected: NewDatasetFingerprints,
    suspendedBudget: TransferBudgetState,
  ): Promise<DatasetSwitchResult> {
    return this.run(async () => {
      if (this.scope.purpose === 'backup' || (await this.load())) throw datasetFailure();
      const next = nextStamps(expected);
      await this.write(
        {
          version: 1,
          operationId: this.scope.operationId,
          generation: this.scope.generation,
          seq: 0,
          phase: 'handoff',
          old: null,
          next,
          attempts: [0, 0, 0],
          remaining: [...BUDGETS],
          budget: budgetState(suspendedBudget),
        },
        this.context,
        'register',
      );
      return outcome('handoff');
    });
  }
  async resumeAtStartup(): Promise<DatasetSwitchResult> {
    return this.run(async () => {
      let journal = await this.load();
      if (!journal) throw datasetFailure();
      if (journal.phase === 'committed')
        return stampsEqual(await this.inspect('live', this.context, 'health'), journal.next)
          ? outcome('committed')
          : outcome('recovery-required', 'invalid-state');
      if (journal.phase === 'rolled-back')
        return journal.old &&
          stampsEqual(await this.inspect('live', this.context, 'recovery'), journal.old)
          ? outcome('old-restored')
          : outcome('recovery-required', 'invalid-state');
      if (journal.attempts[0] === 0) {
        this.oldUnchangedOnStop = true;
        const reserved = this.reserve(0, 'rollbackCopy');
        const context = this.timed('backup', reserved.grant);
        await this.update(
          {
            phase: 'inventory',
            attempts: [1, 0, 0],
            remaining: reserved.remaining,
            budget: reserved.budget,
          },
          context,
          'backup',
        );
        for (const domain of ['sources', 'research', 'watch']) {
          const parent = join(this.scope.userDataRoot, domain);
          await assertPath(this.scope, parent);
          if (!(await checkedStat(parent, 'directory'))) await mkdir(parent);
        }
        if (!stampsEqual(await this.inspect('work', context, 'backup'), journal.next))
          throw datasetFailure();
        const cluster = Number((await statfs(this.scope.userDataRoot)).bsize);
        if (!Number.isSafeInteger(cluster) || cluster < 1) throw datasetFailure();
        let allocatedBytes = 0;
        const old = await this.inspect('live', context, 'backup', (bytes, directory) => {
          // Full copy allocation is based on logical length, including sparse files.
          // One unit per directory is an admission estimate, not a filesystem reservation.
          allocatedBytes += directory ? cluster : Math.ceil(bytes / cluster) * cluster;
          if (!Number.isSafeInteger(allocatedBytes)) throw datasetFailure();
        });
        await context.requireRollbackSpace(allocatedBytes);
        await context.check('backup', 0);
        const empty = DATASET_MEMBERS.map(() => null);
        if (
          !stampsEqual(await this.inspect('rollback', context, 'backup'), empty) ||
          !stampsEqual(await this.inspect('retired', context, 'backup'), empty)
        )
          throw datasetFailure();
        await this.update({ phase: 'backing-up', old }, context, 'backup');
        for (let i = 0; i < old.length; i++)
          if (old[i]) {
            const copied = await fingerprintPath(
              this.scope,
              this.path(i, 'live'),
              context,
              'backup',
              this.path(i, 'rollback'),
            );
            if (!equal(stamp(copied), old[i]!)) throw datasetFailure();
            await context.boundary?.(`backup-member:${i}`);
          }
        if (
          !stampsEqual(await this.inspect('rollback', context, 'backup'), old) ||
          !stampsEqual(await this.inspect('live', context, 'backup'), old)
        )
          throw datasetFailure();
        await this.update({ phase: 'prepared' }, context, 'backup');
        journal = this.journal!;
        const switchReserve = this.reserve(1, 'publish');
        const switching = this.timed('switch', switchReserve.grant);
        await this.update(
          { phase: 'switching', remaining: switchReserve.remaining, budget: switchReserve.budget },
          switching,
          'switch',
        );
        try {
          for (let i = 0; i < old.length; i++) {
            if (old[i])
              await this.move(
                this.path(i, 'live'),
                this.path(i, 'retired'),
                old[i]!,
                `retired:${i}`,
                switching,
                'switch',
              );
            if (journal.next[i])
              await this.move(
                this.path(i, 'work'),
                this.path(i, 'live'),
                journal.next[i]!,
                `installed:${i}`,
                switching,
                'switch',
              );
            await this.update({}, switching, 'switch');
          }
        } catch {
          return this.recover();
        }
      }
      journal = this.journal!;
      if (['inventory', 'backing-up', 'prepared', 'rolling-back'].includes(journal.phase))
        return this.recover();
      if (journal.attempts[1] !== 0) return outcome('recovery-required', 'attempt-exhausted');
      const healthReserve = this.reserve(3, 'boot');
      const health = this.timed('health', healthReserve.grant);
      await this.update(
        {
          phase: 'checking-health',
          attempts: [1, 1, journal.attempts[2]],
          remaining: healthReserve.remaining,
          budget: healthReserve.budget,
        },
        health,
        'health',
      );
      if (stampsEqual(await this.inspect('live', health, 'health'), journal.next)) {
        await this.update(
          {
            phase: 'awaiting-health',
          },
          health,
          'health',
        );
        this.healthOwned = true;
        this.healthContext = health;
        return outcome('new-awaiting-health');
      }
      return this.recover();
    });
  }
  private async recover(): Promise<DatasetSwitchResult> {
    const journal = await this.load();
    if (
      !journal?.old ||
      journal.phase === 'committed' ||
      journal.attempts[2] !== 0 ||
      journal.remaining[2] !== BUDGETS[2]
    )
      return outcome('recovery-required', 'attempt-exhausted');
    const reserved = this.reserve(2, 'publish');
    const context = this.timed('recovery', reserved.grant);
    await this.update(
      {
        phase: 'rolling-back',
        attempts: [1, journal.attempts[1], 1],
        remaining: reserved.remaining,
        budget: reserved.budget,
      },
      context,
      'recovery',
    );
    const live = await this.inspect('live', context, 'recovery');
    const old = journal.old;
    if (stampsEqual(live, old)) {
      await this.update({ phase: 'rolled-back' }, context, 'recovery');
      return outcome('old-restored');
    }
    const retired = await this.inspect('retired', context, 'recovery');
    const rollback = await this.inspect('rollback', context, 'recovery');
    const work = await this.inspect('work', context, 'recovery');
    // Validate every move before changing any member. Unknown content is retained.
    for (let i = 0; i < old.length; i++) {
      if (retired[i] && !equal(retired[i]!, old[i]!)) throw datasetFailure();
      if (rollback[i] && !equal(rollback[i]!, old[i]!)) throw datasetFailure();
      if (work[i] && !equal(work[i]!, journal.next[i]!)) throw datasetFailure();
      if (equal(live[i]!, old[i]!)) continue;
      if (live[i] && (!equal(live[i]!, journal.next[i]!) || work[i])) throw datasetFailure();
      if (old[i] && !retired[i] && !rollback[i]) throw datasetFailure();
    }
    for (let i = 0; i < old.length; i++) {
      if (equal(live[i]!, old[i]!)) continue;
      if (live[i])
        await this.move(
          this.path(i, 'live'),
          this.path(i, 'work'),
          journal.next[i]!,
          `withdrawn:${i}`,
          context,
          'recovery',
        );
      if (old[i])
        await this.move(
          this.path(i, retired[i] ? 'retired' : 'rollback'),
          this.path(i, 'live'),
          old[i]!,
          `restored:${i}`,
          context,
          'recovery',
        );
      await this.update({}, context, 'recovery');
    }
    if (!stampsEqual(await this.inspect('live', context, 'recovery'), old)) throw datasetFailure();
    await this.update({ phase: 'rolled-back' }, context, 'recovery');
    return outcome('old-restored');
  }
  async rollbackAfterFailure(): Promise<DatasetSwitchResult> {
    return this.run(() => this.recover());
  }
  async commitHealthy(): Promise<DatasetSwitchResult> {
    return this.run(async () => {
      const journal = await this.load();
      if (
        !journal ||
        !this.healthOwned ||
        journal.phase !== 'awaiting-health' ||
        !this.healthContext
      )
        throw datasetFailure();
      const context = this.healthContext;
      await context.check('health', 0);
      if (!stampsEqual(await this.inspect('live', context, 'health'), journal.next))
        throw datasetFailure();
      await this.update({ phase: 'committed', remaining: [0, 0, 0, 0] }, context, 'health');
      this.healthOwned = false;
      return outcome('committed');
    });
  }
}
