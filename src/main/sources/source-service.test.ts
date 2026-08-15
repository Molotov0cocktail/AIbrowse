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
    const inv = await service.search('' as unknown as string, { audience: 'user' });
    expect(inv).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await service.search('x'.repeat(501), { audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.search('q', { limit: 0, audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.search('q', { limit: 1.5, audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.search('q', { limit: 11, audience: 'user' })).toEqual({
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
    const hit = await service.search('benchmark', { audience: 'user' });
    expect(hit.ok).toBe(true);
    if (hit.ok) {
      expect(hit.results).toHaveLength(1);
      expect(hit.results[0]?.id).toBe(s.id);
      expect(JSON.stringify(hit.results)).not.toContain('SECRET_NOTE_MARKER');
    }
    expect(await service.search('AI组', { audience: 'user' })).toMatchObject({ ok: true });
    await service.disableManual(s.id, 1);
    const miss = await service.search('Benchmark', { audience: 'user' });
    expect(miss.ok).toBe(true);
    if (miss.ok) expect(miss.results).toHaveLength(0);
  });

  it('list：page/pageSize 校验、分页切割、total、groupId、enabledOnly、确定性排序', async () => {
    const a = await addOne('https://example.com/a', { name: 'a' });
    const b = await addOne('https://example.com/b', { name: 'b', groupName: '组' });
    expect(await service.list({ page: -1, audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.list({ page: 0, pageSize: 21, audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-limit',
    });
    expect(await service.list({ page: 0, pageSize: 0, audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    const page1 = await service.list({ page: 0, pageSize: 1, audience: 'user' });
    expect(page1).toMatchObject({ ok: true, page: 0, pageSize: 1, total: 2 });
    if (page1.ok) expect(page1.items).toHaveLength(1);
    const page2 = await service.list({ page: 1, pageSize: 1, audience: 'user' });
    if (page2.ok) expect(page2.items).toHaveLength(1);
    const byGroup = await service.list({ page: 0, groupId: null, audience: 'user' });
    if (byGroup.ok) expect(byGroup.items.map((i) => i.id)).toEqual([a.id]);
    await service.disableManual(b.id, 1);
    const enabledOnly = await service.list({ page: 0, enabledOnly: true, audience: 'user' });
    if (enabledOnly.ok) expect(enabledOnly.items.map((i) => i.id)).toEqual([a.id]);
  });

  it('get：形状非法 → invalid-change；不存在 → not-found；命中返回完整视图（version/deletedAt/note/groupName）', async () => {
    expect(await service.get('not-a-uuid', 'user')).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.get(UUID, 'user')).toEqual({ ok: false, errorCode: 'source-not-found' });
    const s = await addOne('https://example.com/p', {
      name: 'n',
      groupName: 'g',
      userNote: '备注正文',
    });
    const got = await service.get(s.id, 'user');
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
    expect(await service.list({ page: 0, audience: 'user' })).toMatchObject({ ok: true, total: 0 });
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
    const afterStale = await service.get(s.id, 'user');
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
    expect((await service.get(s.id, 'user')).ok).toBe(true); // 零删除
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
    expect(await service.get(s1.id, 'user')).toEqual({ ok: false, errorCode: 'source-not-found' });
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
    expect((await service.get(s2.id, 'user')).ok).toBe(true);
    expect(await service.get(s1.id, 'user')).toEqual({ ok: false, errorCode: 'source-not-found' });
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
    expect(await service.list({ page: 0, audience: 'user' })).toMatchObject({ ok: true, total: 0 });
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
    expect(await service.get(s.id, 'user')).toMatchObject({
      ok: true,
      source: { name: 'example.com/p', version: 1 },
    });
    expect(
      (await service.list({ page: 0, audience: 'user' })).ok &&
        (await service.list({ page: 0, audience: 'user' })),
    ).toMatchObject({ total: 1 });
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
    expect(await service.list({ page: 0, audience: 'user' })).toMatchObject({ ok: true, total: 0 });
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
    const v1 = await service.get(t1.id, 'user');
    const v2 = await service.get(t2.id, 'user');
    const v3 = await service.get(t3.id, 'user');
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
    const got = await service.get(id, 'user');
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
    const afterReplay = await service.get(id, 'user');
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
    const hit = await service.search(evil, { audience: 'user' });
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
    expect(await service.get(id, 'user')).toEqual({ ok: false, errorCode: 'source-not-found' });
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
      const v = await service.get(s.id, 'user');
      if (v.ok) {
        expect(v.source.name).toBe('example.com/p'); // addOne 缺省 name（默认生成）
        expect(v.source.version).toBe(1); // before 快照恢复（含版本）
      }
    }
    const dis = await service.disableManual(s.id, 1);
    if (dis.ok) {
      expect((await service.undoChange(dis.idempotencyKey)).ok).toBe(true);
      const v = await service.get(s.id, 'user');
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
    const v = await service.get(s.id, 'user');
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
    expect(await service.list({ page: 0, audience: 'user' })).toMatchObject({ ok: true, total: 1 }); // 零写入
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
      expect(await s2.list({ page: 0, audience: 'user' })).toMatchObject({ ok: true, total: 0 });
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
    expect(await service.list({ page: 0, audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await service.get(UUID, 'user')).toEqual({ ok: false, errorCode: 'source-unavailable' });
  });

  it('不可预期 DB 错误 → source-unavailable（日志可诊断、不抛、不泄数据）', async () => {
    handle.exec('DROP TABLE sources'); // 测试专用 SQL：模拟不可预期故障
    expect(await service.list({ page: 0, audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    const r = await service.applyChangeSet(
      { ops: [{ kind: 'add', scope: 'page', url: 'https://example.com/x' }] },
      { runId: 'r14', toolCallId: 't14' },
    );
    expect(r).toMatchObject({ ok: false, errorCode: 'source-unavailable', idempotencyKey: '' });
  });
});
// ---------- B3 检索：audience × 分享模式 × 多语言 × 排序 × 有界（决议 #58–#63） ----------

describe('B3 search/list/get — audience 契约与分享模式矩阵', () => {
  const addFull = () =>
    addOne('https://example.com/zh', {
      name: '基准测试站',
      tags: ['benchmark'],
      groupName: 'AI组',
      shareMode: 'full',
      userNote: '看大模型评测优先看这里',
      aiNote: 'AI 推断的中文备注',
      priority: 5,
    });
  const addMeta = () =>
    addOne('https://example.com/en', {
      name: 'Electron Docs',
      shareMode: 'metadata',
      userNote: 'META_SECRET_1',
      aiNote: 'META_SECRET_2',
    });
  const addBlocked = () =>
    addOne('https://example.com/hidden', {
      name: '隐藏站',
      shareMode: 'blocked',
      userNote: 'BLOCKED_SECRET',
    });

  it('audience 必填：缺失/非法值 → source-invalid-change（search/list/get 一致）', async () => {
    expect(await service.search('q', { audience: undefined as never })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.search('q', { audience: 'x' as never })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.list({ page: 0, audience: undefined as never })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.get(UUID, 'x' as never)).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
  });

  it('agent 视角 blocked 完全不可见：search 不命中/list 不列出/get 视同不存在；user 视角可见可管理', async () => {
    await addFull();
    await addBlocked();
    const agentSearch = await service.search('隐藏', { audience: 'agent' });
    expect(agentSearch.ok && agentSearch.results).toHaveLength(0);
    const userSearch = await service.search('隐藏', { audience: 'user' });
    expect(userSearch.ok && userSearch.results.map((r) => r.name)).toContain('隐藏站');
    const agentList = await service.list({ page: 0, audience: 'agent' });
    expect(agentList.ok && agentList.total).toBe(1); // blocked 不计入 total（不分页空洞）
    expect(agentList.ok && agentList.items.every((i) => i.shareMode !== 'blocked')).toBe(true);
    const userList = await service.list({ page: 0, audience: 'user' });
    expect(userList.ok && userList.total).toBe(2);
    expect(userList.ok && userList.items.some((i) => i.shareMode === 'blocked')).toBe(true);
    const blockedId = userList.ok ? userList.items.find((i) => i.shareMode === 'blocked')!.id : '';
    expect(await service.get(blockedId, 'agent')).toEqual({
      ok: false,
      errorCode: 'source-not-found',
    });
    const userGet = await service.get(blockedId, 'user');
    expect(userGet.ok && userGet.source.userNote).toBe('BLOCKED_SECRET');
  });

  it('agent 视角 metadata 零 note 字节（含 note 不参与命中）；user get 恒完整视图', async () => {
    await addMeta();
    const hit = await service.search('Electron', { audience: 'agent' });
    expect(hit.ok && hit.results).toHaveLength(1);
    if (!hit.ok) return;
    expect(hit.results[0]!.note).toBeNull();
    expect(JSON.stringify(hit.results)).not.toContain('META_SECRET_1');
    expect(JSON.stringify(hit.results)).not.toContain('META_SECRET_2');
    // metadata 的 note 不参与命中：仅 note 命中的查询不返回该条目
    const noteOnly = await service.search('META_SECRET_1', { audience: 'agent' });
    expect(noteOnly.ok && noteOnly.results).toHaveLength(0);
    const noteOnlyUser = await service.search('META_SECRET_1', { audience: 'user' });
    expect(noteOnlyUser.ok && noteOnlyUser.results).toHaveLength(1);
    // agent get metadata：无 note 正文（两字段空串）
    const got = await service.get(hit.results[0]!.id, 'agent');
    expect(got.ok && got.source.userNote === '' && got.source.aiNote === '').toBe(true);
    const userGot = await service.get(hit.results[0]!.id, 'user');
    expect(userGot.ok && userGot.source.userNote).toBe('META_SECRET_1');
  });

  it('agent 视角 full 命中附有界 note 摘录 + provenance 字段分离；user 视角 search 恒无 note', async () => {
    await addFull();
    const hit = await service.search('基准', { audience: 'agent' });
    expect(hit.ok && hit.results).toHaveLength(1);
    if (!hit.ok) return;
    const item = hit.results[0]!;
    expect(item.note?.userNote).toContain('看大模型评测');
    expect(item.note?.aiNote).toContain('AI 推断');
    expect([...(item.note?.userNote ?? '')].length).toBeLessThanOrEqual(200);
    const userHit = await service.search('基准', { audience: 'user' });
    expect(userHit.ok && userHit.results[0]!.note).toBeNull();
  });

  it('note 摘录防御性清洗：bidi 隔离符与换行在读取侧剔除（旧数据/损坏数据同样覆盖）', async () => {
    const s = await addFull();
    // 测试专用 SQL：直接写入含 bidi 隔离符的旧数据（模拟写入侧未清洗的历史数据）
    handle.prepare('UPDATE sources SET user_note = ? WHERE id = ?').run('脏⁦数据⁩\n第二行', s.id);
    const hit = await service.search('基准', { audience: 'agent' });
    if (!hit.ok) return;
    const note = hit.results[0]!.note?.userNote ?? '';
    expect(note).not.toMatch(/[؜⁦-⁩]/);
    expect(note).not.toContain('\n');
    expect(note).toBe('脏数据第二行');
  });
});

describe('B3 search — 多语言/分流/排序/有界/异常', () => {
  it('中文 2 字符降级路径诚实命中（不声称 trigram 原生支持两字符）；1 字符仅精确', async () => {
    await addOne('https://example.com/zh', { name: '基准测试站' });
    const r2 = await service.search('测试', { audience: 'user' });
    expect(r2.ok && r2.results.map((r) => r.name)).toContain('基准测试站');
    const r1 = await service.search('站', { audience: 'user' });
    expect(r1.ok && r1.results).toHaveLength(0);
    const exact1 = await addOne('https://example.com/c', { name: 'C' });
    const r1e = await service.search('C', { audience: 'user' });
    expect(r1e.ok && r1e.results.map((r) => r.id)).toEqual([exact1.id]);
  });

  it('日文假名/汉字 ≥3 字符 FTS 命中；英文词命中（LIKE 前缀 ASCII 不区分大小写兜底）', async () => {
    const ja = await addOne('https://example.com/ja', { name: '日本語情報源', shareMode: 'full' });
    const r = await service.search('日本語', { audience: 'user' });
    expect(r.ok && r.results.map((x) => x.id)).toContain(ja.id);
    const en = await addOne('https://example.com/en2', {
      name: 'Electron Docs',
      shareMode: 'full',
    });
    const re = await service.search('electron', { audience: 'user' });
    expect(re.ok && re.results.map((x) => x.id)).toContain(en.id);
  });

  it('URL 查询确定性集合：normalizeSourceUrl 可解析 → canonical 精确命中', async () => {
    const s = await addOne('https://example.com/docs?x=1#frag', { name: '文档页' });
    const r = await service.search('https://example.com/docs?x=1', { audience: 'user' });
    expect(r.ok && r.results.map((x) => x.id)).toContain(s.id);
    const rFull = await service.search('https://example.com/docs?x=1#frag', { audience: 'user' });
    expect(rFull.ok && rFull.results.map((x) => x.id)).toContain(s.id);
  });

  it('排序全序：档位不可被 priority 反转；同档 priority 降序；recency null 末位；origin/page 同键全序', async () => {
    // tier0（精确）priority=1 vs tier3（note 命中）priority=5：档位优先
    const exact = await addOne('https://example.com/exact', {
      name: 'exact',
      shareMode: 'full',
      priority: 1,
    });
    const noteHit = await addOne('https://example.com/notehit', {
      name: '其他',
      shareMode: 'full',
      priority: 5,
      userNote: '包含 exact 的备注',
    });
    const r = await service.search('exact', { audience: 'user' });
    if (!r.ok) return;
    const ids = r.results.map((x) => x.id);
    expect(ids.indexOf(exact.id)).toBeLessThan(ids.indexOf(noteHit.id));
    // 同档（前缀）priority 降序：priority 5 在 priority 1 前
    const p5 = await addOne('https://example.com/p5', { name: '前缀甲一', priority: 5 });
    const p1 = await addOne('https://example.com/p1', { name: '前缀甲二', priority: 1 });
    const rp = await service.search('前缀甲', { audience: 'user' });
    if (!rp.ok) return;
    const pIds = rp.results.map((x) => x.id);
    expect(pIds.indexOf(p5.id)).toBeLessThan(pIds.indexOf(p1.id));
    // recency：null 恒排最末（同档同 priority）
    const recent = await addOne('https://example.com/recent', { name: 'recency站' });
    handle
      .prepare("UPDATE sources SET last_used_at = '2026-08-15T00:00:00.000Z' WHERE id = ?")
      .run(recent.id);
    const oldNull = await addOne('https://example.com/oldnull', { name: 'recency站乙' });
    const rr = await service.search('recency站', { audience: 'user' });
    if (!rr.ok) return;
    expect(rr.results[0]!.id).toBe(recent.id);
    expect(rr.results.at(-1)!.id).toBe(oldNull.id);
    // origin/page 同源键族：canonicalKey 前驱/后驱（'https://example.com' 与
    // 'https://example.com/'，决议 #50 页面键恒带 '/'）——scope + canonicalKey +
    // id 收尾全序（确定性；同 canonicalKey 的收尾语义由纯函数单测覆盖）
    const origin = await addOne('https://example.com', { scope: 'origin', name: '同键origin' });
    const page = await addOne('https://example.com', { scope: 'page', name: '同键page' });
    const rk = await service.search('example.com', { audience: 'user' });
    if (!rk.ok) return;
    const keyIds = rk.results
      .filter((x) => x.id === origin.id || x.id === page.id)
      .map((x) => x.id);
    expect(keyIds).toEqual([origin.id, page.id]);
  });

  it('硬上限 10：默认 10；limit=11 → source-limit；并发/重复查询输出确定性', async () => {
    for (let i = 0; i < 12; i += 1) {
      await addOne(`https://example.com/bulk-${i}`, { name: `批量站点${i}` });
    }
    const d = await service.search('批量站点', { audience: 'user' });
    expect(d.ok && d.results).toHaveLength(10);
    expect(await service.search('批量站点', { limit: 11, audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-limit',
    });
    const a = await service.search('批量站点', { audience: 'user' });
    const b = await service.search('批量站点', { audience: 'user' });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('list 每页硬上限 20 与 total 一致（agent 过滤 blocked 后 total 同步）', async () => {
    for (let i = 0; i < 3; i += 1) {
      await addOne(`https://example.com/l-${i}`);
    }
    await addOne('https://example.com/lb', { shareMode: 'blocked' });
    const agent = await service.list({ page: 0, pageSize: 20, audience: 'agent' });
    expect(agent.ok && agent.total).toBe(3);
    expect(agent.ok && agent.items.length === agent.total).toBe(true);
    expect(await service.list({ page: 0, pageSize: 21, audience: 'agent' })).toEqual({
      ok: false,
      errorCode: 'source-limit',
    });
  });

  it('注入串（SQL/FTS 语法/引号/通配符/反斜杠）只作数据；查询后数据完好', async () => {
    await addOne('https://example.com/keep', { name: '保留站点' });
    for (const evil of [
      "'; DROP TABLE sources; --",
      'AND OR NOT NEAR * ^',
      'a"b',
      '%_\\',
      'x⁦y⁩',
    ]) {
      const r = await service.search(evil, { audience: 'user' });
      expect(r.ok).toBe(true);
    }
    const list = await service.list({ page: 0, audience: 'user' });
    expect(list.ok && list.total).toBe(1);
  });

  it('FTS 表缺失 → 降级 LIKE 路径仍返回（不伪装成功也非 unavailable）；数据库整体不可用 → source-unavailable', async () => {
    await addOne('https://example.com/zh2', { name: '基准站甲' });
    handle.exec('DROP TABLE sources_fts'); // 建库后 FTS 被破坏（决议 #62 范围）
    const r = await service.search('基准站甲', { audience: 'user' });
    expect(r.ok && r.results.map((x) => x.name)).toContain('基准站甲');
    const noteOnly = await service.search('只存在于备注的词', { audience: 'user' });
    expect(noteOnly.ok && noteOnly.results).toHaveLength(0); // 降级路径不检索 note，如实登记
    handle.exec('DROP TABLE sources');
    expect(await service.search('基准站甲', { audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
  });

  it('disposed 后 search/list/get 安全返回 source-unavailable', async () => {
    await addOne('https://example.com/zz');
    service.dispose();
    expect(await service.search('q', { audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await service.list({ page: 0, audience: 'user' })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await service.get(UUID, 'user')).toEqual({ ok: false, errorCode: 'source-unavailable' });
  });
});

// —— B4 决议 #66：previewChangeSet 只读预览 + blocked 猜测防护 + TOCTOU 版本复验 ——
describe('B4 previewChangeSet — 只读预览（决议 #66）', () => {
  it('与 applyChangeSet 同一校验语义：结构非法/超限 → 同码拒绝，零写入', async () => {
    const before = await service.list({ page: 0, audience: 'user' });
    const bad = await service.previewChangeSet({ ops: [] } as never);
    expect(bad).toMatchObject({ ok: false, errorCode: 'source-limit' });
    const badOp = await service.previewChangeSet({
      ops: [{ kind: 'update', sourceId: 'x' }] as never,
    });
    expect(badOp).toMatchObject({ ok: false, errorCode: 'source-invalid-change' });
    const after = await service.list({ page: 0, audience: 'user' });
    expect(after).toEqual(before); // 预览零写入
  });

  it('生成 ≤2000 字符中文 diff（「共 N 项变更」+ 字段级 before/after；note 仅长度+首 40 字符预览）', async () => {
    const s = await addOne('https://example.com/diff', {
      name: '旧名',
      userNote: '旧备注内容',
      shareMode: 'full',
    });
    const s2 = await addOne('https://example.com/diff2', { name: '待禁用站' });
    const preview = await service.previewChangeSet({
      ops: [
        {
          kind: 'update',
          sourceId: s.id,
          expectedVersion: 1,
          patch: { name: '新名', priority: 5 },
        },
        { kind: 'disable', sourceId: s2.id, expectedVersion: 1 },
      ],
    });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.opsCount).toBe(2);
      expect(preview.diffText).toContain('共 2 项变更');
      expect(preview.diffText).toContain('旧名');
      expect(preview.diffText).toContain('新名');
      expect(preview.diffText).toContain('禁用');
      expect([...preview.diffText].length).toBeLessThanOrEqual(2000);
    }
  });

  it('预览零写入：不生成 journal/幂等键，行数与可撤销列表不变', async () => {
    await addOne('https://example.com/zero', { name: '零写入站' });
    const undoableBefore = await service.listUndoable();
    const preview = await service.previewChangeSet({
      ops: [
        {
          kind: 'add',
          scope: 'page',
          url: 'https://example.com/preview-add',
          name: '预览新增',
        },
      ],
    });
    expect(preview.ok).toBe(true);
    expect(await service.listUndoable()).toHaveLength(undoableBefore.length);
    const hit = await service.search('预览新增', { audience: 'user' });
    expect(hit.ok && hit.results).toHaveLength(0); // 未写入
  });

  it('blocked 猜测：update/disable/restore 引用 blocked → source-forbidden（不得泄漏存在/内容）', async () => {
    const blocked = await addOne('https://example.com/bz', {
      name: '受限站',
      shareMode: 'blocked',
      userNote: 'BLOCKED_PREVIEW_MARKER',
    });
    const preview = await service.previewChangeSet({
      ops: [{ kind: 'disable', sourceId: blocked.id, expectedVersion: 1 }],
    });
    expect(preview).toMatchObject({ ok: false, errorCode: 'source-forbidden' });
    expect(JSON.stringify(preview)).not.toContain('BLOCKED_PREVIEW_MARKER');
    expect(JSON.stringify(preview)).not.toContain('受限站');
  });

  it('版本冲突 → source-version-conflict；预览与提交之间漂移 → apply 拒绝零写入（TOCTOU）', async () => {
    const s = await addOne('https://example.com/toctou', { name: 'TOCTOU 站' });
    const preview = await service.previewChangeSet({
      ops: [{ kind: 'update', sourceId: s.id, expectedVersion: 2, patch: { name: '漂移' } }],
    });
    expect(preview).toMatchObject({ ok: false, errorCode: 'source-version-conflict' });
    const previewOk = await service.previewChangeSet({
      ops: [{ kind: 'update', sourceId: s.id, expectedVersion: 1, patch: { name: '漂移' } }],
    });
    expect(previewOk.ok).toBe(true);
    // 预览通过后、正式提交前：版本漂移（手工修改 1 → 2）
    await service.updateManual(s.id, { name: '手工抢先' }, 1);
    const apply = await service.applyChangeSet(
      { ops: [{ kind: 'update', sourceId: s.id, expectedVersion: 1, patch: { name: '漂移' } }] },
      { runId: 'run-b4', toolCallId: 'call-b4' },
    );
    expect(apply).toMatchObject({ ok: false, errorCode: 'source-version-conflict' });
    const current = await service.get(s.id, 'user');
    expect(current.ok && current.source.name).toBe('手工抢先');
  });
});

describe('B4 applyChangeSet — blocked 猜测防护（决议 #66）', () => {
  it('update/disable/restore 引用 blocked（agent 变更通道）→ source-forbidden 零写入', async () => {
    const blocked = await addOne('https://example.com/bq', {
      name: '受限站',
      shareMode: 'blocked',
    });
    const before = await service.list({ page: 0, audience: 'user' });
    const undoableBefore = await service.listUndoable(); // 种子 addManual 自身 journal
    const res = await service.applyChangeSet(
      { ops: [{ kind: 'disable', sourceId: blocked.id, expectedVersion: 1 }] },
      { runId: 'run-b4', toolCallId: 'call-b4-1' },
    );
    expect(res).toMatchObject({ ok: false, errorCode: 'source-forbidden' });
    const after = await service.list({ page: 0, audience: 'user' });
    expect(after).toEqual(before);
    expect(await service.listUndoable()).toHaveLength(undoableBefore.length); // 零新增 journal
  });

  it('add 撞 blocked canonicalKey → source-duplicate 但不回注 existingSourceId（零泄漏）', async () => {
    const blocked = await addOne('https://example.com/bc', {
      name: '受限站',
      shareMode: 'blocked',
    });
    const res = await service.applyChangeSet(
      { ops: [{ kind: 'add', scope: 'page', url: 'https://example.com/bc' }] },
      { runId: 'run-b4', toolCallId: 'call-b4-2' },
    );
    expect(res).toMatchObject({ ok: false, errorCode: 'source-duplicate' });
    expect(res.results[0]?.existingSourceId).toBeUndefined(); // 不回注 blocked 条目 id
    expect(JSON.stringify(res)).not.toContain(blocked.id);
  });

  it('非 blocked 重复 add 仍回注既有 id（「可能相关」语义不回退）', async () => {
    const s = await addOne('https://example.com/dup', { name: '公开站' });
    const res = await service.applyChangeSet(
      { ops: [{ kind: 'add', scope: 'page', url: 'https://example.com/dup' }] },
      { runId: 'run-b4', toolCallId: 'call-b4-3' },
    );
    expect(res).toMatchObject({ ok: false, errorCode: 'source-duplicate' });
    expect(res.results[0]?.existingSourceId).toBe(s.id);
  });
});

// ---------- B5 扩展（决议 #71/#72）：有界 listGroups + quickAddPage ----------

describe('B5：listGroups（分组浏览，有界分页 + 确定性排序）', () => {
  it('空库 → total 0；分页参数边界（pageSize>20 → source-limit；非法 → invalid）', async () => {
    expect(await service.listGroups({ page: 0 })).toEqual({
      ok: true,
      page: 0,
      pageSize: 20,
      total: 0,
      groups: [],
    });
    expect(await service.listGroups({ page: 0, pageSize: 21 })).toEqual({
      ok: false,
      errorCode: 'source-limit',
    });
    expect(await service.listGroups({ page: -1 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.listGroups({ page: 1.5 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await service.listGroups({ page: 0, pageSize: 0 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
  });

  it('分组按名确定性排序（NOCASE）+ 分页正确', async () => {
    await addOne('https://example.com/a', { groupName: 'Beta' });
    await addOne('https://example.com/b', { groupName: 'alpha' });
    await addOne('https://example.com/c', { groupName: 'Gamma' });
    const page0 = await service.listGroups({ page: 0, pageSize: 2 });
    expect(page0.ok && page0.total).toBe(3);
    expect(page0.ok && page0.groups.map((g) => g.name)).toEqual(['alpha', 'Beta']);
    const page1 = await service.listGroups({ page: 1, pageSize: 2 });
    expect(page1.ok && page1.groups.map((g) => g.name)).toEqual(['Gamma']);
    expect(page1.ok && page1.pageSize).toBe(2);
  });

  it('重复分组名（幂等 get-or-create）不产生重复条目', async () => {
    await addOne('https://example.com/a', { groupName: '研究' });
    await addOne('https://example.com/b', { groupName: '研究' });
    const res = await service.listGroups({ page: 0 });
    expect(res.ok && res.total).toBe(1);
    expect(res.ok && res.groups[0]?.name).toBe('研究');
  });

  it('disposed → source-unavailable；不可预期异常归一化', async () => {
    service.dispose();
    expect(await service.listGroups({ page: 0 })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
  });
});

describe('B5：quickAddPage（当前页快速添加——main 读活动 Tab 后的服务入口）', () => {
  it('非 http(s)/含 userinfo → unsupported-url 零写入', async () => {
    expect(await service.quickAddPage('about:blank')).toEqual({ status: 'unsupported-url' });
    expect(await service.quickAddPage('file:///C:/page.html')).toEqual({
      status: 'unsupported-url',
    });
    expect(await service.quickAddPage('https://user:pass@example.com/a')).toEqual({
      status: 'unsupported-url',
    });
    const afterList = await service.list({ page: 0, audience: 'user' });
    expect(afterList.ok && afterList.total === 0).toBe(true);
  });

  it('添加成功：page scope + metadata 默认 + 名称由主进程确定性生成 + related 不含自身', async () => {
    const other = await addOne('https://example.com/other');
    const r = await service.quickAddPage('https://example.com/new-page#frag');
    expect(r.status).toBe('added');
    if (r.status !== 'added') return;
    expect(r.source.scope).toBe('page');
    expect(r.source.shareMode).toBe('metadata');
    expect(r.source.name).toContain('example.com');
    expect(r.idempotencyKey).not.toBe('');
    expect(r.related.some((i) => i.id === other.id)).toBe(true);
    expect(r.related.some((i) => i.id === r.source.id)).toBe(false);
    // journal 与手工通道同语义（可 Undo）
    expect((await service.listUndoable()).some((u) => u.sourceIds.includes(r.source.id))).toBe(
      true,
    );
  });

  it('精确重复 → duplicate + 既有条目（fragment 变体同身份，决议 #50）', async () => {
    await addOne('https://example.com/target', { name: '目标页' });
    const r = await service.quickAddPage('https://example.com/target#frag');
    expect(r.status).toBe('duplicate');
    if (r.status !== 'duplicate') return;
    expect(r.existing.name).toBe('目标页');
    expect(r.existing.canonicalKey).toBe('https://example.com/target');
  });

  it('同 origin 不同页面 ≤5 条可能相关（有界 + 排除自身 + 不同 origin 不出现）；绝不覆盖/合并', async () => {
    for (let i = 0; i < 7; i += 1) {
      await addOne(`https://example.com/p-${i}`);
    }
    await addOne('https://other.org/x');
    const r = await service.quickAddPage('https://example.com/p-3');
    expect(r.status).toBe('duplicate');
    if (r.status !== 'duplicate') return;
    expect(r.related.length).toBe(5);
    expect(r.related.every((i) => i.canonicalKey !== 'https://example.com/p-3')).toBe(true);
    expect(r.related.some((i) => i.canonicalKey === 'https://other.org/x')).toBe(false);
    // 零覆盖零合并：总数不变（7 个 example.com 页面 + 1 个 other.org = 8）
    const afterList = await service.list({ page: 0, audience: 'user' });
    expect(afterList.ok && afterList.total === 8).toBe(true);
  });

  it('origin 作用域同 origin 条目进入 related（可能相关提示）', async () => {
    const originSrc = await addOne('https://example.com', {
      scope: 'origin',
    });
    const r = await service.quickAddPage('https://example.com/one');
    expect(r.status).toBe('added');
    if (r.status !== 'added') return;
    expect(r.related.some((i) => i.id === originSrc.id)).toBe(true);
  });

  it('disposed → error source-unavailable', async () => {
    service.dispose();
    expect(await service.quickAddPage('https://example.com/a')).toEqual({
      status: 'error',
      errorCode: 'source-unavailable',
    });
  });
});
