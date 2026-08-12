// 冒烟自检（T2 起扩展）：AIBROWSE_SMOKE=1 时在主进程内驱动浏览器核心场景并断言。
// 场景（§10 + T3 扩展）：多 view 创建/切换/关闭、最后 Tab 自动新建、可选真实 URL 加载、
// dispose 幂等与无泄漏；T3 新增 UI 窗口导航保护拦截验证（R-01）与渲染层 bounds 上报生效验证（§6）。
// 任何断言失败 → logError + 抛出，入口 catch 后以退出码 1 结束（与基线冒烟语义一致）。

import { webContents, WebContentsView } from 'electron';
import type { BrowserWindow } from 'electron';
import type { BrowserController } from './browser/browser-controller';
import { logError, logInfo } from './logger';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(
  cond: () => Promise<boolean>,
  timeoutMs: number,
  failure: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(failure);
    await delay(50);
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`冒烟断言失败：${message}`);
}

export interface SmokeOptions {
  loadUrl?: string;
  uiWindow?: BrowserWindow | null; // T3：UI 窗口导航保护拦截与 bounds 上报生效验证用
}

// 活动 Tab 对应的可见 WebContentsView（bounds 上报验证：§6 全量覆盖式应用）
function visibleTabView(win: BrowserWindow | null | undefined): WebContentsView | null {
  if (win === null || win === undefined) return null;
  for (const child of win.contentView.children) {
    if (child instanceof WebContentsView && child.getVisible()) return child;
  }
  return null;
}

export async function runSmokeScenario(
  controller: BrowserController,
  options: SmokeOptions = {},
): Promise<void> {
  try {
    // 0. 初始标签页（main 启动时创建）应存在并就绪
    const initial = await controller.getActiveTab();
    assert(initial !== null, '启动后应存在初始活动标签页');
    await waitFor(
      async () => (await controller.getActiveTab())?.state === 'ready',
      5000,
      '初始标签页未在 5 秒内就绪',
    );

    // 1. UI 窗口导航保护（§9，R-01 关闭条件）：页面发起导航到远程 URL 应被 will-navigate
    //    拦截，UI 停留在自身页面——否则远程页面将获得 window.aibrowse bridge（安全红线）。
    if (options.uiWindow !== null && options.uiWindow !== undefined) {
      const uiWc = options.uiWindow.webContents;
      const uiUrl = uiWc.getURL();
      await uiWc.executeJavaScript("window.location.href = 'https://example.com/'");
      await delay(800); // 给导航提交留出时间；保护生效则 URL 不变（未生效则已跳走/加载中）
      assert(uiWc.getURL() === uiUrl, `UI 窗口导航保护未拦截远程导航：UI 现为 ${uiWc.getURL()}`);
      logInfo('smoke', 'UI 窗口导航保护拦截验证通过');
    }

    // 2. 新建第二个标签页 → 新 Tab 成为活动 Tab
    const tab2 = await controller.createTab();
    assert((await controller.getTabs()).length === 2, 'createTab 后应有 2 个标签页');
    assert((await controller.getActiveTab())?.id === tab2.id, '新建标签页应成为活动标签页');
    await waitFor(
      async () => (await controller.getTabs()).find((t) => t.id === tab2.id)?.state === 'ready',
      5000,
      '第二个标签页未在 5 秒内就绪',
    );

    // 3. 渲染层 bounds 上报生效（§6）：chrome 高度已上报，活动 view 的 y 应 > 0
    //    （窗口首次显示前的兜底值为 y=0；上报后全量覆盖式应用到活动 view）
    await waitFor(
      async () => {
        const view = visibleTabView(options.uiWindow);
        return view !== null && view.getBounds().y > 0;
      },
      5000,
      '渲染层 bounds 上报未生效（活动 WebContentsView 的 y 仍为 0）',
    );
    logInfo('smoke', '渲染层 bounds 上报生效验证通过');

    // 4. 切回第一个标签页
    assert(await controller.activateTab(initial.id), 'activateTab 应返回 true');
    assert((await controller.getActiveTab())?.id === initial.id, '激活应切换回第一个标签页');

    // 5. 关闭活动标签页 → 右邻接管（§5 selectNextActive）
    assert(await controller.closeTab(initial.id), 'closeTab 应返回 true');
    const tabsAfterClose = await controller.getTabs();
    assert(
      tabsAfterClose.length === 1 && tabsAfterClose[0]?.id === tab2.id,
      '关闭活动标签页后应只剩右邻',
    );
    assert(
      (await controller.getActiveTab())?.id === tab2.id,
      '关闭活动标签页后右邻应成为活动标签页',
    );

    // 6. 关闭最后一个标签页 → 自动新建空白标签页（最后 Tab 策略，窗口常驻）
    assert(await controller.closeTab(tab2.id), 'closeTab 应返回 true');
    await waitFor(
      async () => (await controller.getTabs()).length === 1,
      5000,
      '最后 Tab 策略未自动新建标签页',
    );
    const autoCreated = await controller.getActiveTab();
    assert(autoCreated !== null && autoCreated.id !== tab2.id, '自动新建的应是全新空白标签页');
    await waitFor(
      async () => (await controller.getActiveTab())?.state === 'ready',
      5000,
      '自动新建的标签页未在 5 秒内就绪',
    );

    // 7. 可选真实 URL 加载（AIBROWSE_SMOKE_URL）：验证多 Tab 可开网页 + 标题随页面变化
    if (options.loadUrl !== undefined) {
      const pageTab = await controller.createTab(options.loadUrl);
      await waitFor(
        async () => {
          const t = (await controller.getTabs()).find((x) => x.id === pageTab.id);
          return t !== undefined && t.state === 'ready' && t.title !== '';
        },
        15000,
        `真实网页（${options.loadUrl}）15 秒内未加载完成（state=ready 且标题非空）`,
      );
      assert(await controller.closeTab(pageTab.id), '关闭网页标签页应返回 true');
      await waitFor(
        async () => (await controller.getTabs()).length === 1,
        5000,
        '关闭网页标签页后应回到单个标签页',
      );
    }

    // 8. dispose 幂等 + 无残留 webContents（退出路径无泄漏）
    controller.dispose();
    controller.dispose(); // 第二次应为无操作（幂等）
    assert((await controller.getTabs()).length === 0, 'dispose 后应无标签页');
    await waitFor(
      async () => webContents.getAllWebContents().length === 1, // 仅剩 React UI 窗口
      5000,
      'dispose 后仍残留标签页 webContents',
    );

    logInfo('smoke', '冒烟场景全部通过（T2 浏览器核心 + T3 UI 闭环）');
  } catch (err) {
    logError('smoke', '冒烟场景失败', err);
    throw err;
  }
}
