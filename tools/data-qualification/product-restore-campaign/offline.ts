import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createDatasetScope } from '../../../src/main/storage/dataset-layout';
import { runTransferPipeline } from '../../../src/main/storage/transfer-pipeline';
import { TransferBudget } from '../../../src/main/storage/transfer-budget';
import { createSmallFixture, id, DOMAINS, type Variant } from '../product-restore-fixtures/seed';
import { verifySmallFixture } from '../product-restore-fixtures/oracle';
import { inspectProductBackup } from '../product-transfer/backup-evidence';
import { decodeLedger, type Scene } from '../product-restore-process/protocol';
import { verifyProfileIsolationJournal } from '../../release/profile-isolation-policy';
import { hash, object, parents, read, save } from './files';
import { need } from './contract';

const FOUR = [...DOMAINS, 'conversations'] as const;
const BAD_INDEX = Buffer.from('{"version":1,"sessions":');
async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('目标已经存在，保留并停止');
}
async function copySet(source: string, destination: string, variant: Variant): Promise<void> {
  await parents(source);
  await parents(destination);
  for (const domain of FOUR) {
    const from = join(source, domain),
      to = join(destination, domain);
    await parents(from);
    await absent(to);
    await mkdir(to);
    const expected =
      domain === 'conversations' ? ['index.json', `${id(variant, 9000)}.json`] : [`${domain}.db`];
    need((await readdir(from)).sort().join('|') === expected.sort().join('|'));
    for (const name of expected) {
      const sourcePath = join(from, name),
        targetPath = join(to, name);
      const bytes = await read(sourcePath, 16 * 1024 ** 2);
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
      need(hash(await read(targetPath, 16 * 1024 ** 2)) === hash(bytes));
    }
  }
  verifySmallFixture(destination, variant, 'source');
}
async function retired(root: string): Promise<void> {
  const ledger = decodeLedger(
    object(await read(join(root, 'lifecycle-guardian/writers.json'), 4096)),
  );
  need(ledger.main === null && ledger.utility === null);
}
/** Fixed offline subcommands. The runner additionally owns a native retirement proof before reads/moves. */
export async function offline(
  command: string,
  scene: Scene,
  appData: string,
  journal: string,
): Promise<void> {
  const profile = verifyProfileIsolationJournal(appData, journal);
  need(profile.version === 2);
  const manifest = object(await read(join(journal, 'manifest.json')));
  need(typeof manifest.ResolvedProfile === 'string');
  const root = resolve(manifest.ResolvedProfile),
    evidence = join(journal, 'runner-output/restore-campaign');
  await parents(root);
  await parents(evidence);
  const verifyRoot = () =>
    need(
      verifyProfileIsolationJournal(appData, journal).syntheticFileId === profile.syntheticFileId,
    );
  verifyRoot();
  if (command === 'prepare') {
    need((await readdir(root)).join('|') === '.aibrowse-e1-synthetic-owner.json');
    const fixtureRoot = join(evidence, 'fixtures');
    await mkdir(fixtureRoot);
    for (const variant of scene === 'R' ? (['A', 'B'] as const) : (['A', 'H'] as const)) {
      createSmallFixture(join(fixtureRoot, variant), variant);
      await save(
        join(evidence, `fixture-${variant}.json`),
        verifySmallFixture(join(fixtureRoot, variant), variant, 'source'),
      );
    }
    if (scene === 'P') {
      const h = join(fixtureRoot, 'H'),
        budget = new TransferBudget();
      const operationId = randomUUID();
      const check = () => budget.check();
      const scope = await createDatasetScope(
        {
          userDataRoot: h,
          operationId: operationId.replaceAll('-', ''),
          generation: randomUUID().replaceAll('-', ''),
          purpose: 'backup',
        },
        { check, requireRollbackSpace: check },
      );
      await runTransferPipeline({
        scope,
        job: { operationId, snapshotId: randomUUID(), action: 'backup' },
        productVersion: '0.1.0',
        selectedInput: null,
        control: { signal: new AbortController().signal, deadline: performance.now() + 150_000 },
        enterPhase: async (phase) => budget.enter(phase),
        nowIso: new Date().toISOString(),
      });
      const target = join(evidence, 'synthetic-H.aibak');
      await copyFile(join(scope.operationRoot, 'output.aibak'), target, constants.COPYFILE_EXCL);
      const wire = await inspectProductBackup(target, performance.now() + 30_000);
      need(wire.members.every((member) => member.present && member.bytes > 0));
      await save(join(evidence, 'synthetic-H-wire.json'), {
        origin: '受控合成生产管线备份',
        ...wire,
      });
      verifySmallFixture(h, 'H', 'source');
    }
    await copySet(join(fixtureRoot, 'A'), root, 'A');
    if (scene === 'P') {
      const index = join(root, 'conversations/index.json');
      await rename(index, join(root, 'restore-campaign-healthy-A-index.json'));
      // The intentionally malformed file is created once; every later phase preserves its bytes.
      const file = await open(index, 'wx');
      try {
        await file.writeFile(BAD_INDEX);
        await file.sync();
      } finally {
        await file.close();
      }
      await save(join(evidence, 'bad-index-proof.json'), {
        bytes: BAD_INDEX.length,
        sha256: hash(BAD_INDEX),
      });
    }
  } else if (command === 'install-b') {
    need(scene === 'R');
    await retired(root);
    verifySmallFixture(root, 'A', 'source');
    const preserved = join(root, 'restore-campaign-preserved-A');
    await absent(preserved);
    await mkdir(preserved);
    for (const domain of FOUR) {
      verifyRoot();
      await parents(join(root, domain));
      await absent(join(preserved, domain));
      await rename(join(root, domain), join(preserved, domain));
    }
    verifySmallFixture(preserved, 'A', 'source');
    await copySet(join(evidence, 'fixtures/B'), root, 'B');
  } else if (command === 'backup') {
    need(scene === 'R');
    const wire = await inspectProductBackup(
      join(evidence, 'product-A.aibak'),
      performance.now() + 30_000,
    );
    need(wire.members.every((member) => member.present && member.bytes > 0));
    await save(join(evidence, 'product-A-wire.json'), wire);
  } else if (command === 'recovery-entry') {
    need(scene === 'P');
    need(
      (await read(join(root, 'data-transfer/recovery-gate'), 4096)).toString() ===
        'AIbrowse recovery barrier\n',
    );
    need(hash(await read(join(root, 'conversations/index.json'))) === hash(BAD_INDEX));
    await save(join(evidence, 'recovery-entry.json'), {
      gatePresent: true,
      badIndexPreserved: true,
      storeClaim: '固定恢复UI、gate与绑定的产品装配路径联合证明；不直接检查活Store',
    });
  } else if (command === 'verify' || command === 'verify-cold') {
    await retired(root);
    const variant = scene === 'R' ? 'A' : 'H';
    const semantic = verifySmallFixture(root, variant, 'restored');
    if (command === 'verify-cold') {
      const previous = object(await read(join(evidence, 'verify-oracle.json')));
      need(
        JSON.stringify(previous.hashes) === JSON.stringify(semantic.hashes),
        '普通冷启动改变恢复后的业务集合',
      );
    }
    const transfers = join(root, 'data-transfer');
    await absent(join(transfers, 'active.json'));
    await absent(join(transfers, 'active.json.tmp'));
    await absent(join(transfers, 'recovery-gate'));
    if (command === 'verify') {
      const candidates: string[] = [];
      const names = await readdir(transfers);
      need(names.length <= 32);
      for (const name of names) {
        if (!/^[a-f0-9]{32}$/u.test(name)) continue;
        const operation = join(transfers, name);
        await parents(operation);
        const owner = object(await read(join(operation, 'owner.json'), 4096));
        if (owner.purpose === 'restore') candidates.push(operation);
      }
      need(candidates.length === 1);
      const rollback = join(candidates[0]!, 'rollback');
      await parents(rollback);
      need((await readdir(rollback)).sort().join('|') === [...FOUR].sort().join('|'));
      if (scene === 'R') {
        const projection = join(evidence, 'rollback-B');
        await mkdir(projection);
        for (const domain of DOMAINS) {
          await mkdir(join(projection, domain));
          await copyFile(
            join(rollback, domain),
            join(projection, domain, `${domain}.db`),
            constants.COPYFILE_EXCL,
          );
        }
        await mkdir(join(projection, 'conversations'));
        for (const name of ['index.json', `${id('B', 9000)}.json`])
          await copyFile(
            join(rollback, 'conversations', name),
            join(projection, 'conversations', name),
            constants.COPYFILE_EXCL,
          );
        await save(
          join(evidence, 'rollback-B-oracle.json'),
          verifySmallFixture(projection, 'B', 'source'),
        );
      } else {
        need(hash(await read(join(rollback, 'conversations/index.json'))) === hash(BAD_INDEX));
        await save(join(evidence, 'rollback-bad-index.json'), {
          preserved: true,
          sha256: hash(BAD_INDEX),
        });
      }
    }
    await save(join(evidence, `${command}-oracle.json`), semantic);
  } else throw new Error('不支持的固定离线动作');
  verifyRoot();
}
