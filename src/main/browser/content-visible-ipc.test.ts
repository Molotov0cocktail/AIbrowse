// C8 决议 #158(4) 回归：受控 UI send 通道 ui:browser-content-visible 的 payload
// 严格白名单 fail-closed 边界。真实 IPC handler 边界（sender+主帧校验门 + payload
// 门 + setContentVisible 恰好一次/零次）由 handleUiBrowserContentVisible 直接验证
// （index.ts 只做事件解包委托，语义恒等——Electron 壳薄胶水分层纪律）。未知字段/
// 原型链键/array/null/primitive/错误类型全拒 + warn + 零调用；合法 {visible:boolean}
// 恰好一次 + 参数正确；sender/主帧校验失败拒 + warn + 零调用。
import { describe, expect, it, vi } from 'vitest';
import {
  handleUiBrowserContentVisible,
  validateUiBrowserContentVisiblePayload,
} from './content-visible-ipc';

describe('validateUiBrowserContentVisiblePayload（决议 #158(4) 严格白名单）', () => {
  it('接受 { visible: true } / { visible: false }——自有字段精确存在', () => {
    expect(validateUiBrowserContentVisiblePayload({ visible: true })).toEqual({
      ok: true,
      visible: true,
    });
    expect(validateUiBrowserContentVisiblePayload({ visible: false })).toEqual({
      ok: true,
      visible: false,
    });
  });

  it('extra field：{visible, unexpected} 拒绝', () => {
    expect(validateUiBrowserContentVisiblePayload({ visible: true, unexpected: 'x' }).ok).toBe(
      false,
    );
    expect(validateUiBrowserContentVisiblePayload({ visible: false, extra: 1 }).ok).toBe(false);
  });

  it('missing field：{} 拒绝', () => {
    expect(validateUiBrowserContentVisiblePayload({}).ok).toBe(false);
  });

  it('inherited-only：原型链上的 visible 不是自有字段，拒绝', () => {
    expect(validateUiBrowserContentVisiblePayload(Object.create({ visible: true })).ok).toBe(false);
    expect(validateUiBrowserContentVisiblePayload(Object.create({ visible: false })).ok).toBe(
      false,
    );
  });

  it('array：[true] 与带 visible 属性的 array 拒绝', () => {
    expect(validateUiBrowserContentVisiblePayload([true]).ok).toBe(false);
    const arrWithVisible = [true] as unknown as { visible?: unknown };
    arrWithVisible.visible = true;
    expect(validateUiBrowserContentVisiblePayload(arrWithVisible).ok).toBe(false);
  });

  it('null 与 primitive 拒绝', () => {
    for (const bad of [null, true, false, 1, 'true', undefined]) {
      expect(validateUiBrowserContentVisiblePayload(bad).ok).toBe(false);
    }
  });

  it('wrong type：{visible:"true"|1|null|undefined} 拒绝', () => {
    for (const bad of [
      { visible: 'true' },
      { visible: 1 },
      { visible: null },
      { visible: undefined },
    ]) {
      expect(validateUiBrowserContentVisiblePayload(bad).ok).toBe(false);
    }
  });
});

describe('handleUiBrowserContentVisible（真实 IPC handler 边界）', () => {
  const TRUSTED = true;
  const UNTRUSTED = false;

  function run(payload: unknown, isTrusted: boolean) {
    const warns: string[] = [];
    const setContentVisible = vi.fn();
    handleUiBrowserContentVisible(payload, {
      isTrusted,
      warn: (message) => warns.push(message),
      setContentVisible,
    });
    return { warns, setContentVisible };
  }

  it('合法 { visible: true }：可信 sender → setContentVisible 恰好一次 + 参数 true + 零 warn', () => {
    const { warns, setContentVisible } = run({ visible: true }, TRUSTED);
    expect(setContentVisible).toHaveBeenCalledTimes(1);
    expect(setContentVisible).toHaveBeenCalledWith(true);
    expect(warns).toHaveLength(0);
  });

  it('合法 { visible: false }：setContentVisible 恰好一次 + 参数 false', () => {
    const { warns, setContentVisible } = run({ visible: false }, TRUSTED);
    expect(setContentVisible).toHaveBeenCalledTimes(1);
    expect(setContentVisible).toHaveBeenCalledWith(false);
    expect(warns).toHaveLength(0);
  });

  it('未知字段 / 原型链 / array / null / primitive / 错误类型：warn + setContentVisible 零次调用', () => {
    const rejects: unknown[] = [
      { visible: true, unexpected: 'x' },
      {},
      Object.create({ visible: true }),
      [true],
      null,
      true,
      'true',
      { visible: 'true' },
      { visible: 1 },
      { visible: null },
      { visible: undefined },
    ];
    for (const bad of rejects) {
      const { warns, setContentVisible } = run(bad, TRUSTED);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toContain('忽略非法 content-visible 载荷');
      expect(setContentVisible).toHaveBeenCalledTimes(0);
    }
  });

  it('sender/主帧校验：isTrusted=false → 拒绝 + warn + setContentVisible 零次调用（即使 payload 合法）', () => {
    const { warns, setContentVisible } = run({ visible: true }, UNTRUSTED);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('拒绝非主窗口的 IPC 消息');
    expect(warns[0]).toContain('ui:browser-content-visible');
    expect(setContentVisible).toHaveBeenCalledTimes(0);
  });
});

// —— C10 阻断缺陷甄别（93f2ed5 上必须真实失败/抛穿的补充甄别用例） ——
// 甄别点 1：isPlainRecord 不校验原型——Date/Map/class 实例/自定义原型/
// Object.create(null) 均被当作普通 record；ownKeys 用 Object.keys——漏掉
// 非枚举键与 Symbol 键；accessor visible 会被读取（getter 可抛穿）或凭
// 原型链/类型被误收。
describe('validateUiBrowserContentVisiblePayload（原型/自有键全集/accessor 甄别）', () => {
  it('自有 visible + 自定义原型未知字段：拒绝（Object.keys 只看自身可枚举字符串键）', () => {
    const payload = Object.assign(Object.create({ unexpected: 'x' }), { visible: true });
    expect(validateUiBrowserContentVisiblePayload(payload)).toEqual({ ok: false });
  });

  it('非枚举 extra field：拒绝（Object.keys 漏掉非枚举自有键）', () => {
    const payload = { visible: true };
    Object.defineProperty(payload, 'unexpected', { value: 'x', enumerable: false });
    expect(validateUiBrowserContentVisiblePayload(payload)).toEqual({ ok: false });
  });

  it('Symbol extra field：拒绝（Object.keys 漏掉 Symbol 自有键）', () => {
    const payload: Record<string | symbol, unknown> = { visible: true };
    payload[Symbol('unexpected')] = 'x';
    expect(validateUiBrowserContentVisiblePayload(payload)).toEqual({ ok: false });
  });

  it('非普通对象（Date 实例带自有 visible）：拒绝', () => {
    const payload = Object.assign(new Date(), { visible: true });
    expect(validateUiBrowserContentVisiblePayload(payload)).toEqual({ ok: false });
  });

  it('非普通对象（Map 实例带自有 visible）：拒绝', () => {
    const payload = Object.assign(new Map(), { visible: true });
    expect(validateUiBrowserContentVisiblePayload(payload)).toEqual({ ok: false });
  });

  it('非普通对象（class instance 带自有 visible）：拒绝', () => {
    class Foo {
      visible = true;
    }
    expect(validateUiBrowserContentVisiblePayload(new Foo())).toEqual({ ok: false });
  });

  it('非普通对象（Object.create(null) 带 visible）：拒绝（原型不是 Object.prototype）', () => {
    const payload = Object.assign(Object.create(null), { visible: true });
    expect(validateUiBrowserContentVisiblePayload(payload)).toEqual({ ok: false });
  });

  it('accessor visible（getter 返回 true）：拒绝（不是 data property，不读取取值）', () => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, 'visible', {
      get: () => true,
      enumerable: true,
      configurable: true,
    });
    expect(validateUiBrowserContentVisiblePayload(payload)).toEqual({ ok: false });
  });

  it('accessor visible（getter 直接抛错）：validator 不抛穿 + 拒绝', () => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, 'visible', {
      get: () => {
        throw new Error('boom');
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => validateUiBrowserContentVisiblePayload(payload)).not.toThrow();
    expect(validateUiBrowserContentVisiblePayload(payload)).toEqual({ ok: false });
  });

  it('反射 getPrototypeOf trap 抛错的 Proxy：validator 不抛穿 + 拒绝', () => {
    const payload = new Proxy(
      { visible: true },
      {
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    expect(() => validateUiBrowserContentVisiblePayload(payload)).not.toThrow();
    expect(validateUiBrowserContentVisiblePayload(payload)).toEqual({ ok: false });
  });

  it('反射 ownKeys trap 抛错的 Proxy：validator 不抛穿 + 拒绝', () => {
    const payload = new Proxy(
      { visible: true },
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(() => validateUiBrowserContentVisiblePayload(payload)).not.toThrow();
    expect(validateUiBrowserContentVisiblePayload(payload)).toEqual({ ok: false });
  });
});

describe('handleUiBrowserContentVisible（敌意输入 fail-closed + 固定脱敏 warn + 零副作用）', () => {
  const TRUSTED = true;
  const FIXED_WARN = '忽略非法 content-visible 载荷';

  function run(payload: unknown) {
    const warns: string[] = [];
    const setContentVisible = vi.fn();
    handleUiBrowserContentVisible(payload, {
      isTrusted: TRUSTED,
      warn: (message) => warns.push(message),
      setContentVisible,
    });
    return { warns, setContentVisible };
  }

  it('自有 visible + 自定义原型未知字段：handler 不抛 + warn 恰好一次 + 固定文案 + setContentVisible 零次', () => {
    const payload = Object.assign(Object.create({ unexpected: 'x' }), { visible: true });
    const { warns, setContentVisible } = run(payload);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe(FIXED_WARN);
    expect(setContentVisible).toHaveBeenCalledTimes(0);
  });

  it('非枚举/Symbol extra field：handler 拒绝 + warn 恰好一次 + 零副作用', () => {
    const nonEnum: Record<string, unknown> = { visible: true };
    Object.defineProperty(nonEnum, 'unexpected', { value: 'x', enumerable: false });
    const symbolPayload: Record<string | symbol, unknown> = { visible: true };
    symbolPayload[Symbol('unexpected')] = 'x';
    for (const payload of [nonEnum, symbolPayload]) {
      const { warns, setContentVisible } = run(payload);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toBe(FIXED_WARN);
      expect(setContentVisible).toHaveBeenCalledTimes(0);
    }
  });

  it('非普通对象（Date/Map/class 实例/Object.create(null)）：handler 全部拒绝 + warn 恰好一次 + 零副作用', () => {
    class Foo {
      visible = true;
    }
    const hostile: unknown[] = [
      Object.assign(new Date(), { visible: true }),
      Object.assign(new Map(), { visible: true }),
      new Foo(),
      Object.assign(Object.create(null), { visible: true }),
    ];
    for (const payload of hostile) {
      const { warns, setContentVisible } = run(payload);
      expect(warns).toHaveLength(1);
      expect(warns[0]).toBe(FIXED_WARN);
      expect(setContentVisible).toHaveBeenCalledTimes(0);
    }
  });

  it('accessor visible（getter 返回 true）：拒绝，不读取 getter 值', () => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, 'visible', {
      get: () => true,
      enumerable: true,
      configurable: true,
    });
    const { warns, setContentVisible } = run(payload);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe(FIXED_WARN);
    expect(setContentVisible).toHaveBeenCalledTimes(0);
  });

  it('accessor visible（getter 直接抛错）：handler 不抛穿 + warn 恰好一次 + 零副作用', () => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, 'visible', {
      get: () => {
        throw new Error('boom');
      },
      enumerable: true,
      configurable: true,
    });
    expect(() => run(payload)).not.toThrow();
    const { warns, setContentVisible } = run(payload);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe(FIXED_WARN);
    expect(setContentVisible).toHaveBeenCalledTimes(0);
  });

  it('反射 getPrototypeOf trap 抛错的 Proxy：handler 不抛穿 + 受控拒绝', () => {
    const payload = new Proxy(
      { visible: true },
      {
        getPrototypeOf() {
          throw new Error('boom');
        },
      },
    );
    expect(() => run(payload)).not.toThrow();
    const { warns, setContentVisible } = run(payload);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe(FIXED_WARN);
    expect(setContentVisible).toHaveBeenCalledTimes(0);
  });

  it('反射 ownKeys trap 抛错的 Proxy：handler 不抛穿 + 受控拒绝', () => {
    const payload = new Proxy(
      { visible: true },
      {
        ownKeys() {
          throw new Error('boom');
        },
      },
    );
    expect(() => run(payload)).not.toThrow();
    const { warns, setContentVisible } = run(payload);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe(FIXED_WARN);
    expect(setContentVisible).toHaveBeenCalledTimes(0);
  });

  it('poisoned string conversion（{visible:"bad", toString:null}）：handler 不抛穿 + warn 固定文案 + 不含 payload 原文 + 零副作用', () => {
    const payload = Object.assign({ visible: 'bad' }, { toString: null });
    expect(() => run(payload)).not.toThrow();
    const { warns, setContentVisible } = run(payload);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toBe(FIXED_WARN);
    expect(warns[0]).not.toContain('bad');
    expect(setContentVisible).toHaveBeenCalledTimes(0);
  });
});
