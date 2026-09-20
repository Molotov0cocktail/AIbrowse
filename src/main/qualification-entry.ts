import { app } from 'electron';
import {
  authenticateQualificationLaunch,
  closeQualificationLaunch,
  prepareQualificationLaunch,
} from './watch/qualification/launch-authority';
import { applyQualificationLaunchIsolation } from './watch/qualification/launch-isolation';
import type { PreparedLaunchIsolation } from './watch/qualification/native-contract';

let prepared: PreparedLaunchIsolation | null = null;
let isolated = false;
try {
  if (app.isReady()) throw new Error('资格入口过迟');
  prepared = prepareQualificationLaunch();
  applyQualificationLaunchIsolation(app, prepared);
  isolated = true;
} catch {
  void closeQualificationLaunch().finally(() => app.exit(1));
}

if (isolated && prepared !== null) {
  const isolation = prepared;
  void authenticateQualificationLaunch(isolation.ticket)
    .then(async () => {
      const { bootstrapQualification } = await import('./watch/qualification/bootstrap');
      await bootstrapQualification();
      await import('./index');
    })
    .catch(async () => {
      await closeQualificationLaunch().catch(() => undefined);
      app.exit(1);
    });
}
