/// <reference lib="dom" />

import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { USER_SCRIPT_LIMITS } from '../../shared/userscripts';
import type { UserScriptSummary } from '../../shared/types/userscripts';
import { buildUserScriptBody, matchesUserScript } from './metadata';
import type { StoredUserScript } from './store';

type ScriptContents = Pick<
  WebContents,
  | 'on'
  | 'removeListener'
  | 'isDestroyed'
  | 'getURL'
  | 'isLoadingMainFrame'
  | 'executeJavaScriptInIsolatedWorld'
>;
interface ScriptSource {
  getEnabledScripts(): StoredUserScript[];
}
interface DocumentBinding {
  document: Document;
  token: string;
  ran: boolean;
  epoch: number;
}

function prepareDocument(token: string, expectedUrl: string, epoch: number): boolean {
  if (window !== window.top || location.href !== expectedUrl || document.readyState !== 'complete')
    return false;
  const isolated = globalThis as typeof globalThis & {
    __aibrowseUserScriptDocument?: DocumentBinding;
  };
  const previous = isolated.__aibrowseUserScriptDocument;
  if (previous?.document === document) {
    if (previous.ran || previous.epoch >= epoch) return false;
    // A cancelled native preparation can arrive in a later same-URL document.
    // Only a newer epoch may replace its unused binding; late old calls cannot
    // overwrite a current batch, and completed scripts can never be restarted.
    previous.token = token;
    previous.epoch = epoch;
    return true;
  }
  Object.defineProperty(isolated, '__aibrowseUserScriptDocument', {
    value: { document, token, ran: false, epoch },
    configurable: false,
    writable: false,
  });
  return true;
}

// This function is stringified into an unprivileged isolated world, never run in main.
function executeInDocument(
  token: string,
  expectedUrl: string,
  summary: UserScriptSummary,
  execute: (
    GM_info: object,
    GM: object,
    GM_addStyle: ((css: string) => HTMLStyleElement) | undefined,
  ) => void,
): string {
  const binding = (
    globalThis as typeof globalThis & { __aibrowseUserScriptDocument?: DocumentBinding }
  ).__aibrowseUserScriptDocument;
  if (
    window !== window.top ||
    location.href !== expectedUrl ||
    document.readyState !== 'complete' ||
    binding === undefined ||
    binding.document !== document ||
    binding.token !== token ||
    binding.ran
  )
    return 'stale';
  binding.ran = true;
  const info = Object.freeze({
    script: Object.freeze({
      name: summary.name,
      namespace: summary.namespace,
      version: summary.version,
      description: summary.description,
      matches: Object.freeze([...summary.matches]),
      includes: Object.freeze([...summary.includes]),
      excludes: Object.freeze([...summary.excludes, ...summary.excludeGlobs]),
      resources: Object.freeze({}),
      'run-at': 'document-idle',
    }),
    scriptHandler: 'AIbrowse',
    version: '1',
    scriptWillUpdate: false,
    injectInto: 'isolated',
  });
  const addStyle = (css: string): HTMLStyleElement => {
    if (typeof css !== 'string' || css.length > 256 * 1024)
      throw new Error('样式必须是最多 256 KiB 的字符串。');
    const style = document.createElement('style');
    style.textContent = css;
    (document.head ?? document.documentElement).appendChild(style);
    return style;
  };
  const gm = Object.freeze({
    info,
    ...(summary.grants.includes('GM.addStyle') ? { addStyle } : {}),
  });
  try {
    execute(info, gm, summary.grants.includes('GM_addStyle') ? addStyle : undefined);
    return 'executed';
  } catch {
    return 'failed';
  }
}

export function buildUserScriptPrepare(token: string, url: string, epoch: number): string {
  return `(${prepareDocument.toString()})(${JSON.stringify(token)}, ${JSON.stringify(url)}, ${epoch})`;
}

export function buildUserScriptExecution(
  script: StoredUserScript,
  token: string,
  url: string,
): string {
  // The standalone script parser has already rejected unmatched braces/comments.
  // Its return value is discarded; only the fixed execution status crosses back.
  return `(${executeInDocument.toString()})(${JSON.stringify(token)}, ${JSON.stringify(url)}, ${JSON.stringify(script.summary)}, ${buildUserScriptBody(script.source)})`;
}

export class UserScriptRuntime {
  private readonly attachments = new Map<ScriptContents, () => void>();
  private disposed = false;

  constructor(private readonly scripts: ScriptSource) {}

  attach(contents: ScriptContents): () => void {
    if (this.disposed || contents.isDestroyed()) return () => undefined;
    const existing = this.attachments.get(contents);
    if (existing !== undefined) return existing;
    let disposed = false;
    let epoch = 0;
    let finishedEpoch = -1;
    let loadFinishedEpoch = -1;
    const cancelPending = new Set<() => void>();
    const onNavigation = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ): void => {
      if (event.isMainFrame && !event.isSameDocument) {
        epoch += 1;
        for (const cancel of [...cancelPending]) cancel();
      }
    };
    const onRetired = (): void => {
      epoch += 1;
      for (const cancel of [...cancelPending]) cancel();
    };
    const active = (expectedEpoch: number, url: string): boolean =>
      !disposed &&
      !this.disposed &&
      !contents.isDestroyed() &&
      epoch === expectedEpoch &&
      !contents.isLoadingMainFrame() &&
      contents.getURL() === url;
    const inject = (world: number, code: string): Promise<unknown> =>
      new Promise((resolve) => {
        let finished = false;
        const finish = (value: unknown): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          cancelPending.delete(cancel);
          resolve(value);
        };
        const cancel = (): void => finish(null);
        const timer = setTimeout(cancel, 2000);
        cancelPending.add(cancel);
        try {
          // Observe the native promise even after timeout/retirement; no unhandled rejection.
          void contents
            .executeJavaScriptInIsolatedWorld(world, [{ code }], false)
            .then(finish, cancel);
        } catch {
          cancel();
        }
      });
    const run = async (expectedEpoch: number, url: string): Promise<void> => {
      // A document gets exactly one immutable batch. Deleted/reinstalled scripts
      // never inherit a live world's globals; slots are reused only after navigation,
      // when Chromium creates fresh worlds. The binding also rejects reused documents.
      const batch = this.scripts.getEnabledScripts().slice(0, USER_SCRIPT_LIMITS.count);
      for (const [slot, script] of batch.entries()) {
        if (!active(expectedEpoch, url)) return;
        if (!matchesUserScript(script.summary, url)) continue;
        const world = USER_SCRIPT_LIMITS.worldFirst + slot;
        const token = randomUUID();
        const prepared = await inject(world, buildUserScriptPrepare(token, url, expectedEpoch));
        if (prepared !== true || !active(expectedEpoch, url)) continue;
        if (
          !this.scripts
            .getEnabledScripts()
            .some(
              (current) =>
                current.summary.id === script.summary.id && current.source === script.source,
            )
        )
          continue;
        // The second native call cannot execute in a later same-URL document: the
        // first call's world-local document/token binding must still be present.
        await inject(world, buildUserScriptExecution(script, token, url));
      }
    };
    const onStopped = (): void => {
      if (
        disposed ||
        contents.isDestroyed() ||
        loadFinishedEpoch !== epoch ||
        contents.isLoadingMainFrame() ||
        finishedEpoch === epoch
      )
        return;
      finishedEpoch = epoch;
      const url = contents.getURL();
      if (!/^https?:\/\//u.test(url)) return;
      void run(epoch, url).catch(() => undefined);
    };
    const onFinished = (): void => {
      // Electron may emit did-finish-load before clearing isLoadingMainFrame().
      // Record completion now, but claim the batch only once loading has stopped.
      // Requiring both facts also excludes stop events from failed/subframe loads.
      loadFinishedEpoch = epoch;
      onStopped();
    };
    const cleanup = (): void => {
      if (disposed) return;
      disposed = true;
      onRetired();
      contents.removeListener('did-start-navigation', onNavigation);
      contents.removeListener('did-finish-load', onFinished);
      contents.removeListener('did-stop-loading', onStopped);
      contents.removeListener('render-process-gone', onRetired);
      contents.removeListener('destroyed', cleanup);
      this.attachments.delete(contents);
    };
    contents.on('did-start-navigation', onNavigation);
    contents.on('did-finish-load', onFinished);
    contents.on('did-stop-loading', onStopped);
    contents.on('render-process-gone', onRetired);
    contents.on('destroyed', cleanup);
    this.attachments.set(contents, cleanup);
    return cleanup;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of [...this.attachments.values()]) cleanup();
  }
}
