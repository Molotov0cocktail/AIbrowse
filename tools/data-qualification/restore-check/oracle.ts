import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { createSmallFixture, DOMAINS, id, type Variant } from '../product-restore-fixtures/seed';
import {
  readSmallSnapshot,
  snapshotHashes,
  verifySmallFixture,
} from '../product-restore-fixtures/oracle';
import { EXPECTED } from '../product-restore-fixtures/expected';
import { inspectProductBackup } from '../product-transfer/backup-evidence';
import { createDatasetScope } from '../../../src/main/storage/dataset-layout';
import { runTransferPipeline } from '../../../src/main/storage/transfer-pipeline';
import { TransferBudget } from '../../../src/main/storage/transfer-budget';
import { need, readControl, scopeAt, writeNew } from './contract';
import { verifyRuntimeSnapshot, type RuntimeAudit } from './runtime-oracle';

const scope = scopeAt(__dirname);
const control = readControl(join(scope, 'control.json'));
const profile = join(scope, 'profile');
const domains = [...DOMAINS, 'conversations'] as const;
const badIndex = '{"version":1,"sessions":';
const command = process.argv[2];
need(process.argv.length === 3 && typeof command === 'string' && /^v24\./u.test(process.version));
const check = () => need(Date.now() < control.deadline, '固定场景期限已过');
function copyFileBound(source: string, target: string): { bytes: number; sha256: string } {
  const stat = lstatSync(source);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= 16 * 1024 ** 2);
  const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const before = hash(source);
  copyFileSync(source, target, 1);
  need(hash(target) === before && hash(source) === before, '原件与离线副本字节不符');
  return { bytes: stat.size, sha256: before };
}
function retired(): void {
  const v = JSON.parse(
    readFileSync(join(profile, 'lifecycle-guardian/writers.json'), 'utf8'),
  ) as Record<string, unknown>;
  need(v.main === null && v.utility === null, 'writer账本未退休');
  check();
}
function copySet(source: string, target: string, variant: Variant): void {
  need(!existsSync(target));
  mkdirSync(target);
  let total = 0;
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const domain of domains) {
    const from = join(source, domain),
      to = join(target, domain);
    const expected =
      domain === 'conversations' ? ['index.json', `${id(variant, 9000)}.json`] : [`${domain}.db`];
    need(
      JSON.stringify(readdirSync(from).sort()) === JSON.stringify(expected.sort()),
      '业务文件集合或sidecar不符',
    );
    mkdirSync(to);
    for (const name of expected) {
      const file = join(from, name),
        stat = lstatSync(file);
      total += stat.size;
      need(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && total <= 16 * 1024 ** 2);
      files[`${domain}/${name}`] = copyFileBound(file, join(to, name));
    }
  }
  check();
  writeNew(`${target}-files.json`, {
    source: relative(scope, source),
    copy: relative(scope, target),
    files,
  });
}
function runtimeSnapshot(
  copy: string,
  variant: Variant,
  count: number,
  inherited: readonly RuntimeAudit[] = [],
) {
  const value = readSmallSnapshot(copy, variant);
  return {
    bytes: value.bytes,
    ...verifyRuntimeSnapshot(
      value.snapshot,
      variant,
      variant === 'H' ? 'restored' : 'source',
      count,
      control.deadline - 600_000,
      Date.now(),
      inherited,
    ),
  };
}
async function main(): Promise<void> {
  if (command === 'diagnose-a') {
    // A separate read-only investigation copies only the owned, fully exited
    // failed scene. It never re-enters or continues that product campaign.
    const result = JSON.parse(readFileSync(join(scope, 'result.json'), 'utf8')) as {
      completed: unknown;
      jobs: Array<{ job: { ActualZero: unknown } }>;
    };
    need(result.completed === false && result.jobs.every((job) => job.job.ActualZero === true));
    const source = join(scope, 'preserved-A'),
      copy = join(scope, 'diagnostic-A-copy');
    mkdirSync(copy);
    for (const domain of domains) {
      mkdirSync(join(copy, domain));
      const expected =
        domain === 'conversations' ? ['index.json', `${id('A', 9000)}.json`] : [`${domain}.db`];
      if (domain !== 'conversations') {
        need(lstatSync(join(source, domain, `${domain}.db-wal`)).size === 0);
        need(lstatSync(join(source, domain, `${domain}.db-shm`)).size === 32768);
      }
      for (const name of expected)
        copyFileSync(join(source, domain, name), join(copy, domain, name), 1);
    }
    const actual = readSmallSnapshot(copy, 'A'),
      hashes = snapshotHashes(actual.snapshot);
    const mismatch = Object.keys(hashes).filter((key) => hashes[key] !== EXPECTED.A[key]);
    writeNew(join(scope, 'diagnostic-A.json'), {
      mismatch,
      hashes,
      rows: Object.fromEntries(mismatch.map((key) => [key, actual.snapshot[key]])),
    });
    return;
  }
  check();
  if (command === 'prepare') {
    need(!existsSync(profile));
    for (const variant of control.scene === 'R' ? (['A', 'B'] as const) : (['A', 'H'] as const)) {
      const path = join(scope, `fixture-${variant}`);
      createSmallFixture(path, variant);
      writeNew(join(scope, `fixture-${variant}.json`), verifySmallFixture(path, variant, 'source'));
    }
    copySet(join(scope, 'fixture-A'), profile, 'A');
    if (control.scene === 'P') {
      renameSync(
        join(profile, 'conversations/index.json'),
        join(scope, 'healthy-index-original.json'),
      );
      writeFileSync(join(profile, 'conversations/index.json'), badIndex, { flag: 'wx' });
      const root = join(scope, 'fixture-H'),
        budget = new TransferBudget();
      const operationId = randomUUID();
      const transferScope = await createDatasetScope(
        {
          userDataRoot: root,
          operationId: operationId.replaceAll('-', ''),
          generation: randomUUID().replaceAll('-', ''),
          purpose: 'backup',
        },
        { check, requireRollbackSpace: check },
      );
      await runTransferPipeline({
        scope: transferScope,
        job: { operationId, snapshotId: randomUUID(), action: 'backup' },
        productVersion: '0.1.0',
        selectedInput: null,
        control: {
          signal: new AbortController().signal,
          deadline: performance.now() + Math.min(120_000, control.deadline - Date.now()),
        },
        enterPhase: async (phase) => budget.enter(phase),
        nowIso: new Date().toISOString(),
      });
      copyFileSync(
        join(transferScope.operationRoot, 'output.aibak'),
        join(scope, 'synthetic-H.aibak'),
        1,
      );
      writeNew(
        join(scope, 'synthetic-H-wire.json'),
        await inspectProductBackup(join(scope, 'synthetic-H.aibak'), performance.now() + 30_000),
      );
    }
    writeNew(join(scope, 'prepare-complete.json'), { scene: control.scene, prepared: true });
    return;
  }
  retired();
  if (command === 'boot') {
    writeNew(join(scope, 'boot-retired.json'), { retired: true });
    return;
  }
  if (command === 'install-b') {
    need(control.scene === 'R');
    writeNew(
      join(scope, 'product-A-wire.json'),
      await inspectProductBackup(join(scope, 'product-A.aibak'), performance.now() + 30_000),
    );
    const preserved = join(scope, 'preserved-A');
    mkdirSync(preserved);
    for (const domain of domains) renameSync(join(profile, domain), join(preserved, domain));
    const readCopy = join(scope, 'preserved-A-oracle-copy');
    copySet(preserved, readCopy, 'A');
    writeNew(join(scope, 'preserved-A-oracle.json'), runtimeSnapshot(readCopy, 'A', 2));
    const copy = join(scope, 'install-B');
    copySet(join(scope, 'fixture-B'), copy, 'B');
    for (const domain of domains) renameSync(join(copy, domain), join(profile, domain));
    writeNew(join(scope, 'install-b-complete.json'), { installed: true });
    return;
  }
  need(command === 'verify' || command === 'verify-cold');
  const variant = control.scene === 'R' ? 'A' : 'H';
  const copy = join(scope, `${command}-copy`);
  copySet(profile, copy, variant);
  const inherited: RuntimeAudit[] =
    command === 'verify-cold'
      ? (
          JSON.parse(readFileSync(join(scope, 'verify-complete.json'), 'utf8')) as {
            audits: RuntimeAudit[];
          }
        ).audits
      : control.scene === 'R'
        ? (
            JSON.parse(readFileSync(join(scope, 'preserved-A-oracle.json'), 'utf8')) as {
              audits: RuntimeAudit[];
            }
          ).audits
        : [];
  const result = runtimeSnapshot(
    copy,
    variant,
    (control.scene === 'R' ? 2 : 0) + (command === 'verify-cold' ? 1 : 0),
    inherited,
  );
  const transfers = join(profile, 'data-transfer');
  for (const name of ['active.json', 'active.json.tmp', 'recovery-gate'])
    need(!existsSync(join(transfers, name)), '恢复状态未退休');
  if (command === 'verify-cold') {
    const previous = JSON.parse(readFileSync(join(scope, 'verify-complete.json'), 'utf8')) as {
      hashes: unknown;
    };
    need(
      JSON.stringify(result.hashes) === JSON.stringify(previous.hashes),
      '普通冷启动改变恢复业务数据',
    );
  } else {
    const restores = readdirSync(transfers)
      .filter((name) => /^[a-f0-9]{32}$/u.test(name))
      .filter((name) => {
        const owner = JSON.parse(readFileSync(join(transfers, name, 'owner.json'), 'utf8')) as {
          purpose: unknown;
        };
        return owner.purpose === 'restore';
      });
    need(restores.length === 1);
    const rollback = join(transfers, restores[0]!, 'rollback');
    if (control.scene === 'P')
      need(
        readFileSync(join(rollback, 'conversations/index.json'), 'utf8') === badIndex,
        '坏索引原件未保留',
      );
    else {
      const old = join(scope, 'rollback-B-copy');
      mkdirSync(old);
      const files: Record<string, { bytes: number; sha256: string }> = {};
      for (const domain of DOMAINS) {
        mkdirSync(join(old, domain));
        files[`${domain}/${domain}.db`] = copyFileBound(
          join(rollback, domain),
          join(old, domain, `${domain}.db`),
        );
      }
      mkdirSync(join(old, 'conversations'));
      for (const name of ['index.json', `${id('B', 9000)}.json`])
        files[`conversations/${name}`] = copyFileBound(
          join(rollback, 'conversations', name),
          join(old, 'conversations', name),
        );
      writeNew(`${old}-files.json`, { source: relative(scope, rollback), files });
      writeNew(join(scope, 'rollback-B.json'), runtimeSnapshot(old, 'B', 2));
    }
  }
  check();
  writeNew(join(scope, `${command}-complete.json`), result);
}
void main().catch((error: unknown) => {
  try {
    writeNew(join(scope, `${command}-failure.json`), {
      command,
      error: error instanceof Error ? error.message : '恢复离线复算失败',
    });
  } catch {
    /* Keep the original failed receipt. */
  }
  console.error(error instanceof Error ? error.message : '恢复离线复算失败');
  process.exitCode = 1;
});
