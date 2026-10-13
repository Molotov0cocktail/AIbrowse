// Rejected API route: Electron refuses to adopt a BrowserWindow-owned WebContents.
import { app, BrowserWindow, WebContentsView, session } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';

const root = resolve('log/oauth-popup-20261013', `native-owner-${randomUUID()}`);
mkdirSync(join(root, 'profile'), { recursive: true });
app.setPath('userData', join(root, 'profile'));
app.setPath('sessionData', join(root, 'profile'));
const result = { passed: false, requests: [], children: [], failures: [] };
process.on('uncaughtException', (error) => {
  result.failures.push(String(error));
  finish(1);
});
const hosts = [];
const timer = setTimeout(() => {
  result.failures.push('超时');
  finish(1);
}, 20000);
let finished = false;
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
  process.stdout.write(`${root}\n`);
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.destroy();
    }
  } finally {
    app.exit(code);
  }
}
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(50);
  }
  throw new Error('有界状态等待失败');
}
app
  .whenReady()
  .then(async () => {
    const ses = session.fromPartition(`native-owner-${randomUUID()}`);
    await ses.protocol.handle('https', async (request) => {
      const url = new URL(request.url);
      assert(['source.example', 'login.example'].includes(url.hostname));
      assert(result.requests.length < 16);
      result.requests.push({
        path: `${url.hostname}${url.pathname}`,
        method: request.method,
        origin: request.headers.get('origin'),
        referrer: request.headers.get('referer'),
        body: request.method === 'POST' ? await request.text() : null,
      });
      const html =
        url.hostname === 'source.example'
          ? `<html><body><form method="POST" target="_blank" action="https://login.example/form"><input name="fixture" value="ok"></form><script>window.received=false;addEventListener('message',e=>{if(e.origin==='https://login.example'&&e.data==='fixture')received=true})</script></body></html>`
          : '<html><body>合成登录页</body></html>';
      return new globalThis.Response(html, { headers: { 'Content-Type': 'text/html' } });
    });
    const owner = new BrowserWindow({
      show: false,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    owner.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      outlivesOpener: true,
      overrideBrowserWindowOptions: {
        show: false,
        webPreferences: {
          session: ses,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      },
    }));
    owner.webContents.on('did-create-window', (child) => {
      hosts.push(child);
      const wc = child.webContents;
      child.setContentSize(600, 400);
      const view = new WebContentsView({ webContents: wc });
      owner.contentView.addChildView(view);
      view.setBounds({ x: 0, y: 0, width: 600, height: 400 });
      const fact = {
        ownerHidden: !child.isVisible(),
        sameContents: wc === view.webContents,
        reparented: owner.contentView.children.includes(view),
        received: false,
        closeDestroyed: false,
      };
      result.children.push(fact);
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.once('destroyed', () => {
        fact.closeDestroyed = true;
        if (!owner.isDestroyed()) owner.contentView.removeChildView(view);
      });
    });
    await owner.loadURL('https://source.example/start');
    const handle = await owner.webContents.executeJavaScript(
      "window.child=window.open('https://login.example/auth'); child!==null",
      true,
    );
    assert.equal(handle, true);
    await waitFor(() => hosts.length === 1 && !hosts[0].webContents.isLoading());
    result.children[0].received = await hosts[0].webContents.executeJavaScript(
      "window.opener!==null && (opener.postMessage('fixture','https://source.example'),true)",
    );
    await waitFor(() => !owner.webContents.isDestroyed());
    await delay(100);
    assert.equal(await owner.webContents.executeJavaScript('received'), true);
    result.children[0].viewport = await hosts[0].webContents.executeJavaScript(
      '({width:innerWidth,height:innerHeight})',
    );
    assert.deepEqual(result.children[0].viewport, { width: 600, height: 400 });
    owner.contentView.children.at(-1).setBounds({ x: 0, y: 0, width: 700, height: 450 });
    await delay(100);
    result.children[0].resizedViewport = await hosts[0].webContents.executeJavaScript(
      '({width:innerWidth,height:innerHeight})',
    );
    assert.deepEqual(result.children[0].resizedViewport, { width: 700, height: 450 });
    await hosts[0].webContents.executeJavaScript('window.close()').catch(() => {});
    await waitFor(() => result.children[0].closeDestroyed);
    await owner.webContents.executeJavaScript('document.forms[0].submit()', true);
    await waitFor(() => hosts.length === 2 && !hosts[1].webContents.isLoading());
    assert(
      result.requests.some(
        (r) =>
          r.path === 'login.example/form' &&
          r.method === 'POST' &&
          r.body === 'fixture=ok' &&
          r.origin === 'https://source.example',
      ),
    );
    assert(result.children.every((c) => c.ownerHidden && c.sameContents && c.reparented));
    result.passed = true;
    finish(0);
  })
  .catch((error) => {
    result.failures.push(String(error));
    finish(1);
  });
