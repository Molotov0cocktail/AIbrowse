import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { app, BaseWindow, screen, session, webContents, type WebContents } from 'electron';
import { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import type { SessionManager } from '../../src/main/browser/session-manager';
import { IdmDownloadInterceptor } from '../../src/main/downloads/idm-download-interceptor';
import { IdmDownloadCookieReader } from '../../src/main/downloads/idm-cookie-reader';

const root = resolve(process.env.AIBROWSE_DOWNLOAD_PROBE_ROOT ?? '');
assert(root.startsWith(resolve('log/builtin-tools-20261013') + '\\'));
mkdirSync(root, { recursive: true });
app.setPath('userData', join(root, 'profile'));
app.setPath('sessionData', join(root, 'session'));
const report: {
  passed: boolean;
  requests: number;
  events: unknown[];
  checks: string[];
  meta: { primaryBudget: number; concurrencyBudget: number; idmCalls: number };
  error?: string;
} = {
  passed: false,
  requests: 0,
  events: [],
  checks: [],
  meta: { primaryBudget: 26, concurrencyBudget: 3, idmCalls: 0 },
};
let scenario = '';
let window: BaseWindow | undefined;
let controller: BrowserControllerImpl | undefined;
let interceptor: IdmDownloadInterceptor | undefined;
const cookieReader = new IdmDownloadCookieReader();
let finished = false;
let nativeDownloads = 0;
let concurrentRequests = 0;
const responseTimers = new Set<ReturnType<typeof setTimeout>>();
const handoffs: string[] = [];
const handoffFiles: string[] = [];
const serviceAttempts: string[] = [];
const receivedHeaders = new Map<string, { cookie: string; userAgent: string; referer: string }>();
const server = createServer((request, response) => {
  report.requests += 1;
  if (request.url?.startsWith('/file')) {
    const headerKey =
      scenario === 'concurrent-delayed' ? `late-${++concurrentRequests}.bin` : scenario;
    receivedHeaders.set(headerKey, {
      cookie: request.headers.cookie ?? '',
      userAgent: request.headers['user-agent'] ?? '',
      referer: request.headers.referer ?? '',
    });
    report.events.push({
      scenario,
      type: 'server-headers',
      headerKey,
      cookieMatch: request.headers.cookie === 'probe=controlled',
      userAgent: request.headers['user-agent'] ?? '',
      refererPresent: Boolean(request.headers.referer),
    });
  }
  if (report.requests > 29) {
    response.writeHead(429).end();
    return;
  }
  if (scenario === 'concurrent-delayed' && request.url?.startsWith('/file')) {
    const ordinal = concurrentRequests;
    const timer = setTimeout(
      () => {
        response
          .writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="late-${ordinal}.bin"`,
            'Cache-Control': 'no-store',
          })
          .end('controlled');
        responseTimers.delete(timer);
      },
      ordinal === 1 ? 1200 : 60,
    );
    responseTimers.add(timer);
  } else if (request.url?.startsWith('/file'))
    response
      .writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="probe.txt"',
        'Cache-Control': 'no-store',
      })
      .end('controlled');
  else if (request.url?.startsWith('/redirect'))
    response.writeHead(302, { Location: '/file?redirect=1' }).end();
  else if (request.url === '/child')
    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end('<a style="display:block;width:200px;height:80px" href="/file">下载</a>');
  else
    response
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(
        scenario === 'iframe'
          ? '<iframe src="/child" style="border:0;width:500px;height:300px"></iframe>'
          : `<a id="download" style="display:block;width:200px;height:80px" href="${scenario === 'redirect' || scenario === 'blank-redirect' || scenario === 'attribute-redirect' ? '/redirect' : '/file'}" ${scenario.startsWith('blank') ? 'target="_blank"' : ''} ${scenario === 'download-attribute' || scenario === 'attribute-redirect' || scenario === 'concurrent-delayed' ? 'download' : ''} ${scenario === 'attribute-redirect' ? 'referrerpolicy="no-referrer"' : ''}>下载</a>`,
      );
});
const timer = setTimeout(() => {
  report.error = '产品探针超过45秒';
  finish(1);
}, 45000);
function finish(code: number): void {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  for (const responseTimer of responseTimers) clearTimeout(responseTimer);
  interceptor?.dispose();
  cookieReader.dispose();
  controller?.dispose();
  window?.destroy();
  server.close();
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2));
  app.exit(code);
}
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 7000;
  while (!check()) {
    assert(Date.now() < deadline, '有界等待未完成');
    await delay(25);
  }
}
async function click(wc: WebContents, point = { x: 40, y: 40 }): Promise<void> {
  window?.show();
  window?.focus();
  wc.focus();
  await delay(100);
  report.events.push({
    scenario,
    type: 'focus',
    window: window?.isFocused(),
    web: wc.isFocused(),
    main: wc.focusedFrame === wc.mainFrame,
  });
  report.events.push({
    scenario,
    type: 'hit-test',
    target: await wc.executeJavaScript(
      `(() => { const element = document.elementFromPoint(40, 40); document.addEventListener('click', e => globalThis.__probeClick = { trusted: e.isTrusted, tag: e.target.tagName, x: e.clientX, y: e.clientY }); return { tag: element?.tagName, html: element?.outerHTML?.slice(0,500), width: innerWidth, height: innerHeight }; })()`,
    ),
  });
  if (process.env.AIBROWSE_DOWNLOAD_INPUT === 'native') {
    assert(window);
    const bounds = window.getContentBounds();
    const point = screen.dipToScreenPoint({ x: bounds.x + 40, y: bounds.y + 40 });
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
    child.stderr.on('data', (chunk: Buffer) => {
      diagnostic += chunk.toString().slice(0, 4096);
    });
    const code = await new Promise((res, rej) => {
      child.once('exit', res);
      child.once('error', rej);
    });
    report.events.push({ scenario, type: 'native', code, diagnostic });
    assert.equal(code, 0);
    return;
  }
  wc.sendInputEvent({ type: 'mouseMove', ...point });
  await delay(50);
  wc.sendInputEvent({ type: 'mouseDown', button: 'left', ...point, clickCount: 1 });
  await delay(80);
  wc.sendInputEvent({ type: 'mouseUp', button: 'left', ...point, clickCount: 1 });
  await delay(100);
  report.events.push({
    scenario,
    type: 'dom-click',
    click: await wc.executeJavaScript('globalThis.__probeClick ?? null'),
  });
}
void app
  .whenReady()
  .then(async () => {
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const ses = session.fromPartition('download-product-probe');
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    let issuedRequests = 0;
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith(origin + '/') && issuedRequests < 29;
      if (allowed) issuedRequests += 1;
      callback({ cancel: !allowed });
    });
    await ses.cookies.set({ url: origin, name: 'probe', value: 'controlled' });
    window = new BaseWindow({ width: 650, height: 400, show: true });
    window.setAlwaysOnTop(true);
    controller = new BrowserControllerImpl({
      ownerWindow: window,
      sessionManager: { getSession: () => ses } as SessionManager,
      getFallbackBounds: () => ({ x: 0, y: 0, width: 650, height: 350 }),
    });
    ses.on('will-download', (event, item, wc, frame) => {
      event.preventDefault();
      nativeDownloads += 1;
      report.events.push({
        scenario,
        type: 'download',
        gesture: item.hasUserGesture(),
        mainFrame: frame === wc.mainFrame,
        initiator: item.getInitiatorOrigin(),
        url: item.getURL(),
        filename: item.getFilename(),
      });
    });
    interceptor = new IdmDownloadInterceptor({
      session: ses,
      getCaptureContext: (id, frame) => controller!.getDownloadCaptureContext(id, frame),
      isUserDownloadFrame: (id, frame) => controller!.isUserDownloadFrame(id, frame),
      consumeDownloadLease: (wc, frame, snapshot) =>
        controller!.consumeDownloadLease(wc, frame, snapshot),
      readFallback: (input) => cookieReader.read(input),
      service: {
        send: async (metadata, isCurrent) => {
          serviceAttempts.push(metadata.filename);
          report.events.push({
            scenario,
            type: 'metadata-check',
            cookieMatch: metadata.cookie === 'probe=controlled',
            filename: metadata.filename,
            userAgent: metadata.userAgent,
            current: isCurrent(),
          });
          assert(isCurrent());
          const actual = receivedHeaders.get(
            scenario === 'concurrent-delayed' ? metadata.filename : scenario,
          );
          assert(actual);
          const pairs = (cookie: string): string[] =>
            cookie
              .split(';')
              .map((part) => part.trim())
              .filter(Boolean)
              .sort();
          assert.deepEqual(
            pairs(metadata.cookie),
            pairs(actual.cookie),
            'Cookie集合须与实际请求一致',
          );
          assert.equal(metadata.userAgent, actual.userAgent, 'UA须与实际请求一致');
          assert.equal(metadata.referer, actual.referer, 'Referer须与实际请求一致');
          assert.equal(
            metadata.filename,
            scenario === 'concurrent-delayed' ? 'late-2.bin' : 'probe.txt',
          );
          handoffs.push(scenario);
          handoffFiles.push(metadata.filename);
          report.events.push({
            scenario,
            type: 'handoff',
            cookieMatch: true,
            refererPresent: metadata.referer.length > 0,
            filenameMatch: true,
            current: isCurrent(),
          });
          return { ok: true, message: '受控交接通过' };
        },
      },
      onResult: (result) => report.events.push({ scenario, type: 'result', ok: result.ok }),
    });
    for (const name of [
      'ordinary',
      'download-attribute',
      'attribute-redirect',
      'redirect',
      'blank',
      'blank-redirect',
      'automatic',
      'ambient-script',
      'iframe',
      'task',
      'AI',
      'concurrent-delayed',
    ]) {
      scenario = name;
      const target = origin + '/page?' + name;
      const tab =
        name === 'task'
          ? await controller.createTaskTab(target)
          : await controller.createTab(target);
      const wc = webContents.fromId(controller.getOwnedWebContentsId(tab.id)!);
      assert(wc);
      wc.on('before-mouse-event', (_event, input) =>
        report.events.push({ scenario, type: 'input', input: input.type }),
      );
      await until(() => wc.getURL() === target && !wc.isLoadingMainFrame());
      await delay(100);
      const before = handoffs.length;
      const attemptsBefore = serviceAttempts.length;
      const nativeBefore = nativeDownloads;
      if (name === 'concurrent-delayed') {
        await ses.cookies.set({ url: origin, name: 'probe', value: 'old-request' });
        await click(wc);
        await until(() => concurrentRequests === 1);
        await ses.cookies.set({ url: origin, name: 'probe', value: 'new-request' });
        await click(wc);
        await until(() => concurrentRequests === 2 && nativeDownloads === nativeBefore + 2);
      } else if (name === 'ambient-script') {
        await click(wc, { x: 400, y: 200 });
        await wc.executeJavaScript('document.getElementById("download").click()');
      } else if (name === 'automatic')
        await wc.executeJavaScript('document.getElementById("download").click()');
      else if (name === 'iframe') {
        await click(wc, { x: 550, y: 320 });
        const child = wc.mainFrame.frames[0];
        assert(child);
        await child.executeJavaScript('document.querySelector("a").click()', true);
      } else if (name === 'AI') {
        const snapshot = await controller.getPageSnapshot(tab.id);
        assert(snapshot);
        const link = snapshot.links.find((item) => item.text === '下载');
        assert(link);
        const result = await controller.clickElement(
          tab.id,
          link.id,
          'nav',
          snapshot.meta.documentId,
        );
        assert(result.ok);
      } else await click(wc);
      await until(() => nativeDownloads > nativeBefore);
      await delay(500);
      const expected = [
        'ordinary',
        'download-attribute',
        'attribute-redirect',
        'redirect',
        'blank',
        'blank-redirect',
        'concurrent-delayed',
      ].includes(name)
        ? 1
        : 0;
      if (name === 'ambient-script')
        report.events.push({
          scenario,
          type: 'ambient-observation',
          handoffs: handoffs.length - before,
        });
      else {
        assert.equal(handoffs.length - before, expected, name);
        assert.equal(
          serviceAttempts.length - attemptsBefore,
          expected,
          name + ' 不得隐瞒已尝试的交接',
        );
      }
      if (name === 'attribute-redirect') assert.equal(receivedHeaders.get(name)?.referer, '');
      if (name === 'concurrent-delayed') assert.equal(handoffFiles.at(-1), 'late-2.bin');
      if (name === 'iframe')
        assert(
          report.events.some(
            (entry) =>
              typeof entry === 'object' &&
              entry !== null &&
              'scenario' in entry &&
              entry.scenario === name &&
              'type' in entry &&
              entry.type === 'download',
          ),
          '需要真实子帧下载反例',
        );
      if (name.startsWith('blank')) {
        const active = await controller.getActiveTab();
        assert(active);
        assert.equal(active.state, 'ready');
        assert.equal(active.failure, undefined);
      }
      report.checks.push(name);
    }
    assert.equal(report.requests, 29);
    report.passed = true;
    finish(0);
  })
  .catch((error: unknown) => {
    report.error = error instanceof Error ? error.stack : String(error);
    finish(1);
  });
