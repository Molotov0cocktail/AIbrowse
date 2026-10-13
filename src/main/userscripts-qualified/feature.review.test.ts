import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  confirm: vi.fn(),
  read: vi.fn(),
  install: vi.fn(),
  storeDispose: vi.fn(),
  runtimeDispose: vi.fn(),
  networkDispose: vi.fn(),
  request: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { once: vi.fn(), removeListener: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn(), removeListener: vi.fn(), removeHandler: vi.fn() },
  dialog: { showOpenDialog: mocks.select, showMessageBox: mocks.confirm },
  Menu: { buildFromTemplate: vi.fn() },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
vi.mock('./package', () => ({ readQualifiedPackage: mocks.read }));
vi.mock('./store', () => ({
  QualifiedScriptStore: class {
    install = mocks.install;
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
    dispose = mocks.runtimeDispose;
  },
}));

import { createQualifiedScriptFeature } from './feature';
import { QUALIFIED_SCRIPT_CATALOG } from './catalog';

const features: ReturnType<typeof createQualifiedScriptFeature>[] = [];
const texts = new Map([['source', '已通过固定摘要校验的原件']]);
const selectedPath = 'D:/selected-by-native-dialog/fixed-package.json';

function setup() {
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false });
  let current = true;
  const isCurrent = () => current;
  const feature = createQualifiedScriptFeature({
    win: win as unknown as BrowserWindow,
    dataRoot: 'D:/unused-review-root',
    isOpen: isCurrent,
    getActiveUserContentsId: () => null,
    openUserTab: vi.fn(),
  });
  features.push(feature);
  return {
    feature,
    win,
    isCurrent,
    expire: () => {
      current = false;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.select.mockResolvedValue({ canceled: false, filePaths: [selectedPath] });
  mocks.confirm.mockResolvedValue({ response: 1 });
  mocks.read.mockReturnValue(texts);
  mocks.install.mockResolvedValue({ ok: true });
});
afterEach(() => {
  for (const feature of features.splice(0)) feature.dispose();
});

describe('本地资格包独立权限与文档生命周期复核', () => {
  it('文件选择取消时不读取、不确认、不安装', async () => {
    mocks.select.mockResolvedValue({ canceled: true, filePaths: [] });
    const h = setup();
    await expect(h.feature.install('ac-baidu', h.isCurrent, true)).resolves.toEqual({
      ok: true,
      cancelled: true,
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it.each([{ filePaths: [] }, { filePaths: [selectedPath, 'D:/another.json'] }])(
    '选择结果必须只有一个文件 %#',
    async ({ filePaths }) => {
      mocks.select.mockResolvedValue({ canceled: false, filePaths });
      const h = setup();
      await expect(h.feature.install('ac-baidu', h.isCurrent, true)).resolves.toMatchObject({
        ok: false,
      });
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.confirm).not.toHaveBeenCalled();
      expect(mocks.install).not.toHaveBeenCalled();
    },
  );

  it('坏包在权限确认前拒绝，错误不回显文件路径', async () => {
    mocks.read.mockImplementation(() => {
      throw new Error('C:/private-canary/bad-package');
    });
    const h = setup();
    const result = await h.feature.install('ac-baidu', h.isCurrent, true);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('private-canary');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('原生选择期间UI文档过期时不读取被选文件', async () => {
    const selection = deferred<{ canceled: boolean; filePaths: string[] }>();
    mocks.select.mockReturnValue(selection.promise);
    const h = setup();
    const result = h.feature.install('github-zh', h.isCurrent, true);
    h.expire();
    selection.resolve({ canceled: false, filePaths: [selectedPath] });
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('读取并校验后用户拒绝权限仍不安装', async () => {
    mocks.confirm.mockResolvedValue({ response: 0 });
    const h = setup();
    await expect(h.feature.install('ac-baidu', h.isCurrent, true)).resolves.toEqual({
      ok: true,
      cancelled: true,
    });
    expect(mocks.read).toHaveBeenCalledWith(selectedPath, QUALIFIED_SCRIPT_CATALOG['ac-baidu']);
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it.each(['expire', 'dispose'] as const)('权限确认期间%s后接受确认也不得安装', async (mode) => {
    const confirmation = deferred<{ response: number }>();
    mocks.confirm.mockReturnValue(confirmation.promise);
    const h = setup();
    const result = h.feature.install('ac-baidu', h.isCurrent, true);
    await vi.waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    if (mode === 'expire') h.expire();
    else h.feature.dispose();
    confirmation.resolve({ response: 1 });
    await expect(result).resolves.toMatchObject({ ok: false });
    expect(mocks.install).not.toHaveBeenCalled();
  });

  it('依次选择、固定目录校验和权限确认后只把内存资产交给store', async () => {
    const h = setup();
    await expect(h.feature.install('ac-baidu', h.isCurrent, true)).resolves.toEqual({ ok: true });
    expect(mocks.select).toHaveBeenCalledWith(
      h.win,
      expect.objectContaining({
        properties: ['openFile'],
        filters: [{ name: 'AIbrowse 脚本包', extensions: ['json'] }],
      }),
    );
    expect(mocks.read).toHaveBeenCalledWith(selectedPath, QUALIFIED_SCRIPT_CATALOG['ac-baidu']);
    expect(mocks.confirm).toHaveBeenCalledWith(
      h.win,
      expect.objectContaining({
        defaultId: 0,
        cancelId: 0,
        detail: expect.stringContaining('普通浏览标签页'),
      }),
    );
    expect(mocks.read.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.confirm.mock.invocationCallOrder[0]!,
    );
    expect(mocks.confirm.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.install.mock.invocationCallOrder[0]!,
    );
    expect(mocks.install).toHaveBeenCalledWith('ac-baidu', h.isCurrent, texts);
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('进入前已过期的文档不打开任何对话框', async () => {
    const h = setup();
    h.expire();
    await expect(h.feature.install('github-zh', h.isCurrent, true)).resolves.toMatchObject({
      ok: false,
    });
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });
});
