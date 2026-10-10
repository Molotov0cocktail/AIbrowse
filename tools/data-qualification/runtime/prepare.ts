import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readdirSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { prepareFixtures } from './fixtures';
import { isBuildId, BUDGET, assertFact } from './contract';

const root = resolve(__dirname);
assertFact(
  isBuildId(basename(root)) &&
    process.argv.length === 3 &&
    process.argv[2] === '--prepare-fixed-fixture',
  '固定 prepare 入口无效',
);
const started = performance.now();
const report: Record<string, unknown> = {
  completed: false,
  productE2Pass: false,
  budget: { operationMs: 30000, diskBytes: BUDGET.diskBytes },
  error: null,
};
try {
  report.fixture = prepareFixtures(join(root, 'fixtures'));
  const hashes: Record<string, string> = {};
  let diskBytes = 0;
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      assertFact(!stat.isSymbolicLink(), 'prepare 路径含链接');
      if (stat.isDirectory()) walk(path);
      else {
        diskBytes += stat.size;
        assertFact(diskBytes <= BUDGET.diskBytes, 'prepare 磁盘预算超限');
        hashes[path.slice(root.length + 1).replaceAll('\\', '/')] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
      }
    }
  };
  walk(join(root, 'fixtures'));
  report.diskBytes = diskBytes;
  report.hashes = hashes;
  assertFact(performance.now() - started <= 30000, 'prepare 固定时限超限');
  report.completed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : '合成夹具准备失败';
  process.exitCode = 2;
}
report.durationMs = performance.now() - started;
writeFileSync(join(root, 'fixture-proof.json'), JSON.stringify(report, null, 2));
console.log(
  JSON.stringify({
    completed: report.completed,
    durationMs: report.durationMs,
    error: report.error,
  }),
);
