import type { QualificationRuntime } from './runtime';
import { getAuthenticatedQualificationLaunch } from './launch-authority';

let runtime: QualificationRuntime | null = null;
let initializing = false;

/** No caller-supplied object or callback can install a seed-authorizing context. */
export async function initializeQualificationContext(): Promise<QualificationRuntime> {
  getAuthenticatedQualificationLaunch();
  if (runtime !== null || initializing) throw new Error('资格装配重复');
  initializing = true;
  const { QualificationRuntime } = await import('./runtime');
  const value = new QualificationRuntime();
  await value.ready();
  runtime = value;
  return value;
}

export function getQualificationContext(): QualificationRuntime {
  getAuthenticatedQualificationLaunch();
  if (runtime === null) throw new Error('资格装配尚未认证');
  return runtime;
}
