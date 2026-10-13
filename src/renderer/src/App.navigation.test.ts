import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { TabBar } from './browser/TabBar';
import { Toolbar } from './browser/Toolbar';
import { SettingsPage } from './settings/SettingsPage';
import type { BrowserLibraryStatus } from '../../shared/types/browser-library';

const hooks = vi.hoisted(() => ({
  initialView: 'watch' as 'watch' | 'research-result' | 'settings' | 'library',
  viewWrites: [] as string[],
  libraryStatus: { state: 'available', message: '' } as BrowserLibraryStatus | null,
}));

vi.mock('react', () => ({
  useEffect: () => undefined,
  useRef: (initial: unknown) => ({ current: initial }),
  useState: (initial: unknown) => {
    const resolved = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    const isViewMode = resolved === 'browser' || resolved === 'watch';
    let value = isViewMode ? hooks.initialView : resolved;
    return [
      value,
      (next: unknown) => {
        value = typeof next === 'function' ? (next as (current: unknown) => unknown)(value) : next;
        if (isViewMode && typeof value === 'string') hooks.viewWrites.push(value);
      },
    ];
  },
}));

vi.mock('./browser/useContentBounds', () => ({ useContentBounds: () => undefined }));
vi.mock('./browser/useTabsState', () => ({
  useTabsState: () => ({
    activeTabId: 'tab-1',
    tabs: [{ id: 'tab-1', title: '测试页', url: 'https://example.test', state: 'ready' }],
  }),
}));
vi.mock('./ai/useAgent', () => ({
  useAgent: () => ({
    agentState: { runs: {} },
    startTask: vi.fn(),
    confirmTool: vi.fn(),
    stopRun: vi.fn(),
  }),
}));
vi.mock('./research/use-research', () => ({
  useResearch: () => ({
    state: { resultCanvasCleared: false, resultView: null },
    consumeCanvasCleared: vi.fn(),
    refreshList: vi.fn(),
    openResult: vi.fn(),
    exportCsv: vi.fn(),
  }),
}));
vi.mock('./ui/useAppearance', () => ({
  useAppearance: () => ({
    appearance: 'system',
    setAppearance: vi.fn(),
    themeColor: null,
    themeColorError: null,
    setThemeColor: vi.fn(() => true),
  }),
}));
vi.mock('./storage/useLocalData', () => ({
  useLocalData: () => ({ issue: null }),
}));
vi.mock('./browser-library/useBrowserLibraryStatus', () => ({
  useBrowserLibraryStatus: () => hooks.libraryStatus,
}));

beforeEach(() => {
  hooks.libraryStatus = { state: 'available', message: '' };
});

interface ElementNode {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function elements(value: unknown): ElementNode[] {
  if (Array.isArray(value)) return value.flatMap(elements);
  if (typeof value !== 'object' || value === null || !('props' in value)) return [];
  const node = value as ElementNode;
  return [node, ...elements(node.props.children)];
}

function component<T extends ElementNode['props']>(tree: unknown, type: unknown): T {
  return elements(tree).find((node) => node.type === type)!.props as T;
}

describe.each(['watch', 'research-result', 'settings', 'library'] as const)(
  '从 %s 返回浏览',
  (initialView) => {
    beforeEach(() => {
      hooks.initialView = initialView;
      hooks.viewWrites = [];
      vi.stubGlobal('__WATCH_QUALIFICATION__', false);
      const nav = {
        navigate: vi.fn(async () => true),
        back: vi.fn(async () => true),
        forward: vi.fn(async () => true),
        reload: vi.fn(async () => true),
      };
      vi.stubGlobal('window', {
        aibrowse: {
          nav,
          tabs: {
            activate: vi.fn(async () => true),
            close: vi.fn(async () => true),
            create: vi.fn(async () => ({ id: 'tab-2' })),
          },
        },
      });
    });

    it.each([
      ['地址栏导航', 'onNavigate', 'navigate', '搜索词'],
      ['后退', 'onBack', 'back', undefined],
      ['前进', 'onForward', 'forward', undefined],
      ['刷新', 'onReload', 'reload', undefined],
    ] as const)('%s会切回浏览并派发当前标签动作', async (_label, callback, bridgeMethod, input) => {
      const toolbar = component<Record<string, unknown>>(App(), Toolbar);
      (toolbar[callback] as (value?: string) => void)(input);
      await Promise.resolve();

      expect(hooks.viewWrites).toContain('browser');
      expect((window.aibrowse.nav[bridgeMethod] as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual(
        input === undefined ? ['tab-1'] : ['tab-1', input],
      );
    });

    it('激活标签会切回浏览并派发精确tabId', async () => {
      const tabBar = component<Record<string, unknown>>(App(), TabBar);
      (tabBar.onActivate as (tabId: string) => void)('tab-1');
      await Promise.resolve();

      expect(hooks.viewWrites).toContain('browser');
      expect(window.aibrowse.tabs.activate).toHaveBeenCalledExactlyOnceWith('tab-1');
    });

    it('新建标签成功后切回浏览', async () => {
      const button = elements(App()).find((node) => node.props.className === 'new-tab-button')!;
      (button.props.onClick as () => void)();
      await Promise.resolve();
      await Promise.resolve();

      expect(window.aibrowse.tabs.create).toHaveBeenCalledExactlyOnceWith();
      expect(hooks.viewWrites).toContain('browser');
    });
  },
);

it('设置工作区初次进入常规页', () => {
  hooks.initialView = 'settings';
  hooks.viewWrites = [];
  vi.stubGlobal('__WATCH_QUALIFICATION__', false);
  vi.stubGlobal('window', {
    aibrowse: {
      nav: {},
      tabs: {},
      browserLibrary: { getCurrentBookmark: vi.fn() },
    },
  });
  const settings = component<Record<string, unknown>>(App(), SettingsPage);
  expect(settings.section).toBe('general');
});

describe('浏览数据全局故障提醒', () => {
  beforeEach(() => {
    hooks.initialView = 'settings';
    hooks.viewWrites = [];
    vi.stubGlobal('__WATCH_QUALIFICATION__', false);
    vi.stubGlobal('window', { aibrowse: { nav: {}, tabs: {} } });
  });

  it.each([null, 'initializing', 'available', 'maintenance'] as const)(
    '%s不显示浏览数据故障气泡或设置故障标记',
    (state) => {
      hooks.libraryStatus = state === null ? null : { state, message: '受控状态' };
      const tree = App();
      expect(elements(tree).filter((node) => node.props.className === 'data-global-alert')).toEqual(
        [],
      );
      expect(component<Record<string, unknown>>(tree, SettingsPage).browserDataIssue).toBeNull();
    },
  );

  it.each([
    ['unavailable', '浏览数据暂不可用，请检查本地数据'],
    ['storage-error', '浏览数据保存或读取失败，部分新访问可能未保存；请检查本地数据'],
  ] as const)('%s仍显示真实故障并可进入设置', (state, message) => {
    hooks.libraryStatus = { state, message: '不可信错误内容不得回显' };
    const tree = App();
    const alerts = elements(tree).filter((node) => node.props.className === 'data-global-alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.props.children).toBe(message);
    expect(component<Record<string, unknown>>(tree, SettingsPage).browserDataIssue).toBe(message);
    (alerts[0]!.props.onClick as () => void)();
    expect(hooks.viewWrites).toContain('settings');
  });
});
