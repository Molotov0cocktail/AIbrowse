import { BaseWindow, webContents, type WebContents } from 'electron';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import { AppSessionManager } from '../../src/main/browser/session-manager';

// This exercises the actual product classes after the pinned launcher binds paths.
// It is a bounded integration smoke, not a replacement for the resource window.
type Emit = (kind: string, detail?: Record<string, unknown>) => void;
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    check(performance.now() < deadline, '浏览器冒烟等待超时');
    await delay(10);
  }
}

export async function run(emit: Emit): Promise<void> {
  const owner = new BaseWindow({ width: 720, height: 480, show: false });
  const controller = new BrowserControllerImpl({
    ownerWindow: owner,
    sessionManager: new AppSessionManager(),
    getFallbackBounds: () => ({ x: 0, y: 0, width: 720, height: 480 }),
  });
  const owned: WebContents[] = [];
  const contents = (id: string): WebContents => {
    const wcId = controller.getOwnedWebContentsId(id);
    const wc = wcId === null ? undefined : webContents.fromId(wcId);
    check(wc !== undefined, '浏览器冒烟缺少真实内容对象');
    owned.push(wc);
    return wc;
  };
  const server = createServer(async (request, response) => {
    if (request.url === '/next') await delay(300);
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><html><head><title>固定浏览器夹具</title></head><body><main><h1>固定浏览器夹具</h1><p>这是一段只用于本地浏览器生命周期验证的公开固定文本。</p><p id="instance"></p><input id="value" data-aibrowse-el="1"><button id="action" type="button" aria-expanded="false" data-aibrowse-el="2" onclick="this.dataset.clicked=\'yes\'">展开</button></main><script>document.querySelector("#instance").textContent = "文档实例：" + Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-"); window.addEventListener("pagehide", (event) => event.stopImmediatePropagation(), true);</script></body></html>',
    );
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    check(address !== null && typeof address === 'object', '浏览器夹具地址不可用');
    const target = `http://127.0.0.1:${address.port}/fixture`;

    const begin = performance.now();
    const initial = await controller.createTab();
    const first = contents(initial.id);
    check(
      initial.state === 'ready' && first.getOSProcessId() === 0,
      '默认空白应就绪且未创建renderer',
    );
    owner.show();
    await delay(1000);
    check(
      first.getOSProcessId() === 0 && performance.now() - begin < 5000,
      '显示聚焦触发了默认空白加载',
    );
    emit('浏览器场景通过', { scenario: '默认空白显示聚焦', rendererPid: 0 });

    check(await controller.navigate(initial.id, target), '默认空白首次导航失败');
    const firstSnapshot = await controller.getPageSnapshot(initial.id);
    check(
      firstSnapshot?.url === target && firstSnapshot.meta.readyState === 'complete',
      '首次导航未取得真实完整快照',
    );
    await delay(1000);
    check(first.getURL() === target, '首次导航被迟到空白覆盖');
    emit('浏览器场景通过', { scenario: '首次导航和真实快照', rendererPid: first.getOSProcessId() });

    check(
      await controller.navigate(initial.id, `http://127.0.0.1:${address.port}/next`),
      '历史返回夹具导航失败',
    );
    check(await controller.goBack(initial.id), '历史返回失败');
    await until(() => !first.isLoadingMainFrame() && first.getURL() === target);
    const returnedSnapshot = await controller.getPageSnapshot(initial.id);
    const newDocumentInstance =
      firstSnapshot.visibleText?.includes('文档实例：') === true &&
      returnedSnapshot?.visibleText?.includes('文档实例：') === true &&
      firstSnapshot.visibleText !== returnedSnapshot.visibleText;
    check(
      newDocumentInstance &&
        returnedSnapshot !== null &&
        returnedSnapshot.meta.documentId > firstSnapshot.meta.documentId,
      '历史返回意外复用了旧文档实例',
    );
    emit('历史返回文档核对', { newDocumentInstance, lifecycleHandlerBlockedByPage: true });

    const concurrent = await controller.createTab();
    const concurrentWc = contents(concurrent.id);
    let finishes = 0;
    concurrentWc.on('did-finish-load', () => {
      finishes += 1;
    });
    const [snapshot, reloaded, scrolled] = await Promise.all([
      controller.getPageSnapshot(concurrent.id),
      controller.reload(concurrent.id),
      controller.scrollTab(concurrent.id, 20),
    ]);
    check(
      snapshot?.url === 'about:blank' &&
        snapshot.meta.readyState === 'complete' &&
        snapshot.meta.documentId === 1 &&
        reloaded &&
        scrolled.ok &&
        finishes === 1 &&
        concurrentWc.getOSProcessId() > 0,
      '并发首次物化没有共享真实加载',
    );
    emit('浏览器场景通过', {
      scenario: '并发物化',
      finishes,
      documentId: snapshot.meta.documentId,
    });

    const replaced = await controller.createTab();
    const replacedWc = contents(replaced.id);
    const reading = controller.getPageSnapshot(replaced.id);
    const navigating = controller.navigate(replaced.id, target);
    const [replacedSnapshot, navigated] = await Promise.all([reading, navigating]);
    check(
      navigated &&
        replacedSnapshot?.url === target &&
        replacedSnapshot.meta.readyState === 'complete',
      '替代导航没有交付当前文档',
    );
    await delay(1000);
    check(replacedWc.getURL() === target, '替代导航被迟到空白覆盖');
    const stableSnapshot = await controller.getPageSnapshot(replaced.id);
    emit('导航快照世代核对', {
      initialDocumentId: replacedSnapshot.meta.documentId,
      stableDocumentId: stableSnapshot?.meta.documentId ?? null,
    });
    check(
      stableSnapshot?.url === target &&
        replacedSnapshot.meta.documentId === stableSnapshot.meta.documentId,
      '替代导航快照错误绑定旧文档世代',
    );
    emit('浏览器场景通过', { scenario: '导航替代在途物化' });

    const explicit = await controller.createTab('about:blank');
    const explicitWc = contents(explicit.id);
    await until(
      () =>
        !explicitWc.isLoading() &&
        explicitWc.getURL() === 'about:blank' &&
        explicitWc.getOSProcessId() > 0,
    );
    const explicitSnapshot = await controller.getPageSnapshot(explicit.id);
    check(explicitSnapshot?.meta.readyState === 'complete', '显式空白未保持真实加载');
    emit('浏览器场景通过', { scenario: '显式空白兼容', rendererPid: explicitWc.getOSProcessId() });

    const interaction = await controller.createTab();
    const interactionWc = contents(interaction.id);
    check(await controller.navigate(interaction.id, target), '交互夹具首次导航失败');
    const oldDocument = await controller.getPageSnapshot(interaction.id);
    check(oldDocument !== null, '交互夹具快照缺失');
    check(
      oldDocument.inputs?.some((input) => input.id === 'el-1') &&
        oldDocument.buttons.some((button) => button.id === 'el-2'),
      '交互夹具烙印不匹配，不能证明同编号跨文档反例',
    );
    const validFill = await controller.fillElement(
      interaction.id,
      'el-1',
      '合成测试值',
      oldDocument.meta.documentId,
    );
    const validClick = await controller.clickElement(
      interaction.id,
      'el-2',
      'expand',
      oldDocument.meta.documentId,
    );
    const positiveControl: unknown = await interactionWc.executeJavaScript(
      'document.querySelector("#value").value === "合成测试值" && document.querySelector("#action").dataset.clicked === "yes"',
    );
    check(validFill.ok && validClick.ok && positiveControl === true, '同文档交互正控失败');
    const nextNavigation = controller.navigate(
      interaction.id,
      `http://127.0.0.1:${address.port}/next`,
    );
    await until(() => interactionWc.isLoadingMainFrame());
    const readingDuringNavigation = controller.getPageSnapshot(interaction.id);
    const filling = await controller.fillElement(
      interaction.id,
      'el-1',
      '合成测试值',
      oldDocument.meta.documentId,
    );
    check(await nextNavigation, '交互夹具替代导航失败');
    const refreshedDocument = await readingDuringNavigation;
    check(
      refreshedDocument !== null && refreshedDocument.meta.documentId > oldDocument.meta.documentId,
      '导航期间采集没有重取新文档',
    );
    const nextValue: unknown = await interactionWc.executeJavaScript(
      'document.querySelector("#value").value',
    );
    emit('跨文档填充核对', {
      accepted: filling.ok,
      newDocumentModified: nextValue !== '',
      expectedDocumentId: oldDocument.meta.documentId,
    });
    check(!filling.ok && nextValue === '', '旧文档授权的填充写入了新文档');

    const clickDocument = await controller.getPageSnapshot(interaction.id);
    check(clickDocument !== null, '点击夹具快照缺失');
    const clickNavigation = controller.navigate(
      interaction.id,
      `http://127.0.0.1:${address.port}/next`,
    );
    await until(() => interactionWc.isLoadingMainFrame());
    const clicking = await controller.clickElement(
      interaction.id,
      'el-2',
      'expand',
      clickDocument.meta.documentId,
    );
    check(await clickNavigation, '点击夹具替代导航失败');
    const wasClicked: unknown = await interactionWc.executeJavaScript(
      'document.querySelector("#action").dataset.clicked === "yes"',
    );
    emit('跨文档点击核对', { accepted: clicking.ok, newDocumentModified: wasClicked });
    check(!clicking.ok && wasClicked === false, '旧文档授权的点击作用于新文档');
    emit('浏览器场景通过', { scenario: '交互跨文档拒绝' });

    const closing = await controller.createTab();
    const closingWc = contents(closing.id);
    const closingRead = controller.getPageSnapshot(closing.id);
    check(await controller.closeTab(closing.id), '关闭在途物化失败');
    check((await closingRead) === null, '关闭后快照未取消');
    await until(() => closingWc.isDestroyed());
    const destroyed = await controller.createTab();
    const destroyedWc = contents(destroyed.id);
    const destroyedRead = controller.getPageSnapshot(destroyed.id);
    destroyedWc.close({ waitForBeforeUnload: false });
    check((await destroyedRead) === null, '意外销毁后快照未取消');
    emit('浏览器场景通过', { scenario: '关闭和意外销毁取消等待' });

    const disposing = await controller.createTab();
    contents(disposing.id);
    const disposingRead = controller.getPageSnapshot(disposing.id);
    controller.dispose();
    controller.dispose();
    check((await disposingRead) === null, '销毁浏览器后快照未取消');
    await until(() => owned.every((wc) => wc.isDestroyed()));
    check((await controller.getTabs()).length === 0, '浏览器销毁后存在登记残留');
    owner.close();
    check(owner.isDestroyed(), '浏览器窗口未销毁');
    emit('浏览器产品冒烟通过', { scenarios: 8, allOwnedDestroyed: true, defaultGpu: true });
  } finally {
    controller.dispose();
    if (!owner.isDestroyed()) owner.close();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
