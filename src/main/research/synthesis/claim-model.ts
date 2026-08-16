// Fifth Stage C6: VerificationDraft strict parsing + deterministic
// Claim/Conflict assembly + parseResultDraft structural parsing
// (adjudications #142–#144/#147; threat-model FT-03/07/08/17).
//
// The model's verifying round is untrusted input: raw must be PURE JSON with a
// strict top-level/nested whitelist (unknown fields reject the whole document;
// no Markdown fences, no surrounding prose, no lenient repair). claimKey is
// only a local reference inside one proposal. Every trusted field — claimId/
// conflictId/taskId/coverage/sourceTypes/singleSourceFields/conflictIds/
// resolved — is produced by the program; the model has no field channel to
// submit them. All structural AND reference validation completes before any
// trusted ID is allocated (no half-assembled output); IDs must be lowercase
// RFC 4122 v4 UUIDs and unique across the whole assembly (claims and conflicts
// share one namespace). Output order follows the model's proposal order
// (deterministic); inputs are never mutated.
//
// Claim rules (#143): evidenceIds non-empty/unique, all in ctx.evidence for
// the current task; each Evidence's candidateId must resolve to a current
// Candidate (unknown/misbound rejects the whole document). coverage counts the
// DISTINCT canonicalKeys of the referenced Evidence (≥2 → multi-source) —
// never the Evidence count or candidate count. sourceTypes are computed from
// the real Candidates in fixed order vendor → third-party → community
// (deduped): trust.value='community' → community; trust.value='official' AND
// the source origin ∈ origins derived from the accepted vendorCandidateIds →
// vendor; everything else (official outside the vendor set / primary /
// secondary / unknown / null) → third-party (conservative default, no trust
// laundering). severity means impact, not coverage: a single-source high claim
// stays high with coverage=single-source and program-set singleSourceFields
// ['整条结论'] (any single-source claim is marked; multi-source gets []).
//
// Conflict rules (#144): local claimKeys map to program claimIds (≥2 distinct
// existing keys); ≥2 positions with pairwise-distinct normalized positionText;
// every position has ≥1 sourceRef, each ref must be a current candidate WITH
// current-task VerifiedEvidence support, and must fall inside the union of the
// referenced claims' Evidence candidateIds; the whole conflict must cover ≥2
// distinct canonicalKeys; resolved is always 'unresolved'; Claim.conflictIds
// and Conflict.claimIds are assembled bidirectionally by the program.
// Duplicate IDs, dangling references, duplicated positions and empty
// sourceRefs reject the whole document. Honest boundary: the program verifies
// structure and references only — it cannot prove two natural-language
// positions are semantically opposite (threat-model §5 #9).
//
// processVerification safely returns for ANY input and never throws.
// parseResultDraft (#147) is structural only: strict object top-level with
// exactly one key 'result'; the draft passes through unvalidated (C7 owns
// Result semantics); hostile input gets a safe bounded Chinese reason.
import type {
  Claim,
  ClaimSeverity,
  Conflict,
  ResearchSynthesisContext,
  ResearchSynthesisPort,
  SourceCandidate,
  SourceTypeClass,
} from '../../../shared/types/research';
import {
  MAX_CLAIM_EVIDENCE_REFS,
  MAX_CLAIM_KEY_CHARS,
  MAX_CLAIM_TEXT_CHARS,
  MAX_CLAIMS_PER_TASK,
  MAX_CONFLICT_CLAIM_REFS,
  MAX_CONFLICT_POSITION_CHARS,
  MAX_CONFLICT_POSITIONS,
  MAX_CONFLICT_POSITION_SOURCE_REFS,
  MAX_CONFLICT_TOPIC_CHARS,
  MAX_CONFLICTS_PER_TASK,
  MAX_PROVIDER_TEXT_CHARS_PER_STREAM,
  MAX_RESEARCH_REASON_CHARS,
  MAX_VENDOR_CANDIDATE_IDS,
  MAX_VERIFICATION_DRAFT_CHARS,
} from '../../../shared/types/research';
import { normalizeCaptureText } from '../capture-service';

// ---------- 共享形状工具 ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 小写 RFC 4122 v4 UUID（决议 #143(4)/#144(4)：可信 createId 的形状契约）
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// 精确 http/https origin（WHATWG URL；仅 http/https；候选 URL 上游已白名单，
// 此处为纵深防御——解析失败 → null → 保守 third-party）
function deriveOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

type ParseResult =
  { ok: true; claims: Claim[]; conflicts: Conflict[] } | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  // 决议 #142(7)：安全中文短句，不含模型原文，≤MAX_RESEARCH_REASON_CHARS
  return { ok: false, reason: reason.slice(0, MAX_RESEARCH_REASON_CHARS) };
}

// ---------- VerificationDraft 解析（决议 #142：严格白名单，整份拒绝） ----------

interface ParsedDraftClaim {
  claimKey: string;
  text: string; // 已规范化
  severity: ClaimSeverity;
  evidenceIds: string[];
}

interface ParsedDraftConflict {
  topic: string; // 已规范化
  positions: Array<{ positionText: string; sourceRefs: string[] }>; // 已规范化 + sourceRefs 去重
  claimKeys: string[];
}

interface ParsedDraft {
  vendorIds: string[]; // 已校验 ∈ 候选集 + 去重（保持首现顺序）
  claims: ParsedDraftClaim[];
  conflicts: ParsedDraftConflict[];
}

const DRAFT_CLAIM_KEYS = ['claimKey', 'text', 'severity', 'evidenceIds'] as const;
const DRAFT_POSITION_KEYS = ['positionText', 'sourceRefs'] as const;
const DRAFT_CONFLICT_KEYS = ['topic', 'positions', 'claimKeys'] as const;

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(record);
  if (own.length !== keys.length) return false;
  for (const key of keys) {
    if (!(key in record)) return false;
  }
  return true;
}

// claimKey：非空、≤上限、且已经是规范化形态（零控制字符/bidi/首尾空白——
// 严格协议：局部引用必须精确、确定性映射）
function isValidClaimKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value !== '' &&
    value.length <= MAX_CLAIM_KEY_CHARS &&
    normalizeCaptureText(value) === value
  );
}

function parseVendorIds(raw: unknown, candidates: readonly SourceCandidate[]): string[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_VENDOR_CANDIDATE_IDS) return null;
  const ids: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item === '') return null;
    if (!candidates.some((c) => c.id === item)) return null; // 程序只接受当前任务候选 ID
    if (!ids.includes(item)) ids.push(item); // 重复去重（保持首现顺序）
  }
  return ids;
}

function parseClaim(raw: unknown): ParsedDraftClaim | null {
  if (!isRecord(raw)) return null;
  if (!hasExactKeys(raw, DRAFT_CLAIM_KEYS)) return null; // 未知字段整份拒绝
  const claimKey = raw['claimKey'];
  if (!isValidClaimKey(claimKey)) return null;
  const text = raw['text'];
  if (typeof text !== 'string') return null;
  const cleaned = normalizeCaptureText(text);
  if (cleaned === '' || cleaned.length > MAX_CLAIM_TEXT_CHARS) return null;
  const severity = raw['severity'];
  if (severity !== 'high' && severity !== 'medium' && severity !== 'low') return null;
  const evidenceIds = raw['evidenceIds'];
  if (
    !Array.isArray(evidenceIds) ||
    evidenceIds.length === 0 ||
    evidenceIds.length > MAX_CLAIM_EVIDENCE_REFS
  ) {
    return null;
  }
  const seen = new Set<string>();
  for (const id of evidenceIds) {
    if (typeof id !== 'string' || id === '') return null;
    if (seen.has(id)) return null; // 唯一
    seen.add(id);
  }
  return { claimKey, text: cleaned, severity, evidenceIds: [...evidenceIds] };
}

function parseConflict(raw: unknown): ParsedDraftConflict | null {
  if (!isRecord(raw)) return null;
  if (!hasExactKeys(raw, DRAFT_CONFLICT_KEYS)) return null; // 未知字段整份拒绝
  const topic = raw['topic'];
  if (typeof topic !== 'string') return null;
  const cleanedTopic = normalizeCaptureText(topic);
  if (cleanedTopic === '' || cleanedTopic.length > MAX_CONFLICT_TOPIC_CHARS) return null;
  const positions = raw['positions'];
  if (
    !Array.isArray(positions) ||
    positions.length < 2 ||
    positions.length > MAX_CONFLICT_POSITIONS
  ) {
    return null;
  }
  const parsedPositions: ParsedDraftConflict['positions'] = [];
  for (const position of positions) {
    if (!isRecord(position)) return null;
    if (!hasExactKeys(position, DRAFT_POSITION_KEYS)) return null;
    const positionText = position['positionText'];
    if (typeof positionText !== 'string') return null;
    const cleaned = normalizeCaptureText(positionText);
    if (cleaned === '' || cleaned.length > MAX_CONFLICT_POSITION_CHARS) return null;
    const sourceRefs = position['sourceRefs'];
    if (
      !Array.isArray(sourceRefs) ||
      sourceRefs.length === 0 ||
      sourceRefs.length > MAX_CONFLICT_POSITION_SOURCE_REFS
    ) {
      return null; // 空 sourceRefs 整份拒绝（决议 #144(5)）
    }
    const refs: string[] = [];
    for (const ref of sourceRefs) {
      if (typeof ref !== 'string' || ref === '') return null;
      if (!refs.includes(ref)) refs.push(ref); // 去重（保持首现顺序）
    }
    parsedPositions.push({ positionText: cleaned, sourceRefs: refs });
  }
  // 决议 #144：至少 2 个规范化后不同的立场（同一位置复制整份拒绝）
  const distinctTexts = new Set(parsedPositions.map((p) => p.positionText));
  if (distinctTexts.size < 2) return null;
  const claimKeys = raw['claimKeys'];
  if (
    !Array.isArray(claimKeys) ||
    claimKeys.length < 2 ||
    claimKeys.length > MAX_CONFLICT_CLAIM_REFS
  ) {
    return null;
  }
  const seenKeys = new Set<string>();
  for (const key of claimKeys) {
    if (!isValidClaimKey(key)) return null;
    if (seenKeys.has(key)) return null; // 重复 claimKey 整份拒绝
    seenKeys.add(key);
  }
  return { topic: cleanedTopic, positions: parsedPositions, claimKeys: [...claimKeys] };
}

function parseDraft(raw: string, candidates: readonly SourceCandidate[]): ParsedDraft | null {
  if (raw.length > MAX_VERIFICATION_DRAFT_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // 纯 JSON：fence/说明文字/损坏输入一律失败（决议 #142(2)）
  }
  if (!isRecord(parsed)) return null;
  if (!hasExactKeys(parsed, ['vendorCandidateIds', 'claims', 'conflicts'])) return null;
  const vendorIds = parseVendorIds(parsed['vendorCandidateIds'], candidates);
  if (vendorIds === null) return null;
  const claimsRaw = parsed['claims'];
  if (!Array.isArray(claimsRaw) || claimsRaw.length > MAX_CLAIMS_PER_TASK) return null;
  const claims: ParsedDraftClaim[] = [];
  const seenClaimKeys = new Set<string>();
  for (const item of claimsRaw) {
    const claim = parseClaim(item);
    if (claim === null) return null;
    if (seenClaimKeys.has(claim.claimKey)) return null; // claimKey 唯一
    seenClaimKeys.add(claim.claimKey);
    claims.push(claim);
  }
  const conflictsRaw = parsed['conflicts'];
  if (!Array.isArray(conflictsRaw) || conflictsRaw.length > MAX_CONFLICTS_PER_TASK) return null;
  const conflicts: ParsedDraftConflict[] = [];
  for (const item of conflictsRaw) {
    const conflict = parseConflict(item);
    if (conflict === null) return null;
    conflicts.push(conflict);
  }
  return { vendorIds, claims, conflicts };
}

// ---------- sourceTypes 程序判定（决议 #143(6)/(7)，FT-07 不洗白 trust） ----------

const SOURCE_TYPE_ORDER: readonly SourceTypeClass[] = ['vendor', 'third-party', 'community'];

function classifySource(
  candidate: SourceCandidate,
  vendorOrigins: ReadonlySet<string>,
): SourceTypeClass {
  const trust = candidate.trust;
  if (trust !== null && trust.value === 'community') return 'community';
  if (trust !== null && trust.value === 'official') {
    const origin = deriveOrigin(candidate.url);
    if (origin !== null && vendorOrigins.has(origin)) return 'vendor';
  }
  // 其余 official（非厂商域）/primary/secondary/unknown/null → 保守 third-party
  return 'third-party';
}

// 固定顺序 vendor → third-party → community，去重（决议 #143(3)）
function computeSourceTypes(
  candidates: readonly SourceCandidate[],
  vendorOrigins: ReadonlySet<string>,
): SourceTypeClass[] {
  const present = new Set<SourceTypeClass>();
  for (const candidate of candidates) {
    present.add(classifySource(candidate, vendorOrigins));
  }
  return SOURCE_TYPE_ORDER.filter((cls) => present.has(cls));
}

// ---------- 引用校验 + 装配（决议 #143/#144：先全部校验，后分配可信 ID） ----------

function assembleDraft(draft: ParsedDraft, ctx: ResearchSynthesisContext): ParseResult {
  const { taskId, candidates, evidence } = ctx;
  // 厂商 origin 集合（决议 #143(6)：模型只提议候选 ID，程序推导 origin）
  const vendorOrigins = new Set<string>();
  for (const id of draft.vendorIds) {
    const candidate = candidates.find((c) => c.id === id);
    if (candidate === undefined) return fail('vendorCandidateIds 含未知候选 ID');
    const origin = deriveOrigin(candidate.url);
    if (origin !== null) vendorOrigins.add(origin);
  }

  // —— 一、全部结构/引用校验（先于任何 ID 分配，避免半成品输出） ——

  interface AssembledClaim {
    claimKey: string;
    text: string;
    severity: ClaimSeverity;
    evidenceIds: string[];
    coverage: Claim['coverage'];
    sourceTypes: SourceTypeClass[];
    candidateIds: string[];
  }

  const assembledClaims: AssembledClaim[] = [];
  for (const claim of draft.claims) {
    const claimCandidates: SourceCandidate[] = [];
    for (const evidenceId of claim.evidenceIds) {
      const matched = evidence.find((e) => e.evidenceId === evidenceId);
      if (matched === undefined || matched.taskId !== taskId) {
        return fail('引用的证据不存在或不属于当前任务');
      }
      const candidate = candidates.find((c) => c.id === matched.candidateId);
      if (candidate === undefined) {
        return fail('证据关联的来源不在当前候选集合');
      }
      claimCandidates.push(candidate);
    }
    // coverage：只按引用 Evidence 的不同 canonicalKey 数（决议 #143(2)）
    const canonicalKeys = new Set(claimCandidates.map((c) => c.canonicalKey));
    const coverage = canonicalKeys.size >= 2 ? 'multi-source' : 'single-source';
    // sourceTypes：对去重后的真实候选判定，固定顺序（决议 #143(3)）
    const distinctCandidates: SourceCandidate[] = [];
    for (const candidate of claimCandidates) {
      if (!distinctCandidates.some((c) => c.id === candidate.id)) {
        distinctCandidates.push(candidate);
      }
    }
    assembledClaims.push({
      claimKey: claim.claimKey,
      text: claim.text,
      severity: claim.severity,
      evidenceIds: [...claim.evidenceIds],
      coverage,
      sourceTypes: computeSourceTypes(distinctCandidates, vendorOrigins),
      candidateIds: distinctCandidates.map((c) => c.id),
    });
  }

  const claimKeyToIndex = new Map<string, number>();
  assembledClaims.forEach((claim, index) => claimKeyToIndex.set(claim.claimKey, index));

  interface AssembledConflict {
    topic: string;
    positions: Array<{ positionText: string; sourceRefs: string[] }>;
    claimIndexes: number[];
  }

  const assembledConflicts: AssembledConflict[] = [];
  for (const conflict of draft.conflicts) {
    const claimIndexes: number[] = [];
    const unionCandidates = new Set<string>(); // 引用 Claims 的 Evidence 来源并集
    for (const key of conflict.claimKeys) {
      const index = claimKeyToIndex.get(key);
      if (index === undefined) return fail('冲突引用了不存在的 claimKey');
      claimIndexes.push(index);
      for (const candidateId of assembledClaims[index]!.candidateIds) {
        unionCandidates.add(candidateId);
      }
    }
    // sourceRefs：∈ 当前候选 + 有当前任务 VerifiedEvidence 支撑 +
    // 落在引用 Claims 的 Evidence 来源并集内（决议 #144(2)）
    for (const position of conflict.positions) {
      for (const ref of position.sourceRefs) {
        if (!candidates.some((c) => c.id === ref)) {
          return fail('sourceRefs 引用未知候选');
        }
        if (!evidence.some((e) => e.taskId === taskId && e.candidateId === ref)) {
          return fail('sourceRefs 引用无已验证证据支撑的候选');
        }
        if (!unionCandidates.has(ref)) {
          return fail('sourceRefs 超出引用结论的证据来源并集');
        }
      }
    }
    // 整个 Conflict 至少覆盖两个不同 canonicalKey（决议 #144(2)）
    const canonicalKeys = new Set<string>();
    for (const candidateId of unionCandidates) {
      const candidate = candidates.find((c) => c.id === candidateId);
      if (candidate !== undefined) canonicalKeys.add(candidate.canonicalKey);
    }
    if (canonicalKeys.size < 2) {
      return fail('冲突必须覆盖至少两个不同来源');
    }
    assembledConflicts.push({
      topic: conflict.topic,
      positions: conflict.positions.map((p) => ({
        positionText: p.positionText,
        sourceRefs: [...p.sourceRefs],
      })),
      claimIndexes,
    });
  }

  // —— 二、全部校验通过 → 分配可信 ID（小写 v4 + 全局不重复，决议 #143(4)） ——

  const usedIds = new Set<string>();
  const allocateId = (): string | null => {
    let id: unknown;
    try {
      id = ctx.createId();
    } catch {
      return null;
    }
    if (typeof id !== 'string' || !UUID_V4_PATTERN.test(id) || usedIds.has(id)) {
      return null;
    }
    usedIds.add(id);
    return id;
  };

  const claimIds: string[] = [];
  for (let i = 0; i < assembledClaims.length; i++) {
    const id = allocateId();
    if (id === null) return fail('ID 分配失败（UUID 形状或重复）');
    claimIds.push(id);
  }
  const conflictIds: string[] = [];
  for (let i = 0; i < assembledConflicts.length; i++) {
    const id = allocateId();
    if (id === null) return fail('ID 分配失败（UUID 形状或重复）');
    conflictIds.push(id);
  }

  // —— 三、装配（决议 #143(5)：返回顺序 = 模型 proposal 顺序） ——

  const claims: Claim[] = assembledClaims.map((claim, index) => ({
    claimId: claimIds[index]!,
    taskId,
    text: claim.text,
    severity: claim.severity,
    coverage: claim.coverage,
    sourceTypes: [...claim.sourceTypes],
    evidenceIds: [...claim.evidenceIds],
    // 决议 #143(7)：单源标记由程序设置（任意 severity）；多源为空数组
    singleSourceFields: claim.coverage === 'single-source' ? ['整条结论'] : [],
    conflictIds: [], // 由冲突装配反向填充（决议 #144(4)）
  }));

  const conflicts: Conflict[] = assembledConflicts.map((conflict, index) => {
    const conflictId = conflictIds[index]!;
    const claimIdsMapped = conflict.claimIndexes.map((i) => claimIds[i]!);
    // 双向一致：Claim.conflictIds 由程序反向装配（按冲突顺序追加）
    for (const claimIndex of conflict.claimIndexes) {
      claims[claimIndex]!.conflictIds.push(conflictId);
    }
    return {
      conflictId,
      taskId,
      topic: conflict.topic,
      positions: conflict.positions,
      claimIds: claimIdsMapped,
      resolved: 'unresolved' as const, // 决议 #144(4)：v1 恒 unresolved
    };
  });

  return { ok: true, claims, conflicts };
}

// ---------- 端口实现（决议 #134 形状；任意输入安全返回不抛异常） ----------

export function processVerification(
  raw: string,
  ctx: ResearchSynthesisContext,
): { ok: true; claims: Claim[]; conflicts: Conflict[] } | { ok: false; reason: string } {
  try {
    if (typeof raw !== 'string' || raw === '') {
      return fail('核验输出不是合法 JSON');
    }
    const draft = parseDraft(raw, ctx.candidates);
    if (draft === null) {
      return fail('核验输出不符合严格协议（纯 JSON 白名单）');
    }
    return assembleDraft(draft, ctx);
  } catch {
    // 决议 #142(8)：任意 unknown/raw 安全返回，不抛异常，零模型原文回显
    return fail('核验装配失败（内部错误）');
  }
}

// ---------- parseResultDraft（决议 #147：仅结构解析，零 C7 语义） ----------

export function parseResultDraft(
  raw: string,
): { ok: true; draft: unknown } | { ok: false; reason: string } {
  try {
    if (typeof raw !== 'string' || raw === '') {
      return fail('结果草案不是合法 JSON');
    }
    if (raw.length > MAX_PROVIDER_TEXT_CHARS_PER_STREAM) {
      return fail('结果草案超长');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail('结果草案不是合法 JSON');
    }
    if (!isRecord(parsed)) {
      return fail('结果草案顶层必须是 JSON 对象');
    }
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || !('result' in parsed)) {
      return fail('结果草案顶层只能包含 result 字段');
    }
    return { ok: true, draft: parsed['result'] };
  } catch {
    return fail('结果草案解析失败（内部错误）');
  }
}

// 决议 #142/#147：冻结只读合成端口（C6 真实实现；C5 stub 仅测试设施）
export const RESEARCH_SYNTHESIS_PORT: Readonly<ResearchSynthesisPort> = Object.freeze({
  processVerification,
  parseResultDraft,
});
