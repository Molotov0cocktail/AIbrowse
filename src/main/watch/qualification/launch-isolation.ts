import type { App } from 'electron';
import type { PreparedLaunchIsolation } from './native-contract';

type IsolationApp = Pick<App, 'isReady' | 'setPath' | 'getPath'>;

/** Synchronous only: no default PathService read is permitted before all overrides. */
export function applyQualificationLaunchIsolation(
  app: IsolationApp,
  prepared: PreparedLaunchIsolation,
): void {
  if (app.isReady()) throw new Error('资格隔离启动过迟');
  const { paths } = prepared;
  app.setPath('appData', paths.appDataRoot);
  app.setPath('cache', paths.appDataRoot);
  app.setPath('userData', paths.userDataRoot);
  app.setPath('sessionData', paths.userDataRoot);
  app.setPath('userCache', paths.localAppDataRoot);
  app.setPath('logs', paths.localAppDataRoot);
  app.setPath('crashDumps', paths.processTempRoot);
  app.setPath('temp', paths.processTempRoot);
  if (app.isReady()) throw new Error('资格隔离启动过迟');
  const expected = {
    appData: paths.appDataRoot,
    userData: paths.userDataRoot,
    sessionData: paths.userDataRoot,
    logs: paths.localAppDataRoot,
    crashDumps: paths.processTempRoot,
    temp: paths.processTempRoot,
  } as const;
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (app.getPath(key) !== expected[key]) throw new Error('资格隔离路径不一致');
  }
}
