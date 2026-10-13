import { randomUUID } from 'node:crypto';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents, WebFrameMain } from 'electron';
import type {
  QualifiedMenuCommand,
  QualifiedPreparedScript,
  QualifiedScriptId,
} from '../../shared/types/qualified-userscripts';
import type { CatalogEntry } from './catalog';
import type { QualifiedScriptStore } from './store';
import type { QualifiedScriptNetwork } from './network';

const EVENT_CHANNEL = 'qualified-scripts:event';
const SETTINGS_HOSTS = new Set(['ac-baidu.90dao.com', 'ac-baidu.tujidu.com', 'ibaidu.tujidu.com']);
type SenderEvent = Pick<IpcMainEvent | IpcMainInvokeEvent, 'sender' | 'senderFrame'>;
interface Binding {
  id: QualifiedScriptId;
  token: string;
  contents: WebContents;
  frame: WebFrameMain;
  origin: string;
  menus: Map<string, string>;
  requests: Map<string, AbortController>;
  menuPermitUntil: number;
  budgetStartedAt: number;
  writes: number;
  notifications: number;
}

function object(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key) => {
    if (typeof key !== 'string' || !allowed.includes(key)) return false;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property !== undefined && 'value' in property;
  });
}

function boundedText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function wildcard(pattern: string, value: string): boolean {
  const parts = pattern.split('*');
  let offset = 0;
  for (const [index, part] of parts.entries()) {
    if (part === '') continue;
    const found = value.indexOf(part, offset);
    if (found < 0 || (index === 0 && found !== 0)) return false;
    offset = found + part.length;
  }
  return pattern.endsWith('*') || offset === value.length;
}

/** Catalog globs are frozen author declarations; input is always a real HTTP(S) frame URL. */
export function matchesQualifiedScript(entry: CatalogEntry, value: string): boolean {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) return false;
    return (
      [...entry.matches, ...entry.includes].some((rule) => wildcard(rule, url.href)) &&
      !entry.excludes.some((rule) => wildcard(rule, url.href))
    );
  } catch {
    return false;
  }
}

export class QualifiedScriptRuntime {
  private readonly attachments = new Map<WebContents, () => void>();
  private readonly bindings = new Map<string, Binding>();
  private disposed = false;

  constructor(
    private readonly options: {
      store: Pick<QualifiedScriptStore, 'getEnabled' | 'list' | 'getValues' | 'setValue'>;
      network: Pick<QualifiedScriptNetwork, 'request'>;
      isOpen: () => boolean;
      isActiveUserTab: (contentsId: number) => boolean;
      openUserTab: (url: string) => void;
      notify: (text: string) => void;
    },
  ) {}

  attach(contents: WebContents): void {
    if (this.disposed || contents.isDestroyed() || this.attachments.has(contents)) return;
    const revoke = (): void => {
      for (const binding of [...this.bindings.values()]) {
        if (binding.contents === contents) this.revoke(binding);
      }
    };
    const navigating = (
      event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
    ): void => {
      if (event.isMainFrame && !event.isSameDocument) revoke();
    };
    const dispose = (): void => {
      revoke();
      contents.removeListener('did-start-navigation', navigating);
      contents.removeListener('render-process-gone', revoke);
      contents.removeListener('destroyed', dispose);
      this.attachments.delete(contents);
    };
    contents.on('did-start-navigation', navigating);
    contents.on('render-process-gone', revoke);
    contents.once('destroyed', dispose);
    this.attachments.set(contents, dispose);
  }

  prepare(event: SenderEvent, payload: unknown): QualifiedPreparedScript[] {
    if (payload !== undefined || !this.trustedFrame(event)) return [];
    const frame = event.senderFrame!;
    if ([...this.bindings.values()].some((binding) => binding.contents === event.sender)) return [];
    return this.options.store.getEnabled().flatMap((script, index) => {
      if (!matchesQualifiedScript(script.entry, frame.url)) return [];
      const token = randomUUID();
      this.bindings.set(token, {
        token,
        id: script.entry.id,
        contents: event.sender,
        frame,
        origin: new URL(frame.url).origin,
        menus: new Map(),
        requests: new Map(),
        menuPermitUntil: 0,
        budgetStartedAt: Date.now(),
        writes: 0,
        notifications: 0,
      });
      return [
        {
          id: script.entry.id,
          token,
          worldId: 20001 + index,
          source: script.source,
          requires: script.requires,
          resources: script.resources,
          values: script.values,
          name: script.entry.name,
          version: script.entry.version,
          runAt: script.entry.runAt,
        },
      ];
    });
  }

  sync(event: SenderEvent, payload: unknown): unknown {
    try {
      if (!object(payload, ['token', 'op', 'key', 'value', 'commandId', 'label', 'text', 'url']))
        return this.denied();
      const binding = this.resolve(event, payload.token);
      if (!binding) return this.denied();
      if (Date.now() - binding.budgetStartedAt >= 60000) {
        binding.budgetStartedAt = Date.now();
        binding.writes = 0;
        binding.notifications = 0;
      }
      const exact = (keys: string[]): boolean =>
        Reflect.ownKeys(payload).length === keys.length + 2 &&
        object(payload, ['token', 'op', ...keys]);
      if (
        payload.op === 'set-value' &&
        exact(['key', 'value']) &&
        typeof payload.key === 'string'
      ) {
        if (binding.writes >= 60) return this.denied();
        binding.writes += 1;
        const oldValue = this.options.store.getValues(binding.id)[payload.key];
        const result = this.options.store.setValue(binding.id, payload.key, payload.value);
        if (!result.ok) return result;
        const newValue = this.options.store.getValues(binding.id)[payload.key];
        for (const other of this.bindings.values()) {
          if (other.id === binding.id && this.active(other))
            this.emit(other, {
              kind: 'value',
              key: payload.key,
              oldValue,
              newValue,
              remote: other.token !== binding.token,
            });
        }
        return { ok: true };
      }
      if (
        payload.op === 'register-menu' &&
        exact(['commandId', 'label']) &&
        boundedText(payload.commandId, 80) &&
        boundedText(payload.label, 160) &&
        binding.menus.size < 24
      ) {
        binding.menus.set(payload.commandId, payload.label);
        return { ok: true };
      }
      if (
        payload.op === 'unregister-menu' &&
        exact(['commandId']) &&
        boundedText(payload.commandId, 80)
      ) {
        binding.menus.delete(payload.commandId);
        return { ok: true };
      }
      if (payload.op === 'notification' && exact(['text']) && boundedText(payload.text, 500)) {
        if (binding.notifications >= 10) return this.denied();
        binding.notifications += 1;
        this.options.notify(payload.text);
        return { ok: true };
      }
      if (
        payload.op === 'open-tab' &&
        exact(['url']) &&
        binding.id === 'ac-baidu' &&
        boundedText(payload.url, 4096) &&
        binding.menuPermitUntil > Date.now() &&
        this.options.isActiveUserTab(binding.contents.id)
      ) {
        binding.menuPermitUntil = 0;
        const target = new URL(payload.url);
        if (
          target.protocol !== 'https:' ||
          target.username ||
          target.password ||
          target.port ||
          !SETTINGS_HOSTS.has(target.hostname) ||
          !target.pathname.startsWith('/pages/custom/')
        )
          return this.denied();
        this.options.openUserTab(target.href);
        return { ok: true };
      }
      return this.denied();
    } catch {
      return this.denied();
    }
  }

  async request(event: SenderEvent, payload: unknown): Promise<unknown> {
    let binding: Binding | null = null;
    let requestId = '';
    try {
      if (
        !object(payload, ['token', 'requestId', 'url', 'method', 'headers']) ||
        !boundedText(payload.requestId, 80) ||
        typeof payload.url !== 'string' ||
        (payload.method !== 'GET' && payload.method !== 'HEAD')
      )
        return this.denied();
      binding = this.resolve(event, payload.token);
      if (
        !binding ||
        binding.id !== 'ac-baidu' ||
        binding.requests.size >= 4 ||
        binding.requests.has(payload.requestId)
      )
        return this.denied();
      if (
        payload.headers !== undefined &&
        (!object(payload.headers, ['Accept', 'Referer']) ||
          Object.values(payload.headers).some((value) => typeof value !== 'string'))
      )
        return this.denied();
      requestId = payload.requestId;
      const controller = new AbortController();
      binding.requests.set(requestId, controller);
      const value = await this.options.network.request(
        {
          url: payload.url,
          method: payload.method,
          ...(payload.headers === undefined
            ? {}
            : { headers: payload.headers as { Accept?: string; Referer?: string } }),
        },
        controller.signal,
      );
      return this.active(binding) && !controller.signal.aborted
        ? { ok: true, value }
        : this.denied();
    } catch {
      return {
        ok: false,
        message: '脚本请求未完成；仅允许有界的公网 GET/HEAD，且不携带登录凭据。',
      };
    } finally {
      binding?.requests.delete(requestId);
    }
  }

  cancel(event: SenderEvent, payload: unknown): void {
    try {
      if (
        !object(payload, ['token', 'requestId']) ||
        Reflect.ownKeys(payload).length !== 2 ||
        typeof payload.requestId !== 'string'
      )
        return;
      this.resolve(event, payload.token)?.requests.get(payload.requestId)?.abort();
    } catch {
      /* Rejected remote input has no side effects. */
    }
  }

  menus(contentsId: number): QualifiedMenuCommand[] {
    return [...this.bindings.values()]
      .filter((binding) => binding.contents.id === contentsId && this.active(binding))
      .flatMap((binding) =>
        [...binding.menus].map(([commandId, label]) => ({
          token: binding.token,
          commandId,
          label,
        })),
      );
  }

  invokeMenu(command: QualifiedMenuCommand): boolean {
    const binding = this.bindings.get(command.token);
    if (
      !binding ||
      !this.active(binding) ||
      !this.options.isActiveUserTab(binding.contents.id) ||
      !binding.menus.has(command.commandId)
    )
      return false;
    binding.menuPermitUntil = Date.now() + 1000;
    this.emit(binding, { kind: 'menu', commandId: command.commandId });
    return true;
  }

  revokeScript(id: QualifiedScriptId): void {
    for (const binding of [...this.bindings.values()]) if (binding.id === id) this.revoke(binding);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const dispose of [...this.attachments.values()]) dispose();
  }

  private trustedFrame(event: SenderEvent): boolean {
    try {
      return (
        !this.disposed &&
        this.options.isOpen() &&
        this.attachments.has(event.sender) &&
        !event.sender.isDestroyed() &&
        event.senderFrame !== null &&
        event.senderFrame === event.sender.mainFrame
      );
    } catch {
      return false;
    }
  }

  private resolve(event: SenderEvent, token: unknown): Binding | null {
    if (typeof token !== 'string' || !this.trustedFrame(event)) return null;
    const binding = this.bindings.get(token);
    return binding &&
      binding.contents === event.sender &&
      binding.frame === event.senderFrame &&
      this.active(binding)
      ? binding
      : null;
  }

  private active(binding: Binding): boolean {
    try {
      return (
        !this.disposed &&
        this.options.isOpen() &&
        this.bindings.get(binding.token) === binding &&
        !binding.contents.isDestroyed() &&
        binding.frame === binding.contents.mainFrame &&
        new URL(binding.frame.url).origin === binding.origin &&
        this.options.store
          .list()
          .some((entry) => entry.id === binding.id && entry.installed && entry.enabled)
      );
    } catch {
      return false;
    }
  }

  private emit(binding: Binding, event: Record<string, unknown>): void {
    if (!binding.contents.isDestroyed())
      binding.contents.send(EVENT_CHANNEL, { token: binding.token, ...event });
  }

  private revoke(binding: Binding): void {
    this.bindings.delete(binding.token);
    for (const request of binding.requests.values()) request.abort();
    binding.requests.clear();
    binding.menus.clear();
    this.emit(binding, { kind: 'revoke' });
  }

  private denied() {
    return { ok: false as const, message: '脚本权限或页面状态已失效。' };
  }
}
