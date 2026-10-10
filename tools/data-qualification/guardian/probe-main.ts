import { app, utilityProcess } from 'electron';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startLifecycleGuardian } from '../../../src/main/storage/lifecycle-guardian';
import { createElectronStartupProbe } from '../../../src/main/storage/startup-probe-electron';
import { superviseStartupProbe } from '../../../src/main/storage/startup-probe-supervisor';
import { TransferBudget } from '../../../src/main/storage/transfer-budget';

// This isolated app has no Stores, renderer, BrowserWindow, Provider or network task.
const root = app.getAppPath();
const profile = join(root, 'profile');
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
let iteration = -1,
  records = 0;
function record(event: string, code: number | null = null): void {
  if (++records > 400) throw new Error('诊断记录预算超限');
  appendFileSync(
    join(root, 'observations.jsonl'),
    JSON.stringify({ iteration, event, code, ms: performance.now() }) + '\n',
  );
}
const fork = utilityProcess.fork.bind(utilityProcess);
Object.assign(utilityProcess, {
  fork: (...args: Parameters<typeof utilityProcess.fork>) => {
    const child = fork(...args);
    child.on('spawn', () => record('native-spawn'));
    child.on('message', () => record('native-message'));
    child.on('exit', (code) => record('native-exit', code));
    return child;
  },
});
void app
  .whenReady()
  .then(async () => {
    const guardian = await startLifecycleGuardian({
      userDataRoot: profile,
      executablePath: process.execPath,
      developmentAppRoot: root,
    });
    record('guardian-ready');
    const observed = {
      authorizeUtility: async (input: Parameters<typeof guardian.authorizeUtility>[0]) => {
        record('authorize-start');
        await guardian.authorizeUtility(input);
        record('authorize-ack');
      },
      confirmUtilityExit: async (pid: number) => {
        record('retire-start');
        await guardian.confirmUtilityExit(pid);
        record('retire-ack');
      },
    };
    const stopAt = performance.now() + 25_000;
    for (iteration = 0; iteration < 20; iteration++) {
      if (performance.now() >= stopAt) throw new Error('诊断总预算超限');
      const operationId = randomUUID();
      const adapter = createElectronStartupProbe(
        { version: 1, operationId, userDataRoot: profile },
        observed,
      );
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), Math.max(1, stopAt - performance.now()));
      const probe = superviseStartupProbe({
        operationId,
        budget: new TransferBudget(),
        signal: abort.signal,
        spawn: adapter.spawn,
      });
      const result = await probe.done;
      clearTimeout(timer);
      if (
        result.state !== 'succeeded' ||
        result.result.state !== 'normal' ||
        adapter.ownsProcess() ||
        probe.ownsChild()
      )
        throw new Error('诊断探针未完成');
      record('probe-complete');
    }
    await guardian.finishShutdown();
    writeFileSync(
      join(root, 'completed.json'),
      JSON.stringify({ completed: true, probes: iteration }),
    );
    app.exit(0);
  })
  .catch(() => {
    record('fixture-failed');
    app.exit(2);
  });
