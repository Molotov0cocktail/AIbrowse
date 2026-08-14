// SourceService unit tests (B2): CRUD, unique-constraint duplicate, optimistic
// version, change set transaction all-or-nothing, idempotent replay (adjudication
// #53), durable undo (consumption semantics, adjudication #52), hard delete token
// (adjudication #56) + exact journal cleanup (adjudication #55), safe failure on
// invalid input, unexpected-error normalization, idempotent dispose.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type DbHandle } from './db/sqlite-driver';
import { runMigrations } from './db/migrations';
import { SourceServiceImpl } from './source-service';
import type { SourceChangeResult, SourceView, UndoResult } from '../../shared/types/sources';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-service-'));
const BASE_MS = Date.UTC(2026, 7, 15, 0, 0, 0);
const UUID = '11111111-1111-4111-8111-111111111111';

let handle: DbHandle;
let service: SourceServiceImpl;
let nowMs: number;

const okView = (r: unknown): SourceView => {
  const res = r as { ok: boolean; source: SourceView };
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res.source;
};
const okChange = (r: SourceChangeResult): SourceChangeResult => {
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r;
};
const failChange = (r: SourceChangeResult, code: string): SourceChangeResult => {
  expect(r.ok).toBe(false);
  expect(r.errorCode).toBe(code);
  return r;
};

beforeEach(() => {
  nowMs = BASE_MS;
  handle = openDb(join(root, `service-${Math.random().toString(36).slice(2)}.db`));
  runMigrations(handle);
  service = new SourceServiceImpl({ db: handle, now: () => nowMs });
});

afterEach(() => {
  service.dispose(); // 幂等；关闭句柄
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const addOne = async (
  url = 'https://example.com/p',
  over: Record<string, unknown> = {},
): Promise<SourceView> => {
  const r = await service.addManual({ scope: 'page', url, ...over });
  return okView(r);
};

describe('search / list / get — 非法输入安全返回', () => {
  it('search：query 非串/空/超 500 → source-invalid-change；limit 0/负/小数 → invalid；>10 → source-limit', async () => {
    const inv = await service.search('' as unknown as string, {});
    expect(inv).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await service.search('x'.repeat(501), {})).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.search('q', { limit: 0 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.search('q', { limit: 1.5 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.search('q', { limit: 11 })).toEqual({
      ok: false,
      errorCode: 'source-limit',
    });
  });

  it('search 最小实现：name/tag/group/canonical 参数化命中；条目不含 note 正文；软删行不命中', async () => {
    const s = await addOne('https://example.com/p', {
      name: 'Benchmark 站',
      tags: ['benchmark'],
      groupName: 'AI组',
      userNote: 'SECRET_NOTE_MARKER',
    });
    const hit = await service.search('benchmark', {});
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.results).toHaveLength(1);
      expect(hit.results[0]?.id).toBe(s.id);
      expect(JSON.stringify(hit.results)).not.toContain('SECRET_NOTE_MARKER');
    }
    expect(await service.search('AI组', {})).toMatchObject({ ok: true });
    await service.disableManual(s.id, 1);
    const miss = await service.search('Benchmark', {});
    expect(miss.ok).toBe(true);
    if (miss.ok) expect(miss.results).toHaveLength(0);
  });

  it('list：page/pageSize 校验、分页切割、total、groupId、enabledOnly、确定性排序', async () => {
    const a = await addOne('https://example.com/a', { name: 'a' });
    const b = await addOne('https://example.com/b', { name: 'b', groupName: '组' });
    expect(await service.list({ page: -1 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.list({ page: 0, pageSize: 21 })).toEqual({
      ok: false,
      errorCode: 'source-limit',
    });
    expect(await service.list({ page: 0, pageSize: 0 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    const page1 = await service.list({ page: 0, pageSize: 1 });
    expect(page1).toMatchObject({ ok: true, page: 0, pageSize: 1, total: 2 });
    if (page1.ok) expect(page1.items).toHaveLength(1);
    const page2 = await service.list({ page: 1, pageSize: 1 });
    if (page2.ok) expect(page2.items).toHaveLength(1);
    const byGroup = await service.list({ page: 0, groupId: null });
    if (byGroup.ok) expect(byGroup.items.map((i) => i.id)).toEqual([a.id]);
    await service.disableManual(b.id, 1);
    const enabledOnly = await service.list({ page: 0, enabledOnly: true });
    if (enabledOnly.ok) expect(enabledOnly.items.map((i) => i.id)).toEqual([a.id]);
  });

  it('get：形状非法 → invalid-change；不存在 → not-found；命中返回完整视图（version/deletedAt/note/groupName）', async () => {
    expect(await service.get('not-a-uuid')).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.get(UUID)).toEqual({ ok: false, errorCode: 'source-not-found' });
    const s = await addOne('https://example.com/p', {
      name: 'n',
      groupName: 'g',
      userNote: '备注正文',
    });
    const got = await service.get(s.id);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.source.version).toBe(1);
      expect(got.source.deletedAt).toBeNull();
      expect(got.source.userNote).toBe('备注正文');
      expect(got.source.groupName).toBe('g');
    }
  });
});

describe('手工写路径（决议 #51 状态机 + journal）', () => {
  it('addManual：全字段落库 + journal manual 行 + undoable', async () => {
    const r = await service.addManual({
      scope: 'origin',
      url: 'https://Example.COM',
      name: '示例',
      groupName: '组',
      tags: ['a', 'b'],
      priority: 5,
      shareMode: 'full',
      userNote: '备注',
      aiNote: 'ai',
      trust: { value: 'official' },
    });
    const s = okView(r);
    expect(s.canonicalKey).toBe('https://example.com');
    expect(s.tags).toEqual(['a', 'b']);
    expect(s.groupName).toBe('组');
    expect(s.priority).toBe(5);
    expect(s.trust).toEqual({ value: 'official', assertedBy: 'user', verification: 'asserted' });
    expect(s.version).toBe(1);
    const undoable = await service.listUndoable();
    expect(undoable).toHaveLength(1);
    expect(undoable[0]?.changeType).toBe('manual');
    expect(undoable[0]?.sourceIds).toEqual([s.id]);
  });

  it('addManual 缺省规则：name 默认生成、shareMode 按 userNote、trust user/asserted', async () => {
    const s = await addOne('https://example.com/path');
    expect(s.name).toBe('example.com/path');
    expect(s.shareMode).toBe('metadata');
    expect(s.trust).toEqual({ value: 'unknown', assertedBy: 'user', verification: 'asserted' });
  });

  it('addManual 手工可设 blocked（决议 #36 通道边界）', async () => {
    const s = await addOne('https://example.com/blocked', { shareMode: 'blocked' });
    expect(s.shareMode).toBe('blocked');
  });

  it('addManual 重复 canonical → source-duplicate 零写入（journal 不增）', async () => {
    await addOne();
    const r = await service.addManual({ scope: 'page', url: 'https://EXAMPLE.com/p' });
    expect(r).toMatchObject({ ok: false, errorCode: 'source-duplicate' });
    expect(await service.listUndoable()).toHaveLength(1); // 仅第一次 add 的 journal
  });

  it('addManual 非法 URL/超长 → source-invalid-change 零写入', async () => {
    expect(await service.addManual({ scope: 'page', url: 'ftp://x' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(
      await service.addManual({ scope: 'page', url: 'https://e.com', name: 'x'.repeat(201) }),
    ).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await service.list({ page: 0 })).toMatchObject({ ok: true, total: 0 });
  });

  it('updateManual：expectedVersion 匹配 → 恰 +1；过期 → version-conflict 零写入；不存在 → not-found', async () => {
    const s = await addOne();
    const up = await service.updateManual(
      s.id,
      { name: '新名', groupName: '新组', tags: ['x'] },
      1,
    );
    const s2 = okView(up);
    expect(s2.version).toBe(2);
    expect(s2.name).toBe('新名');
    expect(s2.groupName).toBe('新组');
    const stale = await service.updateManual(s.id, { name: '过期' }, 1);
    expect(stale).toEqual({ ok: false, errorCode: 'source-version-conflict' });
    expect(await service.updateManual(UUID, { name: 'x' }, 1)).toEqual({
      ok: false,
      errorCode: 'source-not-found',
    });
    const afterStale = await service.get(s.id);
    if (afterStale.ok) expect(afterStale.source.name).toBe('新名'); // 过期写未生效
  });

  it('updateManual：patch.enabled 拒绝（白名单外）；url 变更重新规范化 + 冲突 duplicate', async () => {
    const s = await addOne();
    expect(
      await service.updateManual(
        s.id,
        { enabled: false } as unknown as Parameters<typeof service.updateManual>[1],
        1,
      ),
    ).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    await addOne('https://example.com/other');
    const r = await service.updateManual(s.id, { url: 'https://EXAMPLE.com/other' }, 1);
    expect(r).toMatchObject({ ok: false, errorCode: 'source-duplicate' });
    const ok = await service.updateManual(s.id, { url: 'HTTPS://Example.COM:443/new#f' }, 1);
    const v = okView(ok);
    expect(v.canonicalKey).toBe('https://example.com/new');
    expect(v.url).toBe('https://example.com/new#f');
  });

  it('disable/restore 状态机：enabled/deletedAt 联动 + version 恰 +1；同方向重复照常 +1（决议 #51）', async () => {
    const s = await addOne();
    const d = okView(await service.disableManual(s.id, 1));
    expect(d.enabled).toBe(false);
    expect(d.deletedAt).not.toBeNull();
    expect(d.version).toBe(2);
    const d2 = okView(await service.disableManual(s.id, 2));
    expect(d2.version).toBe(3); // 同方向照常执行
    const r = okView(await service.restoreManual(s.id, 3));
    expect(r.enabled).toBe(true);
    expect(r.deletedAt).toBeNull();
    expect(r.version).toBe(4);
    expect(await service.disableManual(s.id, 3)).toEqual({
      ok: false,
      errorCode: 'source-version-conflict',
    });
  });
});

describe('hardDeleteManual（决议 #56 能力令牌 + #55 精确清理）', () => {
  it('未签发/错 token/错绑定 → source-conflict 零删除', async () => {
    const s = await addOne();
    expect(await service.hardDeleteManual(s.id, '')).toEqual({
      ok: false,
      errorCode: 'source-conflict',
    });
    expect(await service.hardDeleteManual(s.id, 'fake-token')).toEqual({
      ok: false,
      errorCode: 'source-conflict',
    });
    const other = await addOne('https://example.com/other');
    const token = service.issueDeleteConfirmToken(s.id);
    expect(await service.hardDeleteManual(other.id, token)).toEqual({
      ok: false,
      errorCode: 'source-conflict',
    }); // 错绑定
    expect((await service.get(s.id)).ok).toBe(true); // 零删除
  });

  it('过期（TTL 300s，注入时钟）与重用 → source-conflict 零删除', async () => {
    const s = await addOne();
    const token = service.issueDeleteConfirmToken(s.id);
    nowMs = BASE_MS + 300_001; // 超过 TTL
    expect(await service.hardDeleteManual(s.id, token)).toEqual({
      ok: false,
      errorCode: 'source-conflict',
    });
    nowMs = BASE_MS;
    const fresh = service.issueDeleteConfirmToken(s.id);
    expect((await service.hardDeleteManual(s.id, fresh)).ok).toBe(true);
    expect(await service.hardDeleteManual(s.id, fresh)).toEqual({
      ok: false,
      errorCode: 'source-conflict',
    }); // 重用
  });

  it('成功：行/FTS/usage 全清、journal 精确清理（多 source 行保留其余）、undoable=false', async () => {
    const s1 = await addOne('https://example.com/a', { name: '待删页' });
    const s2 = await addOne('https://example.com/b', { name: '保留页' });
    await service.recordUsage(s1.id, 'reachable');
    // 一个 change set 同时影响 s1 与 s2（journal 多 source 行）
    okChange(
      await service.applyChangeSet(
        {
          ops: [
            { kind: 'update', sourceId: s1.id, expectedVersion: 1, patch: { name: '待删页改' } },
            { kind: 'update', sourceId: s2.id, expectedVersion: 1, patch: { name: '保留页改' } },
          ],
        },
        { runId: 'run-1', toolCallId: 'tool-1' },
      ),
    );
    const before = await service.listUndoable();
    expect(before.some((u) => u.sourceIds.length === 2)).toBe(true);
    const token = service.issueDeleteConfirmToken(s1.id);
    const r = await service.hardDeleteManual(s1.id, token);
    expect(r).toMatchObject({ ok: true, undoable: false, idempotencyKey: '' });
    expect(await service.get(s1.id)).toEqual({ ok: false, errorCode: 'source-not-found' });
    // FTS 行清理（镜像行数 == 主表行数）
    const ftsCount = (
      handle.prepare('SELECT COUNT(*) AS n FROM sources_fts').get() as { n: number }
    ).n;
    const mainCount = (handle.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number })
      .n;
    expect(ftsCount).toBe(mainCount);
    expect(ftsCount).toBe(1);
    // usage 行清理（FK CASCADE）
    expect(
      (handle.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n,
    ).toBe(0);
    // journal 精确清理：change set 行 sourceIds 只剩 s2；s1 的 manual 行整行删除
    const undoable = await service.listUndoable();
    const setEntry = undoable.find((u) => u.changeType === 'agent-change-set');
    expect(setEntry?.sourceIds).toEqual([s2.id]);
    expect(undoable.some((u) => u.changeType === 'manual' && u.sourceIds[0] === s1.id)).toBe(false);
    // Undo 不复活已 hard-deleted 的 s1：undo 该 change set → s2 恢复、s1 仍不存在
    expect((await service.undoChange(setEntry?.idempotencyKey ?? '')).ok).toBe(true);
    expect((await service.get(s2.id)).ok).toBe(true);
    expect(await service.get(s1.id)).toEqual({ ok: false, errorCode: 'source-not-found' });
  });
});

describe('applyChangeSet — 结构校验与整体拒绝', () => {
  it('21 项 → source-limit；assertedBy=user → invalid-change；blocked → invalid-change；均零写入', async () => {
    const ops21 = Array.from({ length: 21 }, (_, i) => ({
      kind: 'add' as const,
      scope: 'page' as const,
      url: `https://e.com/${i}`,
    }));
    expect(
      await service.applyChangeSet({ ops: ops21 }, { runId: 'r', toolCallId: 't' }),
    ).toMatchObject({
      ok: false,
      errorCode: 'source-limit',
      idempotencyKey: '',
    });
    expect(
      await service.applyChangeSet(
        {
          ops: [
            {
              kind: 'add',
              scope: 'page',
              url: 'https://e.com',
              trust: { value: 'official', assertedBy: 'user' },
            },
          ],
        },
        { runId: 'r', toolCallId: 't' },
      ),
    ).toMatchObject({ ok: false, errorCode: 'source-invalid-change' });
    expect(
      await service.applyChangeSet(
        { ops: [{ kind: 'add', scope: 'page', url: 'https://e.com', shareMode: 'blocked' }] },
        {
          runId: 'r',
          toolCallId: 't',
        },
      ),
    ).toMatchObject({ ok: false, errorCode: 'source-invalid-change' });
    expect(await service.list({ page: 0 })).toMatchObject({ ok: true, total: 0 });
    expect(await service.listUndoable()).toHaveLength(0);
  });

  it('expectedVersion 不符 → version-conflict 整体拒绝（results 逐项、零写入）', async () => {
    const s = await addOne();
    const r = await service.applyChangeSet(
      {
        ops: [
          { kind: 'add', scope: 'page', url: 'https://example.com/new' },
          { kind: 'update', sourceId: s.id, expectedVersion: 99, patch: { name: 'x' } },
        ],
      },
      { runId: 'r1', toolCallId: 't1' },
    );
    failChange(r, 'source-version-conflict');
    expect(r.results.map((x) => x.errorCode)).toEqual([undefined, 'source-version-conflict']);
    expect(await service.get(s.id)).toMatchObject({
      ok: true,
      source: { name: 'example.com/p', version: 1 },
    });
    expect((await service.list({ page: 0 })).ok && (await service.list({ page: 0 }))).toMatchObject(
      { total: 1 },
    );
  });

  it('目标不存在 → source-not-found 整体拒绝', async () => {
    const r = await service.applyChangeSet(
      { ops: [{ kind: 'disable', sourceId: UUID, expectedVersion: 1 }] },
      { runId: 'r2', toolCallId: 't2' },
    );
    failChange(r, 'source-not-found');
  });

  it('与既有条目重复 → source-duplicate + 回注 existingSourceId（零覆盖）', async () => {
    const s = await addOne();
    const r = await service.applyChangeSet(
      { ops: [{ kind: 'add', scope: 'page', url: 'https://EXAMPLE.com/p' }] },
      { runId: 'r3', toolCallId: 't3' },
    );
    failChange(r, 'source-duplicate');
    expect(r.results[0]?.existingSourceId).toBe(s.id);
  });

  it('同 set 内 duplicate（第 2 项冲突）→ 整体 rollback：第一个 add 零残留、journal 零', async () => {
    const r = await service.applyChangeSet(
      {
        ops: [
          { kind: 'add', scope: 'page', url: 'https://example.com/a' },
          { kind: 'add', scope: 'page', url: 'https://EXAMPLE.com/a' }, // host 大小写折叠 → 同 canonical
        ],
      },
      { runId: 'r4', toolCallId: 't4' },
    );
    failChange(r, 'source-duplicate');
    expect(await service.list({ page: 0 })).toMatchObject({ ok: true, total: 0 });
    expect(await service.listUndoable()).toHaveLength(0);
    expect((handle.prepare('SELECT COUNT(*) AS n FROM source_tags').get() as { n: number }).n).toBe(
      0,
    );
    expect(
      (handle.prepare('SELECT COUNT(*) AS n FROM source_tag_links').get() as { n: number }).n,
    ).toBe(0);
    expect((handle.prepare('SELECT COUNT(*) AS n FROM sources_fts').get() as { n: number }).n).toBe(
      0,
    );
  });
});

describe('applyChangeSet — 成功提交与幂等重放（决议 #53）', () => {
  it('混合 op 成功：单事务 + 每 op 结果 + journal 恰一条 + version 每次提交恰 +1', async () => {
    const t1 = await addOne('https://example.com/target1');
    const t2 = await addOne('https://example.com/target2');
    const t3 = await addOne('https://example.com/target3');
    const r = okChange(
      await service.applyChangeSet(
        {
          ops: [
            { kind: 'add', scope: 'page', url: 'https://example.com/one', tags: ['t'] },
            { kind: 'add', scope: 'origin', url: 'https://example.org' },
            { kind: 'update', sourceId: t1.id, expectedVersion: 1, patch: { name: 'n' } },
            { kind: 'disable', sourceId: t2.id, expectedVersion: 1 },
            { kind: 'restore', sourceId: t3.id, expectedVersion: 1 },
          ],
        },
        { runId: 'r5', toolCallId: 't5' },
      ),
    );
    expect(r.idempotencyKey).not.toBe('');
    expect(r.results.map((x) => x.ok)).toEqual([true, true, true, true, true]);
    const v1 = await service.get(t1.id);
    const v2 = await service.get(t2.id);
    const v3 = await service.get(t3.id);
    if (v1.ok) expect(v1.source.version).toBe(2); // 每次成功提交恰 +1
    if (v2.ok) expect(v2.source.enabled).toBe(false); // disable 状态机
    if (v3.ok) expect(v3.source.enabled).toBe(true); // restore 状态机
    const undoable = await service.listUndoable();
    expect(undoable.filter((u) => u.changeType === 'agent-change-set')).toHaveLength(1);
    expect(undoable.find((u) => u.changeType === 'agent-change-set')?.sourceIds).toHaveLength(5);
  });

  it('AI 通道 trust 恒 unverified：add 携带 ai+official → 落库 {official, ai, unverified}', async () => {
    const r = okChange(
      await service.applyChangeSet(
        {
          ops: [
            {
              kind: 'add',
              scope: 'page',
              url: 'https://example.com/trust',
              trust: { value: 'official', assertedBy: 'ai' },
            },
          ],
        },
        { runId: 'r6', toolCallId: 't6' },
      ),
    );
    const id = r.results[0]?.sourceId ?? '';
    const got = await service.get(id);
    if (got.ok)
      expect(got.source.trust).toEqual({
        value: 'official',
        assertedBy: 'ai',
        verification: 'unverified',
      });
  });

  it('幂等重放：同 (runId, toolCallId) 同指纹 → 原结果同 key 零重写；异指纹 → source-conflict', async () => {
    const ops = [{ kind: 'add', scope: 'page', url: 'https://example.com/replay' }] as const;
    const meta = { runId: 'r7', toolCallId: 't7' };
    const first = okChange(await service.applyChangeSet({ ops: [...ops] }, meta));
    const id = first.results[0]?.sourceId ?? '';
    const replay = await service.applyChangeSet({ ops: [...ops] }, meta);
    expect(replay.ok).toBe(true);
    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
    const afterReplay = await service.get(id);
    if (afterReplay.ok) expect(afterReplay.source.version).toBe(1); // 未重写（版本未变）
    expect(await service.listUndoable()).toHaveLength(1);
    const tampered = await service.applyChangeSet(
      { ops: [{ kind: 'add', scope: 'page', url: 'https://example.com/different' }] },
      meta,
    );
    expect(tampered).toEqual({
      ok: false,
      errorCode: 'source-conflict',
      idempotencyKey: '',
      results: [],
    });
  });

  it('失败提交零落 journal：同 (run, tool) 修正后重提视为新提交', async () => {
    const s = await addOne();
    const meta = { runId: 'r8', toolCallId: 't8' };
    const ops = [
      { kind: 'update', sourceId: s.id, expectedVersion: 99, patch: { name: 'x' } },
    ] as const;
    expect((await service.applyChangeSet({ ops: [...ops] }, meta)).ok).toBe(false); // 版本冲突
    expect((await service.listUndoable()).length).toBe(1); // 仅 addManual 行
    const retry = await service.applyChangeSet(
      { ops: [{ kind: 'update', sourceId: s.id, expectedVersion: 1, patch: { name: 'x' } }] },
      meta,
    );
    expect(retry.ok).toBe(true);
  });

  it('跨 run 同 toolCallId 不冲突（部分唯一索引以 run_id 区分）', async () => {
    const opsA = [{ kind: 'add', scope: 'page', url: 'https://example.com/cross-a' }] as const;
    const opsB = [{ kind: 'add', scope: 'page', url: 'https://example.com/cross-b' }] as const;
    const a = okChange(
      await service.applyChangeSet({ ops: [...opsA] }, { runId: 'ra', toolCallId: 'same' }),
    );
    const b = okChange(
      await service.applyChangeSet({ ops: [...opsB] }, { runId: 'rb', toolCallId: 'same' }),
    );
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it('SQL 注入串仅作数据（name/note 含 SQL 片段 → 落库恒等、表完好）', async () => {
    const evil = "'; DROP TABLE sources;--";
    okChange(
      await service.applyChangeSet(
        {
          ops: [
            {
              kind: 'add',
              scope: 'page',
              url: 'https://example.com/inject',
              name: evil,
              userNote: "' OR 1=1 --",
            },
          ],
        },
        { runId: 'r9', toolCallId: 't9' },
      ),
    );
    const hit = await service.search(evil, {});
    if (hit.ok) expect(hit.results).toHaveLength(1);
    expect(
      (
        handle.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'sources'").get() as {
          n: number;
        }
      ).n,
    ).toBe(1);
  });
});

describe('undoChange — durable Undo（决议 #52 消费语义 / #55）', () => {
  it('undo add → 反向删除（行/FTS/tags 全清）', async () => {
    const r = okChange(
      await service.applyChangeSet(
        {
          ops: [
            {
              kind: 'add',
              scope: 'page',
              url: 'https://example.com/undo-add',
              tags: ['x'],
              name: '待删',
            },
          ],
        },
        { runId: 'r10', toolCallId: 't10' },
      ),
    );
    const id = r.results[0]?.sourceId ?? '';
    expect((await service.undoChange(r.idempotencyKey)).ok).toBe(true);
    expect(await service.get(id)).toEqual({ ok: false, errorCode: 'source-not-found' });
    expect((handle.prepare('SELECT COUNT(*) AS n FROM sources_fts').get() as { n: number }).n).toBe(
      0,
    );
    expect(
      (handle.prepare('SELECT COUNT(*) AS n FROM source_tag_links').get() as { n: number }).n,
    ).toBe(0);
  });

  it('undo update → 字段/版本恢复；undo disable → enabled 恢复', async () => {
    const s = await addOne();
    const upd = await service.updateManual(s.id, { name: '新名' }, 1);
    if (upd.ok) {
      expect((await service.undoChange(upd.idempotencyKey)).ok).toBe(true);
      const v = await service.get(s.id);
      if (v.ok) {
        expect(v.source.name).toBe('example.com/p'); // addOne 缺省 name（默认生成）
        expect(v.source.version).toBe(1); // before 快照恢复（含版本）
      }
    }
    const dis = await service.disableManual(s.id, 1);
    if (dis.ok) {
      expect((await service.undoChange(dis.idempotencyKey)).ok).toBe(true);
      const v = await service.get(s.id);
      if (v.ok) expect(v.source.enabled).toBe(true);
    }
  });

  it('版本冲突：undo 前又修改 → source-undo-conflict 零写入不覆盖', async () => {
    const s = await addOne();
    const upd = await service.updateManual(s.id, { name: '第一次' }, 1);
    if (!upd.ok) return;
    await service.updateManual(s.id, { name: '后续修改' }, 2); // undo 目标版本已过期
    const r = await service.undoChange(upd.idempotencyKey);
    expect(r).toEqual({ ok: false, errorCode: 'source-undo-conflict' });
    const v = await service.get(s.id);
    if (v.ok) expect(v.source.name).toBe('后续修改'); // 用户修改未被覆盖
  });

  it('重复 Undo 幂等（消费后 undo-not-found 零写入）；未知 key → undo-not-found', async () => {
    const r = okChange(
      await service.applyChangeSet(
        { ops: [{ kind: 'add', scope: 'page', url: 'https://example.com/once' }] },
        { runId: 'r11', toolCallId: 't11' },
      ),
    );
    expect((await service.undoChange(r.idempotencyKey)).ok).toBe(true);
    const again = await service.undoChange(r.idempotencyKey);
    expect(again).toEqual({ ok: false, errorCode: 'source-undo-not-found' });
    expect(await service.undoChange('no-such-key')).toEqual({
      ok: false,
      errorCode: 'source-undo-not-found',
    });
  });

  it('畸形 payload → source-unavailable 安全失败零写入', async () => {
    const r = okChange(
      await service.applyChangeSet(
        { ops: [{ kind: 'add', scope: 'page', url: 'https://example.com/tamper' }] },
        { runId: 'r12', toolCallId: 't12' },
      ),
    );
    handle
      .prepare('UPDATE change_journal SET before_payload = ? WHERE idempotency_key = ?')
      .run('not-json', r.idempotencyKey);
    const res: UndoResult = await service.undoChange(r.idempotencyKey);
    expect(res).toEqual({ ok: false, errorCode: 'source-unavailable' });
    expect(await service.list({ page: 0 })).toMatchObject({ ok: true, total: 1 }); // 零写入
  });

  it('重启后 Undo 可用（新连接新实例）', async () => {
    const dbPath = join(root, `restart-${Math.random().toString(36).slice(2)}.db`);
    const h1 = openDb(dbPath);
    runMigrations(h1);
    const s1 = new SourceServiceImpl({ db: h1, now: () => nowMs });
    const r = await s1.applyChangeSet(
      { ops: [{ kind: 'add', scope: 'page', url: 'https://example.com/restart' }] },
      { runId: 'r13', toolCallId: 't13' },
    );
    expect(r.ok).toBe(true);
    s1.dispose(); // 完整退出（关库）
    const h2 = openDb(dbPath); // 「重启」：新进程语义 = 新连接
    runMigrations(h2);
    const s2 = new SourceServiceImpl({ db: h2, now: () => nowMs });
    try {
      expect((await s2.undoChange(r.idempotencyKey)).ok).toBe(true);
      expect(await s2.list({ page: 0 })).toMatchObject({ ok: true, total: 0 });
    } finally {
      s2.dispose();
      closeDb(h1); // 已由 s1.dispose 关闭；重复关闭幂等兜底
    }
  });
});

describe('recordUsage / getState / dispose / 异常归一化', () => {
  it('recordUsage：合法 upsert 最近一次；非法输入安全 no-op 不抛', async () => {
    const s = await addOne();
    await service.recordUsage(s.id, 'reachable');
    await service.recordUsage(s.id, 'unreachable');
    await service.recordUsage('not-uuid', 'reachable'); // 安全 no-op
    await service.recordUsage(
      s.id,
      'nonsense' as unknown as Parameters<typeof service.recordUsage>[1],
    );
    const row = handle
      .prepare('SELECT outcome FROM usage_events WHERE source_id = ?')
      .get(s.id) as { outcome: string };
    expect(row.outcome).toBe('unreachable');
  });

  it('getState 恒 normal（恢复态装配归 B7）', () => {
    expect(service.getState()).toEqual({ mode: 'normal', reason: null });
  });

  it('listUndoable：summary 不含 note 正文；畸形行跳过不崩溃', async () => {
    await addOne('https://example.com/sum', { userNote: 'SECRET_NOTE_MARKER' });
    const list = await service.listUndoable();
    expect(list.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain('SECRET_NOTE_MARKER');
    handle
      .prepare("UPDATE change_journal SET before_payload = '{{{{' WHERE change_type = 'manual'")
      .run();
    expect(await service.listUndoable()).toHaveLength(0); // 畸形行安全跳过
  });

  it('dispose 幂等；dispose 后调用 → source-unavailable 安全返回（不抛）', async () => {
    service.dispose();
    service.dispose();
    expect(await service.list({ page: 0 })).toEqual({ ok: false, errorCode: 'source-unavailable' });
    expect(await service.get(UUID)).toEqual({ ok: false, errorCode: 'source-unavailable' });
  });

  it('不可预期 DB 错误 → source-unavailable（日志可诊断、不抛、不泄数据）', async () => {
    handle.exec('DROP TABLE sources'); // 测试专用 SQL：模拟不可预期故障
    expect(await service.list({ page: 0 })).toEqual({ ok: false, errorCode: 'source-unavailable' });
    const r = await service.applyChangeSet(
      { ops: [{ kind: 'add', scope: 'page', url: 'https://example.com/x' }] },
      { runId: 'r14', toolCallId: 't14' },
    );
    expect(r).toMatchObject({ ok: false, errorCode: 'source-unavailable', idempotencyKey: '' });
  });
});
