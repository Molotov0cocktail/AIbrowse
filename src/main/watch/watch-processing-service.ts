// D7 watch-processing-service: 统一 main-process 处理编排（detailed-design §8.1、
// §5/#S6-053、§9.2–§9.4/#S6-047～#S6-052/#S6-056/#S6-057）。唯一编排者：
// - prepareAcquisition：经 Repository 读取并严格验证 Rule 当前 Baseline，把与该
//   baselineVersion 绑定的 contentHash/Feed validators 作为不可变 hint 返回；
// - process：验证 Baseline JSON → Feed/Page Diff → Condition 三分支 → EventValidator
//   → reversal 查询 → Repository 结果事务（create/coalesce/dedup/unchanged/
//   changed-unmatched / failed）。本模块不执行 SQL（Repository 是唯一 SQL 点）；
// - 身份/baseline/event-conflict 零写；validation/budget/condition_error 等闭合
//   failed outcome 以单事务终结并返回 ok=true；只有无法安全形成该事务才
//   store-unavailable。
//
// 边界：#S6-056 条件 header 只来自本服务验证过的 hint；acquisition 禁止读 Run
// metadata；not-modified 只能在 hint.kind=feed 且结果事务内 version/contentHash 与
// hint 精确相等时走 unchanged，禁止进入 Diff。
import { randomUUID } from 'node:crypto';
import type {
  ChangeEvidencePair,
  Clock,
  ConditionWarningCode,
  FeedProjection,
  FeedProjectionValue,
  PageProjection,
  PageProjectionValue,
  SourceWatchProjection,
  WatchBaselineHint,
  WatchEvent,
  WatchEventKind,
  WatchFailureCode,
  WatchHealthSnapshot,
  WatchProcessingResult,
  WatchProcessingService,
  WatchRule,
  WatchRunOutcome,
} from '../../shared/types/watch';
import { EVENT_COALESCE_WINDOW_MS, MAX_EVENT_EVIDENCE_BYTES } from '../../shared/types/watch';
import {
  aggregateEventKind,
  basePairKind,
  buildChangeSet,
  computeChangeFingerprint,
  computeConditionVersion,
  computeIdempotencyKey,
  isReversalPair,
  type PairKind,
} from '../../shared/watch/event-validator';
import {
  evaluateStructuredCondition,
  type ConditionErrorCode,
} from '../../shared/watch/condition-engine';
import { utf8ByteLength } from '../../shared/watch/watch-budget';
import { diffFeedProjections } from '../../shared/watch/diff/feed-diff';
import { diffPageProjections } from '../../shared/watch/diff/page-diff';
import {
  isValidFeedProjectionValue,
  isValidPageProjectionValue,
  sha256Hex,
} from '../../shared/watch/diff/evidence';
import type { WatchRepository } from './repository/watch-repository';
import type { WatchErrorCode } from './repository/watch-repository';
import type { WatchAuditReasonCode } from './db/watch-migrations';
import {
  mapRunHealth,
  isImmediatePauseCode,
  healthPauseAuditReason,
} from './watch-run-coordinator';
import { logWarn } from '../logger';

type WatchErrorCodeLike = WatchErrorCode;

/** #S6-058 FIXED DECISION 9：acquisition 事实由 Rule 类型确定——Feed=rss，Page=browser。 */
function acquisitionForRule(rule: WatchRule): 'rss' | 'browser' {
  return rule.kind === 'page' ? 'browser' : 'rss';
}

function healthySnapshot(rule: WatchRule): WatchHealthSnapshot {
  return { state: 'healthy', acquisition: acquisitionForRule(rule), code: null };
}

export interface WatchProcessingServiceOptions {
  repo: WatchRepository;
  clock: Clock;
  onNotificationReady?: () => void;
  onStateChanged?: () => void;
  windowsNotificationsEnabled?: boolean;
}

interface FailureDraft {
  health: WatchFailureCode;
  retryable: boolean;
}

export class WatchProcessingServiceImpl implements WatchProcessingService {
  private readonly repo: WatchRepository;
  private readonly clock: Clock;
  private readonly onNotificationReady: () => void;
  private readonly onStateChanged: () => void;
  private readonly windowsNotificationsEnabled: boolean;

  constructor(options: WatchProcessingServiceOptions) {
    this.repo = options.repo;
    this.clock = options.clock;
    this.onNotificationReady = options.onNotificationReady ?? (() => undefined);
    this.onStateChanged = options.onStateChanged ?? (() => undefined);
    this.windowsNotificationsEnabled = options.windowsNotificationsEnabled ?? false;
  }

  private iso(): string {
    return new Date(this.clock.now().getTime()).toISOString();
  }

  // -------------------------------------------------------------------------
  // §8.1：Baseline hint（唯一条件 header 来源）
  // -------------------------------------------------------------------------

  prepareAcquisition(input: {
    rule: WatchRule;
  }): { ok: true; baselineHint: WatchBaselineHint } | { ok: false; code: 'store-unavailable' } {
    try {
      const baseline = this.repo.getBaseline(input.rule.id);
      if (baseline === null) {
        // 无 Baseline 行时只允许 Rule.baselineVersion=0
        if (input.rule.baselineVersion !== 0) {
          return { ok: false, code: 'store-unavailable' };
        }
        return { ok: true, baselineHint: { kind: 'none', expectedBaselineVersion: 0 } };
      }
      // 行存在时 Rule/Baseline version、projectionType、contentHash 必须全部恒等
      if (
        input.rule.baselineVersion !== baseline.version ||
        (input.rule.kind === 'feed' && baseline.projectionType !== 'feed') ||
        (input.rule.kind === 'page' && baseline.projectionType !== 'page')
      ) {
        return { ok: false, code: 'store-unavailable' };
      }
      // JSON validator：读取后再次用共享 validator 校验（非法/未来版本 → unavailable）
      const parsed = parseProjectionJson(baseline.projectionJson);
      if (parsed === null) return { ok: false, code: 'store-unavailable' };
      if (baseline.projectionType === 'feed' && !isValidFeedProjectionValue(parsed)) {
        return { ok: false, code: 'store-unavailable' };
      }
      if (baseline.projectionType === 'page' && !isValidPageProjectionValue(parsed)) {
        return { ok: false, code: 'store-unavailable' };
      }
      // contentHash 与 canonical 重新编码必须精确一致（防陈旧/篡改/键重排）：
      // #S6-054/#S6-058——canonical JSON 逐字节等于固定键序重新编码，contentHash
      // 必须是该字节串的 SHA-256；任一不符 → store-unavailable。
      const reencoded = JSON.stringify(parsed);
      if (
        reencoded !== baseline.projectionJson ||
        utf8ByteLength(reencoded) !== baseline.byteLength ||
        sha256Hex(reencoded) !== baseline.contentHash
      ) {
        return { ok: false, code: 'store-unavailable' };
      }
      if (baseline.projectionType === 'feed') {
        return {
          ok: true,
          baselineHint: {
            kind: 'feed',
            expectedBaselineVersion: baseline.version,
            contentHash: baseline.contentHash,
            validators: {
              etag: baseline.conditionalEtag,
              lastModified: baseline.conditionalLastModified,
            },
          },
        };
      }
      return {
        ok: true,
        baselineHint: {
          kind: 'page',
          expectedBaselineVersion: baseline.version,
          contentHash: baseline.contentHash,
        },
      };
    } catch (err) {
      logWarn('watch', 'prepareAcquisition 读取 Baseline 失败（store-unavailable）', err);
      return { ok: false, code: 'store-unavailable' };
    }
  }

  // -------------------------------------------------------------------------
  // process：统一处理入口（§8.1）
  // -------------------------------------------------------------------------

  process(input: {
    rule: WatchRule;
    runId: string;
    baselineHint: WatchBaselineHint;
    acquisition: Extract<import('../../shared/types/watch').WatchAcquisitionResult, { ok: true }>;
    sourceAfterAcquisition: SourceWatchProjection;
  }): WatchProcessingResult {
    const nowIso = this.iso();
    const identity = {
      sourceId: input.rule.sourceId,
      sourceLocatorFingerprint: input.rule.sourceLocatorFingerprint,
      expectedBaselineVersion: input.baselineHint.expectedBaselineVersion,
    };

    // 校验 input.rule 与 acquisition 身份一致（防御）
    if (
      input.acquisition.expectedSourceLocatorFingerprint !== input.rule.sourceLocatorFingerprint
    ) {
      return {
        ok: false,
        code: 'identity-conflict',
        terminalWritten: false,
      };
    }

    // not-modified：仅 Feed + 已存在 Baseline
    if (input.acquisition.kind === 'not-modified') {
      if (input.baselineHint.kind !== 'feed') {
        return { ok: false, code: 'validation-failed', terminalWritten: false };
      }
      const responseMetadata = input.acquisition.responseMetadata;
      // 304 成功：validator 存在且合法的新值替换旧值，缺失/超限保留 hint 旧值
      const validatorUpdate =
        responseMetadata !== null
          ? {
              etag:
                responseMetadata.etag !== null
                  ? responseMetadata.etag
                  : input.baselineHint.validators.etag,
              lastModified:
                responseMetadata.lastModified !== null
                  ? responseMetadata.lastModified
                  : input.baselineHint.validators.lastModified,
            }
          : input.baselineHint.validators;
      const outcome: WatchRunOutcome = { kind: 'unchanged' };
      const health: WatchHealthSnapshot = healthySnapshot(input.rule);
      const runMetadata = JSON.stringify({
        schemaVersion: 1,
        http: responseMetadata,
        conditionWarnings: [],
      });
      const result = this.repo.writeEventResult({
        path: 'unchanged',
        rule: input.rule,
        runId: input.runId,
        sourceAfterRevalidationRowVersion: input.sourceAfterAcquisition.rowVersion,
        identity,
        validatorUpdate,
        run: { expectedStatus: 'running', outcome, health, responseMetadataJson: runMetadata },
        audits: [{ id: randomUUID(), reasonCode: 'unchanged', createdAt: nowIso }],
      });
      if (!result.ok) return this.conflictResult(result.code);
      return { ok: true, outcome };
    }

    // 至此 acquisition 必为 projection 形态
    if (input.acquisition.kind !== 'projection') {
      return { ok: false, code: 'validation-failed', terminalWritten: false };
    }

    // projection
    const projection = input.acquisition.projection;
    const oldBaseline = this.repo.getBaseline(input.rule.id);
    if (oldBaseline === null) {
      // hint=none 且 Rule.baselineVersion=0：首建 Baseline（零 Event）
      if (input.baselineHint.kind !== 'none' || input.rule.baselineVersion !== 0) {
        return { ok: false, code: 'baseline-conflict', terminalWritten: false };
      }
      return this.establishFirstBaseline(input, projection, nowIso);
    }
    // hint=kinds feed/page（none 但库中已有 Baseline → 数据完整性失败）
    if (input.baselineHint.kind === 'none') {
      return { ok: false, code: 'store-unavailable', terminalWritten: false };
    }
    const oldValue = parseProjectionJson(oldBaseline.projectionJson);
    if (oldValue === null) return { ok: false, code: 'validation-failed', terminalWritten: false };
    if (oldBaseline.projectionType === 'feed' && !isValidFeedProjectionValue(oldValue)) {
      return { ok: false, code: 'validation-failed', terminalWritten: false };
    }
    if (oldBaseline.projectionType === 'page' && !isValidPageProjectionValue(oldValue)) {
      return { ok: false, code: 'validation-failed', terminalWritten: false };
    }

    // 同 contentHash → unchanged（200 同 hash：validator 提交 200 值，Baseline 不变；
    // 要求库中 Baseline version/contentHash 与 hint 一致）
    if (
      projection.contentHash === input.baselineHint.contentHash &&
      oldBaseline.version === input.baselineHint.expectedBaselineVersion &&
      oldBaseline.contentHash === input.baselineHint.contentHash
    ) {
      const responseMetadata = input.acquisition.responseMetadata;
      const validatorUpdate =
        responseMetadata !== null
          ? { etag: responseMetadata.etag, lastModified: responseMetadata.lastModified }
          : { etag: null, lastModified: null };
      const outcome: WatchRunOutcome = { kind: 'unchanged' };
      const health: WatchHealthSnapshot = healthySnapshot(input.rule);
      const runMetadata = JSON.stringify({
        schemaVersion: 1,
        http: responseMetadata,
        conditionWarnings: [],
      });
      const result = this.repo.writeEventResult({
        path: 'unchanged',
        rule: input.rule,
        runId: input.runId,
        sourceAfterRevalidationRowVersion: input.sourceAfterAcquisition.rowVersion,
        identity,
        validatorUpdate,
        run: { expectedStatus: 'running', outcome, health, responseMetadataJson: runMetadata },
        audits: [{ id: randomUUID(), reasonCode: 'unchanged', createdAt: nowIso }],
      });
      if (!result.ok) return this.conflictResult(result.code);
      return { ok: true, outcome };
    }
    // 若 observation 已存在，说明该变化已提交、Baseline 已推进，diff 对新旧同内容为零对）
    const conditionVersion = computeConditionVersion(input.rule.condition);
    const idempotencyKey = computeIdempotencyKey({
      ruleId: input.rule.id,
      baselineVersion: input.baselineHint.expectedBaselineVersion,
      newProjectionHash: projection.contentHash,
      conditionVersion,
    });
    // 已存在同 idempotencyKey observation → 合法重放（dedup）
    const existing = this.repo.findObservationByIdempotencyKey(idempotencyKey);
    if (existing !== null) {
      const outcome: WatchRunOutcome = { kind: 'event-deduplicated', eventId: existing.eventId };
      const health: WatchHealthSnapshot = healthySnapshot(input.rule);
      const runMetadata = JSON.stringify({
        schemaVersion: 1,
        http: input.acquisition.responseMetadata,
        conditionWarnings: [],
      });
      const result = this.repo.writeEventResult({
        path: 'dedup',
        rule: input.rule,
        runId: input.runId,
        sourceAfterRevalidationRowVersion: input.sourceAfterAcquisition.rowVersion,
        identity,
        dedupIdempotencyKey: idempotencyKey,
        run: { expectedStatus: 'running', outcome, health, responseMetadataJson: runMetadata },
        audits: [{ id: randomUUID(), reasonCode: 'event-deduplicated', createdAt: nowIso }],
      });
      if (!result.ok) return this.conflictResult(result.code);
      return { ok: true, outcome };
    }

    // Diff（§9.2）
    const oldSnapshot = {
      value: oldValue,
      finalUrl: oldBaseline.finalUrl,
      capturedAt: oldBaseline.capturedAt,
      documentId: oldBaseline.documentId,
    };
    const newSnapshot = {
      value: parseProjectionJson(JSON.stringify(projectionValueOf(projection)))!,
      finalUrl: projection.finalUrl,
      capturedAt: projection.capturedAt,
      documentId: projection.documentId,
    };
    const pairs =
      projection.value.type === 'feed'
        ? diffFeedProjections(oldSnapshot as never, newSnapshot as never).pairs
        : diffPageProjections(oldSnapshot as never, newSnapshot as never).pairs;
    if (pairs.length === 0) {
      // contentHash 不同但无合规 pair → unexplainable_change → failed(parse_changed)
      return this.failedTerminal(
        input.rule,
        input.runId,
        { health: 'parse_changed', retryable: false },
        nowIso,
        { changeFingerprint: '' },
        input.acquisition.responseMetadata,
      );
    }

    // Condition 三分支（§5/#S6-053）
    const fieldCatalog = conditionFieldCatalog(input.rule, oldValue, newSnapshot.value);
    const changeSet = buildChangeSet(aggregateEventKind(pairs.map((p) => basePairKind(p))), pairs);
    const conditionResult = evaluateStructuredCondition({
      condition: input.rule.condition,
      changeSet,
      fieldCatalog,
    });
    const conditionWarnings: ConditionWarningCode[] = conditionResult.ok
      ? conditionResult.warnings
      : [];
    if (!conditionResult.ok) {
      // condition error → 非重试失败，立即暂停（dependency-unavailable）
      return this.conditionErrorTerminal(
        input.rule,
        input.runId,
        conditionResult.code,
        nowIso,
        input.acquisition.responseMetadata,
      );
    }

    // reversal oracle（#S6-048）：对每个 pair 查询最近持久化镜像
    const pairKinds: PairKind[] = pairs.map((p) => {
      const q = this.repo.findRecentPersistedPair(input.rule.id, p.itemId, p.fieldKey);
      return isReversalPair(p, q) ? 'reversal' : basePairKind(p);
    });
    const eventKind = aggregateEventKind(pairKinds);
    const changeFingerprint = computeChangeFingerprint(
      pairs.map((p, i) => ({
        itemKey: p.itemId,
        fieldKey: p.fieldKey,
        pairKind: pairKinds[i]!,
        before: p.before,
        after: p.after,
      })),
    );
    const observedAt = nowIso;

    // matched=true → 新建/合并（#S6-047）
    if (conditionResult.matched) {
      return this.createOrCoalesce(
        input,
        pairs,
        eventKind,
        idempotencyKey,
        changeFingerprint,
        observedAt,
        conditionWarnings,
        nowIso,
        identity,
      );
    }

    // matched=false + warnings → changed-unmatched：推进 Baseline、健康恢复
    const outcome: WatchRunOutcome = { kind: 'changed-unmatched', changeFingerprint };
    const health: WatchHealthSnapshot = healthySnapshot(input.rule);
    const runMetadata = JSON.stringify({
      schemaVersion: 1,
      http: input.acquisition.responseMetadata,
      conditionWarnings,
    });
    const result = this.repo.writeEventResult({
      path: 'changed-unmatched',
      rule: input.rule,
      runId: input.runId,
      sourceAfterRevalidationRowVersion: input.sourceAfterAcquisition.rowVersion,
      identity,
      baseline: baselineDraft(input.rule, projection, input.acquisition.responseMetadata),
      run: { expectedStatus: 'running', outcome, health, responseMetadataJson: runMetadata },
      audits: [{ id: randomUUID(), reasonCode: 'changed-unmatched', createdAt: nowIso }],
    });
    if (!result.ok) return this.conflictResult(result.code);
    return { ok: true, outcome };
  }

  // -------------------------------------------------------------------------
  // 分支实现
  // -------------------------------------------------------------------------

  /** 首建 Baseline（零 Event；baseline-established audit）。 */
  private establishFirstBaseline(
    input: {
      rule: WatchRule;
      runId: string;
      acquisition: Extract<import('../../shared/types/watch').WatchAcquisitionResult, { ok: true }>;
      sourceAfterAcquisition: SourceWatchProjection;
    },
    projection: FeedProjection | PageProjection,
    nowIso: string,
  ): WatchProcessingResult {
    const auditId = randomUUID();
    const outcome: WatchRunOutcome = { kind: 'baseline-established', auditId };
    const health: WatchHealthSnapshot = healthySnapshot(input.rule);
    const runMetadata = JSON.stringify({
      schemaVersion: 1,
      http: input.acquisition.responseMetadata,
      conditionWarnings: [],
    });
    const result = this.repo.writeEventResult({
      path: 'changed-unmatched', // 复用 baseline 推进路径（首建）
      rule: input.rule,
      runId: input.runId,
      sourceAfterRevalidationRowVersion: input.sourceAfterAcquisition.rowVersion,
      identity: {
        sourceId: input.rule.sourceId,
        sourceLocatorFingerprint: input.rule.sourceLocatorFingerprint,
        expectedBaselineVersion: null,
      },
      baseline: baselineDraft(input.rule, projection, input.acquisition.responseMetadata),
      run: { expectedStatus: 'running', outcome, health, responseMetadataJson: runMetadata },
      audits: [{ id: auditId, reasonCode: 'baseline-established', createdAt: nowIso }],
    });
    if (!result.ok) return this.conflictResult(result.code);
    return { ok: true, outcome };
  }

  /** matched=true：新建 Event 或 30 分钟内合并到最近 Event（#S6-047）。 */
  private createOrCoalesce(
    input: {
      rule: WatchRule;
      runId: string;
      acquisition: Extract<import('../../shared/types/watch').WatchAcquisitionResult, { ok: true }>;
      sourceAfterAcquisition: SourceWatchProjection;
    },
    pairs: ChangeEvidencePair[],
    eventKind: WatchEventKind,
    idempotencyKey: string,
    changeFingerprint: string,
    observedAt: string,
    conditionWarnings: ConditionWarningCode[],
    nowIso: string,
    identity: {
      sourceId: string;
      sourceLocatorFingerprint: string;
      expectedBaselineVersion: number;
    },
  ): WatchProcessingResult {
    if (input.acquisition.kind !== 'projection') {
      return { ok: false, code: 'validation-failed', terminalWritten: false };
    }
    const projection = input.acquisition.projection;
    const latest = this.repo.findLatestEventForCoalesce(input.rule.id);
    const newItemsBytes = pairs.reduce((s, p) => s + utf8ByteLength(JSON.stringify(p)), 0);
    let canCoalesce = false;
    if (latest !== null) {
      const existingItemsBytes = this.repo
        .listEventItems(latest.id)
        .reduce((s, p) => s + utf8ByteLength(JSON.stringify(p)), 0);
      const firstObservedMs = Date.parse(latest.firstObservedAt);
      const nowMs = this.clock.now().getTime();
      canCoalesce =
        Number.isFinite(firstObservedMs) &&
        nowMs - firstObservedMs < EVENT_COALESCE_WINDOW_MS &&
        existingItemsBytes + newItemsBytes <= MAX_EVENT_EVIDENCE_BYTES;
    }
    const runMetadata = JSON.stringify({
      schemaVersion: 1,
      http: input.acquisition.responseMetadata,
      conditionWarnings,
    });

    if (canCoalesce && latest !== null) {
      const outcome: WatchRunOutcome = { kind: 'event-coalesced', eventId: latest.id };
      const health: WatchHealthSnapshot = healthySnapshot(input.rule);
      const result = this.repo.writeEventResult({
        path: 'coalesce',
        rule: input.rule,
        runId: input.runId,
        sourceAfterRevalidationRowVersion: input.sourceAfterAcquisition.rowVersion,
        identity,
        baseline: baselineDraft(input.rule, projection, input.acquisition.responseMetadata),
        coalesce: {
          eventId: latest.id,
          expectedFirstObservedAt: latest.firstObservedAt,
          expectedItemCount: latest.itemCount,
          eventKind,
          lastObservedAt: observedAt,
          newItemCount: latest.itemCount + pairs.length,
          // R3-4：coalesce observation 使用 Node randomUUID() 小写 UUID v4（无 c- 前缀）
          observationId: randomUUID(),
          idempotencyKey,
          changeFingerprint,
          items: pairs,
        },
        run: { expectedStatus: 'running', outcome, health, responseMetadataJson: runMetadata },
        audits: [{ id: randomUUID(), reasonCode: 'event-coalesced', createdAt: nowIso }],
      });
      if (!result.ok) return this.conflictResult(result.code);
      return { ok: true, outcome };
    }

    const eventId = randomUUID();
    const event: WatchEvent = {
      id: eventId,
      ruleId: input.rule.id,
      sourceId: input.rule.sourceId,
      eventKind,
      importance: input.rule.notificationLevel,
      idempotencyKey,
      changeFingerprint,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      itemCount: pairs.length,
      readAt: null,
    };
    const outcome: WatchRunOutcome = { kind: 'event-created', eventId };
    const health: WatchHealthSnapshot = healthySnapshot(input.rule);
    // #S6-047 FIXED DECISION 3：outbox 抑制条件只有 rule.muted；notificationLevel
    // 只是 Event importance（normal/important 非 muted 都恰一条 in-app outbox）。
    const privacyJson = JSON.stringify({
      eventKind,
      importance: event.importance,
      itemCount: pairs.length,
    });
    const outbox = input.rule.muted
      ? []
      : [
          {
            id: randomUUID(),
            dedupeKey: `in-app|event|${eventId}|1`,
            privacyJson,
            channel: 'in-app' as const,
          },
          ...(this.windowsNotificationsEnabled
            ? [
                {
                  id: randomUUID(),
                  dedupeKey: `windows|event|${eventId}|1`,
                  privacyJson,
                  channel: 'windows' as const,
                },
              ]
            : []),
        ];
    const result = this.repo.writeEventResult({
      path: 'create',
      rule: input.rule,
      runId: input.runId,
      sourceAfterRevalidationRowVersion: input.sourceAfterAcquisition.rowVersion,
      identity,
      baseline: baselineDraft(input.rule, projection, input.acquisition.responseMetadata),
      event: { event, items: pairs, outbox },
      run: { expectedStatus: 'running', outcome, health, responseMetadataJson: runMetadata },
      audits: [{ id: randomUUID(), reasonCode: 'event-created', createdAt: nowIso }],
    });
    if (!result.ok) return this.conflictResult(result.code);
    // Event creation changes global unread state even when mute suppresses every outbox row.
    this.onStateChanged();
    if (outbox.length > 0) this.onNotificationReady();
    return { ok: true, outcome };
  }

  /** 闭合 failed outcome（§5/§7）：unexplainable → parse_changed；validation → 相应码。 */
  private failedTerminal(
    rule: WatchRule,
    runId: string,
    failure: FailureDraft,
    nowIso: string,
    extra: { changeFingerprint?: string },
    responseMetadata: import('../../shared/types/watch').ConditionalResponseMetadata | null,
  ): WatchProcessingResult {
    void extra;
    const cf = rule.consecutiveFailures + 1;
    const health = mapRunHealth(failure.health, cf, acquisitionForRule(rule));
    const outcome: WatchRunOutcome = {
      kind: 'failed',
      health: failure.health,
      retryable: failure.retryable,
    };
    const reasonCode: WatchAuditReasonCode =
      failure.health === 'parse_changed' ? 'parse-changed' : hyphenate(failure.health);
    // R2-1：失败终态也持久化 canonical metadata——http 保留本次 acquisition 的
    // 可信响应元数据（parse_changed 时 acquisition 已成功），warnings=[]（Condition
    // 尚未成功求值）。
    const runMetadata = JSON.stringify({
      schemaVersion: 1,
      http: responseMetadata,
      conditionWarnings: [],
    });
    const result = this.repo.finalizeRun({
      runId,
      ruleId: rule.id,
      outcome,
      health,
      consecutiveFailures: cf,
      backoffUntil: null,
      responseMetadataJson: runMetadata,
      runAudit: { id: randomUUID(), reasonCode, createdAt: nowIso },
      healthPause: isImmediatePauseCode(failure.health)
        ? {
            reason: healthPauseAuditReason(failure.health) ?? 'dependency-unavailable',
            audit: { id: randomUUID(), createdAt: nowIso },
          }
        : undefined,
    });
    if (!result.ok) return this.conflictResult(result.code);
    return { ok: true, outcome };
  }

  /** condition_error 终态（#S6-053）：旧 Baseline、counter+1、无 backoff、立即暂停。 */
  private conditionErrorTerminal(
    rule: WatchRule,
    runId: string,
    code: ConditionErrorCode,
    nowIso: string,
    responseMetadata: import('../../shared/types/watch').ConditionalResponseMetadata | null,
  ): WatchProcessingResult {
    void code;
    const cf = rule.consecutiveFailures + 1;
    const health: WatchHealthSnapshot = {
      state: 'paused',
      acquisition: acquisitionForRule(rule),
      code: 'condition_error',
    };
    const outcome: WatchRunOutcome = {
      kind: 'failed',
      health: 'condition_error',
      retryable: false,
    };
    // R2-1：condition_error 必须保留本次 acquisition 的可信 http metadata；
    // warnings=[]（Condition 求值失败，不是 no-match warning）。
    const runMetadata = JSON.stringify({
      schemaVersion: 1,
      http: responseMetadata,
      conditionWarnings: [],
    });
    const result = this.repo.finalizeRun({
      runId,
      ruleId: rule.id,
      outcome,
      health,
      consecutiveFailures: cf,
      backoffUntil: null,
      responseMetadataJson: runMetadata,
      runAudit: { id: randomUUID(), reasonCode: 'condition-error', createdAt: nowIso },
      healthPause: {
        reason: 'dependency-unavailable',
        audit: { id: randomUUID(), createdAt: nowIso },
      },
    });
    if (!result.ok) return this.conflictResult(result.code);
    return { ok: true, outcome };
  }

  private conflictResult(code: WatchErrorCodeLike): WatchProcessingResult {
    // 映射 repository 错误码到 WatchProcessingResult 闭合 code；未知/SQL 错误按
    // store-unavailable 处理（fail-closed）
    switch (code) {
      case 'identity-conflict':
      case 'rule-not-found':
        return { ok: false, code: 'identity-conflict', terminalWritten: false };
      case 'baseline-conflict':
      case 'baseline-budget-exceeded':
      case 'duplicate-idempotency':
      case 'duplicate-item-sequence':
      case 'event-conflict':
        return { ok: false, code: 'event-conflict', terminalWritten: false };
      case 'validation-failed':
        return { ok: false, code: 'validation-failed', terminalWritten: false };
      case 'event-budget-exceeded':
      case 'db-budget-exceeded':
        return { ok: false, code: 'budget-exceeded', terminalWritten: false };
      case 'store-unavailable':
      default:
        return { ok: false, code: 'store-unavailable', terminalWritten: false };
    }
  }
}

function hyphenate(code: WatchFailureCode): WatchAuditReasonCode {
  switch (code) {
    case 'login_required':
      return 'login-required';
    case 'captcha':
      return 'captcha';
    case 'parse_changed':
      return 'parse-changed';
    case 'unavailable':
      return 'unavailable';
    case 'robots_disallowed':
      return 'robots-disallowed';
    case 'security_rejected':
      return 'security-rejected';
    case 'budget_exceeded':
      return 'budget-exceeded';
    case 'dependency_unavailable':
      return 'dependency-unavailable';
    case 'interrupted':
      return 'interrupted';
    case 'condition_error':
      return 'condition-error';
    default:
      return 'unavailable';
  }
}

function parseProjectionJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function projectionValueOf(
  projection: FeedProjection | PageProjection,
): FeedProjectionValue | PageProjectionValue {
  return projection.value;
}

/** baseline draft：新 envelope → Repository baseline 写入参数。 */
function baselineDraft(
  rule: WatchRule,
  projection: FeedProjection | PageProjection,
  responseMetadata: import('../../shared/types/watch').ConditionalResponseMetadata | null,
): {
  projectionType: 'feed' | 'page';
  projectionJson: string;
  contentHash: string;
  byteLength: number;
  finalUrl: string;
  capturedAt: string;
  documentId: string | null;
  validators: { etag: string | null; lastModified: string | null };
} {
  void rule;
  const isFeed = projection.value.type === 'feed';
  return {
    projectionType: isFeed ? 'feed' : 'page',
    projectionJson: JSON.stringify(projection.value),
    contentHash: projection.contentHash,
    byteLength: projection.byteLength,
    finalUrl: projection.finalUrl,
    capturedAt: projection.capturedAt,
    documentId: projection.documentId,
    validators: {
      etag: isFeed && responseMetadata !== null ? responseMetadata.etag : null,
      lastModified: isFeed && responseMetadata !== null ? responseMetadata.lastModified : null,
    },
  };
}

/** Condition fieldCatalog：Feed 闭合集；Page 取 Baseline 与新 Projection fieldKey 并集。 */
function conditionFieldCatalog(
  rule: WatchRule,
  oldValue: unknown,
  newValue: unknown,
): ReadonlySet<string> {
  if (rule.kind === 'feed') {
    return new Set(['title', 'link', 'summary', 'published']);
  }
  const catalog = new Set<string>();
  const addFields = (v: unknown): void => {
    if (!Array.isArray((v as { fields?: unknown })?.fields)) return;
    for (const f of (v as { fields: Array<{ fieldKey?: unknown }> }).fields) {
      if (typeof f?.fieldKey === 'string') catalog.add(f.fieldKey);
    }
  };
  addFields(oldValue);
  addFields(newValue);
  return catalog;
}
