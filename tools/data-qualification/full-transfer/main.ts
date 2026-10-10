import { app } from 'electron';
import { join, basename } from 'node:path';
import { readdirSync } from 'node:fs';
import { createTransferFiles } from '../../../src/main/storage/transfer-files';
import { createElectronTransfer } from '../../../src/main/storage/transfer-electron';
import {
  startLifecycleGuardian,
  type LifecycleGuardianHandle,
} from '../../../src/main/storage/lifecycle-guardian';
import {
  CAMPAIGN_MS,
  campaignSpace,
  DB_MEMBERS,
  need,
  requireScopeId,
  sessionNames,
} from './contract';
import { runCampaign } from './campaign';
import { readSmall, writeReceipt, parents, fileFact, same } from './io';
import { verifyInputMetadata, validateInputProof } from './input';
import { classifyFailure, observeThenForward, type Stage } from './observations';
import { countPreparedWork } from './counts-electron';
import { createTrace } from './trace';
import { createTransferProtocol } from '../../../src/main/storage/transfer-protocol';

const scope = join(__dirname, '..'),
  scopeId = basename(scope);
requireScopeId(scopeId);
need(process.versions.electron === '43.7.7');
const started = performance.now(),
  root = join(scope, 'profile');
let failed = false;
let stage: Stage = 'input',
  action: 'backup' | 'restore' | null = null;
let observerFailed = false;
let activeCheck: (() => void) | null = null;
let trace: ReturnType<typeof createTrace> | null = null;
const check = () => {
  need(!failed && performance.now() - started < CAMPAIGN_MS);
};
app.setPath('userData', root);
app.disableHardwareAcceleration();
let guardian: LifecycleGuardianHandle | null = null;
const events: { at: number; event: string; pid?: number; action?: string; frame?: unknown }[] = [];
function record(event: string, fields: Omit<(typeof events)[number], 'at' | 'event'> = {}): void {
  check();
  activeCheck?.();
  need(events.length < 96);
  const value = { at: performance.now() - started, event, ...fields };
  trace?.append(value);
  events.push(value);
}
function safeRecord(
  event: string,
  fields: Omit<(typeof events)[number], 'at' | 'event'> = {},
): void {
  try {
    record(event, fields);
  } catch {
    failed = true;
    observerFailed = true;
  }
}
void app
  .whenReady()
  .then(async () => {
    trace = createTrace(join(scope, 'observations.jsonl'), () => {
      check();
      activeCheck?.();
    });
    record('stage:input');
    const rootCheck = parents(root),
      input = readSmall(join(scope, 'input-proof.json'), check);
    const allocation = readSmall(join(scope, 'transfer-volume.json'), check);
    const disk = allocation.value as { unit: string; available: string };
    need(
      /^[0-9]+$/u.test(disk.unit) &&
        /^[0-9]+$/u.test(disk.available) &&
        BigInt(disk.available) >= campaignSpace(BigInt(disk.unit), []),
    );
    const inputProof = validateInputProof(input.value);
    need(inputProof.scopeId === scopeId);
    verifyInputMetadata(root, inputProof, check);
    stage = 'guardian';
    record('stage:guardian');
    guardian = await startLifecycleGuardian({
      userDataRoot: root,
      executablePath: process.execPath,
      developmentAppRoot: __dirname,
    });
    guardian.onFailure(() => {
      failed = true;
    });
    check();
    record('guardian-ready');
    const realGuardian = guardian;
    const tracked = {
      async authorizeUtility(value: { pid: number; role: 'probe' | 'transfer' }) {
        safeRecord('authorize-start', { pid: value.pid });
        await realGuardian.authorizeUtility(value);
        safeRecord('authorize-ack', { pid: value.pid });
        // Keep the original authorization owned and retireable even if observation failed.
        need(!observerFailed);
      },
      async confirmUtilityExit(pid: number) {
        safeRecord('retire-start', { pid });
        await realGuardian.confirmUtilityExit(pid);
        safeRecord('retire-ack', { pid });
      },
    };
    const files = createTransferFiles({
      productVersion: app.getVersion(),
      guardian: tracked,
      createAdapter(registration) {
        const actual = createElectronTransfer(registration, tracked);
        const observationProtocol = createTransferProtocol(registration.job);
        return {
          ownsProcess: actual.ownsProcess,
          spawn: (job, callbacks) =>
            actual.spawn(job, {
              onMessage(frame) {
                observeThenForward(
                  frame,
                  (value) => {
                    record('protocol', {
                      action: registration.job.action,
                      frame: observationProtocol.receive(value),
                    });
                  },
                  () => {
                    failed = true;
                    observerFailed = true;
                  },
                  callbacks.onMessage,
                );
              },
              onExit(code) {
                observeThenForward(
                  code,
                  () => record('guarded-exit', { action: registration.job.action }),
                  () => {
                    failed = true;
                    observerFailed = true;
                  },
                  callbacks.onExit,
                );
              },
            }),
        };
      },
    });
    const outputs: (() => void)[] = [];
    const actions = await runCampaign({
      root,
      destination: join(scope, 'published.aibak'),
      files,
      check,
      counts: (context) => countPreparedWork(context, tracked, app.getVersion()),
      stage(next, nextAction, operationCheck) {
        stage = next;
        action = nextAction;
        activeCheck = operationCheck;
        record('stage:' + next, { action: nextAction });
      },
      report(receipt, actionCheck) {
        const operationRoot = join(root, 'data-transfer', receipt.operationId.replaceAll('-', ''));
        const paths =
          receipt.action === 'backup'
            ? [
                ...DB_MEMBERS.map((p) => 'work/' + p.split('/')[1]),
                'work/conversations.bin',
                'output.aibak',
              ]
            : [
                ...DB_MEMBERS.map((p) => 'work/' + p.split('/')[1]),
                ...sessionNames().map((name) => 'work/conversations/' + name),
              ];
        const facts = paths.map((path) => {
          actionCheck();
          return { path, identity: fileFact(join(operationRoot, path)) };
        });
        const publication =
          receipt.action === 'backup' ? fileFact(join(scope, 'published.aibak')) : null;
        const verify = () => {
          check();
          need(
            readdirSync(join(operationRoot, 'work')).sort().join('|') ===
              (receipt.action === 'backup'
                ? 'conversations.bin|research.db|sources.db|watch.db'
                : 'conversations|research.db|sources.db|watch.db'),
          );
          if (receipt.action === 'restore')
            need(
              readdirSync(join(operationRoot, 'work/conversations')).sort().join('|') ===
                sessionNames().sort().join('|'),
            );
          for (const item of facts) {
            need(same(item.identity, fileFact(join(operationRoot, item.path))));
          }
          if (publication) need(same(publication, fileFact(join(scope, 'published.aibak'))));
          check();
        };
        const completedReceipt = writeReceipt(
          join(scope, `${receipt.action}-result.json`),
          { ...receipt, outputFacts: facts, publication },
          actionCheck,
        );
        outputs.push(verify, () => completedReceipt(check));
        actionCheck();
        verify();
      },
    });
    activeCheck = null;
    stage = 'finalize';
    record('stage:finalize');
    rootCheck();
    input.verify();
    verifyInputMetadata(root, inputProof, check);
    outputs.forEach((fn) => fn());
    record('stage:finish');
    const observations = trace.close();
    const resultCheck = writeReceipt(
      join(scope, 'campaign-result.json'),
      {
        version: 1,
        scopeId,
        completed: true,
        productE2Pass: false,
        actions: actions.map(({ operationId, action, elapsedMs, childrenExited }) => ({
          operationId,
          action,
          elapsedMs,
          childrenExited,
        })),
        events,
        observations,
      },
      check,
    );
    input.verify();
    allocation.verify();
    rootCheck();
    verifyInputMetadata(root, inputProof, check);
    outputs.forEach((fn) => fn());
    resultCheck();
    check();
    stage = 'finish';
    await realGuardian.finishShutdown();
    check();
    app.exit(0);
  })
  .catch((error: unknown) => {
    failed = true;
    try {
      trace?.close();
    } catch {
      /* The original stage remains in the bounded trace. */
    }
    try {
      writeReceipt(
        join(scope, 'campaign-failure.json'),
        {
          version: 1,
          scopeId,
          failed: true,
          stage,
          action,
          error: classifyFailure(error),
          observerFailed,
          events,
        },
        () => {
          need(performance.now() - started < CAMPAIGN_MS);
        },
      );
    } catch {
      /* Keep the original failure and all owned scopes. */
    }
    guardian?.beginShutdown();
    app.exit(2);
  });
