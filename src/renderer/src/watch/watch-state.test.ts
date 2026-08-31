import { describe, expect, it } from 'vitest';
import { INITIAL_WATCH_STATE, reduceWatchState } from './watch-state';

describe('D9 Watch 工作区状态', () => {
  it('五视图闭合切换并按 revision 去重 push', () => {
    const views = ['overview', 'rules', 'events', 'digests', 'health'] as const;
    let state = INITIAL_WATCH_STATE;
    for (const view of views) state = reduceWatchState(state, { type: 'select-view', view });
    expect(state.view).toBe('health');
    state = reduceWatchState(state, { type: 'push-revision', revision: 2 });
    expect(reduceWatchState(state, { type: 'push-revision', revision: 2 })).toBe(state);
  });
});
