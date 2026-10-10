import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DataTransferStatus } from '../../src/shared/types/data-transfer';

// Execute the actual component and effects with deterministic hooks and clock.
// This covers state ownership, not DOM layout or Electron rendering.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as Array<() => (() => void) | void>,
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = initial;
    return [hooks.slots[i], (value: unknown) => (hooks.slots[i] = value)];
  },
  useRef: (initial: unknown) => {
    const i = hooks.cursor++;
    if (!(i in hooks.slots)) hooks.slots[i] = { current: initial };
    return hooks.slots[i];
  },
  useEffect: (effect: () => (() => void) | void) => hooks.effects.push(effect),
}));
// Keep this Node tool's compilation independent from the renderer JSX project.
const componentModule: string = '../../src/renderer/src/storage/LocalDataPanel.tsx';
const { LocalDataPanel } = (await import(componentModule)) as { LocalDataPanel(): unknown };
function plain(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(plain).join('');
  if (typeof value === 'object' && value !== null && 'props' in value)
    return plain((value as { props: { children?: unknown } }).props.children);
  return '';
}
function render() {
  hooks.cursor = 0;
  return plain(LocalDataPanel());
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
const failed: DataTransferStatus = {
  ...idle,
  operationId: '7f24a960-dd65-4ef2-a04a-742c0e87c845',
  action: 'backup',
  state: 'recovery-required',
  code: 'worker',
  message: '原数据需要恢复运行',
  canRecoverOriginal: true,
  availableActions: [],
};
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  hooks.cursor = 0;
  hooks.slots = [];
  hooks.effects = [];
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function mount(transfer: () => Promise<DataTransferStatus>, storage: () => Promise<unknown>) {
  vi.stubGlobal('window', {
    aibrowse: { dataTransfer: { getStatus: transfer }, getConversationStorageStatus: storage },
  });
  render();
  const setup = hooks.effects[0]!;
  const cleanup = setup();
  if (cleanup) cleanups.push(cleanup);
  return { setup, cleanup };
}

it('Conversation状态长期pending时转移状态仍能发现失败和恢复入口，且pending通道不堆积', async () => {
  const transfer = vi.fn(async () => idle);
  const storage = vi.fn(() => new Promise<never>(() => undefined));
  mount(transfer, storage);
  await flush();
  expect(render()).toContain(idle.message);
  transfer.mockResolvedValue(failed);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(storage).toHaveBeenCalledOnce();
  expect(render()).toContain('不能确认已保存');
  expect(render()).toContain(failed.message);
  expect(render()).toContain('恢复原数据运行');
});

it('StrictMode的setup-cleanup-setup不能移除原pending请求的超时提示，也不能重发请求', async () => {
  const transfer = vi.fn(() => new Promise<DataTransferStatus>(() => undefined));
  const f = mount(transfer, async () => ({ state: 'ready', code: null }));
  f.cleanup?.();
  const cleanup = f.setup();
  if (cleanup) cleanups.push(cleanup);
  await vi.advanceTimersByTimeAsync(12_000);
  expect(transfer).toHaveBeenCalledOnce();
  expect(render()).toContain('本地数据状态暂不可用');
});

it('正常独立状态查询继续更新，错误对象正文不会进入面板', async () => {
  const transfer = vi.fn(async () => idle);
  mount(transfer, async () => {
    throw new Error('D:/private/hidden-payload');
  });
  await flush();
  transfer.mockResolvedValue(failed);
  await vi.advanceTimersByTimeAsync(2000);
  expect(render()).toContain(failed.message);
  expect(render()).not.toContain('hidden-payload');
  expect(render()).toContain('不能确认已保存');
});
