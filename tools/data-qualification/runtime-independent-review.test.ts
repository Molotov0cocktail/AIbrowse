import { DatabaseSync, backup } from 'node:sqlite';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { TransformPluginContext } from 'rollup';
import { openPrivateStagingDatabase } from '../../src/main/storage/staging-sqlite';
import { runtimeCompileProfile } from './runtime/build-profile';
import { ScanOperation } from './runtime/protocol';
import { STAGES, validateUiPhase } from './runtime/contract';
import { ObservedPromise } from './runtime/controls';
import {
  activeOriginals,
  assertOriginalsDrainedBeforeReady,
  type ActiveObservations,
} from './runtime/harness';
import { writeProjectedChunks } from './runtime/scan';

vi.mock('electron', () => ({ app: {}, utilityProcess: {} }));
vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
afterEach(() => vi.restoreAllMocks());
const evidence = join(process.cwd(), 'log/stage7-e2/independent-runtime-review-001');
fs.mkdirSync(evidence, { recursive: true });
const root = fs.mkdtempSync(join(evidence, 'cases-'));

it('受维护小型WAL库使用实际backup包含已提交事务，staging配置不改变原DB/WAL', async () => {
  const sourcePath = join(root, 'source.db');
  const copyPath = join(root, 'copy.db');
  const source = new DatabaseSync(sourcePath);
  source.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES('合成事务')",
  );
  const before = fs.readFileSync(sourcePath);
  const walBefore = fs.readFileSync(`${sourcePath}-wal`);
  const readonly = new DatabaseSync(sourcePath, { readOnly: true, allowExtension: false });
  try {
    await backup(readonly, copyPath, { rate: 100 });
    const opened = openPrivateStagingDatabase(copyPath, 'sources');
    try {
      expect(opened.db.prepare('SELECT value FROM evidence').get()?.value).toBe('合成事务');
      opened.db.exec("INSERT INTO evidence VALUES('只变副本')");
      expect(opened.settings.heapEnforcement).toBe('not-guaranteed');
    } finally {
      opened.db.close();
    }
    expect(fs.readFileSync(sourcePath)).toEqual(before);
    expect(fs.readFileSync(`${sourcePath}-wal`)).toEqual(walBefore);
    expect(source.prepare('SELECT count(*) AS count FROM evidence').get()?.count).toBe(1);
  } finally {
    readonly.close();
    source.close();
  }
});

it.each(['-wal', '-shm', '-journal'])('staging拒绝既有%s并保留原始字节', (suffix) => {
  const file = join(root, `${suffix.slice(1)}.db`);
  const original = new DatabaseSync(file);
  original.exec('CREATE TABLE marker(value TEXT)');
  original.close();
  const before = fs.readFileSync(file);
  fs.writeFileSync(file + suffix, '合成附属文件');
  expect(() => openPrivateStagingDatabase(file, 'research')).toThrow();
  expect(fs.readFileSync(file)).toEqual(before);
  expect(fs.readFileSync(file + suffix, 'utf8')).toBe('合成附属文件');
});

it('staging超尺寸stat在DatabaseSync打开前拒绝且不改文件', () => {
  const file = join(root, 'budget.db');
  fs.writeFileSync(file, '小型哨兵');
  const stat = fs.lstatSync(file);
  stat.size = 64 * 1024 ** 2 + 1;
  vi.spyOn(fs, 'lstatSync').mockReturnValue(stat);
  expect(() => openPrivateStagingDatabase(file, 'research')).toThrow('容量');
  expect(fs.readFileSync(file, 'utf8')).toBe('小型哨兵');
});

it.each(['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/src/main.tsx'])(
  '普通编译预变换从%s剥离资格运行分支，最终导入由制品门核对',
  async (file) => {
    const plugin = runtimeCompileProfile(false);
    if (typeof plugin.transform !== 'function') throw new Error('固定编译插件接口改变');
    const output = await plugin.transform.call(
      {} as TransformPluginContext,
      fs.readFileSync(file, 'utf8'),
      resolve(file),
    );
    const code = typeof output === 'string' ? output : output?.code;
    expect(typeof code).toBe('string');
    for (const marker of [
      'runtimeQualification()',
      'e2RuntimeQualification',
      '__E2_RUNTIME_QUALIFICATION__',
    ])
      expect(code).not.toContain(marker);
  },
);

it('完整结果之后发送cancel再exit0也不能接受；stage之后的第二ready失败', () => {
  const id = 'a'.repeat(32);
  const frame = (value: object) => JSON.stringify({ version: 1, operationId: id, ...value });
  const operation = new ScanOperation(id);
  operation.send('init');
  operation.receive(frame({ kind: 'ready' }));
  for (const [index, stage] of STAGES.entries())
    operation.receive(frame({ kind: 'stage', stage, elapsedMs: index + 1 }));
  operation.receive(
    frame({
      kind: 'result',
      result: {
        counts: [5000, 30, 200, 2800, 8400, 1030, 50],
        stageMs: STAGES.map(() => 1),
        rssPeakBytes: 1,
        migrationCases: 13,
        versions: [1, 1, 5],
        sourceIndexRebuilt: true,
        inputsUnchanged: true,
      },
    }),
  );
  operation.send('cancel');
  operation.confirmExit(0);
  expect(operation.accepted()).toBe(false);
  expect(operation.result).toBeNull();
  const replay = new ScanOperation(id);
  replay.send('init');
  replay.receive(frame({ kind: 'ready' }));
  replay.receive(frame({ kind: 'stage', stage: STAGES[0], elapsedMs: 1 }));
  replay.receive(frame({ kind: 'ready' }));
  expect(replay.failure).toBe('protocol');
});

it('UI单相各绿但相间空档超1000ms时全程仍拒绝', () => {
  const first = Array.from({ length: 6 }, (_, i) => ({
    sequence: i + 1,
    observedAt: i * 180,
    roundTripMs: 1,
  }));
  const second = first.map((sample) => ({
    ...sample,
    sequence: sample.sequence + 6,
    observedAt: sample.observedAt + 2500,
  }));
  expect(validateUiPhase(0, 1000, first).ok).toBe(true);
  expect(validateUiPhase(2500, 3500, second).ok).toBe(true);
  expect(validateUiPhase(0, 3500, [...first, ...second]).ok).toBe(false);
});

it('原Watch编排确实在ready后完成时，即使等待完成仍被统一oracle拒绝', async () => {
  const early = new ObservedPromise();
  const fulfilled = Promise.resolve();
  expect(early.track(fulfilled)).toBe(fulfilled);
  await fulfilled;
  const late = new ObservedPromise();
  let release!: () => void;
  const actual = new Promise<void>((resolve) => {
    release = resolve;
  });
  expect(late.track(actual)).toBe(actual);
  const observations: ActiveObservations = {
    chat: early,
    agent: early,
    research: early,
    watch: early,
    watchOrchestration: late,
    digest: early,
    preview: early,
    exporter: early,
    usage: early,
  };
  const readyAt = performance.now();
  expect(() => assertOriginalsDrainedBeforeReady(activeOriginals(observations), readyAt)).toThrow();
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  release();
  await actual;
  expect(late.settledAt).toBeGreaterThan(readyAt);
  expect(() => assertOriginalsDrainedBeforeReady(activeOriginals(observations), readyAt)).toThrow();
  expect(() =>
    assertOriginalsDrainedBeforeReady(activeOriginals(observations), performance.now()),
  ).not.toThrow();
});

it('独立输出夹具对多字节内容逐字节短写并验证实际UTF8文件', async () => {
  const file = join(root, 'short-write-output.json');
  const chunks = [Buffer.from('{"值":"'), Buffer.from('合成😀'), Buffer.from('"}')];
  const originalWrite = fs.writeSync;
  vi.spyOn(fs, 'writeSync').mockImplementation((fd: number, value: unknown, offset?: unknown) => {
    if (!Buffer.isBuffer(value) || typeof offset !== 'number') throw new Error('固定测试接口改变');
    return originalWrite(fd, value, offset, 1);
  });
  const expected = Buffer.concat(chunks);
  const result = await writeProjectedChunks(file, chunks, expected.byteLength);
  expect(fs.readFileSync(file)).toEqual(expected);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ 值: '合成😀' });
  expect(result.actualBytes).toBe(expected.byteLength);
});

it('输出不认领既有成员且非法write返回拒绝并关闭fd', async () => {
  const file = join(root, 'existing-output.json');
  fs.writeFileSync(file, '原件哨兵');
  await expect(writeProjectedChunks(file, [Buffer.from('a')], 1)).rejects.toThrow();
  expect(fs.readFileSync(file, 'utf8')).toBe('原件哨兵');
  vi.spyOn(fs, 'writeSync').mockReturnValue(Number.NaN);
  const close = vi.spyOn(fs, 'closeSync');
  await expect(
    writeProjectedChunks(join(root, 'invalid-write-output.json'), [Buffer.from('a')], 1),
  ).rejects.toThrow('写入未推进');
  expect(close).toHaveBeenCalledTimes(1);
});
