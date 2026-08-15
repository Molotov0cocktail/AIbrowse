// Fourth Stage B5: Sources IPC adapter（决议 #69/#70/#72/#73/#74/#76）——
// 主进程侧的 sources:* 通道业务层（index.ts 的 handle() 包装负责 sender+主帧校验；
// 本模块负责参数严格白名单验证、audience 硬编码 'user'（renderer 无 audience/
// 数据库路径/SQL 通道）、状态门控（normal/readonly-recovery/unavailable：写入口
// 全拒、读入口按决议 #39 一并拒绝）、sources:changed 仅成功变更后触发恰好一次、
// 手工写操作独立脱敏审计（每次写尝试恰好一条：sourceId/操作/字段名/长度/结果码，
// 禁止 note 正文/完整 URL/query/删除 token/数据库路径——不并入 ToolStepDecision）。
// 零 Electron import：可用真实 node:sqlite + SourceServiceImpl 单测（source-ipc.test.ts）。
// stateOverride 为 SMOKE_MODE 专属注入点（生产行为不变）——冒烟驱动恢复态/
// 不可用态 UI 断言（决议 #74 测试落点）。
import {
  isUuidShape,
  validateManualAddInput,
  validateManualPatch,
} from './domain/source-change-set';
import type {
  ManualAddInput,
  ManualPatch,
  ManualWriteResult,
  PrepareHardDeleteResult,
  QuickAddResult,
  SourceErrorCode,
  SourceGroupsResult,
  SourceListResult,
  SourceResult,
  SourceSearchResult,
  SourceService,
  SourcesState,
  UndoResult,
  UndoableChange,
} from '../../shared/types/sources';

// ---- 手工审计（决议 #76）：独立 manual 审计适配器 ----

export interface ManualSourcesAudit {
  op: string; // add/update/disable/restore/undo/quick-add/hard-delete
  sourceId: string | null;
  fields: string[]; // 字段名白名单（不含值）
  lens: number[]; // 对应字段长度（串=字符数；数组=项数；其他=1）
  result: string; // 结果码：'ok' 或 SourceErrorCode/'no-active-page'/'unsupported-url'
}

// 确定性中文格式（经 logger sanitize 脱敏链；note 正文/URL 值/token/路径零出现）
export function formatManualSourcesAudit(entry: ManualSourcesAudit): string {
  return (
    `sources-manual（op=${entry.op}，sourceId=${entry.sourceId ?? '-'}，` +
    `fields=[${entry.fields.join(',')}]，lens=[${entry.lens.join(',')}]，` +
    `result=${entry.result}）`
  );
}

// ---- 载荷严格白名单校验（纯函数；非法输入结构化安全返回，不抛异常） ----

export type SourcesPayloadValidation<T> =
  { ok: true; value: T } | { ok: false; errorCode: SourceErrorCode };

type Record = { [key: string]: unknown };

const isRecord = (v: unknown): v is Record =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// 白名单键校验：未知字段一律拒绝（决议 #69 严格白名单）
function checkKeys(raw: Record, allowed: readonly string[]): boolean {
  return Object.keys(raw).every((k) => (allowed as readonly string[]).includes(k));
}

const invalid = <T>(
  code: SourceErrorCode = 'source-invalid-change',
): SourcesPayloadValidation<T> => ({
  ok: false,
  errorCode: code,
});
const valid = <T>(value: T): SourcesPayloadValidation<T> => ({ ok: true, value });

function readPage(raw: Record, key = 'page'): number | 'invalid' {
  const v = raw[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return 'invalid';
  return v;
}

function readPageSize(raw: Record, key = 'pageSize'): number | 'invalid' | 'limit' | 'default' {
  const v = raw[key];
  if (v === undefined) return 'default';
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return 'invalid';
  if (v > 20) return 'limit';
  return v;
}

export interface ValidatedSourcesList {
  page: number;
  pageSize?: number;
  groupId?: string | null;
  enabledOnly?: boolean;
}

export function validateSourcesListPayload(
  raw: unknown,
): SourcesPayloadValidation<ValidatedSourcesList> {
  if (!isRecord(raw) || !checkKeys(raw, ['page', 'pageSize', 'groupId', 'enabledOnly'])) {
    return invalid();
  }
  const page = readPage(raw);
  if (page === 'invalid') return invalid();
  const pageSize = readPageSize(raw);
  if (pageSize === 'invalid') return invalid();
  if (pageSize === 'limit') return invalid('source-limit');
  const groupId = raw['groupId'];
  if (
    groupId !== undefined &&
    groupId !== null &&
    (typeof groupId !== 'string' || groupId === '')
  ) {
    return invalid();
  }
  const enabledOnly = raw['enabledOnly'];
  if (enabledOnly !== undefined && typeof enabledOnly !== 'boolean') return invalid();
  return valid({
    page,
    ...(pageSize === 'default' ? {} : { pageSize }),
    ...(groupId === undefined ? {} : { groupId: groupId as string | null }),
    ...(enabledOnly === undefined ? {} : { enabledOnly }),
  });
}

export function validateSourcesGetPayload(
  raw: unknown,
): SourcesPayloadValidation<{ sourceId: string }> {
  if (!isRecord(raw) || !checkKeys(raw, ['sourceId'])) return invalid();
  const sourceId = raw['sourceId'];
  if (typeof sourceId !== 'string' || !isUuidShape(sourceId)) return invalid();
  return valid({ sourceId });
}

export interface ValidatedSourcesSearch {
  query: string;
  limit?: number;
}

export function validateSourcesSearchPayload(
  raw: unknown,
): SourcesPayloadValidation<ValidatedSourcesSearch> {
  if (!isRecord(raw) || !checkKeys(raw, ['query', 'limit'])) return invalid();
  const query = raw['query'];
  if (typeof query !== 'string' || query.trim() === '' || query.length > 500) return invalid();
  const limit = raw['limit'];
  if (limit === undefined) return valid({ query });
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) return invalid();
  if (limit > 10) return invalid('source-limit');
  return valid({ query, limit });
}

export interface ValidatedSourcesGroups {
  page: number;
  pageSize?: number;
}

export function validateSourcesGroupsPayload(
  raw: unknown,
): SourcesPayloadValidation<ValidatedSourcesGroups> {
  if (!isRecord(raw) || !checkKeys(raw, ['page', 'pageSize'])) return invalid();
  const page = readPage(raw);
  if (page === 'invalid') return invalid();
  const pageSize = readPageSize(raw);
  if (pageSize === 'invalid') return invalid();
  if (pageSize === 'limit') return invalid('source-limit');
  return valid({ page, ...(pageSize === 'default' ? {} : { pageSize }) });
}

// 决议 #75：IPC 写通道白名单不含 aiNote（AI note 只读展示，用户只编辑 user note）；
// trust 仅 value（assertedBy/verification 由 main/SourceService 确定，renderer 不得伪造）。
const IPC_ADD_KEYS = [
  'scope',
  'url',
  'name',
  'groupName',
  'tags',
  'priority',
  'shareMode',
  'userNote',
  'trust',
] as const;
const IPC_PATCH_KEYS = [
  'name',
  'url',
  'groupName',
  'tags',
  'priority',
  'shareMode',
  'userNote',
  'trust',
] as const;

export function validateSourcesAddPayload(raw: unknown): SourcesPayloadValidation<ManualAddInput> {
  if (!isRecord(raw) || !checkKeys(raw, IPC_ADD_KEYS)) return invalid();
  const validation = validateManualAddInput(raw); // 域层白名单/长度/枚举/URL 形状同源校验
  if (!validation.ok || validation.input === null) {
    return invalid(validation.errorCode ?? 'source-invalid-change');
  }
  // 返回原始白名单载荷（而非 NormalizedManualAdd——后者含 kind/canonicalKey 等
  // 规范化字段，回传 service 会触发「白名单外字段」拒绝；service 按同一域层规则
  // 重新校验/规范化，结果恒等）。断言安全：键集已过白名单、各字段已过域层校验。
  return valid(raw as unknown as ManualAddInput);
}

export interface ValidatedSourcesUpdate {
  sourceId: string;
  expectedVersion: number;
  patch: ManualPatch;
}

export function validateSourcesUpdatePayload(
  raw: unknown,
): SourcesPayloadValidation<ValidatedSourcesUpdate> {
  if (!isRecord(raw) || !checkKeys(raw, ['sourceId', 'expectedVersion', 'patch'])) return invalid();
  const sourceId = raw['sourceId'];
  if (typeof sourceId !== 'string' || !isUuidShape(sourceId)) return invalid();
  const expectedVersion = raw['expectedVersion'];
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return invalid();
  }
  const patch = raw['patch'];
  if (!isRecord(patch) || !checkKeys(patch, IPC_PATCH_KEYS)) return invalid();
  const validation = validateManualPatch(patch); // 域层同源校验（空 patch/长度/枚举）
  if (!validation.ok || validation.patch === null) return invalid();
  // 返回原始白名单 patch（而非 NormalizedPatch——规范化会补 assertedBy/verification
  // 等字段，回传 service 重新校验会被拒；service 按同一规则重校验，结果恒等）
  return valid({ sourceId, expectedVersion, patch: patch as unknown as ManualPatch });
}

export function validateSourcesIdVersionPayload(
  raw: unknown,
): SourcesPayloadValidation<{ sourceId: string; expectedVersion: number }> {
  if (!isRecord(raw) || !checkKeys(raw, ['sourceId', 'expectedVersion'])) return invalid();
  const sourceId = raw['sourceId'];
  if (typeof sourceId !== 'string' || !isUuidShape(sourceId)) return invalid();
  const expectedVersion = raw['expectedVersion'];
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    return invalid();
  }
  return valid({ sourceId, expectedVersion });
}

export function validateSourcesIdPayload(
  raw: unknown,
): SourcesPayloadValidation<{ sourceId: string }> {
  if (!isRecord(raw) || !checkKeys(raw, ['sourceId'])) return invalid();
  const sourceId = raw['sourceId'];
  if (typeof sourceId !== 'string' || !isUuidShape(sourceId)) return invalid();
  return valid({ sourceId });
}

const HARD_DELETE_TOKEN_PATTERN = /^[0-9a-f]{64}$/; // 256-bit hex（决议 #56 签发形态）

export function validateSourcesHardDeletePayload(
  raw: unknown,
): SourcesPayloadValidation<{ sourceId: string; token: string }> {
  if (!isRecord(raw) || !checkKeys(raw, ['sourceId', 'token'])) return invalid();
  const sourceId = raw['sourceId'];
  if (typeof sourceId !== 'string' || !isUuidShape(sourceId)) return invalid();
  const token = raw['token'];
  if (typeof token !== 'string' || !HARD_DELETE_TOKEN_PATTERN.test(token)) return invalid();
  return valid({ sourceId, token });
}

export function validateSourcesUndoPayload(
  raw: unknown,
): SourcesPayloadValidation<{ idempotencyKey: string }> {
  if (!isRecord(raw) || !checkKeys(raw, ['idempotencyKey'])) return invalid();
  const idempotencyKey = raw['idempotencyKey'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey === '') return invalid();
  return valid({ idempotencyKey });
}

// ---- 审计字段摘要（仅字段名 + 长度；值零出现） ----

function fieldLens(raw: Record, allowed: readonly string[]): { fields: string[]; lens: number[] } {
  const fields: string[] = [];
  const lens: number[] = [];
  for (const key of allowed) {
    const v = raw[key];
    if (v === undefined) continue;
    fields.push(key);
    if (typeof v === 'string') lens.push(v.length);
    else if (Array.isArray(v)) lens.push(v.length);
    else lens.push(1);
  }
  return { fields, lens };
}

// ---- 适配器 ----

export interface SourcesAdapterOptions {
  // 惰性解析：主进程 index.ts 的 handler 注册早于 SourceService 装配（createBrowserWindow
  // 内初始化），传入 getter 调用时解引用；单测可直接传实例（同一选项类型）。
  service: SourceService | null | (() => SourceService | null);
  audit: (message: string) => void; // 装配注入（index.ts → logInfo('audit', …)）
  onChanged: () => void; // 仅成功变更后触发（index.ts 转发主窗口 sources:changed）
  stateOverride?: () => SourcesState | null; // SMOKE_MODE 专属（生产不传）
}

export interface SourcesAdapter {
  list(payload: unknown): Promise<SourceListResult>;
  get(payload: unknown): Promise<SourceResult>;
  search(payload: unknown): Promise<SourceSearchResult>;
  groups(payload: unknown): Promise<SourceGroupsResult>;
  add(payload: unknown): Promise<ManualWriteResult>;
  update(payload: unknown): Promise<ManualWriteResult>;
  disable(payload: unknown): Promise<ManualWriteResult>;
  restore(payload: unknown): Promise<ManualWriteResult>;
  undo(payload: unknown): Promise<UndoResult>;
  undoable(): Promise<UndoableChange[]>;
  state(): SourcesState;
  prepareHardDelete(payload: unknown): Promise<PrepareHardDeleteResult>;
  hardDelete(payload: unknown): Promise<ManualWriteResult>;
  quickAdd(activeTab: { url: string } | null): Promise<QuickAddResult>;
}

export function createSourcesAdapter(options: SourcesAdapterOptions): SourcesAdapter {
  const currentService = (): SourceService | null =>
    typeof options.service === 'function' ? options.service() : options.service;

  // 状态门控（决议 #74 + 决议 #39）：normal 以外读写入口一并拒绝（结构化错误）；
  // override（冒烟注入）优先于 service 状态；service 为 null → unavailable。
  const effectiveState = (): SourcesState => {
    const override = options.stateOverride?.() ?? null;
    if (override !== null) return override;
    const svc = currentService();
    if (svc === null) {
      return { mode: 'unavailable', reason: '信源数据库初始化失败（详见日志）' };
    }
    const st = svc.getState();
    return { mode: st.mode, reason: st.reason };
  };
  const writable = (): boolean => effectiveState().mode === 'normal';

  const auditEntry = (
    op: string,
    sourceId: string | null,
    fields: string[],
    lens: number[],
    result: string,
  ): void => {
    options.audit(formatManualSourcesAudit({ op, sourceId, fields, lens, result }));
  };

  const unavailableList = (): SourceListResult => ({ ok: false, errorCode: 'source-unavailable' });
  const unavailableResult = (): SourceResult => ({ ok: false, errorCode: 'source-unavailable' });
  const unavailableSearch = (): SourceSearchResult => ({
    ok: false,
    errorCode: 'source-unavailable',
  });
  const unavailableGroups = (): SourceGroupsResult => ({
    ok: false,
    errorCode: 'source-unavailable',
  });
  const unavailableWrite = (): ManualWriteResult => ({
    ok: false,
    errorCode: 'source-unavailable',
  });

  const adapter: SourcesAdapter = {
    // —— 读（audience 硬编码 'user'，决议 #58/#69） ——
    async list(payload) {
      if (!writable()) return unavailableList();
      const v = validateSourcesListPayload(payload);
      if (!v.ok) return { ok: false, errorCode: v.errorCode };
      const svc = currentService();
      if (svc === null) return unavailableList();
      return svc.list({
        page: v.value.page,
        pageSize: v.value.pageSize,
        groupId: v.value.groupId,
        enabledOnly: v.value.enabledOnly,
        audience: 'user',
      });
    },
    async get(payload) {
      if (!writable()) return unavailableResult();
      const v = validateSourcesGetPayload(payload);
      if (!v.ok) return { ok: false, errorCode: v.errorCode };
      const svc = currentService();
      if (svc === null) return unavailableResult();
      return svc.get(v.value.sourceId, 'user');
    },
    async search(payload) {
      if (!writable()) return unavailableSearch();
      const v = validateSourcesSearchPayload(payload);
      if (!v.ok) return { ok: false, errorCode: v.errorCode };
      const svc = currentService();
      if (svc === null) return unavailableSearch();
      return svc.search(v.value.query, { limit: v.value.limit, audience: 'user' });
    },
    async groups(payload) {
      if (!writable()) return unavailableGroups();
      const v = validateSourcesGroupsPayload(payload);
      if (!v.ok) return { ok: false, errorCode: v.errorCode };
      const svc = currentService();
      if (svc === null) return unavailableGroups();
      return svc.listGroups({ page: v.value.page, pageSize: v.value.pageSize });
    },
    async undoable() {
      const svc = currentService();
      if (!writable() || svc === null) return [];
      return svc.listUndoable();
    },
    state() {
      return effectiveState();
    },

    // —— 写（每次尝试恰好一条脱敏审计；成功 → onChanged 恰好一次） ——
    async add(payload) {
      const v = validateSourcesAddPayload(payload);
      if (!v.ok) {
        const { fields, lens } = isRecord(payload)
          ? fieldLens(payload, IPC_ADD_KEYS)
          : { fields: [], lens: [] };
        auditEntry('add', null, fields, lens, v.errorCode);
        return { ok: false, errorCode: v.errorCode };
      }
      if (!writable()) {
        auditEntry('add', null, [], [], 'source-unavailable');
        return unavailableWrite();
      }
      const svc = currentService();
      if (svc === null) {
        auditEntry('add', null, [], [], 'source-unavailable');
        return unavailableWrite();
      }
      const res = await svc.addManual(v.value);
      const { fields, lens } = fieldLens(payload as Record, IPC_ADD_KEYS);
      auditEntry('add', res.ok ? res.source.id : null, fields, lens, res.ok ? 'ok' : res.errorCode);
      if (res.ok) options.onChanged();
      return res;
    },

    async update(payload) {
      const v = validateSourcesUpdatePayload(payload);
      if (!v.ok) {
        const rawPatch =
          isRecord(payload) && isRecord((payload as Record)['patch'])
            ? ((payload as Record)['patch'] as Record)
            : {};
        const { fields, lens } = fieldLens(rawPatch, IPC_PATCH_KEYS);
        auditEntry('update', null, fields, lens, v.errorCode);
        return { ok: false, errorCode: v.errorCode };
      }
      const svc = currentService();
      if (!writable() || svc === null) {
        auditEntry('update', v.value.sourceId, [], [], 'source-unavailable');
        return unavailableWrite();
      }
      const res = await svc.updateManual(v.value.sourceId, v.value.patch, v.value.expectedVersion);
      const { fields, lens } = fieldLens(
        ((payload as Record)['patch'] as Record) ?? {},
        IPC_PATCH_KEYS,
      );
      auditEntry('update', v.value.sourceId, fields, lens, res.ok ? 'ok' : res.errorCode);
      if (res.ok) options.onChanged();
      return res;
    },

    async disable(payload) {
      const v = validateSourcesIdVersionPayload(payload);
      if (!v.ok) {
        auditEntry('disable', null, [], [], v.errorCode);
        return { ok: false, errorCode: v.errorCode };
      }
      const svc = currentService();
      if (!writable() || svc === null) {
        auditEntry('disable', v.value.sourceId, [], [], 'source-unavailable');
        return unavailableWrite();
      }
      const res = await svc.disableManual(v.value.sourceId, v.value.expectedVersion);
      auditEntry('disable', v.value.sourceId, [], [], res.ok ? 'ok' : res.errorCode);
      if (res.ok) options.onChanged();
      return res;
    },

    async restore(payload) {
      const v = validateSourcesIdVersionPayload(payload);
      if (!v.ok) {
        auditEntry('restore', null, [], [], v.errorCode);
        return { ok: false, errorCode: v.errorCode };
      }
      const svc = currentService();
      if (!writable() || svc === null) {
        auditEntry('restore', v.value.sourceId, [], [], 'source-unavailable');
        return unavailableWrite();
      }
      const res = await svc.restoreManual(v.value.sourceId, v.value.expectedVersion);
      auditEntry('restore', v.value.sourceId, [], [], res.ok ? 'ok' : res.errorCode);
      if (res.ok) options.onChanged();
      return res;
    },

    async undo(payload) {
      const v = validateSourcesUndoPayload(payload);
      if (!v.ok) {
        // 载荷形状非法 → undo-not-found（共享 UndoResult 错误码闭合集；未知/空 key
        // 语义与消费后重放一致——安全无操作，不伪造其他错误形态）
        auditEntry('undo', null, [], [], 'source-undo-not-found');
        return { ok: false, errorCode: 'source-undo-not-found' };
      }
      const svc = currentService();
      if (!writable() || svc === null) {
        auditEntry('undo', null, [], [], 'source-unavailable');
        return { ok: false, errorCode: 'source-unavailable' };
      }
      const res = await svc.undoChange(v.value.idempotencyKey);
      auditEntry('undo', null, [], [], res.ok ? 'ok' : res.errorCode);
      if (res.ok) options.onChanged();
      return res;
    },

    // —— 两阶段永久删除（决议 #73）：prepare 为只读签发（不审计、零写入、零 changed）；
    // hard-delete 消费令牌（未签发/错绑定/过期/重放 → source-conflict 零删除） ——
    async prepareHardDelete(payload) {
      if (!writable()) return { ok: false, errorCode: 'source-unavailable' };
      const v = validateSourcesIdPayload(payload);
      if (!v.ok) return { ok: false, errorCode: v.errorCode };
      const svc = currentService();
      if (svc === null) return { ok: false, errorCode: 'source-unavailable' };
      const existing = await svc.get(v.value.sourceId, 'user');
      if (!existing.ok) return { ok: false, errorCode: existing.errorCode };
      return { ok: true, token: svc.issueDeleteConfirmToken(v.value.sourceId) };
    },

    async hardDelete(payload) {
      const v = validateSourcesHardDeletePayload(payload);
      if (!v.ok) {
        auditEntry('hard-delete', null, [], [], v.errorCode);
        return { ok: false, errorCode: v.errorCode };
      }
      const svc = currentService();
      if (!writable() || svc === null) {
        auditEntry('hard-delete', v.value.sourceId, [], [], 'source-unavailable');
        return unavailableWrite();
      }
      const res = await svc.hardDeleteManual(v.value.sourceId, v.value.token);
      // token 绝不进入审计/日志（决议 #73/#76）
      auditEntry('hard-delete', v.value.sourceId, [], [], res.ok ? 'ok' : res.errorCode);
      if (res.ok) options.onChanged();
      return res;
    },

    // —— 快速添加（决议 #72）：main 在点击时读取活动 Tab；renderer 不提供 URL/标题 ——
    async quickAdd(activeTab) {
      if (!writable()) {
        auditEntry('quick-add', null, [], [], 'source-unavailable');
        return { status: 'error', errorCode: 'source-unavailable' };
      }
      if (activeTab === null) {
        auditEntry('quick-add', null, [], [], 'no-active-page');
        return { status: 'no-active-page' };
      }
      const svc = currentService();
      if (svc === null) {
        auditEntry('quick-add', null, [], [], 'source-unavailable');
        return { status: 'error', errorCode: 'source-unavailable' };
      }
      const res = await svc.quickAddPage(activeTab.url);
      const sourceId =
        res.status === 'added'
          ? res.source.id
          : res.status === 'duplicate'
            ? res.existing.id
            : null;
      auditEntry(
        'quick-add',
        sourceId,
        ['url'],
        [activeTab.url.length], // 仅长度（URL 值零出现，决议 #76）
        res.status === 'added'
          ? 'ok'
          : res.status === 'duplicate'
            ? 'source-duplicate'
            : res.status === 'error'
              ? res.errorCode
              : res.status,
      );
      if (res.status === 'added') options.onChanged();
      return res;
    },
  };

  return adapter;
}
