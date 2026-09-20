import { loadQualificationNativeBridge } from './native-bridge';
import type {
  AuthenticatedQualificationLaunch,
  LaunchIsolationTicket,
  PreparedLaunchIsolation,
  QualificationNativeBridge,
} from './native-contract';

let native: QualificationNativeBridge | null = null;
let prepared: PreparedLaunchIsolation | null = null;
let authenticated: AuthenticatedQualificationLaunch | null = null;
let pending = false;

function requireQualificationBuild(): void {
  if (typeof __WATCH_QUALIFICATION__ === 'undefined' || !__WATCH_QUALIFICATION__) {
    throw new Error('资格入口未编译');
  }
}

export function prepareQualificationLaunch(): PreparedLaunchIsolation {
  requireQualificationBuild();
  if (native !== null) throw new Error('资格启动重复');
  native = Object.freeze(loadQualificationNativeBridge());
  const result = native.prepareLaunchIsolation();
  prepared = Object.freeze({
    ...result,
    ticket: Object.freeze(result.ticket),
    paths: Object.freeze({ ...result.paths }),
    rootFileIds: Object.freeze({ ...result.rootFileIds }),
  });
  return prepared;
}

export async function authenticateQualificationLaunch(
  ticket: LaunchIsolationTicket,
): Promise<AuthenticatedQualificationLaunch> {
  requireQualificationBuild();
  if (
    native === null ||
    prepared === null ||
    ticket !== prepared.ticket ||
    pending ||
    authenticated !== null
  ) {
    throw new Error('资格启动身份无效');
  }
  pending = true;
  const result = await native.authenticateLaunchAndConnectTelemetry(ticket);
  authenticated = Object.freeze({
    ...result,
    capability: Object.freeze(result.capability),
    identity: Object.freeze({
      ...result.identity,
      rootFileIds: Object.freeze({ ...result.identity.rootFileIds }),
    }),
  });
  return authenticated;
}

/** Values can be read, but only a successful real native authentication writes authority. */
export function getAuthenticatedQualificationLaunch(): {
  native: QualificationNativeBridge;
  prepared: PreparedLaunchIsolation;
  launch: AuthenticatedQualificationLaunch;
} {
  requireQualificationBuild();
  if (native === null || prepared === null || authenticated === null)
    throw new Error('资格启动尚未认证');
  return Object.freeze({ native, prepared, launch: authenticated });
}

export async function closeQualificationLaunch(): Promise<void> {
  if (native !== null && prepared !== null)
    await native.closeTelemetry(authenticated?.capability ?? prepared.ticket);
}
