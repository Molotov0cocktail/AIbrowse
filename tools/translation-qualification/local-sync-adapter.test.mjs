import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { Buffer } from 'node:buffer';
import { LOCAL_SYNC_ADAPTER_SOURCE } from './local-sync-adapter.mjs';

function fixture({
  enabled = true,
  promiseNative = false,
  existingStub = false,
  readonlyEvents = false,
  lockedMethod = false,
  failListenerRegistration = false,
  failSyncDefinition = false,
  autoInstall = true,
} = {}) {
  const raw = { localOnly: 'fixture' };
  const listeners = new Set();
  const runtime = {};
  let fail = false;
  const complete = (callback, value) => {
    if (promiseNative) return Promise.resolve(value);
    globalThis.queueMicrotask(() => {
      if (fail) runtime.lastError = { message: 'synthetic native failure' };
      try {
        callback(value);
      } finally {
        delete runtime.lastError;
      }
    });
  };
  const emit = (changes) => {
    if (Object.keys(changes).length) for (const listener of listeners) listener(changes, 'local');
  };
  const local = {
    get(keys, callback) {
      const selected = keys === null ? Object.keys(raw) : keys;
      return complete(
        callback,
        Object.fromEntries(selected.filter((key) => key in raw).map((key) => [key, raw[key]])),
      );
    },
    set(input, callback) {
      const changes = {};
      for (const [key, value] of Object.entries(input)) {
        changes[key] = { ...(key in raw ? { oldValue: raw[key] } : {}), newValue: value };
        raw[key] = value;
      }
      emit(changes);
      return complete(callback);
    },
    remove(keys, callback) {
      const changes = {};
      for (const key of keys) {
        if (!(key in raw)) continue;
        changes[key] = { oldValue: raw[key] };
        delete raw[key];
      }
      emit(changes);
      return complete(callback);
    },
    onChanged: {},
  };
  const chrome = {
    runtime,
    storage: {
      local,
      onChanged: {
        addListener(fn) {
          listeners.add(fn);
          if (failListenerRegistration) throw new Error('synthetic registration failure');
        },
        removeListener: (fn) => listeners.delete(fn),
        hasListener: (fn) => listeners.has(fn),
        hasListeners: () => listeners.size > 0,
      },
      ...(existingStub
        ? {
            sync: {
              get() {
                throw new Error('unavailable');
              },
            },
          }
        : {}),
    },
  };
  const originalEvents = chrome.storage.onChanged;
  const originalLocalEvents = local.onChanged;
  const originalSync = chrome.storage.sync;
  const originalDescriptors = Object.getOwnPropertyDescriptors(originalEvents);
  if (readonlyEvents) {
    Object.defineProperty(chrome.storage, 'onChanged', {
      get: () => originalEvents,
      configurable: false,
    });
    Object.defineProperty(local, 'onChanged', {
      get: () => originalLocalEvents,
      configurable: false,
    });
  }
  if (lockedMethod)
    Object.defineProperty(originalEvents, 'hasListeners', { writable: false, configurable: false });
  if (failSyncDefinition)
    chrome.storage = new Proxy(chrome.storage, {
      defineProperty(target, name, descriptor) {
        if (name === 'sync') throw new Error('synthetic definition failure');
        return Reflect.defineProperty(target, name, descriptor);
      },
    });
  // Compile our adapter in this realm; never evaluate any third-party script.
  const context = {
    chrome,
    TextEncoder: globalThis.TextEncoder,
    __AIBROWSE_LOCAL_SYNC_DIAGNOSTIC__: enabled
      ? { offline: true, freshProfile: true, syntheticDataOnly: true }
      : undefined,
  };
  const install = vm.compileFunction(LOCAL_SYNC_ADAPTER_SOURCE, ['globalThis']);
  if (autoInstall) install(context);
  return {
    chrome,
    sync: chrome.storage.sync,
    raw,
    originalEvents,
    originalLocalEvents,
    originalSync,
    originalDescriptors,
    nativeListenerCount: () => listeners.size,
    setFailure: (value) => (fail = value),
    again: () => install(context),
  };
}

const normalize = (value) => JSON.parse(JSON.stringify(value));

test('必须明确离线新profile合成数据诊断，重复安装幂等', () => {
  assert.throws(() => fixture({ enabled: false }), /离线/);
  const f = fixture();
  const sync = f.sync;
  f.again();
  assert.equal(f.chrome.storage.sync, sync);
  assert.equal(fixture({ existingStub: true }).sync.__aibrowseLocalDiagnostic, true);
});

test('只读onChanged accessor保持原对象，global/local事件仍正确分流', async () => {
  const f = fixture({ readonlyEvents: true, existingStub: true });
  assert.equal(f.chrome.storage.onChanged, f.originalEvents);
  assert.equal(f.chrome.storage.local.onChanged, f.originalLocalEvents);
  const events = [];
  const locals = [];
  f.chrome.storage.onChanged.addListener((change, area) => events.push([normalize(change), area]));
  f.chrome.storage.local.onChanged.addListener((change) => locals.push(normalize(change)));
  await f.sync.set({ fixture: 'sync' });
  await new Promise((resolve) => f.chrome.storage.local.set({ fixture: 'local' }, resolve));
  assert.deepEqual(events, [
    [{ fixture: { newValue: 'sync' } }, 'sync'],
    [{ fixture: { newValue: 'local' } }, 'local'],
  ]);
  assert.deepEqual(locals, [{ fixture: { newValue: 'local' } }]);
});

test('安装前不可补丁方法及注册中途失败均不留下半安装sync或事件方法', () => {
  for (const options of [
    { lockedMethod: true },
    { failSyncDefinition: true },
    { failListenerRegistration: true },
  ]) {
    const f = fixture({ ...options, autoInstall: false, readonlyEvents: true, existingStub: true });
    const before = Object.getOwnPropertyDescriptors(f.originalEvents);
    assert.throws(f.again);
    assert.equal(f.chrome.storage.sync, f.originalSync);
    assert.equal(f.chrome.storage.onChanged, f.originalEvents);
    assert.deepEqual(Object.getOwnPropertyDescriptors(f.originalEvents), before);
    assert.deepEqual(Object.getOwnPropertyDescriptors(f.originalLocalEvents), {});
    assert.equal(f.nativeListenerCount(), 0);
  }
});

test('sync使用独立前缀，get支持键、列表、默认值和全部', async () => {
  const f = fixture();
  await f.sync.set({ localOnly: 'sync-fixture', count: 2, nested: { list: [true, null] } });
  assert.equal(f.raw.localOnly, 'fixture');
  assert.equal(f.raw.__aibrowse_offline_sync_v1__localOnly, undefined);
  assert.equal(f.raw['__aibrowse_offline_sync_v1__:localOnly'], 'sync-fixture');
  assert.deepEqual(normalize(await f.sync.get('count')), { count: 2 });
  assert.deepEqual(normalize(await f.sync.get(['count', 'missing'])), { count: 2 });
  assert.deepEqual(normalize(await f.sync.get({ count: 0, missing: false })), {
    count: 2,
    missing: false,
  });
  assert.deepEqual(normalize(await f.sync.get()), normalize(await f.sync.get(null)));
  assert.equal(Object.keys(await f.sync.get(null)).length, 3);
});

test('clear/remove只能删除sync namespace，不清除local', async () => {
  const f = fixture();
  await f.sync.set({ one: 1, two: 2 });
  await f.sync.remove('one');
  assert.deepEqual(normalize(await f.sync.get()), { two: 2 });
  await f.sync.clear();
  assert.deepEqual(f.raw, { localOnly: 'fixture' });
});

test('全局事件区分sync/local且不泄漏前缀，area监听及移除保持正确', async () => {
  const f = fixture();
  const changes = [];
  const syncChanges = [];
  const localChanges = [];
  const listener = (value, area) => changes.push([normalize(value), area]);
  f.chrome.storage.onChanged.addListener(listener);
  f.sync.onChanged.addListener((value) => syncChanges.push(normalize(value)));
  f.chrome.storage.local.onChanged.addListener((value) => localChanges.push(normalize(value)));
  assert.equal(f.chrome.storage.onChanged.hasListener(listener), true);
  assert.equal(f.chrome.storage.onChanged.hasListeners(), true);
  await f.sync.set({ one: 1 });
  await f.sync.set({ one: 2 });
  await f.sync.remove('one');
  await new Promise((resolve) => f.chrome.storage.local.set({ localOnly: 'changed' }, resolve));
  assert.deepEqual(changes, [
    [{ one: { newValue: 1 } }, 'sync'],
    [{ one: { oldValue: 1, newValue: 2 } }, 'sync'],
    [{ one: { oldValue: 2 } }, 'sync'],
    [{ localOnly: { oldValue: 'fixture', newValue: 'changed' } }, 'local'],
  ]);
  assert.equal(syncChanges.length, 3);
  assert.equal(localChanges.length, 1);
  f.chrome.storage.onChanged.removeListener(listener);
  assert.equal(f.chrome.storage.onChanged.hasListeners(), false);
  await f.sync.set({ afterRemoval: true });
  assert.equal(changes.length, 4);
});

test('Chrome callback形式与Promise原生local均可用，字节统计不包含local键', async () => {
  for (const promiseNative of [false, true]) {
    const f = fixture({ promiseNative });
    await new Promise((resolve) => assert.equal(f.sync.set({ text: '中文' }, resolve), undefined));
    const result = await new Promise((resolve) => f.sync.get({ absent: 9 }, resolve));
    assert.deepEqual(normalize(result), { absent: 9 });
    assert.equal(await f.sync.getBytesInUse('text'), 4 + Buffer.byteLength('"中文"'));
    assert.equal(await new Promise((resolve) => f.sync.getBytesInUse(resolve)), 12);
  }
});

test('原生存储失败受控拒绝，callback期间lastError可见且随后还原', async () => {
  const f = fixture();
  f.setFailure(true);
  await assert.rejects(f.sync.get(), /存储操作失败/);
  const error = await new Promise((resolve) =>
    f.sync.get(() => resolve(f.chrome.runtime.lastError?.message)),
  );
  assert.equal(error, '本地同步诊断存储操作失败');
  assert.equal(f.chrome.runtime.lastError, undefined);
});

test('非法值、访问器、循环、危险键、越界以及无效签名在写入前拒绝', async () => {
  const f = fixture();
  const cycle = {};
  cycle.self = cycle;
  let getterRead = false;
  const getter = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      getterRead = true;
      return 1;
    },
  });
  for (const input of [
    { value: undefined },
    { value: NaN },
    { value: () => 1 },
    { value: new Date() },
    { value: 1n },
    cycle,
    getter,
    { value: 'x'.repeat(65537) },
    JSON.parse('{"__proto__":{"polluted":true}}'),
    { [Symbol('x')]: 'invalid' },
    { value: Array(2) },
  ])
    assert.throws(() => f.sync.set(input), /参数或预算无效/);
  assert.equal(getterRead, false);
  assert.throws(() => f.sync.remove(null), /参数或预算无效/);
  assert.throws(() => f.sync.clear('invalid'), /参数或预算无效/);
  assert.throws(() => f.sync.getBytesInUse({ value: 1 }), /参数或预算无效/);
  assert.throws(() => f.sync.get('__aibrowse_offline_sync_v1__:x'), /参数或预算无效/);
  assert.throws(() => f.sync.set({ valid: true }, 'invalidCallback'), /参数或预算无效/);
  await f.sync.set(Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`k${index}`, 1])));
  await assert.rejects(f.sync.set({ overflow: true }), /参数或预算无效/);
  assert.equal(Object.hasOwn(f.raw, '__aibrowse_offline_sync_v1__:overflow'), false);
});
