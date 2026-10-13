import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, session } from 'electron';

const root = resolve(process.env.AIBROWSE_DOWNLOAD_PROBE_ROOT ?? '');
assert(root.startsWith(resolve('log/builtin-tools-20261013') + '\\'));
mkdirSync(root, { recursive: true });
app.setPath('userData', join(root, 'profile'));
app.setPath('sessionData', join(root, 'session'));
const started = performance.now();
const report: { passed: boolean; requests: number; events: unknown[]; error?: string } = {
  passed: false,
  requests: 0,
  events: [],
};
let scenario = '';
let gesture = 0;
let delayedRequests = 0;
let downloads = 0;
let window: BrowserWindow | undefined;
let finished = false;
const responseTimers = new Set<ReturnType<typeof setTimeout>>();
function record(event: Record<string, unknown>): void {
  report.events.push({
    sequence: report.events.length + 1,
    ms: Math.round((performance.now() - started) * 100) / 100,
    scenario,
    gesture,
    ...event,
  });
}
function file(response: ServerResponse, name: string): void {
  response
    .writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${name}.bin"`,
    })
    .end('controlled');
}
const server = createServer((request, response) => {
  report.requests += 1;
  record({ type: 'server-request', url: request.url });
  if (report.requests > 10) {
    response.writeHead(429).end();
    return;
  }
  if (request.url === '/redirect')
    response.writeHead(302, { Location: '/file?redirect', 'Cache-Control': 'no-store' }).end();
  else if (request.url === '/file?delayed') {
    const ordinal = ++delayedRequests;
    const timer = setTimeout(
      () => {
        record({ type: 'server-response', ordinal });
        file(response, `delayed-${ordinal}`);
        responseTimers.delete(timer);
      },
      ordinal === 1 ? 700 : 60,
    );
    responseTimers.add(timer);
    request.on('close', () => record({ type: 'server-request-close', ordinal }));
  } else if (request.url?.startsWith('/file')) file(response, scenario);
  else
    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .end(
        `<a style="display:block;width:200px;height:80px" href="${scenario === 'redirect' ? '/redirect' : '/file?' + scenario}" ${scenario === 'attribute' || scenario === 'delayed' ? 'download' : ''}>下载</a>`,
      );
});
const deadline = setTimeout(() => {
  report.error = '请求结束顺序探针超过20秒';
  finish(1);
}, 20000);
function finish(code: number): void {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  for (const timer of responseTimers) clearTimeout(timer);
  if (window && !window.isDestroyed()) window.destroy();
  server.close();
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  app.exit(code);
}
async function until(check: () => boolean): Promise<void> {
  const end = Date.now() + 3500;
  while (!check()) {
    assert(Date.now() < end, '有界事件等待未完成');
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
    const origin = `http://127.0.0.1:${address.port}`;
    const ses = session.fromPartition('download-order-probe');
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.webRequest.onBeforeRequest((details, callback) => {
      record({ type: 'before-request', id: details.id, url: details.url });
      callback({ cancel: !details.url.startsWith(origin + '/') });
    });
    ses.webRequest.onSendHeaders((details) =>
      record({
        type: 'send-headers',
        id: details.id,
        url: details.url,
        resourceType: details.resourceType,
      }),
    );
    ses.webRequest.onCompleted((details) =>
      record({ type: 'completed', id: details.id, url: details.url, status: details.statusCode }),
    );
    ses.webRequest.onErrorOccurred((details) =>
      record({ type: 'error-occurred', id: details.id, url: details.url, error: details.error }),
    );
    ses.on('will-download', (event, item) => {
      const metadata = {
        url: item.getURL(),
        filename: item.getFilename(),
        hasUserGesture: item.hasUserGesture(),
      };
      record({ type: 'will-download-before-prevent', ...metadata });
      event.preventDefault();
      record({ type: 'will-download-after-prevent', ...metadata });
      downloads += 1;
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
    window.setAlwaysOnTop(true);
    window.webContents.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseUp') {
        gesture += 1;
        record({ type: 'native-input' });
      }
    });
    scenario = 'fixture';
    await window.loadURL(origin + '/page?fixture');
    for (const name of ['ordinary', 'attribute', 'redirect', 'delayed']) {
      scenario = name;
      await window.webContents.executeJavaScript(`(() => {
        const link = document.querySelector('a');
        link.href = ${JSON.stringify(name === 'redirect' ? '/redirect' : '/file?' + name)};
        ${name === 'attribute' || name === 'delayed' ? "link.setAttribute('download', '')" : "link.removeAttribute('download')"};
      })()`);
      const before = downloads;
      await click();
      if (name === 'delayed') {
        await until(() => delayedRequests === 1);
        await click();
        await until(() => delayedRequests === 2);
        await until(() => downloads === before + 2);
      } else await until(() => downloads === before + 1);
      await delay(100);
    }
    assert.equal(report.requests, 7);
    report.passed = true;
    finish(0);
  })
  .catch((error: unknown) => {
    report.error = error instanceof Error ? error.stack : String(error);
    finish(1);
  });
