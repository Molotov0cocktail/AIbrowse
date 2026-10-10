import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, statfs, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { build } from 'esbuild';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--from=310'))
  throw new Error('仅支持已登记的完整矩阵或末20点补齐');
const from = args.length === 1 ? 310 : 0;
const LIMIT = {
  cases: 400,
  wallMs: from === 310 ? 120_000 : 600_000,
  childMs: 8_000,
  exitMs: 2_000,
  diskBytes: (from === 310 ? 32 : 64) * 1024 ** 2,
  frames: 500,
  frameBytes: 256,
};
const started = performance.now();
const output = resolve(
  'log',
  'stage7-e2',
  `dataset-switch-crash-${randomUUID().replaceAll('-', '')}`,
);
await mkdir(output);
const worker = join(output, 'worker.cjs');
await build({
  entryPoints: ['tools/data-qualification/switch-crash/worker.ts'],
  outfile: worker,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'silent',
});
const record: {
  limits: typeof LIMIT;
  status: string;
  cases: object[];
  baseline?: object;
  elapsedMs?: number;
  allocatedBytes?: number;
  from: number;
  workerSha256: string;
  failure?: string;
  nextCase?: number;
} = {
  limits: LIMIT,
  from,
  workerSha256: createHash('sha256')
    .update(await readFile(worker))
    .digest('hex'),
  status: 'running',
  cases: [],
};
await writeFile(join(output, 'report.json'), JSON.stringify(record, null, 2));
const cluster = Number((await statfs(output)).bsize);
if (!Number.isSafeInteger(cluster) || cluster < 1) throw new Error('分配单元无效');
async function allocated(path: string): Promise<number> {
  const s = await stat(path);
  if (!s.isDirectory()) return Math.ceil(s.size / cluster) * cluster;
  let bytes = cluster;
  for (const name of await readdir(path)) bytes += await allocated(join(path, name));
  return bytes;
}
async function supervise(
  root: string,
  mode: string,
  killAt: number | null,
): Promise<{ state: string | null; points: string[]; killed: boolean; exit: number | null }> {
  if (!isAbsolute(root) || !root.startsWith(output + sep)) throw new Error('资格根越界');
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [worker, root, mode], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    const points: string[] = [];
    let state: string | null = null;
    let killed = false;
    let failed = false;
    let exited = false;
    let settled = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (killed || exited) return;
      killed = true;
      clearTimeout(timer);
      exitTimer = setTimeout(() => {
        if (settled || exited) return;
        settled = true;
        reject(new Error('子进程退出未确认，原件和进程所有权记录保留'));
      }, LIMIT.exitMs);
      try {
        child.kill('SIGKILL');
      } catch {
        /* A thrown kill is not an observed exit. */
      }
    };
    const timer = setTimeout(() => {
      failed = true;
      stop();
    }, LIMIT.childMs);
    let diagnosticBytes = 0;
    const observeOutput = (bytes: Buffer) => {
      diagnosticBytes += bytes.length;
      if (diagnosticBytes > 4096 && !killed) {
        failed = true;
        stop();
      }
    };
    child.stdout?.on('data', observeOutput);
    child.stderr?.on('data', observeOutput);
    child.on('message', (raw: unknown) => {
      if (killed || settled || exited) return;
      if (
        typeof raw !== 'object' ||
        raw === null ||
        Array.isArray(raw) ||
        Buffer.byteLength(JSON.stringify(raw)) > LIMIT.frameBytes
      ) {
        failed = true;
        stop();
        return;
      }
      const frame = raw as Record<string, unknown>;
      if (
        frame.kind === 'boundary' &&
        typeof frame.point === 'string' &&
        /^[a-z0-9:-]{1,100}$/u.test(frame.point) &&
        Object.keys(frame).length === 2
      ) {
        points.push(frame.point);
        if (points.length > LIMIT.frames) {
          failed = true;
          stop();
        } else if (killAt === points.length) stop();
        else {
          try {
            child.send('continue', (error) => {
              if (error && !settled && !exited) {
                failed = true;
                stop();
              }
            });
          } catch {
            failed = true;
            stop();
          }
        }
      } else if (
        frame.kind === 'result' &&
        typeof frame.state === 'string' &&
        Object.keys(frame).length === 2 &&
        state === null
      )
        state = frame.state;
      else {
        failed = true;
        stop();
      }
    });
    child.on('error', () => {
      if (settled || exited) return;
      failed = true;
      stop();
    });
    child.once('exit', (code) => {
      exited = true;
      clearTimeout(timer);
      if (exitTimer) clearTimeout(exitTimer);
      if (settled) return;
      settled = true;
      if (failed || (!killed && code !== 0)) reject(new Error('资格子进程失败'));
      else resolveRun({ state, points, killed, exit: code });
    });
  });
}
async function textAt(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
async function oracle(root: string, state: string | null, requireNew: boolean): Promise<void> {
  const operation = join(root, 'data-transfer', 'a'.repeat(32));
  let completeOld = true;
  let completeNew = true;
  for (const domain of ['sources', 'research', 'watch']) {
    for (const [suffix, label, prefix] of [
      ['', '', 'old'],
      ['-wal', '-wal', 'wal'],
      ['-shm', '-shm', 'shm'],
      ['-journal', '-journal', 'journal'],
    ]) {
      const expected = `${prefix}-${domain}`;
      const live = await textAt(join(root, domain, `${domain}.db${suffix}`));
      const alternatives = await Promise.all(
        ['rollback', 'retired'].map((area) => textAt(join(operation, area, domain + label))),
      );
      if (live !== expected && !alternatives.includes(expected)) throw new Error('旧成员原件丢失');
      completeOld &&= live === expected;
      completeNew &&= suffix === '' ? live === `new-${domain}` : live === null;
      if (
        suffix === '' &&
        requireNew &&
        live !== `new-${domain}` &&
        (await textAt(join(operation, 'work', `${domain}.db`))) !== `new-${domain}`
      )
        throw new Error('新成员丢失');
    }
    if ((await textAt(join(root, domain, 'backups', 'keep'))) !== '保留备份')
      throw new Error('旧备份被改变');
  }
  for (const [name, expected] of [
    ['index.json', 'old-index'],
    ['nested/old.json', 'old-nested'],
  ]) {
    const live = await textAt(join(root, 'conversations', name!));
    const alternatives = await Promise.all(
      ['rollback', 'retired'].map((area) => textAt(join(operation, area, 'conversations', name!))),
    );
    if (live !== expected && !alternatives.includes(expected!)) throw new Error('旧会话原件丢失');
    completeOld &&= live === expected;
  }
  const liveIndex = await textAt(join(root, 'conversations', 'index.json'));
  completeNew &&=
    liveIndex === 'new-index' &&
    (await textAt(join(root, 'conversations', 'nested', 'old.json'))) === null;
  if (
    requireNew &&
    liveIndex !== 'new-index' &&
    (await textAt(join(operation, 'work', 'conversations', 'index.json'))) !== 'new-index'
  )
    throw new Error('新会话丢失');
  if ((await textAt(join(root, 'credentials.json'))) !== '不触及')
    throw new Error('凭据旁支被改变');
  if (
    state === 'committed'
      ? !completeNew
      : state === 'old-restored' || state === 'old-unchanged'
        ? !completeOld
        : state !== 'recovery-required'
  )
    throw new Error('终态与实际数据代不符');
}
try {
  const baseline: Array<{ mode: string; points: string[] }> = [];
  for (const mode of ['publish', 'rollback']) {
    const root = join(output, `baseline-${mode}`);
    const result = await supervise(root, mode, null);
    await oracle(root, result.state, true);
    baseline.push({ mode, points: result.points });
  }
  const count = baseline.reduce((sum, b) => sum + b.points.length, 0);
  record.baseline = { count, runs: baseline };
  if (count > LIMIT.cases) throw new Error('崩溃点超过预登记预算');
  if (from === 310 && count !== 330) throw new Error('续验边界集合已改变');
  let cursor = 0;
  for (const base of baseline)
    for (let index = 0; index < base.points.length; index++) {
      const caseIndex = cursor++;
      if (caseIndex < from) continue;
      record.nextCase = caseIndex;
      if (performance.now() - started > LIMIT.wallMs) throw new Error('总期限耗尽');
      record.allocatedBytes = await allocated(output);
      // The fixed tiny fixture has fewer than 128 entries. Reserve additional
      // report/bundle space before each child; this is not a filesystem quota.
      const reserve = 128 * cluster + 1024 ** 2;
      if (record.allocatedBytes + reserve > LIMIT.diskBytes) throw new Error('空间准入预算耗尽');
      const root = join(output, `case-${String(caseIndex).padStart(3, '0')}`);
      const killed = await supervise(root, base.mode, index + 1);
      if (!killed.killed || killed.points.at(-1) !== base.points[index])
        throw new Error('未在目标边界终止');
      const reopened = await supervise(root, 'reopen', null);
      await oracle(root, reopened.state, !base.points[index]!.startsWith('owner-'));
      record.cases.push({
        caseIndex,
        mode: base.mode,
        index,
        point: base.points[index],
        exit: killed.exit,
        reopened: reopened.state,
      });
      record.allocatedBytes = await allocated(output);
      if (record.allocatedBytes > LIMIT.diskBytes) throw new Error('空间预算耗尽');
      if (record.cases.length % 10 === 0) {
        process.stdout.write(`已核验 ${record.cases.length}/${count} 个崩溃边界\n`);
      }
      await writeFile(join(output, 'report.json'), JSON.stringify(record, null, 2));
    }
  record.status = 'PASS';
} catch (error) {
  record.status = 'FAIL';
  record.failure = error instanceof Error ? error.message : '资格失败';
  process.exitCode = 1;
} finally {
  record.elapsedMs = performance.now() - started;
  record.allocatedBytes = await allocated(output);
  if (record.elapsedMs > LIMIT.wallMs || record.allocatedBytes > LIMIT.diskBytes) {
    record.status = 'FAIL';
    process.exitCode = 1;
  }
  await writeFile(join(output, 'report.json'), JSON.stringify(record, null, 2));
  process.stdout.write(
    JSON.stringify({
      status: record.status,
      cases: record.cases.length,
      elapsedMs: record.elapsedMs,
      allocatedBytes: record.allocatedBytes,
      output,
    }) + '\n',
  );
}
