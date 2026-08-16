// Fifth Stage C7: ResultValidator — implements ResearchResultValidationPort
// (adjudication #134 shape) with the strict rules of adjudications #149–#151
// and detailed-design §8.1: the model draft may only carry {title, summary,
// blocks}; every trusted field (resultId/taskId/evidenceMap/conflicts/
// coverage/fetchedAt) is assembled deterministically by this module. Unknown
// fields, wrong types, out-of-range values, illegal references and duplicate
// IDs reject the whole Result. Expected failures are never thrown — any input
// safely returns the closed discriminated union (pure, deterministic,
// input-preserving).
import {
  MAX_CARDS_BODY_CHARS,
  MAX_CARDS_ITEMS,
  MAX_CARDS_TITLE_CHARS,
  MAX_CONFLICT_POSITION_SOURCE_REFS,
  MAX_MARKDOWN_BLOCK_CHARS,
  MAX_RANKING_DETAIL_CHARS,
  MAX_RANKING_ITEMS,
  MAX_RANKING_TITLE_CHARS,
  MAX_RESEARCH_REASON_CHARS,
  MAX_RESULT_BLOCKS,
  MAX_RESULT_CHARS,
  MAX_RESULT_SUMMARY_CHARS,
  MAX_RESULT_TITLE_CHARS,
  MAX_RESULT_VALIDATION_REASONS,
  MAX_TABLE_CELL_CHARS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MAX_UNCERTAIN_TEXT_CHARS,
} from '../../shared/types/research';
import type {
  ResearchResult,
  ResearchResultValidationContext,
  ResearchResultValidationPort,
  ResultBlock,
} from '../../shared/types/research';
import { collectMarkdownLinkTargets } from '../../shared/markdown/parse-markdown';
import { isSafeMarkdownUrl } from '../../shared/markdown/markdown-url';
import { normalizeMarkdownText, normalizePlainText } from '../../shared/markdown/markdown-text';

// ---------- 失败收集（数量有界、顺序稳定、零敌对正文回显） ----------

class ValidationErrors {
  readonly reasons: string[] = [];

  add(path: string, reason: string): void {
    if (this.reasons.length >= MAX_RESULT_VALIDATION_REASONS) return;
    const text = `${path}${reason}`;
    this.reasons.push(
      text.length > MAX_RESEARCH_REASON_CHARS ? text.slice(0, MAX_RESEARCH_REASON_CHARS) : text,
    );
  }

  get full(): boolean {
    return this.reasons.length >= MAX_RESULT_VALIDATION_REASONS;
  }
}

// ---------- 形状工具 ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------- sourceRefs 校验（#150(5)：非空/去重/有界/∈候选集/有 Evidence 支撑） ----------

function checkSourceRefs(
  refs: unknown,
  path: string,
  ctx: ResearchResultValidationContext,
  errors: ValidationErrors,
): string[] | null {
  if (!Array.isArray(refs)) {
    errors.add(path, '：来源引用必须是数组');
    return null;
  }
  if (refs.length === 0) {
    errors.add(path, '：来源引用不得为空');
    return null;
  }
  if (refs.length > MAX_CONFLICT_POSITION_SOURCE_REFS) {
    errors.add(path, `：来源引用数量超过上限（${MAX_CONFLICT_POSITION_SOURCE_REFS}）`);
    return null;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    if (typeof ref !== 'string' || ref === '') {
      errors.add(`${path}[${i}]`, '：来源引用非法');
      return null;
    }
    if (seen.has(ref)) {
      errors.add(`${path}[${i}]`, '：来源引用重复');
      return null;
    }
    seen.add(ref);
    const candidate = ctx.candidates.find((c) => c.id === ref);
    if (candidate === undefined) {
      errors.add(`${path}[${i}]`, '：引用的候选不在本任务候选集内');
      return null;
    }
    const supported = ctx.evidence.some(
      (e) => e.candidateId === ref && e.verification === 'verified',
    );
    if (!supported) {
      errors.add(`${path}[${i}]`, '：引用的候选没有已验证证据支撑');
      return null;
    }
    out.push(ref);
  }
  return out;
}

// ---------- 逐块校验 ----------

function checkBlock(
  raw: unknown,
  index: number,
  ctx: ResearchResultValidationContext,
  errors: ValidationErrors,
): ResultBlock | null {
  if (!isRecord(raw)) {
    errors.add(`blocks[${index}]`, '：块必须是对象');
    return null;
  }
  const kind = raw['kind'];
  if (typeof kind !== 'string') {
    errors.add(`blocks[${index}]`, '：块缺少合法 kind');
    return null;
  }
  switch (kind) {
    case 'markdown': {
      if (Object.keys(raw).length !== 2 || typeof raw['text'] !== 'string') {
        errors.add(`blocks[${index}]`, '：markdown 块形状非法（仅允许 kind/text）');
        return null;
      }
      const text = normalizeMarkdownText(raw['text']);
      if (text === '') {
        errors.add(`blocks[${index}]`, '：markdown 文本为空');
        return null;
      }
      if (text.length > MAX_MARKDOWN_BLOCK_CHARS) {
        errors.add(`blocks[${index}]`, `：markdown 文本超过 ${MAX_MARKDOWN_BLOCK_CHARS} 字符`);
        return null;
      }
      // 决议 #150(4)：危险链接整份拒绝（FT-12）——扫描源文本全部链接形态
      // （AST 中危险链接已字面降级，必须直接扫描）；Renderer 侧另有纵深降级
      const targets = collectMarkdownLinkTargets(text);
      for (const url of targets) {
        if (!isSafeMarkdownUrl(url)) {
          errors.add(`blocks[${index}]`, '：含危险链接（仅允许绝对 http/https 且禁止用户信息）');
          return null;
        }
      }
      return { kind: 'markdown', text };
    }
    case 'uncertain': {
      if (
        Object.keys(raw).length !== 3 ||
        typeof raw['text'] !== 'string' ||
        typeof raw['reason'] !== 'string'
      ) {
        errors.add(`blocks[${index}]`, '：uncertain 块形状非法（仅允许 kind/text/reason）');
        return null;
      }
      const text = normalizePlainText(raw['text']);
      const reason = normalizePlainText(raw['reason']);
      if (text === '' || reason === '') {
        errors.add(`blocks[${index}]`, '：uncertain 块的 text 与 reason 必须非空');
        return null;
      }
      if (text.length > MAX_UNCERTAIN_TEXT_CHARS || reason.length > MAX_UNCERTAIN_TEXT_CHARS) {
        errors.add(`blocks[${index}]`, `：uncertain 字段超过 ${MAX_UNCERTAIN_TEXT_CHARS} 字符`);
        return null;
      }
      return { kind: 'uncertain', text, reason };
    }
    case 'table': {
      if (
        Object.keys(raw).length !== 4 ||
        !Array.isArray(raw['columns']) ||
        !Array.isArray(raw['rows']) ||
        !Array.isArray(raw['sourceRefs'])
      ) {
        errors.add(`blocks[${index}]`, '：table 块形状非法（仅允许 kind/columns/rows/sourceRefs）');
        return null;
      }
      const columnsRaw = raw['columns'] as unknown[];
      if (columnsRaw.length === 0 || columnsRaw.length > MAX_TABLE_COLUMNS) {
        errors.add(`blocks[${index}]`, `：列数超出 1..${MAX_TABLE_COLUMNS}`);
        return null;
      }
      const columns: string[] = [];
      for (let c = 0; c < columnsRaw.length; c += 1) {
        const cell = columnsRaw[c];
        if (typeof cell !== 'string') {
          errors.add(`blocks[${index}].columns[${c}]`, '：列名必须是字符串');
          return null;
        }
        const normalized = normalizePlainText(cell);
        if (normalized === '') {
          errors.add(`blocks[${index}].columns[${c}]`, '：列名不得为空');
          return null;
        }
        if (normalized.length > MAX_TABLE_CELL_CHARS) {
          errors.add(`blocks[${index}].columns[${c}]`, `：列名超过 ${MAX_TABLE_CELL_CHARS} 字符`);
          return null;
        }
        columns.push(normalized);
      }
      const rowsRaw = raw['rows'] as unknown[];
      if (rowsRaw.length === 0 || rowsRaw.length > MAX_TABLE_ROWS) {
        errors.add(`blocks[${index}]`, `：行数超出 1..${MAX_TABLE_ROWS}`);
        return null;
      }
      const rows: string[][] = [];
      for (let r = 0; r < rowsRaw.length; r += 1) {
        const row = rowsRaw[r];
        if (!Array.isArray(row)) {
          errors.add(`blocks[${index}].rows[${r}]`, '：行必须是数组');
          return null;
        }
        if (row.length !== columns.length) {
          errors.add(`blocks[${index}].rows[${r}]`, '：列数与 columns 不一致');
          return null;
        }
        const normalizedRow: string[] = [];
        for (let c = 0; c < row.length; c += 1) {
          const cell = row[c];
          if (typeof cell !== 'string') {
            errors.add(`blocks[${index}].rows[${r}][${c}]`, '：单元格必须是字符串');
            return null;
          }
          const normalized = normalizePlainText(cell);
          if (normalized.length > MAX_TABLE_CELL_CHARS) {
            errors.add(
              `blocks[${index}].rows[${r}][${c}]`,
              `：单元格超过 ${MAX_TABLE_CELL_CHARS} 字符`,
            );
            return null;
          }
          normalizedRow.push(normalized);
        }
        rows.push(normalizedRow);
      }
      const refs = checkSourceRefs(raw['sourceRefs'], `blocks[${index}].sourceRefs`, ctx, errors);
      if (refs === null) return null;
      return { kind: 'table', columns, rows, sourceRefs: refs };
    }
    case 'cards': {
      if (Object.keys(raw).length !== 2 || !Array.isArray(raw['items'])) {
        errors.add(`blocks[${index}]`, '：cards 块形状非法（仅允许 kind/items）');
        return null;
      }
      const itemsRaw = raw['items'] as unknown[];
      if (itemsRaw.length === 0 || itemsRaw.length > MAX_CARDS_ITEMS) {
        errors.add(`blocks[${index}]`, `：条目数超出 1..${MAX_CARDS_ITEMS}`);
        return null;
      }
      const items: Array<{
        title: string;
        subtitle: string | null;
        body: string;
        sourceRefs: string[];
      }> = [];
      for (let it = 0; it < itemsRaw.length; it += 1) {
        const item = itemsRaw[it];
        const base = `blocks[${index}].items[${it}]`;
        if (!isRecord(item) || Object.keys(item).length !== 4) {
          errors.add(base, '：cards 条目形状非法（仅允许 title/subtitle/body/sourceRefs）');
          return null;
        }
        if (typeof item['title'] !== 'string') {
          errors.add(`${base}.title`, '：必须是字符串');
          return null;
        }
        const title = normalizePlainText(item['title']);
        if (title === '' || title.length > MAX_CARDS_TITLE_CHARS) {
          errors.add(`${base}.title`, `：必须非空且不超过 ${MAX_CARDS_TITLE_CHARS} 字符`);
          return null;
        }
        let subtitle: string | null = null;
        if (item['subtitle'] !== null && item['subtitle'] !== undefined) {
          if (typeof item['subtitle'] !== 'string') {
            errors.add(`${base}.subtitle`, '：必须是字符串或 null');
            return null;
          }
          subtitle = normalizePlainText(item['subtitle']);
          if (subtitle.length > MAX_CARDS_TITLE_CHARS) {
            errors.add(`${base}.subtitle`, `：不超过 ${MAX_CARDS_TITLE_CHARS} 字符`);
            return null;
          }
        }
        if (typeof item['body'] !== 'string') {
          errors.add(`${base}.body`, '：必须是字符串');
          return null;
        }
        const body = normalizePlainText(item['body']);
        if (body === '' || body.length > MAX_CARDS_BODY_CHARS) {
          errors.add(`${base}.body`, `：必须非空且不超过 ${MAX_CARDS_BODY_CHARS} 字符`);
          return null;
        }
        const refs = checkSourceRefs(item['sourceRefs'], `${base}.sourceRefs`, ctx, errors);
        if (refs === null) return null;
        items.push({ title, subtitle, body, sourceRefs: refs });
      }
      return { kind: 'cards', items };
    }
    case 'ranking': {
      if (Object.keys(raw).length !== 2 || !Array.isArray(raw['items'])) {
        errors.add(`blocks[${index}]`, '：ranking 块形状非法（仅允许 kind/items）');
        return null;
      }
      const itemsRaw = raw['items'] as unknown[];
      if (itemsRaw.length === 0 || itemsRaw.length > MAX_RANKING_ITEMS) {
        errors.add(`blocks[${index}]`, `：条目数超出 1..${MAX_RANKING_ITEMS}`);
        return null;
      }
      const items: Array<{ rank: number; title: string; detail: string; sourceRefs: string[] }> =
        [];
      for (let it = 0; it < itemsRaw.length; it += 1) {
        const item = itemsRaw[it];
        const base = `blocks[${index}].items[${it}]`;
        if (!isRecord(item) || Object.keys(item).length !== 4) {
          errors.add(base, '：ranking 条目形状非法（仅允许 rank/title/detail/sourceRefs）');
          return null;
        }
        // 决议 #150(4)：rank 必须与数组顺序严格构成 1..N（rank[i] === i+1）
        if (item['rank'] !== it + 1 || typeof item['rank'] !== 'number') {
          errors.add(`${base}.rank`, `：必须严格等于 ${it + 1}（1..N 连续）`);
          return null;
        }
        if (typeof item['title'] !== 'string') {
          errors.add(`${base}.title`, '：必须是字符串');
          return null;
        }
        const title = normalizePlainText(item['title']);
        if (title === '' || title.length > MAX_RANKING_TITLE_CHARS) {
          errors.add(`${base}.title`, `：必须非空且不超过 ${MAX_RANKING_TITLE_CHARS} 字符`);
          return null;
        }
        if (typeof item['detail'] !== 'string') {
          errors.add(`${base}.detail`, '：必须是字符串');
          return null;
        }
        const detail = normalizePlainText(item['detail']);
        if (detail === '' || detail.length > MAX_RANKING_DETAIL_CHARS) {
          errors.add(`${base}.detail`, `：必须非空且不超过 ${MAX_RANKING_DETAIL_CHARS} 字符`);
          return null;
        }
        const refs = checkSourceRefs(item['sourceRefs'], `${base}.sourceRefs`, ctx, errors);
        if (refs === null) return null;
        items.push({ rank: it + 1, title, detail, sourceRefs: refs });
      }
      return { kind: 'ranking', items };
    }
    default:
      errors.add(`blocks[${index}]`, '：未知块类型');
      return null;
  }
}

// ---------- 程序投影（#151） ----------

function buildEvidenceMap(
  ctx: ResearchResultValidationContext,
): Record<string, { candidateId: string; url: string; title: string; accessTime: string }> {
  const map: Record<
    string,
    { candidateId: string; url: string; title: string; accessTime: string }
  > = {};
  const ids = ctx.evidence.map((e) => e.evidenceId).sort(); // 确定性：字符串升序
  for (const id of ids) {
    const e = ctx.evidence.find((ev) => ev.evidenceId === id)!;
    map[id] = { candidateId: e.candidateId, url: e.url, title: e.title, accessTime: e.accessTime };
  }
  return map;
}

function buildConflicts(ctx: ResearchResultValidationContext): Array<{
  conflictId: string;
  topic: string;
  positions: Array<{ positionText: string; sourceRefs: string[] }>;
}> {
  return ctx.conflicts.map((c) => ({
    conflictId: c.conflictId,
    topic: c.topic,
    positions: c.positions.map((p) => ({
      positionText: p.positionText,
      sourceRefs: [...p.sourceRefs],
    })),
  }));
}

function buildCoverage(ctx: ResearchResultValidationContext): ResearchResult['coverage'] {
  let multiSource = 0;
  let singleSource = 0;
  let vendor = 0;
  let thirdParty = 0;
  let community = 0;
  for (const claim of ctx.claims) {
    if (claim.coverage === 'multi-source') multiSource += 1;
    else if (claim.coverage === 'single-source') singleSource += 1;
    if (claim.sourceTypes.includes('vendor')) vendor += 1;
    if (claim.sourceTypes.includes('third-party')) thirdParty += 1;
    if (claim.sourceTypes.includes('community')) community += 1;
  }
  return {
    total: ctx.claims.length,
    multiSource,
    singleSource,
    vendor,
    thirdParty,
    community,
  };
}

function buildFetchedAt(ctx: ResearchResultValidationContext): string {
  // 决议 #149(2)：Evidence 最大 accessTime（ISO 同形态字典序 = 时间序）；
  // 无 Evidence → ctx.now（Runtime 注入可信时钟）
  let max: string | null = null;
  for (const e of ctx.evidence) {
    if (max === null || e.accessTime > max) max = e.accessTime;
  }
  return max ?? ctx.now;
}

// ---------- 强制 uncertainty 矩阵（#151(5)） ----------

function requiresUncertainty(ctx: ResearchResultValidationContext): boolean {
  if (ctx.evidence.length === 0) return true;
  if (ctx.claims.length === 0) return true;
  if (ctx.verificationState === 'unavailable') return true;
  if (ctx.conflicts.some((c) => c.resolved === 'unresolved')) return true;
  if (ctx.claims.some((c) => c.severity === 'high' && c.coverage === 'single-source')) return true;
  return false;
}

// ---------- 主入口（#150：不 throw 预期失败；纯函数确定性） ----------

function doValidate(
  draft: unknown,
  ctx: ResearchResultValidationContext,
): { ok: true; result: ResearchResult } | { ok: false; reasons: string[] } {
  const errors = new ValidationErrors();
  if (!isRecord(draft)) {
    errors.add('draft', '：结果草案必须是 JSON 对象');
    return { ok: false, reasons: errors.reasons };
  }
  // 决议 #149(1)：顶层严格三字段白名单——可信字段与未知字段整份拒绝
  const allowed = new Set(['title', 'summary', 'blocks']);
  const keys = Object.keys(draft);
  for (const key of keys) {
    if (!allowed.has(key)) {
      return {
        ok: false,
        reasons: ['draft：包含不允许的字段（模型草案仅允许 title/summary/blocks）'],
      };
    }
  }
  if (typeof draft['title'] !== 'string') {
    errors.add('title', '：必须是字符串');
    return { ok: false, reasons: errors.reasons };
  }
  const title = normalizePlainText(draft['title']);
  if (title === '' || title.length > MAX_RESULT_TITLE_CHARS) {
    errors.add('title', `：必须非空且不超过 ${MAX_RESULT_TITLE_CHARS} 字符`);
    return { ok: false, reasons: errors.reasons };
  }
  if (typeof draft['summary'] !== 'string') {
    errors.add('summary', '：必须是字符串');
    return { ok: false, reasons: errors.reasons };
  }
  const summary = normalizePlainText(draft['summary']);
  if (summary.length > MAX_RESULT_SUMMARY_CHARS) {
    errors.add('summary', `：不超过 ${MAX_RESULT_SUMMARY_CHARS} 字符`);
    return { ok: false, reasons: errors.reasons };
  }
  if (!Array.isArray(draft['blocks'])) {
    errors.add('blocks', '：必须是数组');
    return { ok: false, reasons: errors.reasons };
  }
  const blocksRaw = draft['blocks'] as unknown[];
  if (blocksRaw.length === 0 || blocksRaw.length > MAX_RESULT_BLOCKS) {
    errors.add('blocks', `：数量超出 1..${MAX_RESULT_BLOCKS}`);
    return { ok: false, reasons: errors.reasons };
  }
  const blocks: ResultBlock[] = [];
  let hasUncertain = false;
  for (let i = 0; i < blocksRaw.length; i += 1) {
    const block = checkBlock(blocksRaw[i], i, ctx, errors);
    if (block === null) return { ok: false, reasons: errors.reasons };
    if (block.kind === 'uncertain') hasUncertain = true;
    blocks.push(block);
  }
  // 决议 #151(5)：强制 uncertainty 矩阵
  if (requiresUncertainty(ctx) && !hasUncertain) {
    return {
      ok: false,
      reasons: [
        'blocks：缺少 uncertain 块（证据不足/结论为空/核验不可用/存在未解决冲突/单源高影响结论——程序强制）',
      ],
    };
  }
  // 决议 #150(9)：resultId 可信预分配（小写 RFC 4122 v4 UUID）
  let resultId: string;
  try {
    resultId = ctx.createId();
  } catch {
    return { ok: false, reasons: ['resultId：可信 ID 工厂异常'] };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(resultId)) {
    return { ok: false, reasons: ['resultId：可信 ID 工厂返回非法值（须为小写 v4 UUID）'] };
  }
  const result: ResearchResult = {
    resultId,
    taskId: ctx.taskId,
    title,
    summary,
    blocks,
    evidenceMap: buildEvidenceMap(ctx),
    conflicts: buildConflicts(ctx),
    coverage: buildCoverage(ctx),
    fetchedAt: buildFetchedAt(ctx),
  };
  // 决议 #150(7)：总大小（JavaScript 字符数）
  if (JSON.stringify(result).length > MAX_RESULT_CHARS) {
    return {
      ok: false,
      reasons: [`result：总大小超过 ${MAX_RESULT_CHARS} 字符上限`],
    };
  }
  return { ok: true, result };
}

export function validate(
  draft: unknown,
  ctx: ResearchResultValidationContext,
): { ok: true; result: ResearchResult } | { ok: false; reasons: string[] } {
  try {
    return doValidate(draft, ctx);
  } catch {
    // 决议 #150(1)/FT-17：任意输入安全返回（不抛穿、不静默放行）
    return { ok: false, reasons: ['校验器内部异常（安全拒绝）'] };
  }
}

// 决议 #155(1)：C7 冻结端口对象（C6 同模式；生产 factory 使用）
export const RESEARCH_RESULT_VALIDATION_PORT: Readonly<ResearchResultValidationPort> =
  Object.freeze({
    validate,
  });
