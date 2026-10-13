import { EventEmitter } from 'node:events';
import type { IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QualifiedScriptId, ScriptValue } from '../../shared/types/qualified-userscripts';
import { QUALIFIED_SCRIPT_CATALOG } from './catalog';
import type { QualifiedScriptResponse } from './network';
import { matchesQualifiedScript, QualifiedScriptRuntime } from './runtime';

class TestFrame {
  constructor(public url: string) {}

  asFrame(): WebFrameMain {
    return this as unknown as WebFrameMain;
  }
}

let nextContentsId = 1;

class TestContents extends EventEmitter {
  readonly id = nextContentsId++;
  destroyed = false;
  mainFrame: WebFrameMain;
  readonly sent: Array<{ channel: string; value: Record<string, unknown> }> = [];

  constructor(url: string) {
    super();
    this.mainFrame = new TestFrame(url).asFrame();
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, value: Record<string, unknown>): void {
    this.sent.push({ channel, value });
  }

  asContents(): WebContents {
    return this as unknown as WebContents;
  }

  event(
    frame: WebFrameMain | null = this.mainFrame,
  ): Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'> {
    return { sender: this.asContents(), senderFrame: frame };
  }

  navigate(url = this.mainFrame.url): void {
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    this.mainFrame = new TestFrame(url).asFrame();
  }

  sameDocumentNavigation(): void {
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  }

  destroyContents(): void {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

class TestStore {
  readonly enabled = new Set<QualifiedScriptId>();
  readonly values = new Map<QualifiedScriptId, Record<string, ScriptValue>>();

  constructor(ids: QualifiedScriptId[] = ['ac-baidu', 'github-zh']) {
    for (const id of ids) {
      this.enabled.add(id);
      this.values.set(id, {});
    }
  }

  getEnabled() {
    return [...this.enabled].map((id) => ({
      entry: QUALIFIED_SCRIPT_CATALOG[id],
      source: `source:${id}`,
      requires: [`require:${id}`],
      resources: { resource: `resource:${id}` },
      values: { ...this.values.get(id)! },
    }));
  }

  list() {
    return (Object.keys(QUALIFIED_SCRIPT_CATALOG) as QualifiedScriptId[]).map((id) => ({
      id,
      name: QUALIFIED_SCRIPT_CATALOG[id].name,
      version: QUALIFIED_SCRIPT_CATALOG[id].version,
      installed: this.enabled.has(id),
      enabled: this.enabled.has(id),
      issue: null,
    }));
  }

  getValues(id: QualifiedScriptId): Record<string, ScriptValue> {
    return { ...(this.values.get(id) ?? {}) };
  }

  setValue(id: QualifiedScriptId, key: string, value: ScriptValue) {
    if (!this.enabled.has(id)) return { ok: false as const, message: '脚本未启用。' };
    this.values.set(id, { ...(this.values.get(id) ?? {}), [key]: value });
    return { ok: true as const };
  }
}

interface PendingNetwork {
  signal: AbortSignal | undefined;
  resolve(value: QualifiedScriptResponse): void;
  reject(error: unknown): void;
}

function response(responseText = ''): QualifiedScriptResponse {
  return {
    status: 200,
    statusText: 'OK',
    finalUrl: 'https://example.com/a',
    responseText,
    responseHeaders: '',
  };
}

function setup(ids: QualifiedScriptId[] = ['ac-baidu', 'github-zh']) {
  const store = new TestStore(ids);
  const pending: PendingNetwork[] = [];
  const network = {
    request: vi.fn(
      (_input: unknown, signal?: AbortSignal) =>
        new Promise<QualifiedScriptResponse>((resolve, reject) =>
          pending.push({ signal, resolve, reject }),
        ),
    ),
  };
  let open = true;
  const active = new Set<number>();
  const openUserTab = vi.fn();
  const notify = vi.fn();
  const runtime = new QualifiedScriptRuntime({
    store,
    network,
    isOpen: () => open,
    isActiveUserTab: (id) => active.has(id),
    openUserTab,
    notify,
  });
  return {
    runtime,
    store,
    network,
    pending,
    active,
    openUserTab,
    notify,
    close: () => {
      open = false;
    },
  };
}

function attachAndPrepare(
  setupValue: ReturnType<typeof setup>,
  url: string,
): { contents: TestContents; token: string; id: QualifiedScriptId } {
  const contents = new TestContents(url);
  setupValue.runtime.attach(contents.asContents());
  const prepared = setupValue.runtime.prepare(contents.event(), undefined);
  expect(prepared).toHaveLength(1);
  return { contents, token: prepared[0]!.token, id: prepared[0]!.id };
}

function sync(
  runtime: QualifiedScriptRuntime,
  contents: TestContents,
  payload: Record<string, unknown>,
): { ok: boolean; message?: string } {
  return runtime.sync(contents.event(), payload) as { ok: boolean; message?: string };
}

function menuEvents(contents: TestContents): Array<Record<string, unknown>> {
  return contents.sent.filter((item) => item.value.kind === 'menu').map((item) => item.value);
}

beforeEach(() => {
  nextContentsId = 1;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('prepare admission and catalog matching', () => {
  it('rejects unattached contents, child frames, payloads and closed runtime', () => {
    const h = setup(['ac-baidu']);
    const contents = new TestContents('https://www.baidu.com/s?wd=test');
    expect(h.runtime.prepare(contents.event(), undefined)).toEqual([]);
    h.runtime.attach(contents.asContents());
    const child = new TestFrame(contents.mainFrame.url).asFrame();
    expect(h.runtime.prepare(contents.event(child), undefined)).toEqual([]);
    expect(h.runtime.prepare(contents.event(), {})).toEqual([]);
    h.close();
    expect(h.runtime.prepare(contents.event(), undefined)).toEqual([]);
  });

  it('prepares one matching user document with main-owned bytes and a fresh token', () => {
    const h = setup(['ac-baidu']);
    const contents = new TestContents('https://www.baidu.com/s?wd=test');
    h.runtime.attach(contents.asContents());
    const prepared = h.runtime.prepare(contents.event(), undefined);
    expect(prepared).toMatchObject([
      {
        id: 'ac-baidu',
        worldId: 20001,
        source: 'source:ac-baidu',
        requires: ['require:ac-baidu'],
        resources: { resource: 'resource:ac-baidu' },
        values: {},
      },
    ]);
    expect(prepared[0]!.token).toMatch(/^[0-9a-f-]{36}$/u);
    expect(h.runtime.prepare(contents.event(), undefined)).toEqual([]);
  });

  it('supports actual legacy include rules while exclusions and localhost stay closed', () => {
    const entry = QUALIFIED_SCRIPT_CATALOG['ac-baidu'];
    expect(matchesQualifiedScript(entry, 'https://www.baidu.com/s?wd=test')).toBe(true);
    expect(matchesQualifiedScript(entry, 'https://encrypted.google.com/search?q=test')).toBe(true);
    expect(matchesQualifiedScript(entry, 'https://www.bing.com/search?q=test')).toBe(true);
    expect(matchesQualifiedScript(entry, 'https://www.google.com/sorry/index')).toBe(false);
    expect(matchesQualifiedScript(entry, 'https://zhidao.baidu.com/question/1')).toBe(false);
    expect(matchesQualifiedScript(entry, 'http://localhost/search?q=test')).toBe(false);
    expect(matchesQualifiedScript(entry, 'https://user:pass@www.baidu.com/s')).toBe(false);
  });
});

describe('token, document and network ownership', () => {
  it('does not allow a token to cross WebContents or script identities', async () => {
    const h = setup();
    const ac = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    const github = attachAndPrepare(h, 'https://github.com/openai/codex');
    expect(
      sync(h.runtime, github.contents, {
        token: ac.token,
        op: 'notification',
        text: 'forged',
      }).ok,
    ).toBe(false);
    const result = await h.runtime.request(github.contents.event(), {
      token: github.token,
      requestId: 'github-xhr',
      url: 'https://example.com/a',
      method: 'GET',
    });
    expect(result).toMatchObject({ ok: false });
    expect(h.network.request).not.toHaveBeenCalled();
  });

  it('same-URL new document revokes the old token, aborts work and rejects a late result', async () => {
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    const request = h.runtime.request(contents.event(), {
      token,
      requestId: 'pending',
      url: 'https://example.com/a',
      method: 'GET',
    });
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    contents.navigate('https://www.baidu.com/s?wd=test');
    expect(h.pending[0]!.signal?.aborted).toBe(true);
    h.pending[0]!.resolve(response('late'));
    await expect(request).resolves.toMatchObject({ ok: false });
    expect(sync(h.runtime, contents, { token, op: 'notification', text: 'late-token' }).ok).toBe(
      false,
    );
    expect(contents.sent.some((item) => item.value.kind === 'revoke')).toBe(true);
    expect(h.runtime.prepare(contents.event(), undefined)).toHaveLength(1);
  });

  it('same-document navigation preserves the binding', () => {
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    contents.sameDocumentNavigation();
    expect(sync(h.runtime, contents, { token, op: 'notification', text: 'still-active' })).toEqual({
      ok: true,
    });
  });

  it.each([
    { method: 'POST', extra: {} },
    { method: 'GET', extra: { unknown: true } },
    { method: 'GET', extra: { headers: { Cookie: 'secret' } } },
    { method: 'GET', extra: { headers: { Accept: 7 } } },
  ])('rejects unsafe request payload %# before network', async ({ method, extra }) => {
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    const result = await h.runtime.request(contents.event(), {
      token,
      requestId: 'request-1',
      url: 'https://example.com/a',
      method,
      ...extra,
    });
    expect(result).toMatchObject({ ok: false });
    expect(h.network.request).not.toHaveBeenCalled();
  });

  it('passes only AC GET/HEAD with the closed header shape to the network port', async () => {
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    const request = h.runtime.request(contents.event(), {
      token,
      requestId: 'request-1',
      url: 'https://example.com/a',
      method: 'HEAD',
      headers: { Accept: 'text/plain', Referer: 'https://www.baidu.com/' },
    });
    await vi.waitFor(() => expect(h.network.request).toHaveBeenCalledOnce());
    expect(h.network.request.mock.calls[0]![0]).toEqual({
      url: 'https://example.com/a',
      method: 'HEAD',
      headers: { Accept: 'text/plain', Referer: 'https://www.baidu.com/' },
    });
    h.pending[0]!.resolve(response());
    await expect(request).resolves.toMatchObject({ ok: true });
  });

  it('cancels only the exact owned request id and rejects its late result', async () => {
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    const request = h.runtime.request(contents.event(), {
      token,
      requestId: 'owned',
      url: 'https://example.com/a',
      method: 'GET',
    });
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    h.runtime.cancel(contents.event(), { token, requestId: 'other' });
    expect(h.pending[0]!.signal?.aborted).toBe(false);
    h.runtime.cancel(contents.event(), { token, requestId: 'owned' });
    expect(h.pending[0]!.signal?.aborted).toBe(true);
    h.pending[0]!.resolve(response('late'));
    await expect(request).resolves.toMatchObject({ ok: false });
  });
});

describe('value events and rate limits', () => {
  it('emits value changes only to active documents of the same script with remote ownership', () => {
    const h = setup();
    const first = attachAndPrepare(h, 'https://www.baidu.com/s?wd=one');
    const second = attachAndPrepare(h, 'https://www1.baidu.com/s?wd=two');
    const stale = attachAndPrepare(h, 'https://m.baidu.com/s?wd=stale');
    const github = attachAndPrepare(h, 'https://github.com/openai/codex');
    stale.contents.mainFrame = new TestFrame(stale.contents.mainFrame.url).asFrame();
    const result = sync(h.runtime, first.contents, {
      token: first.token,
      op: 'set-value',
      key: 'layout',
      value: 'double',
    });
    expect(result).toEqual({ ok: true });
    expect(first.contents.sent.at(-1)?.value).toMatchObject({
      kind: 'value',
      key: 'layout',
      oldValue: undefined,
      newValue: 'double',
      remote: false,
    });
    expect(second.contents.sent.at(-1)?.value).toMatchObject({
      kind: 'value',
      key: 'layout',
      remote: true,
    });
    expect(stale.contents.sent.some((item) => item.value.kind === 'value')).toBe(false);
    expect(github.contents.sent.some((item) => item.value.kind === 'value')).toBe(false);
  });

  it('limits writes to 60 and notifications to 10 per rolling minute bucket', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    for (let index = 0; index < 60; index += 1) {
      expect(
        sync(h.runtime, contents, { token, op: 'set-value', key: `key-${index}`, value: index }).ok,
      ).toBe(true);
    }
    expect(sync(h.runtime, contents, { token, op: 'set-value', key: 'over', value: 61 }).ok).toBe(
      false,
    );
    for (let index = 0; index < 10; index += 1) {
      expect(
        sync(h.runtime, contents, { token, op: 'notification', text: `notice-${index}` }).ok,
      ).toBe(true);
    }
    expect(sync(h.runtime, contents, { token, op: 'notification', text: 'over' }).ok).toBe(false);
    expect(h.notify).toHaveBeenCalledTimes(10);
    vi.advanceTimersByTime(60_000);
    expect(sync(h.runtime, contents, { token, op: 'set-value', key: 'next', value: true }).ok).toBe(
      true,
    );
    expect(sync(h.runtime, contents, { token, op: 'notification', text: 'next' }).ok).toBe(true);
  });
});

describe('menu and settings-tab capability', () => {
  it('invokes only a registered command on the active user tab', () => {
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    expect(
      sync(h.runtime, contents, {
        token,
        op: 'register-menu',
        commandId: 'settings',
        label: '设置',
      }),
    ).toEqual({
      ok: true,
    });
    const command = h.runtime.menus(contents.id)[0]!;
    expect(command).toMatchObject({ token, commandId: 'settings', label: '设置' });
    expect(h.runtime.invokeMenu(command)).toBe(false);
    h.active.add(contents.id);
    expect(h.runtime.invokeMenu({ ...command, commandId: 'forged' })).toBe(false);
    expect(h.runtime.invokeMenu(command)).toBe(true);
    expect(menuEvents(contents)).toEqual([{ token, kind: 'menu', commandId: 'settings' }]);
  });

  it.each([
    'https://ac-baidu.90dao.com/pages/custom/settings',
    'https://ac-baidu.tujidu.com/pages/custom/settings',
    'https://ibaidu.tujidu.com/pages/custom/settings',
  ])('permits one menu-granted settings open for exact host: %s', (url) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    h.active.add(contents.id);
    sync(h.runtime, contents, { token, op: 'register-menu', commandId: 'settings', label: '设置' });
    const command = h.runtime.menus(contents.id)[0]!;
    expect(h.runtime.invokeMenu(command)).toBe(true);
    expect(sync(h.runtime, contents, { token, op: 'open-tab', url })).toEqual({ ok: true });
    expect(h.openUserTab).toHaveBeenCalledWith(url);
    expect(sync(h.runtime, contents, { token, op: 'open-tab', url }).ok).toBe(false);
  });

  it.each([
    'http://ac-baidu.90dao.com/pages/custom/settings',
    'https://evil.ac-baidu.90dao.com/pages/custom/settings',
    'https://ac-baidu.90dao.com/other/settings',
    'https://user@ac-baidu.90dao.com/pages/custom/settings',
  ])('rejects a non-exact settings target: %s', (url) => {
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    h.active.add(contents.id);
    sync(h.runtime, contents, { token, op: 'register-menu', commandId: 'settings', label: '设置' });
    expect(h.runtime.invokeMenu(h.runtime.menus(contents.id)[0]!)).toBe(true);
    expect(sync(h.runtime, contents, { token, op: 'open-tab', url }).ok).toBe(false);
    expect(h.openUserTab).not.toHaveBeenCalled();
  });

  it('expires the one-shot menu permit after one second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'));
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    h.active.add(contents.id);
    sync(h.runtime, contents, { token, op: 'register-menu', commandId: 'settings', label: '设置' });
    expect(h.runtime.invokeMenu(h.runtime.menus(contents.id)[0]!)).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(
      sync(h.runtime, contents, {
        token,
        op: 'open-tab',
        url: 'https://ac-baidu.90dao.com/pages/custom/settings',
      }).ok,
    ).toBe(false);
  });
});

describe('revocation and cleanup', () => {
  it('disable, navigation and dispose each abort pending work and revoke capabilities', async () => {
    for (const mode of ['disable', 'navigation', 'dispose'] as const) {
      const h = setup(['ac-baidu']);
      const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
      const request = h.runtime.request(contents.event(), {
        token,
        requestId: mode,
        url: 'https://example.com/a',
        method: 'GET',
      });
      await vi.waitFor(() => expect(h.pending).toHaveLength(1));
      if (mode === 'disable') {
        h.store.enabled.delete('ac-baidu');
        h.runtime.revokeScript('ac-baidu');
      } else if (mode === 'navigation') contents.navigate();
      else h.runtime.dispose();
      expect(h.pending[0]!.signal?.aborted).toBe(true);
      h.pending[0]!.resolve(response('late'));
      await expect(request).resolves.toMatchObject({ ok: false });
      expect(sync(h.runtime, contents, { token, op: 'notification', text: 'stale' }).ok).toBe(
        false,
      );
      if (mode === 'dispose') expect(contents.eventNames()).toEqual([]);
    }
  });

  it('destroyed WebContents removes listeners and aborts owned work', async () => {
    const h = setup(['ac-baidu']);
    const { contents, token } = attachAndPrepare(h, 'https://www.baidu.com/s?wd=test');
    const request = h.runtime.request(contents.event(), {
      token,
      requestId: 'destroy',
      url: 'https://example.com/a',
      method: 'GET',
    });
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    contents.destroyContents();
    expect(h.pending[0]!.signal?.aborted).toBe(true);
    h.pending[0]!.resolve(response());
    await expect(request).resolves.toMatchObject({ ok: false });
    expect(contents.eventNames()).toEqual([]);
  });
});
