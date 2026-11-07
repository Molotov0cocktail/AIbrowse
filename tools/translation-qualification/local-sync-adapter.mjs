// This adapter is exclusively for an offline probe with a fresh, synthetic profile.
// It does not provide cloud synchronization or permit importing user data.
function installLocalSyncDiagnostic() {
  'use strict';
  const consent = globalThis.__AIBROWSE_LOCAL_SYNC_DIAGNOSTIC__;
  if (
    !consent ||
    consent.offline !== true ||
    consent.freshProfile !== true ||
    consent.syntheticDataOnly !== true
  )
    throw new Error('本地同步诊断必须使用离线、全新、仅合成数据的配置');
  const chrome = globalThis.chrome;
  const storage = chrome?.storage;
  const local = storage?.local;
  const nativeChanges = storage?.onChanged;
  if (!local || !nativeChanges?.addListener || !nativeChanges?.removeListener || !chrome.runtime)
    throw new Error('本地同步诊断缺少原生 local storage');
  if (storage.sync?.__aibrowseLocalDiagnostic === true) return;
  // Electron exposes an unavailable sync stub; the explicit probe flags authorize replacing it.
  const prefix = '__aibrowse_offline_sync_v1__:';
  const encoder = new globalThis.TextEncoder();
  const invalid = () => new Error('本地同步诊断参数或预算无效');
  const plain = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };
  const key = (value) => {
    if (
      typeof value !== 'string' ||
      value.length < 1 ||
      value.length > 256 ||
      value.startsWith(prefix) ||
      ['__proto__', 'prototype', 'constructor'].includes(value)
    )
      throw invalid();
    return value;
  };
  const clone = (input) => {
    let nodes = 0;
    const seen = new Set();
    const visit = (value, depth) => {
      if (++nodes > 10000 || depth > 32) throw invalid();
      if (value === null || typeof value === 'boolean') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string' && value.length <= 65536) return value;
      if ((!plain(value) && !Array.isArray(value)) || seen.has(value)) throw invalid();
      seen.add(value);
      const out = Array.isArray(value) ? [] : {};
      if (Reflect.ownKeys(value).some((name) => typeof name !== 'string')) throw invalid();
      if (Array.isArray(value) && Object.keys(value).length !== value.length) throw invalid();
      for (const name of Object.keys(value)) {
        key(name);
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (!descriptor || !('value' in descriptor)) throw invalid();
        Object.defineProperty(out, name, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      seen.delete(value);
      return out;
    };
    const result = visit(input, 0);
    if (encoder.encode(JSON.stringify(result)).length > 1024 * 1024) throw invalid();
    return result;
  };
  const select = (input, defaultsAllowed) => {
    if (input === null || input === undefined) return null;
    if (typeof input === 'string') return [key(input)];
    if (Array.isArray(input)) {
      if (input.length > 256) throw invalid();
      return [...new Set(input.map(key))];
    }
    if (defaultsAllowed && plain(input)) return Object.keys(clone(input)).map(key);
    throw invalid();
  };
  const native = (method, value) =>
    new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        if (error) reject(new Error('本地同步诊断存储操作失败'));
        else resolve(result);
      };
      try {
        const result = local[method](value, (data) => finish(chrome.runtime.lastError, data));
        if (result?.then)
          result.then(
            (data) => finish(null, data),
            (error) => finish(error),
          );
      } catch (error) {
        finish(error);
      }
    });
  const callbackResult = (operation, callback) => {
    if (callback === undefined) return operation;
    operation.then(
      (result) => callback(result),
      () => {
        const previous = Object.getOwnPropertyDescriptor(chrome.runtime, 'lastError');
        Object.defineProperty(chrome.runtime, 'lastError', {
          configurable: true,
          value: { message: '本地同步诊断存储操作失败' },
        });
        try {
          callback();
        } finally {
          if (previous) Object.defineProperty(chrome.runtime, 'lastError', previous);
          else delete chrome.runtime.lastError;
        }
      },
    );
    return undefined;
  };
  const signature = (args, minimum, maximum) => {
    const values = [...args];
    const callback = typeof values.at(-1) === 'function' ? values.pop() : undefined;
    if (values.length < minimum || values.length > maximum) throw invalid();
    return { values, callback };
  };
  const read = async (names) => {
    const raw = await native('get', names === null ? null : names.map((name) => prefix + name));
    const out = {};
    for (const [name, value] of Object.entries(raw ?? {})) {
      if (!name.startsWith(prefix)) continue;
      out[key(name.slice(prefix.length))] = clone(value);
    }
    if (Object.keys(out).length > 256) throw invalid();
    return clone(out);
  };
  // Serialize mutations in this context; independent probe contexts share native storage.
  let pending = Promise.resolve();
  const mutate = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };
  const listeners = () => {
    const callbacks = new Set();
    return {
      event: {
        addListener(fn) {
          if (typeof fn !== 'function') throw invalid();
          callbacks.add(fn);
        },
        removeListener(fn) {
          callbacks.delete(fn);
        },
        hasListener(fn) {
          return callbacks.has(fn);
        },
        hasListeners() {
          return callbacks.size > 0;
        },
      },
      emit(changes, area) {
        for (const fn of callbacks) {
          try {
            fn(clone(changes), area);
          } catch {
            // One listener must not suppress other listeners or expose input values.
          }
        }
      },
    };
  };
  const globalEvents = listeners();
  const syncEvents = listeners();
  const localEvents = listeners();
  const sync = {
    __aibrowseLocalDiagnostic: true,
    get(...args) {
      const { values, callback } = signature(args, 0, 1);
      const input = values[0];
      const names = select(input, true);
      const defaults = plain(input) ? clone(input) : {};
      return callbackResult(
        read(names).then((found) => ({ ...defaults, ...found })),
        callback,
      );
    },
    set(...args) {
      const { values, callback } = signature(args, 1, 1);
      if (!plain(values[0])) throw invalid();
      const input = clone(values[0]);
      if (Object.keys(input).length > 256) throw invalid();
      return callbackResult(
        mutate(async () => {
          const merged = clone({ ...(await read(null)), ...input });
          if (Object.keys(merged).length > 256) throw invalid();
          const mapped = Object.fromEntries(
            Object.entries(input).map(([name, value]) => [prefix + key(name), value]),
          );
          if (Object.keys(mapped).length) await native('set', mapped);
        }),
        callback,
      );
    },
    remove(...args) {
      const { values, callback } = signature(args, 1, 1);
      const names = select(values[0], false);
      if (names === null) throw invalid();
      return callbackResult(
        mutate(async () => {
          if (names.length)
            await native(
              'remove',
              names.map((name) => prefix + name),
            );
        }),
        callback,
      );
    },
    clear(...args) {
      const { callback } = signature(args, 0, 0);
      return callbackResult(
        mutate(async () => {
          const names = Object.keys(await read(null));
          if (names.length)
            await native(
              'remove',
              names.map((name) => prefix + name),
            );
        }),
        callback,
      );
    },
    getBytesInUse(...args) {
      const { values, callback } = signature(args, 0, 1);
      const names = select(values[0], false);
      return callbackResult(
        read(names).then((found) =>
          Object.entries(found).reduce(
            (total, [name, value]) =>
              total + encoder.encode(name).length + encoder.encode(JSON.stringify(value)).length,
            0,
          ),
        ),
        callback,
      );
    },
    onChanged: syncEvents.event,
  };
  const relay = (changes, area) => {
    if (area !== 'local') {
      globalEvents.emit(changes, area);
      return;
    }
    const localChanges = {};
    const syncChanges = {};
    for (const [name, change] of Object.entries(changes)) {
      if (name.startsWith(prefix)) syncChanges[key(name.slice(prefix.length))] = change;
      else localChanges[name] = change;
    }
    if (Object.keys(localChanges).length) {
      globalEvents.emit(localChanges, 'local');
      localEvents.emit(localChanges);
    }
    if (Object.keys(syncChanges).length) {
      globalEvents.emit(syncChanges, 'sync');
      syncEvents.emit(syncChanges);
    }
  };
  // Event properties are getter-only in Electron. Keep their identities and patch methods.
  const addNativeListener = nativeChanges.addListener.bind(nativeChanges);
  const removeNativeListener = nativeChanges.removeListener.bind(nativeChanges);
  const patches = [];
  const plan = (target, name, value) => {
    const previous = Object.getOwnPropertyDescriptor(target, name);
    if (
      (!previous && !Object.isExtensible(target)) ||
      (previous && !previous.configurable && (!('value' in previous) || !previous.writable))
    )
      throw new Error('本地同步诊断安装能力不足');
    const replacement =
      previous && 'value' in previous
        ? { ...previous, value }
        : { value, configurable: true, writable: true, enumerable: previous?.enumerable ?? true };
    patches.push({ target, name, previous, replacement });
  };
  for (const name of Object.keys(globalEvents.event))
    plan(nativeChanges, name, globalEvents.event[name]);
  const nativeLocalChanges = local.onChanged;
  if (nativeLocalChanges) {
    if (nativeLocalChanges === nativeChanges) throw new Error('本地同步诊断事件对象冲突');
    for (const name of Object.keys(localEvents.event))
      plan(nativeLocalChanges, name, localEvents.event[name]);
  }
  plan(storage, 'sync', sync);
  let attemptedRegistration = false;
  const applied = [];
  try {
    for (const patch of patches) {
      Object.defineProperty(patch.target, patch.name, patch.replacement);
      applied.push(patch);
    }
    attemptedRegistration = true;
    addNativeListener(relay);
  } catch {
    let rollbackFailed = false;
    if (attemptedRegistration) {
      try {
        removeNativeListener(relay);
      } catch {
        rollbackFailed = true;
      }
    }
    for (const patch of applied.reverse()) {
      try {
        if (patch.previous) Object.defineProperty(patch.target, patch.name, patch.previous);
        else delete patch.target[patch.name];
      } catch {
        rollbackFailed = true;
      }
    }
    if (rollbackFailed) throw new Error('本地同步诊断安装及撤销失败，必须销毁诊断上下文');
    throw new Error('本地同步诊断安装失败，已撤销适配');
  }
}

export const LOCAL_SYNC_ADAPTER_SOURCE = `;(${installLocalSyncDiagnostic.toString()})();\n`;
export const localSyncAdapterSource = LOCAL_SYNC_ADAPTER_SOURCE;
