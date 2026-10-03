import { createServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { WebContentsView } from 'electron';
import type { BrowserController } from '../../src/main/browser/browser-controller';
import { IPC } from '../../src/shared/types/ipc';
import { logInfo } from '../../src/main/logger';

async function waitFor(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

/** Drive the real badge while a synthetic main-frame response is held open. */
export async function qualifyContextPreviewLoading(
  controller: BrowserController,
  ui: BrowserWindow,
): Promise<void> {
  const previous = await controller.getActiveTab();
  let response: ServerResponse | null = null;
  let tabId: string | null = null;
  const probeKey = `contextPreviewProbe_${randomUUID().replaceAll('-', '')}`;
  const server = createServer((_request, result) => {
    response = result;
    result.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    result.write('<!doctype html><title>预览并发合成页面</title><body>合成正文');
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('预览并发地址不可用');
    const tab = await controller.createTab(`http://127.0.0.1:${address.port}/`);
    tabId = tab.id;
    await waitFor(() => response !== null, '预览并发请求未到达');
    const view = ui.contentView.children.find(
      (child) => child instanceof WebContentsView && child.getVisible(),
    );
    if (!(view instanceof WebContentsView)) throw new Error('预览并发活动Tab缺失');
    const contents = view.webContents;
    const tabs = await controller.getTabs();
    if (tabs.find((item) => item.id === tab.id)?.state !== 'loading')
      throw new Error('预览并发未处于加载期');
    await ui.webContents.executeJavaScript(`(() => {
      const state = { count: 0, unsubscribe: null };
      state.unsubscribe = window.aibrowse.tabs.onUpdated((update) => {
        if (update.__qualificationBurstId === ${JSON.stringify(probeKey)}) state.count += 1;
      });
      window[${JSON.stringify(probeKey)}] = state;
    })()`);
    const before = contents.listenerCount('did-stop-loading');
    let peak = before;
    for (let i = 0; i < 30; i += 1)
      ui.webContents.send(IPC.TabsUpdated, {
        tabs,
        activeTabId: tab.id,
        __qualificationBurstId: probeKey,
      });
    await waitFor(async () => {
      peak = Math.max(peak, contents.listenerCount('did-stop-loading'));
      return (
        (await ui.webContents.executeJavaScript(`window[${JSON.stringify(probeKey)}]?.count`)) ===
        30
      );
    }, '预览并发更新未被renderer完整接收');
    if ((await controller.getTabs()).find((item) => item.id === tab.id)?.state !== 'loading')
      throw new Error('预览并发消息确认前页面提前结束加载');
    peak = Math.max(peak, contents.listenerCount('did-stop-loading'));
    if (peak > before) throw new Error(`预览更新新增加载等待监听：before=${before},peak=${peak}`);
    // Reading the closure state through a getter avoids narrowing across callbacks.
    const finish = (): void => {
      response?.end('</body>');
    };
    finish();
    await waitFor(
      async () =>
        (await controller.getTabs()).find((item) => item.id === tab.id)?.state === 'ready',
      '预览并发页面未就绪',
    );
    await waitFor(
      async () =>
        (await ui.webContents.executeJavaScript(
          `document.querySelector('.ai-context-label')?.textContent`,
        )) === '当前网页',
      '预览并发完成后徽标未刷新',
    );
    await waitFor(
      () => contents.listenerCount('did-stop-loading') === 0,
      '预览完成后等待监听未归零',
    );
    logInfo(
      'smoke',
      `E1徽标加载期30次更新通过（renderer确认=30，监听baseline=${before},peak=${peak},完成后=0）`,
    );
  } finally {
    const finish = (): void => {
      response?.end('</body>');
    };
    finish();
    try {
      if (!ui.isDestroyed() && !ui.webContents.isDestroyed()) {
        await ui.webContents.executeJavaScript(`(() => {
          window[${JSON.stringify(probeKey)}]?.unsubscribe?.();
          delete window[${JSON.stringify(probeKey)}];
        })()`);
      }
    } finally {
      try {
        if (tabId !== null) await controller.closeTab(tabId);
      } finally {
        try {
          if (previous !== null) await controller.activateTab(previous.id);
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
    }
  }
}
