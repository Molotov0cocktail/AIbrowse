import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createContext, runInContext, type Context } from 'node:vm';
import type { WebContents, WebSource } from 'electron';
import { describe, expect, it } from 'vitest';
import { parseUserScript } from './metadata';
import { UserScriptRuntime } from './runtime';
import type { StoredUserScript } from './store';

function script(body: string, grants = 'none'): StoredUserScript {
  const source = `// ==UserScript==\n// @name 隔离脚本\n// @match https://example.com/*\n// @grant ${grants}\n// ==/UserScript==\n${body}`;
  const metadata = parseUserScript(source);
  if (!metadata.ok) throw new Error(metadata.message);
  return {
    source,
    summary: {
      ...metadata.value,
      id: randomUUID(),
      installedAt: new Date().toISOString(),
      sourceBytes: Buffer.byteLength(source),
      enabled: true,
    },
  };
}

class Contents extends EventEmitter {
  url = 'https://example.com/page';
  destroyed = false;
  loading = false;
  calls: Array<{ world: number; code: string; gesture: boolean | undefined }> = [];
  results: unknown[] = [];
  queued: Array<() => void> = [];
  holdCall = 0;
  document = this.makeDocument();
  worlds = new Map<number, Context>();
  isDestroyed(): boolean {
    return this.destroyed;
  }
  isLoadingMainFrame(): boolean {
    return this.loading;
  }
  getURL(): string {
    return this.url;
  }
  asContents(): WebContents {
    return this as unknown as WebContents;
  }
  private makeDocument() {
    const styles: Array<{ textContent: string }> = [];
    return {
      title: '',
      readyState: 'complete',
      styles,
      head: {
        appendChild(style: { textContent: string }) {
          styles.push(style);
        },
      },
      createElement: () => ({ textContent: '' }),
    };
  }
  newDocument(url = this.url): void {
    this.loading = true;
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    this.url = url;
    this.document = this.makeDocument();
    this.worlds.clear();
    this.loading = false;
  }
  executeJavaScriptInIsolatedWorld(
    world: number,
    sources: WebSource[],
    gesture?: boolean,
  ): Promise<unknown> {
    const code = sources[0].code;
    this.calls.push({ world, code, gesture });
    const execute = (): unknown => {
      let context = this.worlds.get(world);
      if (context === undefined) {
        context = createContext({ document: this.document, location: { href: this.url } });
        runInContext('window=globalThis;window.top=window;', context);
        this.worlds.set(world, context);
      }
      const result: unknown = runInContext(code, context, { timeout: 100 });
      this.results.push(result);
      return result;
    };
    if (this.calls.length === this.holdCall)
      return new Promise((resolve, reject) =>
        this.queued.push(() => {
          try {
            resolve(execute());
          } catch (error) {
            reject(error);
          }
        }),
      );
    try {
      return Promise.resolve(execute());
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('用户脚本双门注入与生命周期', () => {
  it('真实原生时序finish仍loading时不锁批次，stop后恰好执行一次', async () => {
    const contents = new Contents();
    const entry = script('document.title += "已执行";');
    const runtime = new UserScriptRuntime({ getEnabledScripts: () => [entry] });
    runtime.attach(contents.asContents());
    try {
      contents.loading = true;
      contents.emit('did-finish-load');
      await settle();
      expect(contents.calls).toEqual([]);
      contents.loading = false;
      contents.emit('did-stop-loading');
      await settle();
      expect(contents.document.title).toBe('已执行');
      expect(contents.calls).toHaveLength(2);
      contents.emit('did-stop-loading');
      contents.emit('did-finish-load');
      contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
      contents.emit('did-stop-loading');
      await settle();
      expect(contents.document.title).toBe('已执行');
      expect(contents.calls).toHaveLength(2);
    } finally {
      runtime.dispose();
    }
  });
  it('停止加载本身不授权失败页面，跨导航的旧finish不授权新文档', async () => {
    const contents = new Contents();
    const entry = script('document.title += "新文档";');
    const runtime = new UserScriptRuntime({ getEnabledScripts: () => [entry] });
    runtime.attach(contents.asContents());
    try {
      contents.emit('did-stop-loading');
      await settle();
      expect(contents.calls).toEqual([]);
      contents.loading = true;
      contents.emit('did-finish-load');
      contents.newDocument();
      contents.emit('did-stop-loading');
      await settle();
      expect(contents.calls).toEqual([]);
      contents.loading = true;
      contents.emit('did-finish-load');
      contents.loading = false;
      contents.emit('did-stop-loading');
      await settle();
      expect(contents.document.title).toBe('新文档');
      expect(contents.calls).toHaveLength(2);
    } finally {
      runtime.dispose();
    }
  });
  it('用户局部GM声明不会与API包装冲突，严格模式指令仍有效', async () => {
    const contents = new Contents();
    const entry = script(
      '"use strict"; const GM = { name: "用户值" }; let GM_info = 1; const GM_addStyle = 2; document.title = [GM.name, GM_info, GM_addStyle, (function(){return this;})() === undefined].join("/");',
    );
    const runtime = new UserScriptRuntime({ getEnabledScripts: () => [entry] });
    runtime.attach(contents.asContents());
    contents.emit('did-finish-load');
    await settle();
    expect(contents.document.title).toBe('用户值/1/2/true');
    runtime.dispose();
  });
  it('每文档一次、隔离世界无Node能力、GM样式仅作用DOM', async () => {
    const contents = new Contents();
    const entry = script(
      'document.title = [typeof process,typeof require,typeof ipcRenderer,GM_info.scriptHandler].join("/"); GM_addStyle("body { color: red }"); globalThis.privateScriptValue = 1;',
      'GM_addStyle',
    );
    const runtime = new UserScriptRuntime({ getEnabledScripts: () => [entry] });
    runtime.attach(contents.asContents());
    contents.emit('did-finish-load');
    await settle();
    expect(contents.document.title).toBe('undefined/undefined/undefined/AIbrowse');
    expect(contents.document.styles).toEqual([{ textContent: 'body { color: red }' }]);
    expect(contents.calls).toHaveLength(2);
    expect(contents.calls.every((call) => call.world === 2000 && call.gesture === false)).toBe(
      true,
    );
    contents.emit('did-finish-load');
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    contents.emit('did-finish-load');
    await settle();
    expect(contents.calls).toHaveLength(2);
    contents.newDocument();
    contents.emit('did-finish-load');
    await settle();
    expect(contents.calls).toHaveLength(4);
    runtime.dispose();
    expect(contents.eventNames()).toEqual([]);
  });
  it('不同脚本各用独立world，无跨脚本JS全局污染', async () => {
    const contents = new Contents();
    const entries = [
      script('globalThis.privateValue=7;'),
      script('document.title = typeof privateValue;'),
    ];
    const runtime = new UserScriptRuntime({ getEnabledScripts: () => entries });
    runtime.attach(contents.asContents());
    contents.emit('did-finish-load');
    await settle();
    expect(contents.document.title).toBe('undefined');
    expect(contents.calls.map((call) => call.world)).toEqual([2000, 2000, 2001, 2001]);
    runtime.dispose();
  });
  it('准备绑定等待期间发生同URL刷新，不执行旧批次', async () => {
    const contents = new Contents();
    contents.holdCall = 1;
    const runtime = new UserScriptRuntime({
      getEnabledScripts: () => [script('document.title = "不应运行";')],
    });
    runtime.attach(contents.asContents());
    contents.emit('did-finish-load');
    contents.newDocument();
    contents.queued.shift()?.();
    await settle();
    expect(contents.document.title).toBe('');
    expect(contents.calls).toHaveLength(1);
    runtime.dispose();
  });
  it('执行请求已排队后同URL刷新，world内文档门阻止旧脚本', async () => {
    const contents = new Contents();
    contents.holdCall = 2;
    const entry = script('document.title = "不应运行";');
    const runtime = new UserScriptRuntime({ getEnabledScripts: () => [entry] });
    runtime.attach(contents.asContents());
    contents.emit('did-finish-load');
    await settle();
    expect(contents.calls).toHaveLength(2);
    contents.newDocument();
    contents.queued.shift()?.();
    await settle();
    expect(contents.document.title).toBe('');
    runtime.dispose();
  });

  it('旧准备先到可被新文档接管，旧准备迟到也不得覆盖新token', async () => {
    for (const oldFirst of [true, false]) {
      const contents = new Contents();
      contents.holdCall = 1;
      const entry = script('document.title = "新文档已执行";');
      const runtime = new UserScriptRuntime({ getEnabledScripts: () => [entry] });
      runtime.attach(contents.asContents());
      contents.emit('did-finish-load');
      contents.newDocument();
      if (oldFirst) contents.queued.shift()?.();
      contents.emit('did-finish-load');
      if (!oldFirst) contents.queued.shift()?.();
      await settle();
      expect(contents.document.title).toBe('新文档已执行');
      expect(contents.calls).toHaveLength(3);
      runtime.dispose();
    }
  });
  it('准备期间被禁用则拒绝执行；删除重装须新文档，复用槽没有旧全局', async () => {
    const contents = new Contents();
    contents.holdCall = 1;
    let enabled = [script('globalThis.oldSecret=7;document.title="旧";')];
    const runtime = new UserScriptRuntime({ getEnabledScripts: () => enabled });
    runtime.attach(contents.asContents());
    contents.emit('did-finish-load');
    enabled = [];
    contents.queued.shift()?.();
    await settle();
    expect(contents.calls).toHaveLength(1);
    enabled = [script('document.title=typeof oldSecret;')];
    contents.emit('did-finish-load');
    await settle();
    expect(contents.calls).toHaveLength(1);
    contents.newDocument();
    contents.emit('did-finish-load');
    await settle();
    expect(contents.document.title).toBe('undefined');
    runtime.dispose();
  });
  it.each([
    'about:blank',
    'file:///private',
    'app://ui/index.html',
    'data:text/html,test',
    'chrome-extension://id/page',
    'https://unmatched.example/',
  ])('不在内部或未匹配页面执行：%s', async (url) => {
    const contents = new Contents();
    contents.url = url;
    const runtime = new UserScriptRuntime({
      getEnabledScripts: () => [script('document.title="不应运行";')],
    });
    runtime.attach(contents.asContents());
    contents.emit('did-finish-load');
    await settle();
    expect(contents.calls).toEqual([]);
    runtime.dispose();
  });
  it('销毁时释放监听器，已排队原生请求仍受文档门与dispose复验约束', async () => {
    const contents = new Contents();
    contents.holdCall = 1;
    const runtime = new UserScriptRuntime({
      getEnabledScripts: () => [script('document.title="不应运行";')],
    });
    const cleanup = runtime.attach(contents.asContents());
    expect(runtime.attach(contents.asContents())).toBe(cleanup);
    contents.emit('did-finish-load');
    contents.destroyed = true;
    contents.emit('destroyed');
    contents.queued.shift()?.();
    await settle();
    expect(contents.calls).toHaveLength(1);
    expect(contents.eventNames()).toEqual([]);
    cleanup();
    runtime.dispose();
  });
  it('脚本抛出敏感异常或返回对象时，主进程只接收固定状态', async () => {
    const contents = new Contents();
    const entry = script('throw new Error("private-page-content");');
    const runtime = new UserScriptRuntime({ getEnabledScripts: () => [entry] });
    runtime.attach(contents.asContents());
    contents.emit('did-finish-load');
    await settle();
    expect(contents.calls).toHaveLength(2);
    expect(contents.results).toEqual([true, 'failed']);
    runtime.dispose();
  });
});
