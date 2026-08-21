// Fifth Stage C8: Research IPC adapter（决议 #156/#157/#162）——主进程侧的
// research:* 八通道业务层（index.ts 的 handle() 包装负责 sender+主帧校验；
// 本模块负责参数严格白名单 fail-closed、状态门控、每次写尝试恰好一条脱敏
// 审计、export-csv 经注入式窄端口调用 dialog + 写入）。零 Electron import
// （可用真实 node:sqlite + ResearchServiceImpl 单测）；零 Repository/SQL
// import（adapter 只能调用 ResearchService——依赖方向 §11）。
// export-csv（决议 #161）：renderer 只提供受限 view state（{sort,filter}），
// 主进程重新读取已持久化并验证的 Result 按同一 applyTableView 纯函数重投影
// ——禁止信任 renderer 传来的表格数据；默认文件名只用安全固定前缀 + taskId
// 短段（不使用 goal/Result title）；扩展名大小写不敏感精确 .csv；取消零写入
// + 恰好一条脱敏审计；审计只记 taskId/块索引/行列计数/结果码（路径/文件名/
// 标题/单元格/URL/Evidence 零出现——FT-16）。
import { logWarn } from '../logger';
import { isUuidShape } from '../sources/domain/source-change-set';
import { applyTableView, TABLE_FILTER_MAX_CHARS } from '../../shared/research/table-utils';
import { MAX_CSV_EXPORT_BYTES, serializeCsv } from '../../shared/csv/csv-serializer';
import type {
  ExportCsvResult,
  ResearchExportCsvView,
  ResearchIpcListValue,
  ResearchIpcResult,
  ResearchIpcTaskValue,
  ResearchResultView,
  ResearchService,
} from '../../shared/types/research';
import { MAX_GOAL_CHARS } from '../../shared/types/research';

// ---------- payload 严格白名单校验（纯函数；非法输入结构化安全返回，不抛异常） ----------

type Record = { [key: string]: unknown };

const isRecord = (v: unknown): v is Record =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkKeys(raw: Record, allowed: readonly string[]): boolean {
  return Object.keys(raw).every((k) => (allowed as readonly string[]).includes(k));
}

const invalid = (): { ok: false; errorCode: 'research-invalid-goal' } => ({
  ok: false,
  errorCode: 'research-invalid-goal',
});

// create：goal trim 非空且 ≤MAX_GOAL_CHARS（决议 #156(4)：超长拒绝而非截断——
// IPC 契约层；Service 的截断能力仅作非 IPC 调用的纵深防御）
export function validateResearchCreatePayload(
  raw: unknown,
): { ok: true; goal: string } | { ok: false; errorCode: 'research-invalid-goal' } {
  if (!isRecord(raw) || !checkKeys(raw, ['goal'])) return invalid();
  const goal = raw['goal'];
  if (typeof goal !== 'string' || goal.trim() === '') return invalid();
  if (goal.length > MAX_GOAL_CHARS) return invalid();
  return { ok: true, goal };
}

// 决议 #156(2)：taskId 通道严格 UUID 校验（非法/未知字段/NaN/Infinity/非对象拒绝）
export function validateResearchTaskIdPayload(
  raw: unknown,
): { ok: true; taskId: string } | { ok: false; errorCode: 'research-not-found' } {
  if (!isRecord(raw) || !checkKeys(raw, ['taskId'])) {
    return { ok: false, errorCode: 'research-not-found' };
  }
  const taskId = raw['taskId'];
  if (typeof taskId !== 'string' || !isUuidShape(taskId)) {
    return { ok: false, errorCode: 'research-not-found' };
  }
  return { ok: true, taskId };
}

// 决议 #156(3)：list 分页冻结 1-based——page ≥1、pageSize 1..20；IPC 层严格
// 拒绝非法值（不依赖 Service clamp 洗白）。决议 #164：payload 冻结为
// {page, pageSize}——status 不属 IPC 暴露面，作为未知字段 fail-closed 拒绝
// （主进程内部 ResearchService.listTasks 的 status 筛选能力保留）
export interface ValidatedResearchList {
  page: number;
  pageSize: number;
}

export function validateResearchListPayload(
  raw: unknown,
): { ok: true; value: ValidatedResearchList } | { ok: false; errorCode: 'research-invalid-goal' } {
  if (!isRecord(raw) || !checkKeys(raw, ['page', 'pageSize'])) return invalid();
  const page = raw['page'];
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return invalid();
  const pageSize = raw['pageSize'];
  if (pageSize !== undefined) {
    if (
      typeof pageSize !== 'number' ||
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 20
    ) {
      return invalid();
    }
  }
  return {
    ok: true,
    value: {
      page,
      pageSize: pageSize === undefined ? 20 : pageSize,
    },
  };
}

// 决议 #161(1)：export-csv payload 只允许 {taskId, tableBlockIndex, view}
// ——path/rows/content/文件名等任何字段零通道
export interface ValidatedResearchExportCsv {
  taskId: string;
  tableBlockIndex: number;
  view: ResearchExportCsvView;
}

export function validateResearchExportCsvPayload(
  raw: unknown,
):
  | { ok: true; value: ValidatedResearchExportCsv }
  | { ok: false; errorCode: 'research-invalid-goal' } {
  if (!isRecord(raw) || !checkKeys(raw, ['taskId', 'tableBlockIndex', 'view'])) return invalid();
  const taskId = raw['taskId'];
  if (typeof taskId !== 'string' || !isUuidShape(taskId)) return invalid();
  const tableBlockIndex = raw['tableBlockIndex'];
  if (
    typeof tableBlockIndex !== 'number' ||
    !Number.isInteger(tableBlockIndex) ||
    tableBlockIndex < 0
  ) {
    return invalid();
  }
  const view = raw['view'];
  if (!isRecord(view) || !checkKeys(view, ['sort', 'filter'])) return invalid();
  const filter = view['filter'];
  if (typeof filter !== 'string' || filter.length > TABLE_FILTER_MAX_CHARS) return invalid();
  const sort = view['sort'];
  if (sort !== null) {
    if (!isRecord(sort) || !checkKeys(sort, ['columnIndex', 'direction'])) return invalid();
    const columnIndex = sort['columnIndex'];
    if (typeof columnIndex !== 'number' || !Number.isInteger(columnIndex) || columnIndex < 0) {
      return invalid();
    }
    const direction = sort['direction'];
    if (direction !== 'asc' && direction !== 'desc') return invalid();
  }
  return {
    ok: true,
    value: {
      taskId,
      tableBlockIndex,
      view: { sort: sort === null ? null : (sort as ResearchExportCsvView['sort']), filter },
    },
  };
}

// ---------- 脱敏审计（决议 #162(8)：只记 taskId/块索引/行列计数/结果码） ----------

export interface ResearchAuditEntry {
  op: 'create' | 'start' | 'stop' | 'get' | 'result' | 'list' | 'delete' | 'export';
  taskId: string | null;
  goalLen: number | null; // create 专用（goal 正文零出现）
  tableBlockIndex: number | null; // export 专用
  rows: number | null; // export 专用（行列计数）
  columns: number | null;
  result: string; // 'ok' 或错误码（含 cancelled——取消同样恰好一条脱敏审计）
}

export function formatResearchAudit(entry: ResearchAuditEntry): string {
  const parts = [`op=${entry.op}`, `taskId=${entry.taskId ?? '-'}`];
  if (entry.goalLen !== null) parts.push(`goalLen=${entry.goalLen}`);
  if (entry.tableBlockIndex !== null) parts.push(`block=${entry.tableBlockIndex}`);
  if (entry.rows !== null) parts.push(`rows=${entry.rows}`);
  if (entry.columns !== null) parts.push(`cols=${entry.columns}`);
  parts.push(`result=${entry.result}`);
  return `research-ipc（${parts.join('，')}）`;
}

// ---------- 导出窄端口（决议 #162(1)：research-ipc 零 Electron import） ----------

export interface ResearchExportPort {
  // defaultFileName：安全固定前缀 + taskId 短段（决议 #162(4)：不使用 goal/
  // Result title——标题可能含不可信字符）；null = 用户取消（零写入）
  showSaveDialog(defaultFileName?: string): Promise<string | null>;
  writeCsv(path: string, bytes: Uint8Array): Promise<void>;
}

// ---------- 适配器 ----------

export interface ResearchIpcAdapterOptions {
  // 惰性解析：主进程 index.ts 的 handler 注册早于 ResearchService 装配，
  // 传入 getter 调用时解引用；单测可直接传实例
  service: ResearchService | null | (() => ResearchService | null);
  audit: (message: string) => void; // 装配注入（index.ts → logInfo('audit', …)）
  exportPort: ResearchExportPort; // 生产 = Electron dialog + fs；SMOKE = 注入桩
  defaultCsvName?: () => string; // 生产由 dialog 决定；SMOKE 注入固定名
}

export interface ResearchIpcAdapter {
  create(payload: unknown): Promise<ResearchIpcResult<ResearchIpcTaskValue>>;
  start(payload: unknown): Promise<ResearchIpcResult<ResearchIpcTaskValue>>;
  stop(payload: unknown): Promise<ResearchIpcResult<ResearchIpcTaskValue>>;
  get(payload: unknown): Promise<ResearchIpcResult<ResearchIpcTaskValue>>;
  result(payload: unknown): Promise<ResearchIpcResult<{ view: ResearchResultView }>>;
  list(payload: unknown): Promise<ResearchIpcResult<ResearchIpcListValue>>;
  delete(payload: unknown): Promise<ResearchIpcResult<{ deleted: true }>>;
  exportCsv(payload: unknown): Promise<ExportCsvResult>;
}

const EXTENSION_CSV = '.csv';

export function createResearchIpcAdapter(options: ResearchIpcAdapterOptions): ResearchIpcAdapter {
  const currentService = (): ResearchService | null =>
    typeof options.service === 'function' ? options.service() : options.service;

  const auditEntry = (entry: ResearchAuditEntry): void => {
    options.audit(formatResearchAudit(entry));
  };

  const unavailable = <T>(): ResearchIpcResult<T> => ({
    ok: false,
    errorCode: 'research-unavailable',
  });

  // 决议 #162(8)：service=null 时每次写尝试同样恰好一条脱敏审计（缺装配也
  // 是写尝试——只记 op/taskId/goalLen/block/result=research-unavailable，零
  // 敏感内容）；get/result/list 保持非写操作零审计。export 走既有安全映射
  // internal（ExportCsvErrorCode 闭合联合无 research-unavailable，决议 #162(7)）。
  const auditUnavailable = (
    op: ResearchAuditEntry['op'],
    entry: Partial<ResearchAuditEntry>,
  ): void => {
    auditEntry({
      op,
      taskId: null,
      goalLen: null,
      tableBlockIndex: null,
      rows: null,
      columns: null,
      result: 'research-unavailable',
      ...entry,
    });
  };

  const adapter: ResearchIpcAdapter = {
    async create(payload) {
      const v = validateResearchCreatePayload(payload);
      if (!v.ok) {
        auditEntry({
          op: 'create',
          taskId: null,
          goalLen: null,
          tableBlockIndex: null,
          rows: null,
          columns: null,
          result: v.errorCode,
        });
        return { ok: false, errorCode: v.errorCode };
      }
      const svc = currentService();
      if (svc === null) {
        auditUnavailable('create', { goalLen: v.goal.length });
        return unavailable();
      }
      const res = await svc.createTask(v.goal);
      auditEntry({
        op: 'create',
        taskId: res.ok ? res.task.id : null,
        goalLen: v.goal.length, // 仅长度（goal 正文零出现，决议 #162(8)）
        tableBlockIndex: null,
        rows: null,
        columns: null,
        result: res.ok ? 'ok' : res.errorCode,
      });
      return res.ok
        ? { ok: true, value: { task: res.task } }
        : { ok: false, errorCode: res.errorCode };
    },

    async start(payload) {
      const v = validateResearchTaskIdPayload(payload);
      if (!v.ok) {
        auditEntry({
          op: 'start',
          taskId: null,
          goalLen: null,
          tableBlockIndex: null,
          rows: null,
          columns: null,
          result: v.errorCode,
        });
        return { ok: false, errorCode: v.errorCode };
      }
      const svc = currentService();
      if (svc === null) {
        auditUnavailable('start', { taskId: v.taskId });
        return unavailable();
      }
      const res = await svc.startTask(v.taskId);
      auditEntry({
        op: 'start',
        taskId: v.taskId,
        goalLen: null,
        tableBlockIndex: null,
        rows: null,
        columns: null,
        result: res.ok ? 'ok' : res.errorCode,
      });
      return res.ok
        ? { ok: true, value: { task: res.task } }
        : { ok: false, errorCode: res.errorCode };
    },

    async stop(payload) {
      const v = validateResearchTaskIdPayload(payload);
      if (!v.ok) {
        auditEntry({
          op: 'stop',
          taskId: null,
          goalLen: null,
          tableBlockIndex: null,
          rows: null,
          columns: null,
          result: v.errorCode,
        });
        return { ok: false, errorCode: v.errorCode };
      }
      const svc = currentService();
      if (svc === null) {
        auditUnavailable('stop', { taskId: v.taskId });
        return unavailable();
      }
      const res = await svc.stopTask(v.taskId);
      auditEntry({
        op: 'stop',
        taskId: v.taskId,
        goalLen: null,
        tableBlockIndex: null,
        rows: null,
        columns: null,
        result: res.ok ? 'ok' : res.errorCode,
      });
      return res.ok
        ? { ok: true, value: { task: res.task } }
        : { ok: false, errorCode: res.errorCode };
    },

    async get(payload) {
      const v = validateResearchTaskIdPayload(payload);
      if (!v.ok) return { ok: false, errorCode: v.errorCode };
      const svc = currentService();
      if (svc === null) return unavailable();
      const res = await svc.getTask(v.taskId);
      return res.ok
        ? { ok: true, value: { task: res.task } }
        : { ok: false, errorCode: res.errorCode };
    },

    async result(payload) {
      const v = validateResearchTaskIdPayload(payload);
      if (!v.ok) return { ok: false, errorCode: v.errorCode };
      const svc = currentService();
      if (svc === null) return unavailable();
      const res = await svc.getResearchResultView(v.taskId);
      return res.ok
        ? { ok: true, value: { view: res.view } }
        : { ok: false, errorCode: res.errorCode };
    },

    async list(payload) {
      const v = validateResearchListPayload(payload);
      if (!v.ok) return { ok: false, errorCode: v.errorCode };
      const svc = currentService();
      if (svc === null) return unavailable();
      // 决议 #164：IPC 层只透传 page/pageSize（status 不属暴露面）
      const res = await svc.listTasks({
        page: v.value.page,
        pageSize: v.value.pageSize,
      });
      if (!res.ok) return { ok: false, errorCode: res.errorCode };
      return {
        ok: true,
        value: { page: res.page, pageSize: res.pageSize, total: res.total, items: res.items },
      };
    },

    async delete(payload) {
      const v = validateResearchTaskIdPayload(payload);
      if (!v.ok) {
        auditEntry({
          op: 'delete',
          taskId: null,
          goalLen: null,
          tableBlockIndex: null,
          rows: null,
          columns: null,
          result: v.errorCode,
        });
        return { ok: false, errorCode: v.errorCode };
      }
      const svc = currentService();
      if (svc === null) {
        auditUnavailable('delete', { taskId: v.taskId });
        return unavailable();
      }
      const res = await svc.deleteTask(v.taskId);
      auditEntry({
        op: 'delete',
        taskId: v.taskId,
        goalLen: null,
        tableBlockIndex: null,
        rows: null,
        columns: null,
        result: res.ok ? 'ok' : res.errorCode,
      });
      return res.ok
        ? { ok: true, value: { deleted: true } }
        : { ok: false, errorCode: res.errorCode };
    },

    // 决议 #161(3)/(4)：主进程重新读取已持久化并验证的 Result，按同一
    // applyTableView 纯函数重算（禁止信任 renderer 数据）；tableBlockIndex
    // 指 Result.blocks 的原始 0-based 索引（非整数/越界/非 table 块拒绝）
    async exportCsv(payload) {
      const v = validateResearchExportCsvPayload(payload);
      if (!v.ok) {
        auditEntry({
          op: 'export',
          taskId: null,
          goalLen: null,
          tableBlockIndex: null,
          rows: null,
          columns: null,
          result: 'invalid-payload',
        });
        return { ok: false, errorCode: 'invalid-payload' };
      }
      const svc = currentService();
      if (svc === null) {
        auditEntry({
          op: 'export',
          taskId: v.value.taskId,
          goalLen: null,
          tableBlockIndex: v.value.tableBlockIndex,
          rows: null,
          columns: null,
          result: 'internal', // 决议 #162(7)：导出面闭合错误联合的安全映射
        });
        return { ok: false, errorCode: 'internal' };
      }
      const viewResult = await svc.getResearchResultView(v.value.taskId);
      if (!viewResult.ok) {
        const mapped =
          viewResult.errorCode === 'research-not-found'
            ? 'not-found'
            : viewResult.errorCode === 'research-invalid-state'
              ? 'invalid-state'
              : 'internal';
        auditEntry({
          op: 'export',
          taskId: v.value.taskId,
          goalLen: null,
          tableBlockIndex: v.value.tableBlockIndex,
          rows: null,
          columns: null,
          result: mapped,
        });
        return { ok: false, errorCode: mapped };
      }
      const block = viewResult.view.result.blocks[v.value.tableBlockIndex];
      if (block === undefined || block.kind !== 'table') {
        auditEntry({
          op: 'export',
          taskId: v.value.taskId,
          goalLen: null,
          tableBlockIndex: v.value.tableBlockIndex,
          rows: null,
          columns: null,
          result: 'invalid-block',
        });
        return { ok: false, errorCode: 'invalid-block' };
      }
      // 决议 #161(3)：同一 applyTableView 纯函数重投影（UI 与导出一致性）
      const projected = applyTableView(block.columns, block.rows, v.value.view);
      const csv = serializeCsv(projected.columns, projected.rows);
      // 决议 #161(6)：MAX_CSV_EXPORT_BYTES 按 UTF-8 字节检查；超限零写入
      if (csv.utf8Bytes > MAX_CSV_EXPORT_BYTES) {
        auditEntry({
          op: 'export',
          taskId: v.value.taskId,
          goalLen: null,
          tableBlockIndex: v.value.tableBlockIndex,
          rows: null,
          columns: null,
          result: 'budget-exceeded',
        });
        return { ok: false, errorCode: 'budget-exceeded' };
      }
      // 决议 #162(4)/(5)：dialog 用户选定路径（默认文件名 = 安全固定前缀 +
      // taskId 短段——不使用 goal/Result title）；取消 → cancelled 零写入 +
      // 恰好一条审计
      let path: string | null;
      try {
        path = await options.exportPort.showSaveDialog(
          `research-${v.value.taskId.slice(0, 8)}.csv`,
        );
      } catch (err) {
        logWarn('research', '导出对话框异常（归一 write-failed）', err);
        auditEntry({
          op: 'export',
          taskId: v.value.taskId,
          goalLen: null,
          tableBlockIndex: v.value.tableBlockIndex,
          rows: null,
          columns: null,
          result: 'write-failed',
        });
        return { ok: false, errorCode: 'write-failed' };
      }
      if (path === null) {
        auditEntry({
          op: 'export',
          taskId: v.value.taskId,
          goalLen: null,
          tableBlockIndex: v.value.tableBlockIndex,
          rows: null,
          columns: null,
          result: 'cancelled',
        });
        return { ok: false, errorCode: 'cancelled' };
      }
      // 决议 #162(6)：扩展名大小写不敏感精确 .csv（.CSV 合法；.csvx/.txt/无扩展名拒绝）
      const lower = path.toLowerCase();
      if (!lower.endsWith(EXTENSION_CSV)) {
        auditEntry({
          op: 'export',
          taskId: v.value.taskId,
          goalLen: null,
          tableBlockIndex: v.value.tableBlockIndex,
          rows: null,
          columns: null,
          result: 'invalid-payload',
        });
        return { ok: false, errorCode: 'invalid-payload' };
      }
      // 决议 #162(7)：写入失败 → write-failed（固定错误；零文件残留由调用方处理）
      try {
        await options.exportPort.writeCsv(path, new TextEncoder().encode(csv.text));
      } catch (err) {
        logWarn('research', 'CSV 写入失败（归一 write-failed）', err);
        auditEntry({
          op: 'export',
          taskId: v.value.taskId,
          goalLen: null,
          tableBlockIndex: v.value.tableBlockIndex,
          rows: null,
          columns: null,
          result: 'write-failed',
        });
        return { ok: false, errorCode: 'write-failed' };
      }
      auditEntry({
        op: 'export',
        taskId: v.value.taskId,
        goalLen: null,
        tableBlockIndex: v.value.tableBlockIndex,
        rows: projected.rows.length,
        columns: projected.columns.length,
        result: 'ok',
      });
      return {
        ok: true,
        rows: projected.rows.length,
        columns: projected.columns.length,
        bytes: csv.utf8Bytes,
      };
    },
  };

  return adapter;
}
