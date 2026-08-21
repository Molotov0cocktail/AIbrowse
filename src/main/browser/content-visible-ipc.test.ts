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
