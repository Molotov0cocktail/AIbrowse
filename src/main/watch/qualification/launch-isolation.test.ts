import { describe, expect, it } from 'vitest';
import { applyQualificationLaunchIsolation } from './launch-isolation';
import type { PreparedLaunchIsolation, LaunchIsolationTicket } from './native-contract';

const paths = {
  runRoot: 'D:\\isolated',
  appDataRoot: 'D:\\isolated\\appdata',
  localAppDataRoot: 'D:\\isolated\\localappdata',
  processTempRoot: 'D:\\isolated\\process-temp',
  userDataRoot: 'D:\\isolated\\user-data',
  watchTempRoot: 'D:\\isolated\\watch-temp',
};
const prepared: PreparedLaunchIsolation = {
  paths,
  ticket: {} as LaunchIsolationTicket,
  rootFileIds: { ...paths },
  qualificationRunId: 'TEST',
};

describe('资格首tick同步路径覆盖', () => {
  it('任何getPath之前同步完成全部8个固定覆盖', () => {
    const calls: string[] = [];
    const actual = new Map<string, string>();
    applyQualificationLaunchIsolation(
      {
        isReady: () => false,
        setPath: (key, value) => {
          calls.push(`set:${key}`);
          actual.set(key, value);
        },
        getPath: (key) => {
          calls.push(`get:${key}`);
          expect(actual.size).toBe(8);
          return actual.get(key)!;
        },
      },
      prepared,
    );
    expect(calls.slice(0, 8)).toEqual([
      'set:appData',
      'set:cache',
      'set:userData',
      'set:sessionData',
      'set:userCache',
      'set:logs',
      'set:crashDumps',
      'set:temp',
    ]);
    expect(actual.get('sessionData')).toBe(paths.userDataRoot);
    expect(actual.get('crashDumps')).toBe(paths.processTempRoot);
  });
  it('已ready时零路径读写，中途变ready也拒绝', () => {
    const forbidden = (): never => {
      throw new Error('不应访问默认profile');
    };
    expect(() =>
      applyQualificationLaunchIsolation(
        { isReady: () => true, setPath: forbidden, getPath: forbidden },
        prepared,
      ),
    ).toThrow('过迟');
    let count = 0;
    expect(() =>
      applyQualificationLaunchIsolation(
        { isReady: () => ++count > 1, setPath: () => {}, getPath: forbidden },
        prepared,
      ),
    ).toThrow('过迟');
  });
  it('setPath失败或路径读回不符拒绝，不继续加载业务', () => {
    expect(() =>
      applyQualificationLaunchIsolation(
        {
          isReady: () => false,
          setPath: () => {
            throw new Error('覆盖失败');
          },
          getPath: () => '',
        },
        prepared,
      ),
    ).toThrow('覆盖失败');
    expect(() =>
      applyQualificationLaunchIsolation(
        { isReady: () => false, setPath: () => {}, getPath: () => 'D:\\real-profile' },
        prepared,
      ),
    ).toThrow('不一致');
  });
});
