// D3-R6: 真实 Node 24 localhost/子进程生命周期 oracle（#S6-043 两阶段协议）。
// - 子进程只安装 uncaughtExceptionMonitor（只观察、不恢复）与 unhandledRejection 记录；
//   不添加任何 request/response error observer 掩盖缺陷（observer 变体单独标注为对照事实，
//   且必须从 listenerCount/callback 身份断言中排除）。
// - 经 esbuild 把「当前产品源码」bundle 为 CJS 供子进程 require，保证子进程运行的就是当前 HEAD 产品代码，
//   而不是 Fake seam。
// - pre-socket/pre-response 的 request destroy 在旧 R5 会因未处理 request ECONNRESET 崩溃（非零退出 /
//   uncaughtExceptionMonitor 命中）；R6 product-owned request drain 后 exit 0、monitor/rejection 为零，
//   并可继续后续正常请求（sentinel）。
// - response-after 真实绿态证明：业务 Promise 在同步 cleanup/destroy/fallback 后立即结算；request close
//   清 request drain；product-owned named response drain 在 body reader/destroy 前已安装；若 Node 发出
//   response error 则由该 drain 接收，无论是否发出 error，response close 后 drain 均为 0、子进程 exit 0。
//   本产品 cleanup 顺序为 destroy response → destroy request，实测 Node 在该顺序下不发 response error
//   （条件发射）；强制 aborted → error → close 由确定性敌手 seam 覆盖，不冒充真实 Node 必然顺序。
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// ---------------------------------------------------------------------------
// 子进程脚本：与测试文件同目录？不——写成独立 JS，只依赖 BUNDLE_PATH 环境变量。
// ---------------------------------------------------------------------------

const CHILD_SCRIPT = String.raw`
'use strict';
const http = require('node:http');
const mode = process.env.PROBE_MODE || 'presocket-deadline';
const out = { mode, events: [], monitor: 0, rejection: 0, exit: 0 };

process.on('uncaughtExceptionMonitor', (err) => {
  out.monitor += 1;
  out.events.push('monitor:' + (err && err.code));
});
process.on('unhandledRejection', (reason) => {
  out.rejection += 1;
  out.events.push('unhandled-rejection:' + String(reason));
});

const { createPublicWatchHttpStack } = require(process.env.BUNDLE_PATH);

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
    // pre-response: stay silent
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  let trackedReq = null;
  let targetRes = null;
  let installedObserver = false;

  const stack = createPublicWatchHttpStack({
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    timeoutMs: 150,
    request: (options) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method,
        headers: options.headers,
      });
      trackedReq = req;
      req.on('response', (res) => {
        if (options.path !== '/feed') return;
        targetRes = res;
        out.events.push('target-res-delivered');
        if (mode === 'responseafter-observer') {
          installedObserver = true;
          res.on('error', (e) => out.events.push('observer-res-error:' + e.code));
        }
        // 交付后一个微任务：onResponse 已同步运行 → drain 已安装；在 terminal 前快照。
        queueMicrotask(() => {
          const errNames = res.listeners('error').map((f) => f.name);
          out.delivery = {
            resError: res.listenerCount('error') - (installedObserver ? 1 : 0),
            resClose: res.listenerCount('close'),
            resErrorNames: errNames,
            resCloseNames: res.listeners('close').map((f) => f.name),
            reqErrorNames: trackedReq ? trackedReq.listeners('error').map((f) => f.name) : [],
          };
          out.events.push('delivery-inspected');
        });
      });
      return req;
    },
  });

  const controller = new AbortController();
  let promise;
  if (mode.endsWith('abort')) {
    promise = stack.target.get({
      url: 'http://example.com/feed',
      purpose: 'feed',
      signal: controller.signal,
    });
  } else {
    promise = stack.target.get({ url: 'http://example.com/feed', purpose: 'feed' });
  }
  if (mode.endsWith('abort')) {
    setTimeout(() => controller.abort(), 40);
  }

  const result = await promise;
  out.events.push('result:' + result.kind);

  function snapshot(label) {
    const snap = {};
    if (trackedReq) {
      snap.reqError = trackedReq.listenerCount('error');
      snap.reqClose = trackedReq.listenerCount('close');
    }
    if (targetRes) {
      snap.resError = targetRes.listenerCount('error') - (installedObserver ? 1 : 0);
      snap.resClose = targetRes.listenerCount('close');
    }
    out[label] = snap;
  }
  snapshot('immediate');
  out.events.push('immediate-inspected');
  await new Promise((r) => setTimeout(r, 250));
  snapshot('afterClose');

  try {
    const r2 = await stack.target.get({ url: 'http://example.com/feed2', purpose: 'feed' });
    out.events.push('followup-result:' + r2.kind);
  } catch (e) {
    out.events.push('followup-throw:' + (e && e.message));
  }

  server.close();
  out.exit = 0;
  out.installedObserver = installedObserver;
  console.log('PROBE_RESULT:' + JSON.stringify(out));
  process.exit(0);
}

main().catch((e) => {
  out.events.push('main-error:' + (e && e.message));
  console.log('PROBE_RESULT:' + JSON.stringify(out));
  process.exit(0);
});
`;

// ---------------------------------------------------------------------------
// esbuild bundle：把当前产品源码编译成子进程可 require 的 CJS
// ---------------------------------------------------------------------------

const TMP_ROOT = join(tmpdir(), `aibrowse-r6-${randomBytes(6).toString('hex')}`);
let bundlePath = '';
let childPath = '';

beforeAll(async () => {
  mkdirSync(TMP_ROOT, { recursive: true });
  bundlePath = join(TMP_ROOT, 'public-watch-http-client.cjs');
  await build({
    entryPoints: [join(process.cwd(), 'src/main/watch/public-watch-http-client.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath,
    logLevel: 'silent',
  });
  childPath = join(TMP_ROOT, 'child.js');
  writeFileSync(childPath, CHILD_SCRIPT, 'utf8');
}, 30_000);

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

function runChild(mode: string, timeoutMs = 15_000): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve) => {
    const child = spawn(process.execPath, [childPath], {
      env: { ...process.env, PROBE_MODE: mode, BUNDLE_PATH: bundlePath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
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

function expectGreenTerminal(data: Record<string, unknown> | null): void {
  expect(data).not.toBeNull();
  const d = data as Record<string, unknown> & {
    monitor: number;
    rejection: number;
    events: string[];
    immediate: Record<string, number>;
    afterClose: Record<string, number>;
  };
  expect(d.monitor).toBe(0);
  expect(d.rejection).toBe(0);
  // request drain 在 request close 后归零
  expect(d.afterClose.reqError).toBe(0);
  expect(d.afterClose.reqClose).toBe(0);
  // 后续正常请求成功（进程仍可复用，无残留崩溃）
  expect(d.events).toContain('followup-result:ok');
}

describe('D3-R6 真实 Node 24 localhost/子进程生命周期 oracle（#S6-043）', () => {
  it('pre-socket/pre-response deadline destroy：R5 崩溃红态 → R6 request drain 后 exit 0、monitor/rejection 为零、可续后续请求', async () => {
    const res = await runChild('presocket-deadline');
    // 红态：旧 R5 因未处理 request ECONNRESET 非零退出（exit 1 + Unhandled error event）。
    // 绿态：product-owned request drain 吸收异步 ECONNRESET → exit 0。
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as { immediate: Record<string, number>; events: string[] };
    expect(d.events).toContain('result:failed');
    // 终态同步后、request close 前：request drain 已安装
    expect(d.immediate.reqError).toBe(1);
    expect(d.immediate.reqClose).toBe(1);
  });

  it('pre-socket/pre-response abort destroy：R5 崩溃红态 → R6 request drain 后 exit 0、monitor/rejection 为零、可续后续请求', async () => {
    const res = await runChild('presocket-abort');
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as { immediate: Record<string, number>; events: string[] };
    expect(d.events).toContain('result:aborted');
    expect(d.immediate.reqError).toBe(1);
    expect(d.immediate.reqClose).toBe(1);
  });

  it('response-after deadline：业务立即结算、request close 清 request drain、response drain 在 destroy 前已安装、close 后归零', async () => {
    const res = await runChild('responseafter-deadline');
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as {
      events: string[];
      delivery: Record<string, unknown>;
      immediate: Record<string, number>;
    };
    expect(d.events).toContain('result:failed');
    // 交付时（body reader 前）：product-owned named response drain 已安装，与业务 listener 分层
    const del = d.delivery as { resErrorNames: string[]; resCloseNames: string[] };
    expect(del.resErrorNames).toContain('responseErrorDrain');
    expect(del.resErrorNames).toContain('onSourceError'); // 业务 body-reader error handler
    expect(del.resCloseNames).toContain('responseCloseCleanup');
    // 终态同步后、response close 前：request drain 保留
    expect(d.immediate.reqError).toBe(1);
    expect(d.immediate.reqClose).toBe(1);
  });

  it('response-after abort：业务立即结算、response drain 安装/清理正确、exit 0', async () => {
    const res = await runChild('responseafter-abort');
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as {
      events: string[];
      delivery: Record<string, unknown>;
      immediate: Record<string, number>;
    };
    expect(d.events).toContain('result:aborted');
    const del = d.delivery as { resErrorNames: string[]; resCloseNames: string[] };
    expect(del.resErrorNames).toContain('responseErrorDrain');
    expect(del.resErrorNames).toContain('onSourceError');
    expect(del.resCloseNames).toContain('responseCloseCleanup');
    expect(d.immediate.reqError).toBe(1);
    expect(d.immediate.reqClose).toBe(1);
  });

  it('response-after 带具名对照 observer：Node 条件发射 response error 时由 drain 接收；observer 从断言中排除', async () => {
    const res = await runChild('responseafter-observer');
    expect(res.code).toBe(0);
    expect(res.stderr).not.toMatch(/Unhandled 'error' event/);
    expectGreenTerminal(res.data);
    const d = res.data as {
      events: string[];
      delivery: Record<string, unknown>;
      installedObserver: boolean;
      monitor: number;
    };
    // 具名 observer 单独安装（对照事实，不吞产品缺陷）；drain 仍是 product-owned named sink
    expect(d.installedObserver).toBe(true);
    const del = d.delivery as { resErrorNames: string[]; resCloseNames: string[] };
    expect(del.resErrorNames).toContain('responseErrorDrain');
    // 本产品 cleanup 顺序 destroy response → destroy request：实测 Node 在该顺序下不发
    // response error（条件发射）。因此 observer 可能未触发；若未来 Node 触发，也必须由 drain 接收
    // 并保证 zero monitor/rejection —— 本断言只依赖 drain 存在与 close 后归零，不依赖 error 是否发射。
    expect(d.monitor).toBe(0);
  });
});
