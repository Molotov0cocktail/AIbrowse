import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  dispatch: vi.fn(),
}));
vi.mock('react', () => ({
  useState: vi.fn(),
  useReducer: (_reduce: unknown, initial: unknown) => [initial, h.dispatch],
  useRef: (value: unknown) => ({ current: value }),
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => void | (() => void)) => h.effects.push(effect),
}));
import { INITIAL_RESEARCH_UI_STATE, reduceResearchUi, useResearch } from './use-research';

function mount(list: ReturnType<typeof vi.fn>) {
  h.effects = [];
  h.dispatch.mockClear();
  vi.stubGlobal('window', {
    aibrowse: {
      research: {
        list,
        onProgress: () => () => undefined,
        onTaskDone: () => () => undefined,
      },
    },
  });
  const api = useResearch();
  const cleanup = h.effects[0]!();
  h.effects[2]!();
  return { api, cleanup };
}
const success = { ok: true, value: { items: [], page: 1, pageSize: 20, total: 0 } };
afterEach(() => vi.unstubAllGlobals());

describe('Research历史服务准入及迟到回执', () => {
  it('历史成功只清自己错误，保留模型启动等操作失败原因', () => {
    let state = reduceResearchUi(INITIAL_RESEARCH_UI_STATE, {
      kind: 'invoke-error',
      errorCode: 'research-provider-unavailable',
    });
    const operationError = state.error;
    state = reduceResearchUi(state, {
      kind: 'invoke-error',
      errorCode: 'research-unavailable',
      scope: 'history',
    });
    expect(state.historyError).not.toBeNull();
    state = reduceResearchUi(state, { kind: 'list-ok', ...success.value });
    expect(state.error).toBe(operationError);
    expect(state.error).not.toBeNull();
    expect(state.historyError).toBeNull();
  });

  it('首次IPC拒绝受控收敛，服务就绪后显式刷新读取真实新结果', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('SECRET')).mockResolvedValue(success);
    const { api } = mount(list);
    await Promise.resolve();
    expect(h.dispatch).toHaveBeenCalledWith({
      kind: 'invoke-error',
      errorCode: 'research-unavailable',
      scope: 'history',
    });
    await api.refreshList(1);
    expect(h.dispatch).toHaveBeenLastCalledWith({ kind: 'list-ok', ...success.value });
    expect(JSON.stringify(h.dispatch.mock.calls)).not.toContain('SECRET');
  });

  it('旧首次读取的迟到拒绝不能覆盖新打开面板取得的列表', async () => {
    let reject!: (error: Error) => void;
    const list = vi
      .fn()
      .mockImplementationOnce(() => new Promise((_yes, no) => (reject = no)))
      .mockResolvedValue(success);
    const { api } = mount(list);
    await api.refreshList(1);
    reject(new Error('SECRET'));
    await Promise.resolve();
    expect(h.dispatch).toHaveBeenCalledOnce();
    expect(h.dispatch).toHaveBeenCalledWith({ kind: 'list-ok', ...success.value });
  });

  it('卸载后的迟到列表不发布', async () => {
    let resolve!: (value: typeof success) => void;
    const list = vi.fn(() => new Promise((yes) => (resolve = yes)));
    const { cleanup } = mount(list);
    if (typeof cleanup === 'function') cleanup();
    resolve(success);
    await Promise.resolve();
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
