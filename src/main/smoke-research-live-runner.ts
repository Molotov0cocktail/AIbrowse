// ---------- LIVE_RESEARCH：真实 Provider/真实主题验收（C9，决议 #169；
// AIBROWSE_LIVE_RESEARCH=1 从属于 SMOKE+LIVE_PROVIDER；与其余 LIVE/专属门控
// 互斥由 index.ts 的 resolveResearchGate 纯函数确定性保证） ----------
// 真实执行必须经产品 ResearchService/ResearchRuntime/C6/C7/C8 路径（index.ts
// LIVE_RESEARCH 模式装配生产 RuntimeFactory）；结构断言与模型语义观察分开记录；
// 台账只记录 HTTP 次数/用途/结果分类（决议 #117 报告纪律）。
// 模块边界（C9 恢复，2026-08-18）：本模块 = 真实 Provider 编排；manifest/scan/
// live 纯函数职责保留在各自模块；与 smoke.ts/redteam 模块的引用为「运行时延迟
// 绑定」的循环依赖（全部绑定在函数体内使用，无模块求值期顶层执行）。
// C9 恢复校准（2026-08-18）：
// - 场景执行以 LIVE_RESEARCH_SCENARIO_MANIFEST 为唯一驱动（manifest 每 id
//   恰好执行一次；实际执行 id 集合与 manifest 逐项相等——未执行/重复/未知
//   id 一律 fail-closed）；
// - 至少一个场景经真实 UI DOM 操作（C8 IPC/渲染路径——uiWindow 不再闲置）；
// - Key 零暴露扫描为 Buffer 字节级 + 读取失败 fail-closed（不得因文件锁定
//   跳过）+ 覆盖全部持久化/展示面 + 环境变量清除断言；
// - 失败路径先 stop active task → 等待终态 → 再关闭受控页面服务器。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { logInfo, logWarn } from './logger';
import { assert, clickUi, delay, uiJs, uiText, waitFor, waitForUiText } from './smoke';
import type { LiveProviderSmoke } from './smoke';
import type { BrowserController } from './browser/browser-controller';
import type { ResearchService, ResearchTask } from '../shared/types/research';
import type { SourceService } from '../shared/types/sources';
import type { AuditEntry } from './ai/audit-log';
import { createResearchCanaries } from './smoke-research-scan';
import { startFrtCanaryPages } from './smoke-research-redteam';
import {
  LIVE_RESEARCH_SCENARIO_MANIFEST,
  classifyLiveResearchFailure,
  describeLiveResearchLedger,
  validateLiveResearchExecution,
  validateLiveResearchScenarioManifest,
  type LiveResearchLedgerEntry,
  type LiveResearchResultKind,
  type LiveResearchScenario,
} from './smoke-research-live';

export interface LiveResearchOptions {
  uiWindow: BrowserWindow;
  aiSmokeDir: string;
  liveSmoke: LiveProviderSmoke;
  researchService: ResearchService | null; // index.ts LIVE_RESEARCH 生产 factory 装配
  sourcesService: SourceService | null;
  sourcesDbPath: string | null;
  auditEntries?: AuditEntry[];
}

async function liveResearchAwaitTerminal(
  service: ResearchService,
  taskId: string,
  timeoutMs: number,
): Promise<ResearchTask | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const got = await service.getTask(taskId);
    if (!got.ok) return null;
    if (got.task.status !== 'running') return got.task;
    await delay(500);
  }
  return null; // 超时未收敛
}

// 目录字节收集（fail-closed）：任何文件读取失败 → 记入 failures（调用方必须
// 把该面判失败，不得静默跳过——真 Key 扫描 fail-closed 纪律）
function collectDirBytes(dir: string, failures: string[]): Buffer {
  const chunks: Buffer[] = [];
  const walk = (d: string): void => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      failures.push(`${d} 枚举失败`);
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          chunks.push(readFileSync(p));
        } catch {
          failures.push(p);
        }
      }
    }
  };
  walk(dir);
  return Buffer.concat(chunks);
}

function countToken(buf: Buffer, token: string): number {
  const needle = Buffer.from(token, 'utf8');
  if (needle.length === 0) return 0;
  let hits = 0;
  let index = buf.indexOf(needle);
  while (index !== -1) {
    hits += 1;
    index = buf.indexOf(needle, index + needle.length);
  }
  return hits;
}

// 真实 UI DOM 操作（C8 路径证据）：打开研究面板 → 历史列表选中指定 goal 的
// 任务 → 打开结果画布 → 返回画布文本（产品 ResearchService 经 IPC 驱动）
async function liveResearchUiCanvasOpen(
  uiWindow: BrowserWindow,
  goalMarker: string,
): Promise<string> {
  const uiWc = uiWindow.webContents;
  // C8 事件通道结构断言：渲染层 task-done 到达计数 = manifest 完成场景数
  //（index.ts 转发装配后注册——2026-08-18 修复；修复前恒 0）
  const eventCount = (await uiJs(uiWc, `(() => window.__liveResearchEventCount ?? 'UNSET')()`)) as
    number | string;
  assert(
    typeof eventCount === 'number' && eventCount >= 3,
    `LIVE_RESEARCH：渲染层 task-done 事件到达不足（实际 ${String(eventCount)}，期望 ≥3——C8 事件通道）`,
  );
  logInfo(
    'smoke',
    `LIVE_RESEARCH：C8 事件通道验证通过（渲染层 task-done 到达 ${String(eventCount)} 次）`,
  );
  // 打开面板前：直接经真实 IPC 通道读取任务列表（renderer 侧 list 链路）
  const ipcList = (await uiJs(
    uiWc,
    `window.aibrowse.research.list({ page: 1, pageSize: 20 }).then((r) => JSON.stringify(r)).catch((e) => 'ERR:' + String(e))`,
  )) as string;
  assert(
    ipcList.includes('"ok":true') && ipcList.includes('"total":3'),
    `LIVE_RESEARCH：IPC list 链路异常（${ipcList.slice(0, 120)}）`,
  );
  await uiJs(
    uiWc,
    "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === '研究'); if (b) b.click(); return b !== undefined; })()",
  );
  await waitForUiText(uiWc, '.research-panel', '研究', 5000, 'LIVE_RESEARCH：研究面板未打开');
  // 历史表头（「历史（N）」）出现 = 历史列表已加载（header 承载「历史」文案，
  // list 容器只承载条目——选择器必须指向 header）
  await waitForUiText(
    uiWc,
    '.research-panel-history-header',
    '历史',
    10000,
    'LIVE_RESEARCH：历史列表未加载',
  );
  // 等待目标任务条目真实出现（IPC 异步重读——条目晚于表头到达）
  try {
    await waitFor(
      async () =>
        (await uiJs(
          uiWc,
          `(() => { const items = [...document.querySelectorAll('.research-panel-history-item')]; return items.some((x) => x.textContent.includes(${JSON.stringify(goalMarker)})); })()`,
        )) as boolean,
      10000,
      'LIVE_RESEARCH：历史列表未找到目标任务（goal 匹配失败）',
    );
  } catch (err) {
    const diag = (await uiJs(
      uiWc,
      `(() => { const p = document.querySelector('.research-panel'); return p === null ? 'NO-PANEL' : p.innerText.slice(0, 400); })()`,
    )) as string;
    logWarn('smoke', `LIVE_RESEARCH 面板诊断：${diag}`);
    throw err;
  }
  // 历史条目按 goal 精确匹配（任务经产品 Service 创建——渲染层经 IPC 重读）
  const clicked = (await uiJs(
    uiWc,
    `(() => { const items = [...document.querySelectorAll('.research-panel-history-item')]; const hit = items.find(x => x.textContent.includes(${JSON.stringify(goalMarker)})); if (hit) { hit.click(); return true; } return false; })()`,
  )) as boolean;
  assert(clicked, 'LIVE_RESEARCH：历史列表未找到目标任务（goal 匹配失败）');
  await delay(300);
  await waitFor(
    async () =>
      (await uiJs(
        uiWc,
        `(() => { const b = document.querySelector('.research-panel-open-result'); return b !== null && !b.disabled; })()`,
      )) as boolean,
    10000,
    'LIVE_RESEARCH：打开结果按钮未就绪（任务未完成？）',
  );
  await clickUi(uiWc, '.research-panel-open-result');
  await waitForUiText(uiWc, '.research-canvas', '返回浏览', 10000, 'LIVE_RESEARCH：画布未打开');
  const canvasText = (await uiText(uiWc, '.research-canvas')).toString();
  await clickUi(uiWc, '.research-canvas-back').catch(() => undefined);
  await clickUi(uiWc, '.research-panel-collapse').catch(() => undefined);
  await uiJs(
    uiWc,
    "(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent === 'AI'); if (b) b.click(); })()",
  );
  await delay(150);
  return canvasText;
}

export async function runLiveResearchScenarios(
  controller: BrowserController,
  options: LiveResearchOptions,
): Promise<void> {
  logInfo('smoke', 'LIVE_RESEARCH 开始：真实 Provider/真实主题验收（决议 #117 长期授权）');
  const manifestErrors = validateLiveResearchScenarioManifest(LIVE_RESEARCH_SCENARIO_MANIFEST);
  assert(
    manifestErrors.length === 0,
    `LIVE_RESEARCH：场景清单不完整：${manifestErrors.join('；')}`,
  );
  const ledger: LiveResearchLedgerEntry[] = [];
  const executedIds: string[] = [];
  const canaries = createResearchCanaries();
  const pages = await startFrtCanaryPages(canaries);
  const uiWc = options.uiWindow.webContents;
  // 事件到达探针（诊断用）：渲染层订阅 task-done 并写入 data 属性——场景
  // 结束后读取计数，验证 main→renderer 事件链路
  await uiJs(
    uiWc,
    `(() => { window.__liveResearchEventCount = 0; window.aibrowse.research.onTaskDone(() => { window.__liveResearchEventCount = (window.__liveResearchEventCount ?? 0) + 1; }); return true; })()`,
  );
  const userTabsBefore = JSON.stringify(
    (await controller.getTabs()).map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
    })),
  );
  const service = options.researchService;
  assert(service !== null, 'LIVE_RESEARCH：researchService 未装配（index.ts 应注入生产 factory）');
  if (service === null) return;
  // 渲染层事件到达计数探针（C8 事件通道结构断言——2026-08-18 真实运行发现
  // index.ts 转发注册位于装配之前导致零到达；修复后计数 = 完成场景数）
  await uiJs(
    options.uiWindow.webContents,
    `(() => { window.__liveResearchEventCount = 0; window.aibrowse.research.onTaskDone(() => { window.__liveResearchEventCount = (window.__liveResearchEventCount ?? 0) + 1; }); return true; })()`,
  );
  // —— 稳定性预检（决议 #169(7)）：Provider 装配就绪 + service 可用 + 受控页可达 ——
  const ready = await options.liveSmoke.ready;
  assert(ready, 'LIVE_RESEARCH 预检：Provider 配置/Key 装配未就绪');
  const probe = await service.listTasks({ page: 1, pageSize: 1 });
  assert(probe.ok, 'LIVE_RESEARCH 预检：ResearchService 不可用');
  const probeTab = await controller.createTab(pages.conflictAUrl);
  await waitFor(
    async () => (await controller.getTabs()).find((t) => t.id === probeTab.id)?.state === 'ready',
    10000,
    'LIVE_RESEARCH 预检：受控页不可达（夹具缺陷）',
  );
  assert(await controller.closeTab(probeTab.id), 'LIVE_RESEARCH 预检：关闭探针 Tab 应成功');
  logInfo('smoke', 'LIVE_RESEARCH 预检通过（Provider 就绪 + service 可用 + 受控页可达）');

  // —— 受控信源种子（真实 SourceService 手工通道；用户断言 trust/分组） ——
  const sources = options.sourcesService;
  assert(sources !== null, 'LIVE_RESEARCH：sourcesService 未装配');
  if (sources === null) return;
  const seedGroup = '冒烟验收分组';
  const hostileGroup = '敌对观察分组';
  const seedUrls = [pages.conflictAUrl, pages.conflictBUrl, 'http://127.0.0.1:9/unreachable'];
  for (const url of seedUrls) {
    const added = await sources.addManual({
      scope: 'page',
      url,
      name: `受控来源 ${url.split('/').pop() ?? ''}`,
      groupName: seedGroup,
      shareMode: 'full',
      userNote: '真实验收受控来源',
    });
    assert(
      added.ok || added.errorCode === 'source-duplicate',
      `LIVE_RESEARCH：种子信源写入失败（${url}）`,
    );
  }
  for (const url of [pages.hostilePlanUrl, pages.conflictAUrl, pages.conflictBUrl]) {
    const added = await sources.addManual({
      scope: 'page',
      url,
      name: `敌对观察 ${url.split('/').pop() ?? ''}`,
      groupName: hostileGroup,
      shareMode: 'full',
    });
    assert(
      added.ok || added.errorCode === 'source-duplicate',
      `LIVE_RESEARCH：敌对信源写入失败（${url}）`,
    );
  }

  // 最近启动的任务（失败路径 stop 用）；HTTP 计数 = roundsUsed 冻结语义
  // （重试同样计数——Runtime roundsUsed 每次 stream 调用前递增）
  let lastStartedTaskId: string | null = null;

  const runScenario = async (scenario: LiveResearchScenario): Promise<ResearchTask | null> => {
    const created = await service.createTask(scenario.goal);
    assert(created.ok, `LIVE_RESEARCH ${scenario.id}：任务创建失败`);
    if (!created.ok) return null;
    lastStartedTaskId = created.task.id;
    const started = await service.startTask(created.task.id);
    assert(
      started.ok,
      `LIVE_RESEARCH ${scenario.id}：startTask 失败（${!started.ok ? started.errorCode : ''}）`,
    );
    if (!started.ok) return null;
    // 真实运行：30 分钟总超时（Runtime 内建 deadline）+ 轮询收敛
    const terminal = await liveResearchAwaitTerminal(service, created.task.id, 31 * 60 * 1000);
    assert(terminal !== null, `LIVE_RESEARCH ${scenario.id}：任务未在时限内收敛`);
    if (terminal !== null) {
      const resultKind: LiveResearchResultKind =
        terminal.status === 'completed'
          ? 'completed'
          : terminal.status === 'cancelled'
            ? 'failed-product'
            : (() => {
                const cls = classifyLiveResearchFailure({
                  errorCode: terminal.errorCode ?? undefined,
                });
                if (cls === 'network') return 'failed-network';
                if (cls === 'model-compat') return 'failed-model-compat';
                if (cls === 'fixture-defect') return 'failed-fixture';
                if (cls === 'product-defect') return 'failed-product';
                if (cls === 'unclassified') {
                  // 无安全 HTTP 状态观察钩子 → 如实登记「Provider 类别未细分」，
                  // 不得伪造余额/权限/网络/服务端判定（决议 #117/#169(8)）
                  logWarn(
                    'smoke',
                    `LIVE_RESEARCH ${scenario.id}：Provider 类别未细分（errorCode=${terminal.errorCode ?? '无'}，无 HTTP 状态观察钩子——余额/权限/网络/服务端不区分）`,
                  );
                }
                return 'failed-provider';
              })();
      ledger.push({
        scenario: scenario.id,
        httpCalls: terminal.stats.roundsUsed,
        resultKind,
        purpose: scenario.purpose,
      });
      logInfo(
        'smoke',
        `LIVE_RESEARCH ${scenario.id}：status=${terminal.status}，HTTP=${String(terminal.stats.roundsUsed)} 次，errorCode=${terminal.errorCode ?? '无'}`,
      );
    }
    return terminal;
  };

  // 每场景结构化断言（switch by id；goal/purpose 来自 manifest 单一事实源）
  const assertScenarioOutcome = async (
    scenario: LiveResearchScenario,
    terminal: ResearchTask | null,
  ): Promise<void> => {
    if (scenario.id === 'lr1-group-compare') {
      assert(
        terminal !== null && terminal.status === 'completed',
        'LIVE_RESEARCH lr1：任务应 completed',
      );
      if (terminal !== null && terminal.status === 'completed') {
        const view = await service.getResearchResultView(terminal.id);
        assert(view.ok, 'LIVE_RESEARCH lr1：结果视图应可读（产品 getResearchResultView 路径）');
        if (view.ok) {
          const resultJson = JSON.stringify(view.view.result);
          assert(!resultJson.includes('"score"'), 'LIVE_RESEARCH lr1：Result 无 score 字段');
          assert(!resultJson.includes('"percent"'), 'LIVE_RESEARCH lr1：Result 无 percent 字段');
          assert(
            !resultJson.includes('"confidence"'),
            'LIVE_RESEARCH lr1：Result 无 confidence 字段',
          );
          assert(view.view.result.blocks.length >= 1, 'LIVE_RESEARCH lr1：Result 至少 1 个块');
          for (const dto of view.view.evidence) {
            assert(dto.provenance !== undefined, 'LIVE_RESEARCH lr1：Evidence DTO 含 provenance');
            const keys = Object.keys(dto);
            assert(
              !keys.includes('captureId') &&
                !keys.includes('documentId') &&
                !keys.includes('contentHash'),
              'LIVE_RESEARCH lr1：DTO 内部字段零暴露',
            );
          }
          // 观察记录：分组使用与失败继续（模型模式选择为语义行为——如实登记）
          logInfo(
            'smoke',
            `LIVE_RESEARCH lr1 观察：candidates=${String(terminal.stats.candidateCount)}，captures=${String(terminal.stats.captureCount)}，failedRead=${String(terminal.stats.failedReadCount)}，evidence=${String(terminal.stats.evidenceCount)}，blocks=${view.view.result.blocks.map((b) => b.kind).join('/')}`,
          );
        }
      }
      return;
    }
    if (scenario.id === 'lr2-sources-plus-search') {
      assert(
        terminal !== null && terminal.status === 'completed',
        'LIVE_RESEARCH lr2：真实主题任务应 completed',
      );
      if (terminal !== null && terminal.status === 'completed') {
        const view = await service.getResearchResultView(terminal.id);
        assert(view.ok, 'LIVE_RESEARCH lr2：结果视图应可读');
        if (view.ok) {
          assert(view.view.result.blocks.length >= 1, 'LIVE_RESEARCH lr2：Result 至少 1 个块');
          logInfo(
            'smoke',
            `LIVE_RESEARCH lr2 观察：candidates=${String(terminal.stats.candidateCount)}，evidence=${String(terminal.stats.evidenceCount)}，steps=${String(terminal.stats.stepsUsed)}，blocks=${view.view.result.blocks.map((b) => b.kind).join('/')}`,
          );
        }
      }
      return;
    }
    if (scenario.id === 'lr3-hostile-observe') {
      assert(terminal !== null, 'LIVE_RESEARCH lr3：任务应收敛');
      if (terminal !== null && terminal.status === 'completed') {
        // 结构断言 + 诚实观察（2026-08-18 真实运行校准）：敌对页标记只能经
        // 已验证 Evidence 摘录或模型自身输出出现——系统从不把捕获正文注入
        // Result；真实模型可能引用敌对页标记（语义行为——如实登记为观察项，
        // 不作为确定性防御断言；确定性 8.20 FRT 扫描面仍要求零命中）
        const captureCanary = canaries.find((c) => c.kind === 'capture-body')!.value;
        const view = await service.getResearchResultView(terminal.id);
        if (view.ok) {
          const excerptValues = view.view.evidence.map((e) => e.excerpt);
          let resultJson = JSON.stringify({ ...view.view.result, evidenceMap: {} });
          for (const ex of excerptValues) resultJson = resultJson.split(ex).join('');
          const markerHits = resultJson.includes(captureCanary)
            ? (resultJson.match(new RegExp(captureCanary, 'g')) ?? []).length
            : 0;
          if (markerHits > 0) {
            logWarn(
              'smoke',
              `LIVE_RESEARCH lr3 观察：模型在 Result 中引用了敌对页标记 ${markerHits} 次（语义行为如实登记——标记无特权、引用机制按设计工作；不作为确定性防御断言）`,
            );
          }
        }
        logInfo(
          'smoke',
          `LIVE_RESEARCH lr3 观察（语义行为如实登记，不冒充防御）：conflicts=${String(terminal.stats.conflictCount)}，claims=${String(terminal.stats.claimCount)}，rejectedEvidence=${String(terminal.stats.rejectedEvidenceCount)}`,
        );
      }
      return;
    }
    assert(false, `LIVE_RESEARCH：未知场景 id（${scenario.id}）——manifest 外执行禁止`);
  };

  try {
    // —— manifest 驱动执行：每个 id 恰好一次（同源校验在末尾 fail-closed） ——
    for (const scenario of LIVE_RESEARCH_SCENARIO_MANIFEST) {
      const terminal = await runScenario(scenario);
      executedIds.push(scenario.id);
      await assertScenarioOutcome(scenario, terminal);
      logInfo('smoke', `LIVE_RESEARCH ${scenario.id} 完成（结构断言通过）`);
    }
    const execErrors = validateLiveResearchExecution(LIVE_RESEARCH_SCENARIO_MANIFEST, executedIds);
    assert(
      execErrors.length === 0,
      `LIVE_RESEARCH：执行与 manifest 不同源（fail-closed）：${execErrors.join('；')}`,
    );

    // —— C8 真实 UI DOM 路径：lr1 结果画布经真实渲染层打开并断言 ——
    const uiCanvasText = await liveResearchUiCanvasOpen(options.uiWindow, seedGroup);
    assert(
      uiCanvasText.length > 0 && uiCanvasText.includes('返回浏览'),
      'LIVE_RESEARCH：真实 UI 画布已打开（C8 渲染路径证据）',
    );

    // —— Key 零暴露扫描（真 Key 全表面零命中；Buffer 字节级 + fail-closed） ——
    const key = options.liveSmoke.key;
    const scanFailures: string[] = [];
    const scanTargets: Array<{ label: string; read: () => Buffer | Promise<Buffer> }> = [];
    const tempRoot = tmpdir();
    // research/sources/temp-other：全部 aibrowse-smoke-*/aibrowse-frt* 目录
    //（含 research.db/WAL/SHM、sources.db/WAL/SHM、backups、会话产物——目录递归）
    for (const entry of readdirSync(tempRoot, { withFileTypes: true })) {
      const isSmokeDir =
        entry.isDirectory() &&
        (entry.name.startsWith('aibrowse-smoke-') || entry.name.startsWith('aibrowse-frt'));
      if (isSmokeDir) {
        const dir = join(tempRoot, entry.name);
        scanTargets.push({
          label: `temp-dir:${entry.name}`,
          read: () => collectDirBytes(dir, scanFailures),
        });
      }
    }
    // sources-db 备份目录（库文件已随 temp-dir 覆盖；backups 目录单独列面）
    if (options.sourcesDbPath !== null) {
      const backupsDir = join(options.sourcesDbPath, '..', 'backups');
      if (existsSync(backupsDir)) {
        scanTargets.push({
          label: 'sources-backups',
          read: () => {
            const chunks: Buffer[] = [];
            for (const name of readdirSync(backupsDir)) {
              const bp = join(backupsDir, name);
              try {
                if (statSync(bp).isFile()) chunks.push(readFileSync(bp));
              } catch {
                scanFailures.push(`backup:${name}`);
              }
            }
            return Buffer.concat(chunks);
          },
        });
      }
    }
    // conversation 目录（独立面——即使已在 temp-dir 覆盖也单独断言）
    scanTargets.push({
      label: 'conversation-dir',
      read: () => collectDirBytes(options.aiSmokeDir, scanFailures),
    });
    // 日志区间（进程起点起）
    scanTargets.push({
      label: 'log-slice',
      read: () => {
        const { file, offsetBefore } = options.liveSmoke.logScan;
        if (!existsSync(file)) return Buffer.alloc(0);
        try {
          const full = readFileSync(file);
          return full.subarray(offsetBefore);
        } catch {
          scanFailures.push('log-slice');
          return Buffer.alloc(0);
        }
      },
    });
    // audit 收集器
    if (options.auditEntries !== undefined) {
      const entries = options.auditEntries;
      scanTargets.push({
        label: 'audit',
        read: () => Buffer.from(entries.map((a) => JSON.stringify(a)).join('\n'), 'utf8'),
      });
    }
    // UI DOM 面（真实渲染层当前 DOM：innerText + outerHTML）
    scanTargets.push({
      label: 'ui-dom',
      read: async () => {
        const innerText = (await uiJs(
          options.uiWindow.webContents,
          'document.body ? document.body.innerText : ""',
        )) as string;
        const outer = (await uiJs(
          options.uiWindow.webContents,
          'document.documentElement ? document.documentElement.outerHTML : ""',
        )) as string;
        return Buffer.from(`${innerText}\n${outer}`, 'utf8');
      },
    });
    // 读取失败 fail-closed：任何面读取失败 → 整体失败（不得跳过）
    for (const target of scanTargets) {
      let buf: Buffer;
      try {
        buf = await target.read();
      } catch {
        scanFailures.push(target.label);
        continue;
      }
      assert(countToken(buf, key) === 0, `LIVE_RESEARCH：真 Key 零暴露扫描失败（${target.label}）`);
      assert(
        countToken(buf, `Bearer ${key}`) === 0,
        `LIVE_RESEARCH：Authorization 形态零暴露扫描失败（${target.label}）`,
      );
    }
    assert(
      scanFailures.length === 0,
      `LIVE_RESEARCH：真 Key 扫描面读取失败（fail-closed）：${scanFailures.join('；')}`,
    );
    logInfo('smoke', `LIVE_RESEARCH：真 Key 零暴露扫描通过（${scanTargets.length} 个表面）`);
    // 环境变量清除断言（index.ts 装配路径读取后立即移除）
    assert(
      process.env['AIBROWSE_TEST_API_KEY'] === undefined,
      'LIVE_RESEARCH：AIBROWSE_TEST_API_KEY 必须已从环境变量移除',
    );

    // —— 终检：用户 Tab 恒等 + 零 running 残留 ——
    const userTabsAfter = JSON.stringify(
      (await controller.getTabs()).map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        active: t.active,
      })),
    );
    assert(userTabsAfter === userTabsBefore, 'LIVE_RESEARCH：用户 Tab id/url/title/active 恒等');
    const finalList = await service.listTasks({ page: 1, pageSize: 20 });
    assert(
      finalList.ok && finalList.items.every((t) => t.status !== 'running'),
      'LIVE_RESEARCH：零 running 任务残留',
    );
    logInfo('smoke', describeLiveResearchLedger(ledger));
    logInfo('smoke', 'LIVE_RESEARCH 全部通过（真实 Provider/真实主题验收）');
  } finally {
    // 失败路径清理：先 stop active Research task → 等待终态（cleanupAll 由
    // Runtime 终态保证）→ 再关闭受控页面服务器；不留 running task 或 task Tab
    if (lastStartedTaskId !== null) {
      try {
        const got = await service.getTask(lastStartedTaskId);
        if (got.ok && got.task.status === 'running') {
          logWarn('smoke', `LIVE_RESEARCH：失败路径停止活动任务（${lastStartedTaskId}）`);
          await service.stopTask(lastStartedTaskId);
          await liveResearchAwaitTerminal(service, lastStartedTaskId, 60_000);
        }
      } catch (err) {
        logWarn('smoke', 'LIVE_RESEARCH：失败路径任务停止异常（不掩盖原始错误）', err);
      }
    }
    try {
      await pages.close();
    } catch (err) {
      logWarn('smoke', 'LIVE_RESEARCH：受控页面服务器关闭异常', err);
    }
  }
}
