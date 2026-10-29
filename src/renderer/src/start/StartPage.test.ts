import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WatchPushDto } from '../../../shared/types/watch-ipc';
import { StartPage } from './StartPage';

const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  writes: vi.fn(),
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => [initial, hooks.writes],
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
const listHistory = vi.fn();
const listRules = vi.fn();
const getStatus = vi.fn();
const unsubscribe = vi.fn();
const navigate = vi.fn();
let push: (value: WatchPushDto) => void;
let cleanups: Array<void | (() => void)> = [];
const props = {
  libraryState: 'available' as const,
  onNavigate: navigate,
  onOpenHistory: vi.fn(),
  onOpenBookmarks: vi.fn(),
  onOpenWatch: vi.fn(),
  onOpenAi: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  hooks.effects = [];
  listHistory.mockResolvedValue({ ok: true, value: { items: [] } });
  listRules.mockResolvedValue({ ok: true, value: { items: [] } });
  getStatus.mockResolvedValue({ ok: true, value: { mode: 'available', ruleCount: 0 } });
  vi.stubGlobal('window', {
    aibrowse: {
      browserLibrary: { listHistory },
      watch: {
        listRules,
        getStatus,
        subscribe: (listener: typeof push) => {
          push = listener;
          return unsubscribe;
        },
      },
    },
  });
});
afterEach(() => {
  for (const cleanup of cleanups) cleanup?.();
  cleanups = [];
  vi.unstubAllGlobals();
});
function mount() {
  StartPage(props);
  cleanups = hooks.effects.map((effect) => effect());
}
async function settled() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

it('只读取有界本地数据，初始化不自动导航或创建任务', async () => {
  mount();
  await settled();
  expect(listHistory).toHaveBeenCalledExactlyOnceWith({ query: '', cursor: null, limit: 6 });
  expect(listRules).toHaveBeenCalledExactlyOnceWith({
    page: 1,
    pageSize: 4,
    filter: { state: null, sourceId: null },
  });
  expect(navigate).not.toHaveBeenCalled();
});
it('卸载后丢弃历史和监视迟到结果并注销推送', async () => {
  let releaseHistory!: (value: unknown) => void;
  let releaseRules!: (value: unknown) => void;
  listHistory.mockReturnValue(
    new Promise((resolve) => {
      releaseHistory = resolve;
    }),
  );
  listRules.mockReturnValue(
    new Promise((resolve) => {
      releaseRules = resolve;
    }),
  );
  mount();
  for (const cleanup of cleanups) cleanup?.();
  cleanups = [];
  hooks.writes.mockClear();
  releaseHistory({ ok: true, value: { items: [] } });
  releaseRules({ ok: true, value: { items: [] } });
  await settled();
  expect(hooks.writes).not.toHaveBeenCalled();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it('旧监视读取不能覆盖较新推送触发的结果', async () => {
  let release!: (value: unknown) => void;
  listRules.mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  mount();
  push({ type: 'status' } as WatchPushDto);
  await settled();
  hooks.writes.mockClear();
  release({ ok: false, errorCode: 'unavailable' });
  await settled();
  expect(hooks.writes).not.toHaveBeenCalled();
});
