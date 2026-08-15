// source-ipc unit tests (B5): the Sources IPC adapter contract — strict whitelist
// validation (illegal id / unknown fields / page-size-length-enum bounds), audience
// hardcoded 'user' at the main adapter (adjudication #69/#58), state gating
// (normal/readonly-recovery/unavailable: writes zero change, reads rejected per
// adjudication #39/#74), sources:changed emitted exactly once and only after a
// successful change, exactly one redacted manual audit entry per write attempt
// (adjudication #76: sourceId/op/field names/lengths/result code only — no note
// bodies, no full URLs/queries, no delete tokens, no database paths), two-phase
// hard delete (adjudication #73: cancel/expiry/wrong-binding/replay → zero deletion),
// quick-add reading the active tab in main (adjudication #72: no renderer URL/title;
// duplicate returned; ≤5 same-origin related hints, never overwrite/merge).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from './db/sqlite-driver';
import { runMigrations } from './db/migrations';
import { SourceServiceImpl } from './source-service';
import {
  createSourcesAdapter,
  formatManualSourcesAudit,
  validateSourcesAddPayload,
  validateSourcesGetPayload,
  validateSourcesGroupsPayload,
  validateSourcesHardDeletePayload,
  validateSourcesIdPayload,
  validateSourcesIdVersionPayload,
  validateSourcesListPayload,
  validateSourcesSearchPayload,
  validateSourcesUndoPayload,
  validateSourcesUpdatePayload,
  type ManualSourcesAudit,
  type SourcesAdapter,
} from './source-ipc';
import type { SourceService, SourcesState, SourceView } from '../../shared/types/sources';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-sources-ipc-'));
const BASE_MS = Date.UTC(2026, 7, 15, 0, 0, 0);
const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';

let handle: DbHandle;
let service: SourceServiceImpl;
let adapter: SourcesAdapter;
let audits: string[];
let changedCount: number;
let stateOverrideHolder: { current: SourcesState | null };

const okView = (r: unknown): SourceView => {
  const res = r as { ok: boolean; source: SourceView };
  expect(res.ok, JSON.stringify(res)).toBe(true);
  return res.source;
};

beforeEach(() => {
  handle = openDb(join(root, `ipc-${Math.random().toString(36).slice(2)}.db`));
  runMigrations(handle);
  service = new SourceServiceImpl({ db: handle, now: () => BASE_MS });
  audits = [];
  changedCount = 0;
  stateOverrideHolder = { current: null };
  adapter = createSourcesAdapter({
    service,
    audit: (message) => {
      audits.push(message);
    },
    onChanged: () => {
      changedCount += 1;
    },
    stateOverride: () => stateOverrideHolder.current,
  });
});

afterEach(() => {
  service.dispose();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------- 1. 载荷校验矩阵（严格白名单 + 边界；非法输入结构化安全返回） ----------

describe('sources:list payload 校验', () => {
  it('page 必须为 ≥0 整数；pageSize 1–20；groupId null/string；enabledOnly 布尔；未知字段拒绝', async () => {
    expect(await adapter.list(null)).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.list('x')).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.list({ page: -1 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.list({ page: 1.5 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.list({})).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.list({ page: 0, pageSize: 0 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.list({ page: 0, pageSize: 21 })).toEqual({
      ok: false,
      errorCode: 'source-limit',
    });
    expect(await adapter.list({ page: 0, pageSize: 1.5 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.list({ page: 0, groupId: '' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.list({ page: 0, groupId: 3 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.list({ page: 0, enabledOnly: 'yes' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.list({ page: 0, audience: 'agent' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.list({ page: 0, sql: 'DROP TABLE sources' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    const ok = await adapter.list({ page: 0, pageSize: 20, groupId: null, enabledOnly: true });
    expect(ok).toEqual({ ok: true, page: 0, pageSize: 20, total: 0, items: [] });
  });

  it('validateSourcesListPayload 纯函数与适配器同语义', () => {
    expect(validateSourcesListPayload({ page: 0 })).toEqual({
      ok: true,
      value: { page: 0 },
    });
    expect(validateSourcesListPayload({ page: 0, pageSize: 20, groupId: null })).toEqual({
      ok: true,
      value: { page: 0, pageSize: 20, groupId: null },
    });
    expect(validateSourcesListPayload({ page: 0, pageSize: 21 })).toEqual({
      ok: false,
      errorCode: 'source-limit',
    });
    expect(validateSourcesListPayload({ page: '0' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(validateSourcesListPayload({ page: 0, extra: 1 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
  });
});

describe('sources:get/search/groups 校验', () => {
  it('get：UUID 形状强制、未知字段拒绝', async () => {
    expect(await adapter.get(null)).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.get({ sourceId: 'not-a-uuid' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.get({ sourceId: UUID, extra: true })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.get({ sourceId: UUID })).toEqual({
      ok: false,
      errorCode: 'source-not-found',
    });
    expect(validateSourcesGetPayload({ sourceId: UUID })).toEqual({
      ok: true,
      value: { sourceId: UUID },
    });
    expect(validateSourcesGetPayload({ sourceId: 'x' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
  });

  it('search：query 非空 ≤500；limit 1–10（>10 → source-limit）；未知字段拒绝', async () => {
    expect(await adapter.search(null)).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.search({})).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.search({ query: '   ' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.search({ query: 'x'.repeat(501) })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.search({ query: 'q', limit: 0 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.search({ query: 'q', limit: 11 })).toEqual({
      ok: false,
      errorCode: 'source-limit',
    });
    expect(await adapter.search({ query: 'q', audience: 'agent' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    const ok = await adapter.search({ query: 'q', limit: 10 });
    expect(ok).toEqual({ ok: true, query: 'q', results: [] });
    expect(validateSourcesSearchPayload({ query: 'q', limit: 10 })).toEqual({
      ok: true,
      value: { query: 'q', limit: 10 },
    });
    expect(validateSourcesSearchPayload({ query: 'q', limit: 10.5 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
  });

  it('groups：page 边界与未知字段拒绝', async () => {
    expect(await adapter.groups(null)).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.groups({})).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.groups({ page: 0, pageSize: 21 })).toEqual({
      ok: false,
      errorCode: 'source-limit',
    });
    expect(await adapter.groups({ page: 0, x: 1 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.groups({ page: 0 })).toEqual({
      ok: true,
      page: 0,
      pageSize: 20,
      total: 0,
      groups: [],
    });
    expect(validateSourcesGroupsPayload({ page: 0, pageSize: 5 })).toEqual({
      ok: true,
      value: { page: 0, pageSize: 5 },
    });
  });
});

describe('sources:add/update/disable/restore/undo/hard-delete 校验', () => {
  it('add：白名单外字段/aiNote/assertedBy 拒绝（AI note 只读、provenance 由主进程确定）', async () => {
    const base = { scope: 'page', url: 'https://example.com/a' };
    expect(await adapter.add(null)).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.add({})).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.add({ ...base, extra: 1 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.add({ ...base, aiNote: '模型不该从这里写' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(
      await adapter.add({ ...base, trust: { value: 'official', assertedBy: 'user' } }),
    ).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.add({ scope: 'x', url: 'https://example.com/a' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.add({ scope: 'page', url: 'ftp://example.com/a' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(validateSourcesAddPayload({ ...base, userNote: '备注' })).toEqual({
      ok: true,
      value: { scope: 'page', url: 'https://example.com/a', userNote: '备注' },
    });
    expect(validateSourcesAddPayload({ ...base, aiNote: 'x' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
  });

  it('update：envelope/patch 白名单（patch 无 aiNote/enabled）、expectedVersion 正整数', async () => {
    const patch = { name: '新名' };
    expect(await adapter.update(null)).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.update({ sourceId: 'x', expectedVersion: 1, patch })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.update({ sourceId: UUID, expectedVersion: 0, patch })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.update({ sourceId: UUID, expectedVersion: 1, patch: {} })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(
      await adapter.update({ sourceId: UUID, expectedVersion: 1, patch: { enabled: false } }),
    ).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(
      await adapter.update({ sourceId: UUID, expectedVersion: 1, patch: { aiNote: 'x' } }),
    ).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(
      await adapter.update({
        sourceId: UUID,
        expectedVersion: 1,
        patch: { trust: { value: 'official', assertedBy: 'user' } },
      }),
    ).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.update({ sourceId: UUID, expectedVersion: 1, patch, version: 9 })).toEqual(
      { ok: false, errorCode: 'source-invalid-change' },
    );
    expect(
      validateSourcesUpdatePayload({ sourceId: UUID, expectedVersion: 1, patch: { name: 'n' } }),
    ).toEqual({
      ok: true,
      value: { sourceId: UUID, expectedVersion: 1, patch: { name: 'n' } },
    });
  });

  it('disable/restore/prepare：sourceId UUID + expectedVersion 正整数；未知字段拒绝', async () => {
    expect(await adapter.disable(null)).toEqual({ ok: false, errorCode: 'source-invalid-change' });
    expect(await adapter.disable({ sourceId: UUID })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.disable({ sourceId: UUID, expectedVersion: 1.5 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.disable({ sourceId: UUID, expectedVersion: 1, x: 1 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(validateSourcesIdVersionPayload({ sourceId: UUID, expectedVersion: 1 })).toEqual({
      ok: true,
      value: { sourceId: UUID, expectedVersion: 1 },
    });
    expect(validateSourcesIdPayload({ sourceId: UUID })).toEqual({
      ok: true,
      value: { sourceId: UUID },
    });
    expect(validateSourcesIdPayload({ sourceId: 'bad', expectedVersion: 1 })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
  });

  it('hard-delete：token 必为 64 位小写 hex（opaque 能力令牌）', async () => {
    expect(await adapter.hardDelete(null)).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.hardDelete({ sourceId: UUID, token: '' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.hardDelete({ sourceId: UUID, token: 'short' })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.hardDelete({ sourceId: UUID, token: 'A'.repeat(64) })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(await adapter.hardDelete({ sourceId: UUID, token: 'z'.repeat(64) })).toEqual({
      ok: false,
      errorCode: 'source-invalid-change',
    });
    expect(validateSourcesHardDeletePayload({ sourceId: UUID, token: 'ab'.repeat(32) })).toEqual({
      ok: true,
      value: { sourceId: UUID, token: 'ab'.repeat(32) },
    });
  });

  it('undo：idempotencyKey 非空串；未知字段拒绝（→ undo-not-found，错误码闭合集）', async () => {
    expect(await adapter.undo(null)).toEqual({ ok: false, errorCode: 'source-undo-not-found' });
    expect(await adapter.undo({ idempotencyKey: '' })).toEqual({
      ok: false,
      errorCode: 'source-undo-not-found',
    });
    expect(await adapter.undo({ idempotencyKey: 'k', x: 1 })).toEqual({
      ok: false,
      errorCode: 'source-undo-not-found',
    });
    expect(await adapter.undo({ idempotencyKey: 'no-such-key' })).toEqual({
      ok: false,
      errorCode: 'source-undo-not-found',
    });
    expect(validateSourcesUndoPayload({ idempotencyKey: 'k' })).toEqual({
      ok: true,
      value: { idempotencyKey: 'k' },
    });
  });
});

// ---------- 2. audience 硬编码 'user'（决议 #58/#69）：blocked 可见可管理 ----------

describe('audience 硬编码 user', () => {
  it('blocked 条目在 list/get/search 中均可见（renderer 无 audience 通道）', async () => {
    const blocked = okView(
      await service.addManual({
        scope: 'page',
        url: 'https://example.com/secret',
        shareMode: 'blocked',
      }),
    );
    const list = await adapter.list({ page: 0 });
    expect(list.ok && list.items.some((i) => i.id === blocked.id)).toBe(true);
    const get = await adapter.get({ sourceId: blocked.id });
    expect(get.ok && get.source.shareMode === 'blocked').toBe(true);
    const search = await adapter.search({ query: 'https://example.com/secret' });
    expect(search.ok && search.results.some((i) => i.id === blocked.id)).toBe(true);
  });
});

// ---------- 3. 恢复态/不可用态（决议 #39/#74）：写入零变化 + 读入口拒绝 ----------

describe('state gating', () => {
  it('service 正常 → state 为 normal', async () => {
    expect(adapter.state()).toEqual({ mode: 'normal', reason: null });
  });

  it('service 为 null → unavailable + 中文原因；读写均结构化拒绝、零变化、零 changed', async () => {
    const dead = createSourcesAdapter({
      service: null,
      audit: (message) => {
        audits.push(message);
      },
      onChanged: () => {
        changedCount += 1;
      },
    });
    const state = dead.state();
    expect(state.mode).toBe('unavailable');
    expect(state.reason).toBeTruthy();
    expect(await dead.list({ page: 0 })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await dead.get({ sourceId: UUID })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await dead.search({ query: 'q' })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await dead.groups({ page: 0 })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await dead.undoable()).toEqual([]);
    expect(await dead.add({ scope: 'page', url: 'https://example.com/a' })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await dead.prepareHardDelete({ sourceId: UUID })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await dead.quickAdd({ url: 'https://example.com/a' })).toEqual({
      status: 'error',
      errorCode: 'source-unavailable',
    });
    expect(audits.length).toBe(2); // add 与 quick-add 各为一次写尝试 → 各审计一条
    expect(changedCount).toBe(0);
    expect(await service.list({ page: 0, audience: 'user' })).toEqual({
      ok: true,
      page: 0,
      pageSize: 20,
      total: 0,
      items: [],
    });
  });

  it('override readonly-recovery：读写拒绝 + 每次写尝试审计一条 + 零变化零 changed', async () => {
    const seeded = okView(await service.addManual({ scope: 'page', url: 'https://example.com/a' }));
    stateOverrideHolder.current = {
      mode: 'readonly-recovery',
      reason: '冒烟注入只读恢复态（测试）',
    };
    expect(adapter.state().mode).toBe('readonly-recovery');
    expect(await adapter.list({ page: 0 })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    const upd = await adapter.update({
      sourceId: seeded.id,
      expectedVersion: 1,
      patch: { name: '不该写入' },
    });
    expect(upd).toEqual({ ok: false, errorCode: 'source-unavailable' });
    expect(audits.length).toBe(1);
    expect(changedCount).toBe(0);
    const still = await service.get(seeded.id, 'user');
    expect(still.ok && still.source.name !== '不该写入').toBe(true);
    // override unavailable：同语义
    stateOverrideHolder.current = { mode: 'unavailable', reason: '冒烟注入不可用态（测试）' };
    expect(adapter.state().mode).toBe('unavailable');
    expect(await adapter.get({ sourceId: seeded.id })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(await adapter.disable({ sourceId: seeded.id, expectedVersion: 1 })).toEqual({
      ok: false,
      errorCode: 'source-unavailable',
    });
    expect(changedCount).toBe(0);
  });

  it('override 清除后恢复 normal 写入', async () => {
    stateOverrideHolder.current = null;
    const r = await adapter.add({ scope: 'page', url: 'https://example.com/b' });
    expect((r as { ok: boolean }).ok).toBe(true);
    expect(changedCount).toBe(1);
  });

  it('getter 惰性解析：构造时 null、调用时已装配 → 正常服务（回归：handler 注册早于装配）', async () => {
    let target: SourceService | null = null;
    const lazy = createSourcesAdapter({
      service: () => target,
      audit: (message) => {
        audits.push(message);
      },
      onChanged: () => {
        changedCount += 1;
      },
    });
    expect(lazy.state().mode).toBe('unavailable'); // 未装配期结构化不可用
    target = service; // 装配完成（index.ts createBrowserWindow 内）
    expect(lazy.state().mode).toBe('normal');
    const r = await lazy.add({ scope: 'page', url: 'https://example.com/lazy' });
    expect((r as { ok: boolean }).ok).toBe(true);
    expect(changedCount).toBe(1);
    expect((await lazy.list({ page: 0 })).ok).toBe(true);
  });
});

// ---------- 4. sources:changed 与手工审计（决议 #69/#76） ----------

describe('changed 事件与手工审计', () => {
  it('写成功：changed 恰好一次；写失败：零次', async () => {
    const added = (await adapter.add({ scope: 'page', url: 'https://example.com/a' })) as {
      ok: boolean;
      source: SourceView;
      idempotencyKey: string;
      undoable: boolean;
    };
    expect(added.ok).toBe(true);
    expect(changedCount).toBe(1);
    // 重复 → source-duplicate 零 changed
    expect(await adapter.add({ scope: 'page', url: 'https://example.com/a' })).toEqual({
      ok: false,
      errorCode: 'source-duplicate',
    });
    expect(changedCount).toBe(1);
    // 版本冲突 → 零 changed
    const conflict = await adapter.update({
      sourceId: added.source.id,
      expectedVersion: 99,
      patch: { name: 'x' },
    });
    expect(conflict).toEqual({ ok: false, errorCode: 'source-version-conflict' });
    expect(changedCount).toBe(1);
    // disable 成功 → changed 恰一次
    expect((await adapter.disable({ sourceId: added.source.id, expectedVersion: 1 })).ok).toBe(
      true,
    );
    expect(changedCount).toBe(2);
    // undo 成功 → changed 恰一次
    const undoable = await adapter.undoable();
    const entry = undoable.find((u) => u.sourceIds[0] === added.source.id);
    expect(entry).toBeDefined();
    expect((await adapter.undo({ idempotencyKey: entry!.idempotencyKey })).ok).toBe(true);
    expect(changedCount).toBe(3);
    // 重复 undo → 失败零 changed
    expect(await adapter.undo({ idempotencyKey: entry!.idempotencyKey })).toEqual({
      ok: false,
      errorCode: 'source-undo-not-found',
    });
    expect(changedCount).toBe(3);
  });

  it('每次写尝试恰好一条审计（成功与失败均一条）；prepare 不审计', async () => {
    const before = audits.length;
    await adapter.add({ scope: 'page', url: 'https://example.com/a' }); // 1
    const s = okView(await service.addManual({ scope: 'page', url: 'https://example.com/b' }));
    await adapter.update({ sourceId: s.id, expectedVersion: 1, patch: { name: '改名' } }); // 2
    await adapter.disable({ sourceId: s.id, expectedVersion: 2 }); // 3
    await adapter.restore({ sourceId: s.id, expectedVersion: 3 }); // 4
    await adapter.add({ scope: 'page', url: 'https://example.com/a' }); // 5（失败也一条）
    await adapter.add({ scope: 'page', url: 'bad-url', aiNote: 'x' }); // 6（非法也一条）
    const undoable = await adapter.undoable();
    await adapter.undo({ idempotencyKey: undoable[0]!.idempotencyKey }); // 7
    await adapter.undo({ idempotencyKey: 'no-such-key' }); // 8
    await adapter.hardDelete({ sourceId: s.id, token: 'f'.repeat(64) }); // 9（错误令牌也一条）
    expect(audits.length - before).toBe(9);
    // prepare-hard-delete：非写尝试，不审计
    await adapter.prepareHardDelete({ sourceId: s.id });
    expect(audits.length - before).toBe(9);
  });

  it('审计脱敏：note 正文/完整 URL/敏感 query/删除 token/数据库路径零出现', async () => {
    const note = 'sk-secret-note-123 私人备注';
    const urlWithToken = 'https://example.com/x?token=topsecret&key=abc';
    const r = await adapter.add({
      scope: 'page',
      url: urlWithToken,
      userNote: note,
      name: 'SK-name',
    });
    expect((r as { ok: boolean }).ok).toBe(true);
    const message = audits.join('\n');
    expect(message).not.toContain('topsecret');
    expect(message).not.toContain('私人备注');
    expect(message).not.toContain('sk-secret-note-123');
    expect(message).not.toContain('example.com/x');
    expect(message).not.toContain('\\sources');
    expect(message).not.toContain('/sources/');
    expect(message).not.toContain('sources.db');
    // 审计允许：操作/字段名/长度/结果码
    expect(message).toContain('op=add');
    expect(message).toContain('userNote');
    expect(message).toContain('result=ok');
    // URL query 值与凭据形态零出现（仅长度）
    expect(message).not.toContain('token=');
  });

  it('hard-delete 审计不含 token；formatManualSourcesAudit 确定性中文', () => {
    const formatted = formatManualSourcesAudit({
      op: 'hard-delete',
      sourceId: UUID,
      fields: [],
      lens: [],
      result: 'source-conflict',
    });
    expect(formatted).toBe(
      `sources-manual（op=hard-delete，sourceId=${UUID}，fields=[]，lens=[]，result=source-conflict）`,
    );
    const withFields = formatManualSourcesAudit({
      op: 'update',
      sourceId: UUID2,
      fields: ['name', 'userNote'],
      lens: [2, 10],
      result: 'ok',
    });
    expect(withFields).toContain('fields=[name,userNote]');
    expect(withFields).toContain('lens=[2,10]');
    expect(withFields).toContain('result=ok');
    const entry: ManualSourcesAudit = {
      op: 'update',
      sourceId: null,
      fields: ['name'],
      lens: [4],
      result: 'source-version-conflict',
    };
    expect(formatManualSourcesAudit(entry)).toContain('sourceId=-');
  });
});

// ---------- 5. 两阶段永久删除（决议 #73） ----------

describe('prepare-hard-delete / hard-delete 两阶段协议', () => {
  it('取消（不调用 hard-delete）→ 零删除；prepare 后仍可正常读取', async () => {
    const s = okView(await service.addManual({ scope: 'page', url: 'https://example.com/a' }));
    const prepared = await adapter.prepareHardDelete({ sourceId: s.id });
    expect(prepared.ok).toBe(true);
    // 取消：不消费令牌 → 条目仍在
    const still = await service.get(s.id, 'user');
    expect(still.ok).toBe(true);
    expect(changedCount).toBe(0);
  });

  it('错绑定令牌 → source-conflict 零删除且不消费（原令牌仍可用）', async () => {
    const a = okView(await service.addManual({ scope: 'page', url: 'https://example.com/a' }));
    const b = okView(await service.addManual({ scope: 'page', url: 'https://example.com/b' }));
    const prepared = await adapter.prepareHardDelete({ sourceId: a.id });
    expect(prepared.ok).toBe(true);
    const token = (prepared as { token: string }).token;
    // 错绑定：用 a 的令牌删 b
    const wrong = await adapter.hardDelete({ sourceId: b.id, token });
    expect(wrong).toEqual({ ok: false, errorCode: 'source-conflict' });
    expect((await service.get(b.id, 'user')).ok).toBe(true);
    // 原令牌未被消费：仍可删除 a
    const right = await adapter.hardDelete({ sourceId: a.id, token });
    expect(right.ok).toBe(true);
    expect((await service.get(a.id, 'user')).ok).toBe(false);
  });

  it('过期令牌 → source-conflict 零删除（时钟注入：TTL 300s）', async () => {
    // 独立注入时钟的 service + adapter（TTL 判定与 before 夹具解耦）
    const nowHolder = { now: BASE_MS };
    const timedDb = openDb(join(root, `ipc-timed-${Math.random().toString(36).slice(2)}.db`));
    runMigrations(timedDb);
    const timedService = new SourceServiceImpl({ db: timedDb, now: () => nowHolder.now });
    const timedAdapter = createSourcesAdapter({
      service: timedService,
      audit: (message) => {
        audits.push(message);
      },
      onChanged: () => {
        changedCount += 1;
      },
    });
    try {
      const s = okView(
        await timedService.addManual({ scope: 'page', url: 'https://example.com/a' }),
      );
      const prepared = await timedAdapter.prepareHardDelete({ sourceId: s.id });
      expect(prepared.ok).toBe(true);
      const token = (prepared as { token: string }).token;
      nowHolder.now = BASE_MS + 301_000; // 超过 300s TTL
      const late = await timedAdapter.hardDelete({ sourceId: s.id, token });
      expect(late).toEqual({ ok: false, errorCode: 'source-conflict' });
      expect(changedCount).toBe(0);
      expect((await timedService.get(s.id, 'user')).ok).toBe(true); // 零删除
    } finally {
      timedService.dispose();
    }
  });

  it('重放/并发双击：令牌消费即失效 → 第二次 source-conflict 零删除；成功删除后无 Undo 入口', async () => {
    const s = okView(await service.addManual({ scope: 'page', url: 'https://example.com/a' }));
    const prepared = await adapter.prepareHardDelete({ sourceId: s.id });
    expect(prepared.ok).toBe(true);
    const token = (prepared as { token: string }).token;
    const first = await adapter.hardDelete({ sourceId: s.id, token });
    expect(first.ok).toBe(true);
    expect(changedCount).toBe(1);
    const replay = await adapter.hardDelete({ sourceId: s.id, token });
    expect(replay).toEqual({ ok: false, errorCode: 'source-conflict' });
    expect(changedCount).toBe(1);
    // 成功后无 Undo 入口：journal 中该 source 的条目已被精确清理
    const undoable = await service.listUndoable();
    expect(undoable.some((u) => u.sourceIds.includes(s.id))).toBe(false);
    // 已删除 → not-found
    expect(await adapter.prepareHardDelete({ sourceId: s.id })).toEqual({
      ok: false,
      errorCode: 'source-not-found',
    });
  });
});

// ---------- 6. 快速添加（决议 #72）：main 读活动 Tab，renderer 不提供 URL/标题 ----------

describe('sources:quick-add', () => {
  it('无活动页 → no-active-page（审计一条、零 changed、零写入）', async () => {
    expect(await adapter.quickAdd(null)).toEqual({ status: 'no-active-page' });
    expect(audits.length).toBe(1);
    expect(changedCount).toBe(0);
  });

  it('非 http(s) → unsupported-url 零写入', async () => {
    expect(await adapter.quickAdd({ url: 'about:blank' })).toEqual({
      status: 'unsupported-url',
    });
    expect(await adapter.quickAdd({ url: 'file:///C:/x.html' })).toEqual({
      status: 'unsupported-url',
    });
    expect(await adapter.quickAdd({ url: 'https://user:pass@example.com/a' })).toEqual({
      status: 'unsupported-url',
    });
    expect(changedCount).toBe(0);
    const afterList = await service.list({ page: 0, audience: 'user' });
    expect(afterList.ok && afterList.total === 0).toBe(true);
  });

  it('添加成功（page scope + metadata 默认）→ added + changed 一次 + related 不含自身', async () => {
    const other = okView(
      await service.addManual({ scope: 'page', url: 'https://example.com/other' }),
    );
    const r = await adapter.quickAdd({ url: 'https://example.com/new-page' });
    expect(r.status).toBe('added');
    const added = r as Extract<
      Awaited<ReturnType<SourcesAdapter['quickAdd']>>,
      { status: 'added' }
    >;
    expect(added.source.scope).toBe('page');
    expect(added.source.shareMode).toBe('metadata'); // 无备注默认 metadata（决议 #52）
    expect(added.related.some((i) => i.id === other.id)).toBe(true);
    expect(added.related.some((i) => i.id === added.source.id)).toBe(false);
    expect(changedCount).toBe(1);
    expect(audits.length).toBe(1);
    // 名称由主进程按 URL 确定性生成（renderer 不提供标题）
    expect(added.source.name).toContain('example.com');
  });

  it('精确重复 → duplicate + 既有条目；同 origin 不同页面最多 5 条可能相关；绝不覆盖/合并', async () => {
    await adapter.quickAdd({ url: 'https://example.com/target' });
    for (let i = 0; i < 7; i += 1) {
      await service.addManual({ scope: 'page', url: `https://example.com/other-${i}` });
    }
    const listBefore = await service.list({ page: 0, audience: 'user' });
    expect(listBefore.ok).toBe(true);
    if (!listBefore.ok) return;
    const totalBefore = listBefore.total;
    const dup = await adapter.quickAdd({ url: 'https://example.com/target#frag' });
    expect(dup.status).toBe('duplicate');
    const d = dup as Extract<
      Awaited<ReturnType<SourcesAdapter['quickAdd']>>,
      { status: 'duplicate' }
    >;
    expect(d.existing.canonicalKey).toBe('https://example.com/target');
    expect(d.related.length).toBe(5); // 有界 5（决议 #72）
    expect(d.related.every((i) => i.canonicalKey !== 'https://example.com/target')).toBe(true);
    const listAfter = await service.list({ page: 0, audience: 'user' });
    expect(listAfter.ok && listAfter.total === totalBefore).toBe(true); // 零覆盖零合并
    expect(changedCount).toBe(1); // 仅首次添加成功触发
    // 不同 origin 页面不出现在 related
    await service.addManual({ scope: 'page', url: 'https://other.org/page' });
    const dup2 = await adapter.quickAdd({ url: 'https://example.com/target' });
    const d2 = dup2 as Extract<
      Awaited<ReturnType<SourcesAdapter['quickAdd']>>,
      { status: 'duplicate' }
    >;
    expect(d2.related.some((i) => i.canonicalKey === 'https://other.org/page')).toBe(false);
  });

  it('origin 作用域同 origin 条目进入 related（可能相关提示，不覆盖）', async () => {
    const originSrc = okView(
      await service.addManual({ scope: 'origin', url: 'https://example.com' }),
    );
    const r = await adapter.quickAdd({ url: 'https://example.com/one-page' });
    const added = r as Extract<
      Awaited<ReturnType<SourcesAdapter['quickAdd']>>,
      { status: 'added' }
    >;
    expect(added.related.some((i) => i.id === originSrc.id)).toBe(true);
  });

  it('状态非 normal 时 quick-add 结构化拒绝（零写入零 changed）', async () => {
    stateOverrideHolder.current = { mode: 'unavailable', reason: '测试不可用' };
    const r = await adapter.quickAdd({ url: 'https://example.com/x' });
    expect(r).toEqual({ status: 'error', errorCode: 'source-unavailable' });
    expect(changedCount).toBe(0);
    stateOverrideHolder.current = null;
    const listAfter = await service.list({ page: 0, audience: 'user' });
    expect(listAfter.ok && listAfter.total === 0).toBe(true);
  });
});

// ---------- B7：rebuild 受控入口（仅 UI 通道 + normal 状态；无参数/无审计/无 changed） ----------

describe('sources:rebuild-index — 诊断入口门控', () => {
  it('normal 状态 → 调用 service.rebuildSearchIndex 并透传有界诊断；零审计零 changed', async () => {
    const result = await adapter.rebuildIndex();
    expect(result.ok).toBe(true);
    expect(result.sourceCount).toBe(0);
    expect(audits).toHaveLength(0); // rebuild 非 Source 数据变更（决议 #91：不产生 manual 审计）
    expect(changedCount).toBe(0); // 不发 sources:changed
  });

  it('状态 override readonly-recovery → 拒绝且不触达 service', async () => {
    stateOverrideHolder.current = { mode: 'readonly-recovery', reason: '测试恢复态' };
    const gated = createSourcesAdapter({
      service: () => service,
      audit: (m) => audits.push(m),
      onChanged: () => {
        changedCount += 1;
      },
      stateOverride: () => stateOverrideHolder.current,
    });
    const result = await gated.rebuildIndex();
    expect(result.ok).toBe(false);
    expect(audits).toHaveLength(0);
    expect(changedCount).toBe(0);
    stateOverrideHolder.current = null;
  });

  it('service null → 结构化拒绝（ok=false）不抛', async () => {
    const bare = createSourcesAdapter({
      service: null,
      audit: (m) => audits.push(m),
      onChanged: () => {
        changedCount += 1;
      },
    });
    const result = await bare.rebuildIndex();
    expect(result.ok).toBe(false);
    expect(audits).toHaveLength(0);
    expect(changedCount).toBe(0);
  });

  it('非法/多余参数一律忽略（无 payload 通道：SQL/路径/权限参数零暴露）', async () => {
    const result = await adapter.rebuildIndex();
    expect(typeof result.ok).toBe('boolean');
    expect(typeof result.message).toBe('string');
    expect(Number.isInteger(result.sourceCount)).toBe(true);
    expect(Number.isInteger(result.ftsCount)).toBe(true);
  });
});
