import { utilityProcess } from 'electron';
import { createGuardedUtilityPort, type UtilityGuardian } from './utility-guardian-port';
import { join } from 'node:path';
import {
  parseStartupProbeRegistration,
  type StartupProbeRegistration,
} from './startup-probe-registration';
export {
  parseStartupProbeRegistration,
  type StartupProbeRegistration,
} from './startup-probe-registration';
import type { StartupProbeSupervisorOptions } from './startup-probe-supervisor';
export function createElectronStartupProbe(
  registration: StartupProbeRegistration,
  guardian: UtilityGuardian,
): {
  spawn: StartupProbeSupervisorOptions['spawn'];
  ownsProcess(): boolean;
} {
  const frozen = parseStartupProbeRegistration(JSON.stringify(registration));
  let attempted = false,
    owned = false;
  return {
    ownsProcess: () => owned,
    spawn(operationId, events) {
      if (attempted || operationId !== frozen.operationId) throw new Error('启动预检世代无效');
      attempted = true;
      owned = true;
      const child = utilityProcess.fork(
        join(__dirname, 'startup-probe-worker.js'),
        [JSON.stringify(frozen)],
        {
          cwd: frozen.userDataRoot,
          serviceName: 'AIbrowse 启动数据预检',
          execArgv: [],
          stdio: 'ignore',
          env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
        },
      );
      return createGuardedUtilityPort(child, guardian, 'probe', events, () => {
        owned = false;
      });
    },
  };
}
