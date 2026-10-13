import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { QualifiedPreparedScript } from '../shared/types/qualified-userscripts';

const electronMocks = vi.hoisted(() => ({
  expose: vi.fn(),
  sync: vi.fn(),
  invoke: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  remove: vi.fn(),
  execute: vi.fn().mockResolvedValue(true),
  mainWorld: vi.fn().mockResolvedValue(true),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInIsolatedWorld: electronMocks.expose },
  ipcRenderer: {
    sendSync: electronMocks.sync,
    invoke: electronMocks.invoke,
    send: electronMocks.send,
    on: electronMocks.on,
    removeListener: electronMocks.remove,
  },
  webFrame: {
    executeJavaScriptInIsolatedWorld: electronMocks.execute,
    executeJavaScript: electronMocks.mainWorld,
  },
}));
import {
  buildQualifiedExecution,
  isSettingsPage,
  startQualifiedPreload,
} from './qualified-userscripts';

function harness(
  options: {
    id?: 'ac-baidu' | 'github-zh';
    url?: string;
    source?: string;
    requires?: string[];
    version?: string;
  } = {},
) {
  const sync = vi.fn();
  const cancel = vi.fn();
  const request = vi.fn().mockResolvedValue({
    status: 200,
    statusText: 'OK',
    finalUrl: 'https://public.example/final',
    responseText: 'body',
    responseHeaders: 'tm-finalurlbad: https://evil.example/\r\ncontent-type: text/plain',
  });
  const prepared: QualifiedPreparedScript = {
    id: options.id ?? 'ac-baidu',
    token: 'host-owned-token',
    worldId: 20001,
    source:
      options.source ??
      'globalThis.fixture = {GM,GM_info,GM_getValue,GM_setValue,GM_addStyle,GM_getResourceText,GM_getResourceURL,GM_listValues,GM_registerMenuCommand,GM_unregisterMenuCommand,GM_addValueChangeListener,GM_notification,GM_xmlhttpRequest,unsafeWindow,DDG};',
    requires: options.requires ?? [],
    resources: { style: 'body {color: red}' },
    values: { enabled: true },
    name: '合成资格脚本',
    version: options.version ?? '1',
    runAt: 'document-start',
  };
  const context = createContext({
    URL,
    Blob,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    __qualifiedHost: { sync, request, cancel },
    location: new URL(options.url ?? 'https://www.baidu.com/s?wd=x'),
    messages: [],
    callbackResults: [],
  });
  const run = (code: string): unknown => new Script(code).runInContext(context, { timeout: 1000 });
  run(`globalThis.window = globalThis; window.top = window;
    const events = new Map();
    window.addEventListener = (name, callback) => { let items=events.get(name); if(!items) events.set(name,items=[]); items.push(callback); };
    window.removeEventListener = (name, callback) => { events.set(name,(events.get(name)||[]).filter(item=>item!==callback)); };
    window.postMessage = (value) => messages.push(value);
    globalThis.emit = (name, data) => (events.get(name)||[]).slice().forEach(callback=>callback(data));
    globalThis.document = { documentElement: {appendChild(){}},head:{appendChild(){}},createElement(){return {textContent:''}},addEventListener:window.addEventListener };
  `);
  run(buildQualifiedExecution(prepared, 'page-channel', isSettingsPage(String(context.location))));
  return { context, run, sync, cancel, request };
}

describe('合资格脚本独立世界', () => {
  it('依赖和原稿共享私有词法作用域，源码字节不变且不泄露全局', () => {
    const source = 'globalThis.observed = dictionary.label;';
    const h = harness({ source, requires: ["var dictionary = {label:'词库'};"] });
    expect(h.run('observed')).toBe('词库');
    expect(h.run('typeof dictionary')).toBe('undefined');
  });

  it('同步持久化确认发生在setValue返回前，失败不改变快照', () => {
    const h = harness();
    h.run(
      "fixture.GM_setValue('enabled',false); callbackResults.push(fixture.GM_getValue('enabled'));",
    );
    expect(h.sync).toHaveBeenCalledWith({ op: 'set-value', key: 'enabled', value: false });
    expect(h.run('callbackResults[0]')).toBe(false);
    h.sync.mockImplementationOnce(() => {
      throw new Error('存储失败');
    });
    expect(() => h.run("fixture.GM_setValue('enabled',true)")).toThrow('存储失败');
    expect(h.run("fixture.GM_getValue('enabled')")).toBe(false);
  });

  it('拒绝原型污染、访问器及超量值，不调用宿主', () => {
    const h = harness();
    expect(() => h.run("fixture.GM_setValue('__proto__',1)")).toThrow();
    expect(() =>
      h.run("fixture.GM_setValue('k',{get value(){throw new Error('不应执行')}})"),
    ).toThrow('访问器');
    expect(() => h.run("fixture.GM_setValue('k','x'.repeat(262145))")).toThrow();
    expect(h.sync).not.toHaveBeenCalled();
  });

  it('同文档SPA路径变化保留状态，撤销后菜单和API不可继续', () => {
    const h = harness();
    h.run(
      "location.pathname='/other'; globalThis.menu = fixture.GM_registerMenuCommand('菜单',()=>callbackResults.push('clicked'));",
    );
    h.run("__qualifiedDispatch({kind:'menu',commandId:menu})");
    expect(h.run('callbackResults.length')).toBe(1);
    h.run(
      "__qualifiedDispatch({kind:'revoke'}); __qualifiedDispatch({kind:'menu',commandId:menu});",
    );
    expect(h.run('callbackResults.length')).toBe(1);
    expect(() => h.run("fixture.GM_setValue('enabled',true)")).toThrow('失效');
  });

  it('数组访问器、空洞与额外属性均拒绝且不执行getter', () => {
    const h = harness();
    h.run(
      "globalThis.calls=0; globalThis.accessor=[]; Object.defineProperty(accessor,'0',{get(){calls++;return 1;},enumerable:true});",
    );
    expect(() => h.run("fixture.GM_setValue('array',accessor)")).toThrow();
    expect(h.run('calls')).toBe(0);
    expect(() => h.run("fixture.GM_setValue('array',new Array(2))")).toThrow();
    expect(() => h.run("fixture.GM_setValue('array',Object.assign([1],{extra:2}))")).toThrow();
    expect(h.sync).not.toHaveBeenCalled();
  });

  it('固定GitHub版本关闭简介翻译函数但保留本地词库汉化', () => {
    const h = harness({
      id: 'github-zh',
      version: '1.9.2.4-2026-09-27',
      source:
        "function transDesc(el) { globalThis.thirdParty=true; } transDesc('description'); globalThis.localLabel=dictionary.label;",
      requires: ["var dictionary={label:'问题'};"],
    });
    expect(h.run('typeof thirdParty')).toBe('undefined');
    expect(h.run('localLabel')).toBe('问题');
    expect(() =>
      harness({
        id: 'github-zh',
        version: '1.9.2.4-2026-09-27',
        source: 'globalThis.changed=true;',
      }),
    ).toThrow('资格适配');
  });

  it('值变更只通知对应key且传递remote，脚本资源来自冻结映射', () => {
    const h = harness();
    h.run(
      "fixture.GM_addValueChangeListener('enabled',(key,oldValue,newValue,remote)=>callbackResults.push({key,oldValue,newValue,remote}));",
    );
    h.run(
      "__qualifiedDispatch({kind:'value',key:'enabled',oldValue:true,newValue:false,remote:true});",
    );
    expect(h.run('callbackResults[0].remote')).toBe(true);
    expect(h.run("fixture.GM_getResourceText('style')")).toContain('color: red');
    expect(() => h.run("fixture.GM_getResourceText('../secret')")).toThrow('资格');
  });

  it('Github网络全部拒绝，AC拒绝POST与Cookie请求头', async () => {
    const gh = harness({ id: 'github-zh' });
    gh.run(
      "fixture.GM_xmlhttpRequest({url:'https://www.iflyrec.com/',method:'POST',onerror:()=>callbackResults.push('blocked')})",
    );
    const ac = harness();
    ac.run(
      "fixture.GM_xmlhttpRequest({url:'https://public.example/',headers:{Cookie:'private'},onerror:()=>callbackResults.push('blocked')})",
    );
    ac.run("fixture.GM_xmlhttpRequest({url:'https://public.example/',method:'POST'})");
    await Promise.resolve();
    expect(gh.request).not.toHaveBeenCalled();
    expect(ac.request).not.toHaveBeenCalled();
    expect(gh.run('callbackResults[0]')).toBe('blocked');
  });

  it('GET仅发闭合主协议，回执重建真实finalUrl而非敌手头', async () => {
    const h = harness();
    h.run(
      "fixture.GM_xmlhttpRequest({url:'https://public.example/',headers:{Accept:'*/*'},method:'GET',onload:response=>callbackResults.push(response)})",
    );
    await Promise.resolve();
    expect(h.request).toHaveBeenCalledWith({
      requestId: 'request-1',
      url: 'https://public.example/',
      method: 'GET',
      headers: { Accept: '*/*' },
    });
    expect(h.run('callbackResults[0].responseHeaders')).toContain(
      'tm-finalurlaibrowse: https://public.example/final',
    );
    expect(h.run('callbackResults[0].responseHeaders')).not.toContain('evil.example');
  });

  it('撤销取消在途请求且不执行迟到onload/onabort', async () => {
    const h = harness();
    let resolve: (value: unknown) => void = () => undefined;
    h.request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    h.run(
      "fixture.GM_xmlhttpRequest({url:'https://public.example/',onload:()=>callbackResults.push('load'),onabort:()=>callbackResults.push('abort')}); __qualifiedDispatch({kind:'revoke'});",
    );
    expect(h.cancel).toHaveBeenCalledWith('request-1');
    resolve({
      status: 200,
      statusText: 'OK',
      finalUrl: 'https://public.example/',
      responseText: '',
      responseHeaders: '',
    });
    await Promise.resolve();
    expect(h.run('callbackResults.length')).toBe(0);
  });

  it('设置桥只接受固定来源和配置key，hash路由继续可用', async () => {
    const h = harness({ url: 'https://ac-baidu.90dao.com/pages/custom/#baidu' });
    h.run(
      "fixture.unsafeWindow.AC_GM_Interface={get:async(key,value)=>({key,value}),save:async()=>{},change:async()=>{}}; location.hash='#google';",
    );
    h.run(
      "emit('message',{source:window,origin:location.origin,data:{channel:'page-channel',kind:'ac-call',requestId:'ok',method:'get',key:'ACConfig',value:'{}'}})",
    );
    h.run(
      "emit('message',{source:window,origin:'https://evil.example',data:{channel:'page-channel',kind:'ac-call',requestId:'bad',method:'get',key:'ACConfig',value:'{}'}})",
    );
    h.run(
      "emit('message',{source:window,origin:location.origin,data:{channel:'page-channel',kind:'ac-call',requestId:'badkey',method:'get',key:'apiKey',value:'{}'}})",
    );
    await Promise.resolve();
    expect(h.run('messages.length')).toBe(1);
    expect(h.run('messages[0].requestId')).toBe('ok');
  });

  it('main-world设置域名匹配不会接纳后缀伪造或其它路径', () => {
    expect(isSettingsPage('https://ibaidu.tujidu.com/pages/custom/#common')).toBe(true);
    for (const url of [
      'https://ac-baidu.90dao.com.evil.test/pages/custom/',
      'http://ac-baidu.90dao.com/pages/custom/',
      'https://ac-baidu.90dao.com/other/',
      'https://user@ac-baidu.90dao.com/pages/custom/',
    ])
      expect(isSettingsPage(url)).toBe(false);
  });

  it('sandbox入口不引入运行时共享chunk或向网页暴露通用桥', () => {
    const source = readFileSync(new URL('./qualified-userscripts.ts', import.meta.url), 'utf8');
    expect(source.match(/^import (?!type).*from /gmu)).toHaveLength(1);
    expect(source).not.toContain('exposeInMainWorld(');
    expect(source).not.toContain('ipcRenderer.invoke(channel');
  });

  it('document-end等待DOMContentLoaded，提前revoke后不再启动', () => {
    const domListener = vi.fn();
    vi.stubGlobal('process', { ...process, isMainFrame: true });
    vi.stubGlobal('location', new URL('https://github.com/test'));
    vi.stubGlobal('window', { addEventListener: vi.fn() });
    vi.stubGlobal('document', { readyState: 'loading', addEventListener: domListener });
    electronMocks.sync.mockReturnValueOnce([
      {
        id: 'github-zh',
        token: 'pending-end',
        worldId: 20002,
        source: '',
        requires: [],
        resources: {},
        values: {},
        name: '合成',
        version: '1',
        runAt: 'document-end',
      },
    ]);
    try {
      startQualifiedPreload();
      expect(electronMocks.execute).not.toHaveBeenCalled();
      expect(domListener).toHaveBeenCalledWith('DOMContentLoaded', expect.any(Function), {
        once: true,
      });
      const eventHandler = electronMocks.on.mock.calls.at(-1)?.[1] as (
        event: object,
        data: object,
      ) => void;
      eventHandler({}, { token: 'pending-end', kind: 'revoke' });
      const executeAfterReady = domListener.mock.calls[0][1] as () => void;
      executeAfterReady();
      expect(electronMocks.execute).toHaveBeenCalledTimes(1);
      expect(electronMocks.execute.mock.calls[0][1][0].code).toContain('__qualifiedDispatch');
    } finally {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  });

  it('子frame与非HTTP文档不请求prepare', () => {
    vi.stubGlobal('process', { ...process, isMainFrame: false });
    vi.stubGlobal('location', new URL('https://github.com/test'));
    try {
      startQualifiedPreload();
      expect(electronMocks.sync).not.toHaveBeenCalled();
      vi.stubGlobal('process', { ...process, isMainFrame: true });
      vi.stubGlobal('location', new URL('file:///private'));
      startQualifiedPreload();
      expect(electronMocks.sync).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.clearAllMocks();
    }
  });
});
