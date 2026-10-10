import { createContext, runInContext, type Context } from 'node:vm';
import { webcrypto } from 'node:crypto';
import type { WebContents, WebSource } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { PageReader } from './page-reader';

vi.mock('../logger', () => ({ logDebug: vi.fn(), logWarn: vi.fn() }));
vi.mock('./snapshot-script', () => ({
  SNAPSHOT_SCRIPT_SOURCE: `({
    ok: true, url: location.href, title: '', readyState: 'complete',
    viewport: { scrollX: 0, scrollY: 0, width: 1024, height: 768 },
    selection: '', visibleText: '', headings: [], links: [], buttons: [], inputs: [], tables: [],
    iframes: { total: 0, crossOrigin: 0 }, truncated: []
  })`,
}));

class Input {
  readonly tagName = 'INPUT';
  readonly offsetParent = {};
  readonly disabled = false;
  readonly readOnly = false;
  private stored = '';
  clicked = 0;
  events: string[] = [];

  get value(): string {
    return this.stored;
  }
  set value(value: string) {
    this.stored = value;
  }
  getAttribute(name: string): string | null {
    return name === 'type' ? 'checkbox' : name === 'data-aibrowse-el' ? '1' : null;
  }
  getClientRects(): object[] {
    return [{}];
  }
  click(): void {
    this.clicked += 1;
  }
  dispatchEvent(event: { type: string }): void {
    this.events.push(event.type);
  }
}

class DocumentFixture {
  readonly input = new Input();
  readonly mainWorld: Context;
  readonly worlds = new Map<number, Context>();

  constructor(readonly url: string) {
    this.mainWorld = this.createWorld();
  }

  private createWorld(): Context {
    const globals: Record<string, unknown> = {
      document: { querySelector: () => this.input },
      location: { href: this.url },
      HTMLInputElement: Input,
      HTMLTextAreaElement: class {},
      Event: class {
        constructor(readonly type: string) {}
      },
      crypto: webcrypto,
    };
    globals['window'] = globals;
    return createContext(globals);
  }

  world(id: number): Context {
    let world = this.worlds.get(id);
    if (world === undefined) {
      world = this.createWorld();
      this.worlds.set(id, world);
    }
    return world;
  }
}

class ContentsFixture {
  document = new DocumentFixture('https://example.test/old');
  gate: Promise<void> = Promise.resolve();
  private release: (() => void) | undefined;
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }
  isCrashed(): boolean {
    return false;
  }
  isLoadingMainFrame(): boolean {
    return false;
  }
  getURL(): string {
    return this.document.url;
  }
  getTitle(): string {
    return '';
  }
  holdInjection(): void {
    this.gate = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }
  commit(url: string): void {
    this.document = new DocumentFixture(url);
    this.release?.();
  }
  executeJavaScript = vi.fn(async (source: string): Promise<unknown> => {
    await this.gate;
    return runInContext(source, this.document.mainWorld) as unknown;
  });
  executeJavaScriptInIsolatedWorld = vi.fn(
    async (worldId: number, scripts: WebSource[], userGesture?: boolean): Promise<unknown> => {
      expect(worldId).toBe(1001);
      expect(userGesture).toBe(false);
      await this.gate;
      let result: unknown;
      for (const script of scripts) {
        result = runInContext(script.code, this.document.world(worldId)) as unknown;
      }
      return result;
    },
  );
  asWebContents(): WebContents {
    return this as unknown as WebContents;
  }
}

describe('PageReader 执行时文档绑定', () => {
  it.each([
    ['click', 'https://example.test/new'],
    ['fill', 'https://example.test/new'],
    ['click', 'https://example.test/old'],
    ['fill', 'https://example.test/old'],
  ] as const)('%s 等待后落到 %s 的新文档，执行前拒绝且同编号元素未改变', async (action, url) => {
    const reader = new PageReader();
    const contents = new ContentsFixture();
    const wc = contents.asWebContents();
    reader.acceptSnapshot(wc, await reader.snapshot(wc, 4));
    const previous = contents.document;
    contents.holdInjection();
    const operation =
      action === 'click'
        ? reader.click(wc, 'el-1', 'toggle', 4)
        : reader.fill(wc, 'el-1', '合成测试值', 4);
    contents.commit(url);
    expect(await operation).toMatchObject({ ok: false, errorCode: 'stale-element' });
    expect(contents.document.input.value).toBe('');
    expect(contents.document.input.clicked).toBe(0);
    expect(contents.document.input.events).toEqual([]);
    expect(previous.input.value).toBe('');
    expect(previous.input.clicked).toBe(0);
  });

  it('同一文档已采集后 click/fill 保持动作、原生 setter 和事件语义', async () => {
    const reader = new PageReader();
    const contents = new ContentsFixture();
    const wc = contents.asWebContents();
    const collected = await reader.snapshot(wc, 4);
    expect(collected.snapshot).toMatchObject({ meta: { degraded: 'none' } });
    reader.acceptSnapshot(wc, collected);
    expect(await reader.click(wc, 'el-1', 'toggle', 4)).toMatchObject({ ok: true });
    expect(await reader.fill(wc, 'el-1', '合法值', 4)).toMatchObject({ ok: true });
    expect(contents.document.input.clicked).toBe(1);
    expect(contents.document.input.value).toBe('合法值');
    expect(contents.document.input.events).toEqual(['input', 'change']);
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
  });

  it('没有采集绑定或主进程绑定不匹配时不执行交互', async () => {
    const reader = new PageReader();
    const contents = new ContentsFixture();
    const wc = contents.asWebContents();
    expect(await reader.fill(wc, 'el-1', '值', 4)).toMatchObject({
      ok: false,
      errorCode: 'stale-element',
    });
    reader.acceptSnapshot(wc, await reader.snapshot(wc, 5));
    expect(await reader.click(wc, 'el-1', 'toggle', 4)).toMatchObject({
      ok: false,
      errorCode: 'stale-element',
    });
    expect(contents.document.input.value).toBe('');
    expect(contents.document.input.clicked).toBe(0);
  });

  it.each(['click', 'fill'] as const)(
    '旧快照与旧 %s 一起延迟到新文档，新快照不能重建旧授权',
    async (action) => {
      const reader = new PageReader();
      const contents = new ContentsFixture();
      const wc = contents.asWebContents();
      const original = await reader.snapshot(wc, 4);
      reader.acceptSnapshot(wc, original);
      contents.holdInjection();
      const crossedSnapshot = reader.snapshot(wc, 4);
      const operation =
        action === 'click'
          ? reader.click(wc, 'el-1', 'toggle', 4)
          : reader.fill(wc, 'el-1', '旧授权值', 4);
      contents.commit('https://example.test/new');
      const crossed = await crossedSnapshot;
      expect(crossed.token).not.toBe(original.token);
      expect(await operation).toMatchObject({ ok: false, errorCode: 'stale-element' });
      expect(contents.document.input.clicked).toBe(0);
      expect(contents.document.input.value).toBe('');
      // Only the controller's stable-generation path may accept the fresh capture.
      const current = await reader.snapshot(wc, 5);
      reader.acceptSnapshot(wc, current);
      expect(await reader.fill(wc, 'el-1', '新授权值', 5)).toMatchObject({ ok: true });
      expect(contents.document.input.value).toBe('新授权值');
    },
  );

  it('并发同文档快照复用私有 token，且 token 不进入 PageSnapshot', async () => {
    const reader = new PageReader();
    const contents = new ContentsFixture();
    const wc = contents.asWebContents();
    const [first, second] = await Promise.all([reader.snapshot(wc, 4), reader.snapshot(wc, 4)]);
    expect(first.token).toMatch(/^[0-9a-f]{32}$/);
    expect(first.token).toBe(second.token);
    reader.acceptSnapshot(wc, second);
    reader.acceptSnapshot(wc, first);
    expect(await reader.fill(wc, 'el-1', '合法值', 4)).toMatchObject({ ok: true });
    expect(JSON.stringify(first.snapshot)).not.toContain(first.token);
    expect(JSON.stringify(first.snapshot)).not.toContain('token');
  });

  it('页面预置同名 window 属性及同编号 DOM 不能复制隔离 world 绑定', async () => {
    const reader = new PageReader();
    const contents = new ContentsFixture();
    const wc = contents.asWebContents();
    const old = await reader.snapshot(wc, 4);
    reader.acceptSnapshot(wc, old);
    contents.commit('https://example.test/spoof');
    // Even a guessed real token in page world cannot populate isolated state.
    contents.document.mainWorld['__aibrowseDocumentBinding'] = {
      document: contents.document.mainWorld['document'],
      token: old.token,
      active: true,
    };
    expect(await reader.fill(wc, 'el-1', '不得填写', 4)).toMatchObject({
      ok: false,
      errorCode: 'stale-element',
    });
    expect(contents.document.input.value).toBe('');
    const current = await reader.snapshot(wc, 5);
    expect(current.token).not.toBe(old.token);
    reader.acceptSnapshot(wc, current);
    expect(await reader.click(wc, 'el-1', 'toggle', 5)).toMatchObject({ ok: true });
  });

  it('Document 对象被替换但隔离 world 未重建时也拒绝旧绑定', async () => {
    const reader = new PageReader();
    const contents = new ContentsFixture();
    const wc = contents.asWebContents();
    reader.acceptSnapshot(wc, await reader.snapshot(wc, 4));
    for (const world of contents.document.worlds.values()) {
      world['document'] = { querySelector: () => contents.document.input };
    }
    expect(await reader.fill(wc, 'el-1', '旧值', 4)).toMatchObject({
      ok: false,
      errorCode: 'stale-element',
    });
    expect(contents.document.input.value).toBe('');
  });

  it('没有有效私有 token 的采集结果按 L2 降级且不能建立交互授权', async () => {
    const reader = new PageReader();
    const contents = new ContentsFixture();
    const wc = contents.asWebContents();
    contents.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({
      token: '网页伪造的无效绑定',
      snapshot: { ok: true, url: contents.getURL(), title: '不能采信' },
    });
    const collected = await reader.snapshot(wc, 4);
    expect(collected).toMatchObject({
      token: null,
      snapshot: { meta: { degraded: 'main-process-only' } },
    });
    reader.acceptSnapshot(wc, collected);
    expect(await reader.fill(wc, 'el-1', '不得填写', 4)).toMatchObject({
      ok: false,
      errorCode: 'stale-element',
    });
    expect(contents.document.input.value).toBe('');
  });
});
