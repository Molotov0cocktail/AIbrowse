import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DataTransferStatus } from '../../../shared/types/data-transfer';
import type { ConversationStorageStatus } from '../../../shared/types/conversation';
import { LocalDataPanel } from './LocalDataPanel';

const hooks = vi.hoisted(() => ({
  cursor: 0,
  values: [] as unknown[],
  effects: [] as Array<() => (() => void) | void>,
  writes: 0,
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.values)) hooks.values[i] = initial;
    return [
      hooks.values[i],
      (next: unknown) => {
        hooks.values[i] = next;
        hooks.writes++;
      },
    ];
  },
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.values)) hooks.values[i] = { current: initial };
    return hooks.values[i];
  },
  useEffect: (effect: () => (() => void) | void) => hooks.effects.push(effect),
}));
interface Element {
  type: unknown;
  props: { children?: unknown; onClick?: () => void; disabled?: boolean; role?: string };
}
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== 'object' || value === null || !('props' in value)) return [];
  const node = value as Element;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && 'props' in value)
    return text((value as Element).props.children);
  return '';
}
function render() {
  hooks.cursor = 0;
  return LocalDataPanel();
}
function button(label: string) {
  return nodes(render()).find((n) => n.type === 'button' && text(n.props.children) === label)!;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function drain() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}
const idle: DataTransferStatus = {
  operationId: null,
  action: null,
  state: 'idle',
  code: 'none',
  message: '尚未执行数据操作',
  canCancel: false,
  canRecoverOriginal: false,
  availableActions: ['backup', 'restore'],
};
const active: DataTransferStatus = {
  ...idle,
  operationId: '7f24a960-dd65-4ef2-a04a-742c0e87c845',
  action: 'backup',
  state: 'validating',
  message: '正在验证备份',
  canCancel: true,
  availableActions: [],
};
const cleanups: Array<() => void> = [];
function mount(read = vi.fn(async () => idle)) {
  const bridge = {
    dataTransfer: {
      getStatus: read,
      start: vi.fn(async () => active),
      cancel: vi.fn(async () => ({ ...active, state: 'cancelled' as const })),
      recoverOriginal: vi.fn(async () => idle),
    },
    getConversationStorageStatus: vi.fn(async (): Promise<ConversationStorageStatus> => ({
      state: 'ready',
      code: null,
    })),
  };
  vi.stubGlobal('window', { aibrowse: bridge });
  render();
  const setup = hooks.effects[0]!;
  const cleanup = setup();
  if (cleanup) cleanups.push(cleanup);
  return { bridge, setup, cleanup };
}
beforeEach(() => {
  vi.useFakeTimers();
  hooks.cursor = 0;
  hooks.values = [];
  hooks.effects = [];
  hooks.writes = 0;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('恢复专用能力只开放选择备份，backup点击及进行中重复操作均拒绝', async () => {
  const f = mount(
    vi.fn(async (): Promise<DataTransferStatus> => ({
      ...idle,
      state: 'recovery-required',
      availableActions: ['restore'],
    })),
  );
  await drain();
  expect(button('备份本地数据').props.disabled).toBe(true);
  expect(button('选择备份恢复').props.disabled).toBe(false);
  button('备份本地数据').props.onClick!();
  expect(f.bridge.dataTransfer.start).not.toHaveBeenCalled();
  button('选择备份恢复').props.onClick!();
  await drain();
  expect(f.bridge.dataTransfer.start).toHaveBeenCalledExactlyOnceWith('restore');
  expect(button('选择备份恢复').props.disabled).toBe(true);
});

it('真实面板明确范围与隐私，备份只发action，取消只发main返回UUID', async () => {
  const f = mount();
  await drain();
  expect(text(render())).toContain('Cookie');
  expect(text(render())).toContain('关闭当前标签页');
  button('备份本地数据').props.onClick!();
  await drain();
  expect(f.bridge.dataTransfer.start).toHaveBeenCalledExactlyOnceWith('backup');
  button('取消当前操作').props.onClick!();
  await drain();
  expect(f.bridge.dataTransfer.cancel).toHaveBeenCalledExactlyOnceWith(active.operationId);
});
it('挂起状态读取最多一个，超时显示固定错误且不积累请求', async () => {
  const pending = deferred<DataTransferStatus>();
  const read = vi.fn(() => pending.promise);
  mount(read);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(read).toHaveBeenCalledOnce();
  expect(text(render())).toContain('状态暂不可用');
  pending.resolve(idle);
  await drain();
  await vi.advanceTimersByTimeAsync(2000);
  expect(read).toHaveBeenCalledTimes(2);
});
it('startup恢复失败和Conversation持久失败可见，不因其他API拒绝崩溃', async () => {
  const f = mount(
    vi.fn(async () => ({
      ...active,
      state: 'recovery-required',
      code: 'recovery',
      message: '数据恢复需要处理',
      canCancel: false,
      canRecoverOriginal: true,
    })),
  );
  f.bridge.getConversationStorageStatus.mockResolvedValue({
    state: 'recovery-required',
    code: 'io',
  });
  await drain();
  await vi.advanceTimersByTimeAsync(500);
  await drain();
  expect(text(render())).toContain('数据恢复需要处理');
  expect(text(render())).toContain('不能确认已保存');
  button('恢复原数据运行').props.onClick!();
  await drain();
  expect(f.bridge.dataTransfer.recoverOriginal).toHaveBeenCalledWith(active.operationId);
});
it('卸载及effect重建后旧请求不得覆盖新状态', async () => {
  const old = deferred<DataTransferStatus>();
  const f = mount(vi.fn(() => old.promise));
  f.cleanup?.();
  const writes = hooks.writes;
  old.resolve(active);
  await drain();
  expect(hooks.writes).toBe(writes);
  f.bridge.dataTransfer.getStatus.mockResolvedValue(idle);
  const cleanup = f.setup();
  if (cleanup) cleanups.push(cleanup);
  await drain();
  expect(text(render())).toContain(idle.message);
});
it('轮询旧结果不能覆盖按钮返回的新终态，拒绝内容不展示', async () => {
  const old = deferred<DataTransferStatus>();
  const read = vi.fn(async () => idle);
  const f = mount(read);
  await drain();
  read.mockReturnValueOnce(old.promise);
  await vi.advanceTimersByTimeAsync(2000);
  f.bridge.dataTransfer.start.mockResolvedValue({
    ...active,
    state: 'completed',
    message: '备份已完成',
    availableActions: ['backup', 'restore'],
  });
  button('备份本地数据').props.onClick!();
  await drain();
  old.resolve(active);
  await drain();
  expect(text(render())).toContain('备份已完成');
  f.bridge.dataTransfer.start.mockRejectedValue(new Error('D:/private/secret'));
  button('选择备份恢复').props.onClick!();
  await drain();
  expect(text(render())).not.toContain('secret');
  expect(text(render())).toContain('操作未完成');
});

it('卸载后按钮迟到回执不得写入组件，连续点击也只派发一次', async () => {
  const f = mount();
  await drain();
  const pending = deferred<DataTransferStatus>();
  f.bridge.dataTransfer.start.mockReturnValue(pending.promise);
  const start = button('备份本地数据').props.onClick!;
  start();
  start();
  expect(f.bridge.dataTransfer.start).toHaveBeenCalledOnce();
  f.cleanup?.();
  const writes = hooks.writes;
  pending.resolve(active);
  await drain();
  expect(hooks.writes).toBe(writes);
});

it('会话状态API拒绝不阻断备份入口，固定错误不回显拒绝正文', async () => {
  const f = mount();
  f.bridge.getConversationStorageStatus.mockRejectedValue(new Error('私密路径正文'));
  await drain();
  await vi.advanceTimersByTimeAsync(2000);
  expect(text(render())).toContain('不能确认已保存');
  expect(text(render())).not.toContain('私密路径正文');
  expect(button('备份本地数据').props.disabled).toBe(false);
  button('备份本地数据').props.onClick!();
  await drain();
  expect(f.bridge.dataTransfer.start).toHaveBeenCalledExactlyOnceWith('backup');
});

it('effect重建时复用在途槽，不重发挂起IPC，旧返回不被新effect接纳', async () => {
  const pending = deferred<DataTransferStatus>();
  const read = vi.fn(() => pending.promise);
  const f = mount(read);
  f.cleanup?.();
  const cleanup = f.setup();
  if (cleanup) cleanups.push(cleanup);
  await vi.advanceTimersByTimeAsync(4000);
  expect(read).toHaveBeenCalledOnce();
  pending.resolve(active);
  await drain();
  expect(text(render())).not.toContain(active.message);
  read.mockResolvedValue(idle);
  await vi.advanceTimersByTimeAsync(2000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(text(render())).toContain(idle.message);
});

it('状态API拒绝显示错误并禁用启动，后续单次读取可恢复', async () => {
  const read = vi.fn(async (): Promise<DataTransferStatus> => {
    throw new Error('私密错误');
  });
  mount(read);
  await drain();
  expect(text(render())).toContain('状态暂不可用');
  expect(button('备份本地数据').props.disabled).toBe(true);
  read.mockResolvedValue(idle);
  await vi.advanceTimersByTimeAsync(2000);
  expect(button('备份本地数据').props.disabled).toBe(false);
  expect(text(render())).not.toContain('私密错误');
});

it('effect在原请求第九秒重建仍于原第十秒显示超时，不续租不重发', async () => {
  const read = vi.fn(() => new Promise<DataTransferStatus>(() => {}));
  const f = mount(read);
  await vi.advanceTimersByTimeAsync(9000);
  f.cleanup?.();
  const cleanup = f.setup();
  if (cleanup) cleanups.push(cleanup);
  await vi.advanceTimersByTimeAsync(999);
  expect(text(render())).not.toContain('本地数据状态暂不可用');
  await vi.advanceTimersByTimeAsync(1);
  expect(text(render())).toContain('本地数据状态暂不可用');
  expect(read).toHaveBeenCalledOnce();
});

it('转移状态长期pending也不阻断会话持久失败的新状态', async () => {
  const read = vi.fn(() => new Promise<DataTransferStatus>(() => {}));
  const f = mount(read);
  await drain();
  f.bridge.getConversationStorageStatus.mockResolvedValue({
    state: 'recovery-required',
    code: 'io',
  });
  await vi.advanceTimersByTimeAsync(2000);
  expect(text(render())).toContain('会话保存失败');
  expect(read).toHaveBeenCalledOnce();
  expect(f.bridge.getConversationStorageStatus).toHaveBeenCalledTimes(2);
});
