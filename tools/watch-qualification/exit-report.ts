import { boolean, number, type RawObservation } from './read-evidence.ts';
import { ticks, type Verdict, type Window } from './resource-report.ts';

export interface ExitReport {
  verdict: Verdict;
  firstZeroSeconds: number | null;
  consecutiveZeroPoints: number;
  evidenceIssues: string[];
  violations: string[];
  observedSlots: number;
}

/** DB reopening and workload checks remain separate, explicitly required gates. */
export function reportExit(
  window: Window,
  records: readonly RawObservation[],
  mainComplete: boolean,
): ExitReport {
  const issues: string[] = [];
  const violations: string[] = [];
  const slots = new Map<number, { exit?: RawObservation; files?: RawObservation }>();
  const last = window.mode === 'formal' ? 60 : 6;
  let knownDb: string | null = null;
  for (const row of records) {
    if (
      row.kind === 'files' &&
      row.status === 'ok' &&
      row.dbExists === true &&
      typeof row.dbFileId === 'string'
    ) {
      if (knownDb !== null && knownDb !== row.dbFileId) issues.push('数据库身份在窗口内改变');
      knownDb ??= row.dbFileId;
    }
    if (row.phase !== 'drain' || !['exit', 'files'].includes(row.kind)) continue;
    try {
      const begin = Number(ticks(row.beginQpc) - ticks(window.endQpc)) / window.qpcFrequency;
      const end = Number(ticks(row.endQpc) - ticks(window.endQpc)) / window.qpcFrequency;
      const low = row.slot === 0 ? 0 : row.slot * 10 - 2;
      const high = row.slot === last ? last * 10 : row.slot * 10 + 2;
      if (row.slot > last || begin < low || end < begin || end > high || row.status !== 'ok')
        continue;
      // Select the first complete valid observation, not merely the first envelope.
      if (row.kind === 'exit') {
        const exited = boolean(row.rootExited);
        number(row.activeProcesses);
        boolean(row.stdoutEof);
        boolean(row.stderrEof);
        boolean(row.telemetryEof);
        if (exited) number(row.rootExitCode);
        else if (row.rootExitCode !== null) throw new Error('退出码与状态矛盾');
      } else {
        number(row.tempEntries);
        const exists = boolean(row.dbExists);
        boolean(row.walExists);
        boolean(row.shmExists);
        if (exists && (typeof row.dbFileId !== 'string' || typeof row.dbExclusive !== 'boolean'))
          throw new Error('数据库观察不完整');
        if (!exists && row.dbFileId !== null) throw new Error('数据库身份与状态矛盾');
      }
      const slot = slots.get(row.slot) ?? {};
      const key = row.kind as 'exit' | 'files';
      slot[key] ??= row;
      slots.set(row.slot, slot);
    } catch {
      /* Invalid raw observations remain in the source; a later valid one may fill the slot. */
    }
  }
  let firstZeroSeconds: number | null = null;
  let consecutiveZeroPoints = 0;
  let zeroObserved = false;
  for (let index = 0; index <= last; ++index) {
    const slot = slots.get(index);
    // A missing peer metric must never hide an independently observed product failure.
    if (slot?.exit) {
      const row = slot.exit;
      if (row.rootExited && row.rootExitCode !== 0) violations.push('根进程退出码非零');
      if (
        Number(ticks(row.beginQpc) - ticks(window.endQpc)) / window.qpcFrequency >= 60 &&
        (row.rootExited === false || number(row.activeProcesses) > 0)
      )
        violations.push('六十秒后仍有实际存活进程');
    }
    if (slot?.files) {
      const row = slot.files;
      if (
        Number(ticks(row.beginQpc) - ticks(window.endQpc)) / window.qpcFrequency >= 60 &&
        (number(row.tempEntries) > 0 ||
          (row.dbExists && row.dbExclusive === false) ||
          row.walExists ||
          row.shmExists)
      )
        violations.push('六十秒后仍有数据库占用或临时文件');
    }
    if (!slot?.exit || !slot.files) {
      issues.push(`排水slot${index}缺少完整观察`);
      consecutiveZeroPoints = 0;
      continue;
    }
    try {
      const exit = slot.exit;
      const files = slot.files;
      const rootExited = boolean(exit.rootExited);
      const activeProcesses = number(exit.activeProcesses);
      const entries = number(files.tempEntries);
      const exists = boolean(files.dbExists);
      const wal = boolean(files.walExists);
      const shm = boolean(files.shmExists);
      const elapsed =
        Math.max(
          Number(ticks(exit.endQpc) - ticks(window.endQpc)),
          Number(ticks(files.endQpc) - ticks(window.endQpc)),
        ) / window.qpcFrequency;
      if (rootExited && exit.rootExitCode !== 0) violations.push('根进程退出码非零');
      const released = !exists
        ? files.rootAbsent === true && knownDb !== null
        : files.dbExclusive === true &&
          knownDb !== null &&
          files.dbFileId === knownDb &&
          !wal &&
          !shm;
      if (!exists && files.rootAbsent !== true) issues.push('数据库消失但owned根仍在，不能当释放');
      const productZero =
        rootExited &&
        exit.rootExitCode === 0 &&
        activeProcesses === 0 &&
        entries === 0 &&
        released &&
        mainComplete;
      const streamZero =
        boolean(exit.stdoutEof) && boolean(exit.stderrEof) && boolean(exit.telemetryEof);
      if (productZero && !streamZero) issues.push('Job已空但流未完整结束');
      if (productZero && streamZero) {
        firstZeroSeconds ??= elapsed;
        ++consecutiveZeroPoints;
        zeroObserved = true;
      } else {
        if (zeroObserved) violations.push('首次清零之后资源重新出现');
        consecutiveZeroPoints = 0;
      }
    } catch {
      issues.push(`排水slot${index}字段无效`);
    }
  }
  if (!knownDb) issues.push('缺少存活期间的数据库身份');
  if (firstZeroSeconds === null || firstZeroSeconds > 60 || consecutiveZeroPoints < 6)
    issues.push('未在六十秒内观察清零并连续六点保持');
  return {
    verdict: violations.length
      ? 'FAIL-product'
      : issues.length || window.mode === 'short'
        ? 'BLOCKED/evidence-insufficient'
        : 'PASS',
    firstZeroSeconds,
    consecutiveZeroPoints,
    evidenceIssues: [...new Set(issues)],
    violations: [...new Set(violations)],
    observedSlots: slots.size,
  };
}
