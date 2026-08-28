// D4 watch-lifecycle-coordinator tests: SourceLifecycleObserver（prepare/commit/
// abort）、durable intent、启动 reconciliation、run revalidation 端口、恢复后
// grant 失效钩子（detailed-design §10.3、决议 #S6-034、threat-model §5 崩溃点
// 恢复表、WRT-17）。真实 node:sqlite + 内存 SourceProjectionReader 夹具；
// 临时目录精确清理。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runWatchMigrations } from './db/watch-migrations';
import { WatchRepository } from './repository/watch-repository';
import {
  WatchLifecycleCoordinator,
  type SourceProjectionReader,
} from './watch-lifecycle-coordinator';
import { computeSourceLocatorFingerprint } from '../../shared/watch/watch-rule-state';
import type {
  SourceWatchMutation,
  SourceWatchProjection,
  WatchRule,
} from '../../shared/types/watch';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-watch-lifecycle-'));

const FINGERPRINT = computeSourceLocatorFingerprint({
  sourceId: 'src-1',
  scope: 'page',
  canonicalKey: 'https://example.com/doc',
  kind: 'feed',
  canonicalTargetUrl: 'https://example.com/rss.xml',
});
const NOW = '2026-08-28T00:00:00.000Z';

let handle: DbHandle;
let repo: WatchRepository;
let coordinator: WatchLifecycleCoordinator;
let sources: Map<string, SourceWatchProjection>;

function projection(overrides: Partial<SourceWatchProjection> = {}): SourceWatchProjection {
  return {
    sourceId: 'src-1',
    rowVersion: 1,
    enabled: true,
    deletedAt: null,
    scope: 'page',
    canonicalKey: 'https://example.com/doc',
    ...overrides,
  };
}

const reader: SourceProjectionReader = (sourceId) => sources.get(sourceId) ?? null;

function bind(): void {
  coordinator.bind(repo, reader);
}

beforeEach(() => {
  handle = openDb(join(root, `lc-${Math.random().toString(36).slice(2)}.db`));
  runWatchMigrations(handle);
  repo = new WatchRepository(handle);
  coordinator = new WatchLifecycleCoordinator({ nowMs: () => Date.parse(NOW) });
  sources = new Map<string, SourceWatchProjection>([['src-1', projection()]]);
  bind();
});

afterEach(() => {
  // Windows 句柄释放：确保每个用例的 db 句柄关闭，避免 afterAll rmSync EPERM
  coordinator.dispose();
  if (!repo.isDisposed) repo.dispose();
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRule(overrides: Partial<WatchRule> = {}): WatchRule {
  return {
    id: randomUUID(),
    sourceId: 'src-1',
    kind: 'feed',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'public',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: { type: 'feed', feedUrl: 'https://example.com/rss.xml', format: 'rss2' },
    condition: null,
    notificationLevel: 'normal',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: FINGERPRINT,
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function mutation(overrides: Partial<SourceWatchMutation> = {}): SourceWatchMutation {
  return {
    mutationId: randomUUID(),
    operation: 'update',
    before: projection(),
    after: projection({ rowVersion: 2 }),
    ...overrides,
  };
}

describe('prepare（fail-closed 预暂停 + durable intent）', () => {
  it('未绑定/unavailable → prepare 恒 { ok:false, watch-unavailable }', () => {
    const fresh = new WatchLifecycleCoordinator({ nowMs: () => Date.now() });
    expect(fresh.prepare([mutation()])).toEqual({ ok: false, reason: 'watch-unavailable' });
    coordinator.markUnavailable();
    expect(coordinator.prepare([mutation()])).toEqual({ ok: false, reason: 'watch-unavailable' });
  });

  it('disable mutation：规则暂停 source-disabled、rowVersion 更新、intent 持久化前态、desiredEnabled 不变、审计写入', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({
      operation: 'disable',
      before: projection(),
      after: projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }),
    });
    expect(coordinator.prepare([m])).toEqual({ ok: true });
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('paused');
    expect(after.pauseReason).toBe('source-disabled');
    expect(after.desiredEnabled).toBe(true); // 不覆盖用户意图
    expect(after.sourceRowVersion).toBe(2);
    const intent = repo.getSourceCleanupIntent(m.mutationId)!;
    expect(intent.state).toBe('prepared');
    expect(intent.affectedRuleState[rule.id]).toEqual({
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      sourceRowVersion: 1,
      sourceLocatorFingerprint: FINGERPRINT,
    });
    const audits = repo.listAudits();
    expect(audits.some((a) => a.ruleId === rule.id && a.reasonCode === 'source-disabled')).toBe(
      true,
    );
  });

  it('hard-delete mutation：暂停 source-deleted', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({ operation: 'hard-delete', before: projection(), after: null });
    expect(coordinator.prepare([m])).toEqual({ ok: true });
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('paused');
    expect(after.pauseReason).toBe('source-deleted');
  });

  it('locator 变化（canonicalKey 更新）：暂停 source-changed、旧 fingerprint 保留、rowVersion 更新', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({
      operation: 'update',
      before: projection(),
      after: projection({ canonicalKey: 'https://example.com/other', rowVersion: 2 }),
    });
    expect(coordinator.prepare([m])).toEqual({ ok: true });
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('paused');
    expect(after.pauseReason).toBe('source-changed');
    expect(after.sourceLocatorFingerprint).toBe(FINGERPRINT); // 旧身份保留等待 rebaseline
    expect(after.sourceRowVersion).toBe(2);
  });

  it('metadata-only update：不暂停、不覆盖', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({
      operation: 'update',
      before: projection(),
      after: projection({ rowVersion: 2 }),
    });
    expect(coordinator.prepare([m])).toEqual({ ok: true });
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('enabled');
    expect(after.sourceRowVersion).toBe(2);
  });

  it('用户 pause（desiredEnabled=false）不被 prepare 覆盖', () => {
    const rule = makeRule({ state: 'paused', pauseReason: 'user', desiredEnabled: false });
    repo.insertRule(rule);
    const m = mutation({
      operation: 'disable',
      before: projection(),
      after: projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }),
    });
    expect(coordinator.prepare([m])).toEqual({ ok: true });
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('paused');
    expect(after.pauseReason).toBe('user'); // 原因不被覆盖
    expect(after.desiredEnabled).toBe(false);
  });

  it('prepare 绝不 paused→enabled（restore mutation 不恢复）', () => {
    const rule = makeRule({
      state: 'paused',
      pauseReason: 'source-disabled',
      desiredEnabled: true,
    });
    repo.insertRule(rule);
    const m = mutation({
      operation: 'restore',
      before: projection({ enabled: false }),
      after: projection({ rowVersion: 2 }),
    });
    expect(coordinator.prepare([m])).toEqual({ ok: true });
    expect(repo.getRule(rule.id)!.state).toBe('paused');
  });

  it('事务失败（重复 mutationId）→ 整体回滚 + unavailable', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({
      operation: 'disable',
      after: projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }),
    });
    expect(coordinator.prepare([m])).toEqual({ ok: true });
    // 重复 mutationId → duplicate-mutation → prepare 失败
    const again = coordinator.prepare([m]);
    expect(again).toEqual({ ok: false, reason: 'watch-unavailable' });
    expect(coordinator.getState().mode).toBe('unavailable');
    expect(coordinator.prepare([mutation()])).toEqual({ ok: false, reason: 'watch-unavailable' });
  });
});

describe('commit / abort（§10.3 步骤 3–4 失败传播）', () => {
  it('commit disable：Source 事实 disabled → 保持暂停；restore 且 desiredEnabled=true → 自动 enabled', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({
      operation: 'disable',
      before: projection(),
      after: projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }),
    });
    coordinator.prepare([m]);
    sources.set('src-1', projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }));
    expect(coordinator.commit([m.mutationId])).toEqual({ ok: true });
    const intent = repo.getSourceCleanupIntent(m.mutationId)!;
    expect(intent.state).toBe('complete');
    expect(repo.getRule(rule.id)!.pauseReason).toBe('source-disabled');

    // restore：desiredEnabled=true 且 source 原因 → 自动 enabled（版本递增但身份不变）
    const r2 = mutation({
      operation: 'restore',
      before: projection({ enabled: false }),
      after: projection({ rowVersion: 3 }),
    });
    coordinator.prepare([r2]);
    sources.set('src-1', projection({ rowVersion: 3 }));
    expect(coordinator.commit([r2.mutationId])).toEqual({ ok: true });
    const restored = repo.getRule(rule.id)!;
    expect(restored.state).toBe('enabled');
    expect(restored.sourceRowVersion).toBe(3);
  });

  it('用户 pause（desiredEnabled=false）restore 后永不自动恢复', () => {
    const rule = makeRule({
      state: 'paused',
      pauseReason: 'source-disabled',
      desiredEnabled: false,
    });
    repo.insertRule(rule);
    const m = mutation({
      operation: 'restore',
      before: projection({ enabled: false }),
      after: projection({ rowVersion: 2 }),
    });
    coordinator.prepare([m]);
    sources.set('src-1', projection({ rowVersion: 2 }));
    coordinator.commit([m.mutationId]);
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('paused');
    expect(after.pauseReason).toBe('source-disabled');
  });

  it('commit locator 变化：保持 source-changed 等待 rebaseline', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({
      operation: 'update',
      before: projection(),
      after: projection({ canonicalKey: 'https://example.com/other', rowVersion: 2 }),
    });
    coordinator.prepare([m]);
    sources.set('src-1', projection({ canonicalKey: 'https://example.com/other', rowVersion: 2 }));
    coordinator.commit([m.mutationId]);
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('paused');
    expect(after.pauseReason).toBe('source-changed');
  });

  it('commit hard-delete：Source 不存在 → 级联 + complete + cascade 审计', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({ operation: 'hard-delete', before: projection(), after: null });
    coordinator.prepare([m]);
    sources.delete('src-1');
    expect(coordinator.commit([m.mutationId])).toEqual({ ok: true });
    expect(repo.getRule(rule.id)).toBeNull(); // 级联删除
    expect(repo.getSourceCleanupIntent(m.mutationId)!.state).toBe('complete');
    expect(
      repo
        .listAudits()
        .some((a) => a.kind === 'lifecycle-cascade' && a.reasonCode === 'hard-delete'),
    ).toBe(true);
  });

  it('commit 幂等重放（intent 已解决 → 再次 commit ok 且零变化）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({
      operation: 'disable',
      after: projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }),
    });
    coordinator.prepare([m]);
    sources.set('src-1', projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }));
    coordinator.commit([m.mutationId]);
    const before = repo.listAudits().length;
    expect(coordinator.commit([m.mutationId])).toEqual({ ok: true });
    expect(repo.listAudits().length).toBe(before);
  });

  it('abort：Source 仍等于 before → 恢复 prepare 前状态 + intent aborted', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({
      operation: 'disable',
      before: projection(),
      after: projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }),
    });
    coordinator.prepare([m]);
    coordinator.abort([m.mutationId]); // 无异常（void 契约）
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('enabled'); // 恢复
    expect(after.sourceRowVersion).toBe(1); // rowVersion 一并恢复
    expect(repo.getSourceCleanupIntent(m.mutationId)!.state).toBe('aborted');
  });

  it('abort：Source 已不等于 before → 不恢复、intent 保持 prepared（交 reconciliation）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({
      operation: 'disable',
      before: projection(),
      after: projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }),
    });
    coordinator.prepare([m]);
    sources.set(
      'src-1',
      projection({ canonicalKey: 'https://example.com/changed-concurrent', rowVersion: 3 }),
    );
    coordinator.abort([m.mutationId]);
    expect(repo.getSourceCleanupIntent(m.mutationId)!.state).toBe('prepared');
    expect(repo.getRule(rule.id)!.state).toBe('paused'); // prepare 的暂停保留
  });

  it('abort 失败（事务异常）→ unavailable 且 Source 侧可继续返回原失败（void 契约零抛）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const m = mutation({
      operation: 'disable',
      after: projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }),
    });
    coordinator.prepare([m]);
    // 让事务失败：破坏 db 连接
    repo.dbHandle.close();
    expect(() => coordinator.abort([m.mutationId])).not.toThrow();
    expect(coordinator.getState().mode).toBe('unavailable');
    void rule;
  });
});

describe('启动 reconciliation（§10.2 步骤 6 + 崩溃点恢复表）', () => {
  function freshCoordinator(): WatchLifecycleCoordinator {
    const c = new WatchLifecycleCoordinator({ nowMs: () => Date.parse(NOW) });
    c.bind(repo, reader);
    return c;
  }

  it('prepared disable + Source 已 enabled（Source 事务未提交）：replay commit 协调 + 已解决 intent 删除', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const c1 = freshCoordinator();
    const m = mutation({
      operation: 'disable',
      before: projection(),
      after: projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }),
    });
    c1.prepare([m]); // 崩溃点：intent 写入后进程退出
    sources.set('src-1', projection({ rowVersion: 2 })); // Source 事务实际已提交（enabled 回滚？用 enabled 状态说明）
    const c2 = freshCoordinator();
    const result = c2.reconcileOnStartup(repo, reader);
    expect(result).toEqual({ ok: true, reason: null });
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('enabled'); // 当前事实 enabled + 身份不变 → 恢复
    expect(repo.getSourceCleanupIntent(m.mutationId)).toBeNull(); // 已解决删除
    expect(
      repo.listAudits().some((a) => a.kind === 'reconciliation' && a.reasonCode === 'complete'),
    ).toBe(true);
  });

  it('prepared hard-delete + Source 不存在：reconcile 级联完成', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const c1 = freshCoordinator();
    const m = mutation({ operation: 'hard-delete', before: projection(), after: null });
    c1.prepare([m]);
    sources.delete('src-1');
    const c2 = freshCoordinator();
    expect(c2.reconcileOnStartup(repo, reader)).toEqual({ ok: true, reason: null });
    expect(repo.getRule(rule.id)).toBeNull();
    expect(repo.listSourceCleanupIntents().length).toBe(0);
  });

  it('prepared hard-delete + Source 仍等于 before：reconcile 恢复 + aborted', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const c1 = freshCoordinator();
    const m = mutation({ operation: 'hard-delete', before: projection(), after: null });
    c1.prepare([m]);
    const c2 = freshCoordinator();
    expect(c2.reconcileOnStartup(repo, reader)).toEqual({ ok: true, reason: null });
    expect(repo.getRule(rule.id)!.state).toBe('enabled');
    expect(repo.listSourceCleanupIntents().length).toBe(0);
  });

  it('undo 逆 add（after=null）+ Source 不存在：reconcile 级联 + undo-source-removed 审计', () => {
    const rule = makeRule({ sourceId: 'src-2' });
    repo.insertRule(rule);
    sources.set('src-2', projection({ sourceId: 'src-2' }));
    const c1 = freshCoordinator();
    const m: SourceWatchMutation = {
      mutationId: randomUUID(),
      operation: 'undo',
      before: projection({ sourceId: 'src-2' }),
      after: null,
    };
    c1.prepare([m]);
    sources.delete('src-2');
    const c2 = freshCoordinator();
    expect(c2.reconcileOnStartup(repo, reader)).toEqual({ ok: true, reason: null });
    expect(repo.getRule(rule.id)).toBeNull();
    expect(
      repo
        .listAudits()
        .some((a) => a.kind === 'lifecycle-cascade' && a.reasonCode === 'undo-source-removed'),
    ).toBe(true);
  });

  it('孤儿规则（无 intent、Source 缺失）：暂停 source-deleted 零继续', () => {
    const rule = makeRule({ sourceId: 'src-ghost' });
    repo.insertRule(rule);
    const c = freshCoordinator();
    expect(c.reconcileOnStartup(repo, reader)).toEqual({ ok: true, reason: null });
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('paused');
    expect(after.pauseReason).toBe('source-deleted');
  });

  it('孤儿规则 locator 变化：暂停 source-changed', () => {
    const rule = makeRule({ sourceId: 'src-3' });
    sources.set(
      'src-3',
      projection({ sourceId: 'src-3', canonicalKey: 'https://example.com/new' }),
    );
    repo.insertRule(rule);
    const c = freshCoordinator();
    expect(c.reconcileOnStartup(repo, reader)).toEqual({ ok: true, reason: null });
    const after = repo.getRule(rule.id)!;
    expect(after.state).toBe('paused');
    expect(after.pauseReason).toBe('source-changed');
  });

  it('reconciliation 失败（reader 抛错）→ 整体回滚 + 失败审计 + ok:false', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const c1 = freshCoordinator();
    const m = mutation({
      operation: 'disable',
      after: projection({ enabled: false, deletedAt: NOW, rowVersion: 2 }),
    });
    c1.prepare([m]);
    const throwingReader: SourceProjectionReader = () => {
      throw new Error('SourceService 读取失败');
    };
    const c2 = freshCoordinator();
    const result = c2.reconcileOnStartup(repo, throwingReader);
    expect(result.ok).toBe(false);
    expect(repo.getSourceCleanupIntent(m.mutationId)!.state).toBe('prepared'); // 回滚保留
    expect(
      repo.listAudits().some((a) => a.kind === 'reconciliation' && a.reasonCode === 'aborted'),
    ).toBe(true);
  });

  it('reconciliation 幂等（重跑零变化）', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    const c = freshCoordinator();
    expect(c.reconcileOnStartup(repo, reader)).toEqual({ ok: true, reason: null });
    const audits = repo.listAudits().length;
    expect(c.reconcileOnStartup(repo, reader)).toEqual({ ok: true, reason: null });
    expect(repo.listAudits().length).toBe(audits + 1); // 每次成功恰一条 complete 审计
    expect(repo.getRule(rule.id)!.state).toBe('enabled');
  });
});

describe('run revalidation 端口（§10.3 步骤 5 判定矩阵）', () => {
  it('不存在/禁用/locator 变化 → 判定 + 暂停；正常 → ok + rowVersion', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    // 正常
    sources.set('src-1', projection({ rowVersion: 4 }));
    expect(coordinator.revalidateRuleSource(rule.id)).toEqual({ status: 'ok', rowVersion: 4 });
    expect(repo.getRule(rule.id)!.sourceRowVersion).toBe(4);
    // 禁用
    sources.set('src-1', projection({ rowVersion: 5, enabled: false, deletedAt: NOW }));
    const disabled = coordinator.revalidateRuleSource(rule.id);
    expect(disabled.status).toBe('source-disabled');
    expect(repo.getRule(rule.id)!.pauseReason).toBe('source-disabled');
    // 不存在
    sources.delete('src-1');
    expect(coordinator.revalidateRuleSource(rule.id)).toEqual({ status: 'source-missing' });
    // locator 变化（先恢复存在）
    sources.set('src-1', projection({ rowVersion: 6, canonicalKey: 'https://example.com/moved' }));
    expect(coordinator.revalidateRuleSource(rule.id)).toEqual({ status: 'locator-changed' });
    // 规则缺失/已删除/未绑定
    expect(coordinator.revalidateRuleSource('ghost')).toEqual({ status: 'rule-missing' });
    const fresh = new WatchLifecycleCoordinator({ nowMs: () => Date.now() });
    expect(fresh.revalidateRuleSource(rule.id)).toEqual({ status: 'unavailable' });
  });

  it('仅 rowVersion 变化 + fingerprint 相同：更新 rowVersion、不丢弃状态', () => {
    const rule = makeRule();
    repo.insertRule(rule);
    sources.set('src-1', projection({ rowVersion: 9 }));
    expect(coordinator.revalidateRuleSource(rule.id)).toEqual({ status: 'ok', rowVersion: 9 });
    expect(repo.getRule(rule.id)!.sourceRowVersion).toBe(9);
    expect(repo.getRule(rule.id)!.state).toBe('enabled');
  });
});

describe('Session grant 失效钩子', () => {
  it('invalidateSessionConsents 委托 repository；未绑定 → ok:false', () => {
    const rule = makeRule({
      kind: 'page',
      accessMode: 'session',
      target: {
        type: 'page',
        pageUrl: 'https://example.com/doc',
        regions: [{ kind: 'main-text', label: '正文' }],
        sessionConsent: { version: 1, origin: 'https://example.com', grantedAt: NOW },
      },
    });
    repo.insertRule(rule);
    expect(coordinator.invalidateSessionConsents()).toEqual({ ok: true, count: 1 });
    const after = repo.getRule(rule.id)!;
    if (after.target.type === 'page') expect(after.target.sessionConsent).toBeNull();
    const fresh = new WatchLifecycleCoordinator({ nowMs: () => Date.now() });
    expect(fresh.invalidateSessionConsents()).toEqual({ ok: false, count: 0 });
  });
});

describe('dispose 幂等', () => {
  it('dispose 后 prepare 恒失败；重复 dispose 安全', () => {
    coordinator.dispose();
    coordinator.dispose();
    expect(coordinator.prepare([mutation()])).toEqual({ ok: false, reason: 'watch-unavailable' });
    expect(coordinator.getState().mode).toBe('unavailable');
  });
});
