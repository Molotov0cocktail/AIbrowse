import { mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Campaign } from './campaign';
import { LIMITS, need, type Ports, type Retirement } from './contract';
import { verifyBinding, type Proof } from './binding';
import { fileHash, object, read, save } from './files';
import { waitStart } from './start';
import { Processes, type OwnedChild } from './process';
import { uiPort, verifyQuiescentJob } from './ui';
import { verifyProfileIsolationJournal } from '../../release/profile-isolation-policy';
import { identity, startObserver, type SuccessorClient } from '../product-restore-process/protocol';
import { startOrdinaryLease } from '../product-restore-lifecycle/protocol';

async function main(): Promise<void> {
  const [sceneArg, scopeArg, packageArg, evidenceArg, appDataArg, journalArg, preflightArg] =
    process.argv.slice(2);
  need(
    process.platform === 'win32' &&
      process.arch === 'x64' &&
      process.argv.length === 9 &&
      (sceneArg === 'R' || sceneArg === 'P') &&
      scopeArg &&
      packageArg &&
      evidenceArg &&
      appDataArg &&
      journalArg &&
      preflightArg &&
      /^(?:0|[1-9][0-9]{0,5})$/u.test(preflightArg) &&
      Number(preflightArg) < LIMITS.offline,
  );
  const scene = sceneArg,
    scope = resolve(scopeArg),
    packageRoot = resolve(packageArg),
    evidence = resolve(evidenceArg),
    appData = resolve(appDataArg),
    journal = resolve(journalArg);
  need(evidence === join(journal, 'runner-output'));
  let preflightElapsedMs = Number(preflightArg);
  const started = performance.now();
  let deadline = started + LIMITS[scene] - preflightElapsedMs;
  const processes = new Processes(() => deadline);
  const leases = new Set<Retirement>(),
    observers = new Set<SuccessorClient>();
  const products: OwnedChild[] = [];
  let campaign: Campaign | null = null;
  let proof: Proof | null = null;
  let ok = false;
  let result: unknown = null;
  let reportWritten = false;
  let productGoneChecks = 0;
  const runRoot = join(evidence, 'restore-campaign');
  const stop = () => processes.stop();
  // The fixed claim is consumed before proof reads, package hashing, or any product/profile action.
  const claim = await open(join(scope, `claim-${scene}.json`), 'wx');
  try {
    await claim.writeFile(JSON.stringify({ version: 1, scene, journal }));
    await claim.sync();
  } finally {
    await claim.close();
  }
  await mkdir(runRoot);
  await mkdir(join(evidence, 'restore-ui'));
  await mkdir(join(evidence, 'restore-native'));
  const profile = verifyProfileIsolationJournal(appData, journal);
  need(profile.version === 2);
  const startup = performance.now();
  preflightElapsedMs = await waitStart(journal, {
    runId: profile.runId,
    scene,
    proofSha256: await fileHash(join(scope, 'build-proof.json'), 2 * 1024 ** 2),
    preflightLowerBound: preflightElapsedMs,
  });
  const handoffAt = performance.now();
  deadline = Math.min(deadline, handoffAt + LIMITS[scene] - preflightElapsedMs);
  const external = (exe: string, args: string[], until: number) =>
    processes.external(exe, args, until);
  const offline = (command: string) =>
    external(
      process.execPath,
      [join(scope, 'offline.cjs'), command, scene, appData, journal],
      Math.min(deadline, performance.now() + LIMITS.offline),
    );
  try {
    const ports: Ports = {
      now: () => performance.now(),
      stop,
      backupA: join(runRoot, 'product-A.aibak'),
      backupH: join(runRoot, 'synthetic-H.aibak'),
      ...uiPort(journal, profile.runId, external),
      async prepare() {
        proof = await verifyBinding(scope, packageRoot);
        await save(join(runRoot, 'launch-contract.json'), {
          version: 1,
          scene,
          limits: LIMITS,
          proof,
          noClaims: ['E2整体通过', '独立Windows环境', '物理磁盘耗尽', '真实Provider'],
          arguments: {
            initial: ['--force-renderer-accessibility'],
            cold: [],
            successor: '产品guardian固定继任参数',
          },
        });
        await external(
          'pwsh.exe',
          [
            '-NoProfile',
            '-File',
            resolve('tools/data-qualification/product-transfer/job-budget.ps1'),
            '-RunId',
            profile.runId,
            '-RunnerId',
            String(process.pid),
            '-Executable',
            join(packageRoot, 'AIbrowse.exe'),
            '-Apply',
            '-Output',
            join(runRoot, 'job-initial.json'),
          ],
          Math.min(deadline, performance.now() + LIMITS.helper),
        );
        const job = object(await read(join(runRoot, 'job-initial.json')));
        need(job.hardTotalLimit === 24 && job.limitFlags === 0x2008);
        await offline('prepare');
      },
      async launch(kind, until) {
        const product = processes.start(
          join(packageRoot, 'AIbrowse.exe'),
          kind === 'cold' ? [] : ['--force-renderer-accessibility'],
          true,
          packageRoot,
        );
        products.push(product);
        need(product.child.pid);
        const pid = product.child.pid;
        const label =
          kind === 'cold' ? 'ProductRestart' : kind === 'B' ? 'ProductSecond' : 'ProductOriginal';
        await external(
          'pwsh.exe',
          [
            '-NoProfile',
            '-File',
            resolve('tools/release-profile/disposable-profile.ps1'),
            '-Action',
            'ProbeProcess',
            '-Journal',
            journal,
            '-ProcessId',
            String(pid),
            '-Label',
            label,
          ],
          until,
        );
        const receipt = object(await read(join(evidence, `process-${label}-${pid}.json`)));
        need(
          receipt.version === 1 &&
            receipt.pid === pid &&
            receipt.label === label &&
            receipt.packageStatus === 15700 &&
            receipt.packageFullName === '' &&
            receipt.probeRootFileId128 === profile.syntheticFileId,
        );
        const initial = identity({
          pid,
          created: receipt.processCreatedFileTime,
          image: receipt.imagePath,
        });
        need(initial.image.toLowerCase() === join(packageRoot, 'AIbrowse.exe').toLowerCase());
        return { identity: initial, bootDeadline: until };
      },
      async holdOrdinary(initial, until) {
        need(proof);
        const lease = await startOrdinaryLease({
          journal,
          appData,
          initial,
          deadline: until,
          executableSha256: proof.executableSha256,
          guardianSha256: proof.guardianSha256,
          bindingSha256: proof.bindingSha256,
          stop,
        });
        leases.add(lease);
        return lease;
      },
      async assertProductGone(until) {
        const output = join(runRoot, `job-quiescent-${productGoneChecks + 1}.json`);
        await external(
          'pwsh.exe',
          [
            '-NoProfile',
            '-File',
            resolve('tools/data-qualification/product-transfer/job-budget.ps1'),
            '-RunId',
            profile.runId,
            '-RunnerId',
            String(process.pid),
            '-Executable',
            join(packageRoot, 'AIbrowse.exe'),
            '-Output',
            output,
          ],
          until,
        );
        verifyQuiescentJob(await read(output));
        need(performance.now() < until);
        productGoneChecks++;
      },
      async observe(initial, until) {
        need(proof);
        const observer = await startObserver({
          journal,
          appData,
          scene,
          initial,
          deadline: Math.min(until, performance.now() + 3_600_000),
          executableSha256: proof.executableSha256,
          guardianSha256: proof.guardianSha256,
          bindingSha256: proof.bindingSha256,
          stop,
        });
        observers.add(observer);
        return observer;
      },
      installB: () => offline('install-b'),
      verifyRecoveryEntry: () => offline('recovery-entry'),
      verify: (_variant, cold) => offline(cold ? 'verify-cold' : 'verify'),
      inspectBackup: () => offline('backup'),
      async finalBinding() {
        for (const product of products) need((await product.closed) === 0);
        for (const lease of leases) need((await lease.closed) === 0 && lease.pendingOwned === 0);
        for (const observer of observers)
          need((await observer.closed) === 0 && observer.pendingOwned === 0);
        await verifyBinding(scope, packageRoot);
        need(
          verifyProfileIsolationJournal(appData, journal).syntheticFileId ===
            profile.syntheticFileId,
        );
      },
    };
    need(handoffAt >= startup);
    campaign = new Campaign(
      scene,
      ports,
      deadline,
      preflightElapsedMs + Math.ceil(performance.now() - handoffAt),
    );
    result = await campaign.run();
    need(performance.now() < deadline && processes.owned.size === 0);
    ok = true;
  } catch {
    campaign?.stop();
    stop();
    process.exitCode = 1;
  } finally {
    const report = {
      version: 1,
      scene,
      ok,
      result,
      elapsedMs: performance.now() - started,
      pending: campaign?.pending.size ?? 0,
      productGoneChecks,
      children: processes.owned.size,
      observers: [...observers].map((client) => client.pendingOwned),
      leases: [...leases].map((client) => client.pendingOwned),
      failure: ok ? 'none' : '场景未通过，停止并保留原件',
      outerJobReleaseRequired: true,
    };
    try {
      const writeReport = async () => {
        await save(join(runRoot, 'child-receipts.json'), processes.diagnostics);
        await save(join(runRoot, 'report.json'), report);
      };
      if (ok && campaign) await campaign.finishEvidence(writeReport);
      else await writeReport();
      need(!ok || performance.now() < deadline);
      reportWritten = true;
    } catch {
      process.exitCode = 1;
      stop();
    }
    // Keep this process and its lease alive until original work and real child closure settle.
    // The external Job is the final bounded closer; this timer grants no new product action.
    if (!ok || !reportWritten) {
      process.exitCode = 1;
      const keepAlive = setInterval(() => {
        if (
          (campaign?.pending.size ?? 0) === 0 &&
          processes.owned.size === 0 &&
          [...observers].every((client) => client.pendingOwned === 0) &&
          [...leases].every((client) => client.pendingOwned === 0)
        )
          clearInterval(keepAlive);
      }, 100);
    }
  }
}
void main().catch(() => {
  process.exitCode = 1;
});
