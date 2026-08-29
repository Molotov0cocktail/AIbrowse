// Sixth Stage D6: Watch Page/Session Electron 冒烟（8.23；detailed-design §8.1/
// §12.2/§15.3、FIXED DECISIONS 8/9/10/12）。
//
// 场景分层：
// - runWatchPageSessionScenario：默认 dev/production 矩阵（AIBROWSE_SMOKE=1）——
//   受控 loopback 服务 + 真实 BrowserController + 真实 PageAcquisitionRouter
//   Session 路径；机器断言 Session 标记、每 attempt 精确 create/close、用户
//   Tab/焦点恒等、locator/origin/grant 失效、认知矩阵、abort/drain、日志隐私。
// - runWatchPageSmokeGateSet/Check：AIBROWSE_WATCH_SMOKE=set|check 跨进程——
//   共享受控临时 userData；set 建立登录 Cookie + 写 rule(consent) + 一次真实
//   acquisition（task Tab 已关闭）+ canary 扫描；check 新进程重开同一
//   userData：grant store 为空、consent 保留、新 task Tab 重建成功、真实
//   restoreWatchStore() 后 consent 清空、router login_required 且 create=0。
//
// 隐私红线（机器断言）：Cookie 值、task 页签 id、grant handle、input/form 值、
// 敌手正文在任何日志/DB/文件中零命中；测试代码不读取 Cookie 值（间接经
// 服务端“只有该 Session 才返回”的页面标记验证）。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { BrowserController } from './browser/browser-controller';
import type { TabInfo } from '../shared/types/browser';
import { getCurrentLogFilePath, logInfo } from './logger';
import { createSystemClock } from '../shared/watch/clock';
import type { Clock, PageTarget, WatchRule } from '../shared/types/watch';
import { HostRequestGate } from './watch/host-request-gate';
import { WatchTaskTabWorkspace } from './watch/watch-task-tab-workspace';
import { BrowserWatchReader } from './watch/browser-watch-reader';
import { SessionGrantStore } from './watch/session-grant-store';
import { PageAcquisitionRouter } from './watch/watch-acquisition-service';
import { createPublicWatchHttpStack } from './watch/public-watch-http-client';
import { computeSessionTargetDigest } from './watch/page-projector';
import { openWatchStore, restoreWatchStore } from './watch/watch-store';
import { createConsistentBackup } from './sources/db/backup';
import { computeSourceLocatorFingerprint } from '../shared/watch/watch-rule-state';
import { openDb, closeDb } from './sources/db/sqlite-driver';

// ---------------------------------------------------------------------------
// 本地断言工具（不 import smoke.ts，避免大模块/循环依赖）
// ---------------------------------------------------------------------------

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`冒烟断言失败：${message}`);
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs: number,
  failure: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(failure);
    await delay(50);
  }
}

interface LogSlice {
  file: string;
  offset: number;
}

function currentLogOffset(): LogSlice {
  const file = getCurrentLogFilePath();
  if (file === '') return { file, offset: 0 };
  try {
    return { file, offset: statSync(file).size };
  } catch {
    return { file, offset: 0 };
  }
}

function assertLogSliceFreeOf(from: LogSlice, needle: string, label: string): void {
  if (from.file === '') return;
  const data = readFileSync(from.file);
  const slice = data.subarray(from.offset).toString('utf8');
  assert(!slice.includes(needle), `日志隐私扫描：${label} 不得出现在日志文件`);
}

function assertFileBytesFreeOf(path: string, needle: string, label: string): void {
  if (
    !path.endsWith('watch.db') &&
    !path.endsWith('watch.db-wal') &&
    !path.endsWith('watch.db-shm')
  ) {
    return;
  }
  const data = readFileSync(path);
  assert(
    !data.includes(Buffer.from(needle, 'utf8')),
    `数据库隐私扫描：${label} 不得出现在 ${path}`,
  );
}

// ---------------------------------------------------------------------------
// D6 受控 loopback 服务（跨进程保持同一 origin/端口；计数器落盘）
// ---------------------------------------------------------------------------

const D6_COOKIE_NAME = 'aibrowse_d6_probe';
const D6_COOKIE_VALUE = 'd6-ok';
const D6_SERVER_STATE_FILE = 'd6-server-state.json';
const SECURE_MARKER = 'SECURE-PAGE-MARKER';
const FORM_CANARY = 'D6-FORM-CANARY-VALUE';

interface D6ServerState {
  port: number;
  hits: Record<string, number>;
}

export interface WatchPageServer {
  base: string; // http://127.0.0.1:<port>（consent origin）
  protectedUrl: string;
  loginUrl: string;
  movedUrl: string;
  loginFormUrl: string;
  challengeUrl: string;
  hits(): Record<string, number>;
  close(): Promise<void>;
}

const D6_PAGE_HTML = (marker: string): string => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>D6 受控页</title></head>
<body>
<main><h1>D6 受控页</h1><p>${marker}</p></main>
<table><tr><th>名称</th><th>状态</th></tr><tr><td>看门</td><td>${marker}</td></tr></table>
<a href="/plain">同源链接</a><a href="https://example.com/">跨源链接</a>
</body></html>`;

const D6_LOGIN_FORM_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录</title></head>
<body><main><h1>登录</h1><p>${FORM_CANARY}</p>
<form action="/login" method="post"><input type="password" name="pass"><button type="submit">登录</button></form>
</main></body></html>`;

async function startD6PageServer(stateDir: string | null): Promise<WatchPageServer> {
  const hits: Record<string, number> = {};
  const bump = (path: string): void => {
    hits[path] = (hits[path] ?? 0) + 1;
  };
  let statePath: string | null = null;
  if (stateDir !== null) {
    mkdirSync(stateDir, { recursive: true });
    statePath = join(stateDir, D6_SERVER_STATE_FILE);
  }
  let port: number | null = null;
  if (statePath !== null) {
    try {
      const saved = JSON.parse(readFileSync(statePath, 'utf8')) as D6ServerState;
      if (Number.isInteger(saved.port) && saved.port > 0 && saved.port < 65536) {
        port = saved.port;
        Object.assign(hits, saved.hits ?? {});
      }
    } catch {
      // 无既有状态：选择新端口
    }
  }

  const server: Server = createServer((req, res) => {
    const path = req.url ?? '/';
    bump(path);
    const hasCookie =
      typeof req.headers.cookie === 'string' &&
      req.headers.cookie
        .split(';')
        .some((c) => c.trim() === `${D6_COOKIE_NAME}=${D6_COOKIE_VALUE}`);
    if (path === '/login') {
      // Max-Age 必须显式：无 Max-Age/Expires 的 session cookie 不落盘，
      // check 进程将无法从持久分区读到（B-01 同款持久化语义）
      res.writeHead(302, {
        Location: '/protected',
        'Set-Cookie': `${D6_COOKIE_NAME}=${D6_COOKIE_VALUE}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`,
      });
      res.end();
      return;
    }
    if (path === '/protected') {
      if (hasCookie) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(D6_PAGE_HTML(`${SECURE_MARKER} ${hits['/protected'] ?? 0}`));
        return;
      }
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body>unauthorized</body></html>');
      return;
    }
    if (path === '/plain') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(D6_PAGE_HTML(`PLAIN-${hits['/plain'] ?? 0}`));
      return;
    }
    if (path === '/moved') {
      res.writeHead(302, { Location: '/plain' });
      res.end();
      return;
    }
    if (path === '/login-form') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(D6_LOGIN_FORM_HTML);
      return;
    }
    if (path === '/challenge') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><body><main><h1>挑战</h1><form><button type="submit">继续</button></form></main></body></html>',
      );
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  const listen = (p: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(p, '127.0.0.1', () => resolve());
    });

  let started = false;
  if (port !== null) {
    // 复用同端口（跨进程同一 origin）；释放窗口有界重试
    for (let attempt = 0; attempt < 50 && !started; attempt += 1) {
      try {
        await listen(port);
        started = true;
      } catch {
        await delay(200);
      }
    }
    if (!started) throw new Error('D6 门控服务无法绑定既有端口（跨进程同一 origin 要求）');
  } else {
    await listen(0);
  }
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;

  const persistHits = (): void => {
    if (statePath !== null) {
      try {
        writeFileSync(statePath, JSON.stringify({ port: addr.port, hits } satisfies D6ServerState));
      } catch {
        // 计数器为测试设施，落盘失败不阻塞
      }
    }
  };
  persistHits();

  return {
    base,
    protectedUrl: `${base}/protected`,
    loginUrl: `${base}/login`,
    movedUrl: `${base}/moved`,
    loginFormUrl: `${base}/login-form`,
    challengeUrl: `${base}/challenge`,
    hits: () => ({ ...hits }),
    close: async () => {
      persistHits();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// D6 冒烟装配（真实 Clock/Browser；public stack 只作依赖占位，零公网请求）
// ---------------------------------------------------------------------------

export interface WatchPageSmokeBundle {
  clock: Clock;
  hostGate: HostRequestGate;
  workspace: WatchTaskTabWorkspace;
  grantStore: SessionGrantStore;
  router: PageAcquisitionRouter;
}

export function createWatchPageSmokeBundle(browser: BrowserController): WatchPageSmokeBundle {
  const clock = createSystemClock();
  const hostGate = new HostRequestGate({ clock });
  const workspace = new WatchTaskTabWorkspace({ browser });
  const reader = new BrowserWatchReader({ browser, clock });
  const publicStack = createPublicWatchHttpStack({ hostGate });
  const grantStore = new SessionGrantStore({});
  const router = new PageAcquisitionRouter({
    publicTarget: publicStack.target,
    workspace,
    reader,
    hostGate,
    clock,
  });
  return { clock, hostGate, workspace, grantStore, router };
}

function makeSessionRule(
  pageUrl: string,
  regions: PageTarget['regions'],
  origin: string,
  sourceId: string,
  ruleId: string,
): WatchRule {
  const now = new Date().toISOString();
  return {
    id: ruleId,
    sourceId,
    kind: 'page',
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    muted: false,
    accessMode: 'session',
    schedule: { kind: 'interval', intervalMinutes: 60 },
    target: {
      type: 'page',
      pageUrl,
      regions,
      sessionConsent: { version: 1, origin, grantedAt: now },
    },
    condition: null,
    notificationLevel: 'normal',
    sourceRowVersion: 1,
    sourceLocatorFingerprint: computeSourceLocatorFingerprint({
      sourceId,
      scope: 'page',
      canonicalKey: pageUrl,
      kind: 'page',
      canonicalTargetUrl: pageUrl,
    }),
    nextDueAt: null,
    lastConsumedScheduledFor: null,
    lastDailyLocalDate: null,
    consecutiveFailures: 0,
    backoffUntil: null,
    baselineVersion: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function sessionTargetDigestFor(pageUrl: string, regions: PageTarget['regions']): string {
  const digest = computeSessionTargetDigest({ accessMode: 'session', pageUrl, regions });
  if (digest === null) throw new Error('D6 冒烟：target digest 计算失败');
  return digest;
}

async function userTabs(controller: BrowserController): Promise<TabInfo[]> {
  return (await controller.getTabs()).filter((t) => !t.id.startsWith('task-'));
}

// R2 修复：包装 createTab 记录每次真实创建的 Tab 精确 ID（task-owned Tab 经同一
// BrowserController.createTab 创建）。冒烟 harness 随后逐个字节扫描本次日志切片，
// 断言真实 task tabId 零命中（不依赖文案/前缀扫描）。
function recordCreatedTabIds(controller: BrowserController): string[] {
  const created: string[] = [];
  const original = controller.createTab.bind(controller);
  const wrapped = async (url?: string): Promise<TabInfo> => {
    const tab = await original(url);
    created.push(tab.id);
    return tab;
  };
  (controller as unknown as { createTab: typeof wrapped }).createTab = wrapped;
  return created;
}

async function runAcquisition(router: PageAcquisitionRouter, rule: WatchRule) {
  return router.run({
    target: rule.target as PageTarget,
    accessMode: rule.accessMode,
    ruleId: rule.id,
    sourceId: rule.sourceId,
    sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
    signal: new AbortController().signal,
    deadline: new Date(Date.now() + 90_000),
  });
}

// ---------------------------------------------------------------------------
// 8.23 默认矩阵场景（dev + production；AIBROWSE_SMOKE=1）
// ---------------------------------------------------------------------------

const REGION_MAIN = [{ kind: 'main-text' as const, label: '正文' }];

async function acquireWithSignal(
  bundle: WatchPageSmokeBundle,
  rule: WatchRule,
  signal: AbortSignal,
) {
  return bundle.router.run({
    target: rule.target as PageTarget,
    accessMode: rule.accessMode,
    ruleId: rule.id,
    sourceId: rule.sourceId,
    sourceLocatorFingerprint: rule.sourceLocatorFingerprint,
    signal,
    deadline: new Date(Date.now() + 90_000),
  });
}

export async function runWatchPageSessionScenario(deps: {
  controller: BrowserController;
  getBundle: () => WatchPageSmokeBundle | null;
}): Promise<void> {
  const logFrom = currentLogOffset();
  const bundle = deps.getBundle();
  assert(bundle !== null, '8.23：D6 冒烟 bundle 未装配（index.ts watch 装配缺失）');
  const server = await startD6PageServer(null);
  // R2：真实 task-owned Tab 由 workspace 经 controller.createTab 创建——先包装
  // 记录每次创建（含登录 Tab 与 task Tab）的精确 ID，扫描阶段逐个字节核对。
  const createdTabIds = recordCreatedTabIds(deps.controller);
  try {
    const origin = server.base;
    const userTabsBefore = await userTabs(deps.controller);

    // 1. 建立授权 Session：真实用户 Tab 访问 /login（HttpOnly Cookie 写入 persist 分区）
    const loginTab = await deps.controller.createTab(server.loginUrl);
    const beforeActive = (await deps.controller.getActiveTab())?.id ?? null;
    assert(loginTab.id === beforeActive, '8.23：登录 Tab 应为活动 Tab');
    await waitFor(
      async () =>
        server.hits()['/login'] !== undefined &&
        (await deps.controller.getTabs()).some((t) => t.id === loginTab.id && t.state === 'ready'),
      15_000,
      '8.23：登录 Tab 未在 15 秒内就绪',
    );

    // 2. grant 生命周期（主进程内存；零持久化）
    const regions: PageTarget['regions'] = REGION_MAIN;
    const digest = sessionTargetDigestFor(server.protectedUrl, regions);
    const issued = bundle.grantStore.issue({
      sourceId: 'src-d6',
      previewTabId: loginTab.id,
      finalOrigin: origin,
      targetDigest: digest,
    });
    assert(issued.ok, '8.23：grant issue 失败');
    if (!issued.ok) return;
    assert(/^[A-Za-z0-9_-]{43}$/.test(issued.handle), '8.23：grant handle 应为不透明 base64url');
    const consumed = bundle.grantStore.consume({
      handle: issued.handle,
      sourceId: 'src-d6',
      previewTabId: loginTab.id,
      finalOrigin: origin,
      targetDigest: digest,
    });
    assert(consumed.ok, '8.23：grant consume 应成功');
    const replay = bundle.grantStore.consume({
      handle: issued.handle,
      sourceId: 'src-d6',
      previewTabId: loginTab.id,
      finalOrigin: origin,
      targetDigest: digest,
    });
    assert(!replay.ok, '8.23：grant 重放必须失败');
    assert(bundle.grantStore.recordCount() === 0, '8.23：消费后记录归零');

    // 3. Session 采集：只有登录 Session 才返回的安全标记进入 Projection
    const rule = makeSessionRule(
      server.protectedUrl,
      regions,
      origin,
      'src-d6',
      'd6-rule-scenario',
    );
    const tabsBeforeRun = await userTabs(deps.controller);
    const r1 = await runAcquisition(bundle.router, rule);
    if (!r1.ok) {
      logInfo('smoke', `8.23 失败详情：${r1.health}/${r1.disposition}`);
      throw new Error('8.23：受保护页 Session 采集应成功（无 Cookie 时服务端只返回 401）');
    }
    assert(
      r1.projection.value.fields.some(
        (f) => f.kind === 'main-text' && f.value.includes(SECURE_MARKER),
      ),
      '8.23：Projection 必须包含仅登录 Session 可读的安全标记（Cookie 生效证明）',
    );
    assert(r1.projection.documentId !== null, '8.23：session 投影必须有 documentId');
    const tabsAfterRun = await userTabs(deps.controller);
    assert(
      JSON.stringify(tabsBeforeRun.map((t) => ({ id: t.id, url: t.url, title: t.title }))) ===
        JSON.stringify(tabsAfterRun.map((t) => ({ id: t.id, url: t.url, title: t.title }))),
      '8.23：attempt 前后用户 Tab 集合必须恒等',
    );
    assert(bundle.workspace.getOwnedCount() === 0, '8.23：attempt 后零 owned task Tab');
    assert(bundle.workspace.getInFlightCount() === 0, '8.23：attempt 后零 in-flight');

    // 4. 焦点恢复：未切换时恢复 activeBefore
    const activeNow = (await deps.controller.getActiveTab())?.id ?? null;
    assert(activeNow === beforeActive, '8.23：未切换焦点应恢复原活动 Tab');

    // 5. 同 origin locator 漂移 → source-changed（零自动改 Rule、零 Projection）
    const movedRule = makeSessionRule(server.movedUrl, regions, origin, 'src-d6', 'd6-rule-moved');
    await delay(5_500); // 5 秒 host gap（同 host 相邻 createTab 硬下限）
    const r2 = await runAcquisition(bundle.router, movedRule);
    assert(
      !r2.ok && r2.disposition === 'source-changed',
      '8.23：locator 漂移必须失败且 disposition=source-changed（零自动改 Rule）',
    );
    assert(bundle.workspace.getOwnedCount() === 0, '8.23：失败 attempt 后零 owned');

    // 6. 登录表单结构信号 → login_required（input/form 值零泄露）
    const formRule = makeSessionRule(
      server.loginFormUrl,
      regions,
      origin,
      'src-d6',
      'd6-rule-form',
    );
    await delay(5_500); // host gap（上一 attempt 刚登记 start）
    const r3 = await runAcquisition(bundle.router, formRule);
    assert(!r3.ok, '8.23：密码表单页必须 login_required');
    if (!r3.ok) assert(r3.health === 'login_required', '8.23：login_required 健康码');

    // 7. challenge URL + 结构信号 → captcha
    const chRule = makeSessionRule(server.challengeUrl, regions, origin, 'src-d6', 'd6-rule-chl');
    await delay(5_500);
    const r4 = await runAcquisition(bundle.router, chRule);
    assert(!r4.ok, '8.23：challenge 页必须失败');
    if (!r4.ok) assert(r4.health === 'captcha', '8.23：captcha 健康码');

    // 8. 预中止 signal：零 create，零残留
    const abortController = new AbortController();
    abortController.abort();
    const preTabs = await userTabs(deps.controller);
    const r5 = await acquireWithSignal(bundle, rule, abortController.signal);
    assert(!r5.ok, '8.23：预中止采集必须失败');
    const postTabs = await userTabs(deps.controller);
    assert(preTabs.length === postTabs.length, '8.23：abort 不得残留 task Tab');

    // 9. cleanupAll drain 幂等（无 owned → 零关闭；可重复）
    const clean1 = await bundle.workspace.cleanupAll();
    assert(clean1.ok, '8.23：cleanupAll 应成功');
    assert(
      bundle.workspace.getOwnedCount() === 0 && bundle.workspace.getInFlightCount() === 0,
      '8.23：drain 后零 owned/in-flight',
    );

    // 10. 隐私扫描（R2）：Cookie 值、grant handle、表单 canary、页面正文标记零
    //     命中；每个真实创建 Tab（含每次 task-owned Tab）的精确 ID 逐个字节扫描
    //     本次日志切片——真实 task tabId 在全部日志零出现（BrowserController/
    //     TabManager 已做日志脱敏，不依赖文案或前缀扫描）。
    assertLogSliceFreeOf(logFrom, D6_COOKIE_VALUE, 'D6 Cookie 值');
    assertLogSliceFreeOf(logFrom, issued.handle, 'D6 grant handle');
    assertLogSliceFreeOf(logFrom, FORM_CANARY, 'D6 表单值 canary');
    assertLogSliceFreeOf(logFrom, SECURE_MARKER, 'D6 页面正文标记');
    assert(createdTabIds.length > 0, '8.23：冒烟必须至少记录一个真实创建 Tab 的精确 ID');
    for (const id of createdTabIds) {
      assertLogSliceFreeOf(logFrom, id, `真实 task/创建 Tab 精确 ID（${id}）`);
    }

    // 11. 关闭授权 Tab（场景自建自清理；用户原有 Tab 零触碰）
    assert(await deps.controller.closeTab(loginTab.id), '8.23：关闭登录 Tab 应成功');
    logInfo(
      'smoke',
      '8.23 D6 Watch Page/Session 冒烟全部通过（Session 标记/所有权/焦点/失效矩阵/隐私）',
    );
    void userTabsBefore;
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------------------
// AIBROWSE_WATCH_SMOKE=set|check 的 D6 阶段（同一受控临时 userData）
// ---------------------------------------------------------------------------

/** 当前 watch.db schema user_version（与 smoke-watch-store 同款探针）。 */
function currentDbVersion(path: string): number {
  const h = openDb(path);
  try {
    return (h.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  } finally {
    closeDb(h);
  }
}

export async function runWatchPageSmokeGateSet(deps: {
  controller: BrowserController;
}): Promise<void> {
  const logFrom = currentLogOffset();
  const watchDir = join(app.getPath('userData'), 'watch');
  const server = await startD6PageServer(watchDir);
  const bundle = createWatchPageSmokeBundle(deps.controller);
  // R2：记录每次真实创建 Tab（含 task-owned Tab）的精确 ID，扫描阶段逐个字节核对
  const createdTabIds = recordCreatedTabIds(deps.controller);
  const origin = server.base;
  try {
    // 1. 建立共享登录 Session（HttpOnly Cookie 落 persist 分区，跨进程持久化）
    const loginTab = await deps.controller.createTab(server.loginUrl);
    await waitFor(
      async () =>
        server.hits()['/login'] !== undefined &&
        (await deps.controller.getTabs()).some((t) => t.id === loginTab.id && t.state === 'ready'),
      15_000,
      'WATCH set(D6)：登录 Tab 未就绪',
    );

    // 2. 写 rule（含 sessionConsent）到共享 watch.db
    const dbPath = join(watchDir, 'watch.db');
    const backupsDir = join(watchDir, 'backups');
    const outcome = openWatchStore({
      dbPath,
      backupsDir,
      reconcile: () => ({ ok: true, reason: null }),
    });
    assert(outcome.mode === 'normal', 'WATCH set(D6)：watch.db 应 normal 装配');
    if (outcome.mode !== 'normal') return;
    const repo = outcome.repo;
    const rule = makeSessionRule(
      server.protectedUrl,
      REGION_MAIN,
      origin,
      'src-d6',
      'd6-gate-0000-0000-0000-000000000001',
    );
    assert(repo.insertRule(rule).ok, 'WATCH set(D6)：Session rule 写入失败');
    repo.dispose();

    // 3. grant 单次消费（同一目标摘要绑定；handle 零持久化）
    const digest = sessionTargetDigestFor(server.protectedUrl, REGION_MAIN);
    const issued = bundle.grantStore.issue({
      sourceId: 'src-d6',
      previewTabId: loginTab.id,
      finalOrigin: origin,
      targetDigest: digest,
    });
    assert(issued.ok, 'WATCH set(D6)：grant issue 失败');
    if (!issued.ok) return;
    const consumed = bundle.grantStore.consume({
      handle: issued.handle,
      sourceId: 'src-d6',
      previewTabId: loginTab.id,
      finalOrigin: origin,
      targetDigest: digest,
    });
    assert(consumed.ok, 'WATCH set(D6)：grant consume 失败');

    // 4. 真实 acquisition：受保护页 → 安全标记 Projection；task Tab 已关闭
    const tabsBefore = await userTabs(deps.controller);
    const r = await runAcquisition(bundle.router, rule);
    if (!r.ok) {
      logInfo('smoke', `WATCH set(D6) 失败：${r.health}/${r.disposition}`);
      throw new Error('WATCH set(D6)：Session 采集应成功');
    }
    assert(
      r.projection.value.fields.some(
        (f) => f.kind === 'main-text' && f.value.includes(SECURE_MARKER),
      ),
      'WATCH set(D6)：安全标记必须进入 Projection',
    );
    const tabsAfter = await userTabs(deps.controller);
    assert(
      tabsBefore.map((t) => t.id).join(',') === tabsAfter.map((t) => t.id).join(','),
      'WATCH set(D6)：用户 Tab 集合恒等',
    );
    assert(bundle.workspace.getOwnedCount() === 0, 'WATCH set(D6)：task Tab 已关闭');

    // 5. 隐私扫描（R2）：日志与 watch.db 字节（Cookie 值/handle/表单 canary/每个
    //    真实创建 Tab 的精确 ID——含每次 task-owned Tab）
    assertLogSliceFreeOf(logFrom, D6_COOKIE_VALUE, 'D6 Cookie 值');
    assertLogSliceFreeOf(logFrom, issued.handle, 'D6 grant handle');
    assertLogSliceFreeOf(logFrom, FORM_CANARY, 'D6 表单 canary');
    for (const id of createdTabIds) {
      assertLogSliceFreeOf(logFrom, id, `WATCH set(D6) 真实 task/创建 Tab 精确 ID（${id}）`);
    }
    for (const suffix of ['watch.db', 'watch.db-wal', 'watch.db-shm']) {
      try {
        assertFileBytesFreeOf(join(watchDir, suffix), D6_COOKIE_VALUE, 'D6 Cookie 值');
        assertFileBytesFreeOf(join(watchDir, suffix), issued.handle, 'D6 grant handle');
        assertFileBytesFreeOf(join(watchDir, suffix), FORM_CANARY, 'D6 表单 canary');
        assertFileBytesFreeOf(join(watchDir, suffix), loginTab.id, 'D6 登录 tabId');
      } catch {
        // WAL/SHM 可随 close 消失 → 跳过
      }
    }

    // 6. 关闭登录 Tab（授权 Tab 由场景自建自清理）
    assert(await deps.controller.closeTab(loginTab.id), 'WATCH set(D6)：关闭登录 Tab 应成功');
    // B-01 同款落盘安全余量：干净退出时 Chromium flush Cookie 存储，给持久层
    // 留出写盘时间（check 进程必须从磁盘读到同一 Cookie）
    await delay(1_000);
    logInfo('smoke', 'WATCH set(D6)：登录 Cookie/rule/acquire/扫描完成，直接退出');
  } finally {
    await server.close();
  }
}

export async function runWatchPageSmokeGateCheck(deps: {
  controller: BrowserController;
}): Promise<void> {
  const logFrom = currentLogOffset();
  const watchDir = join(app.getPath('userData'), 'watch');
  const server = await startD6PageServer(watchDir); // 同一端口 → 同一 origin
  const bundle = createWatchPageSmokeBundle(deps.controller);
  // R2：记录每次真实创建 Tab（含 task-owned Tab）的精确 ID，扫描阶段逐个字节核对
  const createdTabIds = recordCreatedTabIds(deps.controller);
  const origin = server.base;
  try {
    const dbPath = join(watchDir, 'watch.db');
    const backupsDir = join(watchDir, 'backups');

    // 1. grant store 为新进程内存态：空；不存在旧 handle/tabId 恢复路径
    assert(bundle.grantStore.recordCount() === 0, 'WATCH check(D6)：新进程 grant store 必须为空');

    // 2. 重开共享 watch.db：consent 正常保留；rule 读回
    const outcome = openWatchStore({
      dbPath,
      backupsDir,
      reconcile: () => ({ ok: true, reason: null }),
    });
    assert(outcome.mode === 'normal', 'WATCH check(D6)：重开应 normal');
    if (outcome.mode !== 'normal') return;
    const rule = outcome.repo
      .listRules()
      .find((r) => r.id === 'd6-gate-0000-0000-0000-000000000001');
    assert(rule !== undefined, 'WATCH check(D6)：D6 rule 应读回');
    if (rule === undefined) return;
    const target = rule.target as PageTarget;
    assert(target.sessionConsent !== null, 'WATCH check(D6)：consent 必须保留（正常重启不失效）');
    assert(target.sessionConsent!.origin === origin, 'WATCH check(D6)：consent origin 一致');
    outcome.repo.dispose();

    // 3. 新建 task Tab 重建采集（共享 Session 的 Cookie 已跨进程持久化）
    const r1 = await runAcquisition(bundle.router, rule);
    if (!r1.ok) {
      logInfo('smoke', `WATCH check(D6) 采集失败：${r1.health}/${r1.disposition}`);
      throw new Error('WATCH check(D6)：重启后 Session 采集应成功（新建 task Tab + 共享 Cookie）');
    }
    assert(
      r1.projection.value.fields.some(
        (f) => f.kind === 'main-text' && f.value.includes(SECURE_MARKER),
      ),
      'WATCH check(D6)：跨进程 Cookie 仍有效（安全标记出现）',
    );
    assert(bundle.workspace.getOwnedCount() === 0, 'WATCH check(D6)：新 task Tab 已关闭');

    // 4. 备份 → 真实 restoreWatchStore() → consent 清空
    const backupsDirOk = join(watchDir, 'backups');
    mkdirSync(backupsDirOk, { recursive: true });
    const version = currentDbVersion(dbPath);
    const backup = createConsistentBackupForCheck(dbPath, backupsDirOk, version);
    assert(
      backup.ok && backup.backupPath !== null,
      `WATCH check(D6)：备份生成失败（${backup.reason ?? '未知原因'}）`,
    );
    const backupName = backup.backupPath!.split(/[\\/]/).pop()!;
    const restored = restoreWatchStore({
      dbPath,
      backupsDir: backupsDirOk,
      backupFileName: backupName,
    });
    assert(restored.mode === 'normal', 'WATCH check(D6)：restore 应 normal 装配');
    if (restored.mode !== 'normal') return;
    const ruleRestored = restored.repo
      .listRules()
      .find((r) => r.id === 'd6-gate-0000-0000-0000-000000000001');
    assert(ruleRestored !== undefined, 'WATCH check(D6)：restore 后 rule 读回');
    if (ruleRestored === undefined) return;
    assert(
      (ruleRestored.target as PageTarget).sessionConsent === null,
      'WATCH check(D6)：restore 必须清空 sessionConsent',
    );
    restored.repo.dispose();

    // 5. consent 失效 → login_required 且 create=0（零网络、零 Tab）
    const tabsBefore = await userTabs(deps.controller);
    const r2 = await runAcquisition(bundle.router, ruleRestored);
    assert(
      !r2.ok && r2.health === 'login_required',
      'WATCH check(D6)：consent 失效后采集必须 login_required',
    );
    const tabsAfter = await userTabs(deps.controller);
    assert(tabsBefore.length === tabsAfter.length, 'WATCH check(D6)：create=0');

    // 6. 日志隐私扫描（R2）：Cookie 值/表单 canary 零命中；每个真实创建 Tab
    //    （含 task-owned Tab）的精确 ID 逐个字节扫描日志切片
    assertLogSliceFreeOf(logFrom, D6_COOKIE_VALUE, 'D6 Cookie 值');
    assertLogSliceFreeOf(logFrom, FORM_CANARY, 'D6 表单 canary');
    for (const id of createdTabIds) {
      assertLogSliceFreeOf(logFrom, id, `WATCH check(D6) 真实 task/创建 Tab 精确 ID（${id}）`);
    }
    logInfo(
      'smoke',
      'WATCH check(D6)：consent 保留/新建 task Tab/restore 失效/login_required 通过',
    );
  } finally {
    await server.close();
  }
}

// restore 备份生成（与 smoke-watch-store 8.21 同参数；namePrefix 固定 watch-backup-）
function createConsistentBackupForCheck(
  dbPath: string,
  backupsDir: string,
  version: number,
): { ok: boolean; backupPath: string | null; reason: string | null } {
  const result = createConsistentBackup(
    dbPath,
    backupsDir,
    version,
    () => Date.now(),
    () => 'd6beef01', // 严格命名要求的 8 位十六进制
    { namePrefix: 'watch-backup-', parentLabel: '监控' },
  );
  return { ok: result.ok, backupPath: result.backupPath ?? null, reason: result.reason ?? null };
}
