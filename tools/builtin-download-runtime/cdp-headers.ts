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
  events: unknown[];
  cases: unknown[];
  error?: string;
} = { passed: false, requests: 0, events: [], cases: [] };
type Headers = Record<string, string>;
const actual = new Map<string, Headers>();
const requests = new Map<string, { url: string; headers: Headers }>();
const extraHeaders = new Map<string, Headers>();
const downloads: string[] = [];
let scenario = '';
let window: BrowserWindow | undefined;
let finished = false;
const server = createServer((request, response) => {
  report.requests += 1;
  if (report.requests > 8) {
    response.writeHead(429).end();
    return;
  }
  if (request.url?.startsWith('/file')) {
    const headers = {
      Cookie: request.headers.cookie ?? '',
      'User-Agent': request.headers['user-agent'] ?? '',
      Referer: request.headers.referer ?? '',
    };
    actual.set(scenario, headers);
    report.events.push({ scenario, type: 'server-headers', headers });
    response
      .writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="probe.txt"',
      })
      .end('controlled');
  } else {
    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(
        `<a style="display:block;width:200px;height:80px" href="/file?case=${scenario}" ${scenario === 'attribute' ? 'download' : ''}>下载</a>`,
      );
  }
});
const timer = setTimeout(() => {
  report.error = 'CDP对照超过25秒';
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
function headersOf(value: unknown): Headers {
  if (typeof value !== 'object' || value === null) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}
function select(headers: Headers): Headers {
  return Object.fromEntries(
    ['Cookie', 'User-Agent', 'Referer'].map((key) => [
      key,
      Object.entries(headers).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? '',
    ]),
  );
}
void app
  .whenReady()
  .then(async () => {
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const ses = session.fromPartition('download-cdp-probe');
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith(origin + '/') }),
    );
    await ses.cookies.set({ url: origin, name: 'probe', value: 'controlled' });
    ses.webRequest.onSendHeaders((details) => {
      if (details.url.includes('/file'))
        report.events.push({
          scenario,
          type: 'electron-headers',
          url: details.url,
          id: details.id,
          headers: select(details.requestHeaders),
        });
    });
    ses.on('will-download', (event, item, wc, frame) => {
      event.preventDefault();
      downloads.push(scenario);
      report.events.push({
        scenario,
        type: 'native-download',
        url: item.getURL(),
        chain: item.getURLChain(),
        userGesture: item.hasUserGesture(),
        mainFrame: wc.mainFrame === frame,
      });
    });
    window = new BrowserWindow({
      width: 650,
      height: 400,
      show: true,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        sandbox: true,
        contextIsolation: true,
      },
    });
    const wc = window.webContents;
    window.setAlwaysOnTop(true);
    await window.loadURL('about:blank');
    report.events.push({ type: 'target-ready' });
    wc.debugger.attach('1.3');
    wc.debugger.on('message', (_event, method, params: Record<string, unknown>) => {
      if (typeof params.requestId !== 'string') return;
      const id = params.requestId;
      if (method === 'Network.requestWillBeSent') {
        const request = params.request;
        if (
          typeof request !== 'object' ||
          request === null ||
          !('url' in request) ||
          typeof request.url !== 'string'
        )
          return;
        requests.set(id, {
          url: request.url,
          headers: 'headers' in request ? headersOf(request.headers) : {},
        });
        report.events.push({
          scenario,
          type: method,
          id,
          url: request.url,
          headers: 'headers' in request ? select(headersOf(request.headers)) : {},
        });
      } else if (method === 'Network.requestWillBeSentExtraInfo') {
        extraHeaders.set(id, headersOf(params.headers));
        report.events.push({
          scenario,
          type: method,
          id,
          headers: select(headersOf(params.headers)),
        });
      } else if (method === 'Network.responseReceivedExtraInfo') {
        report.events.push({ scenario, type: method, id, statusCode: params.statusCode });
      } else if (method === 'Network.responseReceived' || method === 'Network.loadingFailed') {
        report.events.push({ scenario, type: method, id, errorText: params.errorText });
      }
    });
    await wc.debugger.sendCommand('Network.enable');
    for (const name of ['ordinary', 'attribute']) {
      scenario = name;
      await window.loadURL(origin + '/page?' + name);
      window.show();
      window.focus();
      wc.focus();
      await delay(100);
      wc.sendInputEvent({ type: 'mouseMove', x: 40, y: 40 });
      wc.sendInputEvent({ type: 'mouseDown', button: 'left', x: 40, y: 40, clickCount: 1 });
      await delay(80);
      wc.sendInputEvent({ type: 'mouseUp', button: 'left', x: 40, y: 40, clickCount: 1 });
      await delay(600);
      assert(downloads.includes(name), '需要实际原生下载');
      const request = [...requests.entries()].find(
        ([, entry]) => entry.url === origin + '/file?case=' + name,
      );
      const actualHeaders = actual.get(name);
      assert(actualHeaders);
      const extra = request ? extraHeaders.get(request[0]) : undefined;
      const selected = extra ? select(extra) : undefined;
      report.cases.push({
        scenario: name,
        requestId: request?.[0] ?? null,
        requestObserved: Boolean(request),
        extraObserved: Boolean(extra),
        matchesServer:
          selected !== undefined &&
          Object.keys(actualHeaders).every((key) => selected[key] === actualHeaders[key]),
      });
    }
    report.passed = true;
    finish(0);
  })
  .catch((error: unknown) => {
    report.error = error instanceof Error ? error.stack : String(error);
    finish(1);
  });
