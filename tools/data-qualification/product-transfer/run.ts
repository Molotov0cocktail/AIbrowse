import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyPackagedDirectory } from '../../release/package-policy.ts';
import { verifyProfileIsolationJournal } from '../../release/profile-isolation-policy.ts';
import {
  ControlledProcessProbeError,
  probeControlledProcessIdentity,
} from '../../release/process-identity-probe.ts';
import { inspectProductBackup } from './backup-evidence.ts';

/** Fixed ProductTransfer runner only. The outer audited lease/Job owns its process tree. */
async function main(): Promise<void> {
  const [packageArg, evidenceArg, appDataArg, journalArg] = process.argv.slice(2);
  if (
    process.platform !== 'win32' ||
    !packageArg ||
    !evidenceArg ||
    !appDataArg ||
    !journalArg ||
    process.argv.length !== 6
  )
    throw new Error('需要固定disposable ProductTransfer入口');
  const packageRoot = resolve(packageArg),
    evidenceRoot = resolve(evidenceArg),
    appData = resolve(appDataArg),
    journal = resolve(journalArg);
  if (evidenceRoot !== join(journal, 'runner-output')) throw new Error('证据目录不属于本次journal');
  const started = performance.now(),
    deadline = started + 480000;
  let workStopped = false;
  const pending = new Map<Promise<unknown>, string>();
  const children = new Set<ChildProcess>();
  const killed = new Set<ChildProcess>();
  const killOwned = (child: ChildProcess): void => {
    if (killed.has(child)) return;
    killed.add(child);
    try {
      child.kill();
    } catch {
      /* Ownership remains with the outer Job. */
    }
  };
  const stopWork = (): void => {
    workStopped = true;
    for (const child of children) killOwned(child);
  };
  const check = () => {
    if (workStopped || performance.now() >= deadline) {
      stopWork();
      throw new Error('本轮固定工作期限耗尽');
    }
  };
  const step = <T>(name: string, work: () => Promise<T>, allowance = 480000): Promise<T> => {
    check();
    const until = Math.min(deadline, performance.now() + allowance);
    // Retain the original Promise after a logical timeout; only settlement removes it.
    let original: Promise<T>;
    try {
      original = work();
    } catch (error) {
      return Promise.reject(error);
    }
    pending.set(original, name);
    void original.then(
      () => pending.delete(original),
      () => pending.delete(original),
    );
    return new Promise<T>((resolveStep, rejectStep) => {
      let finished = false;
      const timer = setTimeout(
        () => {
          if (finished) return;
          finished = true;
          stopWork();
          rejectStep(new Error('本轮固定工作期限耗尽'));
        },
        Math.max(0, until - performance.now()),
      );
      void original.then(
        (value) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          try {
            check();
            if (performance.now() >= until) throw new Error('动作期限耗尽');
            resolveStep(value);
          } catch (error) {
            stopWork();
            rejectStep(error);
          }
        },
        (error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          rejectStep(error);
        },
      );
    });
  };
  const profile = verifyProfileIsolationJournal(appData, journal);
  if (profile.version !== 2) throw new Error('本轮必须使用已资格化disposable实体profile');
  const names = await step('profile-read', () => readdir(join(appData, 'aibrowse')));
  if (names.length !== 1 || names[0] !== '.aibrowse-e1-synthetic-owner.json')
    throw new Error('不是全新自有profile，拒绝运行');
  const runRoot = join(evidenceRoot, 'product-transfer');
  await step('evidence-directory', () => mkdir(runRoot));
  const targetDirectory = join(runRoot, 'published');
  await step('publication-directory', () => mkdir(targetDirectory));
  const target = join(targetDirectory, 'product-backup.aibak');
  const report: Record<string, unknown> = {
    version: 1,
    scenario: 'small-backup-cancel-save-readback',
    ok: false,
    limits: {
      runnerMs: 480000,
      outerJobMs: 600000,
      outerExitMs: 30000,
      uiMs: 30000,
      jobProcesses: 24,
      main: 1,
      guardian: 1,
      chromium: 16,
      utilityIncludingChromiumService: 2,
      toolProcesses: 4,
    },
    nonClaims: ['完整容量', '恢复确认与重启', '独立机器', 'SQLite业务语义', '真实Provider'],
    profile,
  };
  let phase = 'package';
  let product: ChildProcess | null = null;
  let exited = false;
  let exitCode: number | null = null;
  let sequence = 0;
  const save = async (name: string, value: unknown) =>
    writeFile(join(runRoot, name), JSON.stringify(value, null, 2), { flag: 'wx' });
  const sourceHashes = async () => {
    const paths = [
      'tools/data-qualification/product-transfer/run.ts',
      'tools/data-qualification/product-transfer/ui-driver.ps1',
      'tools/data-qualification/product-transfer/NativeSaveControl.cs',
      'tools/data-qualification/product-transfer/NativeSaveButton.cs',
      'tools/data-qualification/product-transfer/job-budget.ps1',
      'tools/data-qualification/product-transfer/JobBudget.cs',
      'tools/data-qualification/product-transfer/backup-evidence.ts',
      'tools/release-profile/disposable-profile.ps1',
      'tools/release-profile/DisposableProfile.cs',
      'tools/release-profile/ProfileIsolation.cs',
      'tools/release-profile/JobProcess.cs',
      'tools/release-profile/ReleaseDataIdentity.cs',
      'tools/release/ProductWindow.cs',
      'tools/release/package-policy.ts',
      'tools/release/profile-isolation-policy.ts',
      'tools/release/process-identity-probe.ts',
    ];
    const values: Record<string, string> = {};
    for (const path of paths)
      values[path] = createHash('sha256')
        .update(await step('source-read', () => readFile(resolve(path))))
        .digest('hex');
    return values;
  };
  const external = async (
    script: string,
    args: string[],
    output: string,
    timeout = 35000,
  ): Promise<Record<string, unknown>> => {
    check();
    const child = spawn('pwsh.exe', ['-NoProfile', '-File', script, ...args, '-Output', output], {
      cwd: resolve('.'),
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    children.add(child);
    const result = await step(
      'helper-exit',
      () =>
        new Promise<{ code: number | null; stderr: string }>((done, fail) => {
          let stderr = '';
          child.stderr?.on('data', (chunk: Buffer) => {
            if (stderr.length < 8192)
              stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length);
          });
          child.once('error', (error) => {
            fail(error);
          });
          child.once('exit', (code) => {
            children.delete(child);
            done({ code, stderr });
          });
        }),
      timeout,
    );
    await step('helper-diagnostic', () =>
      save(`external-${sequence}-stderr.json`, { stderr: result.stderr }),
    );
    if (result.code !== 0) throw new Error('受控外部动作失败，停止本轮');
    check();
    const raw = await step('helper-receipt', () => readFile(output));
    if (raw.length > 65536) throw new Error('动作回执超限');
    return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
  };
  const job = async (apply = false) => {
    const output = join(runRoot, `job-${++sequence}.json`);
    const result = await external(
      resolve('tools/data-qualification/product-transfer/job-budget.ps1'),
      [
        '-RunId',
        profile.runId,
        '-RunnerId',
        String(process.pid),
        '-Executable',
        join(packageRoot, 'AIbrowse.exe'),
        ...(apply ? ['-Apply'] : []),
      ],
      output,
    );
    if (result.hardTotalLimit !== 24) throw new Error('Job进程预算未绑定');
    return result;
  };
  try {
    report.toolSources = await step('source-binding', sourceHashes);
    report.package = await step('package-verification', () => verifyPackagedDirectory(packageRoot));
    check();
    await step('launch-contract', () =>
      save('launch-contract.json', {
        ...report,
        phase,
        productArguments: ['--force-renderer-accessibility'],
        environmentOverrides: [],
        providerCalls: 0,
      }),
    );
    await step('initial-job', () => job(true));
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (
        /^AIBROWSE_/i.test(key) ||
        ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(
          key.toUpperCase(),
        )
      )
        delete env[key];
    phase = 'launch';
    product = spawn(join(packageRoot, 'AIbrowse.exe'), ['--force-renderer-accessibility'], {
      cwd: packageRoot,
      env,
      windowsHide: false,
      stdio: 'ignore',
    });
    children.add(product);
    const processExit = new Promise<void>((done, fail) => {
      product!.once('exit', (code) => {
        children.delete(product!);
        exited = true;
        exitCode = code;
        done();
      });
      product!.once('error', fail);
    });
    // Attach rejection handling before any identity or UI awaits.
    void processExit.catch(() => undefined);
    if (!product.pid) throw new Error('产品没有实际PID');
    const productPid = product.pid;
    const identity = await step('product-identity', () =>
      probeControlledProcessIdentity(journal, productPid, 'ProductOriginal'),
    );
    report.product = identity;
    const ui = async (action: string, extra: string[] = []) => {
      check();
      if (exited) throw new Error('产品提前退出');
      phase = action;
      verifyProfileIsolationJournal(appData, journal);
      const result = await step('ui-helper', () =>
        external(
          resolve('tools/data-qualification/product-transfer/ui-driver.ps1'),
          [
            '-Action',
            action,
            '-ProcessId',
            String(identity.pid),
            '-CreatedFileTime',
            identity.processCreatedFileTime,
            '-Executable',
            identity.imagePath,
            ...extra,
          ],
          join(runRoot, `ui-${++sequence}-${action}.json`),
        ),
      );
      if (result.ok !== true || result.action !== action) throw new Error('UI回执不匹配');
      await step('job-sample', () => job());
      return result;
    };
    await step('open-backup', () => ui('OpenBackup'));
    report.dialogQualification = await step('dialog-qualification', () => ui('InspectSaveDialog'));
    report.cancelAction = await step('cancel-save', () => ui('CancelSave'));
    await step('wait-cancelled', () => ui('WaitCancelled'));
    if ((await step('cancelled-directory', () => readdir(targetDirectory))).length !== 0)
      throw new Error('取消原生选择仍写入目标目录');
    await step('reopen-backup', () => ui('OpenBackup'));
    report.saveAction = await step('save-backup', () => ui('SaveBackup', ['-Target', target]));
    await step('wait-completed', () => ui('WaitCompleted'));
    phase = 'readback';
    report.backup = await step(
      'backup-readback',
      () => inspectProductBackup(target, Math.min(deadline, performance.now() + 150000)),
      150000,
    );
    if (
      (await step('published-directory', () => readdir(targetDirectory))).join(',') !==
      'product-backup.aibak'
    )
      throw new Error('发布目录有未知遗留对象');
    await step('backup-receipt', () => save('backup-readback.json', report.backup));
    await step('close-ui', () => ui('Close'));
    phase = 'exit';
    await step('product-exit', () => processExit, 30000);
    if (exitCode !== 0) throw new Error('产品正常关闭退出码非零');
    report.finalJobSample = await step('final-job', () => job());
    verifyProfileIsolationJournal(appData, journal);
    if (
      JSON.stringify(report.toolSources) !==
      JSON.stringify(await step('final-source-binding', sourceHashes))
    )
      throw new Error('资格工具源码在运行中变化');
    report.ok = true;
  } catch (error) {
    stopWork();
    if (error instanceof ControlledProcessProbeError)
      report.identityProbeFailure = error.diagnostic;
    report.failureType = error instanceof Error ? error.name : 'unknown';
    report.failure = '场景未通过，停止且保留全部原件';
    process.exitCode = 1;
  } finally {
    report.phase = phase;
    report.elapsedMs = performance.now() - started;
    report.productExited = exited;
    report.productExitCode = exitCode;
    report.pendingOriginals = [...pending.values()];
    report.unconfirmedChildren = children.size;
    report.requiresOuterTerminal = true;
    // At expiry, make one best-effort asynchronous diagnostic submission without
    // granting more work time. Its original IO is retained; no exit is inferred.
    const recording = save('report.json', report);
    pending.set(recording, 'terminal-diagnostic');
    void recording.then(
      () => pending.delete(recording),
      () => pending.delete(recording),
    );
    if (!workStopped && performance.now() < deadline) {
      try {
        await step('terminal-diagnostic', () => recording);
      } catch {
        process.exitCode = 1;
      }
    }
    // Never target a name or an arbitrary PID. On failure the outer native Job
    // retains the entire tree until actual zero; this signal uses our owned handle.
    if (product && !exited) killOwned(product);
  }
}
void main().catch((error) => {
  process.stderr.write(
    (error instanceof Error ? error.name : 'Error') + '：资格准备或执行失败，原件保留\n',
  );
  process.exitCode = 1;
});
