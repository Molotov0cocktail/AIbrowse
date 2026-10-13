import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inside, phasePassed } from './run';

const quietDownloadBoundary = () => ({
  harnessHeaderObservers: 1,
  productHeaderListeners: [],
  cookieReads: 0,
  debuggerAttachments: 0,
  cookieCommands: 0,
  nativeEvents: [],
  trustedClick: false,
});

describe('运行证据边界', () => {
  it('拒绝根目录、父目录和相邻伪前缀', () => {
    const root = resolve('log/browser-groups-userscripts-20261013');
    expect(inside(root, root)).toBe(false);
    expect(inside(root, resolve(root, '..'))).toBe(false);
    expect(inside(root, `${root}-other`)).toBe(false);
    expect(inside(root, resolve(root, 'runtime-1'))).toBe(true);
  });
  it('不能仅用passed自述冒充完整生命周期事实', () => {
    const valid = {
      phase: 'reopen',
      passed: true,
      willQuit: true,
      error: null,
      facts: {
        isolation: true,
        scriptsPersisted: true,
        persistedExecution: true,
        themeColorPersisted: true,
      },
      childLaunches: 0,
      downloadBoundary: quietDownloadBoundary(),
    };
    expect(phasePassed(valid, 'reopen')).toBe(true);
    expect(
      phasePassed({ ...valid, facts: { ...valid.facts, themeColorPersisted: false } }, 'reopen'),
    ).toBe(false);
    expect(phasePassed({ ...valid, facts: { isolation: true } }, 'reopen')).toBe(false);
    expect(phasePassed({ ...valid, willQuit: false }, 'reopen')).toBe(false);
    expect(phasePassed({ ...valid, error: '失败' }, 'reopen')).toBe(false);
    expect(phasePassed(valid, 'write')).toBe(false);
    expect(phasePassed(null, 'reopen')).toBe(false);
  });
  it('实际点击下载必须被产品取消，不能用事实标签或零事件冒充通过', () => {
    const valid = {
      phase: 'write',
      passed: true,
      willQuit: true,
      error: null,
      facts: Object.fromEntries(
        [
          'isolation',
          'groups',
          'groupEditorControls',
          'uiReloadGroups',
          'appearance',
          'themeColors',
          'themeColorKeyboard',
          'themeColorInputs',
          'themeColorReset',
          'themeColorNarrow',
          'themeNativeSync',
          'themeColorPersistencePrepared',
          'downloadToolEntry',
          'downloadToolAppearance',
          'browserDownloadBlocked',
          'scriptLifecycle',
          'scriptIsolation',
          'unsupportedRejected',
          'persistencePrepared',
        ].map((key) => [key, true]),
      ),
      childLaunches: 0,
      downloadBoundary: {
        ...quietDownloadBoundary(),
        trustedClick: true,
        nativeEvents: [{ filename: 'blocked-download.bin', hasUserGesture: true, prevented: true }],
      },
    };
    expect(phasePassed(valid, 'write')).toBe(true);
    for (const fact of [
      'themeColors',
      'themeColorKeyboard',
      'themeColorInputs',
      'themeColorReset',
      'themeColorNarrow',
      'themeNativeSync',
      'themeColorPersistencePrepared',
    ])
      expect(phasePassed({ ...valid, facts: { ...valid.facts, [fact]: false } }, 'write')).toBe(
        false,
      );
    expect(phasePassed({ ...valid, downloadBoundary: undefined }, 'write')).toBe(false);
    for (const change of [
      { nativeEvents: [] },
      { trustedClick: false },
      { nativeEvents: [{ ...valid.downloadBoundary.nativeEvents[0], prevented: false }] },
      { nativeEvents: [{ ...valid.downloadBoundary.nativeEvents[0], hasUserGesture: false }] },
      { productHeaderListeners: ['onSendHeaders'] },
      { harnessHeaderObservers: 0 },
      { cookieReads: 1 },
      { debuggerAttachments: 1 },
      { cookieCommands: 1 },
    ])
      expect(
        phasePassed(
          { ...valid, downloadBoundary: { ...valid.downloadBoundary, ...change } },
          'write',
        ),
      ).toBe(false);
    expect(phasePassed({ ...valid, childLaunches: 1 }, 'write')).toBe(false);
  });
});
