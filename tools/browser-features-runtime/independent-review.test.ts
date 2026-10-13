import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createContext, runInContext, Script, type Context } from 'node:vm';
import type { WebContents, WebSource } from 'electron';
import { expect, it } from 'vitest';
import { parseUserScript } from '../../src/main/userscripts/metadata';
import { buildUserScriptExecution, UserScriptRuntime } from '../../src/main/userscripts/runtime';
import type { StoredUserScript } from '../../src/main/userscripts/store';

function entry(): StoredUserScript {
  const source =
    '// ==UserScript==\n// @name 独审导航竞态\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\ndocument.title = "executed";';
  const parsed = parseUserScript(source);
  if (!parsed.ok) throw new Error(parsed.message);
  return {
    source,
    summary: {
      ...parsed.value,
      id: randomUUID(),
      enabled: true,
      installedAt: new Date().toISOString(),
      sourceBytes: Buffer.byteLength(source),
    },
  };
}

class DelayedContents extends EventEmitter {
  readonly url = 'https://example.com/same-url';
  document = { readyState: 'complete', title: '' };
  calls = 0;
  pending: (() => void) | undefined;
  readonly worlds = new Map<number, Context>();

  isDestroyed(): boolean {
    return false;
  }
  isLoadingMainFrame(): boolean {
    return false;
  }
  getURL(): string {
    return this.url;
  }

  replaceDocument(): void {
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    this.document = { readyState: 'complete', title: '' };
    this.worlds.clear();
  }

  executeJavaScriptInIsolatedWorld(world: number, sources: WebSource[]): Promise<unknown> {
    this.calls += 1;
    const execute = (): unknown => {
      let context = this.worlds.get(world);
      if (context === undefined) {
        context = createContext({ document: this.document, location: { href: this.url } });
        runInContext('window = globalThis; window.top = window;', context);
        this.worlds.set(world, context);
      }
      return runInContext(sources[0].code, context, { timeout: 100 });
    };
    if (this.calls === 1)
      return new Promise((resolve) => {
        this.pending = () => resolve(execute());
      });
    return Promise.resolve(execute());
  }
}

it('旧文档延迟准备不得占用新同URL文档的脚本执行机会', async () => {
  const contents = new DelayedContents();
  const script = entry();
  const runtime = new UserScriptRuntime({ getEnabledScripts: () => [script] });
  runtime.attach(contents as unknown as WebContents);
  try {
    contents.emit('did-finish-load');
    expect(contents.calls).toBe(1);
    contents.replaceDocument();
    contents.pending?.();
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    expect(contents.document.title).toBe('');
    contents.emit('did-finish-load');
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    expect(contents.document.title).toBe('executed');
  } finally {
    runtime.dispose();
  }
});

it.each(['const GM = {};', 'let GM_info = {};', 'const GM_addStyle = () => {};'])(
  '导入接受的JavaScript必须可在实际隔离执行包装中编译：%s',
  (declaration) => {
    const candidate = entry();
    candidate.source += `\n${declaration}`;
    const parsed = parseUserScript(candidate.source);
    if (!parsed.ok) {
      expect(['invalid-input', 'unsupported']).toContain(parsed.code);
      return;
    }
    candidate.summary = { ...candidate.summary, ...parsed.value };
    expect(
      () => new Script(buildUserScriptExecution(candidate, randomUUID(), 'https://example.com/')),
    ).not.toThrow();
  },
);
