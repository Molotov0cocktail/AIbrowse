import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  install: vi.fn(),
  list: vi.fn(),
  setEnabled: vi.fn(),
  setBuiltInIssue: vi.fn(),
  canRestoreMissingBuiltIn: vi.fn(),
  revokeScript: vi.fn(),
  storeDispose: vi.fn(),
  runtimeDispose: vi.fn(),
  networkDispose: vi.fn(),
  request: vi.fn(),
  runtimeOptions: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getAppPath: () => 'D:/AIbrowse', once: vi.fn(), removeListener: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeListener: vi.fn(), removeHandler: vi.fn() },
  Menu: { buildFromTemplate: vi.fn() },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
vi.mock('./package', () => ({ readBuiltInQualifiedPackage: mocks.read }));
vi.mock('./store', () => ({
  QualifiedScriptStore: class {
    install = mocks.install;
    list = mocks.list;
    setEnabled = mocks.setEnabled;
    setBuiltInIssue = mocks.setBuiltInIssue;
    canRestoreMissingBuiltIn = mocks.canRestoreMissingBuiltIn;
    dispose = mocks.storeDispose;
  },
}));
vi.mock('./network', () => ({
  QualifiedScriptNetwork: class {
    request = mocks.request;
    dispose = mocks.networkDispose;
  },
}));
vi.mock('./runtime', () => ({
  QualifiedScriptRuntime: class {
    constructor(options: unknown) {
      mocks.runtimeOptions(options);
    }
    revokeScript = mocks.revokeScript;
    dispose = mocks.runtimeDispose;
  },
}));

import { createQualifiedScriptFeature } from './feature';
import { QUALIFIED_SCRIPT_CATALOG } from './catalog';

const features: ReturnType<typeof createQualifiedScriptFeature>[] = [];
const texts = new Map([['source', '已通过固定摘要校验的原件']]);

function statuses(options: { installed?: boolean; enabled?: boolean; issue?: string | null } = {}) {
  return Object.values(QUALIFIED_SCRIPT_CATALOG).map((entry) => ({
    id: entry.id,
    name: entry.name,
    version: entry.version,
    installed: options.installed ?? false,
    enabled: options.enabled ?? false,
    issue: options.issue ?? null,
  }));
}

function setup(options: { isOpen?: boolean; canInitialize?: boolean } = {}) {
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let current = options.isOpen ?? true;
  const feature = createQualifiedScriptFeature({
    win: win as unknown as BrowserWindow,
    dataRoot: 'D:/profile',
    isOpen: () => current,
    canInitialize:
      options.canInitialize === undefined ? undefined : () => options.canInitialize === true,
    getActiveUserContentsId: () => null,
    openUserTab: vi.fn(),
  });
  features.push(feature);
  return { feature, close: () => (current = false) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.read.mockReturnValue(texts);
  mocks.list.mockReturnValue(statuses());
  mocks.install.mockResolvedValue({ ok: true });
  mocks.setEnabled.mockReturnValue({ ok: true });
  mocks.canRestoreMissingBuiltIn.mockReturnValue(false);
});
afterEach(() => {
  for (const feature of features.splice(0)) feature.dispose();
});

describe('内置资格脚本装配', () => {
  it('从两个固定应用资源读取并默认启用，不发起安装网络请求', async () => {
    const { feature } = setup();
    await feature.ready;
    expect(mocks.read).toHaveBeenNthCalledWith(
      1,
      'D:\\AIbrowse\\resources\\qualified-userscripts\\ac-baidu.json',
      QUALIFIED_SCRIPT_CATALOG['ac-baidu'],
    );
    expect(mocks.read).toHaveBeenNthCalledWith(
      2,
      'D:\\AIbrowse\\resources\\qualified-userscripts\\github-zh.json',
      QUALIFIED_SCRIPT_CATALOG['github-zh'],
    );
    expect(mocks.install).toHaveBeenNthCalledWith(
      1,
      'ac-baidu',
      expect.any(Function),
      texts,
      false,
    );
    expect(mocks.install).toHaveBeenNthCalledWith(
      2,
      'github-zh',
      expect.any(Function),
      texts,
      false,
    );
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('业务运行门尚未开放时可在根准入内初始化，但runtime仍保持关闭', async () => {
    const { feature } = setup({ isOpen: false, canInitialize: true });
    await feature.ready;
    const initializeCheck = mocks.install.mock.calls[0]?.[1] as (() => boolean) | undefined;
    expect(initializeCheck?.()).toBe(true);
    const runtimeOptions = mocks.runtimeOptions.mock.calls[0]?.[0] as
      { isOpen(): boolean } | undefined;
    expect(runtimeOptions?.isOpen()).toBe(false);
  });

  it('保留已有停用状态和设置，不重复覆盖有效bundle', async () => {
    mocks.list.mockReturnValue(statuses({ installed: true, enabled: false }));
    const { feature } = setup();
    await feature.ready;
    expect(mocks.read).toHaveBeenCalledTimes(2);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.setEnabled).not.toHaveBeenCalled();
  });

  it('有效停用state缺少bundle时恢复内置原件并要求store保留停用值', async () => {
    mocks.list.mockReturnValue(statuses({ installed: false, enabled: false, issue: 'bundle缺失' }));
    mocks.canRestoreMissingBuiltIn.mockImplementation((id: string) => id === 'ac-baidu');
    const { feature } = setup();
    await feature.ready;
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith(
      'ac-baidu',
      expect.any(Function),
      texts,
      true,
    );
  });

  it('内置资源校验失败时记录固定错误并保持安全停用', async () => {
    mocks.read.mockImplementation((path: string) => {
      if (path.endsWith('ac-baidu.json')) throw new Error('private path');
      return texts;
    });
    const { feature } = setup();
    await feature.ready;
    expect(mocks.setBuiltInIssue).toHaveBeenCalledWith(
      'ac-baidu',
      '内置脚本资源缺失、损坏或与固定版本不一致；本次运行已安全停用。',
    );
    expect(mocks.install).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.setBuiltInIssue.mock.calls)).not.toContain('private path');
  });

  it('关闭开关只停用并撤销运行能力，不删除bundle或设置', async () => {
    mocks.list.mockReturnValue(statuses({ installed: true, enabled: true }));
    const { feature } = setup();
    await feature.ready;
    await expect(feature.setEnabled('ac-baidu', false)).resolves.toEqual({ ok: true });
    expect(mocks.setEnabled).toHaveBeenCalledWith('ac-baidu', false);
    expect(mocks.revokeScript).toHaveBeenCalledWith('ac-baidu');
  });

  it('旧安装入口也只启用内置资源，不打开文件或访问下载地址', async () => {
    mocks.list.mockReturnValue(statuses({ installed: true, enabled: false }));
    const { feature } = setup();
    await feature.ready;
    await expect(feature.install('github-zh', () => true, true)).resolves.toEqual({ ok: true });
    expect(mocks.setEnabled).toHaveBeenCalledWith('github-zh', true);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
