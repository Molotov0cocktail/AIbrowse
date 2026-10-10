import { app, BrowserWindow } from 'electron';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BaselineFixtureReceipt } from './baseline-fixture';
import { ConfigStore } from '../../../src/main/ai/config-store';
import { SecureCredentialStoreImpl } from '../../../src/main/ai/credential-store';
import { SafeStorageCipher } from '../../../src/main/ai/safe-storage-cipher';

interface Control {
  version: 1;
  mode: 'baseline' | 'candidate' | 'feasibility' | 'long';
  durationMs: number;
  deadlineEpochMs: number;
  externalProviderStatus:
    'not-run-credential-file-missing' | 'not-run-credential-file-present-has-key-not-checked';
}
const scope = dirname(__dirname);
if (!/^performance-check-[a-f0-9]{32}$/u.test(scope.split(/[\\/]/u).at(-1)!))
  throw new Error('scope无效');
const control = JSON.parse(readFileSync(join(scope, 'control.json'), 'utf8')) as Control;
if (
  control.version !== 1 ||
  !['baseline', 'candidate', 'feasibility', 'long'].includes(control.mode) ||
  !Number.isSafeInteger(control.durationMs) ||
  (['baseline', 'candidate'].includes(control.mode) && control.durationMs !== 0) ||
  control.durationMs < (['baseline', 'candidate'].includes(control.mode) ? 0 : 60_000) ||
  control.durationMs > 7_200_000 ||
  ![
    'not-run-credential-file-missing',
    'not-run-credential-file-present-has-key-not-checked',
  ].includes(control.externalProviderStatus)
)
  throw new Error('control无效');
const setupMode = process.argv.at(-1) === 'setup';
const baselineMatch = process.argv.at(-1)?.match(/^baseline-([0-6])$/u) ?? null;
const baselineIteration = baselineMatch === null ? null : Number(baselineMatch[1]);
if (!setupMode && ['baseline', 'candidate'].includes(control.mode) !== (baselineIteration !== null))
  throw new Error('短基线轮次错绑');
const profile = join(scope, 'profile');
if (
  !existsSync(profile) ||
  !lstatSync(profile).isDirectory() ||
  lstatSync(profile).isSymbolicLink()
)
  throw new Error('profile类型无效');
let fixture: BaselineFixtureReceipt | null = null;
if (baselineIteration === 6) {
  fixture = JSON.parse(
    readFileSync(join(scope, 'baseline-fixture.json'), 'utf8'),
  ) as BaselineFixtureReceipt;
}
app.setPath('userData', profile);
app.setPath('sessionData', profile);
for (const key of Object.keys(process.env))
  if (
    key.startsWith('AIBROWSE_') ||
    ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'NODE_OPTIONS'].includes(key)
  )
    delete process.env[key];

// Electron's performance clock starts with the process, before this bootstrap module loads.
const started = 0;
const latencies: number[] = [];
const createLatencies: number[] = [];
const appMetrics: unknown[] = [];
const snapshots: Array<{
  tabId: string;
  documentId: number;
  urlHash: string;
  kind: number;
  generation: number;
  latencyMs: number;
}> = [];
interface TabExpectation {
  readonly pageIndex: number;
  readonly generation: number;
  documentId: number | null;
}
const tabExpectations = new Map<string, TabExpectation>();
const ownershipEvents: Array<{
  elapsedMs: number;
  closedTabIdHash: string;
  createdTabIdHash: string;
}> = [];
const interactionEvents: Array<{ elapsedMs: number; tabIdHash: string }> = [];
const navigationEvents: Array<{
  elapsedMs: number;
  tabIdHash: string;
  priorDocumentId: number;
  currentDocumentId: number;
}> = [];
let window: BrowserWindow | null = null;
let failed = false;
let providerRequests = 0;
let authorizedProviderRequests = 0;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
function writeNew(name: string, value: unknown): void {
  writeFileSync(join(scope, name), JSON.stringify(value, null, 2), { flag: 'wx' });
}
function need(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function remaining(): number {
  return control.deadlineEpochMs - Date.now();
}
function check(): void {
  need(!failed && remaining() > 0, '固定期限已过');
}
async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const server = createServer(async (request, response) => {
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    providerRequests += 1;
    if (request.headers.authorization === 'Bearer sk-performance-local-only')
      authorizedProviderRequests += 1;
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      need(bytes <= 1_048_576, 'Provider请求超限');
      chunks.push(buffer);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      messages?: Array<{ role?: unknown; content?: unknown }>;
    };
    const system = body.messages?.find((message) => message.role === 'system')?.content;
    need(typeof system === 'string', 'Provider system缺失');
    const content = system.includes('候选查询计划')
      ? '{"sourceMode":"search","sourceQuery":"PERF_NO_MATCH","groupId":null,"webQueries":[],"selectedCandidateIds":[]}'
      : system.includes('交叉核验者')
        ? '{"vendorCandidateIds":[],"claims":[],"conflicts":[]}'
        : system.includes('综合者')
          ? '{"result":{"title":"受控性能研究","summary":"没有候选证据。","blocks":[{"kind":"uncertain","text":"没有候选证据。","reason":"受控性能夹具返回空候选。"}]}}'
          : 'PERF_TOKEN';
    await sleep(5);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    return;
  }
  const match = request.url?.match(/^\/page\/(\d+)(?:\?g=(\d+))?$/u);
  if (match === null || match === undefined) {
    response.writeHead(404).end();
    return;
  }
  const index = Number(match[1]);
  const generation = Number(match[2] ?? 0);
  const kind = index % 3;
  const body =
    kind === 0
      ? `<h1>⟦PERF_TAB:${index}:${generation}⟧</h1><p>${'alpha '.repeat(200)}</p>`
      : kind === 1
        ? `<h1>⟦PERF_TAB:${index}:${generation}⟧</h1><table><tr><th>A</th><th>B</th></tr>${Array.from({ length: 80 }, (_, row) => `<tr><td>${row}</td><td>value-${row}</td></tr>`).join('')}</table>`
        : `<h1>⟦PERF_TAB:${index}:${generation}⟧</h1>${Array.from({ length: 120 }, (_, row) => `<section><h2>Section ${row}</h2><a href="#${row}">item</a></section>`).join('')}`;
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(
    `<!doctype html><html><head><title>PERF ${index}</title></head><body>${body}</body></html>`,
  );
});
let base = '';

function fail(error: unknown): void {
  if (failed) return;
  failed = true;
  try {
    writeNew(
      baselineIteration === null
        ? 'runtime-failure.json'
        : `baseline-failure-${baselineIteration}.json`,
      {
        error: error instanceof Error ? error.message.slice(0, 500) : '运行失败',
        elapsedMs: performance.now() - started,
      },
    );
  } finally {
    server.close();
    app.exit(1);
  }
}
async function evaluate(source: string, timeoutMs = 60_000): Promise<unknown> {
  check();
  need(window !== null && !window.isDestroyed(), '主窗口缺失');
  const allowed = Math.min(timeoutMs, remaining());
  need(Number.isFinite(allowed) && allowed > 0, '动作期限已过');
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      window.webContents.executeJavaScript(source),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('动作绝对期限耗尽')), allowed);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
async function waitFor(source: string, label: string, timeoutMs = 30_000): Promise<unknown> {
  const stop = Math.min(performance.now() + timeoutMs, performance.now() + remaining());
  while (performance.now() < stop) {
    const value = await evaluate(source, stop - performance.now());
    if (performance.now() >= stop) throw new Error(`等待失败:${label}`);
    if (value !== null && value !== false) return value;
    await sleep(50);
  }
  throw new Error(`等待失败:${label}`);
}
async function measureSnapshot(tabId: string, expected?: TabExpectation): Promise<void> {
  need(expected !== undefined, 'snapshot期待绑定缺失');
  const begin = performance.now();
  const value = await evaluate(`window.aibrowse.page.snapshot(${JSON.stringify(tabId)})`, 5_000);
  const elapsed = performance.now() - begin;
  need(elapsed <= 5_000, 'snapshot超过绝对上限');
  need(value !== null && typeof value === 'object', 'snapshot缺失');
  const snapshot = value as {
    url?: unknown;
    visibleText?: unknown;
    meta?: { documentId?: unknown; readyState?: unknown };
  };
  const expectedUrl = `${base}/page/${expected.pageIndex}?g=${expected.generation}`;
  need(snapshot.url === expectedUrl, 'snapshot URL错绑');
  need(
    typeof snapshot.visibleText === 'string' &&
      snapshot.visibleText.includes(`⟦PERF_TAB:${expected.pageIndex}:${expected.generation}⟧`),
    'snapshot正文错绑',
  );
  need(
    typeof snapshot.meta?.documentId === 'number' && snapshot.meta.readyState === 'complete',
    'snapshot世代或ready错误',
  );
  if (expected.documentId === null) expected.documentId = snapshot.meta.documentId;
  else need(snapshot.meta.documentId === expected.documentId, 'snapshot文档世代错绑');
  latencies.push(elapsed);
  snapshots.push({
    tabId,
    documentId: snapshot.meta.documentId,
    urlHash: sha(snapshot.url),
    kind: expected.pageIndex % 3,
    generation: expected.generation,
    latencyMs: elapsed,
  });
}
async function finishWindow(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  window!.close();
}

async function runBaseline(iteration: number): Promise<void> {
  const initial = (await waitFor(
    `window.aibrowse.tabs.list().then(v=>v.length===1&&v[0].state==='ready'?v:null)`,
    '基线初始Tab',
  )) as Array<{ id: string }>;
  const startupMs = performance.now() - started;
  need(startupMs <= 30_000, '启动超过绝对上限');
  if (iteration < 6) {
    writeNew(`baseline-runtime-${iteration}.json`, { version: 1, iteration, startupMs });
    await finishWindow();
    return;
  }
  need(fixture !== null, 'Sources夹具缺失');
  const initialTab = initial[0]!.id;
  const newTabMs: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    const begin = performance.now();
    const created = await evaluate(
      `window.aibrowse.tabs.create(${JSON.stringify(`${base}/page/${index % 3}?g=${index}`)})`,
    );
    need(
      created !== null &&
        typeof created === 'object' &&
        typeof (created as { id?: unknown }).id === 'string',
      '基线新建Tab失败',
    );
    const id = (created as { id: string }).id;
    await waitFor(
      `window.aibrowse.tabs.list().then(v=>v.some(t=>t.id===${JSON.stringify(id)}&&t.state==='ready')?true:null)`,
      '基线新Tab ready',
      5_000,
    );
    const elapsed = performance.now() - begin;
    need(elapsed <= 5_000, '新Tab超过绝对上限');
    newTabMs.push(elapsed);
    need(
      (await evaluate(`window.aibrowse.tabs.close(${JSON.stringify(id)})`)) === true,
      '基线关闭Tab失败',
    );
    await waitFor(
      `window.aibrowse.tabs.list().then(v=>v.length===1&&!v.some(t=>t.id===${JSON.stringify(id)})?true:null)`,
      '基线关闭确认',
    );
  }
  const snapshotMs: number[][] = [[], [], []];
  for (let kind = 0; kind < 3; kind += 1) {
    need(
      (await evaluate(
        `window.aibrowse.nav.navigate(${JSON.stringify(initialTab)},${JSON.stringify(`${base}/page/${kind}?g=${kind}`)})`,
      )) === true,
      '基线导航失败',
    );
    const expected = { pageIndex: kind, generation: kind, documentId: null };
    tabExpectations.set(initialTab, expected);
    await waitFor(
      `window.aibrowse.tabs.list().then(v=>v.find(t=>t.id===${JSON.stringify(initialTab)})?.state==='ready'?true:null)`,
      '基线DOM ready',
    );
    for (let sample = 0; sample < 30; sample += 1) {
      await measureSnapshot(initialTab, expected);
      snapshotMs[kind]!.push(snapshots.at(-1)!.latencyMs);
    }
  }
  const searchMs: number[][] = [];
  const searchIdentitySha256: string[][] = [];
  for (const query of fixture.queryTokens) {
    const querySamples: number[] = [];
    const queryIdentities: string[] = [];
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const begin = performance.now();
      const result = await evaluate(
        `window.aibrowse.sources.search(${JSON.stringify({ query, limit: 10 })})`,
        5_000,
      );
      const elapsed = performance.now() - begin;
      need(elapsed <= 5_000, 'Sources搜索超过绝对上限');
      need(
        result !== null &&
          typeof result === 'object' &&
          (result as { ok?: unknown }).ok === true &&
          Array.isArray((result as { results?: unknown }).results) &&
          (result as { results: unknown[] }).results.length === 10,
        'Sources搜索结果无效',
      );
      const rows = (result as { results: Array<Record<string, unknown>> }).results;
      need(
        new Set(rows.map((row) => row.id)).size === 10 &&
          rows.every(
            (row) =>
              typeof row.id === 'string' &&
              /^10000000-0000-4000-8000-[a-f0-9]{12}$/u.test(row.id) &&
              Number.parseInt(row.id.slice(-12), 16) % 10 ===
                Number.parseInt(query.slice('PERF_QUERY_'.length), 10) &&
              typeof row.name === 'string' &&
              row.name.includes(query) &&
              typeof row.url === 'string' &&
              row.url.startsWith('https://performance.invalid/source/'),
          ),
        'Sources搜索身份错绑',
      );
      querySamples.push(elapsed);
      queryIdentities.push(sha(JSON.stringify(rows.map((row) => row.id))));
    }
    searchMs.push(querySamples);
    searchIdentitySha256.push(queryIdentities);
  }
  const sourceList = await evaluate(`window.aibrowse.sources.list({page:0,pageSize:20})`);
  need(
    sourceList !== null &&
      typeof sourceList === 'object' &&
      (sourceList as { ok?: unknown }).ok === true &&
      (sourceList as { total?: unknown }).total === 5_000,
    'Sources夹具总数无效',
  );
  need(
    (await evaluate(`window.aibrowse.config.providers.hasKey('openai-compatible')`)) === true,
    '本地Provider准备失败',
  );
  const firstTokenMs: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const result = await evaluate(`new Promise(async (resolve,reject)=>{
      const session=await window.aibrowse.conversation.create({ephemeral:true});
      if(!session)return reject(new Error('session'));
      let first=null; const begin=performance.now();
      const offChunk=window.aibrowse.conversation.onStreamChunk(e=>{if(e.sessionId===session.id&&first===null)first=performance.now()-begin});
      const timer=setTimeout(()=>{offChunk();offDone();reject(new Error('first-token-timeout'))},10000);
      const offDone=window.aibrowse.conversation.onTurnDone(async e=>{if(e.sessionId!==session.id)return;clearTimeout(timer);offChunk();offDone();await window.aibrowse.conversation.remove(session.id);if(e.status!=='complete'||first===null)reject(new Error('turn'));else resolve({firstTokenMs:first})});
      const asked=await window.aibrowse.conversation.ask(session.id,'PERF_FIRST_TOKEN_${index}');
      if(!asked.ok){clearTimeout(timer);offChunk();offDone();reject(new Error('ask'));}
    })`);
    need(
      result !== null &&
        typeof result === 'object' &&
        typeof (result as { firstTokenMs?: unknown }).firstTokenMs === 'number',
      '首token结果无效',
    );
    const elapsed = (result as { firstTokenMs: number }).firstTokenMs;
    need(elapsed <= 10_000, '首token超过绝对上限');
    firstTokenMs.push(elapsed);
  }
  const researchMs: number[] = [];
  const researchExpected: Array<{ taskId: string; goal: string }> = [];
  for (let index = 0; index < 5; index += 1) {
    const goal = `PERF_NO_MATCH_${index}`;
    const begin = performance.now();
    const created = await evaluate(`window.aibrowse.research.create(${JSON.stringify(goal)})`);
    need(
      created !== null &&
        typeof created === 'object' &&
        (created as { ok?: unknown }).ok === true &&
        typeof (created as { value?: { task?: { id?: unknown } } }).value?.task?.id === 'string',
      'Research创建失败',
    );
    const taskId = (created as { value: { task: { id: string } } }).value.task.id;
    researchExpected.push({ taskId, goal });
    const startedResult = await evaluate(
      `window.aibrowse.research.start(${JSON.stringify(taskId)})`,
    );
    need(
      startedResult !== null &&
        typeof startedResult === 'object' &&
        (startedResult as { ok?: unknown }).ok === true,
      'Research启动失败',
    );
    await waitFor(
      `window.aibrowse.research.get(${JSON.stringify(taskId)}).then(r=>r.ok&&r.value.task.status==='completed'?true:r.ok&&['failed','cancelled'].includes(r.value.task.status)?Promise.reject(new Error('research-terminal')):null)`,
      'Research完成',
      60_000,
    );
    const elapsed = performance.now() - begin;
    need(elapsed <= 60_000, 'Research超过绝对上限');
    researchMs.push(elapsed);
  }
  need(
    providerRequests >= 25 && authorizedProviderRequests === providerRequests,
    '本地Provider请求或凭据绑定无效',
  );
  const overheadStarted = performance.now();
  for (let index = 0; index < 100; index += 1) app.getAppMetrics();
  writeNew(`baseline-runtime-${iteration}.json`, {
    version: 1,
    iteration,
    startupMs,
    fixture,
    sourcesTotal: 5_000,
    samples: {
      newTabMs,
      snapshotMs,
      searchMs,
      searchIdentitySha256,
      firstTokenMs,
      researchMs,
    },
    metricsObservation100Ms: performance.now() - overheadStarted,
    provider: { requests: providerRequests, authorizedRequests: authorizedProviderRequests },
    externalProvider: control.externalProviderStatus,
    researchExpected,
  });
  await finishWindow();
}

async function runSteady(): Promise<void> {
  const overheadStarted = performance.now();
  for (let index = 0; index < 100; index += 1) app.getAppMetrics();
  const metricsObservation100Ms = performance.now() - overheadStarted;
  const initial = (await waitFor(
    `window.aibrowse.tabs.list().then(v=>v.length? v:null)`,
    '初始Tab',
  )) as Array<{ id: string }>;
  const startupMs = performance.now() - started;
  need(startupMs <= 30_000, '启动超过绝对上限');
  need(initial.length === 1, '合成profile应仅有一个初始Tab');
  const tabIds = [initial[0]!.id];
  for (let index = 1; index < 10; index += 1) {
    const begin = performance.now();
    const created = await evaluate(
      `window.aibrowse.tabs.create(${JSON.stringify(`${base}/page/${index}?g=0`)})`,
    );
    need(
      created !== null &&
        typeof created === 'object' &&
        typeof (created as { id?: unknown }).id === 'string',
      '新建Tab失败',
    );
    const createdId = (created as { id: string }).id;
    tabIds.push(createdId);
    tabExpectations.set(createdId, { pageIndex: index, generation: 0, documentId: null });
    await waitFor(
      `window.aibrowse.tabs.list().then(v=>v.some(t=>t.id===${JSON.stringify(createdId)}&&t.state==='ready')?true:null)`,
      '新Tab ready',
      5_000,
    );
    const createdMs = performance.now() - begin;
    need(createdMs <= 5_000, '新Tab超过绝对上限');
    latencies.push(createdMs);
    createLatencies.push(createdMs);
  }
  need(
    (await evaluate(
      `window.aibrowse.nav.navigate(${JSON.stringify(tabIds[0])},${JSON.stringify(`${base}/page/0?g=0`)})`,
    )) === true,
    '初始Tab导航失败',
  );
  tabExpectations.set(tabIds[0]!, { pageIndex: 0, generation: 0, documentId: null });
  await waitFor(
    `window.aibrowse.tabs.list().then(v=>v.length===10&&v.every(t=>t.state==='ready')?v:null)`,
    '10 Tab ready',
  );
  for (const tabId of tabIds) await measureSnapshot(tabId, tabExpectations.get(tabId));
  const workloadStart = performance.now();
  let nextResource = workloadStart;
  let nextInteraction = workloadStart + 60_000;
  let nextNavigate = workloadStart + 600_000;
  let nextRecreate = workloadStart + 900_000;
  let generation = 0;
  let interactionIndex = 0;
  while (performance.now() - workloadStart < control.durationMs) {
    check();
    const now = performance.now();
    if (now >= nextResource) {
      need(appMetrics.length < 721, 'appMetrics时点超限');
      appMetrics.push({
        elapsedMs: now - workloadStart,
        members: app.getAppMetrics().map((member) => ({
          pid: member.pid,
          type: member.type,
          cpu: member.cpu,
          memory: member.memory,
        })),
      });
      nextResource += 10_000;
    }
    if (now >= nextInteraction) {
      const tabId = tabIds[interactionIndex++ % tabIds.length]!;
      await evaluate(`window.aibrowse.tabs.activate(${JSON.stringify(tabId)})`);
      await measureSnapshot(tabId, tabExpectations.get(tabId));
      interactionEvents.push({
        elapsedMs: performance.now() - workloadStart,
        tabIdHash: sha(tabId),
      });
      nextInteraction += 60_000;
    }
    if (now >= nextNavigate) {
      generation += 1;
      const index = generation % tabIds.length;
      const tabId = tabIds[index]!;
      const prior = tabExpectations.get(tabId)?.documentId ?? 0;
      const expected = { pageIndex: index, generation, documentId: null };
      tabExpectations.set(tabId, expected);
      await evaluate(
        `window.aibrowse.nav.navigate(${JSON.stringify(tabId)},${JSON.stringify(`${base}/page/${index}?g=${generation}`)})`,
      );
      await waitFor(
        `window.aibrowse.tabs.list().then(v=>v.find(t=>t.id===${JSON.stringify(tabId)})?.state==='ready')`,
        '导航ready',
      );
      await measureSnapshot(tabId, expected);
      const currentDocumentId = snapshots.at(-1)!.documentId;
      need(currentDocumentId > prior, '导航未推进文档世代');
      navigationEvents.push({
        elapsedMs: performance.now() - workloadStart,
        tabIdHash: sha(tabId),
        priorDocumentId: prior,
        currentDocumentId,
      });
      nextNavigate += 600_000;
    }
    if (now >= nextRecreate) {
      const index = Math.floor((now - workloadStart) / 900_000) % tabIds.length;
      const oldId = tabIds[index]!;
      await evaluate(`window.aibrowse.tabs.close(${JSON.stringify(oldId)})`);
      await waitFor(
        `window.aibrowse.tabs.list().then(v=>v.length===9&&!v.some(t=>t.id===${JSON.stringify(oldId)})?v:null)`,
        '关闭精确Tab',
      );
      const createStarted = performance.now();
      const created = await evaluate(
        `window.aibrowse.tabs.create(${JSON.stringify(`${base}/page/${index}?g=${generation}`)})`,
      );
      need(
        created !== null &&
          typeof created === 'object' &&
          typeof (created as { id?: unknown }).id === 'string',
        '重建Tab失败',
      );
      const newId = (created as { id: string }).id;
      tabIds[index] = newId;
      tabExpectations.delete(oldId);
      const expected = { pageIndex: index, generation, documentId: null };
      tabExpectations.set(newId, expected);
      await waitFor(
        `window.aibrowse.tabs.list().then(v=>v.length===10&&v.some(t=>t.id===${JSON.stringify(newId)}&&t.state==='ready')?v:null)`,
        '重建Tab ready',
        5_000,
      );
      const createdMs = performance.now() - createStarted;
      need(createdMs <= 5_000, '重建Tab超过绝对上限');
      createLatencies.push(createdMs);
      await measureSnapshot(newId, expected);
      ownershipEvents.push({
        elapsedMs: performance.now() - workloadStart,
        closedTabIdHash: sha(oldId),
        createdTabIdHash: sha(newId),
      });
      nextRecreate += 900_000;
    }
    await sleep(25);
  }
  const workloadEnd = performance.now();
  need(appMetrics.length < 721, 'appMetrics时点超限');
  appMetrics.push({
    elapsedMs: workloadEnd - workloadStart,
    members: app.getAppMetrics().map((member) => ({
      pid: member.pid,
      type: member.type,
      cpu: member.cpu,
      memory: member.memory,
    })),
  });
  const finalTabs = (await evaluate('window.aibrowse.tabs.list()')) as Array<{
    id: string;
    state: string;
  }>;
  need(
    finalTabs.length === 10 && tabIds.every((id) => finalTabs.some((tab) => tab.id === id)),
    '最终Tab所有权不符',
  );
  writeNew('runtime-result.json', {
    version: 1,
    mode: control.mode,
    startupMs,
    durationMs: workloadEnd - workloadStart,
    workloadStartProcessMs: workloadStart,
    workloadEndProcessMs: workloadEnd,
    metricsObservation100Ms,
    tabIds,
    finalTabs,
    latencies,
    createLatencies,
    snapshots,
    ownershipEvents,
    interactionEvents,
    navigationEvents,
    appMetrics,
    localFixture: { pages: 10, kinds: 3 },
    provider: control.externalProviderStatus,
    research: 'not-run',
    sourcesSearch: 'not-run',
  });
  await finishWindow();
}

app.on('web-contents-created', (_event, contents) => {
  contents.once('render-process-gone', () => fail(new Error('受控WebContents异常退出')));
});
app.on('browser-window-created', (_event, candidate) => {
  if (window !== null) {
    fail(new Error('只允许一个主窗口'));
    return;
  }
  window = candidate;
  candidate.webContents.once('did-finish-load', () => {
    void (baselineIteration === null ? runSteady() : runBaseline(baselineIteration)).catch(fail);
  });
});
setTimeout(() => fail(new Error('固定总期限耗尽')), Math.max(1, remaining())).unref();
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
async function bootstrap(): Promise<void> {
  let requestedPort = 0;
  if (!setupMode) {
    const portData = JSON.parse(readFileSync(join(scope, 'fixture-port.json'), 'utf8')) as {
      version?: unknown;
      port?: unknown;
    };
    need(
      portData.version === 1 &&
        Number.isSafeInteger(portData.port) &&
        Number(portData.port) >= 1024 &&
        Number(portData.port) <= 65_535,
      'fixture端口证明无效',
    );
    requestedPort = Number(portData.port);
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, '127.0.0.1', resolve);
  });
  const address = server.address();
  need(address !== null && typeof address === 'object', 'fixture监听失败');
  base = `http://127.0.0.1:${address.port}`;
  if (setupMode) {
    await app.whenReady();
    const credentials = new SecureCredentialStoreImpl(profile, new SafeStorageCipher());
    need(
      await credentials.set('openai-compatible', 'sk-performance-local-only'),
      'DPAPI夹具写入失败',
    );
    const generation = credentials.getGeneration?.('openai-compatible') ?? null;
    need(generation !== null, 'DPAPI夹具世代缺失');
    const config = new ConfigStore(profile, credentials);
    need(
      config.commitAuthorized(
        {
          providerId: 'openai-compatible',
          baseUrl: `${base}/v1`,
          model: 'performance-local',
        },
        config.getVersion(),
        generation,
      ),
      '本地Provider绑定失败',
    );
    writeNew('fixture-port.json', { version: 1, port: address.port });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // safeStorage can depend on Electron profile state that is finalized during
    // normal shutdown. app.exit() skips that lifecycle and made the next process
    // unable to decrypt the just-written controlled credential.
    app.quit();
    return;
  }
  createRequire(__filename)('./out/main/index.js');
}
void bootstrap().catch(fail);
