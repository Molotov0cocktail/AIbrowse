import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { prepareCrossApp } from './cross-smoke-scope';
import {
  CROSS_ABNORMAL_MARKER,
  verifyCrossEvidence,
  type CrossEvidence,
} from './cross-smoke-readback';

const id = '11111111-1111-4111-8111-111111111111';
function research(): CrossEvidence {
  return {
    kind: 'research',
    mode: 'set',
    exitCode: 91,
    jobZero: true,
    ledgerRetired: true,
    log:
      'RESEARCH set：completed 任务与遗留 running 任务已就绪，直接退出\n' + CROSS_ABNORMAL_MARKER,
    expectedRunningId: null,
    tasks: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        status: 'completed',
        phase: null,
        interrupted: false,
        result: true,
      },
      { id, status: 'running', phase: 'planning', interrupted: false, result: false },
    ],
  };
}
it.each([0, 91])('Research-set exit %d仍须全部异常fixture证据', (exitCode) => {
  const value = { ...research(), exitCode };
  expect(verifyCrossEvidence(value)).toEqual({ passed: true, runningId: id });
  for (const patch of [
    { log: '' },
    { log: CROSS_ABNORMAL_MARKER },
    { log: value.log + '\n冒烟自检通过，正常退出' },
    { jobZero: false },
    { ledgerRetired: false },
    { tasks: [] },
    { tasks: value.tasks.map((task) => ({ ...task, status: 'interrupted' })) },
  ])
    expect(verifyCrossEvidence({ ...value, ...patch }).passed).toBe(false);
});
it('Research-check必须读到set的同一个task已interrupted且phase清空', () => {
  const value: CrossEvidence = {
    ...research(),
    mode: 'check',
    exitCode: 0,
    expectedRunningId: id,
    log: 'RESEARCH check：读回与 interrupted 标记验证通过\n冒烟自检通过，正常退出',
    tasks: research().tasks.map((task) =>
      task.id === id ? { ...task, status: 'interrupted', phase: null, interrupted: true } : task,
    ),
  };
  expect(verifyCrossEvidence(value).passed).toBe(true);
  expect(verifyCrossEvidence({ ...value, expectedRunningId: 'other' }).passed).toBe(false);
  expect(verifyCrossEvidence({ ...value, exitCode: 91 }).passed).toBe(false);
  expect(verifyCrossEvidence({ ...value, tasks: research().tasks }).passed).toBe(false);
});
it('非Research-set拒绝异常退出和只有通用成功marker', () => {
  const value: CrossEvidence = {
    ...research(),
    kind: 'watch',
    mode: 'check',
    exitCode: 0,
    tasks: [],
    log: 'WATCH check：读回/interrupted/reconciliation 级联验证通过\n冒烟自检通过，正常退出',
  };
  expect(verifyCrossEvidence(value).passed).toBe(true);
  expect(verifyCrossEvidence({ ...value, exitCode: 91 }).passed).toBe(false);
  expect(verifyCrossEvidence({ ...value, log: '冒烟自检通过，正常退出' }).passed).toBe(false);
});
it('固定runner只用原子Job生命周期，固定五组，零PID枚举杀进程或清场', () => {
  const source = readFileSync('tools/data-qualification/run-cross-smoke.ps1', 'utf8');
  expect(source).toContain("@('session','sources','sources-ui','research','watch')");
  expect(source).toContain('[AIbrowse.ReleaseProfile.JobProcess]::Execute');
  expect(source).toContain("@('--import',([Uri]::new($scopeTool).AbsoluteUri),$cli,'dev')");
  expect(source).toContain("else { @('.') }");
  expect(source).not.toMatch(/\.Kill\(|Stop-Process|Remove-Item|Get-Process/);
  expect(readFileSync('node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js', 'utf8')).toContain(
    "ps.on('close', process.exit);",
  );
});

it('固定Node读回以真实只读SQLite保留running原件，再识别同任务interrupted', () => {
  const root = mkdtempSync(join(tmpdir(), 'cross-readback-'));
  const profile = join(root, 'profile');
  mkdirSync(join(profile, 'research'), { recursive: true });
  mkdirSync(join(profile, 'lifecycle-guardian'));
  const dbPath = join(profile, 'research/research.db');
  const db = new DatabaseSync(dbPath);
  db.exec(
    'CREATE TABLE research_tasks(id TEXT,status TEXT,phase TEXT,interrupted_at TEXT,result_id TEXT)',
  );
  const insert = db.prepare('INSERT INTO research_tasks VALUES(?,?,?,?,?)');
  for (const row of research().tasks)
    insert.run(row.id, row.status, row.phase, null, row.result ? 'result' : null);
  db.close();
  writeFileSync(
    join(profile, 'lifecycle-guardian/writers.json'),
    JSON.stringify({
      version: 1,
      root: 'a'.repeat(64),
      session: 'b'.repeat(32),
      main: null,
      utility: null,
    }),
  );
  const repository = join(root, 'repository');
  for (const part of ['main', 'preload', 'renderer', 'lifecycle-guardian'])
    mkdirSync(join(repository, 'out', part), { recursive: true });
  writeFileSync(
    join(repository, 'package.json'),
    JSON.stringify({ name: 'aibrowse', version: '1.0.0' }),
  );
  writeFileSync(join(repository, 'out/main/index.js'), 'fixed main');
  writeFileSync(join(repository, 'out/lifecycle-guardian/guardian.exe'), 'fixed helper');
  const hash = () => createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  for (const mode of ['set', 'check'] as const) {
    const appRoot = join(root, mode + '.app');
    const buildReceipt = join(root, mode + '.before.json');
    prepareCrossApp({ repository, appRoot, receipt: buildReceipt, electron: 'unused' });
    const logPath = join(appRoot, 'log/aibrowse-2026-10-04.log');
    if (mode === 'check') {
      const fixture = new DatabaseSync(dbPath);
      fixture
        .prepare(
          "UPDATE research_tasks SET status='interrupted',phase=NULL,interrupted_at='fixed' WHERE id=?",
        )
        .run(id);
      fixture.close();
    }
    writeFileSync(
      logPath,
      mode === 'set'
        ? research().log
        : 'RESEARCH check：读回与 interrupted 标记验证通过\n冒烟自检通过，正常退出',
    );
    const request = join(root, `${mode}.request.json`);
    const output = join(root, `${mode}.readback.json`);
    writeFileSync(
      request,
      JSON.stringify({
        root,
        profile,
        repository,
        appRoot,
        buildReceipt,
        kind: 'research',
        mode,
        exitCode: mode === 'set' ? 91 : 0,
        jobZero: true,
        expectedRunningId: mode === 'set' ? null : id,
        output,
      }),
    );
    const before = hash();
    execFileSync(
      process.execPath,
      [resolve('tools/data-qualification/cross-smoke-readback.ts'), request],
      {
        timeout: 5000,
        windowsHide: true,
        stdio: 'pipe',
        maxBuffer: 65536,
      },
    );
    expect(hash()).toBe(before);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toMatchObject({
      passed: true,
      ledgerRetired: true,
      runningId: id,
    });
  }
});
