import { createRequire } from 'node:module';
import type { QualificationNativeBridge } from './native-contract';

/** Resolve only the fixed build artifact; a missing native bridge is a hard failure. */
export function loadQualificationNativeBridge(): QualificationNativeBridge {
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.type !== 'browser') {
    throw new Error('qualification-native-unavailable');
  }
  const nativeRequire = createRequire(__filename);
  const bridge: unknown = nativeRequire('./watch-qualification.node');
  if (
    bridge === null ||
    typeof bridge !== 'object' ||
    Object.keys(bridge).sort().join(',') !==
      'authenticateLaunchAndConnectTelemetry,closeTelemetry,prepareLaunchIsolation,readQpc,writeTelemetryFrame'
  ) {
    throw new Error('qualification-native-unavailable');
  }
  for (const name of Object.keys(bridge)) {
    if (typeof Reflect.get(bridge, name) !== 'function') {
      throw new Error('qualification-native-unavailable');
    }
  }
  return bridge as QualificationNativeBridge;
}
