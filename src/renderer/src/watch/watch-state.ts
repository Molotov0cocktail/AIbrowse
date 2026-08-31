export const WATCH_VIEWS = ['overview', 'rules', 'events', 'digests', 'health'] as const;
export type WatchView = (typeof WATCH_VIEWS)[number];

export interface WatchUiState {
  view: WatchView;
  revision: number;
}

export const INITIAL_WATCH_STATE: WatchUiState = { view: 'overview', revision: 0 };

export type WatchUiEvent =
  { type: 'select-view'; view: WatchView } | { type: 'push-revision'; revision: number };

export function reduceWatchState(state: WatchUiState, event: WatchUiEvent): WatchUiState {
  if (event.type === 'select-view')
    return event.view === state.view ? state : { ...state, view: event.view };
  return event.revision <= state.revision ? state : { ...state, revision: event.revision };
}
