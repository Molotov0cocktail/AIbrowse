// C8 research-ipc 八通道红→绿测试（决议 #156/#157/#162）：payload 严格白名单
// fail-closed（未知字段/原型链键/非法 UUID/NaN·Infinity·非整数/分页边界）/
// service=null·unavailable 全拒/每次 create/start/stop/delete/export 尝试恰好
// 一条脱敏审计（goal 长度/taskId/统计/导出块索引·行列计数/结果码——URL·摘录·
// 标题·路径·文件名·单元格零出现）/export payload 无 path·rows·content 通道/
// CSV 主进程重投影 + 写字节断言（BOM/CRLF/公式防护/当前视图一致性/Evidence
// 零出现）/非 table 块·越界·错误任务·非 completed·取消·write 失败·非法扩展名。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, closeDb, type DbHandle } from '../sources/db/sqlite-driver';
import { runResearchMigrations } from './db/research-migrations';
import { ResearchRepository, type ResearchEvidenceRow } from './repository/research-repository';
import { ResearchServiceImpl } from './research-service';
import {
  createResearchIpcAdapter,
  validateResearchCreatePayload,
  validateResearchExportCsvPayload,
  validateResearchListPayload,
  validateResearchTaskIdPayload,
  type ResearchExportPort,
  type ResearchIpcAdapter,
  type ResearchIpcAdapterOptions,
} from './research-ipc';
import type { ResearchResultView, ResearchTask } from '../../shared/types/research';
import { MAX_GOAL_CHARS } from '../../shared/types/research';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-research-ipc-'));

let handle: DbHandle;
let repo: ResearchRepository;
let svc: ResearchServiceImpl;
let audits: string[];
let ipc: ResearchIpcAdapter;
let exportDir: string;

// 确定性 completed 任务 + Result（table 块）+ 候选 + Evidence fixture
const TASK_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const CAND_ID = 'bbbbbbbb-1111-4111-8111-111111111111';
const EV_ID = 'cccccccc-1111-4111-8111-111111111111';
const RESULT_ID = 'dddddddd-1111-4111-8111-111111111111';

const TASK_STATS = {
  candidateCount: 1,
  selectedCount: 1,
  captureCount: 1,
  failedReadCount: 0,
  evidenceCount: 1,
  rejectedEvidenceCount: 0,
  claimCount: 0,
  conflictCount: 0,
  stepsUsed: 0,
  roundsUsed: 0,
};

function makeCompletedFixture(): void {
  const now = '2026-08-16T00:00:00.000Z';
  const task: ResearchTask = {
    id: TASK_ID,
    goal: 'fixture 目标',
    status: 'completed',
    phase: null,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    finishedAt: now,
    interruptedAt: null,
    errorCode: null,
    resultId: RESULT_ID,
    stats: { ...TASK_STATS },
  };
  withTx(() => {
    repo.insertTask({
      id: task.id,
      goal: task.goal,
      status: task.status,
      phase: null,
      created_at: now,
      updated_at: now,
      started_at: now,
      finished_at: now,
      interrupted_at: null,
      error_code: null,
      result_id: RESULT_ID,
      stats_json: JSON.stringify(TASK_STATS),
    });
    repo.insertCandidate({
      candidate_id: CAND_ID,
      task_id: TASK_ID,
      url: 'https://example.com/one',
      display_url: 'https://example.com/one',
      title: '候选一',
      canonical_key: 'https://example.com/one',
      scope: 'page',
      discovered_via_json: JSON.stringify(['sources']),
      source_id: null,
      trust_value: null,
      trust_asserted_by: null,
      trust_verification: null,
      priority: null,
      last_used_at: null,
      note: null,
      sort_key: '01|00000|9|~~~~~~~~~~~~~~~~~~~~~~~~|1|https://example.com/one|' + CAND_ID,
    });
    const evidence: ResearchEvidenceRow = {
      evidence_id: EV_ID,
      task_id: TASK_ID,
      candidate_id: CAND_ID,
      source_id: null,
      capture_id: 'capture-1',
      url: 'https://example.com/one',
      title: '候选一',
      access_time: now,
      document_id: '1',
      content_hash: 'hash',
      type: 'quote',
      locator_json: JSON.stringify({ kind: 'text', excerpt: '摘录一' }),
      excerpt: '摘录一',
      value: null,
      verification: 'verified',
    };
    repo.insertEvidence(evidence);
    repo.insertResult({
      result_id: RESULT_ID,
      task_id: TASK_ID,
      title: '结果标题',
      summary: '结果摘要',
      blocks_json: JSON.stringify([
        {
          kind: 'table',
          columns: ['名称', '数值'],
          rows: [
            ['甲', '1'],
            ['乙', '2'],
          ],
          sourceRefs: [CAND_ID],
        },
        { kind: 'markdown', text: '正文' },
      ]),
      evidence_map_json: JSON.stringify({
        [EV_ID]: {
          candidateId: CAND_ID,
          url: 'https://example.com/one',
          title: '候选一',
          accessTime: now,
        },
      }),
      conflicts_json: JSON.stringify([]),
      coverage_json: JSON.stringify({
        total: 0,
        multiSource: 0,
        singleSource: 0,
        vendor: 0,
        thirdParty: 0,
        community: 0,
      }),
      fetched_at: now,
    });
  });
}

function withTx(fn: () => void): void {
  handle.exec('BEGIN');
  try {
    fn();
    handle.exec('COMMIT');
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

function buildIpc(over: Partial<ResearchIpcAdapterOptions> = {}): ResearchIpcAdapter {
  audits = [];
  return createResearchIpcAdapter({
    service: svc,
    audit: (m) => audits.push(m),
    exportPort: {
      showSaveDialog: async () => null,
      writeCsv: async () => undefined,
    },
    ...over,
  });
}

beforeEach(() => {
  const dbPath = join(root, `ipc-${Math.random().toString(36).slice(2)}.db`);
  handle = openDb(dbPath);
  runResearchMigrations(handle);
  repo = new ResearchRepository(handle);
  svc = new ResearchServiceImpl({ db: handle, now: () => Date.now() });
  exportDir = mkdtempSync(join(tmpdir(), 'aibrowse-research-ipc-csv-'));
  ipc = buildIpc();
});

afterEach(() => {
  svc.dispose();
  closeDb(handle);
  try {
    rmSync(exportDir, { recursive: true, force: true });
  } catch {
    // 尽力清理
  }
});

afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // 尽力清理
  }
});

// ---------- payload 白名单（决议 #156(2)） ----------

describe('payload 严格白名单（决议 #156(2)/(3)/(4)）', () => {
  it('create：goal trim 非空 ≤MAX_GOAL_CHARS；超长/空/非串/未知字段/原型键拒绝', () => {
    expect(validateResearchCreatePayload({ goal: '研究目标' }).ok).toBe(true);
    expect(validateResearchCreatePayload({ goal: '  研究目标  ' }).ok).toBe(true);
    expect(validateResearchCreatePayload({ goal: '' }).ok).toBe(false);
    expect(validateResearchCreatePayload({ goal: '   ' }).ok).toBe(false);
    expect(validateResearchCreatePayload({ goal: 42 }).ok).toBe(false);
    expect(validateResearchCreatePayload({ goal: null }).ok).toBe(false);
    expect(validateResearchCreatePayload({}).ok).toBe(false);
    expect(validateResearchCreatePayload({ goal: 'x', extra: 1 }).ok).toBe(false);
    // 原型链键（真实攻击面：JSON.parse 的 __proto__ 为自身属性——字面量形态
    // 会被 JS 语义吸收，故用 JSON.parse 构造）
    const proto = JSON.parse('{"goal":"x","__proto__":{}}');
    expect(validateResearchCreatePayload(proto).ok).toBe(false);
    expect(validateResearchCreatePayload({ goal: 'x', constructor: {} }).ok).toBe(false);
    expect(validateResearchCreatePayload({ goal: '长'.repeat(MAX_GOAL_CHARS + 1) }).ok).toBe(false);
    expect(validateResearchCreatePayload(null).ok).toBe(false);
    expect(validateResearchCreatePayload('goal').ok).toBe(false);
  });

  it('taskId 通道：非法 UUID/未知字段/NaN/Infinity/非对象拒绝', () => {
    for (const bad of [
      { taskId: 'not-a-uuid' },
      { taskId: 'aaaaaaaa-1111-4111-8111-111111111111', extra: 1 },
      { taskId: '' },
      { taskId: 42 },
      { taskId: NaN },
      { taskId: Infinity },
      { taskId: null },
      {},
      null,
      'taskId',
    ]) {
      expect(validateResearchTaskIdPayload(bad).ok).toBe(false);
    }
    expect(
      validateResearchTaskIdPayload({ taskId: 'aaaaaaaa-1111-4111-8111-111111111111' }).ok,
    ).toBe(true);
  });

  it('list：page 1-based ≥1、pageSize 1..20 严格拒绝（不依赖 Service clamp 洗白）', () => {
    expect(validateResearchListPayload({ page: 1 }).ok).toBe(true);
    expect(validateResearchListPayload({ page: 1, pageSize: 20 }).ok).toBe(true);
    expect(validateResearchListPayload({ page: 2, pageSize: 1 }).ok).toBe(true);
    for (const bad of [
      { page: 0 },
      { page: -1 },
      { page: 1.5 },
      { page: NaN },
      { page: Infinity },
      { page: '1' },
      { pageSize: 0 },
      { pageSize: 21 },
      { pageSize: 1.5 },
      { pageSize: NaN },
      { page: 1, pageSize: '20' },
      { page: 1, pageSize: 20, extra: 1 },
      { page: 1, status: 'bogus' },
      // 决议 #164：status 不属 IPC 暴露面——即使合法枚举值也作为未知字段
      // fail-closed 拒绝（Service 内部 status 筛选能力保留，不经 IPC 暴露）
      { page: 1, status: 'completed' },
      { page: 1, pageSize: 10, status: 'running' },
      { page: 1, status: null },
      {},
      null,
    ]) {
      expect(validateResearchListPayload(bad).ok).toBe(false);
    }
  });

  it('export-csv：payload 只允许 {taskId, tableBlockIndex, view}——path/rows/content/文件名零通道', () => {
    const good = {
      taskId: TASK_ID,
      tableBlockIndex: 0,
      view: { sort: { columnIndex: 1, direction: 'desc' }, filter: '' },
    };
    expect(validateResearchExportCsvPayload(good).ok).toBe(true);
    expect(
      validateResearchExportCsvPayload({ ...good, view: { sort: null, filter: 'x' } }).ok,
    ).toBe(true);
    for (const bad of [
      { ...good, path: 'C:\\evil.csv' },
      { ...good, rows: [['a']] },
      { ...good, content: 'x' },
      { ...good, fileName: 'x.csv' },
      { ...good, extra: 1 },
      { taskId: 'bad', tableBlockIndex: 0, view: good.view },
      { taskId: TASK_ID, tableBlockIndex: -1, view: good.view },
      { taskId: TASK_ID, tableBlockIndex: 1.5, view: good.view },
      { taskId: TASK_ID, tableBlockIndex: NaN, view: good.view },
      {
        taskId: TASK_ID,
        tableBlockIndex: 0,
        view: { sort: { columnIndex: -1, direction: 'asc' }, filter: '' },
      },
      {
        taskId: TASK_ID,
        tableBlockIndex: 0,
        view: { sort: { columnIndex: 1.5, direction: 'asc' }, filter: '' },
      },
      {
        taskId: TASK_ID,
        tableBlockIndex: 0,
        view: { sort: { columnIndex: 0, direction: 'sideways' }, filter: '' },
      },
      {
        taskId: TASK_ID,
        tableBlockIndex: 0,
        view: { sort: null, filter: 'x'.repeat(201) },
      },
      { taskId: TASK_ID, tableBlockIndex: 0, view: null },
      { taskId: TASK_ID, tableBlockIndex: 0 },
      {},
      null,
    ]) {
      expect(validateResearchExportCsvPayload(bad).ok).toBe(false);
    }
  });
});

// ---------- 通道行为（真实 service + 真实库） ----------

describe('八通道行为（真实 service；决议 #156/#157/#162）', () => {
  it('create→get→list→delete 全链路 + 审计恰好一条', async () => {
    const created = await ipc.create({ goal: '八通道目标' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.value.task.id;
    expect(audits.filter((a) => a.includes('op=create')).length).toBe(1);

    const got = await ipc.get({ taskId });
    expect(got.ok).toBe(true);
    if (!got.ok) return;

    const list1 = await ipc.list({ page: 1, pageSize: 20 });
    expect(list1.ok).toBe(true);
    if (!list1.ok) return;
    expect(list1.value.total).toBeGreaterThanOrEqual(1);
    expect(list1.value.items.map((t) => t.id)).toContain(taskId);

    const deleted = await ipc.delete({ taskId });
    expect(deleted.ok).toBe(true);
    expect(audits.filter((a) => a.includes('op=delete')).length).toBe(1);

    const gone = await ipc.get({ taskId });
    expect(gone.ok).toBe(false);
    if (!gone.ok) expect(gone.errorCode).toBe('research-not-found');
  });

  it('list：renderer payload 携带 status → 未知字段 fail-closed 拒绝（决议 #164）', async () => {
    // status 不属 IPC 暴露面（§11 冻结 {page, pageSize≤20}）——即使合法枚举值
    // 也拒绝；正常分页不回归
    const withStatus = { page: 1, pageSize: 20, status: 'completed' } as unknown as Parameters<
      ResearchIpcAdapter['list']
    >[0];
    const rejected = await ipc.list(withStatus);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.errorCode).toBe('research-invalid-goal');
    const normal = await ipc.list({ page: 1, pageSize: 20 });
    expect(normal.ok).toBe(true);
  });

  it('start：未装配 Runtime → 前置拒绝 research-runtime-unavailable + 审计恰好一条 + 任务保持 created', async () => {
    const created = await ipc.create({ goal: '失败保留目标' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = await ipc.start({ taskId: created.value.task.id });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.errorCode).toBe('research-runtime-unavailable');
    expect(audits.filter((a) => a.includes('op=start')).length).toBe(1);
    const got = await ipc.get({ taskId: created.value.task.id });
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.task.status).toBe('created');
  });

  it('service=null → 五个写操作各自恰好一条脱敏审计；get/result/list 零写审计（决议 #162(8)）', async () => {
    const nullIpc = createResearchIpcAdapter({
      service: null,
      audit: (m) => audits.push(m),
      exportPort: { showSaveDialog: async () => null, writeCsv: async () => undefined },
    });
    const auditByOp = (op: string): string[] => audits.filter((a) => a.includes(`op=${op}`));

    // 只读操作：fail-closed 返回但零写审计（保持非写操作）
    expect((await nullIpc.get({ taskId: TASK_ID })).ok).toBe(false);
    expect((await nullIpc.result({ taskId: TASK_ID })).ok).toBe(false);
    expect((await nullIpc.list({ page: 1 })).ok).toBe(false);

    // 写操作全部 fail-closed：普通 Research 操作 → research-unavailable；export
    // 保持既有安全映射 internal（ExportCsvErrorCode 闭合联合无 research-unavailable）
    const created = await nullIpc.create({ goal: '敏感目标内容-abc123' });
    expect(created.ok).toBe(false);
    if (!created.ok) expect(created.errorCode).toBe('research-unavailable');
    const started = await nullIpc.start({ taskId: TASK_ID });
    expect(started.ok).toBe(false);
    if (!started.ok) expect(started.errorCode).toBe('research-unavailable');
    const stopped = await nullIpc.stop({ taskId: TASK_ID });
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) expect(stopped.errorCode).toBe('research-unavailable');
    const deleted = await nullIpc.delete({ taskId: TASK_ID });
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) expect(deleted.errorCode).toBe('research-unavailable');
    const exported = await nullIpc.exportCsv({
      taskId: TASK_ID,
      tableBlockIndex: 0,
      view: { sort: null, filter: '' },
    });
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.errorCode).toBe('internal');

    // 五个写操作各自恰好一条；只读不新增 → 总审计恰 5
    for (const op of ['create', 'start', 'stop', 'delete', 'export']) {
      expect(auditByOp(op).length).toBe(1);
    }
    expect(audits.length).toBe(5);

    // create：goalLen 仅记长度 + result=research-unavailable（goal 正文零出现）
    const createAudit = auditByOp('create')[0]!;
    expect(createAudit).toContain('goalLen=');
    expect(createAudit).toContain('result=research-unavailable');
    expect(createAudit).not.toContain('敏感目标内容');
    expect(createAudit).not.toContain('abc123');

    // start/stop/delete：taskId 记录 + result=research-unavailable
    for (const op of ['start', 'stop', 'delete']) {
      const audit = auditByOp(op)[0]!;
      expect(audit).toContain(TASK_ID);
      expect(audit).toContain('result=research-unavailable');
    }

    // export：taskId + block 索引记录 + result=internal（导出面安全映射）
    const exportAudit = auditByOp('export')[0]!;
    expect(exportAudit).toContain(TASK_ID);
    expect(exportAudit).toContain('block=0');
    expect(exportAudit).toContain('result=internal');

    // 全量脱敏：URL/Evidence/Result/路径/文件名/单元格零出现
    for (const audit of audits) {
      expect(audit).not.toContain('https://');
      expect(audit).not.toContain('摘录');
      expect(audit).not.toContain('C:');
      expect(audit).not.toContain('.csv');
    }
  });

  it('result：completed + Result 存在 → 安全视图（Evidence DTO 仅下钻必需字段）', async () => {
    makeCompletedFixture();
    const res = await ipc.result({ taskId: TASK_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const view: ResearchResultView = res.value.view;
    expect(view.task.id).toBe(TASK_ID);
    expect(view.result.resultId).toBe(RESULT_ID);
    expect(view.result.taskId).toBe(TASK_ID);
    expect(view.evidence.length).toBe(1);
    const ev = view.evidence[0]!;
    expect(ev.evidenceId).toBe(EV_ID);
    expect(ev.candidateId).toBe(CAND_ID);
    expect(ev.url).toBe('https://example.com/one');
    expect(ev.excerpt).toBe('摘录一');
    expect(ev.verification).toBe('verified');
    // DTO 不暴露无 UI 需要的内部字段（决议 #157(9)：documentId/contentHash/captureId/sourceId 零出现；
    // 决议 #165：provenance 为 UI 必需展示字段——候选发现路径 + trust 三元组）
    const keys = Object.keys(ev).sort();
    expect(keys).toEqual(
      [
        'accessTime',
        'candidateId',
        'evidenceId',
        'excerpt',
        'locator',
        'provenance',
        'title',
        'type',
        'url',
        'value',
        'verification',
      ].sort(),
    );
  });

  it('result：非 completed → research-invalid-state；不存在 → not-found', async () => {
    const created = await svc.createTask('created 任务');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const res = await ipc.result({ taskId: created.task.id });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errorCode).toBe('research-invalid-state');

    const missing = await ipc.result({ taskId: 'ffffffff-1111-4111-8111-111111111111' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errorCode).toBe('research-not-found');
  });

  it('export-csv：主进程重投影当前视图 + 写字节断言（BOM/CRLF/当前视图一致性/Evidence 零出现）', async () => {
    makeCompletedFixture();
    const port: ResearchExportPort = {
      showSaveDialog: async () => join(exportDir, 'research-export.csv'),
      writeCsv: async (path, bytes) => {
        writeFileSync(path, bytes);
      },
    };
    const adapter = buildIpc({ exportPort: port });

    // view：按第 0 列降序 + 筛选「甲」
    const res = await adapter.exportCsv({
      taskId: TASK_ID,
      tableBlockIndex: 0,
      view: { sort: { columnIndex: 0, direction: 'desc' }, filter: '甲' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toBe(1);
    expect(res.columns).toBe(2);

    const bytes = readFileSync(join(exportDir, 'research-export.csv'));
    const text = bytes.toString('utf8');
    // BOM
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    // CRLF + header 行（逗号分隔） + 当前视图行
    expect(text).toContain('名称,数值\r\n');
    expect(text).toContain('甲,1\r\n');
    expect(text).not.toContain('乙');
    // Evidence 摘录/候选标题/URL 元数据/Result 标题摘要零出现
    expect(text).not.toContain('摘录一');
    expect(text).not.toContain('候选一');
    expect(text).not.toContain('https://example.com');
    expect(text).not.toContain('结果标题');
    expect(text).not.toContain('结果摘要');
    // 审计恰好一条且只记 taskId/块索引/行列/结果码——URL/摘录/路径零出现
    const expAudits = audits.filter((a) => a.includes('op=export'));
    expect(expAudits.length).toBe(1);
    expect(expAudits[0]).toContain(TASK_ID);
    expect(expAudits[0]).not.toContain('https://');
    expect(expAudits[0]).not.toContain('摘录');
    expect(expAudits[0]).not.toContain('C:');
    expect(expAudits[0]).not.toContain('research-export.csv');
  });

  it('export-csv：公式注入防护字节级断言（=,+,-,@、TAB、CR 前缀加单引号）', async () => {
    // 用模型可控单元格构造 Result：=cmd|/C、+1+2、-1+1、@SUM、TAB、CR 前缀
    withTx(() => {
      repo.insertTask({
        id: 'eeeeeeee-1111-4111-8111-111111111111',
        goal: '公式防护目标',
        status: 'completed',
        phase: null,
        created_at: '2026-08-16T00:00:00.000Z',
        updated_at: '2026-08-16T00:00:00.000Z',
        started_at: '2026-08-16T00:00:00.000Z',
        finished_at: '2026-08-16T00:00:00.000Z',
        interrupted_at: null,
        error_code: null,
        result_id: 'eeeeeeee-2222-4222-8222-222222222222',
        stats_json: JSON.stringify(TASK_STATS),
      });
      repo.insertResult({
        result_id: 'eeeeeeee-2222-4222-8222-222222222222',
        task_id: 'eeeeeeee-1111-4111-8111-111111111111',
        title: 't',
        summary: 's',
        blocks_json: JSON.stringify([
          {
            kind: 'table',
            columns: ['值'],
            rows: [
              ['=cmd|/C calc'],
              ['+1+2'],
              ['-1+1'],
              ['@SUM(1,2)'],
              ['\t前导TAB'],
              ['\r前导CR'],
            ],
            sourceRefs: [],
          },
        ]),
        evidence_map_json: JSON.stringify({}),
        conflicts_json: JSON.stringify([]),
        coverage_json: JSON.stringify({
          total: 0,
          multiSource: 0,
          singleSource: 0,
          vendor: 0,
          thirdParty: 0,
          community: 0,
        }),
        fetched_at: '2026-08-16T00:00:00.000Z',
      });
    });
    const port: ResearchExportPort = {
      showSaveDialog: async () => join(exportDir, 'formula.csv'),
      writeCsv: async (path, bytes) => {
        writeFileSync(path, bytes);
      },
    };
    const adapter = buildIpc({ exportPort: port });
    const res = await adapter.exportCsv({
      taskId: 'eeeeeeee-1111-4111-8111-111111111111',
      tableBlockIndex: 0,
      view: { sort: null, filter: '' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const text = readFileSync(join(exportDir, 'formula.csv'), 'utf8');
    expect(text).toContain("'=cmd|/C calc");
    expect(text).toContain("'+1+2");
    expect(text).toContain("'-1+1");
    // @SUM 含逗号 → 防护后按 RFC 4180 整体双引号包裹（防护先于 quoting）
    expect(text).toContain('"' + "'@SUM(1,2)" + '"');
    expect(text).toContain("'\t前导TAB");
    // CR 前缀 → 防护 + 引用（含 \r 触发 quoting）
    expect(text).toContain('"' + "'\r前导CR" + '"');
  });

  it('export-csv：非 table 块索引/越界 → 拒绝零写入；任务不存在 → not-found；取消 → cancelled 零写入 + 恰好一条审计', async () => {
    makeCompletedFixture();
    const written: string[] = [];
    const port: ResearchExportPort = {
      showSaveDialog: async () => join(exportDir, 'x.csv'),
      writeCsv: async (path) => {
        written.push(path);
      },
    };
    const adapter = buildIpc({ exportPort: port });

    // index=1 是 markdown 块 → invalid-block
    const bad = await adapter.exportCsv({
      taskId: TASK_ID,
      tableBlockIndex: 1,
      view: { sort: null, filter: '' },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errorCode).toBe('invalid-block');
    expect(written.length).toBe(0);

    // 越界 → invalid-block
    const oob = await adapter.exportCsv({
      taskId: TASK_ID,
      tableBlockIndex: 99,
      view: { sort: null, filter: '' },
    });
    expect(oob.ok).toBe(false);
    if (!oob.ok) expect(oob.errorCode).toBe('invalid-block');

    // 不存在 → not-found
    const missing = await adapter.exportCsv({
      taskId: 'ffffffff-1111-4111-8111-111111111111',
      tableBlockIndex: 0,
      view: { sort: null, filter: '' },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errorCode).toBe('not-found');

    // 取消 → cancelled 零写入 + 恰好一条审计
    const cancelPort: ResearchExportPort = {
      showSaveDialog: async () => null,
      writeCsv: async () => undefined,
    };
    const cancelAdapter = buildIpc({ exportPort: cancelPort });
    const cancelled = await cancelAdapter.exportCsv({
      taskId: TASK_ID,
      tableBlockIndex: 0,
      view: { sort: null, filter: '' },
    });
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.errorCode).toBe('cancelled');
    const cancelAudits = audits.filter((a) => a.includes('op=export'));
    expect(cancelAudits.length).toBe(1);
    expect(cancelAudits[0]).toContain('cancelled');
  });

  it('export-csv：write 失败 → write-failed；dialog 返回非 .csv → invalid-payload 零写入', async () => {
    makeCompletedFixture();
    const failPort: ResearchExportPort = {
      showSaveDialog: async () => join(exportDir, 'x.csv'),
      writeCsv: async () => {
        throw new Error('disk full');
      },
    };
    const failAdapter = buildIpc({ exportPort: failPort });
    const failed = await failAdapter.exportCsv({
      taskId: TASK_ID,
      tableBlockIndex: 0,
      view: { sort: null, filter: '' },
    });
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.errorCode).toBe('write-failed');

    const badExtPort: ResearchExportPort = {
      showSaveDialog: async () => join(exportDir, 'x.txt'),
      writeCsv: async () => undefined,
    };
    const badExtAdapter = buildIpc({ exportPort: badExtPort });
    const badExt = await badExtAdapter.exportCsv({
      taskId: TASK_ID,
      tableBlockIndex: 0,
      view: { sort: null, filter: '' },
    });
    expect(badExt.ok).toBe(false);
    if (!badExt.ok) expect(badExt.errorCode).toBe('invalid-payload');
  });

  it('审计脱敏：create 审计只记 goal 长度（goal/URL/path/title/excerpt/cell 零出现）', async () => {
    const created = await ipc.create({ goal: '敏感目标内容-abc123' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const createAudits = audits.filter((a) => a.includes('op=create'));
    expect(createAudits.length).toBe(1);
    expect(createAudits[0]).not.toContain('敏感目标内容');
    expect(createAudits[0]).not.toContain('abc123');
    expect(createAudits[0]).toContain('goalLen');
  });
});
