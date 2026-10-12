// PageReader：快照与交互编排——给定一个活的 webContents，执行只读注入并产出 PageSnapshot
// Snapshot and interaction templates run in a private isolated world. Document
// bindings stay internal and are accepted only after the controller's stability check.
// Contract source: doc/detailed-design.md §2.5/§8.1/§8.5（L0–L2 降级阶梯内部处理）+ §5。
// 前置守卫（tab 存在、webContents 未销毁 → L3 null）由 BrowserController 完成；
// 本模块只管「活的 webContents → 结果」：执行失败/页面崩溃/结果不可用 → 结构化降级
// （不抛异常）。依赖方向：仅被 BrowserController 调用（分层纪律）；页面返回值视为
// 不可信输入（§8.6 + §5.1 交互结果逐字段校验）。

import type { WebContents } from 'electron';
import type { ClickAllowedKind } from '../../shared/types/agent';
import type { PageSnapshot } from '../../shared/types/browser';
import { logDebug, logWarn } from '../logger';
import { redactUrlForLog } from '../../shared/url';
import { normalizeSnapshot } from './snapshot-normalize';
import { buildInteractionSource } from './interaction-script';
import {
  BOUND_SNAPSHOT_SCRIPT_SOURCE,
  buildBoundInteractionSource,
  PAGE_READER_WORLD_ID,
} from './document-binding-script';
import {
  normalizeInteractionResult,
  type InteractionAction,
  type NormalizedInteractionResult,
} from './interaction-normalize';

export type CollectedPageSnapshot =
  | { status: 'collected'; snapshot: PageSnapshot; token: string | null }
  | { status: 'cancelled'; snapshot: null; token: null };

type SnapshotRequestResult =
  | { status: 'fulfilled'; value: unknown }
  | { status: 'rejected'; error: unknown }
  | { status: 'cancelled' };

interface SnapshotRequest {
  webContents: WebContents;
  approved: boolean;
  promise: Promise<SnapshotRequestResult>;
  finish(result: SnapshotRequestResult): void;
}

const cancelledSnapshot = (): CollectedPageSnapshot => ({
  status: 'cancelled',
  snapshot: null,
  token: null,
});

// Own the pre-dispatch wait. Electron's implicit loading wait has no abort or
// destroyed settlement, so it must not acquire our operation while loading.
function waitForSnapshotReadiness(
  webContents: WebContents,
  signal?: AbortSignal,
): Promise<boolean> {
  const alive = (): boolean =>
    !signal?.aborted && !webContents.isDestroyed() && !webContents.isCrashed();
  const ready = (): boolean => webContents.getURL() !== '' && !webContents.isLoadingMainFrame();
  if (!alive()) return Promise.resolve(false);
  if (ready()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      webContents.removeListener('did-stop-loading', check);
      webContents.removeListener('destroyed', cancel);
      webContents.removeListener('render-process-gone', cancel);
      signal?.removeEventListener('abort', cancel);
      resolve(value);
    };
    const cancel = (): void => finish(false);
    const check = (): void => {
      if (!alive()) finish(false);
      else if (ready()) finish(true);
    };
    webContents.on('did-stop-loading', check);
    webContents.once('destroyed', cancel);
    webContents.once('render-process-gone', cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    check();
  });
}

export class PageReader {
  private readonly bindings = new WeakMap<WebContents, { documentId: number; token: string }>();
  private snapshotShutdown = false;
  private stopOperation: Promise<void> | null = null;
  private readonly readers = new Map<AbortController, Promise<CollectedPageSnapshot>>();
  private readonly requests = new Set<SnapshotRequest>();
  private readonly interactions = new Map<WebContents, Set<Promise<NormalizedInteractionResult>>>();

  beginSnapshotShutdown(): void {
    this.snapshotShutdown = true;
  }

  /** Main-only: the caller must obtain native user consent before this operation. */
  stopSnapshotsForShutdown(): Promise<void> {
    if (!this.snapshotShutdown) return Promise.reject(new Error('尚未进入退出阶段'));
    this.stopOperation ??= Promise.resolve().then(async () => {
      for (const reader of this.readers.keys()) reader.abort();
      const targets = new Set<WebContents>();
      for (const request of this.requests) {
        request.approved = true;
        targets.add(request.webContents);
      }
      await Promise.all([...targets].map((contents) => this.retireSnapshotTarget(contents)));
      await Promise.allSettled([...this.readers.values()]);
    });
    return this.stopOperation;
  }

  private async retireSnapshotTarget(contents: WebContents): Promise<void> {
    // Approval covers snapshots only. Existing interaction transports retain their
    // original completion and cannot be interrupted by destroying a shared target.
    await Promise.allSettled([...(this.interactions.get(contents) ?? [])]);
    const pending = [...this.requests].filter((item) => item.webContents === contents);
    if (pending.length === 0) return;
    const destroyed = (): void => {
      if (!contents.isDestroyed()) return;
      for (const request of pending) request.finish({ status: 'cancelled' });
    };
    contents.on('destroyed', destroyed);
    try {
      if (contents.isDestroyed()) destroyed();
      else {
        contents.close({ waitForBeforeUnload: false });
        destroyed();
      }
      await Promise.all(pending.map((item) => item.promise));
    } finally {
      contents.removeListener('destroyed', destroyed);
    }
  }

  private collectRequest(contents: WebContents): Promise<SnapshotRequestResult> {
    let resolve!: (result: SnapshotRequestResult) => void;
    const promise = new Promise<SnapshotRequestResult>((done) => (resolve = done));
    const request: SnapshotRequest = {
      webContents: contents,
      approved: false,
      promise,
      finish: (result) => {
        if (!this.requests.delete(request)) return;
        resolve(request.approved ? { status: 'cancelled' } : result);
      },
    };
    this.requests.add(request);
    try {
      // The original Electron Promise remains observed even after entity retirement.
      // Only this owned request has a cancelled terminal; the transport is not fulfilled.
      const native = contents.executeJavaScriptInIsolatedWorld(
        PAGE_READER_WORLD_ID,
        [{ code: BOUND_SNAPSHOT_SCRIPT_SOURCE }],
        false,
      );
      void native.then(
        (value: unknown) => request.finish({ status: 'fulfilled', value }),
        (error: unknown) => request.finish({ status: 'rejected', error }),
      );
    } catch (error) {
      request.finish({ status: 'rejected', error });
    }
    return promise;
  }

  // Called only after the controller confirms that collection did not cross navigation.
  acceptSnapshot(webContents: WebContents, collected: CollectedPageSnapshot): void {
    if (collected.token === null) return;
    this.bindings.set(webContents, {
      documentId: collected.snapshot.meta.documentId,
      token: collected.token,
    });
  }

  snapshot(
    webContents: WebContents,
    documentId: number,
    signal?: AbortSignal,
  ): Promise<CollectedPageSnapshot> {
    if (this.snapshotShutdown) return Promise.resolve(cancelledSnapshot());
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const operation = this.readSnapshot(webContents, documentId, combined).finally(() =>
      this.readers.delete(controller),
    );
    this.readers.set(controller, operation);
    return operation;
  }

  private async readSnapshot(
    webContents: WebContents,
    documentId: number,
    signal: AbortSignal,
  ): Promise<CollectedPageSnapshot> {
    const fallback = {
      url: webContents.getURL(),
      title: webContents.getTitle(),
      documentId, // A3：主进程侧导航世代（TabManager 维护），页面/模型不可伪造
    };

    // 防御：契约上前置守卫已完成 L3 判定，此处兜底竞态（快照瞬间销毁/崩溃）
    if (webContents.isDestroyed()) {
      return {
        status: 'collected',
        snapshot: this.buildL2(fallback, 'webContents 已销毁'),
        token: null,
      };
    }
    if (webContents.isCrashed()) {
      return {
        status: 'collected',
        snapshot: this.buildL2(fallback, '渲染进程已崩溃，仅返回主进程侧数据'),
        token: null,
      };
    }

    let raw: unknown;
    try {
      for (;;) {
        if (!(await waitForSnapshotReadiness(webContents, signal))) {
          if (this.snapshotShutdown) return cancelledSnapshot();
          return {
            status: 'collected',
            snapshot: this.buildL2(fallback, '页面采集等待已取消或页面已不可用'),
            token: null,
          };
        }
        if (this.snapshotShutdown) return cancelledSnapshot();
        // A navigation can begin during the readiness Promise handoff.
        if (signal?.aborted || webContents.isDestroyed() || webContents.isCrashed())
          return {
            status: 'collected',
            snapshot: this.buildL2(fallback, '页面采集已取消或页面已不可用'),
            token: null,
          };
        if (webContents.getURL() !== '' && !webContents.isLoadingMainFrame()) break;
      }
      const result = await this.collectRequest(webContents);
      if (result.status === 'cancelled') return cancelledSnapshot();
      if (result.status === 'rejected') throw result.error;
      raw = result.value;
      // Ordinary abort still waits for the original transport. Explicit shutdown
      // approval additionally permits retirement of the exact destroyed entity.
      if (signal.aborted) {
        if (this.snapshotShutdown) return cancelledSnapshot();
        return {
          status: 'collected',
          snapshot: this.buildL2(fallback, '页面采集已取消'),
          token: null,
        };
      }
    } catch (err) {
      // L2：页面冻结/崩溃/导航竞态导致执行上下文失效（§8.5）
      const reason = err instanceof Error ? err.message : String(err);
      return {
        status: 'collected',
        snapshot: this.buildL2(fallback, `页面采集脚本执行失败：${reason}`),
        token: null,
      };
    }

    const envelope =
      typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    const token =
      typeof envelope?.['token'] === 'string' && /^[0-9a-f]{32}$/.test(envelope['token'])
        ? envelope['token']
        : null;
    const snapshot = normalizeSnapshot(token === null ? null : envelope?.['snapshot'], fallback);
    const collected: CollectedPageSnapshot = { status: 'collected', snapshot, token };
    if (snapshot.meta.degraded === 'main-process-only') {
      // 执行成功但结果不可用（脚本返回 ok:false/垃圾）——补充上下文说明
      logWarn('page-reader', `快照降级 L2（脚本结果不可用，url=${redactUrlForLog(fallback.url)}）`);
      return { status: 'collected', snapshot, token: null };
    }
    if (snapshot.meta.degraded === 'partial') {
      logWarn(
        'page-reader',
        `快照降级 L1（url=${redactUrlForLog(fallback.url)}，warnings=${snapshot.meta.warnings.join('；')}）`,
      );
      return collected;
    }
    logDebug('page-reader', `快照采集完成 L0（url=${redactUrlForLog(fallback.url)}）`);
    return collected;
  }

  // L2 形状由 normalizeSnapshot 统一产出（单一声源），此处仅追加具体失败原因（§8.5）
  private buildL2(
    fallback: { url: string; title: string; documentId: number },
    reason: string,
  ): PageSnapshot {
    const snapshot = normalizeSnapshot(null, fallback);
    snapshot.meta.warnings.unshift(reason);
    logWarn('page-reader', `快照降级 L2：${reason}（url=${redactUrlForLog(fallback.url)}）`);
    return snapshot;
  }

  // Fixed interaction templates use the same isolated world as collection.
  // 交互返回值视为敌手输入，经 normalizeInteractionResult 逐字段校验；执行异常/渲染进程
  // 失效只产生结构化失败——异常与堆栈只进日志（logWarn），不穿透 ToolResult。

  private guardInteractive(webContents: WebContents): NormalizedInteractionResult | null {
    if (this.snapshotShutdown) {
      return { ok: false, errorCode: 'execution-failed', reason: '应用正在退出，无法执行交互' };
    }
    if (webContents.isDestroyed()) {
      return { ok: false, errorCode: 'execution-failed', reason: '标签页已销毁' };
    }
    if (webContents.isCrashed()) {
      return { ok: false, errorCode: 'execution-failed', reason: '渲染进程已崩溃，无法执行交互' };
    }
    return null;
  }

  private inject(
    webContents: WebContents,
    source: string,
    method: InteractionAction,
  ): Promise<NormalizedInteractionResult> {
    const guard = this.guardInteractive(webContents);
    if (guard !== null) return Promise.resolve(guard);
    let resolve!: (result: NormalizedInteractionResult) => void;
    let reject!: (error: unknown) => void;
    const operation = new Promise<NormalizedInteractionResult>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    let pending = this.interactions.get(webContents);
    if (pending === undefined) {
      pending = new Set();
      this.interactions.set(webContents, pending);
    }
    const owned = pending;
    const tracked = operation.finally(() => {
      owned.delete(tracked);
      if (owned.size === 0) this.interactions.delete(webContents);
    });
    owned.add(tracked);
    void this.runInteraction(webContents, source, method).then(resolve, reject);
    return tracked;
  }

  private async runInteraction(
    webContents: WebContents,
    source: string,
    method: InteractionAction,
  ): Promise<NormalizedInteractionResult> {
    try {
      const raw: unknown = await webContents.executeJavaScriptInIsolatedWorld(
        PAGE_READER_WORLD_ID,
        [{ code: source }],
        false,
      );
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
    documentId: number,
  ): Promise<NormalizedInteractionResult> {
    const binding = this.bindings.get(webContents);
    if (binding?.documentId !== documentId) return this.staleElement();
    return this.inject(
      webContents,
      buildBoundInteractionSource({ action: 'click', elementId, allowedKind }, binding.token),
      'click',
    );
  }

  async fill(
    webContents: WebContents,
    elementId: string,
    text: string,
    documentId: number,
  ): Promise<NormalizedInteractionResult> {
    const binding = this.bindings.get(webContents);
    if (binding?.documentId !== documentId) return this.staleElement();
    return this.inject(
      webContents,
      buildBoundInteractionSource({ action: 'fill', elementId, text }, binding.token),
      'fill',
    );
  }

  async scroll(webContents: WebContents, dy: number): Promise<NormalizedInteractionResult> {
    return this.inject(webContents, buildInteractionSource({ action: 'scroll', dy }), 'scroll');
  }

  private staleElement(): NormalizedInteractionResult {
    return {
      ok: false,
      errorCode: 'stale-element',
      reason: '元素所属的快照已过期（页面已导航或刷新），请重新读取页面',
    };
  }
}
