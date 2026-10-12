// Offline compatibility check of already-normalized synthetic Research results.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { ResearchRepository } from '../../src/main/research/repository/research-repository';
import { validate } from '../../src/main/research/result-validator';
import type { DbHandle } from '../../src/main/sources/db/sqlite-driver';

const repositoryRoot = resolve('.');
const databasePath = resolve(process.argv[2] ?? '');
const reportPath = resolve(process.argv[3] ?? '');
const local = (path: string) => relative(repositoryRoot, path).replaceAll('\\', '/');
if (
  !/^log\/real-provider-20261012\/campaign-[a-f0-9-]{36}\/research\/research-scenarios-[A-Za-z0-9]+\/research\.db$/.test(
    local(databasePath),
  ) ||
  !/^log\/real-provider-20261012\/validator-replay-[a-f0-9-]{36}\/report\.json$/.test(
    local(reportPath),
  )
)
  throw new Error('离线回投路径不属于固定合成目录');
const fact = (path: string) => {
  const bytes = readFileSync(path);
  return {
    path: local(path),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};
const before = fact(databasePath);
const validator = fact(resolve('src/main/research/result-validator.ts'));
const database = new DatabaseSync(databasePath, { readOnly: true });
const handle: DbHandle = {
  path: databasePath,
  get isOpen() {
    return database.isOpen;
  },
  prepare: (sql) => database.prepare(sql),
  exec: () => {
    throw new Error('离线回投禁止写入');
  },
  close: () => database.close(),
};
const counts = { tasks: 0, results: 0, blocks: 0, evidence: 0, claims: 0, conflicts: 0 };
const fieldChecks: Record<string, boolean> = {};
let validationPassed = true;
let passed = true;
try {
  const repository = new ResearchRepository(handle);
  const tasks = repository.listTasks({ page: 1, pageSize: 2 });
  if (tasks.total !== 1 || tasks.items.length !== 1) throw new Error('合成研究任务数量不符');
  for (const task of tasks.items) {
    if (task.status !== 'completed') throw new Error('合成研究未完成');
    counts.tasks++;
    const result = repository.getResultByTaskId(task.id);
    if (!result || result.resultId !== task.resultId) throw new Error('已保存研究结果不完整');
    const evidence = repository.listEvidenceByTask(task.id);
    const claims = repository.listClaimsByTask(task.id);
    const storedConflicts = repository.listConflictsByTask(task.id);
    const byId = new Map(storedConflicts.map((conflict) => [conflict.conflictId, conflict]));
    if (
      byId.size !== result.conflicts.length ||
      new Set(result.conflicts.map((conflict) => conflict.conflictId)).size !== byId.size
    )
      throw new Error('已保存冲突集合不完整');
    // Repository reads sort random IDs; restore the original persisted Result order.
    const conflicts = result.conflicts.map((projection) => {
      const conflict = byId.get(projection.conflictId);
      if (!conflict) throw new Error('已保存结果含未知冲突');
      return conflict;
    });
    const outcome = validate(
      { title: result.title, summary: result.summary, blocks: result.blocks },
      {
        taskId: task.id,
        candidates: repository.listCandidatesByTask(task.id),
        evidence,
        claims,
        conflicts,
        verificationState: 'verified',
        now: result.fetchedAt,
        createId: () => result.resultId,
      },
    );
    validationPassed &&= outcome.ok;
    if (outcome.ok) {
      for (const key of Object.keys(result) as Array<keyof typeof result>) {
        fieldChecks[key] = isDeepStrictEqual(outcome.result[key], result[key]);
      }
    }
    passed &&= outcome.ok && isDeepStrictEqual(outcome.result, result);
    counts.results++;
    counts.blocks += result.blocks.length;
    counts.evidence += evidence.length;
    counts.claims += claims.length;
    counts.conflicts += conflicts.length;
  }
} finally {
  database.close();
}
const unchanged = isDeepStrictEqual(before, fact(databasePath));
passed &&= unchanged;
const report = {
  version: 1,
  scope: 'saved-result-validator-compatibility',
  passed,
  rawModelOutputRevalidated: false,
  networkCalls: 0,
  readOnlyDatabase: true,
  databaseUnchanged: unchanged,
  normalizedResultUnchanged: passed,
  validationPassed,
  fieldChecks,
  conflictOrder: 'restored-by-persisted-result-ids',
  database: before,
  validator,
  counts,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2), { flag: 'wx' });
process.stdout.write(JSON.stringify({ passed, counts, databaseUnchanged: unchanged }) + '\n');
if (!passed) process.exitCode = 1;
