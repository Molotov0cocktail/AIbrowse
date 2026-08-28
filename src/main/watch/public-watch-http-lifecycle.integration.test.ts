// D3-R7: 真实 Node 24 localhost/子进程生命周期 oracle（#S6-043 两阶段协议）。
// - 子进程只安装 uncaughtExceptionMonitor（只观察、不恢复）与 unhandledRejection 记录；
//   不添加任何 request/response error observer 掩盖缺陷（具名对照 observer 单独标注为对照事实，
//   且必须按 callback identity 从 listenerCount/名称断言中排除）。
// - 经 Vite build（package.json 直接声明的 devDependency，不导入未声明的传递依赖）把「当前产品
//   源码」bundle 为 CJS 供子进程 require，保证子进程运行的就是当前 HEAD 产品代码，而非 Fake seam。
// - 真实场景区分两类确定性的 socket 状态（不再用固定 40ms/150ms 延迟推断）：
//   * true pre-socket：request 尚未 end、socket 事件尚未发生即 destroy —— 受控 Clock 令 remaining
//     deadline 到期（feed requestFactory 内把时钟推过 deadline），或 requestFactory 返回前触发
//     AbortController；业务终态同步点断言 socketSeen=false。
//   * socket-after/pre-response：监听真实 request 的 socket 事件，仅在 socketSeen=true 后触发
//     deadline/abort；server 不发送 response；断言 socketSeen=true。
// - pre-socket/pre-response 的 request destroy 在旧 R5 会因未处理 request ECONNRESET 崩溃（exit 1 +
//   "Unhandled 'error' event"，本文件标题沿用该红态语义；R7 修复后 exit 0、monitor/rejection 为零）。
// - response-after 真实绿态证明：业务 Promise 在同步 cleanup/destroy/fallback 后立即结算；request
//   close 清 request drain；product-owned named response drain 在 body reader/destroy 前已安装；
//   response close 后 drain 归零、子进程自然退出（exit 0）。cleanup 顺序 destroy response → destroy
//   request 下 Node 条件发射 response error，由该 drain 接收；不冒充真实 Node 必然顺序。
// - 子进程不调用 process.exit(0)：成功路径自然退出（父进程以 timeout 检测活动句柄泄漏），harness
//   异常设置非零 process.exitCode；JSON 缺失/解析失败/harness 异常必然使测试失败。
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// ---------------------------------------------------------------------------
// 子进程脚本：与测试文件同目录？不——写成独立 JS，只依赖 BUNDLE_PATH/PROBE_MODE 环境变量。
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = String.raw`
'use strict';
const http = require('node:http');
const mode = process.env.PROBE_MODE || 'presocket-deadline';
const out = { mode, events: [], monitor: 0, rejection: 0, socketSeen: false };

process.on('uncaughtExceptionMonitor', (err) => {
  out.monitor += 1;
  out.events.push('monitor:' + (err && err.code));
});
process.on('unhandledRejection', (reason) => {
  out.rejection += 1;
  out.events.push('unhandled-rejection:' + String(reason));
});

const { createPublicWatchHttpStack } = require(process.env.BUNDLE_PATH);

// 受控 Clock：now() 可被推进到 deadline 之后（true pre-socket deadline）；setTimeout 只登记不自动
// 触发，由 fireFeedTimers() 在 socketSeen / response 交付后的微任务里确定性触发（不依赖墙钟延迟）。
let nowMs = 0;
let advance = false;
const timers = new Map();
let nextTimerId = 1;
let feedCreated = false;
const feedTimerIds = [];
function fakeClock() {
  return {
    now: () => new Date(nowMs + (advance ? 30001 : 0)),
    setTimeout: (cb, ms) => {
      const id = nextTimerId++;
      timers.set(id, cb);
      if (feedCreated) feedTimerIds.push(id);
      return { kind: 'timer', id };
    },
    clearTimeout: (h) => {
      if (h && h.id) timers.delete(h.id);
    },
  };
}
function fireFeedTimers() {
  for (const id of feedTimerIds) {
    const cb = timers.get(id);
    if (cb) cb();
  }
}

async function main() {
  const server = http.createServer((req, res) => {
    if (req.url === '/robots.txt') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end();
      return;
    }
    if (req.url.endsWith('2')) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('followup ok');
      return;
    }
    if (mode.indexOf('responseafter') === 0) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.write('hello world');
      return;
    }
    // pre-response: stay silent（不发 response，也不 end）
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  let feedSocketSeen = false;
  let feedReq = null;
  let targetRes = null;
  let responseErrorObserver = null;
  let installedObserver = false;
  const controller = new AbortController();

  const stack = createPublicWatchHttpStack({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 30_000,
    clock: fakeClock(),
    request: (options) => {
      // agent:false → 每个请求独立 socket 且响应/销毁后关闭，保证 server.close 与子进程自然退出。
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method,
        headers: options.headers,
        agent: false,
      });
      if (options.path === '/feed') feedReq = req;
      // 观察真实 request 的 socket 事件：socket 一旦分配即记录 socketSeen（不再用固定延迟推断）。
      req.on('socket', () => {
        if (options.path !== '/feed') return;
        feedSocketSeen = true;
        out.events.push('feed-socket-seen');
        // socket-after/pre-response：仅在 socketSeen=true 后触发 deadline/abort（微任务，非固定延迟）。
        if (mode === 'socketafter-deadline') queueMicrotask(() => fireFeedTimers());
        if (mode === 'socketafter-abort') queueMicrotask(() => controller.abort());
      });
      if (options.path === '/feed' && !feedCreated) {
        feedCreated = true;
        // true pre-socket：request 尚未 end 即触发（受控 Clock 推过 deadline / 返回产品前 abort）。
        if (mode === 'presocket-deadline') advance = true;
        if (mode === 'presocket-abort') controller.abort();
      }
      req.on('response', (res) => {
        if (options.path !== '/feed') return;
        targetRes = res;
        out.events.push('target-res-delivered');
        if (mode === 'responseafter-observer') {
          // 具名对照 observer：保存其身份，listenerCount/名称断言按 callback identity 排除。
          responseErrorObserver = function responseErrorObserver(e) {
            out.events.push('observer-res-error:' + (e && e.code));
          };
          res.on('error', responseErrorObserver);
          installedObserver = true;
        }
        // 交付后一个微任务：产品 onResponse 已同步运行 → response drain 与业务 listener 已安装。
        queueMicrotask(() => {
          const errListeners = res.listeners('error');
          const nonObs = errListeners.filter((f) => f !== responseErrorObserver);
          out.delivery = {
            resErrorCount: nonObs.length,
            resErrorNames: nonObs.map((f) => f.name),
            resCloseNames: res.listeners('close').map((f) => f.name),
            observerInstalled: installedObserver,
            observerIsNamed:
              typeof responseErrorObserver === 'function' &&
              responseErrorObserver.name === 'responseErrorObserver',
            observerIdentityMatches: res.listeners('error').includes(responseErrorObserver),
          };
          out.events.push('delivery-inspected');
          // response-after：在 drain/业务 listener 安装后才触发 deadline/abort（微任务，条件事件路径）。
          if (mode === 'responseafter-deadline' || mode === 'responseafter-observer')
            queueMicrotask(() => fireFeedTimers());
          if (mode === 'responseafter-abort') queueMicrotask(() => controller.abort());
        });
      });
      return req;
    },
  });

  const promise =
    mode === 'presocket-abort' || mode === 'socketafter-abort' || mode === 'responseafter-abort'
      ? stack.target.get({ url: 'http://example.com/feed', purpose: 'feed', signal: controller.signal })
      : stack.target.get({ url: 'http://example.com/feed', purpose: 'feed' });

  const result = await promise;
  out.events.push('result:' + result.kind);
  advance = false; // true pre-socket deadline 已触发并结束；后续 sentinel 恢复正常时钟语义

  function snapshot(label) {
    const snap = {};
    if (feedReq) {
      snap.reqError = feedReq.listenerCount('error');
      snap.reqClose = feedReq.listenerCount('close');
    }
    if (targetRes) {
      const nonObs = targetRes.listeners('error').filter((f) => f !== responseErrorObserver);
      snap.resError = nonObs.length;
      snap.resClose = targetRes.listenerCount('close');
    }
    out[label] = snap;
  }
  // 注：await 后立即观察可能已处于 request close 之后（Node 异步发 error/close），不得描述为
  // 首终态同步状态；首终态业务 listener 立即归零 + drain 保留由单元测试（FakeRequest 同步终态）证明。
  snapshot('immediate');
  out.events.push('immediate-inspected');
  // 等待 transport 异步 error/close 全部到达，使 request/response drain 在各自 close 后自清理。
  await new Promise((r) => setTimeout(r, 250));
  snapshot('afterClose');

  try {
    const r2 = await stack.target.get({ url: 'http://example.com/feed2', purpose: 'feed' });
    out.events.push('followup-result:' + r2.kind);
  } catch (e) {
    out.events.push('followup-throw:' + (e && e.message));
  }

  out.socketSeen = feedSocketSeen;
  out.installedObserver = installedObserver;
  // 自然退出：等待 server 关闭（agent:false 已使全部测试连接关闭），不调用 process.exit(0)。
  await new Promise((r) => server.close(r));
  console.log('PROBE_RESULT:' + JSON.stringify(out));
}

main().catch((e) => {
  out.events.push('main-error:' + (e && e.message));
  out.harnessError = true;
  console.error('PROBE_ERROR:' + (e && e.stack));
  console.log('PROBE_RESULT:' + JSON.stringify(out));
  // harness 异常必须非零，不得用 process.exit(0) 伪装成功。
  process.exitCode = 1;
});
`;

// ---------------------------------------------------------------------------
// Vite build（package.json 直接声明的 devDependency）：把当前产品源码 bundle 为子进程可 require 的 CJS。
// minify:false 保留产品具名 drain/业务 listener 的函数名（responseErrorDrain/onSourceError/...）。
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), `aibrowse-r7-${randomBytes(6).toString('hex')}`);
let bundlePath = '';
let childPath = '';

beforeAll(async () => {
  mkdirSync(TMP_ROOT, { recursive: true });
  bundlePath = join(TMP_ROOT, 'public-watch-http-client.cjs');
  await build({
    configFile: false,
    logLevel: 'silent',
    root: process.cwd(),
    build: {
      outDir: TMP_ROOT,
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: join(process.cwd(), 'src/main/watch/public-watch-http-client.ts'),
        formats: ['cjs'],
        fileName: () => 'public-watch-http-client.cjs',
      },
      rollupOptions: {
        external: [/^node:/],
        output: { exports: 'named' },
      },
    },
  });
  childPath = join(TMP_ROOT, 'child.js');
  writeFileSync(childPath, CHILD_SCRIPT, 'utf8');
}, 60_000);

afterAll(() => {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // 清理尽力而为
  }
});

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
  data: Record<string, unknown> | null;
}

function runChild(mode: string, timeoutMs = 10_000): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve) => {
    const child = spawn(process.execPath, [childPath], {
      env: { ...process.env, PROBE_MODE: mode, BUNDLE_PATH: bundlePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    // 子进程不调用 process.exit(0)：若存在活动句柄泄漏则不会自然退出，超时 kill → code=-1 暴露。
    const killTimer = setTimeout(() => {
      killed = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      let data: Record<string, unknown> | null = null;
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith('PROBE_RESULT:'));
      if (line) {
        try {
          data = JSON.parse(line.slice('PROBE_RESULT:'.length)) as Record<string, unknown>;
        } catch {
          data = null;
        }
      }
      resolve({ code: killed ? -1 : (code ?? -1), stdout, stderr, data });
    });
  });
}

// 通用绿态终态：子进程自然退出 0、monitor/rejection 为零、request close 后 request drain 归零、
// 后续正常请求成功（进程仍可复用，无残留崩溃）、PROBE_RESULT JSON 存在且可解析。
function expectGreenTerminal(data: Record<string, unknown> | null): void {
  expect(data).not.toBeNull();
  const d = data as Record<string, unknown> & {
    monitor: number;
    rejection: number;
    events: string[];
    afterClose: Record<string, number>;
  };
  expect(d.monitor).toBe(0);
  expect(d.rejection).toBe(0);
  // request drain 只在 request close 后归零（本观察在 await + 250ms 之后，必然已 close）
  expect(d.afterClose.reqError).toBe(0);
  expect(d.afterClose.reqClose).toBe(0);
  expect(d.events).toContain('followup-result:ok');
}

describe('D3-R7 真实 Node 24 localhost/子进程生命周期 oracle（#S6-043）', () => {
  it('true pre-socket deadline destroy：socketSeen=false、业务 failed、request drain 后 exit 0、monitor/rejection=0、可续后续请求', async () => {
    const res = await runChild('presocket-deadline');
    // 红态：旧 R5 因未处理 request ECONNRESET 非零退出（exit 1 + "Unhandled 'error' event"）。
    // 绿态：product-owned request drain 吸收异步 ECONNRESET → 子进程自然 exit 0。
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as { events: string[]; socketSeen: boolean; monitor: number };
    expect(d.events).toContain('result:failed');
    // true pre-socket：socket 从未分配
    expect(d.socketSeen).toBe(false);
    expect(d.monitor).toBe(0);
  });

  it('true pre-socket abort destroy：socketSeen=false、业务 aborted、request drain 后 exit 0、monitor/rejection=0、可续后续请求', async () => {
    const res = await runChild('presocket-abort');
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as { events: string[]; socketSeen: boolean; monitor: number };
    expect(d.events).toContain('result:aborted');
    expect(d.socketSeen).toBe(false);
    expect(d.monitor).toBe(0);
  });

  it('socket-after/pre-response deadline destroy：socketSeen=true、业务 failed、request drain 后 exit 0、monitor/rejection=0、可续后续请求', async () => {
    const res = await runChild('socketafter-deadline');
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as { events: string[]; socketSeen: boolean; monitor: number };
    expect(d.events).toContain('result:failed');
    // socket 已分配但 response 前 destroy
    expect(d.socketSeen).toBe(true);
    expect(d.monitor).toBe(0);
  });

  it('socket-after/pre-response abort destroy：socketSeen=true、业务 aborted、request drain 后 exit 0、monitor/rejection=0、可续后续请求', async () => {
    const res = await runChild('socketafter-abort');
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as { events: string[]; socketSeen: boolean; monitor: number };
    expect(d.events).toContain('result:aborted');
    expect(d.socketSeen).toBe(true);
    expect(d.monitor).toBe(0);
  });

  it('response-after deadline：业务立即结算、response drain 在 destroy 前已安装、close 后归零、exit 0', async () => {
    const res = await runChild('responseafter-deadline');
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as {
      events: string[];
      socketSeen: boolean;
      delivery: Record<string, unknown>;
      afterClose: Record<string, number>;
    };
    expect(d.events).toContain('result:failed');
    expect(d.socketSeen).toBe(true);
    const del = d.delivery as {
      resErrorNames: string[];
      resCloseNames: string[];
      resErrorCount: number;
    };
    // 交付时（body reader/destroy 前）：product-owned named response drain 已安装，与业务 listener 分层
    expect(del.resErrorNames).toContain('responseErrorDrain');
    expect(del.resErrorNames).toContain('onSourceError'); // 业务 body-reader error handler
    expect(del.resCloseNames).toContain('responseCloseCleanup');
    expect(del.resErrorCount).toBe(2); // drain + onSourceError
    // response close 后 drain 归零
    expect(d.afterClose.resError).toBe(0);
    expect(d.afterClose.resClose).toBe(0);
  });

  it('response-after abort：业务立即结算、response drain 安装/清理正确、exit 0', async () => {
    const res = await runChild('responseafter-abort');
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as {
      events: string[];
      socketSeen: boolean;
      delivery: Record<string, unknown>;
      afterClose: Record<string, number>;
    };
    expect(d.events).toContain('result:aborted');
    expect(d.socketSeen).toBe(true);
    const del = d.delivery as {
      resErrorNames: string[];
      resCloseNames: string[];
      resErrorCount: number;
    };
    expect(del.resErrorNames).toContain('responseErrorDrain');
    expect(del.resErrorNames).toContain('onSourceError');
    expect(del.resCloseNames).toContain('responseCloseCleanup');
    expect(del.resErrorCount).toBe(2);
    expect(d.afterClose.resError).toBe(0);
    expect(d.afterClose.resClose).toBe(0);
  });

  it('response-after 带具名对照 observer：按 callback identity 排除 observer、drain 结构完整、exit 0', async () => {
    const res = await runChild('responseafter-observer');
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as {
      events: string[];
      socketSeen: boolean;
      delivery: Record<string, unknown>;
      monitor: number;
      installedObserver: boolean;
    };
    // 具名 observer 单独安装（对照事实，不吞产品缺陷）；listenerCount/名称断言按 identity 排除。
    expect(d.installedObserver).toBe(true);
    expect(d.socketSeen).toBe(true);
    const del = d.delivery as {
      resErrorNames: string[];
      resCloseNames: string[];
      resErrorCount: number;
      observerInstalled: boolean;
      observerIsNamed: boolean;
      observerIdentityMatches: boolean;
    };
    expect(del.observerInstalled).toBe(true);
    expect(del.observerIsNamed).toBe(true);
    expect(del.observerIdentityMatches).toBe(true); // 保存的 callback 身份与已安装 listener 同一函数
    expect(del.resErrorNames).toContain('responseErrorDrain');
    expect(del.resErrorNames).toContain('onSourceError');
    expect(del.resCloseNames).toContain('responseCloseCleanup');
    // observer 不计入 product-owned/业务 listener 数量（按精确 callback 过滤，而非减常量 1）
    expect(del.resErrorCount).toBe(2);
    expect(d.monitor).toBe(0);
  });
});
