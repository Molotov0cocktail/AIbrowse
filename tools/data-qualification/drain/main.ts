import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { initLogger } from '../../../src/main/logger';
import { BUDGET, assertFact, validBuildId } from './contract';
import { conversationCase, researchCase, watchCase, type CaseEvidence } from './cases';
import type { Trace } from './controls';

// The bundled entry has one fixed action and derives every writable path from its own location.
const root = __dirname;
assertFact(process.platform === 'win32' && process.arch === 'x64', '资格仅限 Windows x64');
assertFact(/^v24\./.test(process.version), '资格需要现有 Node 24');
assertFact(
  process.argv.length === 3 && process.argv[2] === '--qualification-run',
  '资格入口参数无效',
);
assertFact(
  validBuildId(basename(root)) &&
    basename(dirname(root)) === 'stage7-e2' &&
    basename(dirname(dirname(root))) === 'log',
  '资格入口目录无效',
);
const repository = resolve(root, '../../..');
for (const path of [
  repository,
  join(repository, 'log'),
  dirname(root),
  root,
  join(root, 'fixture.cjs'),
]) {
  assertFact(!lstatSync(path).isSymbolicLink(), '资格目录不得经过符号链接');
}
const runtime = join(root, 'runtime');
mkdirSync(runtime);
initLogger(runtime);
globalThis.fetch = async () => {
  throw new Error('固定离线资格禁止网络请求');
};
const startedAt = performance.now();
const evidence: Array<{ round: number; durationMs: number; cases: CaseEvidence[] }> = [];
let eventCount = 0;
let activeRound = 0;
let activeCase = 'initializing';
let completed = false;
let reportWritten = false;

function directoryBytes(path: string): number {
  let total = 0;
  for (const name of readdirSync(path)) {
    const item = join(path, name);
    const info = lstatSync(item);
    assertFact(!info.isSymbolicLink(), '资格输出出现链接');
    total += info.isDirectory() ? directoryBytes(item) : info.size;
    assertFact(total <= BUDGET.diskBytes, '资格输出超过磁盘预算');
  }
  return total;
}

const trace: Trace = (name, facts = {}) => {
  assertFact(++eventCount <= BUDGET.maximumEvents, '资格事件数超过预算');
  appendFileSync(
    join(runtime, 'events.jsonl'),
    JSON.stringify({
      at: performance.now(),
      round: activeRound,
      case: activeCase,
      name,
      ...facts,
    }) + '\n',
  );
};

function report(error: string | null): void {
  if (reportWritten) return;
  reportWritten = true;
  const bundleSha256 = createHash('sha256')
    .update(readFileSync(join(root, 'fixture.cjs')))
    .digest('hex');
  let bytes: number | null = null;
  try {
    bytes = directoryBytes(root);
  } catch {
    completed = false;
    error = '磁盘或输出路径核验失败';
  }
  writeFileSync(
    join(runtime, 'report.json'),
    JSON.stringify(
      {
        version: 1,
        buildId: basename(root),
        bundleSha256,
        node: process.version,
        sqlite: process.versions.sqlite,
        budget: BUDGET,
        completed,
        productE2Pass: false,
        classification: completed
          ? '旧方法提前返回反例已收集，产品排水仍未实现'
          : '资格未完成，保留原件并停止',
        error,
        activeRound,
        activeCase,
        durationMs: performance.now() - startedAt,
        directoryBytes: bytes,
        eventCount,
        rounds: evidence,
      },
      null,
      2,
    ),
  );
}

async function run(): Promise<void> {
  for (let round = 1; round <= BUDGET.rounds; round++) {
    activeRound = round;
    const start = performance.now();
    const result = { round, durationMs: 0, cases: [] as CaseEvidence[] };
    evidence.push(result);
    const timer = setTimeout(() => {
      report('单轮 20 秒资格预算耗尽；未确认的操作不得视为排水');
      process.exit(2);
    }, BUDGET.roundMs);
    try {
      for (const [name, execute] of [
        ['conversation', conversationCase],
        ['research', researchCase],
        ['watch', watchCase],
      ] as const) {
        activeCase = name;
        const path = join(runtime, `round-${round}`, name);
        mkdirSync(path, { recursive: true });
        trace('case.start');
        result.cases.push(await execute(path, trace));
        trace('case.finished');
        directoryBytes(root);
      }
      result.durationMs = performance.now() - start;
      assertFact(result.durationMs < BUDGET.roundMs, '单轮超过冻结预算');
    } finally {
      clearTimeout(timer);
    }
  }
  activeCase = 'finished';
  completed = true;
  report(null);
}

void run().catch((error: unknown) => {
  report(error instanceof Error ? error.message.slice(0, 512) : '受控资格失败');
  process.exitCode = 1;
});
