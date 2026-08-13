// PageReader：快照编排——给定一个活的 webContents，执行只读注入并产出 PageSnapshot.
// Contract source: doc/detailed-design.md §2.5/§8.1/§8.5（L0–L2 降级阶梯内部处理）.
// 前置守卫（tab 存在、webContents 未销毁 → L3 null）由 BrowserController 完成；
// 本模块只管「活的 webContents → 快照」：执行失败/页面崩溃/结果不可用 → L2 降级（不抛异常）.
// 依赖方向：仅被 BrowserController 调用（分层纪律）；页面返回值视为不可信输入（§8.6）.

import type { WebContents } from 'electron';
import type { PageSnapshot } from '../../shared/types/browser';
import { logDebug, logWarn } from '../logger';
import { SNAPSHOT_SCRIPT_SOURCE } from './snapshot-script';
import { normalizeSnapshot } from './snapshot-normalize';

export class PageReader {
  async snapshot(webContents: WebContents): Promise<PageSnapshot> {
    const fallback = { url: webContents.getURL(), title: webContents.getTitle() };

    // 防御：契约上前置守卫已完成 L3 判定，此处兜底竞态（快照瞬间销毁/崩溃）
    if (webContents.isDestroyed()) {
      return this.buildL2(fallback, 'webContents 已销毁');
    }
    if (webContents.isCrashed()) {
      return this.buildL2(fallback, '渲染进程已崩溃，仅返回主进程侧数据');
    }

    let raw: unknown;
    try {
      raw = await webContents.executeJavaScript(SNAPSHOT_SCRIPT_SOURCE, false);
    } catch (err) {
      // L2：页面冻结/崩溃/导航竞态导致执行上下文失效（§8.5）
      const reason = err instanceof Error ? err.message : String(err);
      return this.buildL2(fallback, `页面采集脚本执行失败：${reason}`);
    }

    const snapshot = normalizeSnapshot(raw, fallback);
    if (snapshot.meta.degraded === 'main-process-only') {
      // 执行成功但结果不可用（脚本返回 ok:false/垃圾）——补充上下文说明
      logWarn('page-reader', `快照降级 L2（脚本结果不可用，url=${fallback.url}）`);
      return snapshot;
    }
    if (snapshot.meta.degraded === 'partial') {
      logWarn(
        'page-reader',
        `快照降级 L1（url=${fallback.url}，warnings=${snapshot.meta.warnings.join('；')}）`,
      );
      return snapshot;
    }
    logDebug('page-reader', `快照采集完成 L0（url=${fallback.url}）`);
    return snapshot;
  }

  // L2 形状由 normalizeSnapshot 统一产出（单一声源），此处仅追加具体失败原因（§8.5）
  private buildL2(fallback: { url: string; title: string }, reason: string): PageSnapshot {
    const snapshot = normalizeSnapshot(null, fallback);
    snapshot.meta.warnings.unshift(reason);
    logWarn('page-reader', `快照降级 L2：${reason}（url=${fallback.url}）`);
    return snapshot;
  }
}
