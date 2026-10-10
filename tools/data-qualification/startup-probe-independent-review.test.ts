import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { runStartupProbe } from '../../src/main/storage/startup-probe';
import { superviseStartupProbe } from '../../src/main/storage/startup-probe-supervisor';
import { TransferBudget } from '../../src/main/storage/transfer-budget';
import type { TransferChildEvents } from '../../src/main/storage/transfer-supervisor';

it('future版本仅在已提交WAL里也必须拒绝，不能因main header为0而创建其它空库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'probe-wal-future-independent-'));
  mkdirSync(join(root, 'watch'));
  const path = join(root, 'watch', 'watch.db');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA user_version=99;');
    expect(readFileSync(path).readUInt32BE(60)).toBe(0);
    const digest = (name: string) => createHash('sha256').update(readFileSync(name)).digest('hex');
    const original = [digest(path), digest(path + '-wal')];
    expect(
      await runStartupProbe(root, {
        signal: new AbortController().signal,
        deadline: performance.now() + 5000,
      }),
    ).toEqual({ state: 'recovery-required', code: 'future', domain: 'watch' });
    expect([digest(path), digest(path + '-wal')]).toEqual(original);
    expect(existsSync(join(root, 'sources'))).toBe(false);
    expect(existsSync(join(root, 'research'))).toBe(false);
  } finally {
    db.close();
  }
});

it('合法result先到但实际exit晚于原SQLite额度，未触发timer也不得授成功', async () => {
  let now = 0;
  const budget = new TransferBudget(() => now);
  budget.enter('sqlite');
  now = 89000;
  budget.leave();
  const operationId = randomUUID();
  let events!: TransferChildEvents;
  const handle = superviseStartupProbe({
    operationId,
    budget,
    signal: new AbortController().signal,
    timers: { set: () => () => {} },
    spawn(_operationId, sink) {
      events = sink;
      return {
        postMessage() {
          sink.onMessage(JSON.stringify({ type: 'ready', operationId }));
          sink.onMessage(
            JSON.stringify({
              type: 'result',
              operationId,
              result: {
                state: 'normal',
                root: { dev: '1', ino: '2' },
                members: ['sources', 'research', 'watch'].map((id) => ({
                  id,
                  state: 'missing',
                  version: null,
                  directory: null,
                  database: null,
                  wal: null,
                  journal: null,
                })),
              },
            }),
          );
        },
        kill: () => false,
        disposeListeners() {},
      };
    },
  });
  expect(handle.ownsChild()).toBe(true);
  now = 90001;
  events.onExit(0);
  await expect(handle.done).resolves.toEqual({ state: 'failed', code: 'deadline', exitCode: 0 });
  expect(handle.ownsChild()).toBe(false);
});
