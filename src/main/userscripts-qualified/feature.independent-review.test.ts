import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

it('独审：旧安装操作跨越ready微任务后失效不得启用脚本', async () => {
  mocks.list.mockReturnValue(statuses({ installed: true, enabled: false }));
  const { feature } = setup();
  await feature.ready;
  let current = true;
  const pending = feature.install('ac-baidu', () => current);
  current = false;
  await pending;
  expect(mocks.setEnabled).not.toHaveBeenCalled();
});
it('独审：业务准入在开关等待ready期间关闭不得落盘', async () => {
  mocks.list.mockReturnValue(statuses({ installed: true, enabled: false }));
  const { feature, close } = setup();
  await feature.ready;
  const pending = feature.setEnabled('ac-baidu', true);
  close();
  await pending;
  expect(mocks.setEnabled).not.toHaveBeenCalled();
});
