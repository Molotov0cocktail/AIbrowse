import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, screen, session } from 'electron';

const root = resolve(process.env.AIBROWSE_DOWNLOAD_PROBE_ROOT ?? '');
assert(root.startsWith(resolve('log/builtin-tools-20261013') + '\\'));
mkdirSync(root, { recursive: true });
app.setPath('userData', join(root, 'profile'));
app.setPath('sessionData', join(root, 'session'));
const report: { passed: boolean; requests: number; events: unknown[]; error?: string } = {
  passed: false,
  requests: 0,
  events: [],
};
let scenario = '';
let win: BrowserWindow | undefined;
const server = createServer((request, response) => {
  report.requests += 1;
  if (report.requests > 30) {
    response.writeHead(429).end();
    return;
  }
  if (request.url?.startsWith('/file')) {
    response
      .writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="probe.txt"',
      })
      .end('controlled');
  } else if (request.url === '/redirect') {
    response.writeHead(302, { Location: '/file?redirect=1' }).end();
  } else {
    response
      .writeHead(200, { 'Content-Type': 'text/html' })
      .end(
        `<a id="download" style="display:block;width:200px;height:80px" href="${scenario === 'redirect' ? '/redirect' : '/file'}" ${scenario === 'blank' ? 'target="_blank"' : ''} ${scenario === 'download-attribute' ? 'download' : ''}>下载</a>`,
      );
  }
});
const timer = setTimeout(() => {
  report.error = '探针超过45秒';
  finish(1);
}, 45000);
function finish(code: number): void {
  clearTimeout(timer);
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  server.close();
  win?.destroy();
  app.exit(code);
}
async function click(window: BrowserWindow): Promise<void> {
  window.show();
  window.focus();
  window.webContents.focus();
  await delay(200);
  const bounds = window.getContentBounds();
  const point = screen.dipToScreenPoint({ x: bounds.x + 40, y: bounds.y + 40 });
  if (process.env.AIBROWSE_DOWNLOAD_INPUT === 'electron') {
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      button: 'left',
      x: 40,
      y: 40,
      clickCount: 1,
    });
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      button: 'left',
      x: 40,
      y: 40,
      clickCount: 1,
    });
    return;
  }
  const child = spawn(
    'pwsh.exe',
    [
      '-NoProfile',
      '-File',
      resolve('tools/browser-library-runtime/native-input.ps1'),
      '-TargetWindow',
      String(window.getNativeWindowHandle().readBigUInt64LE()),
      '-TargetProcess',
      String(process.pid),
      '-X',
      String(point.x),
      '-Y',
      String(point.y),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let diagnostic = '';
  child.stdout.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString().slice(0, 4096);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostic += chunk.toString().slice(0, 4096);
  });
  const code = await new Promise((res, rej) => {
    child.once('exit', res);
    child.once('error', rej);
  });
  report.events.push({ scenario, type: 'os-input', code, diagnostic });
  assert.equal(code, 0);
}
void app
  .whenReady()
  .then(async () => {
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const ses = session.fromPartition('download-probe');
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: !details.url.startsWith(origin + '/') }),
    );
    ses.webRequest.onSendHeaders((details) =>
      report.events.push({
        scenario,
        type: 'headers',
        url: details.url,
        webContentsId: details.webContentsId,
        resourceType: details.resourceType,
        frameMain: details.frame?.parent === null,
        frameOrigin: details.frame?.origin,
      }),
    );
    ses.on('will-download', (event, item, wc, frame) => {
      event.preventDefault();
      report.events.push({
        scenario,
        type: 'download',
        url: item.getURL(),
        chain: item.getURLChain(),
        gesture: item.hasUserGesture(),
        initiator: item.getInitiatorOrigin(),
        wc: wc?.id,
        frameMain: frame?.parent === null,
        frameOrigin: frame?.origin,
        sameMain: frame === wc?.mainFrame,
      });
    });
    win = new BrowserWindow({
      width: 650,
      height: 400,
      show: false,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.webContents.on('before-mouse-event', (_event, input) =>
      report.events.push({ scenario, type: 'input', inputType: input.type }),
    );
    win.webContents.on('did-start-navigation', (event) =>
      report.events.push({ scenario, type: 'start', url: event.url, main: event.isMainFrame }),
    );
    win.webContents.on('did-navigate', (_event, url) =>
      report.events.push({ scenario, type: 'commit', url }),
    );
    win.webContents.setWindowOpenHandler((details) => {
      report.events.push({ scenario, type: 'popup', url: details.url });
      const child = new BrowserWindow({
        show: false,
        webPreferences: {
          session: ses,
          sandbox: true,
          nodeIntegration: false,
          contextIsolation: true,
        },
      });
      void child
        .loadURL(details.url)
        .catch(() => {})
        .finally(() => setTimeout(() => child.destroy(), 500));
      return { action: 'deny' };
    });
    for (const current of ['ordinary', 'redirect', 'blank', 'automatic', 'download-attribute']) {
      scenario = current;
      await win.loadURL(origin + '/page?' + current);
      if (current === 'automatic')
        await win.webContents.executeJavaScript('document.getElementById("download").click()');
      else await click(win);
      await delay(700);
    }
    assert.equal(
      report.events.filter(
        (entry) =>
          typeof entry === 'object' &&
          entry !== null &&
          'type' in entry &&
          entry.type === 'download',
      ).length,
      5,
    );
    report.passed = true;
    finish(0);
  })
  .catch((error: unknown) => {
    report.error = error instanceof Error ? error.message : String(error);
    finish(1);
  });
