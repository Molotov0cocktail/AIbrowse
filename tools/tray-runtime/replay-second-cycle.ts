import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isStrictChild, validateCoalescedCycle } from './oracle.ts';
const repository = realpathSync(resolve(import.meta.dirname, '../..'));
const root = realpathSync(resolve(process.argv[2] ?? ''));
assert(isStrictChild(join(repository, 'log/tray-runtime-20261012'), root));
const hash = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');
const dbPath = join(root, 'profile/watch/watch.db');
const dbSha256 = hash(dbPath);
const prior = JSON.parse(readFileSync(join(root, 'write.json'), 'utf8')) as {
  passed: boolean;
  error: string;
  facts: Record<string, unknown>;
};
const input = JSON.parse(readFileSync(join(root, 'input.json'), 'utf8')) as {
  binding: Record<string, string>;
};
assert.equal(prior.passed, false);
assert(prior.error.startsWith('Error: 隐藏期间自动周期完成超时\n'));
assert.equal(prior.facts['scheduledEventWhileHidden'], true);
assert.equal(
  hash(join(root, 'tool-snapshot/harness.cjs')),
  input.binding['tools/tray-runtime/harness.cjs'],
);
const db = new DatabaseSync(dbPath, { readOnly: true });
let data;
try {
  data = {
    rules: db.prepare('SELECT id FROM watch_rules').all(),
    runs: db.prepare('SELECT * FROM watch_runs ORDER BY rowid').all(),
    events: db.prepare('SELECT * FROM watch_events').all(),
    observations: db.prepare('SELECT * FROM watch_event_observations ORDER BY sequence').all(),
    evidence: db.prepare('SELECT * FROM watch_event_items ORDER BY sequence').all(),
    baseline: db.prepare('SELECT * FROM watch_baselines').all(),
  };
} finally {
  db.close();
}
assert.equal(hash(dbPath), dbSha256);
const failures = validateCoalescedCycle(data);
writeFileSync(
  join(root, 'second-cycle-replay.json'),
  JSON.stringify(
    {
      passed: failures.length === 0,
      failures,
      dbSha256,
      originalReportSha256: hash(join(root, 'write.json')),
      originalHarnessSha256: hash(join(root, 'tool-snapshot/harness.cjs')),
      oracleSha256: hash(join(repository, 'tools/tray-runtime/oracle.ts')),
      hiddenStateEvidence:
        '推论：原冻结harness每次probe均先alive/isVisible断言，原超时错误无lastError；不能声称原整场PASS',
      data,
    },
    null,
    2,
  ),
  { flag: 'wx' },
);
process.stdout.write(`回放passed=${failures.length === 0}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
