import { beforeEach, expect, it, vi } from 'vitest';
import { useContentBounds } from './useContentBounds';

const hooks = vi.hoisted(() => ({
  effect: null as (() => (() => void) | void) | null,
  ref: null as { current: unknown } | null,
}));

vi.mock('react', () => ({
  useLayoutEffect: (effect: () => (() => void) | void) => {
    hooks.effect = effect;
  },
  useRef: (initial: unknown) => {
    hooks.ref ??= { current: initial };
    return hooks.ref;
  },
}));

class ResizeObserverFake {
  static latest: ResizeObserverFake | null = null;
  readonly observe = vi.fn();
  readonly disconnect = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    ResizeObserverFake.latest = this;
  }

  notify(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

beforeEach(() => {
  hooks.effect = null;
  hooks.ref = null;
  ResizeObserverFake.latest = null;
  vi.stubGlobal('ResizeObserver', ResizeObserverFake);
});

it('挂载与尺寸通知立即上报完整矩形，并在清理后解除观察和窗口监听', () => {
  let rect = { x: 8.4, y: 80.6, width: 900.2, height: 620.8 };
  const container = {
    getBoundingClientRect: vi.fn(() => rect),
  } as unknown as HTMLElement;
  const reportContentBounds = vi.fn();
  const listeners = new Map<string, EventListener>();
  const documentListeners = new Map<string, EventListener>();
  vi.stubGlobal('window', {
    aibrowse: { ui: { reportContentBounds } },
    addEventListener: vi.fn((type: string, listener: EventListener) =>
      listeners.set(type, listener),
    ),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    }),
  });
  vi.stubGlobal('document', {
    addEventListener: vi.fn((type: string, listener: EventListener) =>
      documentListeners.set(type, listener),
    ),
    removeEventListener: vi.fn((type: string, listener: EventListener) => {
      if (documentListeners.get(type) === listener) documentListeners.delete(type);
    }),
  });

  useContentBounds({ current: container });
  const cleanup = hooks.effect?.();

  expect(reportContentBounds).toHaveBeenCalledExactlyOnceWith({
    x: 8,
    y: 81,
    width: 900,
    height: 621,
  });
  expect(ResizeObserverFake.latest?.observe).toHaveBeenCalledExactlyOnceWith(container);

  rect = { x: 8, y: 81, width: 520, height: 621 };
  ResizeObserverFake.latest?.notify();
  expect(reportContentBounds).toHaveBeenLastCalledWith({ x: 8, y: 81, width: 520, height: 621 });
  expect(reportContentBounds).toHaveBeenCalledTimes(2);

  ResizeObserverFake.latest?.notify();
  expect(reportContentBounds).toHaveBeenCalledTimes(2);

  rect = { x: 0, y: 82, width: 500, height: 600 };
  listeners.get('resize')?.(new Event('resize'));
  expect(reportContentBounds).toHaveBeenLastCalledWith({ x: 0, y: 82, width: 500, height: 600 });

  rect = { x: 0, y: 210, width: 500, height: 472 };
  documentListeners.get('toggle')?.(new Event('toggle'));
  expect(reportContentBounds).toHaveBeenLastCalledWith({ x: 0, y: 210, width: 500, height: 472 });

  if (typeof cleanup === 'function') cleanup();

  useContentBounds({ current: container });
  const secondCleanup = hooks.effect?.();
  expect(reportContentBounds).toHaveBeenCalledTimes(4);

  if (typeof secondCleanup === 'function') secondCleanup();
  expect(ResizeObserverFake.latest?.disconnect).toHaveBeenCalledOnce();
  expect(listeners.has('resize')).toBe(false);
  expect(documentListeners.has('toggle')).toBe(false);
});
