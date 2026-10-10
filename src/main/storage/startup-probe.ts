import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BigIntStats } from 'node:fs';
import { checkedStat } from './dataset-layout';
import { checkTransferControl, type OperationControl } from './backup-container';
import {
  inspectNativeTransferParents,
  recheckNativeTransferParents,
} from './native-transfer-selection';
import { validateTransferSchema } from './transfer-schema';
import {
  STARTUP_PROBE_DOMAINS,
  STARTUP_PROBE_VERSIONS,
  StartupProbeError,
  type StartupProbeResult,
  type StartupProbeMember,
  type StartupDirectoryIdentity,
  type StartupFileIdentity,
  type StartupProbeDomain,
} from './startup-probe-protocol';

const directoryIdentity = (stat: BigIntStats): StartupDirectoryIdentity => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
});
const fileIdentity = (stat: BigIntStats | null): StartupFileIdentity | null =>
  stat
    ? {
        ...directoryIdentity(stat),
        size: String(stat.size),
        mtimeNs: String(stat.mtimeNs),
        ctimeNs: String(stat.ctimeNs),
      }
    : null;
async function inspect(
  root: string,
  check: () => void,
): Promise<{ root: StartupDirectoryIdentity; members: StartupProbeMember[] }> {
  check();
  const parents = await inspectNativeTransferParents(root, check);
  check();
  const rootStat = await checkedStat(root, 'directory');
  check();
  if (!rootStat) throw new StartupProbeError();
  const members: StartupProbeMember[] = [];
  for (const id of STARTUP_PROBE_DOMAINS) {
    const path = join(root, id, `${id}.db`);
    const directory = await checkedStat(join(root, id), 'directory');
    check();
    const db = await checkedStat(path, 'file');
    check();
    const wal = await checkedStat(path + '-wal', 'file');
    check();
    const journal = await checkedStat(path + '-journal', 'file');
    check();
    const shm = await checkedStat(path + '-shm', 'file');
    check();
    if ((!db && (wal || journal || shm)) || (!directory && db)) throw new StartupProbeError();
    members.push({
      id,
      state: 'missing',
      version: null,
      directory: directory ? directoryIdentity(directory) : null,
      database: fileIdentity(db),
      wal: fileIdentity(wal),
      journal: fileIdentity(journal),
    });
  }
  await recheckNativeTransferParents(parents, check);
  check();
  return { root: directoryIdentity(rootStat), members };
}
function equalFiles(
  a: Awaited<ReturnType<typeof inspect>>,
  b: Awaited<ReturnType<typeof inspect>>,
): boolean {
  return (
    JSON.stringify({
      root: a.root,
      members: a.members.map(({ id, directory, database, wal, journal }) => ({
        id,
        directory,
        database,
        wal,
        journal,
      })),
    }) ===
    JSON.stringify({
      root: b.root,
      members: b.members.map(({ id, directory, database, wal, journal }) => ({
        id,
        directory,
        database,
        wal,
        journal,
      })),
    })
  );
}
/** Main may call this metadata-only check after actual probe exit, before any Store opens. */
export async function assertStartupProbeInputs(
  root: string,
  result: Extract<StartupProbeResult, { state: 'normal' | 'migrate' }>,
  check: () => void,
): Promise<void> {
  try {
    if (!equalFiles(result, await inspect(root, check))) throw new StartupProbeError();
    check();
  } catch {
    throw new StartupProbeError();
  }
}
/** Utility only. Never opens a writer, changes journal mode, repairs or migrates originals. */
export async function runStartupProbe(
  root: string,
  control: OperationControl,
): Promise<StartupProbeResult> {
  let domain: StartupProbeDomain | null = null;
  const check = (): void => checkTransferControl(control);
  try {
    const receipt = await inspect(root, check);
    let migrate = false;
    for (const member of receipt.members) {
      domain = member.id;
      check();
      if (member.database === null) continue;
      const db = new DatabaseSync(join(root, member.id, `${member.id}.db`), {
        readOnly: true,
        allowExtension: false,
        defensive: true,
        enableForeignKeyConstraints: true,
        enableDoubleQuotedStringLiterals: false,
        timeout: 0,
      });
      try {
        db.exec(
          'PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-8192;',
        );
        if (
          db.prepare('PRAGMA trusted_schema').get()?.trusted_schema !== 0 ||
          db.prepare('PRAGMA query_only').get()?.query_only !== 1 ||
          db.prepare('PRAGMA temp_store').get()?.temp_store !== 2 ||
          db.prepare('PRAGMA cache_size').get()?.cache_size !== -8192 ||
          db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1
        )
          return { state: 'recovery-required', code: 'io', domain };
        for (const row of db.prepare('PRAGMA compile_options').iterate())
          if (row.compile_options === 'TEMP_STORE=0')
            return { state: 'recovery-required', code: 'io', domain };
        db.exec('BEGIN');
        const version = db.prepare('PRAGMA user_version').get()?.user_version;
        if (typeof version === 'number' && version > STARTUP_PROBE_VERSIONS[member.id])
          return { state: 'recovery-required', code: 'future', domain };
        const schema = validateTransferSchema(db, member.id);
        check();
        if (!schema.ok) return { state: 'recovery-required', code: 'schema', domain };
        if (db.prepare('PRAGMA quick_check(1)').get()?.quick_check !== 'ok')
          return { state: 'recovery-required', code: 'integrity', domain };
        check();
        if (!db.prepare('PRAGMA foreign_key_check').iterate().next().done)
          return { state: 'recovery-required', code: 'integrity', domain };
        check();
        member.version = schema.version;
        member.state =
          schema.version === 0
            ? 'empty'
            : schema.version === STARTUP_PROBE_VERSIONS[member.id] && schema.variant === 'current'
              ? 'current'
              : 'legacy';
        migrate ||= member.state === 'legacy';
      } finally {
        db.close();
      }
      check();
      // SQLite may create an empty WAL while reopening a clean, closed WAL-mode
      // database read-only. Bind that one auxiliary creation immediately after
      // this handle closes; all original business facts remain immutable.
      const observedWal = fileIdentity(
        await checkedStat(join(root, member.id, `${member.id}.db-wal`), 'file'),
      );
      check();
      const boundWal = member.wal === null && observedWal?.size === '0' ? observedWal : member.wal;
      const bound = {
        ...receipt,
        members: receipt.members.map((entry) =>
          entry === member ? { ...entry, wal: boundWal } : entry,
        ),
      };
      if (!equalFiles(bound, await inspect(root, check)))
        return { state: 'recovery-required', code: 'input-changed', domain };
      member.wal = boundWal;
      check();
    }
    if (!equalFiles(receipt, await inspect(root, check)))
      return { state: 'recovery-required', code: 'input-changed', domain: null };
    check();
    return { state: migrate ? 'migrate' : 'normal', ...receipt };
  } catch {
    return {
      state: 'recovery-required',
      code: control.signal.aborted
        ? 'cancelled'
        : performance.now() >= control.deadline
          ? 'deadline'
          : 'io',
      domain,
    };
  }
}
