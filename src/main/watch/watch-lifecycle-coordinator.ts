// Sixth Stage D4: WatchLifecycleCoordinator（detailed-design §10.3、决议
// #S6-034、threat-model §5/WRT-17）。SourceService 内部 prepare/commit/abort
// 观察端口 + durable intent + 启动 reconciliation + run revalidation 端口 +
// 恢复后 Session grant 失效钩子。
//
// 语义要点：
// - 组合 D2 纯函数（transitionRuleState/coordinateSourceRule/computeSourceLocatorFingerprint），
//   不重写状态语义；本模块只负责 watch.db 事务编排与 SourceService 事实读取；
// - prepare 只做 fail-closed 暂停（disable/delete → 暂停；locator 变化 →
//   source-changed），绝不 paused→enabled；restore 只在 commit 恢复；
// - abort 仅在当前 Source 仍等于 before locator/state 时恢复 prepare 前状态；
// - commit 幂等；hard-delete 只以 Source 当前不存在为完成依据；
// - 任一 watch.db 失败 → 进入 unavailable：所有后续 prepare 恒
//   { ok: false, reason: 'watch-unavailable' }（fail-closed，绝不退化为 no-op）；
// - 启动 reconciliation 全部成功才删除已解决 intent（可启动状态由 Store 的
//   schedulerReady 位承载）；本模块零网络能力（reader 端口由装配层注入）。
import { randomUUID } from 'node:crypto';
import { logError } from '../logger';
import {
  coordinateSourceRule,
  computeSourceLocatorFingerprint,
  transitionRuleState,
} from '../../shared/watch/watch-rule-state';
import type {
  SourceLifecycleObserver,
  SourceWatchMutation,
  SourceWatchProjection,
  WatchRule,
  WatchRuleKind,
} from '../../shared/types/watch';
import type { AffectedRulePrepareState } from './watch-row-validation';
import { withTransaction } from './db/watch-driver';
import { WatchRepository, type SourceCleanupIntentRow } from './repository/watch-repository';

// D4-R：Source 投影读取三态协议——found/missing/unavailable 严格区分：
// unavailable（SourceRepository 抛错/数据库不可用/非法行）绝不降级为 missing，
// 调用方（hard-delete/reconciliation/revalidation）遇 unavailable 必须回滚并使
// Watch unavailable，绝不删除或级联 Watch 数据。
export type SourceProjectionReadResult =
  | { status: 'found'; projection: SourceWatchProjection }
  | { status: 'missing' }
  | { status: 'unavailable' };

export type SourceProjectionReader = (sourceId: string) => SourceProjectionReadResult;

// 仅当确定性 missing 返回 null；unavailable 抛错交由调用方 fail-closed。
function projectionOrNull(result: SourceProjectionReadResult): SourceWatchProjection | null {
  if (result.status === 'found') return result.projection;
  if (result.status === 'missing') return null;
  throw new Error('Source 投影读取不可用（unavailable，不得视同缺失）');
}

export type WatchRevalidationResult =
  | { status: 'ok'; rowVersion: number; sourceAfterAcquisition: SourceWatchProjection }
  | { status: 'unavailable' }
  | { status: 'rule-missing' }
  | { status: 'rule-deleted' }
  | { status: 'source-missing' }
  | { status: 'source-disabled' }
  | { status: 'locator-changed' };

export interface WatchCoordinatorOptions {
  nowMs?: () => number;
}

interface RuleCoordinationFields {
  state: WatchRule['state'];
  pauseReason: WatchRule['pauseReason'];
  desiredEnabled: boolean;
  sourceRowVersion: number;
  sourceLocatorFingerprint: string;
}

function ruleFields(rule: WatchRule): RuleCoordinationFields {
  return {
    state: rule.state,
    pauseReason: rule.pauseReason,
    desiredEnabled: rule.desiredEnabled,
    sourceRowVersion: rule.sourceRowVersion,
    sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
  };
}

function canonicalTargetUrlOf(rule: WatchRule): string {
  return rule.target.type === 'feed' ? rule.target.feedUrl : rule.target.pageUrl;
}

function computeFingerprintFor(
  rule: { sourceId: string; kind: WatchRuleKind; targetUrl: string },
  projection: SourceWatchProjection,
): string {
  return computeSourceLocatorFingerprint({
    sourceId: projection.sourceId,
    scope: projection.scope,
    canonicalKey: projection.canonicalKey,
    kind: rule.kind,
    canonicalTargetUrl: rule.targetUrl,
  });
}

// 「当前 Source 仍等于 before locator/state」（§10.3 abort 恢复条件）：
// 比较 locator（scope/canonicalKey）与状态（enabled/deletedAt 非空性）；
// rowVersion 单独变化不阻止恢复。
function sourceEqualsBefore(
  current: SourceWatchProjection | null,
  before: SourceWatchProjection | null,
): boolean {
  if (before === null) return current === null;
  if (current === null) return false;
  return (
    current.scope === before.scope &&
    current.canonicalKey === before.canonicalKey &&
    current.enabled === before.enabled &&
    (current.deletedAt === null) === (before.deletedAt === null)
  );
}

function projectionFromAfter(mutation: SourceWatchMutation): SourceWatchProjection | null {
  return mutation.after;
}

export class WatchLifecycleCoordinator implements SourceLifecycleObserver {
  private repo: WatchRepository | null = null;
  private reader: SourceProjectionReader | null = null;
  private unavailable = true;
  private unavailableReason: string | null = '未绑定（启动装配未完成）';
  private readonly nowMs: () => number;

  constructor(options: WatchCoordinatorOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  // Store normal 装配成功后绑定（index.ts 装配顺序：先构造 coordinator →
  // Sources → WatchStore → bind）
  bind(repo: WatchRepository, reader: SourceProjectionReader): void {
    this.repo = repo;
    this.reader = reader;
    this.unavailable = false;
    this.unavailableReason = null;
  }

  // 幂等卸载：解绑并进入 unavailable（store 拥有 db 句柄生命周期）
  dispose(): void {
    this.repo = null;
    this.reader = null;
    this.unavailable = true;
    this.unavailableReason = '已卸载';
  }

  markUnavailable(reason = 'watch.db 操作失败'): void {
    this.unavailable = true;
    this.unavailableReason = reason;
  }

  getState(): { mode: 'normal' | 'unavailable'; reason: string | null } {
    if (this.unavailable) return { mode: 'unavailable', reason: this.unavailableReason };
    if (this.repo === null || this.reader === null) {
      return { mode: 'unavailable', reason: this.unavailableReason };
    }
    if (this.repo.isDisposed) {
      return { mode: 'unavailable', reason: '数据库连接已关闭' };
    }
    return { mode: 'normal', reason: null };
  }

  private get activeRepo(): WatchRepository {
    if (this.repo === null || this.repo.isDisposed) {
      throw new Error('程序缺陷：coordinator 未绑定或已卸载');
    }
    return this.repo;
  }

  private get activeReader(): SourceProjectionReader {
    if (this.reader === null) {
      throw new Error('程序缺陷：coordinator 未绑定 reader');
    }
    return this.reader;
  }

  private iso(): string {
    return new Date(this.nowMs()).toISOString();
  }

  // -------------------------------------------------------------------------
  // SourceLifecycleObserver（§10.3 步骤 2–4）
  // -------------------------------------------------------------------------

  prepare(
    changes: SourceWatchMutation[],
  ): { ok: true } | { ok: false; reason: 'watch-unavailable' } {
    if (this.getState().mode !== 'normal') return { ok: false, reason: 'watch-unavailable' };
    const repo = this.activeRepo;
    try {
      withTransaction(repo.dbHandle, () => {
        const nowIso = this.iso();
        for (const change of changes) {
          const after = projectionFromAfter(change);
          const rules = repo
            .listRulesBySource(change.before?.sourceId ?? after?.sourceId ?? '')
            .filter((r) => r.state !== 'deleted');
          const affected: Record<string, AffectedRulePrepareState> = {};
          for (const rule of rules) {
            affected[rule.id] = {
              state: rule.state,
              pauseReason: rule.pauseReason,
              desiredEnabled: rule.desiredEnabled,
              sourceRowVersion: rule.sourceRowVersion,
              sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
            };
            const action = this.prepareActionFor(change, rule, after);
            if (action !== null) {
              const next = transitionRuleState(ruleFields(rule), action, {
                sourceExists: after !== null,
                sourceEnabled: after !== null && after.enabled,
                locatorUnchanged: after !== null,
              });
              const nextRowVersion = after === null ? rule.sourceRowVersion : after.rowVersion;
              const updated = repo.updateRuleCoordination(
                rule.id,
                {
                  state: rule.state,
                  pauseReason: rule.pauseReason,
                  sourceRowVersion: rule.sourceRowVersion,
                  sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
                },
                {
                  state: next.state,
                  pauseReason: next.pauseReason,
                  sourceRowVersion: nextRowVersion,
                  sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
                },
                nowIso,
              );
              if (!updated.ok) {
                throw new Error(`prepare 规则协调失败（${updated.code}）`);
              }
              // 生命周期驱动的暂停审计（仅当本次确实从非 paused 迁入）
              if (rule.state !== 'paused' && next.state === 'paused' && next.pauseReason !== null) {
                this.writeAudit(repo, {
                  id: randomUUID(),
                  ruleId: rule.id,
                  kind: 'lifecycle-pause',
                  reasonCode: this.pauseAuditReason(next.pauseReason),
                  createdAt: nowIso,
                });
              }
            } else if (after !== null && after.rowVersion !== rule.sourceRowVersion) {
              // metadata-only：只更新 sourceRowVersion（不触碰状态/原因/指纹）
              const updated = repo.updateRuleCoordination(
                rule.id,
                {
                  state: rule.state,
                  pauseReason: rule.pauseReason,
                  sourceRowVersion: rule.sourceRowVersion,
                  sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
                },
                {
                  state: rule.state,
                  pauseReason: rule.pauseReason,
                  sourceRowVersion: after.rowVersion,
                  sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
                },
                nowIso,
              );
              if (!updated.ok) {
                throw new Error(`prepare rowVersion 更新失败（${updated.code}）`);
              }
            }
          }
          const inserted = repo.insertSourceCleanupIntent({
            mutationId: change.mutationId,
            sourceId: change.before?.sourceId ?? after?.sourceId ?? '',
            operation: change.operation,
            beforeProjection: change.before,
            afterProjection: change.after,
            affectedRuleState: affected,
            state: 'prepared',
            createdAt: nowIso,
            updatedAt: nowIso,
          });
          if (!inserted.ok) {
            throw new Error(`prepare intent 写入失败（${inserted.code}）`);
          }
        }
      });
      return { ok: true };
    } catch (err) {
      this.markUnavailable('prepare 事务失败');
      logError('watch', 'prepare 事务失败（已整体回滚，Watch 进入 unavailable）', err);
      return { ok: false, reason: 'watch-unavailable' };
    }
  }

  private prepareActionFor(
    change: SourceWatchMutation,
    rule: WatchRule,
    after: SourceWatchProjection | null,
  ):
    | { kind: 'source-disable' }
    | { kind: 'source-delete' }
    | { kind: 'source-locator-change' }
    | null {
    if (change.operation === 'hard-delete' || (after === null && change.operation === 'undo')) {
      return { kind: 'source-delete' };
    }
    if (after === null) return null; // 理论不可达（undo-of-add 之外无 after=null）
    if (!after.enabled) return { kind: 'source-disable' };
    const fingerprint = computeFingerprintFor(
      { sourceId: rule.sourceId, kind: rule.kind, targetUrl: canonicalTargetUrlOf(rule) },
      after,
    );
    if (fingerprint !== rule.sourceLocatorFingerprint) {
      return { kind: 'source-locator-change' };
    }
    return null;
  }

  private pauseAuditReason(
    reason: string,
  ): 'source-disabled' | 'source-deleted' | 'source-changed' {
    if (reason === 'source-disabled') return 'source-disabled';
    if (reason === 'source-deleted') return 'source-deleted';
    return 'source-changed';
  }

  commit(mutationIds: string[]): { ok: true } | { ok: false; reason: 'watch-unavailable' } {
    if (this.getState().mode !== 'normal') return { ok: false, reason: 'watch-unavailable' };
    const repo = this.activeRepo;
    const reader = this.activeReader;
    try {
      withTransaction(repo.dbHandle, () => {
        for (const mutationId of mutationIds) {
          const intent = repo.getSourceCleanupIntent(mutationId);
          if (intent === null) continue; // 已解决/不存在 → 幂等跳过
          if (intent.state === 'complete' || intent.state === 'aborted') continue; // 幂等重放
          this.replayCommitIntent(repo, reader, intent);
        }
      });
      return { ok: true };
    } catch (err) {
      this.markUnavailable('commit 事务失败');
      logError('watch', 'commit 事务失败（已整体回滚，Watch 进入 unavailable）', err);
      return { ok: false, reason: 'watch-unavailable' };
    }
  }

  abort(mutationIds: string[]): void {
    if (this.getState().mode !== 'normal') return;
    const repo = this.activeRepo;
    const reader = this.activeReader;
    try {
      withTransaction(repo.dbHandle, () => {
        for (const mutationId of mutationIds) {
          const intent = repo.getSourceCleanupIntent(mutationId);
          if (intent === null) continue;
          if (intent.state === 'complete' || intent.state === 'aborted') continue;
          // unavailable 抛错 → 本事务回滚 + Watch unavailable（intent 保持 prepared）
          const current = projectionOrNull(reader(intent.sourceId));
          if (!sourceEqualsBefore(current, intent.beforeProjection)) {
            // Source 已不等于 before → 交启动 reconciliation，intent 保持 prepared
            continue;
          }
          this.restoreAffectedRules(repo, intent);
          const transition = repo.transitionSourceCleanupIntent(
            mutationId,
            intent.state,
            'aborted',
            this.iso(),
          );
          if (!transition.ok) {
            throw new Error(`abort intent 状态迁移失败（${transition.code}）`);
          }
        }
      });
    } catch (err) {
      this.markUnavailable('abort 事务失败');
      logError('watch', 'abort 事务失败（已整体回滚，Watch 进入 unavailable）', err);
    }
  }

  // 恢复 prepare 前状态（abort/reconcile 共用）：仅对非 deleted 规则恢复
  // state/pauseReason/sourceRowVersion/fingerprint（desiredEnabled 从未被改）
  private restoreAffectedRules(repo: WatchRepository, intent: SourceCleanupIntentRow): void {
    const nowIso = this.iso();
    for (const [ruleId, affected] of Object.entries(intent.affectedRuleState)) {
      const rule = repo.getRule(ruleId);
      if (rule === null || rule.state === 'deleted') continue;
      const updated = repo.updateRuleCoordination(
        ruleId,
        {
          state: rule.state,
          pauseReason: rule.pauseReason,
          sourceRowVersion: rule.sourceRowVersion,
          sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
        },
        {
          state: affected.state,
          pauseReason: affected.pauseReason,
          sourceRowVersion: affected.sourceRowVersion,
          sourceLocatorFingerprint: affected.sourceLocatorFingerprint,
        },
        nowIso,
      );
      if (!updated.ok) {
        throw new Error(`恢复 prepare 前状态失败（rule=${ruleId}，${updated.code}）`);
      }
    }
  }

  // commit/reconcile 共用：按当前 Source 事实重放
  private replayCommitIntent(
    repo: WatchRepository,
    reader: SourceProjectionReader,
    intent: SourceCleanupIntentRow,
  ): void {
    // unavailable 抛错 → 调用方事务回滚；仅确定性 missing 才允许缺失逻辑（级联）
    const current = projectionOrNull(reader(intent.sourceId));
    if (intent.operation === 'hard-delete') {
      if (current === null) {
        // 只以 Source 当前不存在为完成依据（§10.3）。级联审计先写且 rule_id=null
        //（§10.1：audits 对 rule 删除行为 CASCADE——null 审计随级联存活可追溯）
        this.insertCascadeAudits(repo, intent, 'hard-delete');
        const cascaded = repo.cascadeDeleteRulesBySource(intent.sourceId);
        if (!cascaded.ok) {
          throw new Error(`hard-delete 级联失败（source=${intent.sourceId}）`);
        }
        this.finishIntent(repo, intent, 'complete');
        return;
      }
      // Source 仍存在 → abort 语义（恢复/按事实协调）
      if (sourceEqualsBefore(current, intent.beforeProjection)) {
        this.restoreAffectedRules(repo, intent);
      } else {
        this.coordinateRulesWithSource(repo, intent.sourceId, current);
      }
      this.finishIntent(repo, intent, 'aborted');
      return;
    }
    if (current === null) {
      if (intent.operation === 'undo' && intent.afterProjection === null) {
        // undo 逆 add：Source 物理消失 → 级联（与 hard-delete 同族）
        this.insertCascadeAudits(repo, intent, 'undo-source-removed');
        const cascaded = repo.cascadeDeleteRulesBySource(intent.sourceId);
        if (!cascaded.ok) {
          throw new Error(`undo 逆 add 级联失败（source=${intent.sourceId}）`);
        }
      } else {
        // Source 意外消失 → 全部规则暂停 source-deleted（零联网防线）
        this.pauseRulesSourceDeleted(repo, intent.sourceId);
      }
      this.finishIntent(repo, intent, 'complete');
      return;
    }
    // 提交语义：按实际 Source 窄投影协调（metadata-only → 只更新 rowVersion；
    // restore → 仅 desiredEnabled=true 且 source 原因自动 enabled；locator 变化
    // → source-changed 保持）
    this.coordinateRulesWithSource(repo, intent.sourceId, current);
    this.finishIntent(repo, intent, 'complete');
  }

  // 契约要求的审计写入必须检查结果；失败 → 抛错使同一事务整体失败（R1）
  private writeAudit(
    repo: WatchRepository,
    input: {
      id: string;
      ruleId: string | null;
      kind: Parameters<WatchRepository['insertAudit']>[0]['kind'];
      reasonCode: Parameters<WatchRepository['insertAudit']>[0]['reasonCode'];
      createdAt: string;
    },
  ): void {
    const result = repo.insertAudit(input);
    if (!result.ok) {
      throw new Error(`审计写入失败（${result.code}）`);
    }
  }

  private insertCascadeAudits(
    repo: WatchRepository,
    intent: SourceCleanupIntentRow,
    reasonCode: 'hard-delete' | 'undo-source-removed',
  ): void {
    const nowIso = this.iso();
    for (const ruleId of Object.keys(intent.affectedRuleState)) {
      // §10.1：audits 对 rule 删除行为 CASCADE——级联删除审计必须以 rule_id=null
      // 写入才能随级联存活（删除审计可追溯）；先写审计再级联。
      this.writeAudit(repo, {
        id: randomUUID(),
        ruleId: null,
        kind: 'lifecycle-cascade',
        reasonCode,
        createdAt: nowIso,
      });
      void ruleId;
    }
  }

  private finishIntent(
    repo: WatchRepository,
    intent: SourceCleanupIntentRow,
    next: 'complete' | 'aborted',
  ): void {
    const transition = repo.transitionSourceCleanupIntent(
      intent.mutationId,
      intent.state,
      next,
      this.iso(),
    );
    if (!transition.ok) {
      throw new Error(`intent 状态迁移失败（${intent.mutationId}，${transition.code}）`);
    }
  }

  // 用 coordinateSourceRule（D2 纯函数）按当前事实协调 sourceId 全部规则
  private coordinateRulesWithSource(
    repo: WatchRepository,
    sourceId: string,
    current: SourceWatchProjection,
  ): void {
    const nowIso = this.iso();
    for (const rule of repo.listRulesBySource(sourceId)) {
      if (rule.state === 'deleted') continue;
      const fingerprint = computeFingerprintFor(
        { sourceId: rule.sourceId, kind: rule.kind, targetUrl: canonicalTargetUrlOf(rule) },
        current,
      );
      const next = coordinateSourceRule(
        ruleFields(rule),
        { exists: true, enabled: current.enabled, rowVersion: current.rowVersion },
        fingerprint,
      );
      if (
        next.state === rule.state &&
        next.pauseReason === rule.pauseReason &&
        next.sourceRowVersion === rule.sourceRowVersion &&
        next.sourceLocatorFingerprint === rule.sourceLocatorFingerprint
      ) {
        continue;
      }
      const updated = repo.updateRuleCoordination(
        rule.id,
        {
          state: rule.state,
          pauseReason: rule.pauseReason,
          sourceRowVersion: rule.sourceRowVersion,
          sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
        },
        {
          state: next.state,
          pauseReason: next.pauseReason,
          sourceRowVersion: next.sourceRowVersion,
          sourceLocatorFingerprint: next.sourceLocatorFingerprint,
        },
        nowIso,
      );
      if (!updated.ok) {
        throw new Error(`规则协调失败（rule=${rule.id}，${updated.code}）`);
      }
      if (rule.state !== 'paused' && next.state === 'paused' && next.pauseReason !== null) {
        this.writeAudit(repo, {
          id: randomUUID(),
          ruleId: rule.id,
          kind: 'lifecycle-pause',
          reasonCode: this.pauseAuditReason(next.pauseReason),
          createdAt: nowIso,
        });
      }
    }
  }

  private pauseRulesSourceDeleted(repo: WatchRepository, sourceId: string): void {
    const nowIso = this.iso();
    for (const rule of repo.listRulesBySource(sourceId)) {
      if (rule.state === 'deleted') continue;
      const next = transitionRuleState(
        ruleFields(rule),
        { kind: 'source-delete' },
        { sourceExists: false, sourceEnabled: false, locatorUnchanged: true },
      );
      if (next.state === rule.state && next.pauseReason === rule.pauseReason) continue;
      const updated = repo.updateRuleCoordination(
        rule.id,
        {
          state: rule.state,
          pauseReason: rule.pauseReason,
          sourceRowVersion: rule.sourceRowVersion,
          sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
        },
        {
          state: next.state,
          pauseReason: next.pauseReason,
          sourceRowVersion: rule.sourceRowVersion,
          sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
        },
        nowIso,
      );
      if (!updated.ok) {
        throw new Error(`规则暂停失败（rule=${rule.id}，${updated.code}）`);
      }
      if (rule.state !== 'paused') {
        this.writeAudit(repo, {
          id: randomUUID(),
          ruleId: rule.id,
          kind: 'lifecycle-pause',
          reasonCode: 'source-deleted',
          createdAt: nowIso,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // 启动 reconciliation（store 步骤 6 hook；全部成功才返回 ok）
  // -------------------------------------------------------------------------

  reconcileOnStartup(
    repo: WatchRepository,
    reader: SourceProjectionReader,
  ): { ok: boolean; reason: string | null } {
    try {
      withTransaction(repo.dbHandle, () => {
        const nowIso = this.iso();
        for (const intent of repo.listSourceCleanupIntents()) {
          if (intent.state === 'complete' || intent.state === 'aborted') continue;
          this.replayCommitIntent(repo, reader, intent);
        }
        // 无 intent 覆盖的规则同样对照 Source 当前事实（sources.db 被恢复/被
        // 直接改动等路径）：任一孤儿一律暂停，零联网保证。
        for (const rule of repo.listRules()) {
          if (rule.state === 'deleted') continue;
          const current = projectionOrNull(reader(rule.sourceId));
          if (current === null) {
            this.pauseSingleRuleSourceDeleted(repo, rule, nowIso);
            continue;
          }
          const fingerprint = computeFingerprintFor(
            { sourceId: rule.sourceId, kind: rule.kind, targetUrl: canonicalTargetUrlOf(rule) },
            current,
          );
          const next = coordinateSourceRule(
            ruleFields(rule),
            { exists: true, enabled: current.enabled, rowVersion: current.rowVersion },
            fingerprint,
          );
          if (
            next.state === rule.state &&
            next.pauseReason === rule.pauseReason &&
            next.sourceRowVersion === rule.sourceRowVersion &&
            next.sourceLocatorFingerprint === rule.sourceLocatorFingerprint
          ) {
            continue;
          }
          const updated = repo.updateRuleCoordination(
            rule.id,
            {
              state: rule.state,
              pauseReason: rule.pauseReason,
              sourceRowVersion: rule.sourceRowVersion,
              sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
            },
            {
              state: next.state,
              pauseReason: next.pauseReason,
              sourceRowVersion: next.sourceRowVersion,
              sourceLocatorFingerprint: next.sourceLocatorFingerprint,
            },
            nowIso,
          );
          if (!updated.ok) {
            throw new Error(`reconciliation 规则协调失败（rule=${rule.id}，${updated.code}）`);
          }
          if (rule.state !== 'paused' && next.state === 'paused' && next.pauseReason !== null) {
            this.writeAudit(repo, {
              id: randomUUID(),
              ruleId: rule.id,
              kind: 'lifecycle-pause',
              reasonCode: this.pauseAuditReason(next.pauseReason),
              createdAt: nowIso,
            });
          }
        }
        // 全部成功才删除已解决 intent（schedulerReady 由 Store 置位）
        repo.deleteResolvedIntents();
        this.writeAudit(repo, {
          id: randomUUID(),
          ruleId: null,
          kind: 'reconciliation',
          reasonCode: 'complete',
          createdAt: nowIso,
        });
      });
      return { ok: true, reason: null };
    } catch (err) {
      // 事务已回滚；写一条独立事务的失败审计（最佳努力——审计失败不掩盖原始失败）
      try {
        withTransaction(repo.dbHandle, () => {
          const auditResult = repo.insertAudit({
            id: randomUUID(),
            ruleId: null,
            kind: 'reconciliation',
            reasonCode: 'aborted',
            createdAt: this.iso(),
          });
          if (!auditResult.ok) throw new Error(`失败审计写入失败（${auditResult.code}）`);
        });
      } catch {
        // 审计失败不掩盖原始失败
      }
      logError('watch', '启动 reconciliation 失败（已整体回滚）', err);
      return { ok: false, reason: '启动 reconciliation 失败（已整体回滚）' };
    }
  }

  private pauseSingleRuleSourceDeleted(
    repo: WatchRepository,
    rule: WatchRule,
    nowIso: string,
  ): void {
    const next = transitionRuleState(
      ruleFields(rule),
      { kind: 'source-delete' },
      { sourceExists: false, sourceEnabled: false, locatorUnchanged: true },
    );
    if (next.state === rule.state && next.pauseReason === rule.pauseReason) return;
    const updated = repo.updateRuleCoordination(
      rule.id,
      {
        state: rule.state,
        pauseReason: rule.pauseReason,
        sourceRowVersion: rule.sourceRowVersion,
        sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
      },
      {
        state: next.state,
        pauseReason: next.pauseReason,
        sourceRowVersion: rule.sourceRowVersion,
        sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
      },
      nowIso,
    );
    if (!updated.ok) {
      throw new Error(`规则暂停失败（rule=${rule.id}，${updated.code}）`);
    }
    if (rule.state !== 'paused') {
      this.writeAudit(repo, {
        id: randomUUID(),
        ruleId: rule.id,
        kind: 'lifecycle-pause',
        reasonCode: 'source-deleted',
        createdAt: nowIso,
      });
    }
  }

  // -------------------------------------------------------------------------
  // run revalidation 端口（§10.3 步骤 5；D5 在 acquisition 前消费）
  // -------------------------------------------------------------------------

  revalidateRuleSource(ruleId: string): WatchRevalidationResult {
    if (this.getState().mode !== 'normal') return { status: 'unavailable' };
    const repo = this.activeRepo;
    const reader = this.activeReader;
    try {
      return withTransaction(repo.dbHandle, () => {
        const rule = repo.getRule(ruleId);
        if (rule === null) return { status: 'rule-missing' as const };
        if (rule.state === 'deleted') return { status: 'rule-deleted' as const };
        // unavailable 抛错 → 本事务回滚 + Watch unavailable
        const current = projectionOrNull(reader(rule.sourceId));
        if (current === null) {
          this.pauseSingleRuleSourceDeleted(repo, rule, this.iso());
          return { status: 'source-missing' as const };
        }
        const fingerprint = computeFingerprintFor(
          { sourceId: rule.sourceId, kind: rule.kind, targetUrl: canonicalTargetUrlOf(rule) },
          current,
        );
        if (fingerprint !== rule.sourceLocatorFingerprint) {
          this.pauseSingleRuleLocatorChanged(repo, rule, current, this.iso());
          return { status: 'locator-changed' as const };
        }
        if (!current.enabled) {
          this.pauseSingleRuleSourceDisabled(repo, rule, current, this.iso());
          return { status: 'source-disabled' as const };
        }
        // 仅 rowVersion 变化且 fingerprint 相同：更新 rowVersion（D5 结果事务
        // 仍须以 fingerprint+baselineVersion CAS 提交，不丢弃已形成的有效结果）
        const next = coordinateSourceRule(
          ruleFields(rule),
          { exists: true, enabled: true, rowVersion: current.rowVersion },
          fingerprint,
        );
        if (
          next.state !== rule.state ||
          next.pauseReason !== rule.pauseReason ||
          next.sourceRowVersion !== rule.sourceRowVersion
        ) {
          const updated = repo.updateRuleCoordination(
            rule.id,
            {
              state: rule.state,
              pauseReason: rule.pauseReason,
              sourceRowVersion: rule.sourceRowVersion,
              sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
            },
            {
              state: next.state,
              pauseReason: next.pauseReason,
              sourceRowVersion: next.sourceRowVersion,
              sourceLocatorFingerprint: next.sourceLocatorFingerprint,
            },
            this.iso(),
          );
          if (!updated.ok) {
            throw new Error(`revalidation 协调失败（rule=${rule.id}，${updated.code}）`);
          }
        }
        return {
          status: 'ok' as const,
          rowVersion: current.rowVersion,
          sourceAfterAcquisition: current,
        };
      });
    } catch (err) {
      this.markUnavailable('revalidation 事务失败');
      logError('watch', 'run revalidation 事务失败（已整体回滚，Watch 进入 unavailable）', err);
      return { status: 'unavailable' };
    }
  }

  private pauseSingleRuleSourceDisabled(
    repo: WatchRepository,
    rule: WatchRule,
    current: SourceWatchProjection,
    nowIso: string,
  ): void {
    const next = transitionRuleState(
      ruleFields(rule),
      { kind: 'source-disable' },
      { sourceExists: true, sourceEnabled: false, locatorUnchanged: true },
    );
    if (
      next.state === rule.state &&
      next.pauseReason === rule.pauseReason &&
      rule.sourceRowVersion === current.rowVersion
    ) {
      return;
    }
    const updated = repo.updateRuleCoordination(
      rule.id,
      {
        state: rule.state,
        pauseReason: rule.pauseReason,
        sourceRowVersion: rule.sourceRowVersion,
        sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
      },
      {
        state: next.state,
        pauseReason: next.pauseReason,
        sourceRowVersion: current.rowVersion,
        sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
      },
      nowIso,
    );
    if (!updated.ok) {
      throw new Error(`规则暂停失败（rule=${rule.id}，${updated.code}）`);
    }
    if (rule.state !== 'paused') {
      this.writeAudit(repo, {
        id: randomUUID(),
        ruleId: rule.id,
        kind: 'lifecycle-pause',
        reasonCode: 'source-disabled',
        createdAt: nowIso,
      });
    }
  }

  private pauseSingleRuleLocatorChanged(
    repo: WatchRepository,
    rule: WatchRule,
    current: SourceWatchProjection,
    nowIso: string,
  ): void {
    const next = transitionRuleState(
      ruleFields(rule),
      { kind: 'source-locator-change' },
      { sourceExists: true, sourceEnabled: current.enabled, locatorUnchanged: false },
    );
    const updated = repo.updateRuleCoordination(
      rule.id,
      {
        state: rule.state,
        pauseReason: rule.pauseReason,
        sourceRowVersion: rule.sourceRowVersion,
        sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
      },
      {
        state: next.state,
        pauseReason: next.pauseReason,
        sourceRowVersion: current.rowVersion,
        sourceLocatorFingerprint: rule.sourceLocatorFingerprint, // 旧 fingerprint 保留等待 rebaseline
      },
      nowIso,
    );
    if (!updated.ok) {
      throw new Error(`规则暂停失败（rule=${rule.id}，${updated.code}）`);
    }
    if (rule.state !== 'paused') {
      this.writeAudit(repo, {
        id: randomUUID(),
        ruleId: rule.id,
        kind: 'lifecycle-pause',
        reasonCode: 'source-changed',
        createdAt: nowIso,
      });
    }
  }

  // 恢复后 Session grant 失效钩子（store 恢复路径消费；正常重启不调用）
  invalidateSessionConsents(): { ok: boolean; count: number } {
    if (this.getState().mode !== 'normal') return { ok: false, count: 0 };
    return this.activeRepo.invalidateAllSessionConsents();
  }
}
