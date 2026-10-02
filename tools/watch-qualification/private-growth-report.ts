import type { QualificationFrame } from '../../src/main/watch/qualification/native-contract.ts';
import {
  reportResourceGrowth,
  type HandleGrowthDependencies,
  type HandleGrowthReport,
} from './handle-growth-report.ts';
import type { ResourceInput } from './resource-report.ts';

export function reportPrivateGrowth(
  input: ResourceInput,
  runId: string,
  frames: readonly QualificationFrame[],
  dependencies: HandleGrowthDependencies,
): HandleGrowthReport & { revision: 'private-growth-v2' } {
  return {
    ...reportResourceGrowth(input, runId, frames, dependencies, 'privateMiB'),
    revision: 'private-growth-v2',
  };
}
