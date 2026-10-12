import { app, type WebContents } from 'electron';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageReader } from '../../src/main/browser/page-reader';
import type { BrowserControllerImpl } from '../../src/main/browser/browser-controller';
import type { ConversationServiceImpl } from '../../src/main/ai/conversation-service';

type Identity = {
  id: number;
  parent: number | null;
  kind: string;
  tabId?: string;
  wcId?: number;
  documentId?: number;
};
type Receipt = Identity & { started: number; state: 'pending' | 'fulfilled' | 'rejected' };
const context = new AsyncLocalStorage<Identity>();
const pending = new Map<number, Receipt>();
const productClasses = [
  'runSmokeScenario',
  'runWatchD9EndToEndSmoke',
  'releaseWizardTab',
  'runAiUiScenarios',
  'runAgentUiScenarios',
  'runResearchUiScenario',
  'runSrtScenarios',
  'runResearchCaptureScenario',
  'runResearchRuntimeScenario',
  'runResearchSynthesisScenario',
  'runResearchProductionFactoryScenario',
];
let sequence = 0;
let records = 0;
let bytes = 0;
let checkpointStarted = false;
let runtimeSourceRecorded = false;
const eventsPath = join(app.getAppPath(), 'shutdown-events.jsonl');
function record(event: string, detail: unknown = null): void {
  const text = JSON.stringify({ ms: performance.now(), event, detail }) + '\n';
  if (++records > 20000 || (bytes += Buffer.byteLength(text)) > 8388608)
    throw new Error('退出关联诊断预算耗尽');
  appendFileSync(eventsPath, text);
}
function withPromise<T>(
  kind: string,
  detail: Omit<Identity, 'id' | 'parent' | 'kind'>,
  work: () => Promise<T>,
): Promise<T> {
  const identity = { id: ++sequence, parent: context.getStore()?.id ?? null, kind, ...detail };
  const receipt: Receipt = { ...identity, started: performance.now(), state: 'pending' };
  pending.set(identity.id, receipt);
  record('begin', receipt);
  let promise: Promise<T>;
  try {
    promise = context.run(identity, work);
  } catch (error) {
    pending.delete(identity.id);
    record('throw', identity);
    throw error;
  }
  void promise.then(
    () => {
      pending.delete(identity.id);
      receipt.state = 'fulfilled';
      record('settled', receipt);
    },
    () => {
      pending.delete(identity.id);
      receipt.state = 'rejected';
      record('settled', receipt);
    },
  );
  // Return the exact original Promise. Diagnostic observation does not complete or race it.
  return promise;
}
function location(): string[] {
  const stack = new Error().stack ?? '';
  return productClasses.filter((name) => stack.includes(name));
}
function contents(wc: WebContents): void {
  const wcId = wc.id;
  let epoch = 0;
  let started = 0;
  let stopped = 0;
  const state = () => ({
    wcId,
    epoch,
    started,
    stopped,
    destroyed: wc.isDestroyed(),
    loading: wc.isDestroyed() ? null : wc.isLoadingMainFrame(),
  });
  record('wc-created', { wcId });
  const emit = wc.emit;
  // Observe the existing event dispatch without becoming a product listener.
  // The default smoke independently requires readiness listeners to retire to zero.
  wc.emit = function (this: WebContents, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'did-start-navigation' && args[3] === true && args[2] === false) {
      started++;
      record('wc-navigation-start', state());
    } else if (event === 'did-navigate') {
      epoch++;
      record('wc-commit', state());
    } else if (event === 'did-stop-loading') {
      stopped++;
      record('wc-load-stop', state());
    } else if (event === 'render-process-gone') {
      record('wc-renderer-gone', state());
    } else if (event === 'destroyed') {
      record('wc-destroyed', state());
    }
    return emit.call(this, event, ...args);
  };
  if (!runtimeSourceRecorded) {
    const method = wc.executeJavaScriptInIsolatedWorld.toString();
    if (Buffer.byteLength(method) > 65536) throw new Error('框架方法源码超出诊断预算');
    writeFileSync(
      join(app.getAppPath(), 'shutdown-runtime-source.json'),
      JSON.stringify({ electron: process.versions.electron, method }),
      { flag: 'wx' },
    );
    runtimeSourceRecorded = true;
  }
  const execute = wc.executeJavaScriptInIsolatedWorld.bind(wc);
  wc.executeJavaScriptInIsolatedWorld = (...args) => {
    record('native-dispatch-state', {
      request: context.getStore() ?? null,
      ...state(),
      world: args[0],
      scripts: args[1].length,
    });
    return withPromise('native', { wcId }, () => execute(...args));
  };
}
export function install(classes: {
  PageReader: { prototype: PageReader };
  BrowserControllerImpl: { prototype: BrowserControllerImpl };
  ConversationServiceImpl: { prototype: ConversationServiceImpl };
}): void {
  const reader = classes.PageReader.prototype;
  const snapshot = reader.snapshot;
  reader.snapshot = function (wc, documentId, signal) {
    return withPromise('reader', { wcId: wc.id, documentId }, () => {
      const identity = context.getStore();
      const onAbort = () => record('reader-abort', { identity, destroyed: wc.isDestroyed() });
      signal?.addEventListener('abort', onAbort, { once: true });
      const promise = snapshot.call(this, wc, documentId, signal);
      void promise.then(
        () => signal?.removeEventListener('abort', onAbort),
        () => signal?.removeEventListener('abort', onAbort),
      );
      return promise;
    });
  };
  const browser = classes.BrowserControllerImpl.prototype;
  const getSnapshot = browser.getPageSnapshot;
  browser.getPageSnapshot = function (tabId, signal) {
    return withPromise(
      'controller-snapshot',
      { tabId, wcId: this.getOwnedWebContentsId(tabId) ?? undefined },
      () => getSnapshot.call(this, tabId, signal),
    );
  };
  const close = browser.closeTab;
  browser.closeTab = function (tabId) {
    record('tab-close-call', {
      tabId,
      wcId: this.getOwnedWebContentsId(tabId),
      caller: location(),
    });
    return withPromise('tab-close', { tabId }, () => close.call(this, tabId));
  };
  const dispose = browser.dispose;
  browser.dispose = function () {
    record('controller-dispose', { caller: location() });
    return dispose.call(this);
  };
  const conversation = classes.ConversationServiceImpl.prototype;
  const preview = conversation.previewContext;
  conversation.previewContext = function () {
    return withPromise('preview', {}, () => preview.call(this));
  };
  const drain = conversation.drainBeforeClose;
  conversation.drainBeforeClose = function () {
    record('conversation-drain', { counts: this.getPendingOperationCounts(), caller: location() });
    return withPromise('conversation-drain', {}, () => drain.call(this));
  };
  app.on('web-contents-created', (_event, wc) => contents(wc));
  app.on('before-quit', () => {
    record('before-quit', { pending: [...pending.values()] });
    if (checkpointStarted) return;
    checkpointStarted = true;
    setTimeout(() => {
      const observation = {
        kind: '十秒正常退出观察窗结束',
        pending: [...pending.values()],
        records,
        bytes,
        ms: performance.now(),
      };
      record('shutdown-observation', observation);
      writeFileSync(
        join(app.getAppPath(), 'shutdown-observation.json'),
        JSON.stringify(observation),
        { flag: 'wx' },
      );
    }, 10000).unref();
  });
  process.on('exit', (code) => record('process-exit', { code, pending: [...pending.values()] }));
  record('installed', { electron: process.versions.electron });
}
