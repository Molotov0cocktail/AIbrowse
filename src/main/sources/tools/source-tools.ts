// Fourth Stage B4: Source Tools v1（detailed-design §9 + 决议 #64–#67）。
// - 四工具 wire-safe 名：source_search/source_list/source_get（L0）+ source_apply_changes
//   （L2）；executor 只经 ctx.sourceService（注入点，类比 ctx.searchProvider）执行，
//   零 Electron import、零网络能力；缺省回退注册注入；两者皆缺 → source-unavailable。
// - audience 硬编码 'agent'（决议 #58）：模型工具参数中不得出现 audience。
// - 序列化层 allowlist（§8.1）：source_get 的 agent 视角返回 expectedVersion 并发令牌
//   （决议 #65）；search/list 恒不返回任何版本字段；note 仅 full + 摘录 ≤200（服务层
//   已截断）；blocked 视同不存在（服务层过滤）。
// - source_apply_changes：confirmSummary 钩子（决议 #66）在确认前调用
//   previewChangeSet（只读 diff ≤2000）；批准后 applyChangeSet 重新校验版本（TOCTOU）。
import type { ToolResult, ToolResultErrorCode } from '../../../shared/types/agent';
import type {
  SourceChangeOp,
  SourceErrorCode,
  SourceListItem,
  SourceListResult,
  SourcePreviewResult,
  SourceReadAudience,
  SourceResult,
  SourceSearchItem,
  SourceSearchResult,
  SourceService,
  SourceTrust,
  SourceView,
} from '../../../shared/types/sources';
import { isUuidShape } from '../domain/source-change-set';
import type { ToolDefinition, ToolExecutorFn } from '../../ai/tools/tool-types';

// 决议 #58：四工具一律 agent 视角（主进程适配器硬编码；模型参数无 audience 通道）
const AUDIENCE: SourceReadAudience = 'agent';

// B6（决议 #83）：description 校准——说明 search/list→get→apply 的正确引用链路与
// 自然语言管理语义（「不再优先」= 降低 priority，不等同 disable；仅明确禁用/恢复
// 意图才用对应 op）。description 只描述能力与用法，不描述或改变权限（权限由
// decide 确定性纯函数判定，AGENT_SYSTEM_PROMPT 不变）。
export const SOURCE_TOOL_DESCRIPTIONS = {
  search:
    '搜索用户长期维护的信源库（本地检索，最多返回 10 条）。支持按名称/网址/标签/分组/备注关键词检索；' +
    '返回条目含 ID（供 source_get/source_apply_changes 引用的唯一标识）与规范键/作用域；' +
    '不含版本号，备注仅在分享模式允许时出现。搜索命中不会自动打开或修改信源——' +
    '打开网页用 browser_open，修改需先 source_get 取得 expectedVersion 再 source_apply_changes。',
  list: '分页列出信源库条目（每页最多 20 条）。条目含 ID 与分组 ID（按组过滤用）；不含备注正文与版本号。',
  get:
    '按 ID 查看单个信源详情（ID 来自 source_search/source_list 条目）。' +
    '返回 expectedVersion（提交 update/disable/restore 时需携带的并发版本号）；' +
    '无权限或受限条目视为不存在。',
  applyChanges:
    '批量变更信源（新增/修改/禁用/恢复，最多 20 项，需用户确认后单事务生效）。' +
    '正确链路：先 source_search/source_list 取得条目 ID，必要时 source_get 取得 expectedVersion，再提交本工具。' +
    'update/disable/restore 必须携带 expectedVersion。自然语言意图映射：' +
    '「以后不再优先用某站」= 降低 priority（1–5，仅在检索排序同档内起作用），不是禁用；' +
    '只有明确要求禁用/停止使用某信源时才用 disable op，明确要求恢复使用时才用 restore op。' +
    '「标成官方」会把信任值设为 official，但来源仍标记为 AI 推断·未核验。' +
    '不能把分享模式设为 blocked，信任断言只能由 AI 提出（恒未核验）。',
} as const;

export const SOURCE_TOOL_NAMES = [
  'source_search',
  'source_list',
  'source_get',
  'source_apply_changes',
] as const;

// SourceErrorCode → ToolResultErrorCode（8 码恒等映射；undo-* 等不经工具路径 → 防御归一）
export function mapSourceError(code: SourceErrorCode): ToolResultErrorCode {
  switch (code) {
    case 'source-invalid-change':
    case 'source-version-conflict':
    case 'source-duplicate':
    case 'source-not-found':
    case 'source-forbidden':
    case 'source-limit':
    case 'source-unavailable':
    case 'source-conflict':
      return code;
    default:
      return 'source-unavailable';
  }
}

function sourceFailure(id: string, errorCode: ToolResultErrorCode, content: string): ToolResult {
  return { toolCallId: id, ok: false, content, errorCode };
}

// --- 序列化（§8.1 allowlist 纯文本，确定性；模型/网页无富文本特权） ---

function trustLabel(trust: SourceTrust): string {
  const provenance = trust.assertedBy === 'user' ? '用户标定' : 'AI 推断·未核验';
  return `${trust.value}（${provenance}）`;
}

function stateLabel(enabled: boolean): string {
  return enabled ? '启用' : '已禁用';
}

function shareModeLabel(mode: string): string {
  switch (mode) {
    case 'full':
      return 'full（备注可返回）';
    case 'metadata':
      return 'metadata（仅元数据）';
    case 'blocked':
      return 'blocked（对 AI 隐藏）';
    default:
      return mode;
  }
}

function lastUsedLabel(lastUsedAt: string | null): string | null {
  return lastUsedAt === null ? null : `上次使用：${lastUsedAt}`;
}

function appendListItem(lines: string[], item: SourceListItem | SourceSearchItem): void {
  // B6（决议 #80）：§8.1 allowlist 的引用链路字段——ID 是模型引用条目的唯一标识
  // （source_get/update/disable/restore 的 sourceId 来源）；规范键为规范化身份
  // （fragment/默认端口等变体同身份）；groupId 供 source_list 按组过滤。
  lines.push(`   ID：${item.id}`);
  lines.push(`   网址：${item.url}`);
  lines.push(`   规范键：${item.canonicalKey}`);
  lines.push(`   作用域：${item.scope === 'origin' ? '整个站点' : '具体页面'}`);
  if (item.groupName !== null) lines.push(`   分组：${item.groupName}`);
  if (item.groupId !== null) lines.push(`   分组 ID：${item.groupId}`);
  if (item.tags.length > 0) lines.push(`   标签：${item.tags.join('，')}`);
  lines.push(`   优先级：${item.priority}`);
  lines.push(`   状态：${stateLabel(item.enabled)}`);
  lines.push(`   分享模式：${shareModeLabel(item.shareMode)}`);
  lines.push(`   信任：${trustLabel(item.trust)}`);
  const used = lastUsedLabel(item.lastUsedAt);
  if (used !== null) lines.push(`   ${used}`);
  const note = (item as SourceSearchItem).note;
  if (note !== null && note !== undefined) {
    // 决议 #59：仅 agent + full 命中携带；provenance 由字段分离承载（§8.2）
    if (note.userNote !== null) lines.push(`   用户备注（来源：user）：${note.userNote}`);
    if (note.aiNote !== null) lines.push(`   AI 备注（来源：ai，未核验）：${note.aiNote}`);
  }
}

function appendSourceView(lines: string[], source: SourceView): void {
  // B6（决议 #80）：get 同样补齐 allowlist 引用链路字段（ID/规范键/分组 ID）
  lines.push(`ID：${source.id}`);
  lines.push(`名称：${source.name}`);
  lines.push(`网址：${source.url}`);
  lines.push(`规范键：${source.canonicalKey}`);
  lines.push(`作用域：${source.scope === 'origin' ? '整个站点' : '具体页面'}`);
  if (source.groupName !== null) lines.push(`分组：${source.groupName}`);
  if (source.groupId !== null) lines.push(`分组 ID：${source.groupId}`);
  if (source.tags.length > 0) lines.push(`标签：${source.tags.join('，')}`);
  lines.push(`优先级：${source.priority}`);
  lines.push(`状态：${stateLabel(source.enabled)}`);
  lines.push(`分享模式：${shareModeLabel(source.shareMode)}`);
  lines.push(`信任：${trustLabel(source.trust)}`);
  const used = lastUsedLabel(source.lastUsedAt);
  if (used !== null) lines.push(used);
  // metadata：服务层已清空两字段（零 note 字节）；空串不输出（§8.2）
  if (source.userNote !== '') lines.push(`用户备注（来源：user）：${source.userNote}`);
  if (source.aiNote !== '') lines.push(`AI 备注（来源：ai，未核验）：${source.aiNote}`);
  // 决议 #65：expectedVersion 并发令牌——仅 source_get 返回；version 字段名不回显
  lines.push(`expectedVersion：${source.version}`);
}

export function formatSourceSearchResults(
  result: Extract<SourceSearchResult, { ok: true }>,
): string {
  const items = result.results;
  if (items.length === 0) return '共 0 条信源（未找到匹配）';
  const lines = [`共 ${items.length} 条信源：`];
  items.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.name}`);
    appendListItem(lines, item);
  });
  return lines.join('\n');
}

export function formatSourceListItems(result: Extract<SourceListResult, { ok: true }>): string {
  const { page, pageSize, total, items } = result;
  if (items.length === 0) return `共 ${total} 条信源（第 ${page + 1} 页无条目）`;
  const lines = [`共 ${total} 条信源（第 ${page + 1} 页，每页 ${pageSize} 条）：`];
  items.forEach((item, i) => {
    lines.push(`${i + 1}. ${item.name}`);
    appendListItem(lines, item);
  });
  return lines.join('\n');
}

export function formatSourceDetail(result: Extract<SourceResult, { ok: true }>): string {
  const lines: string[] = ['信源详情：'];
  appendSourceView(lines, result.source);
  return lines.join('\n');
}

// --- 四工具定义（schema/description/paramRules 为程序常量） ---

const TRUST_VALUES = ['official', 'primary', 'secondary', 'community', 'unknown'];
const OPS_ITEM_SCHEMA = {
  type: 'object' as const,
  required: ['kind'],
  properties: {
    kind: {
      type: 'string' as const,
      enum: ['add', 'update', 'disable', 'restore'],
      description: '操作类型',
    },
    scope: {
      type: 'string' as const,
      enum: ['origin', 'page'],
      description: 'add：作用域（origin=整个站点/page=具体页面）',
    },
    url: { type: 'string' as const, description: 'add：网址（http/https）' },
    name: { type: 'string' as const, description: '名称（缺省由系统按网址生成，≤200 字符）' },
    groupName: { type: 'string' as const, description: '分组名（按名幂等复用，≤64 字符）' },
    tags: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: '标签（≤20 个，每个 ≤32 字符）',
    },
    priority: {
      type: 'number' as const,
      description: '优先级 1–5 整数（缺省 3；仅在检索排序同档内起作用）',
    },
    shareMode: {
      type: 'string' as const,
      enum: ['full', 'metadata', 'blocked'],
      description: '分享模式（full/metadata；AI 不得设置 blocked——仅用户界面可设）',
    },
    userNote: { type: 'string' as const, description: '用户备注（≤2000 字符）' },
    aiNote: { type: 'string' as const, description: 'AI 备注（≤2000 字符）' },
    trust: {
      type: 'object' as const,
      required: ['value'],
      properties: {
        value: {
          type: 'string' as const,
          enum: TRUST_VALUES,
          description: '信任类型（official/primary/secondary/community/unknown）',
        },
        assertedBy: {
          type: 'string' as const,
          enum: ['user', 'ai'],
          description: '断言来源（AI 通道只能为 ai——模型断言恒未核验）',
        },
      },
    },
    sourceId: {
      type: 'string' as const,
      description: 'update/disable/restore：目标信源 ID（UUID）',
    },
    expectedVersion: {
      type: 'number' as const,
      description: 'update/disable/restore：source_get 返回的并发版本号（正整数）',
    },
    patch: {
      type: 'object' as const,
      required: [],
      properties: {
        name: { type: 'string' as const },
        url: { type: 'string' as const, description: '变更网址（重新规范化，唯一约束）' },
        groupName: { type: 'string' as const, description: '分组名（null/缺省不移出分组）' },
        tags: { type: 'array' as const, items: { type: 'string' as const } },
        priority: { type: 'number' as const },
        shareMode: {
          type: 'string' as const,
          enum: ['full', 'metadata', 'blocked'],
          description: 'AI 不得设置 blocked',
        },
        userNote: { type: 'string' as const },
        aiNote: { type: 'string' as const },
        trust: {
          type: 'object' as const,
          required: ['value'],
          properties: {
            value: { type: 'string' as const, enum: TRUST_VALUES },
            assertedBy: { type: 'string' as const, enum: ['user', 'ai'] },
          },
        },
      },
    },
  },
};

// 装配工厂：sourceService 为注册注入（生产装配传 index.ts 组装的唯一实例）；
// executor 执行时 ctx.sourceService 优先（冒烟临时库/A5 AgentLoop 注入点）。
export function createSourceTools(sourceService: SourceService | null): ToolDefinition[] {
  const serviceOf = (ctx: { sourceService?: SourceService }): SourceService | null =>
    ctx.sourceService ?? sourceService;

  const searchExecutor: ToolExecutorFn = async ({ id, args }, ctx) => {
    const service = serviceOf(ctx);
    if (service === null) {
      return sourceFailure(id, 'source-unavailable', '信源服务不可用（未初始化）');
    }
    const res = await service.search(String(args.query), { audience: AUDIENCE });
    if (!res.ok) {
      return sourceFailure(id, mapSourceError(res.errorCode), `搜索信源失败：${res.errorCode}`);
    }
    // B6（决议 #79）：usage 关联只经结构化命中登记（id/scope/canonicalKey）——
    // 禁止解析 ToolResult 文本建立关联；失败/空结果零登记（登记在 ok 之后）。
    ctx.sourceUsage?.recordSearchHits(
      res.results.map((r) => ({ sourceId: r.id, scope: r.scope, canonicalKey: r.canonicalKey })),
    );
    return { toolCallId: id, ok: true, content: formatSourceSearchResults(res) };
  };

  const listExecutor: ToolExecutorFn = async ({ id, args }, ctx) => {
    const service = serviceOf(ctx);
    if (service === null) {
      return sourceFailure(id, 'source-unavailable', '信源服务不可用（未初始化）');
    }
    const res = await service.list({
      page: Number(args.page),
      pageSize: args.pageSize === undefined ? undefined : Number(args.pageSize),
      groupId: typeof args.groupId === 'string' ? args.groupId : null,
      enabledOnly: typeof args.enabledOnly === 'boolean' ? args.enabledOnly : undefined,
      audience: AUDIENCE,
    });
    if (!res.ok) {
      return sourceFailure(id, mapSourceError(res.errorCode), `列出信源失败：${res.errorCode}`);
    }
    return { toolCallId: id, ok: true, content: formatSourceListItems(res) };
  };

  const getExecutor: ToolExecutorFn = async ({ id, args }, ctx) => {
    const sourceId = String(args.sourceId);
    if (!isUuidShape(sourceId)) {
      return sourceFailure(id, 'invalid-args', 'sourceId 必须为 UUID 形状');
    }
    const service = serviceOf(ctx);
    if (service === null) {
      return sourceFailure(id, 'source-unavailable', '信源服务不可用（未初始化）');
    }
    const res = await service.get(sourceId, AUDIENCE);
    if (!res.ok) {
      return sourceFailure(id, mapSourceError(res.errorCode), `查看信源失败：${res.errorCode}`);
    }
    return { toolCallId: id, ok: true, content: formatSourceDetail(res) };
  };

  const applyExecutor: ToolExecutorFn = async ({ id, args }, ctx) => {
    const service = serviceOf(ctx);
    if (service === null) {
      return sourceFailure(id, 'source-unavailable', '信源服务不可用（未初始化）');
    }
    const res = await service.applyChangeSet(
      { ops: args['ops'] as SourceChangeOp[] }, // 校验层已保证结构形状
      { runId: ctx.runId, toolCallId: id },
    );
    if (!res.ok) {
      return sourceFailure(
        id,
        mapSourceError(res.errorCode ?? 'source-invalid-change'),
        `变更信源失败：${res.errorCode ?? 'source-invalid-change'}`,
      );
    }
    return {
      toolCallId: id,
      ok: true,
      content: `已应用 ${res.results.length} 项信源变更（已保存，可在信源界面撤销）`,
      // 决议 #67：主进程幂等键仅供审计出口读取（不进块/持久化/UI）
      idempotencyKey: res.idempotencyKey,
    };
  };

  // 决议 #66：程序化确认摘要钩子——ToolExecutor 在 requestConfirm 前调用；只读
  // previewChangeSet（零写入）生成 ≤2000 确定性 diff；预览失败（版本冲突/blocked
  // 猜测/结构拒绝）→ fail-closed 终止（不进入确认、零写入、审计恰好一条）。
  const applyConfirmSummary: NonNullable<ToolDefinition['confirmSummary']> = async (args, ctx) => {
    const service = serviceOf(ctx);
    if (service === null) {
      return {
        ok: false,
        errorCode: 'source-unavailable',
        content: '信源服务不可用，无法生成变更预览',
      };
    }
    const preview: SourcePreviewResult = await service.previewChangeSet({
      ops: args['ops'] as SourceChangeOp[],
    });
    if (!preview.ok) {
      return {
        ok: false,
        errorCode: mapSourceError(preview.errorCode),
        content: `变更预览失败：${preview.errorCode}`,
      };
    }
    return { ok: true, summary: { detail: preview.diffText } };
  };

  return [
    {
      name: 'source_search',
      description: SOURCE_TOOL_DESCRIPTIONS.search,
      parameters: {
        properties: {
          query: {
            type: 'string',
            description: '检索关键词（1–500 字符；支持名称/网址/标签/分组/备注）',
          },
        },
        required: ['query'],
      },
      paramRules: { query: { nonEmpty: true } }, // 长度上限走注册表字符串默认 500
      baseRisk: 0, // §9.2 矩阵：L0（有界 + 分享模式过滤为执行层保证）
      executor: searchExecutor,
    },
    {
      name: 'source_list',
      description: SOURCE_TOOL_DESCRIPTIONS.list,
      parameters: {
        properties: {
          page: { type: 'number', description: '页码（从 0 开始）' },
          pageSize: { type: 'number', description: '每页条数（1–20，缺省 20）' },
          groupId: { type: 'string', description: '按分组 ID 过滤（可选，条目中可取得）' },
          enabledOnly: { type: 'boolean', description: '仅列出启用条目（可选）' },
        },
        required: ['page'],
      },
      paramRules: { page: { integer: true, min: 0 }, pageSize: { integer: true, min: 1, max: 20 } },
      baseRisk: 0,
      executor: listExecutor,
    },
    {
      name: 'source_get',
      description: SOURCE_TOOL_DESCRIPTIONS.get,
      parameters: {
        properties: { sourceId: { type: 'string', description: '信源 ID（UUID）' } },
        required: ['sourceId'],
      },
      baseRisk: 0,
      executor: getExecutor,
    },
    {
      name: 'source_apply_changes',
      description: SOURCE_TOOL_DESCRIPTIONS.applyChanges,
      parameters: {
        properties: {
          ops: {
            type: 'array',
            maxItems: 20, // 决议 #64：数组上限 20（与 CHANGE_SET_MAX_OPS 同值）
            description: '变更操作列表（1–20 项；单事务生效，需用户确认）',
            items: OPS_ITEM_SCHEMA,
          },
        },
        required: ['ops'],
      },
      baseRisk: 2, // §9.2 矩阵：L2 无条件（任何 change set 都必须确认）
      executor: applyExecutor,
      confirmSummary: applyConfirmSummary,
    },
  ];
}
