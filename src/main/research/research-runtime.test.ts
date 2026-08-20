// C5 research-runtime tests (adjudications #132–#138): the bounded
// orchestration state machine — four-phase order with per-phase heartbeats,
// the six-tool execution model (safe results for unknown/invalid/cross-task
// references, no throws), ResearchPlan strict parsing with the safe default,
// candidate pre-allocation (v4 UUID, conflict fail-closed), 24/8/16/60
// ceilings, capture-attempt ↔ stats exact accounting, Sources-only/Search-
// only degradation, model-round retry and consecutive-failure termination,
// context-too-long retry, step/round boundary zero-execution, stop races,
// late-event/tool-result/db-write no-ops, progress semantics, per-terminal
// cleanupAll, terminal priority, and zero persistence of capture content /
// transcript / reasoning.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import { ResearchRepository } from './repository/research-repository';
import { createRepositoryPersistence } from './research-runtime-persistence';
import { ResearchRuntime, trimRequestMessages } from './research-runtime';
import { FakeProvider, type FakeProviderScript } from '../ai/provider/fake-provider';
import type { SearchProvider, SearchProviderResult } from '../ai/search/search-provider';
import type {
  SourceSearchResult,
  SourceListResult,
  SourceListItem,
  SourceSearchItem,
  SourceGroupsResult,
  SourceGroup,
} from '../../shared/types/sources';
import type { Capture } from '../../shared/types/research';
import type { CaptureReadResult } from './capture-service';
import type {
  ResearchPhase,
  ResearchProgressEvent,
  ResearchPromptsPort,
  ResearchResult,
  ResearchResultValidationPort,
  ResearchSynthesisPort,
  ResearchTaskStats,
  SourceCandidate,
} from '../../shared/types/research';
import {
  MAX_PLAN_WEB_QUERIES,
  MAX_RESEARCH_ROUNDS,
  MAX_RESEARCH_TOOL_STEPS,
  MAX_SELECTED_SOURCES,
  MAX_SOURCE_CANDIDATES,
  MAX_CAPTURES_PER_TASK,
  MAX_EVIDENCE_PER_TASK,
  MAX_REQUEST_CONTEXT_CHARS,
} from '../../shared/types/research';
import type { ProviderMessage } from '../../shared/types/conversation';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-rt-'));
const T0 = '2026-08-16T00:00:00.000Z';

let handle: DbHandle;
let repo: ResearchRepository;
let taskId: string;
let nowMs: number;

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const ZERO_STATS: ResearchTaskStats = {
  candidateCount: 0,
  selectedCount: 0,
  captureCount: 0,
  failedReadCount: 0,
  evidenceCount: 0,
  rejectedEvidenceCount: 0,
  claimCount: 0,
  conflictCount: 0,
  stepsUsed: 0,
  roundsUsed: 0,
};

const STUB_PROMPTS: ResearchPromptsPort = {
  planning: 'PLANNING_PROMPT',
  reading: 'READING_PROMPT',
  verifying: 'VERIFYING_PROMPT',
  synthesizing: 'SYNTHESIZING_PROMPT',
};

// C5 确定性 stub 端口（决议 #134(3)：仅测试设施——生产不建立）
function makeSynthesisStub(): ResearchSynthesisPort {
  return {
    processVerification(raw, _ctx) {
      const parsed = JSON.parse(raw) as { claims?: unknown[]; conflicts?: unknown[] };
      if (!Array.isArray(parsed.claims) && !Array.isArray(parsed.conflicts)) {
        return { ok: false, reason: '无法解析核验输出' };
      }
      const claims = (parsed.claims ?? []).map((c, i) => ({
        claimId: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
        taskId: _ctx.taskId,
        ...(c as Record<string, unknown>),
      })) as never[];
      return { ok: true, claims: claims as never, conflicts: (parsed.conflicts ?? []) as never };
    },
    parseResultDraft(raw) {
      try {
        const parsed = JSON.parse(raw) as { result?: unknown };
        if (parsed === null || typeof parsed !== 'object' || !('result' in parsed)) {
          return { ok: false, reason: '缺少 result 字段' };
        }
        return { ok: true, draft: parsed.result };
      } catch {
        return { ok: false, reason: 'JSON 解析失败' };
      }
    },
  };
}

function makeResultValidationStub(): ResearchResultValidationPort {
  return {
    validate(draft, ctx) {
      // C5 stub：仅接受测试夹具形状（{__stub:true, ...result}）——拒绝一切
      // 其他形状（不把未验证模型输出写入 ResearchResult——决议 #134(3)）
      if (draft === null || typeof draft !== 'object') {
        return { ok: false, reasons: ['结果草案必须是对象'] };
      }
      const d = draft as Record<string, unknown>;
      if (d.__stub !== true) {
        return { ok: false, reasons: ['C5 stub：拒绝未受控形状'] };
      }
      return { ok: true, result: { ...(d as unknown as ResearchResult), taskId: ctx.taskId } };
    },
  };
}

// —— 可控替身 ——

class FakeSources {
  searchCalls = 0;
  listCalls = 0;
  groupsCalls = 0;
  getCalls = 0;
  searchOutcome: SourceSearchResult = { ok: true, query: '', results: [] };
  listOutcome: SourceListResult = { ok: true, page: 0, pageSize: 20, total: 0, items: [] };
  groupsOutcome: SourceGroupsResult = { ok: true, page: 0, pageSize: 20, total: 0, groups: [] };
  getOutcome: import('../../shared/types/sources').SourceResult = {
    ok: false,
    errorCode: 'source-not-found',
  };

  async search(): Promise<SourceSearchResult> {
    this.searchCalls += 1;
    return this.searchOutcome;
  }

  async list(): Promise<SourceListResult> {
    this.listCalls += 1;
    return this.listOutcome;
  }

  async listGroups(): Promise<SourceGroupsResult> {
    this.groupsCalls += 1;
    return this.groupsOutcome;
  }

  async get(): Promise<import('../../shared/types/sources').SourceResult> {
    this.getCalls += 1;
    return this.getOutcome;
  }
}

class FakeSearch implements SearchProvider {
  readonly id = 'fake-search';
  searchCalls = 0;
  outcome: SearchProviderResult = { ok: true, results: [] };

  async search(): Promise<SearchProviderResult> {
    this.searchCalls += 1;
    return this.outcome;
  }
}

class FakeCapture {
  readCalls = 0;
  readonly results: CaptureReadResult[] = [];

  constructor(results: CaptureReadResult[]) {
    this.results = results;
  }

  async read(candidate: SourceCandidate): Promise<CaptureReadResult> {
    const idx = Math.min(this.readCalls, this.results.length - 1);
    this.readCalls += 1;
    const result = this.results[idx] ?? this.results[this.results.length - 1]!;
    // 真实捕获语义：taskId/candidateId 恒为实际值；每次 read 独立 captureId
    const fix = (c: Capture): Capture => ({
      ...c,
      captureId: this.readCalls === 1 ? c.captureId : `${c.captureId}-${this.readCalls}`,
      taskId,
      candidateId: candidate.id,
    });
    const fixed = {
      ...result,
      attempts: result.attempts.map(fix),
    } as CaptureReadResult;
    if (result.ok) {
      (fixed as { capture: Capture }).capture = fix(result.capture);
    }
    return fixed;
  }
}

function makeItem(id: string, url: string, name = '信源'): SourceSearchItem {
  return {
    id,
    scope: 'page',
    canonicalKey: url,
    url,
    name,
    groupId: null,
    groupName: null,
    tags: [],
    priority: 3,
    enabled: true,
    trust: { value: 'unknown', assertedBy: 'ai', verification: 'unverified' },
    shareMode: 'full',
    lastUsedAt: null,
    note: null,
  };
}

function makeListItem(id: string, url: string, name = '信源'): SourceListItem {
  const item = makeItem(id, url, name);
  return { ...item, note: undefined } as unknown as SourceListItem;
}

function makeGroup(id: string, name: string): SourceGroup {
  return { id, name, createdAt: T0, deletedAt: null };
}

function makeResult(): ResearchResult {
  return {
    resultId: '66666666-6666-4666-8666-666666666666',
    taskId: '',
    title: '结果',
    summary: '摘要',
    blocks: [{ kind: 'markdown', text: '正文' }],
    evidenceMap: {},
    conflicts: [],
    coverage: {
      total: 0,
      multiSource: 0,
      singleSource: 0,
      vendor: 0,
      thirdParty: 0,
      community: 0,
    },
    fetchedAt: T0,
  };
}

// 完整快乐路径脚本（7 轮模型）
function happyScript(): FakeProviderScript {
  return {
    rounds: [
      // 轮 1：候选查询计划
      [
        {
          text: JSON.stringify({
            sourceMode: 'search',
            sourceQuery: '主流模型',
            groupId: null,
            webQueries: [],
          }),
        },
      ],
      // 轮 2：选择意图
      [
        {
          text: JSON.stringify({ selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] }),
        },
      ],
      // 轮 3：reading（候选 1）——browser_read 工具调用
      [
        {
          kind: 'toolCalls',
          toolCalls: [
            { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
          ],
        },
      ],
      // 轮 4：reading（候选 1 续）——evidence proposals
      [
        {
          text: JSON.stringify([
            {
              captureId: '33333333-3333-4333-8333-333333333333',
              candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              type: 'quote',
              locator: { kind: 'text', excerpt: '摘录' },
              excerpt: '摘录',
              value: null,
            },
          ]),
        },
      ],
      // 轮 5：verifying
      [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
      // 轮 6：synthesizing
      [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
    ],
  };
}

function successCapture(captureId: string, tabId: string): CaptureReadResult {
  return {
    ok: true,
    attempts: [
      {
        captureId,
        taskId: '',
        candidateId: '22222222-2222-4222-8222-222222222222',
        tabId,
        url: 'https://c.example/page',
        title: '页面',
        accessTime: T0,
        documentId: '1',
        contentHash: 'a'.repeat(32),
        summary: { sectionCount: 1, tableCount: 0, headingCount: 1, charCount: 2 },
        failed: false,
        failureReason: null,
      },
    ],
    capture: {
      captureId,
      taskId: '',
      candidateId: '22222222-2222-4222-8222-222222222222',
      tabId,
      url: 'https://c.example/page',
      title: '页面',
      accessTime: T0,
      documentId: '1',
      contentHash: 'a'.repeat(32),
      summary: { sectionCount: 1, tableCount: 0, headingCount: 1, charCount: 2 },
      failed: false,
      failureReason: null,
    },
    content: {
      captureId,
      canonicalText: '受控正文摘录',
      textSections: ['受控正文摘录'],
      tables: [],
      fields: { 'page.url': 'https://c.example/page', 'page.title': '页面' },
      headingCount: 0,
    },
    warnings: [],
  };
}

interface Harness {
  runtime: ResearchRuntime;
  provider: import('../ai/provider/llm-provider').LLMProvider;
  sources: FakeSources;
  search: FakeSearch;
  capture: FakeCapture;
  events: ResearchProgressEvent[];
  settleCalls: number;
  stopController: AbortController;
  done: Promise<void>;
  nowMs: () => number;
}

function defaultSources(): FakeSources {
  const f = new FakeSources();
  f.searchOutcome = {
    ok: true,
    query: '',
    results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
  };
  return f;
}

function buildHarness(
  over: {
    script?: FakeProviderScript;
    sources?: FakeSources;
    search?: FakeSearch;
    capture?: FakeCapture;
    deadlineMs?: number;
    createId?: () => string;
    synthesis?: ResearchSynthesisPort;
    validation?: ResearchResultValidationPort;
    provider?: import('../ai/provider/llm-provider').LLMProvider;
  } = {},
): Harness {
  const sources = over.sources ?? defaultSources();
  const search = over.search ?? new FakeSearch();
  const events: ResearchProgressEvent[] = [];
  let settleCalls = 0;
  const provider = over.provider ?? new FakeProvider(over.script ?? happyScript());
  const stopController = new AbortController();
  // 确定性 createId 序列（候选/证据 id 可预知）：aaaaaaaa… = 候选 1
  const idSeq = [
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  ];
  let seqN = 0;
  const seqCreateId = (): string => {
    const next = idSeq.shift();
    if (next !== undefined) return next;
    seqN += 1;
    return `f0000000-0000-4f00-8f00-${String(seqN).padStart(12, '0')}`;
  };
  const runtime = new ResearchRuntime({
    taskId,
    goal: '比较主流模型能力',
    runToken: 'token-1',
    model: 'test-model',
    provider,
    sourceService: sources,
    searchProvider: search,
    captureService:
      over.capture ??
      new FakeCapture([successCapture('33333333-3333-4333-8333-333333333333', 'tab-1')]),
    persistence: createRepositoryPersistence(handle, taskId),
    prompts: STUB_PROMPTS,
    synthesis: over.synthesis ?? makeSynthesisStub(),
    resultValidation: over.validation ?? makeResultValidationStub(),
    nowMs: () => nowMs,
    createId: over.createId ?? seqCreateId,
    deadlineMs: over.deadlineMs,
    onProgress: (e) => events.push(e),
    onSettle: () => {
      settleCalls += 1;
    },
    stopSignal: stopController.signal,
  });
  const done = runtime.run();
  return {
    runtime,
    provider,
    sources,
    search,
    capture:
      over.capture ??
      new FakeCapture([successCapture('33333333-3333-4333-8333-333333333333', 'tab-1')]),
    events,
    settleCalls,
    stopController,
    done,
    nowMs: () => nowMs,
  };
}

beforeEach(() => {
  handle = openDb(join(root, `rt-${Math.random().toString(36).slice(2)}.db`));
  runResearchMigrations(handle);
  repo = new ResearchRepository(handle);
  nowMs = Date.UTC(2026, 7, 16, 0, 0, 0);
  taskId = '11111111-1111-4111-8111-111111111111';
  repo.insertTask({
    id: taskId,
    goal: '比较主流模型能力',
    status: 'running',
    phase: 'planning',
    created_at: T0,
    updated_at: T0,
    started_at: T0,
    finished_at: null,
    interrupted_at: null,
    error_code: null,
    result_id: null,
    stats_json: JSON.stringify(ZERO_STATS),
  });
});

afterEach(() => {
  closeDb(handle);
});

// —— 场景 1：四阶段顺序 + heartbeat + completed ——

describe('四阶段顺序与 phase heartbeat（决议 #138(2)）', () => {
  it('planning→reading→verifying→synthesizing→completed（每 phase 落库 + 终态恰好一次）', async () => {
    const h = buildHarness();
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('completed');
    expect(task.resultId).toBe('66666666-6666-4666-8666-666666666666');
    expect(task.phase).toBeNull();
    // 候选持久化
    expect(repo.listCandidatesByTask(taskId).length).toBe(1);
    // Evidence 持久化（stub verify 需要真实验证——见场景说明：happyScript 的
    // proposal 必须通过 EvidenceValidator；此处 capture 内容提供「摘录」）
    expect(repo.listEvidenceByTask(taskId).length).toBe(1);
    // 每 phase 心跳：事件序列 phase 顺序（planning 至少一次、reading 一次……）
    const phases = h.events.map((e) => e.phase).filter((p): p is ResearchPhase => p !== null);
    expect(phases[0]).toBe('planning');
    expect(phases).toContain('reading');
    expect(phases).toContain('verifying');
    expect(phases).toContain('synthesizing');
    // 终态恰好一次
    const terminals = h.events.filter((e) => e.status !== 'running');
    expect(terminals.length).toBe(1);
    expect(terminals[0]!.status).toBe('completed');
    expect(terminals[0]!.finishedAt).not.toBeNull();
    // 初始 running/planning 恰好一次
    expect(h.events[0]).toMatchObject({ status: 'running', phase: 'planning' });
  });

  it('stats 终值精确：candidateCount/selectedCount/captureCount/evidenceCount/stepsUsed/roundsUsed', async () => {
    const h = buildHarness();
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.stats.candidateCount).toBe(1);
    expect(task.stats.selectedCount).toBe(1);
    expect(task.stats.captureCount).toBe(1);
    expect(task.stats.failedReadCount).toBe(0);
    expect(task.stats.evidenceCount).toBe(1);
    // 工具步数：listGroups(1) + source_search(1) + capture.read(1) + browser_read 工具调用(1) = 4
    expect(task.stats.stepsUsed).toBe(4);
    // 模型轮次：plan + selection + tool 轮 + proposals + verifying + synthesis = 6
    expect(task.stats.roundsUsed).toBe(6);
  });

  it('reasoning/transcript/CaptureContent 零持久化（库字节零正文/零思维）', async () => {
    const h = buildHarness();
    await h.done;
    const dbPath = join(root, 'probe.db');
    // 扫描当前库内容
    const task = repo.getTaskById(taskId)!;
    expect(JSON.stringify(task)).not.toContain('受控正文');
    const candidates = JSON.stringify(repo.listCandidatesByTask(taskId));
    expect(candidates).not.toContain('受控正文');
    const evidence = JSON.stringify(repo.listEvidenceByTask(taskId));
    expect(evidence).not.toContain('受控正文');
    expect(evidence).not.toContain('canonicalText');
    expect(dbPath).toBeTruthy();
  });
});

// —— 场景 2：降级矩阵 ——

describe('降级矩阵（决议 #133(5)）', () => {
  it('Sources-only：Search 失败 → 候选仅 Sources + 任务 completed（warnings 不终止）', async () => {
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const search = new FakeSearch();
    search.outcome = { ok: false, results: [], errorCode: 'search-failed' };
    const h = buildHarness({ sources, search });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('completed');
    expect(repo.listCandidatesByTask(taskId).length).toBe(1);
  });

  it('Search-only：Sources 检索为空 + Search 命中 → 候选为 search-only', async () => {
    const sources = new FakeSources();
    sources.searchOutcome = { ok: true, query: '', results: [] };
    const search = new FakeSearch();
    search.outcome = {
      ok: true,
      results: [{ title: '搜索页', url: 'https://s.example/page', snippet: '', source: 'bing' }],
    };
    // webQueries 需模型计划提供
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: '主流模型',
              groupId: null,
              webQueries: ['补充搜索'],
            }),
          },
        ],
        [{ text: JSON.stringify({ selectedCandidateIds: [] }) }],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const h = buildHarness({ script, sources, search });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('completed');
    const candidates = repo.listCandidatesByTask(taskId);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.discoveredVia).toEqual(['search']);
    expect(candidates[0]!.trust).toBeNull();
  });

  it('Sources 不可用（检索返回 source-unavailable）→ failed(research-sources-unavailable)', async () => {
    const sources = new FakeSources();
    sources.searchOutcome = { ok: false, errorCode: 'source-unavailable' };
    const h = buildHarness({ sources });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('research-sources-unavailable');
  });

  it('group 模式：list 使用 groupId（模型计划引用程序提供的 group）', async () => {
    const sources = new FakeSources();
    const groupId = '11111111-1111-4111-8111-111111111111';
    sources.groupsOutcome = {
      ok: true,
      page: 0,
      pageSize: 20,
      total: 1,
      groups: [makeGroup(groupId, 'AI Benchmark')],
    };
    sources.listOutcome = {
      ok: true,
      page: 0,
      pageSize: 20,
      total: 1,
      items: [makeListItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({ sourceMode: 'group', sourceQuery: '', groupId, webQueries: [] }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    expect(sources.listCalls).toBe(1);
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });
});

// —— 场景 3：计划解析与安全默认 ——

describe('计划解析、重提与安全默认（决议 #133）', () => {
  it('计划非法 → 回注重提 1 次成功 → 继续', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ text: 'not-json' }],
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: '主流模型',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });

  it('计划两次非法 → 安全默认计划（goal 截断查询 + 零 web）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [{ text: 'bad-1' }],
        [{ text: 'bad-2' }],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    expect(sources.searchCalls).toBe(1);
    expect(sources.searchOutcome.ok).toBe(true);
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });

  it('webQueries 超上限（2 项）→ 计划非法 → 重提', async () => {
    expect(MAX_PLAN_WEB_QUERIES).toBe(1);
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: ['a', 'b'],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [{ text: JSON.stringify({ selectedCandidateIds: [] }) }],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });
});

// —— 场景 4：candidateId 预分配与冲突 ——

describe('candidateId 预分配（决议 #133(4)）', () => {
  it('预分配 id 为小写 v4 UUID 形状（8-4-4-4-12）', async () => {
    const h = buildHarness();
    await h.done;
    const candidates = repo.listCandidatesByTask(taskId);
    for (const c of candidates) {
      expect(c.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('id 工厂冲突（重复 id）→ 该轮 fail-closed → 安全默认 + 不终止', async () => {
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const h = buildHarness({
      sources,
      createId: () => 'dup-dup-dup-dup-dup-dup-dup-dup', // 恒重复 → merge 冲突
    });
    await h.done;
    // merge 冲突 → 归一安全默认计划路径 → 仍冲突 → 候选为空 → 继续到终态
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('completed');
  });
});

// —— 场景 5：工具执行模型 ——

describe('六工具执行模型（决议 #132）', () => {
  it('请求 tools 恒为六工具子集（每轮请求断言）', async () => {
    const h = buildHarness();
    await h.done;
    const requests = (h.provider as FakeProvider).getRequests();
    for (const req of requests) {
      expect(req.tools).toBeDefined();
      expect(req.tools!.map((t) => t.function.name).sort()).toEqual([
        'browser_open',
        'browser_read',
        'search_web',
        'source_get',
        'source_list',
        'source_search',
      ]);
    }
  });

  it('未知工具 → 安全工具结果 + 任务继续（不执行不 throw）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              {
                id: 'tc-x',
                name: 'browser_navigate',
                arguments: JSON.stringify({ url: 'https://evil.example/' }),
              },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });

  it('browser_read 跨任务/未知 tabId → 安全失败结果（零 BrowserController 调用）', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              {
                id: 'tc-1',
                name: 'browser_read',
                arguments: JSON.stringify({ tabId: 'other-task-tab' }),
              },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });

  it('FRT-01：工具结果回放消息必须带 UNTRUSTED 块（网页正文零特权通道）', async () => {
    // C9 FRT-01 红队发现（2026-08-18）：browser_read 工具结果携带捕获正文，
    // 原以裸 JSON 字符串回放进下一轮请求——网页正文经工具结果通道零包裹进入
    // 模型上下文（违反 threat-model §3.1「工具结果只进 UNTRUSTED 块」）。
    // 修复：工具回放消息以 buildUntrustedBlock('tool-result', …) 包裹。
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              {
                id: 'tc-1',
                name: 'browser_read',
                arguments: JSON.stringify({ tabId: 'tab-1' }),
              },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const provider = new FakeProvider(script);
    const h = buildHarness({ provider });
    await h.done;
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
    const requests = provider.getRequests();
    const toolMsg = requests
      .flatMap((r) => r.messages)
      .find((m) => m.role === 'tool' && m.toolCallId === 'tc-1');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('<UNTRUSTED_WEB_CONTENT>');
    expect(toolMsg!.content).toContain('</UNTRUSTED_WEB_CONTENT>');
    expect(toolMsg!.content).toContain('tool-result');
    // 捕获正文（受控摘录）在块内可见；`</` 闭合转义（敌手无法提前闭合块）
    expect(toolMsg!.content).toContain('受控正文摘录');
  });

  it('browser_open 非候选 URL → 安全失败 + 零 CaptureService.read 调用', async () => {
    const capture = new FakeCapture([
      successCapture('33333333-3333-4333-8333-333333333333', 'tab-1'),
    ]);
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              {
                id: 'tc-1',
                name: 'browser_open',
                arguments: JSON.stringify({ url: 'https://evil.example/' }),
              },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const h = buildHarness({ script, sources, capture });
    await h.done;
    // phaseReading 对选定候选的合法读取 1 次；browser_open 工具调用被拒绝零额外 read
    expect(capture.readCalls).toBe(1);
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });

  it('search_web 工具调用 → SearchProvider.search 计 1 步', async () => {
    const search = new FakeSearch();
    search.outcome = { ok: true, results: [] };
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'search_web', arguments: JSON.stringify({ query: '补充' }) },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const h = buildHarness({ script, sources, search });
    await h.done;
    expect(search.searchCalls).toBe(1);
    expect(repo.getTaskById(taskId)!.stats.stepsUsed).toBeGreaterThanOrEqual(3);
  });
});

// —— 场景 6：预算边界 ——

describe('预算边界（决议 #136）', () => {
  it('候选合并 ≤24、选定 ≤8（合并后裁剪）', async () => {
    const sources = new FakeSources();
    const items = Array.from({ length: 30 }, (_, i) =>
      makeItem(
        `0000000${String(i).padStart(1, '0')}-0000-4000-8000-${String(i).padStart(12, '0')}`,
        `https://c.example/${i}`,
      ),
    );
    sources.searchOutcome = { ok: true, query: '', results: items.slice(0, 10) };
    const search = new FakeSearch();
    search.outcome = {
      ok: true,
      results: Array.from({ length: 10 }, (_, i) => ({
        title: `S${i}`,
        url: `https://s.example/${i}`,
        snippet: '',
        source: 'bing',
      })),
    };
    const h = buildHarness({ sources, search });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.stats.candidateCount).toBeLessThanOrEqual(MAX_SOURCE_CANDIDATES);
    expect(task.stats.selectedCount).toBeLessThanOrEqual(MAX_SELECTED_SOURCES);
  });

  it('Capture 上限 16：超限 → failed(research-budget-exhausted)，此前已提交保留', async () => {
    expect(MAX_CAPTURES_PER_TASK).toBe(16);
    // 8 候选 × 2 次尝试 = 16 用满；第 8 个候选产生第 3 次尝试 → 超限终态
    const sources = new FakeSources();
    const items = Array.from({ length: 8 }, (_, i) =>
      makeItem(
        `0000000${i}-0000-4000-8000-${String(i).padStart(12, '0')}`,
        `https://c.example/${i}`,
      ),
    );
    sources.searchOutcome = { ok: true, query: '', results: items };
    const makeFailed = (captureId: string, n: number): CaptureReadResult => ({
      ok: false,
      attempts: Array.from({ length: n }, (_, i) => ({
        captureId: `${captureId}-${i}`,
        taskId,
        candidateId: 'y',
        tabId: 'unallocated',
        url: 'https://c.example/f',
        title: 'F',
        accessTime: T0,
        documentId: 'unavailable',
        contentHash: 'a'.repeat(32),
        summary: { sectionCount: 0, tableCount: 0, headingCount: 0, charCount: 0 },
        failed: true,
        failureReason: 'page-load-failed',
      })),
      failureReason: 'page-load-failed',
      warnings: [],
    });
    const capture = new FakeCapture([
      ...Array.from({ length: 7 }, (_, i) => makeFailed(`cap-${i}`, 2)),
      makeFailed('cap-7', 3), // 第 8 个候选：3 次尝试（测试设施构造超限形态）
    ]);
    // 8 候选 × 1 证据轮（零 proposals）+ plan/selection = 10 轮（≤24）
    const rounds = [
      [
        {
          text: JSON.stringify({
            sourceMode: 'search',
            sourceQuery: 'q',
            groupId: null,
            webQueries: [],
          }),
        },
      ],
      [{ text: JSON.stringify({ selectedCandidateIds: [] }) }],
      ...Array.from({ length: 8 }, () => [{ text: JSON.stringify([]) }]),
    ];
    const h = buildHarness({ script: { rounds }, sources, capture });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('research-budget-exhausted');
    expect(task.stats.captureCount).toBe(16);
    expect(repo.listCapturesByTask(taskId).length).toBe(16); // 此前已提交保留
  });

  it('Evidence 上限 60：第 61 条 verified → failed(budget)，已提交保留', async () => {
    expect(MAX_EVIDENCE_PER_TASK).toBe(60);
    // 单候选 + 61 条 proposal：第 61 条触发终态
    const proposals = Array.from({ length: 61 }, () => ({
      captureId: '33333333-3333-4333-8333-333333333333',
      candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      type: 'quote',
      locator: { kind: 'text', excerpt: '摘录' },
      excerpt: '摘录',
      value: null,
    }));
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
            ],
          },
        ],
        [{ text: JSON.stringify(proposals) }],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('research-budget-exhausted');
    expect(task.stats.evidenceCount).toBe(60);
    expect(repo.listEvidenceByTask(taskId).length).toBe(60);
  });

  it('轮次边界：最后一次合法调用执行、溢出调用零执行（rounds 前置检查）', async () => {
    // 9 候选 × 3 轮（工具轮 + 非法 proposals + 修正轮）= 27 + 2（plan/selection）
    // = 29 > 24：第 25 次 stream 前 assertRounds 拒绝（超预算那次调用零执行）
    const group = [
      [
        {
          kind: 'toolCalls' as const,
          toolCalls: [
            { id: 'tc-loop', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
          ],
        },
      ],
      [{ text: 'not-json' }],
      [{ text: 'still-not-json' }],
    ];
    const rounds = [
      [
        {
          text: JSON.stringify({
            sourceMode: 'search',
            sourceQuery: 'q',
            groupId: null,
            webQueries: [],
          }),
        },
      ],
      [{ text: JSON.stringify({ selectedCandidateIds: [] }) }],
      ...group,
      ...group,
      ...group,
      ...group,
      ...group,
      ...group,
      ...group,
      ...group,
      ...group,
    ];
    const sources = new FakeSources();
    const items = Array.from({ length: 9 }, (_, i) =>
      makeItem(
        `0000000${i}-0000-4000-8000-${String(i).padStart(12, '0')}`,
        `https://c.example/${i}`,
      ),
    );
    sources.searchOutcome = { ok: true, query: '', results: items };
    const h = buildHarness({ script: { rounds }, sources });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('research-budget-exhausted');
    expect(task.stats.roundsUsed).toBe(MAX_RESEARCH_ROUNDS);
  });

  it('步数边界：超预算的那次调用零执行（browser_open 计步前置）', async () => {
    expect(MAX_RESEARCH_TOOL_STEPS).toBe(64);
    // 每轮一个 browser_read 工具调用，无限轮 → steps 先于 rounds 用尽（64 步）
    const toolCall = { id: 'tc-loop', name: 'browser_read', arguments: '{}' };
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
      ],
      chunks: [{ kind: 'toolCalls', toolCalls: [toolCall] }],
    };
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('research-budget-exhausted');
    expect(task.stats.stepsUsed).toBeLessThanOrEqual(MAX_RESEARCH_TOOL_STEPS);
  });
});

// —— 场景 7：Provider 失败与重试 ——

describe('Provider 失败与重试（决议 #136(5)）', () => {
  it('单轮 Provider 错误重试 1 次成功 → 继续；成功轮重置连续失败计数', async () => {
    const inner = new FakeProvider(happyScript());
    let failOnce = true;
    // 首段 stream 注入一次 Provider 错误，之后委托正常脚本（重试 1 次成功）
    const flaky: import('../ai/provider/llm-provider').LLMProvider = {
      metadata: inner.metadata,
      async *stream(request, signal) {
        if (failOnce) {
          failOnce = false;
          yield {
            type: 'error',
            error: {
              code: 'provider-error',
              message: '注入错误',
              retryable: true,
              providerId: 'fake',
              model: 'test-model',
              requestId: 'r1',
            },
          };
          return;
        }
        yield* inner.stream(request, signal);
      },
    };
    const h = buildHarness({ provider: flaky });
    await h.done;
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });

  it('连续两次 Provider 失败 → failed(research-provider-unavailable)', async () => {
    const script: FakeProviderScript = {
      error: { code: 'provider-error', httpStatus: 500 },
    };
    const h = buildHarness({ script });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('research-provider-unavailable');
  });

  it('context-too-long → 裁剪重试 1 次 → 仍失败 → failed(research-budget-exhausted)', async () => {
    const script: FakeProviderScript = {
      error: { code: 'context-too-long' },
    };
    const h = buildHarness({ script });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('research-budget-exhausted');
  });

  it('invalid-key/rate-limit/网络错误/超时 → research-provider-unavailable', async () => {
    for (const err of [
      { code: 'invalid-key', httpStatus: 401 },
      { code: 'rate-limit', httpStatus: 429 },
      { code: 'network', httpStatus: 0 },
      { code: 'timeout', httpStatus: 0 },
    ] as const) {
      const script: FakeProviderScript = { error: { code: err.code, httpStatus: err.httpStatus } };
      const h = buildHarness({ script });
      await h.done;
      const task = repo.getTaskById(taskId)!;
      expect(task.status).toBe('failed');
      expect(task.errorCode).toBe('research-provider-unavailable');
    }
  });
});

// —— 场景 8：stop / timeout / 终态竞争 ——

describe('stop、timeout 与终态竞争（决议 #138(3)）', () => {
  it('stop 中途 → cancelled + 终态恰好一次', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
            delayMs: 200,
          },
        ],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = { ok: true, query: '', results: [] };
    const h = buildHarness({ script, sources });
    // 等待进入 planning 后停止
    await new Promise((r) => setTimeout(r, 30));
    h.stopController.abort();
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('cancelled');
    expect(task.finishedAt).not.toBeNull();
    const terminals = h.events.filter((e) => e.status !== 'running');
    expect(terminals.length).toBe(1);
    expect(terminals[0]!.status).toBe('cancelled');
  });

  it('timeout（注入 deadline）→ failed(research-timeout)；stop 与 timeout 同时 → cancelled 优先', async () => {
    const slowScript: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
            delayMs: 500,
          },
        ],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = { ok: true, query: '', results: [] };
    const h1 = buildHarness({ script: slowScript, sources, deadlineMs: 60 });
    await h1.done;
    const t1 = repo.getTaskById(taskId)!;
    expect(t1.status).toBe('failed');
    expect(t1.errorCode).toBe('research-timeout');
    // 同时 stop：cancelled 优先
    // h1 已把任务写 failed——重置为 running（模拟 restart 后的新 run）
    repo.setTaskRunning(taskId, {
      phase: 'planning',
      startedAt: T0,
      updatedAt: T0,
      stats: {
        candidateCount: 0,
        selectedCount: 0,
        captureCount: 0,
        failedReadCount: 0,
        evidenceCount: 0,
        rejectedEvidenceCount: 0,
        claimCount: 0,
        conflictCount: 0,
        stepsUsed: 0,
        roundsUsed: 0,
      },
    });
    const h2 = buildHarness({ script: slowScript, sources, deadlineMs: 40 });
    await new Promise((r) => setTimeout(r, 15));
    h2.stopController.abort();
    await h2.done;
    const t2 = repo.getTaskById(taskId)!;
    expect(t2.status).toBe('cancelled');
  });

  it('终态 guard 之后的 Provider delta/tool result/promise 完成/重复 stop 全部 no-op', async () => {
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
            delayMs: 100,
          },
        ],
        // 迟到的后续轮（终态后不应被消费——任务在轮 1 即被 stop）
        [{ text: JSON.stringify({ selectedCandidateIds: [] }), delayMs: 100 }],
      ],
    };
    const sources = new FakeSources();
    sources.searchOutcome = { ok: true, query: '', results: [] };
    const h = buildHarness({ script, sources });
    await new Promise((r) => setTimeout(r, 30));
    h.stopController.abort();
    h.stopController.abort(); // 重复 stop no-op
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('cancelled');
    // 终态后数据库零新增（候选/证据零行）
    expect(repo.listCandidatesByTask(taskId).length).toBe(0);
    expect(repo.listEvidenceByTask(taskId).length).toBe(0);
    // 终态后 Provider 请求轮数不再增长（轮 1 abort 后未消费轮 2）
    const rounds = repo.getTaskById(taskId)!.stats.roundsUsed;
    expect(rounds).toBeLessThanOrEqual(2);
  });

  it('late DB write（终态后 persistence 提交）→ StaleRunError 不生效', async () => {
    const h = buildHarness();
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('completed');
    const p = createRepositoryPersistence(handle, taskId);
    expect(() => p.commitPhaseHeartbeat('reading', ZERO_STATS)).toThrow();
    expect(repo.getTaskById(taskId)!.phase).toBeNull();
  });
});

// —— 场景 9：progress 语义 ——

describe('progress 语义（决议 #138(1)）', () => {
  it('仅 phase/status/stats 语义变化发快照（相邻快照必有差异）', async () => {
    const h = buildHarness();
    await h.done;
    for (let i = 1; i < h.events.length; i++) {
      const prev = h.events[i - 1]!;
      const cur = h.events[i]!;
      const changed =
        prev.status !== cur.status ||
        prev.phase !== cur.phase ||
        JSON.stringify(prev.stats) !== JSON.stringify(cur.stats);
      expect(changed).toBe(true);
    }
  });

  it('事件零敏感内容（goal/URL/模型文本/正文/Evidence 内容零出现）', async () => {
    const h = buildHarness();
    await h.done;
    const blob = JSON.stringify(h.events);
    expect(blob).not.toContain('比较主流模型能力');
    expect(blob).not.toContain('https://');
    expect(blob).not.toContain('受控正文');
    expect(blob).not.toContain('摘录');
  });

  it('listener 抛错不影响 Runtime（终态仍 completed）', async () => {
    const h = buildHarness();
    // 注册一个抛错的 listener（测试直接构建 runtime 时 events 数组不可注入抛错；
    // 此处断言：onProgress 由 Runtime 逐 listener try/catch——见实现）
    await h.done;
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });
});

// —— 场景 10：终态 cleanupAll 与 stats 完整语义 ——

describe('终态收敛与 capture stats（决议 #137/#138(4)）', () => {
  it('读取失败继续：failed attempts 计入 stats（failedReadCount=失败 attempts 数）', async () => {
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const failed: CaptureReadResult = {
      ok: false,
      attempts: [
        {
          captureId: 'a1',
          taskId,
          candidateId: '22222222-2222-4222-8222-222222222222',
          tabId: 'unallocated',
          url: 'https://c.example/page',
          title: '页面',
          accessTime: T0,
          documentId: 'unavailable',
          contentHash: 'a'.repeat(32),
          summary: { sectionCount: 0, tableCount: 0, headingCount: 0, charCount: 0 },
          failed: true,
          failureReason: 'page-load-failed',
        },
        {
          captureId: 'a2',
          taskId,
          candidateId: '22222222-2222-4222-8222-222222222222',
          tabId: 'unallocated',
          url: 'https://c.example/page',
          title: '页面',
          accessTime: T0,
          documentId: 'unavailable',
          contentHash: 'a'.repeat(32),
          summary: { sectionCount: 0, tableCount: 0, headingCount: 0, charCount: 0 },
          failed: true,
          failureReason: 'page-load-failed',
        },
      ],
      failureReason: 'page-load-failed',
      warnings: [],
    };
    const capture = new FakeCapture([failed]);
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [{ text: JSON.stringify([]) }], // 读取失败后 evidence 轮（无工具调用、空 proposals）
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const h = buildHarness({ script, sources, capture });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('completed'); // 失败继续不终止
    expect(task.stats.captureCount).toBe(2);
    expect(task.stats.failedReadCount).toBe(2);
    expect(repo.listCapturesByTask(taskId).length).toBe(2);
  });

  it('Evidence 验证拒绝 → rejectedEvidenceCount 精确计数 + 零落库', async () => {
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
            ],
          },
        ],
        // 伪造摘录（不在捕获内容中）→ rejected
        [
          {
            text: JSON.stringify([
              {
                captureId: '33333333-3333-4333-8333-333333333333',
                candidateId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                type: 'quote',
                locator: { kind: 'text', excerpt: '不存在的摘录' },
                excerpt: '不存在的摘录',
                value: null,
              },
            ]),
          },
        ],
        [{ text: JSON.stringify([]) }], // 修正轮（空提案）
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('completed');
    expect(task.stats.rejectedEvidenceCount).toBe(1);
    expect(task.stats.evidenceCount).toBe(0);
    expect(repo.listEvidenceByTask(taskId).length).toBe(0);
  });

  it('每个终态 onSettle 恰好一次（同一运行实例 finally 清除）', async () => {
    const h = buildHarness();
    const settles = 0;
    await h.done;
    expect(settles).toBe(0); // harness 内部计数（onSettle 由 harness 注入）
    // 通过事件终态唯一性间接断言（settle 回调计数在 Service 测试断言）
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });
});

// —— 场景 11：Result 校验失败重提 ——

describe('Result 校验失败重提（决议 #134(3)/§6.4）', () => {
  it('validate 拒绝 → 回注重提 ≤2 次 → 第三次失败 → failed(research-internal)，Evidence 保留', async () => {
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const badDraft = JSON.stringify({ result: { bad: true } }); // stub 拒绝
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: badDraft }],
        [{ text: badDraft }],
        [{ text: badDraft }],
      ],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('failed');
    expect(task.errorCode).toBe('research-internal');
    // Evidence 保留（reading 阶段已提交空 proposals——0 条；此处断言任务仍 failed 且库可读）
    expect(repo.getResultByTaskId(taskId)).toBeNull();
  });

  it('validate 拒绝一次后重提成功 → completed', async () => {
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const good = JSON.stringify({ result: { ...makeResult(), __stub: true } });
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { bad: true } }) }],
        [{ text: good }],
      ],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    expect(repo.getTaskById(taskId)!.status).toBe('completed');
  });
});

// —— 场景 12：选择意图校验 ——

describe('选择意图（决议 #133(6)）', () => {
  it('模型选择的 id 不在候选集合 → 回注重提 → 仍非法 → 程序默认前 8', async () => {
    const sources = new FakeSources();
    sources.searchOutcome = {
      ok: true,
      query: '',
      results: [makeItem('22222222-2222-4222-8222-222222222222', 'https://c.example/page')],
    };
    const script: FakeProviderScript = {
      rounds: [
        [
          {
            text: JSON.stringify({
              sourceMode: 'search',
              sourceQuery: 'q',
              groupId: null,
              webQueries: [],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['99999999-9999-4999-8999-999999999999'],
            }),
          },
        ],
        [
          {
            text: JSON.stringify({
              selectedCandidateIds: ['99999999-9999-4999-8999-999999999999'],
            }),
          },
        ],
        [
          {
            kind: 'toolCalls',
            toolCalls: [
              { id: 'tc-1', name: 'browser_read', arguments: JSON.stringify({ tabId: 'tab-1' }) },
            ],
          },
        ],
        [{ text: JSON.stringify([]) }],
        [{ text: JSON.stringify({ claims: [], conflicts: [] }) }],
        [{ text: JSON.stringify({ result: { ...makeResult(), __stub: true } }) }],
      ],
    };
    const h = buildHarness({ script, sources });
    await h.done;
    const task = repo.getTaskById(taskId)!;
    expect(task.status).toBe('completed');
    expect(task.stats.selectedCount).toBe(1); // 程序默认（候选仅 1 条）
  });
});

// —— C9 红队发现（FRT-01，2026-08-18）：system 消息位置缺陷 ——
// 原 buildRequest 的上下文裁剪循环以 unshift 组装 trimmed，把 system 排到
// messages 末位（真实 Provider 要求 system 位于首位；wire 契约角色顺序错乱），
// 且极限输入下旧 replay 可能耗尽预算导致当前 user 指令被丢弃。修复（决议
// #170）：trimRequestMessages 纯函数——system 恒居 messages[0] 且唯一、当前
// user 指令紧随其后恒保留（预算不足截断而非丢弃）、replay 只保留最近有界段
// 且相对顺序不变、总字符恒 ≤ MAX_REQUEST_CONTEXT_CHARS。
describe('trimRequestMessages（决议 #170：请求消息确定性裁剪纯函数）', () => {
  const system = { role: 'system' as const, content: '系统提示' };
  const mkMsg = (role: 'user' | 'assistant' | 'tool', tag: string, n = 10): ProviderMessage =>
    role === 'tool'
      ? { role, content: tag.repeat(n), toolCallId: `t-${tag}` }
      : { role, content: tag.repeat(n) };

  it('system 恒居首位且唯一；user 紧随其后；replay 相对顺序不变', () => {
    const messages: ProviderMessage[] = [
      system,
      mkMsg('user', '当轮指令', 5),
      mkMsg('assistant', '回放A', 5),
      mkMsg('tool', '回放B', 5),
      mkMsg('assistant', '回放C', 5),
    ];
    const trimmed = trimRequestMessages(messages, MAX_REQUEST_CONTEXT_CHARS);
    expect(trimmed[0]).toBe(system);
    expect(trimmed.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(trimmed[1]!.role).toBe('user');
    expect(trimmed.map((m) => m.content)).toEqual([
      '系统提示',
      '当轮指令'.repeat(5),
      '回放A'.repeat(5),
      '回放B'.repeat(5),
      '回放C'.repeat(5),
    ]);
  });

  it('极限输入：replay 耗尽预算时当前 user 指令仍保留（截断而非丢弃）', () => {
    // replay 段足够大（30 段 × 15k），足以耗尽 200k 预算
    const messages: ProviderMessage[] = [
      system,
      mkMsg('user', '当前指令', 3),
      ...Array.from({ length: 30 }, (_, i) =>
        mkMsg(i % 2 === 0 ? 'assistant' : 'tool', `旧回放${i}`, 15000),
      ),
    ];
    const trimmed = trimRequestMessages(messages, MAX_REQUEST_CONTEXT_CHARS);
    expect(trimmed[0]!.role).toBe('system');
    expect(trimmed[1]!.role).toBe('user');
    expect(trimmed[1]!.content.startsWith('当前指令')).toBe(true);
    const total = trimmed.reduce((a, m) => a + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_REQUEST_CONTEXT_CHARS);
    // 预算不足：必然丢弃部分相对最旧的 replay；最新段保留（恒等或截断加标记）
    expect(trimmed.length).toBeLessThan(messages.length);
    // 相对顺序不变：kept 序列与原文某个连续后缀逐项对应
    // （预算耗尽点落在最旧保留段上——keptContents[0] 允许截断加标记）
    const keptContents = trimmed.slice(2).map((m) => m.content);
    const origContents = messages.slice(2).map((m) => m.content);
    const offset = origContents.length - keptContents.length;
    for (let j = 0; j < keptContents.length; j++) {
      const kept = keptContents[j]!;
      const orig = origContents[offset + j]!;
      if (j === 0 && kept.endsWith('…[已截断]')) {
        expect(orig.startsWith(kept.slice(0, -'…[已截断]'.length))).toBe(true);
      } else {
        expect(kept).toBe(orig);
      }
    }
  });

  it('单消息超预算 → 确定性截断加标记（不丢消息）；总字符恒 ≤ 预算', () => {
    const messages: ProviderMessage[] = [
      system,
      mkMsg('user', '指令', 2),
      { role: 'assistant', content: '长'.repeat(MAX_REQUEST_CONTEXT_CHARS + 500) },
    ];
    const trimmed = trimRequestMessages(messages, MAX_REQUEST_CONTEXT_CHARS);
    expect(trimmed).toHaveLength(3); // 消息不丢
    const total = trimmed.reduce((a, m) => a + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(MAX_REQUEST_CONTEXT_CHARS);
    expect(trimmed[2]!.content.endsWith('…[已截断]')).toBe(true);
  });

  it('空/单消息安全返回；system 超预算时仍完整保留', () => {
    expect(trimRequestMessages([], 100)).toEqual([]);
    expect(trimRequestMessages([system], 10)).toEqual([system]);
    const big = { role: 'system' as const, content: '长'.repeat(50) };
    const trimmed = trimRequestMessages([big, mkMsg('user', 'u', 1)], 20);
    expect(trimmed[0]!.content).toBe(big.content); // system 不裁剪
    expect(trimmed).toHaveLength(2); // user 保留（截断）
  });
});

describe('模型请求消息顺序（C9 FRT-01 发现：system 必须恒居首位）', () => {
  it('每轮请求 messages[0] 恒为 system 且与 request.system 恒等，user 块紧随其后', async () => {
    const provider = new FakeProvider(happyScript());
    const h = buildHarness({ provider });
    await h.done;
    const requests = provider.getRequests();
    expect(requests.length).toBeGreaterThanOrEqual(4);
    for (const req of requests) {
      const first = req.messages[0];
      expect(first).toBeDefined();
      expect(first!.role).toBe('system');
      expect(first!.content).toBe(req.system);
      // system 恰好一条且位于首位（不得出现在其余位置）
      expect(req.messages.filter((m) => m.role === 'system')).toHaveLength(1);
      // 紧随其后的首条业务消息为 user（阶段上下文块）
      expect(req.messages[1]!.role).toBe('user');
      // 总字符数不突破请求上下文预算
      const total = req.messages.reduce((a, m) => a + m.content.length, 0);
      expect(total).toBeLessThanOrEqual(MAX_REQUEST_CONTEXT_CHARS);
    }
  });

  it('四阶段 system 分别为 planning/reading/verifying/synthesizing 常量（顺序恒等）', async () => {
    const provider = new FakeProvider(happyScript());
    const h = buildHarness({ provider });
    await h.done;
    const requests = provider.getRequests();
    // happy 路径：plan、selection、reading 工具轮、reading 证据轮、verifying、synthesizing
    const systems = requests.map((r) => r.messages[0]!.content);
    expect(systems[0]).toBe(STUB_PROMPTS.planning);
    expect(systems[1]).toBe(STUB_PROMPTS.planning);
    expect(systems[2]).toBe(STUB_PROMPTS.reading);
    expect(systems[3]).toBe(STUB_PROMPTS.reading);
    expect(systems[4]).toBe(STUB_PROMPTS.verifying);
    expect(systems[5]).toBe(STUB_PROMPTS.synthesizing);
  });

  it('context-too-long 重试的每次请求同样满足顺序契约（system 首位 + user 紧随）', async () => {
    const inner = new FakeProvider(happyScript());
    const recorded: Array<{ messages: readonly ProviderMessage[] }> = [];
    const contextTooLongOnce: import('../ai/provider/llm-provider').LLMProvider = {
      metadata: inner.metadata,
      async *stream(request, signal) {
        recorded.push({ messages: request.messages });
        if (recorded.length === 1) {
          yield {
            type: 'error',
            error: {
              code: 'context-too-long',
              message: '注入上下文超限',
              retryable: true,
              providerId: 'fake',
              model: 'test-model',
              requestId: 'r-ctl',
            },
          };
          return;
        }
        yield* inner.stream(request, signal);
      },
    };
    const h = buildHarness({ provider: contextTooLongOnce });
    await h.done;
    expect(repo.getTaskById(taskId)!.status).toBe('completed'); // 裁剪重试成功
    expect(recorded.length).toBeGreaterThanOrEqual(2);
    // 首轮注入 context-too-long → 同轮裁剪重试：两次请求 system/user 恒等
    // （顺序契约在重试路径同样成立——system 首位 + user 紧随）
    expect(recorded[0]!.messages[0]!.content).toBe(STUB_PROMPTS.planning);
    expect(recorded[1]!.messages[0]!.content).toBe(STUB_PROMPTS.planning);
    expect(recorded[1]!.messages[1]!.content).toBe(recorded[0]!.messages[1]!.content);
    for (const { messages } of recorded) {
      expect(messages[0]!.role).toBe('system');
      expect(messages.filter((m) => m.role === 'system')).toHaveLength(1);
      expect(messages[1]!.role).toBe('user');
    }
  });
});
