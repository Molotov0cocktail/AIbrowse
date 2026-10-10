import { join } from 'node:path';
import { LIMITS, need } from './contract';
import { object, read } from './files';
import type { Scene } from '../product-restore-process/protocol';

export function startupBudget(
  bytes: Buffer,
  expected: {
    runId: string;
    scene: Scene;
    proofSha256: string;
    preflightLowerBound: number;
    nodeUptimeMs: number;
  },
): number {
  const value = object(bytes, ['version', 'runId', 'scene', 'proofSha256', 'preflightElapsedMs']);
  need(
    value.version === 1 &&
      value.runId === expected.runId &&
      value.scene === expected.scene &&
      value.proofSha256 === expected.proofSha256 &&
      typeof value.preflightElapsedMs === 'number' &&
      Number.isSafeInteger(value.preflightElapsedMs) &&
      value.preflightElapsedMs >= expected.preflightLowerBound &&
      Number.isFinite(expected.nodeUptimeMs) &&
      expected.nodeUptimeMs >= 0,
  );
  const used = value.preflightElapsedMs + Math.ceil(expected.nodeUptimeMs);
  need(
    Number.isSafeInteger(used) && used >= 0 && used < LIMITS.offline,
    '恢复准入原工具额度已耗尽',
  );
  return used;
}
export async function waitStart(
  journal: string,
  expected: Omit<Parameters<typeof startupBudget>[1], 'nodeUptimeMs'>,
): Promise<number> {
  for (;;) {
    need(expected.preflightLowerBound + Math.ceil(process.uptime() * 1000) < LIMITS.offline);
    try {
      const bytes = await read(join(journal, 'restore-start.json'), 4096);
      return startupBudget(bytes, { ...expected, nodeUptimeMs: process.uptime() * 1000 });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await new Promise<void>((done) => setTimeout(done, 25));
  }
}
