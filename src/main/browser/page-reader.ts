// PageReader：快照与交互编排——给定一个活的 webContents，执行只读注入并产出 PageSnapshot
// （A3 扩展：documentId 主进程世代盖章 + click/fill/scroll 交互注入编排，复用同一
// executeJavaScript 通道与前置守卫）。
// Contract source: doc/detailed-design.md §2.5/§8.1/§8.5（L0–L2 降级阶梯内部处理）+ §5。
// 前置守卫（tab 存在、webContents 未销毁 → L3 null）由 BrowserController 完成；
// 本模块只管「活的 webContents → 结果」：执行失败/页面崩溃/结果不可用 → 结构化降级
// （不抛异常）。依赖方向：仅被 BrowserController 调用（分层纪律）；页面返回值视为
// 不可信输入（§8.6 + §5.1 交互结果逐字段校验）。

import type { WebContents } from 'electron';
import type { ClickAllowedKind } from '../../shared/types/agent';
import type { PageSnapshot } from '../../shared/types/browser';
import { logDebug, logWarn } from '../logger';
import { SNAPSHOT_SCRIPT_SOURCE } from './snapshot-script';
import { normalizeSnapshot } from './snapshot-normalize';
import { buildInteractionSource } from './interaction-script';
import {
  normalizeInteractionResult,
  type InteractionAction,
  type NormalizedInteractionResult,
} from './interaction-normalize';

export class PageReader {
  async snapshot(webContents: WebContents, documentId: number): Promise<PageSnapshot> {
    const fallback = {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      documentId, // A3：主进程侧导航世代（TabManager 维护），页面/模型不可伪造
    };

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
  private buildL2(
    fallback: { url: string; title: string; documentId: number },
    reason: string,
  ): PageSnapshot {
    const snapshot = normalizeSnapshot(null, fallback);
    snapshot.meta.warnings.unshift(reason);
    logWarn('page-reader', `快照降级 L2：${reason}（url=${fallback.url}）`);
    return snapshot;
  }

  // ---------- A3 交互编排（§5.1）：复用 executeJavaScript 通道 + 前置守卫 ----------
  // 交互返回值视为敌手输入，经 normalizeInteractionResult 逐字段校验；执行异常/渲染进程
  // 失效只产生结构化失败——异常与堆栈只进日志（logWarn），不穿透 ToolResult。

  private guardInteractive(webContents: WebContents): NormalizedInteractionResult | null {
    if (webContents.isDestroyed()) {
      return { ok: false, errorCode: 'execution-failed', reason: '标签页已销毁' };
    }
    if (webContents.isCrashed()) {
      return { ok: false, errorCode: 'execution-failed', reason: '渲染进程已崩溃，无法执行交互' };
    }
    return null;
  }

  private async inject(
    webContents: WebContents,
    source: string,
    method: InteractionAction,
  ): Promise<NormalizedInteractionResult> {
    const guard = this.guardInteractive(webContents);
    if (guard !== null) return guard;
    try {
      const raw: unknown = await webContents.executeJavaScript(source, false);
      return normalizeInteractionResult(raw, method);
    } catch (err) {
      // 页面冻结/崩溃/导航竞态导致执行上下文失效——细节只进日志，ToolResult 仅中文说明
      logWarn('page-reader', `交互脚本执行失败（${method}）`, err);
      return { ok: false, errorCode: 'execution-failed', reason: '页面执行失败（渲染进程不可用）' };
    }
  }

  async click(
    webContents: WebContents,
    elementId: string,
    allowedKind: ClickAllowedKind,
  ): Promise<NormalizedInteractionResult> {
    return this.inject(
      webContents,
      buildInteractionSource({ action: 'click', elementId, allowedKind }),
      'click',
    );
  }

  async fill(
    webContents: WebContents,
    elementId: string,
    text: string,
  ): Promise<NormalizedInteractionResult> {
    return this.inject(
      webContents,
      buildInteractionSource({ action: 'fill', elementId, text }),
      'fill',
    );
  }

  async scroll(webContents: WebContents, dy: number): Promise<NormalizedInteractionResult> {
    return this.inject(webContents, buildInteractionSource({ action: 'scroll', dy }), 'scroll');
  }
}
