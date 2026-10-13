import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, session } from 'electron';

const root = resolve(process.env.AIBROWSE_DOWNLOAD_PROBE_ROOT ?? '');
assert(root.startsWith(resolve('log/builtin-tools-20261013') + '\\'));
mkdirSync(root, { recursive: true });
app.setPath('userData', join(root, 'profile'));
app.setPath('sessionData', join(root, 'session'));
const report: {
  passed: boolean;
  requests: number;
  meta: unknown;
  events: unknown[];
  checks: unknown[];
  error?: string;
} = {
  passed: false,
  requests: 0,
  meta: {
    budget: 10,
    target: '隔离127.0.0.1主frame及同源302',
    commands: ['Network.setCookie', 'Network.getCookies'],
    networkEnabled: false,
    responseBodyRead: false,
    idmCalls: 0,
    syntheticCookiesOnly: true,
  },
  events: [],
  checks: [],
};
type Cookie = {
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  partitionKey?: unknown;
};
const received = new Map<string, { cookie: string; referer: string; userAgent: string }>();
const nativeReferrers = new Map<string, string>();
const queryResults: Array<Promise<void>> = [];
let window: BrowserWindow | undefined;
let finished = false;
let scenario = '';
let origin = '';
let site = '';
let downloads = 0;
const server = createServer((request, response) => {
  report.requests += 1;
  if (report.requests > 10) {
    response.writeHead(429).end();
    return;
  }
  const url = origin + request.url;
  if (request.url?.startsWith('/allowed/file')) {
    const headers = {
      cookie: request.headers.cookie ?? '',
      referer: request.headers.referer ?? '',
      userAgent: request.headers['user-agent'] ?? '',
    };
    received.set(url, headers);
    report.events.push({ scenario, type: 'server-download', url, headers });
    response
      .writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="probe.bin"',
      })
      .end('controlled');
  } else if (request.url === '/allowed/redirect') {
    response
      .writeHead(302, { Location: '/allowed/file?redirect', 'Cache-Control': 'no-store' })
      .end();
  } else {
    response
      .writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'unsafe-url',
      })
      .end(
        '<a id="download" style="display:block;width:200px;height:80px" href="/allowed/file?direct" download referrerpolicy="origin">下载</a>',
      );
  }
});
const timer = setTimeout(() => {
  report.error = 'Cookie分区探针超过25秒';
  finish(1);
}, 25000);
function finish(code: number): void {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (window && !window.isDestroyed()) {
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.destroy();
  }
  server.close();
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  app.exit(code);
}
function parseCookies(result: unknown): Cookie[] {
  assert(
    result && typeof result === 'object' && 'cookies' in result && Array.isArray(result.cookies),
  );
  return result.cookies.map((cookie: unknown) => {
    assert(
      cookie &&
        typeof cookie === 'object' &&
        'name' in cookie &&
        typeof cookie.name === 'string' &&
        'value' in cookie &&
        typeof cookie.value === 'string',
    );
    return cookie as Cookie;
  });
}
function headerPairs(header: string): string[] {
  return header
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort();
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 4000;
  while (!check()) {
    assert(Date.now() < end, '有界下载等待未完成');
    await delay(20);
  }
}
async function click(): Promise<void> {
  assert(window);
  const wc = window.webContents;
  window.show();
  window.focus();
  wc.focus();
  await delay(150);
  wc.sendInputEvent({ type: 'mouseMove', x: 40, y: 40 });
  await delay(50);
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', x: 40, y: 40, clickCount: 1 });
  await delay(50);
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', x: 40, y: 40, clickCount: 1 });
}
void app
  .whenReady()
  .then(async () => {
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const address = server.address();
    assert(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    site = 'http://127.0.0.1';
    const ses = session.fromPartition('download-cookie-scope-probe');
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith(origin + '/') }),
    );
    ses.webRequest.onSendHeaders((details) => {
      if (details.url.includes('/allowed/')) {
        nativeReferrers.set(details.url, details.referrer);
        report.events.push({
          scenario,
          type: 'native-request',
          url: details.url,
          referrer: details.referrer,
          resourceType: details.resourceType,
          headers: details.requestHeaders,
        });
      }
    });
    window = new BrowserWindow({
      width: 650,
      height: 400,
      show: true,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    window.setAlwaysOnTop(true);
    await window.loadURL(origin + '/page?document=synthetic');
    const wc = window.webContents;
    wc.debugger.attach('1.3');
    for (const fixture of [
      { name: 'plain', value: 'fixture-plain', path: '/allowed' },
      { name: 'http_only', value: 'fixture-http-only', path: '/allowed', httpOnly: true },
      { name: 'strict_cookie', value: 'fixture-strict', path: '/allowed', sameSite: 'Strict' },
      { name: 'other_path', value: 'fixture-other-path', path: '/unrelated' },
      {
        name: 'partition_own',
        value: 'fixture-own',
        path: '/allowed',
        secure: true,
        sameSite: 'None',
        partitionKey: { topLevelSite: site, hasCrossSiteAncestor: false },
      },
      {
        name: 'partition_other',
        value: 'fixture-other',
        path: '/allowed',
        secure: true,
        sameSite: 'None',
        partitionKey: { topLevelSite: 'http://other.test', hasCrossSiteAncestor: false },
      },
    ]) {
      const result: unknown = await wc.debugger.sendCommand('Network.setCookie', {
        url: origin + '/allowed/file',
        ...fixture,
      });
      report.events.push({ type: 'set-cookie', name: fixture.name, result });
      assert(
        result && typeof result === 'object' && 'success' in result && result.success === true,
        fixture.name,
      );
    }
    const first = parseCookies(
      await wc.debugger.sendCommand('Network.getCookies', { urls: [origin + '/allowed/file'] }),
    );
    report.events.push({ type: 'initial-get-cookies', cookies: first });
    assert.deepEqual(first.map((cookie) => cookie.name).sort(), [
      'http_only',
      'partition_own',
      'plain',
      'strict_cookie',
    ]);
    assert(first.find((cookie) => cookie.name === 'http_only')?.httpOnly);
    assert.equal(first.find((cookie) => cookie.name === 'strict_cookie')?.sameSite, 'Strict');
    assert.deepEqual(first.find((cookie) => cookie.name === 'partition_own')?.partitionKey, {
      topLevelSite: site,
      hasCrossSiteAncestor: false,
    });
    report.checks.push({
      type: 'url-and-partition-filter',
      passed: true,
      secureCookieOnTrustworthyHttpLoopback:
        first.find((cookie) => cookie.name === 'partition_own')?.secure === true,
    });
    ses.on('will-download', (event, item, owner, frame) => {
      const url = item.getURL();
      const chain = item.getURLChain();
      event.preventDefault();
      report.events.push({
        scenario,
        type: 'native-download',
        url,
        chain,
        mainFrame: frame === owner.mainFrame,
        hasUserGesture: item.hasUserGesture(),
      });
      const name = scenario;
      const query = wc.debugger
        .sendCommand('Network.getCookies', { urls: [url] })
        .then((result: unknown) => {
          const cookies = parseCookies(result);
          const actual = received.get(url);
          assert(actual);
          report.events.push({ scenario: name, type: 'download-cookie-query', cookies });
          assert.deepEqual(
            cookies.map((cookie) => `${cookie.name}=${cookie.value}`).sort(),
            headerPairs(actual.cookie),
          );
          assert.equal(nativeReferrers.get(url), actual.referer);
          assert.equal(wc.getUserAgent(), actual.userAgent);
          assert.equal(actual.referer, name === 'origin-policy' ? origin + '/' : '');
          report.checks.push({
            scenario: name,
            cookieMatchesActual: true,
            referrerMatchesActual: true,
            userAgentMatchesActual: true,
            chain,
          });
        });
      queryResults.push(query);
      downloads += 1;
    });
    scenario = 'origin-policy';
    await click();
    await until(() => downloads === 1);
    await queryResults[0];
    await wc.executeJavaScript(
      `(() => { const link = document.getElementById('download'); link.href='/allowed/redirect'; link.referrerPolicy='no-referrer'; })()`,
    );
    scenario = 'no-referrer-redirect';
    await click();
    await until(() => downloads === 2);
    await queryResults[1];
    assert.equal(report.requests, 4);
    report.passed = true;
    finish(0);
  })
  .catch((error: unknown) => {
    report.error = error instanceof Error ? error.stack : String(error);
    finish(1);
  });
