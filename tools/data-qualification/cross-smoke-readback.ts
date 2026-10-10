import {
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeFileSync,
  lstatSync,
  opendirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { snapshotOut } from './cross-smoke-scope.ts';

export const CROSS_KINDS = ['session', 'sources', 'sources-ui', 'research', 'watch'] as const;
export type CrossKind = (typeof CROSS_KINDS)[number];
export const CROSS_ABNORMAL_MARKER =
  'Research set 异常恢复夹具：准入已关闭，保留 running 任务，请求故意异常退出';
const MARKERS: Record<CrossKind, readonly [string, string]> = {
  session: [
    'Session 冒烟（set）通过：Cookie 已写入持久分区',
    'Session 冒烟（check）通过：新进程读取到先前写入的 Cookie',
  ],
  sources: ['B-02 set 完成：CRUD + journal + usage 写入', 'B-02 check 完成：跨进程读回一致'],
  'sources-ui': ['B-05 set 完成：快速添加 + 编辑', 'B-05 check 完成：跨进程读回 + 重启后 Undo'],
  research: [
    'RESEARCH set：completed 任务与遗留 running 任务已就绪，直接退出',
    'RESEARCH check：读回与 interrupted 标记验证通过',
  ],
  watch: [
    'WATCH set：Rule/Baseline/Event/遗留 Run/未决 intent 已就绪，直接退出',
    'WATCH check：读回/interrupted/reconciliation 级联验证通过',
  ],
};
interface TaskFact {
  id: string;
  status: string;
  phase: string | null;
  interrupted: boolean;
  result: boolean;
}
export interface CrossEvidence {
  kind: CrossKind;
  mode: 'set' | 'check';
  exitCode: number;
  jobZero: boolean;
  ledgerRetired: boolean;
  log: string;
  tasks: TaskFact[];
  expectedRunningId: string | null;
}
export function verifyCrossEvidence(value: CrossEvidence): {
  passed: boolean;
  runningId: string | null;
} {
  const abnormal = value.kind === 'research' && value.mode === 'set';
  const code = abnormal ? value.exitCode === 0 || value.exitCode === 91 : value.exitCode === 0;
  const marker = value.log.includes(MARKERS[value.kind][value.mode === 'set' ? 0 : 1]);
  const terminal = abnormal
    ? value.log.includes(CROSS_ABNORMAL_MARKER) && !value.log.includes('冒烟自检通过，正常退出')
    : value.log.includes('冒烟自检通过，正常退出');
  let tasks = true;
  let runningId: string | null = null;
  if (value.kind === 'research') {
    const completed = value.tasks.filter((task) => task.status === 'completed' && task.result);
    const leftover = value.tasks.filter((task) =>
      value.mode === 'set'
        ? task.status === 'running' && task.phase === 'planning' && !task.interrupted
        : task.status === 'interrupted' &&
          task.phase === null &&
          task.interrupted &&
          task.id === value.expectedRunningId,
    );
    tasks = value.tasks.length === 2 && completed.length === 1 && leftover.length === 1;
    runningId = leftover[0]?.id ?? null;
  }
  return {
    passed:
      code &&
      marker &&
      terminal &&
      tasks &&
      value.jobZero &&
      value.ledgerRetired &&
      !value.log.includes('冒烟场景失败（调度层）'),
    runningId,
  };
}

function boundedFile(path: string, max: number, offset = 0): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    throw new Error('证据类型异常');
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    const length = stat.size - offset;
    if (
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      length < 0 ||
      length > max
    )
      throw new Error('证据读取超出预算');
    const output = Buffer.alloc(length);
    let used = 0;
    while (used < length) {
      const count = readSync(fd, output, used, length - used, offset + used);
      if (count === 0) throw new Error('证据读取中断');
      used += count;
    }
    const after = fstatSync(fd);
    const named = lstatSync(path);
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      named.ino !== stat.ino ||
      named.dev !== stat.dev
    )
      throw new Error('证据读取期间改变');
    return output;
  } finally {
    closeSync(fd);
  }
}
function measure(root: string): { bytes: number; files: number } {
  let bytes = 0,
    files = 0;
  const walk = (path: string, depth: number): void => {
    if (depth > 16) throw new Error('证据目录超出深度预算');
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1)
    )
      throw new Error('证据目录包含未知链接');
    files += 1;
    bytes += stat.isFile() ? stat.size : 0;
    if (files > 4096 || bytes > 256 * 1024 * 1024) throw new Error('证据累计超出预算');
    if (stat.isDirectory()) {
      const directory = opendirSync(path);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync())
          walk(join(path, entry.name), depth + 1);
      } finally {
        directory.closeSync();
      }
    }
  };
  walk(root, 0);
  return { bytes, files };
}
export function readPrivateLogs(appRoot: string, identity: { dev: string; ino: string }) {
  const directory = join(appRoot, 'log');
  const before = lstatSync(directory, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    String(before.dev) !== identity.dev ||
    String(before.ino) !== identity.ino
  )
    throw new Error('本次私有日志目录身份不符');
  const opened = opendirSync(directory);
  const names: string[] = [];
  try {
    for (let entry = opened.readSync(); entry; entry = opened.readSync()) {
      if (
        !/^aibrowse-\d{4}-\d{2}-\d{2}(?:\.[1-9]\d*)?\.log$/.test(entry.name) ||
        names.length >= 10
      )
        throw new Error('私有日志成员超出预算');
      names.push(entry.name);
    }
  } finally {
    opened.closeSync();
  }
  let remaining = 8 * 1024 * 1024;
  const parts: Buffer[] = [];
  const members = [];
  for (const name of names.sort()) {
    const path = join(directory, name);
    const bytes = boundedFile(path, remaining);
    remaining -= bytes.length;
    const stat = lstatSync(path, { bigint: true });
    members.push({
      name,
      dev: String(stat.dev),
      ino: String(stat.ino),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    parts.push(bytes);
  }
  const after = lstatSync(directory, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeNs !== before.mtimeNs)
    throw new Error('私有日志集合改变');
  return { bytes: Buffer.concat(parts), members };
}
interface Request {
  root: string;
  profile: string;
  repository: string;
  appRoot: string;
  buildReceipt: string;
  kind: CrossKind;
  mode: 'set' | 'check';
  exitCode: number;
  jobZero: boolean;
  expectedRunningId: string | null;
  output: string;
}
function run(request: Request): void {
  if (!CROSS_KINDS.includes(request.kind) || !['set', 'check'].includes(request.mode))
    throw new Error('冒烟读回类型非法');
  const receipt = JSON.parse(boundedFile(request.buildReceipt, 1024 * 1024).toString('utf8')) as {
    files: ReturnType<typeof snapshotOut>;
    log: { dev: string; ino: string };
  };
  if (JSON.stringify(snapshotOut(request.repository)) !== JSON.stringify(receipt.files))
    throw new Error('运行制品与启动前绑定不符');
  const logs = readPrivateLogs(request.appRoot, receipt.log);
  const logBytes = logs.bytes;
  const log = new TextDecoder('utf-8', { fatal: true }).decode(logBytes);
  const ledger = JSON.parse(
    boundedFile(join(request.profile, 'lifecycle-guardian/writers.json'), 4096).toString('utf8'),
  ) as Record<string, unknown>;
  const ledgerRetired =
    Object.keys(ledger).sort().join(',') === 'main,root,session,utility,version' &&
    ledger.version === 1 &&
    typeof ledger.root === 'string' &&
    /^[a-f0-9]{64}$/.test(ledger.root) &&
    typeof ledger.session === 'string' &&
    /^[a-f0-9]{32}$/.test(ledger.session) &&
    ledger.main === null &&
    ledger.utility === null;
  const tasks: TaskFact[] = [];
  if (request.kind === 'research') {
    const path = join(request.profile, 'research/research.db');
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size > 512 * 1024 * 1024
    )
      throw new Error('研究夹具类型或容量异常');
    const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000;');
      for (const row of db
        .prepare(
          'SELECT id,status,phase,interrupted_at IS NOT NULL AS interrupted,result_id IS NOT NULL AS result FROM research_tasks LIMIT 3',
        )
        .all()) {
        if (
          typeof row.id !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(row.id) ||
          typeof row.status !== 'string' ||
          !(row.phase === null || typeof row.phase === 'string')
        )
          throw new Error('研究夹具字段异常');
        tasks.push({
          id: row.id,
          status: row.status,
          phase: row.phase,
          interrupted: row.interrupted === 1,
          result: row.result === 1,
        });
      }
    } finally {
      db.close();
    }
  }
  const verdict = verifyCrossEvidence({ ...request, ledgerRetired, log, tasks });
  writeFileSync(request.output.replace(/\.json$/, '.main-log.txt'), logBytes, { flag: 'wx' });
  const usage = measure(request.root);
  writeFileSync(
    request.output,
    JSON.stringify({ ...verdict, ledgerRetired, tasks, usage, logMembers: logs.members }),
    {
      flag: 'wx',
    },
  );
  if (!verdict.passed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('冒烟读回参数非法');
  const request = JSON.parse(boundedFile(process.argv[2]!, 4096).toString('utf8')) as Request;
  run(request);
}
