// D4 SourceService 观察者接线测试（detailed-design §10.3）：六个写路径的
// prepare/commit/abort 次序、mutation 形状（before/after 窄投影、UUID
// mutationId、批量 change set 单 batch）、失败传播（hard-delete prepare 失败
// 零 Source 写；其余路径 prepare 失败仍提交但不报告已协调；commit 失败 Source
// 返回成功；Source 事务失败 abort 恰一次、abort 抛错 Source 返回原失败）、
// 内部窄投影读取端口（blocked 亦可见）。真实 node:sqlite + 临时目录。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from './db/sqlite-driver';
import { runMigrations } from './db/migrations';
import { SourceServiceImpl } from './source-service';
import type { SourceLifecycleObserver, SourceWatchMutation } from '../../shared/types/watch';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-source-watch-'));

let handle: DbHandle;
let second: DbHandle;
let service: SourceServiceImpl;
let observer: RecordingObserver;

const NOW = '2026-08-28T00:00:00.000Z';

class RecordingObserver implements SourceLifecycleObserver {
  prepares: SourceWatchMutation[][] = [];
  commits: string[][] = [];
  aborts: string[][] = [];
  prepareResult: { ok: true } | { ok: false; reason: 'watch-unavailable' } = { ok: true };
  commitResult: { ok: true } | { ok: false; reason: 'watch-unavailable' } = { ok: true };
  abortThrows = false;
  onPrepare: ((changes: SourceWatchMutation[]) => void) | null = null;

  reset(): void {
    this.prepares = [];
    this.commits = [];
    this.aborts = [];
    this.prepareResult = { ok: true };
    this.commitResult = { ok: true };
    this.abortThrows = false;
    this.onPrepare = null;
  }

  prepare(
    changes: SourceWatchMutation[],
  ): { ok: true } | { ok: false; reason: 'watch-unavailable' } {
    this.prepares.push(JSON.parse(JSON.stringify(changes)) as SourceWatchMutation[]);
    if (this.onPrepare !== null) this.onPrepare(changes);
    return this.prepareResult;
  }

  commit(mutationIds: string[]): { ok: true } | { ok: false; reason: 'watch-unavailable' } {
    this.commits.push([...mutationIds]);
    return this.commitResult;
  }

  abort(mutationIds: string[]): void {
    if (this.abortThrows) throw new Error('abort 注入异常');
    this.aborts.push([...mutationIds]);
  }
}

beforeEach(() => {
  const dbPath = join(root, `svc-${Math.random().toString(36).slice(2)}.db`);
  handle = openDb(dbPath);
  runMigrations(handle);
  second = openDb(dbPath); // 竞态注入用第二连接（WAL 多连接）
  observer = new RecordingObserver();
  service = new SourceServiceImpl({
    db: handle,
    now: () => Date.parse(NOW),
    observer,
  });
});

afterEach(() => {
  // Windows 句柄释放：精确关闭本用例连接，避免 afterAll rmSync EPERM
  service.dispose();
  if (second !== undefined && second.isOpen) second.close();
  if (handle !== undefined && handle.isOpen) handle.close();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('prepare/commit/abort 接线矩阵（§10.3）', () => {
  it('addManual：prepare 恰一次（create，before=null、after 窄投影）、成功后 commit 恰一次', async () => {
    const r = await service.addManual({
      scope: 'origin',
      url: 'https://example.com',
      name: '示例站',
    });
    expect(r.ok).toBe(true);
    expect(observer.prepares).toHaveLength(1);
    const [mutation] = observer.prepares[0]!;
    expect(mutation).toBeDefined();
    expect(mutation!.operation).toBe('create');
    expect(mutation!.before).toBeNull();
    expect(mutation!.after).toMatchObject({
      enabled: true,
      deletedAt: null,
      scope: 'origin',
      canonicalKey: 'https://example.com',
      rowVersion: 1,
    });
    expect(mutation!.after!.sourceId).toBe(r.ok ? r.source.id : '');
    expect(mutation!.mutationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(observer.commits).toHaveLength(1);
    expect(observer.commits[0]).toEqual([mutation!.mutationId]);
    expect(observer.aborts).toHaveLength(0);
  });

  it('quickAddPage 经 addManual 同一观察者路径', async () => {
    const r = await service.quickAddPage('https://example.com/page?q=1#frag');
    expect(r.status).toBe('added');
    expect(observer.prepares).toHaveLength(1);
    expect(observer.prepares[0]![0]!.operation).toBe('create');
    expect(observer.prepares[0]![0]!.after!.canonicalKey).toBe('https://example.com/page?q=1');
    expect(observer.commits).toHaveLength(1);
  });

  it('updateManual（metadata）：before/after 窄投影 + rowVersion+1；URL 更新 → canonicalKey 变化', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/doc' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    observer.prepares = [];
    observer.commits = [];
    const upd = await service.updateManual(add.source.id, { name: '新名' }, 1);
    expect(upd.ok).toBe(true);
    expect(observer.prepares).toHaveLength(1);
    const [m] = observer.prepares[0]!;
    expect(m!.operation).toBe('update');
    expect(m!.before).toMatchObject({
      sourceId: add.source.id,
      rowVersion: 1,
      canonicalKey: 'https://example.com/doc',
    });
    expect(m!.after).toMatchObject({
      rowVersion: 2,
      canonicalKey: 'https://example.com/doc',
      enabled: true,
    });
    expect(observer.commits).toHaveLength(1);

    observer.prepares = [];
    observer.commits = [];
    const urlUpd = await service.updateManual(
      add.source.id,
      { url: 'https://example.com/other' },
      2,
    );
    expect(urlUpd.ok).toBe(true);
    expect(observer.prepares[0]![0]!.after!.canonicalKey).toBe('https://example.com/other');
    expect(observer.commits).toHaveLength(1);
  });

  it('disableManual/restoreManual：operation 与 after.enabled/deletedAt 精确', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/doc' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    observer.prepares = [];
    observer.commits = [];
    const dis = await service.disableManual(add.source.id, 1);
    expect(dis.ok).toBe(true);
    const [dm] = observer.prepares[0]!;
    expect(dm!.operation).toBe('disable');
    expect(dm!.after).toMatchObject({ enabled: false, deletedAt: NOW, rowVersion: 2 });
    expect(observer.commits).toHaveLength(1);

    observer.prepares = [];
    observer.commits = [];
    const res = await service.restoreManual(add.source.id, 2);
    expect(res.ok).toBe(true);
    const [rm] = observer.prepares[0]!;
    expect(rm!.operation).toBe('restore');
    expect(rm!.after).toMatchObject({ enabled: true, deletedAt: null, rowVersion: 3 });
    expect(observer.commits).toHaveLength(1);
  });

  it('undo（update 回放）：after 为快照投影；undo 逆 add：after=null（走级联）', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/doc' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const upd = await service.updateManual(add.source.id, { name: '改名' }, 1);
    expect(upd.ok).toBe(true);
    if (!upd.ok) return;
    observer.reset();
    expect(await service.undoChange(upd.idempotencyKey)).toEqual({ ok: true });
    const [m] = observer.prepares[0]!;
    expect(m!.operation).toBe('undo');
    expect(m!.before).toMatchObject({ rowVersion: 2 });
    expect(m!.after).toMatchObject({ rowVersion: 1, enabled: true });
    expect(observer.commits).toHaveLength(1);

    observer.prepares = [];
    observer.commits = [];
    expect(await service.undoChange(add.idempotencyKey)).toEqual({ ok: true });
    const [um] = observer.prepares[0]!;
    expect(um!.operation).toBe('undo');
    expect(um!.after).toBeNull(); // 逆 add → 级联
    expect(observer.commits).toHaveLength(1);
    const proj = service.getSourceWatchProjection(add.source.id);
    expect(proj).toEqual({ status: 'missing' }); // Source 已物理删除（确定性 missing）
  });

  it('applyChangeSet：批量作为一个 observer batch（一次 prepare + 一次 commit）', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/a' });
    const addB = await service.addManual({ scope: 'page', url: 'https://example.com/b' });
    expect(add.ok && addB.ok).toBe(true);
    if (!add.ok || !addB.ok) return;
    observer.prepares = [];
    observer.commits = [];
    observer.aborts = [];
    const cs = await service.applyChangeSet(
      {
        ops: [
          { kind: 'add', scope: 'origin', url: 'https://example.org' },
          { kind: 'update', sourceId: add.source.id, expectedVersion: 1, patch: { priority: 5 } },
          { kind: 'disable', sourceId: addB.source.id, expectedVersion: 1 },
        ],
      },
      { runId: 'run-1', toolCallId: 'tool-1' },
    );
    expect(cs.ok).toBe(true);
    expect(observer.prepares).toHaveLength(1);
    expect(observer.prepares[0]!.length).toBe(3);
    expect(observer.prepares[0]!.map((m) => m.operation)).toEqual(['create', 'update', 'disable']);
    expect(observer.commits).toHaveLength(1);
    expect(observer.commits[0]!.length).toBe(3);
    expect(observer.aborts).toHaveLength(0);
  });

  it('预检失败（版本冲突）零观察者调用', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/a' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    observer.prepares = [];
    const bad = await service.updateManual(add.source.id, { name: 'x' }, 99);
    expect(bad.ok).toBe(false);
    expect(observer.prepares).toHaveLength(0);
  });

  it('hard-delete：prepare 失败 → source-unavailable 且 sources.db 零写', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/hd' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const token = service.issueDeleteConfirmToken(add.source.id);
    observer.prepares = [];
    observer.commits = [];
    observer.aborts = [];
    observer.prepareResult = { ok: false, reason: 'watch-unavailable' };
    const del = await service.hardDeleteManual(add.source.id, token);
    expect(del).toEqual({ ok: false, errorCode: 'source-unavailable' });
    expect(observer.prepares).toHaveLength(1);
    expect(observer.commits).toHaveLength(0);
    expect(observer.aborts).toHaveLength(0);
    // sources.db 零写：source 仍存在且可用
    const got = await service.get(add.source.id, 'user');
    expect(got.ok).toBe(true);
    expect(got.ok && got.source.id).toBe(add.source.id);
  });

  it('hard-delete：prepare 成功 → commit 恰一次；Source 事务失败 → abort 恰一次', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/hd2' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    observer.prepares = [];
    observer.commits = [];
    const token = service.issueDeleteConfirmToken(add.source.id);
    const del = await service.hardDeleteManual(add.source.id, token);
    expect(del.ok).toBe(true);
    expect(observer.prepares).toHaveLength(1);
    expect(observer.prepares[0]![0]!.operation).toBe('hard-delete');
    expect(observer.prepares[0]![0]!.after).toBeNull();
    expect(observer.commits).toHaveLength(1);
    expect(observer.aborts).toHaveLength(0);
    expect(service.getSourceWatchProjection(add.source.id)).toEqual({ status: 'missing' });
  });

  it('hard-delete 事务失败（FTS 表被并发破坏）→ abort 恰一次 + 原失败返回', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/hd3' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    observer.onPrepare = () => {
      second.exec('DROP TABLE sources_fts'); // 竞态注入：外层事务 FTS 写必失败
    };
    observer.prepares = [];
    observer.commits = [];
    observer.aborts = [];
    const token = service.issueDeleteConfirmToken(add.source.id);
    const del = await service.hardDeleteManual(add.source.id, token);
    expect(del).toEqual({ ok: false, errorCode: 'source-unavailable' });
    expect(observer.prepares).toHaveLength(1);
    expect(observer.commits).toHaveLength(0);
    expect(observer.aborts).toHaveLength(1);
    expect(observer.aborts[0]!.length).toBe(1);
  });

  it('prepare 失败（update 路径）：Source 操作仍成功返回但不报告 Watch 已协调', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/pf' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    observer.prepares = [];
    observer.commits = [];
    observer.aborts = [];
    observer.prepareResult = { ok: false, reason: 'watch-unavailable' };
    const upd = await service.updateManual(add.source.id, { name: '仍提交' }, 1);
    expect(upd.ok).toBe(true); // 原 Source 操作允许提交
    expect(observer.prepares).toHaveLength(1);
    expect(observer.commits).toHaveLength(0); // 不得报告 Watch 已协调
    expect(observer.aborts).toHaveLength(0);
    const got = await service.get(add.source.id, 'user');
    expect(got.ok && got.source.name).toBe('仍提交');
  });

  it('commit 失败：Source 返回成功（intent 留待启动 reconciliation）', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/cf' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    observer.prepares = [];
    observer.commits = [];
    observer.commitResult = { ok: false, reason: 'watch-unavailable' };
    const upd = await service.updateManual(add.source.id, { name: '提交成功' }, 1);
    expect(upd.ok).toBe(true);
    expect(observer.prepares).toHaveLength(1);
    expect(observer.commits).toHaveLength(1);
    expect(observer.aborts).toHaveLength(0);
  });

  it('abort 抛错：Source API 返回原失败、零崩溃', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/at' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    observer.abortThrows = true;
    observer.onPrepare = () => {
      second.exec('DROP TABLE sources_fts');
    };
    observer.prepares = [];
    observer.commits = [];
    observer.aborts = [];
    const upd = await service.updateManual(add.source.id, { name: 'x' }, 1);
    expect(upd).toEqual({ ok: false, errorCode: 'source-unavailable' });
    expect(observer.prepares).toHaveLength(1);
    expect(observer.commits).toHaveLength(0);
  });

  it('addManual 事务失败（并发唯一约束）→ abort 恰一次 + source-duplicate', async () => {
    let injected = false;
    observer.onPrepare = (changes) => {
      if (injected) return;
      injected = true;
      const m = changes[0]!;
      if (m.operation !== 'create' || m.after === null) return;
      // 第二连接抢注同 canonical → 外层事务 INSERT 撞唯一约束
      second
        .prepare(
          `INSERT INTO sources (id, scope, canonical_key, url, name, priority, enabled,
   share_mode, trust_value, trust_asserted_by, trust_verification, user_note,
   ai_note, created_by, version, created_at, updated_at, deleted_at,
   last_used_at, last_usage_outcome)
  VALUES (?, ?, ?, ?, ?, 3, 1, 'metadata', 'unknown', 'user', 'unverified', '',
   '', 'user', 1, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          randomUUID(),
          m.after.scope,
          m.after.canonicalKey,
          m.after.canonicalKey,
          '抢占',
          NOW,
          NOW,
        );
    };
    observer.prepares = [];
    observer.commits = [];
    observer.aborts = [];
    const r = await service.addManual({ scope: 'origin', url: 'https://example.org' });
    expect(r).toEqual({ ok: false, errorCode: 'source-duplicate' });
    expect(observer.prepares).toHaveLength(1);
    expect(observer.commits).toHaveLength(0);
    expect(observer.aborts).toHaveLength(1);
  });
});

describe('内部窄投影读取端口（三态协议：found/missing/unavailable）', () => {
  it('blocked 亦可见（user-audience）；不存在/非法 id → missing（确定性）', async () => {
    const add = await service.addManual({
      scope: 'page',
      url: 'https://example.com/blocked',
      shareMode: 'blocked',
    });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    const proj = service.getSourceWatchProjection(add.source.id);
    expect(proj.status).toBe('found');
    if (proj.status !== 'found') return;
    expect(proj.projection).toMatchObject({
      sourceId: add.source.id,
      rowVersion: 1,
      enabled: true,
      scope: 'page',
      canonicalKey: 'https://example.com/blocked',
    });
    expect(service.getSourceWatchProjection(randomUUID())).toEqual({ status: 'missing' });
    expect(service.getSourceWatchProjection('not-a-uuid')).toEqual({ status: 'missing' });
  });

  it('db 不可用/读取异常 → unavailable（绝不冒充 missing）', async () => {
    const add = await service.addManual({ scope: 'page', url: 'https://example.com/u' });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    service.dispose(); // 关闭句柄：读取通道整体不可用
    expect(service.getSourceWatchProjection(add.source.id)).toEqual({ status: 'unavailable' });
  });
});
