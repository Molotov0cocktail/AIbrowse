/// <reference lib="dom" />

import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { QualifiedPreparedScript, ScriptValue } from '../shared/types/qualified-userscripts';

type SyncOperation =
  | { op: 'set-value'; key: string; value: ScriptValue }
  | { op: 'register-menu'; commandId: string; label: string }
  | { op: 'unregister-menu'; commandId: string }
  | { op: 'notification'; text: string }
  | { op: 'open-tab'; url: string };
interface NetworkRequest {
  requestId: string;
  url: string;
  method: 'GET' | 'HEAD';
  headers?: { Accept?: string; Referer?: string };
}
interface NetworkResponse {
  status: number;
  statusText: string;
  finalUrl: string;
  responseText: string;
  responseHeaders: string;
}
interface HostBridge {
  sync(operation: SyncOperation): void;
  request(request: NetworkRequest): Promise<NetworkResponse>;
  cancel(requestId: string): void;
}
interface RuntimeEvent {
  kind: 'value' | 'menu' | 'revoke';
  key?: string;
  oldValue?: ScriptValue;
  newValue?: ScriptValue;
  remote?: boolean;
  commandId?: string;
}
interface AcInterface {
  get(key: string, defaultJson: string): Promise<unknown>;
  save(key: string, value: ScriptValue): Promise<unknown>;
  change(key: string, value: ScriptValue): Promise<unknown>;
}

export function isSettingsPage(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.port === '' &&
      ['ac-baidu.90dao.com', 'ac-baidu.tujidu.com', 'ibaidu.tujidu.com'].includes(url.hostname) &&
      url.pathname === '/pages/custom/'
    );
  } catch {
    return false;
  }
}

// This entire function is copied into a dedicated, unprivileged script world.
export function installQualifiedRuntime(
  prepared: QualifiedPreparedScript,
  host: HostBridge,
  pageChannel: string,
  settingsPage: boolean,
): unknown[] {
  const boundDocument = document;
  const origin = location.origin;
  let alive = true;
  let sequence = 0;
  const values = new Map<string, ScriptValue>(Object.entries(prepared.values));
  const menus = new Map<string, () => void>();
  const listeners = new Map<
    number,
    {
      key: string;
      callback: (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void;
    }
  >();
  const requests = new Map<string, () => void>();
  const resourceUrls = new Map<string, string>();
  let acInterface: AcInterface | undefined;
  let acStarted = false;
  const assertAlive = (): void => {
    if (!alive || document !== boundDocument || location.origin !== origin || window !== window.top)
      throw new Error('脚本当前文档授权已失效。');
  };
  const validKey = (key: unknown): key is string =>
    typeof key === 'string' &&
    key.length > 0 &&
    key.length <= 256 &&
    !key.includes('\0') &&
    !['__proto__', 'prototype', 'constructor'].includes(key);
  const clone = (value: unknown): ScriptValue => {
    let nodes = 0;
    const walk = (item: unknown, depth: number): ScriptValue => {
      if (++nodes > 10000 || depth > 16) throw new Error('脚本数据超过结构预算。');
      if (item === null || typeof item === 'boolean') return item;
      if (typeof item === 'number' && Number.isFinite(item)) return item;
      if (typeof item === 'string' && item.length <= 262144) return item;
      if (Array.isArray(item)) {
        if (item.length > 10000 || Reflect.ownKeys(item).length !== item.length + 1)
          throw new Error('脚本数组必须是有界的连续 JSON 数组。');
        const result: ScriptValue[] = [];
        for (let index = 0; index < item.length; index++) {
          const property = Object.getOwnPropertyDescriptor(item, String(index));
          if (!property || !Object.hasOwn(property, 'value'))
            throw new Error('脚本数组不接受空洞或访问器。');
          result.push(walk(property.value, depth + 1));
        }
        return result;
      }
      if (
        typeof item !== 'object' ||
        item === null ||
        Object.getPrototypeOf(item) !== Object.prototype
      )
        throw new Error('脚本数据必须是有限 JSON 值。');
      const result: Record<string, ScriptValue> = {};
      for (const key of Reflect.ownKeys(item)) {
        if (!validKey(key)) throw new Error('脚本数据键无效。');
        const property = Object.getOwnPropertyDescriptor(item, key);
        if (!property || !Object.hasOwn(property, 'value'))
          throw new Error('脚本数据不接受访问器。');
        result[key] = walk(property.value, depth + 1);
      }
      return result;
    };
    const result = walk(value, 0);
    if (JSON.stringify(result).length > 262144) throw new Error('脚本数据超过长度预算。');
    return result;
  };
  const requireKey = (key: unknown): string => {
    if (!validKey(key)) throw new Error('脚本存储键无效。');
    return key;
  };
  const callSafely = (callback: (() => void) | undefined): void => {
    try {
      callback?.();
    } catch {
      /* Third-party callback errors never escape the bridge. */
    }
  };
  const getValue = (key: string, fallback?: unknown): unknown => {
    assertAlive();
    const value = values.get(requireKey(key));
    return value === undefined
      ? fallback === undefined
        ? undefined
        : clone(fallback)
      : clone(value);
  };
  const setValue = (key: string, input: unknown): void => {
    assertAlive();
    const checkedKey = requireKey(key);
    const value = clone(input);
    host.sync({ op: 'set-value', key: checkedKey, value });
    values.set(checkedKey, value);
  };
  const listValues = (): string[] => {
    assertAlive();
    return [...values.keys()];
  };
  const addStyle = (css: string): HTMLStyleElement => {
    assertAlive();
    if (typeof css !== 'string' || css.length > 262144) throw new Error('脚本样式超过预算。');
    const element = document.createElement('style');
    element.textContent = css;
    const insert = (): void => {
      if (alive) (document.head ?? document.documentElement)?.appendChild(element);
    };
    if (document.documentElement) insert();
    else document.addEventListener('DOMContentLoaded', insert, { once: true });
    return element;
  };
  const resourceText = (name: string): string => {
    assertAlive();
    requireKey(name);
    if (!Object.hasOwn(prepared.resources, name)) throw new Error('脚本资源未通过资格校验。');
    return prepared.resources[name];
  };
  const resourceUrl = (name: string): string => {
    const text = resourceText(name);
    const existing = resourceUrls.get(name);
    if (existing) return existing;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    resourceUrls.set(name, url);
    return url;
  };
  const registerMenu = (label: string, callback: () => void): string => {
    assertAlive();
    if (
      typeof label !== 'string' ||
      label.length === 0 ||
      label.length > 200 ||
      typeof callback !== 'function' ||
      menus.size >= 16
    )
      throw new Error('脚本菜单超过预算或参数无效。');
    const commandId = `menu-${++sequence}`;
    host.sync({ op: 'register-menu', commandId, label });
    menus.set(commandId, callback);
    return commandId;
  };
  const unregisterMenu = (commandId: string): void => {
    assertAlive();
    if (!menus.has(commandId)) return;
    host.sync({ op: 'unregister-menu', commandId });
    menus.delete(commandId);
  };
  const notification = (input: string | { text: string }): void => {
    assertAlive();
    const text = typeof input === 'string' ? input : input?.text;
    if (typeof text !== 'string' || text.length > 1000) throw new Error('脚本通知无效。');
    host.sync({ op: 'notification', text });
  };
  const valueListener = (
    key: string,
    callback: (key: string, oldValue: unknown, newValue: unknown, remote: boolean) => void,
  ): number => {
    assertAlive();
    requireKey(key);
    if (typeof callback !== 'function' || listeners.size >= 64)
      throw new Error('脚本监听器超过预算。');
    const id = ++sequence;
    listeners.set(id, { key, callback });
    return id;
  };
  interface RequestOptions {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    timeout?: number;
    responseType?: string;
    onload?: (response: NetworkResponse & { response: unknown; readyState: number }) => void;
    onerror?: (error: { error: string; status: number }) => void;
    ontimeout?: () => void;
    onabort?: () => void;
  }
  const xmlhttpRequest = (options: RequestOptions): { abort(): void } => {
    assertAlive();
    if (!options || typeof options !== 'object') throw new Error('脚本请求无效。');
    const requestId = `request-${++sequence}`;
    let completed = false;
    const timing: { timer?: ReturnType<typeof setTimeout> } = {};
    const finish = (): boolean => {
      if (completed) return false;
      completed = true;
      clearTimeout(timing.timer);
      requests.delete(requestId);
      return alive && document === boundDocument && location.origin === origin;
    };
    const abort = (): void => {
      if (completed) return;
      host.cancel(requestId);
      if (finish()) callSafely(options.onabort);
    };
    const fail = (message: string): void => {
      if (finish()) callSafely(() => options.onerror?.({ error: message, status: 0 }));
    };
    let request: NetworkRequest;
    try {
      const url = new URL(options.url);
      const method = (options.method ?? 'GET').toUpperCase();
      if (
        prepared.id !== 'ac-baidu' ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        options.url.length > 8192 ||
        (method !== 'GET' && method !== 'HEAD') ||
        requests.size >= 4
      )
        throw new Error('脚本仅允许有界公共 GET/HEAD 请求。');
      const headers: { Accept?: string; Referer?: string } = {};
      for (const [key, value] of Object.entries(options.headers ?? {})) {
        if (typeof value !== 'string' || value.length > 2048 || /[\r\n\0]/u.test(value))
          throw new Error('脚本请求头无效。');
        if (key.toLowerCase() === 'accept') headers.Accept = value;
        else if (key.toLowerCase() === 'referer') headers.Referer = value;
        else throw new Error('脚本请求头未获授权。');
      }
      request = {
        requestId,
        url: url.href,
        method,
        ...(Object.keys(headers).length ? { headers } : {}),
      };
      if (options.responseType && !['text', 'json'].includes(options.responseType))
        throw new Error('脚本响应类型未获支持。');
    } catch {
      queueMicrotask(() => fail('脚本请求未获授权。'));
      return { abort };
    }
    requests.set(requestId, abort);
    const timeout = Number.isFinite(options.timeout)
      ? Math.min(15000, Math.max(1, options.timeout!))
      : 10000;
    timing.timer = setTimeout(() => {
      host.cancel(requestId);
      if (finish())
        callSafely(
          options.ontimeout ?? (() => options.onerror?.({ error: '请求超时。', status: 0 })),
        );
    }, timeout);
    void host.request(request).then(
      (response) => {
        if (!finish()) return;
        let body: unknown = response.responseText;
        if (options.responseType === 'json') {
          try {
            body = JSON.parse(response.responseText);
          } catch {
            body = null;
          }
        }
        const responseHeaders = response.responseHeaders
          .split(/\r?\n/u)
          .filter((line) => !/^tm-finalurl[^:]*:/iu.test(line))
          .join('\r\n');
        const finalHeader = /[\r\n\0]/u.test(response.finalUrl)
          ? ''
          : `\r\ntm-finalurlaibrowse: ${response.finalUrl}`;
        callSafely(() =>
          options.onload?.({
            ...response,
            responseHeaders: responseHeaders + finalHeader,
            response: body,
            readyState: 4,
          }),
        );
      },
      () => fail('脚本请求失败。'),
    );
    return { abort };
  };
  const configKey = (key: unknown): key is string =>
    typeof key === 'string' &&
    [
      'ACConfig',
      'ACBlockRules',
      'SyncConfig',
      'op_common',
      'op_baidu',
      'op_google',
      'op_bing',
      'op_duck',
      'op_duckduckgo',
      'op_haosou',
      'op_doge',
    ].includes(key);
  const onPageMessage = (event: MessageEvent<unknown>): void => {
    if (
      !alive ||
      !settingsPage ||
      !acInterface ||
      event.source !== window ||
      event.origin !== origin ||
      location.origin !== origin ||
      location.pathname !== '/pages/custom/'
    )
      return;
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    const data = message as Record<string, unknown>;
    if (
      data.channel !== pageChannel ||
      data.kind !== 'ac-call' ||
      typeof data.requestId !== 'string' ||
      data.requestId.length > 80 ||
      !configKey(data.key) ||
      !['get', 'save', 'change'].includes(String(data.method))
    )
      return;
    let response: Promise<unknown>;
    try {
      if (data.method === 'get') {
        if (typeof data.value !== 'string' || data.value.length > 262144)
          throw new Error('无效配置默认值。');
        clone(JSON.parse(data.value));
        response = acInterface.get(data.key, data.value);
      } else response = acInterface[data.method as 'save' | 'change'](data.key, clone(data.value));
    } catch {
      response = Promise.reject(new Error('配置参数无效。'));
    }
    void response
      .then((value) => {
        if (!alive || location.origin !== origin || location.pathname !== '/pages/custom/') return;
        window.postMessage(
          {
            channel: pageChannel,
            kind: 'ac-result',
            requestId: data.requestId,
            ok: true,
            value: value === undefined ? null : clone(value),
          },
          origin,
        );
      })
      .catch(() => {
        if (alive && location.origin === origin && location.pathname === '/pages/custom/')
          window.postMessage(
            { channel: pageChannel, kind: 'ac-result', requestId: data.requestId, ok: false },
            origin,
          );
      });
  };
  if (settingsPage) window.addEventListener('message', onPageMessage);
  const unsafeWindow = Object.defineProperties(
    {},
    {
      isACBaiduInit: {
        get: () => acStarted,
        set: (value: unknown) => {
          assertAlive();
          acStarted = value === true;
        },
      },
      AC_GM_Interface: {
        get: () => acInterface,
        set: (value: AcInterface) => {
          assertAlive();
          if (
            !settingsPage ||
            !value ||
            typeof value.get !== 'function' ||
            typeof value.save !== 'function' ||
            typeof value.change !== 'function'
          )
            throw new Error('当前网页未获脚本配置接口授权。');
          acInterface = value;
        },
      },
      webInterface: {
        get: () =>
          settingsPage
            ? {
                update: () => {
                  assertAlive();
                  window.postMessage({ channel: pageChannel, kind: 'ac-update' }, origin);
                },
              }
            : undefined,
      },
      isDevMode: {
        get: () => false,
        set: () => {
          throw new Error('本地开发模式未获授权。');
        },
      },
    },
  );
  const ddg = Object.freeze({
    settings: Object.freeze({
      set: (key: string, value: number): void => {
        assertAlive();
        if (
          prepared.id === 'ac-baidu' &&
          (location.hostname === 'duckduckgo.com' ||
            location.hostname.endsWith('.duckduckgo.com')) &&
          ['kn', 'kav'].includes(key) &&
          value === 1
        )
          window.postMessage({ channel: pageChannel, kind: 'ddg-setting', key }, origin);
      },
    }),
  });
  if (prepared.id === 'ac-baidu') {
    Object.defineProperty(globalThis, 'open', {
      configurable: true,
      value: (url: unknown): null => {
        assertAlive();
        if (typeof url !== 'string' || url.length > 2048) throw new Error('脚本设置链接无效。');
        host.sync({ op: 'open-tab', url });
        return null;
      },
    });
  }
  const info = Object.freeze({
    script: Object.freeze({
      name: prepared.name,
      version: prepared.version,
      resources: Object.freeze(
        Object.fromEntries(Object.keys(prepared.resources).map((name) => [name, { name }])),
      ),
    }),
    scriptHandler: 'AIbrowse',
    version: '1',
    injectInto: 'isolated',
    scriptWillUpdate: false,
  });
  const gm = Object.freeze({
    info,
    addStyle,
    getValue: async (key: string, fallback?: unknown) => getValue(key, fallback),
    setValue: async (key: string, value: unknown) => setValue(key, value),
    listValues: async () => listValues(),
    getResourceText: async (name: string) => resourceText(name),
    getResourceUrl: async (name: string) => resourceUrl(name),
    registerMenuCommand: registerMenu,
    unregisterMenuCommand: unregisterMenu,
    addValueChangeListener: valueListener,
    notification,
    xmlHttpRequest: xmlhttpRequest,
  });
  const revoke = (): void => {
    if (!alive) return;
    alive = false;
    for (const abort of requests.values()) abort();
    menus.clear();
    listeners.clear();
    requests.clear();
    for (const url of resourceUrls.values()) URL.revokeObjectURL(url);
    resourceUrls.clear();
    window.removeEventListener('message', onPageMessage);
    acInterface = undefined;
  };
  Object.defineProperty(globalThis, '__qualifiedDispatch', {
    value: (event: RuntimeEvent): void => {
      if (event.kind === 'revoke') {
        revoke();
        return;
      }
      if (!alive || document !== boundDocument || location.origin !== origin) return;
      if (event.kind === 'menu' && event.commandId) callSafely(menus.get(event.commandId));
      if (
        event.kind === 'value' &&
        event.key &&
        validKey(event.key) &&
        event.newValue !== undefined
      ) {
        values.set(event.key, clone(event.newValue));
        for (const listener of listeners.values())
          if (listener.key === event.key)
            callSafely(() =>
              listener.callback(event.key!, event.oldValue, event.newValue, event.remote === true),
            );
      }
    },
    configurable: false,
  });
  window.addEventListener('pagehide', revoke, { once: true });
  return [
    gm,
    info,
    addStyle,
    getValue,
    setValue,
    listValues,
    resourceText,
    resourceUrl,
    registerMenu,
    unregisterMenu,
    valueListener,
    notification,
    xmlhttpRequest,
    unsafeWindow,
    ddg,
  ];
}

// Main-world facade contains only page messages and three AC-specific methods.
export function installPageFacade(channel: string, settingsPage: boolean, duckPage: boolean): void {
  const origin = location.origin;
  const path = location.pathname;
  let sequence = 0;
  const pending = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(reason: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const request = (method: string, key: string, value: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (location.origin !== origin || location.pathname !== path || pending.size >= 32) {
        reject(new Error('脚本配置接口当前不可用。'));
        return;
      }
      const requestId = `page-${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('脚本配置请求超时。'));
      }, 5000);
      pending.set(requestId, { resolve, reject, timer });
      window.postMessage({ channel, kind: 'ac-call', requestId, method, key, value }, origin);
    });
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (
      event.source !== window ||
      event.origin !== origin ||
      location.origin !== origin ||
      location.pathname !== path ||
      !event.data ||
      typeof event.data !== 'object'
    )
      return;
    const data = event.data as Record<string, unknown>;
    if (data.channel !== channel) return;
    if (settingsPage && data.kind === 'ac-result' && typeof data.requestId === 'string') {
      const entry = pending.get(data.requestId);
      if (!entry) return;
      pending.delete(data.requestId);
      clearTimeout(entry.timer);
      if (data.ok === true) entry.resolve(data.value);
      else entry.reject(new Error('脚本配置请求被拒绝。'));
    } else if (settingsPage && data.kind === 'ac-update') {
      const page = window as typeof window & { webInterface?: { update?: () => void } };
      if (typeof page.webInterface?.update === 'function') page.webInterface.update();
    } else if (
      duckPage &&
      data.kind === 'ddg-setting' &&
      ['kn', 'kav'].includes(String(data.key))
    ) {
      const page = window as typeof window & {
        DDG?: { settings?: { set?: (key: string, value: number, options: object) => void } };
      };
      page.DDG?.settings?.set?.(String(data.key), 1, { saveToCloud: true, forceTheme: true });
    }
  });
  if (settingsPage)
    Object.defineProperty(window, 'AC_GM_Interface', {
      configurable: false,
      value: Object.freeze({
        get: (key: string, defaultJson: string) => request('get', key, defaultJson),
        save: (key: string, value: unknown) => request('save', key, value),
        change: (key: string, value: unknown) => request('change', key, value),
      }),
    });
  window.addEventListener(
    'pagehide',
    () => {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('脚本配置文档已关闭。'));
      }
      pending.clear();
    },
    { once: true },
  );
}

export function buildQualifiedExecution(
  prepared: QualifiedPreparedScript,
  channel: string,
  settings: boolean,
): string {
  const names =
    'GM,GM_info,GM_addStyle,GM_getValue,GM_setValue,GM_listValues,GM_getResourceText,GM_getResourceURL,GM_registerMenuCommand,GM_unregisterMenuCommand,GM_addValueChangeListener,GM_notification,GM_xmlhttpRequest,unsafeWindow,DDG';
  let source = prepared.source;
  const replaceOnce = (before: string, after: string): void => {
    if (source.split(before).length !== 2) throw new Error('脚本资格适配与固定版本不符。');
    source = source.replace(before, after);
  };
  // Only the execution copy of the hash-verified, pinned source is adapted.
  if (prepared.id === 'github-zh' && prepared.version === '1.9.2.4-2026-09-27')
    replaceOnce('function transDesc(el) {', 'function transDesc(el) { return;');
  if (prepared.id === 'ac-baidu' && prepared.version === '27.20')
    replaceOnce(
      'let relURL = Reg_Get(response.responseHeaders,',
      'let relURL = MyApi.Reg_Get(response.responseHeaders,',
    );
  return `(() => { const args = (${installQualifiedRuntime.toString()})(${JSON.stringify(prepared)}, globalThis.__qualifiedHost, ${JSON.stringify(channel)}, ${settings}); (function(${names}) {\n${prepared.requires.join('\n;\n')}\n;\n${source}\n}).apply(globalThis, args); return true; })()`;
}

export function startQualifiedPreload(): void {
  if (!process.isMainFrame || (location.protocol !== 'https:' && location.protocol !== 'http:'))
    return;
  const prepared: unknown = ipcRenderer.sendSync('qualified-scripts:prepare');
  if (!Array.isArray(prepared) || prepared.length > 2) return;
  const live = new Map<string, QualifiedPreparedScript>();
  for (const candidate of prepared as QualifiedPreparedScript[]) {
    if (
      !candidate ||
      !['ac-baidu', 'github-zh'].includes(candidate.id) ||
      typeof candidate.token !== 'string' ||
      !Number.isInteger(candidate.worldId) ||
      candidate.worldId < 20001 ||
      candidate.worldId > 20002 ||
      typeof candidate.source !== 'string' ||
      !Array.isArray(candidate.requires)
    )
      continue;
    const script = candidate;
    live.set(script.token, script);
    let revoked = false;
    const assertLive = (): void => {
      if (revoked) throw new Error('脚本授权已撤销。');
    };
    const unwrap = (response: unknown): unknown => {
      if (!response || typeof response !== 'object' || !('ok' in response) || response.ok !== true)
        throw new Error('脚本操作被主进程拒绝。');
      return 'value' in response ? response.value : undefined;
    };
    const bridge: HostBridge = {
      sync: (operation) => {
        assertLive();
        unwrap(
          ipcRenderer.sendSync('qualified-scripts:sync', { token: script.token, ...operation }),
        );
      },
      request: async (request) => {
        assertLive();
        const result = unwrap(
          await ipcRenderer.invoke('qualified-scripts:request', {
            token: script.token,
            ...request,
          }),
        );
        assertLive();
        return result as NetworkResponse;
      },
      cancel: (requestId) =>
        ipcRenderer.send('qualified-scripts:cancel', { token: script.token, requestId }),
    };
    contextBridge.exposeInIsolatedWorld(script.worldId, '__qualifiedHost', bridge);
    const channel = crypto.randomUUID();
    const settings = script.id === 'ac-baidu' && isSettingsPage(location.href);
    const duck =
      script.id === 'ac-baidu' &&
      (location.hostname === 'duckduckgo.com' || location.hostname.endsWith('.duckduckgo.com'));
    if (settings || duck)
      void webFrame
        .executeJavaScript(
          `(${installPageFacade.toString()})(${JSON.stringify(channel)},${settings},${duck})`,
        )
        .catch(() => undefined);
    const execute = (): void => {
      if (revoked) return;
      void webFrame
        .executeJavaScriptInIsolatedWorld(
          script.worldId,
          [{ code: buildQualifiedExecution(script, channel, settings) }],
          false,
        )
        .catch(() => undefined);
    };
    if (script.runAt === 'document-start' || document.readyState !== 'loading') execute();
    else document.addEventListener('DOMContentLoaded', execute, { once: true });
    const onEvent = (_event: Electron.IpcRendererEvent, input: unknown): void => {
      if (
        !input ||
        typeof input !== 'object' ||
        !('token' in input) ||
        input.token !== script.token ||
        !('kind' in input)
      )
        return;
      const event = input as RuntimeEvent;
      if (!['value', 'menu', 'revoke'].includes(event.kind)) return;
      if (event.kind === 'revoke') revoked = true;
      void webFrame
        .executeJavaScriptInIsolatedWorld(
          script.worldId,
          [{ code: `globalThis.__qualifiedDispatch?.(${JSON.stringify(event)})` }],
          event.kind === 'menu',
        )
        .catch(() => undefined);
    };
    ipcRenderer.on('qualified-scripts:event', onEvent);
    window.addEventListener(
      'pagehide',
      () => {
        revoked = true;
        live.delete(script.token);
        ipcRenderer.removeListener('qualified-scripts:event', onEvent);
      },
      { once: true },
    );
  }
}

if (process.type === 'renderer') startQualifiedPreload();
