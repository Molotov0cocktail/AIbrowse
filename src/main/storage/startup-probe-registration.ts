import { parseBoundedJson } from './bounded-json';
import { requireNativeTransferPath } from './native-transfer-selection';
import { isTransferUuid } from './backup-container';
export interface StartupProbeRegistration {
  version: 1;
  operationId: string;
  userDataRoot: string;
}
export function parseStartupProbeRegistration(text: string): StartupProbeRegistration {
  const v = parseBoundedJson(text, { bytes: 4096, depth: 2, nodes: 8 });
  if (typeof v !== 'object' || v === null || Array.isArray(v) || Object.keys(v).length !== 3)
    throw new Error('启动预检登记无效');
  const value = v as Record<string, unknown>;
  if (
    value.version !== 1 ||
    !isTransferUuid(value.operationId) ||
    typeof value.userDataRoot !== 'string'
  )
    throw new Error('启动预检登记无效');
  requireNativeTransferPath(value.userDataRoot);
  return Object.freeze({
    version: 1,
    operationId: value.operationId,
    userDataRoot: value.userDataRoot,
  });
}
