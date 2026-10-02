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

describe('资格首tick同步路径核对与覆盖', () => {
  it('覆盖前核对两个早期路径，再同步覆盖全部8个路径', () => {
    const calls: string[] = [];
    const actual = new Map<string, string>();
    const receipt = applyQualificationLaunchIsolation(
      {
        isReady: () => false,
        setPath: (key, value) => {
          calls.push(`set:${key}`);
          actual.set(key, value);
        },
        getPath: (key) => {
          calls.push(`get:${key}`);
          if (actual.size === 0) {
            expect(['userData', 'sessionData']).toContain(key);
            return paths.userDataRoot;
          }
          expect(actual.size).toBe(8);
          return actual.get(key)!;
        },
      },
      prepared,
    );
    expect(calls.slice(0, 10)).toEqual([
      'get:userData',
      'get:sessionData',
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
    expect(receipt).toEqual({ userDataMatches: true, sessionDataMatches: true });
    expect(Object.isFrozen(receipt)).toBe(true);
  });

  it.each(['userData', 'sessionData'])('早期%s不符时零覆盖且错误不含路径', (mismatch) => {
    let writes = 0;
    expect(() =>
      applyQualificationLaunchIsolation(
        {
          isReady: () => false,
          setPath: () => writes++,
          getPath: (key) => (key === mismatch ? 'D:\\synthetic-private-path' : paths.userDataRoot),
        },
        prepared,
      ),
    ).toThrowError(new Error('资格早期路径不一致'));
    expect(writes).toBe(0);
  });

  it.each(['userData', 'sessionData'])('早期%s读取失败时零覆盖且不回显底层错误', (failure) => {
    let writes = 0;
    expect(() =>
      applyQualificationLaunchIsolation(
        {
          isReady: () => false,
          setPath: () => writes++,
          getPath: (key) => {
            if (key === failure) throw new Error('D:\\synthetic-private-path');
            return paths.userDataRoot;
          },
        },
        prepared,
      ),
    ).toThrowError(new Error('资格早期路径不可用'));
    expect(writes).toBe(0);
  });

  it('已ready时零路径读写', () => {
    const forbidden = (): never => {
      throw new Error('不应访问默认profile');
    };
    expect(() =>
      applyQualificationLaunchIsolation(
        { isReady: () => true, setPath: forbidden, getPath: forbidden },
        prepared,
      ),
    ).toThrow('过迟');
  });

  it.each([2, 3])('第%d次检查发现ready时拒绝继续', (readyAt) => {
    let checks = 0;
    let writes = 0;
    expect(() =>
      applyQualificationLaunchIsolation(
        {
          isReady: () => ++checks >= readyAt,
          setPath: () => writes++,
          getPath: () => paths.userDataRoot,
        },
        prepared,
      ),
    ).toThrow('过迟');
    expect(writes).toBe(readyAt === 2 ? 0 : 8);
  });

  it('setPath失败时拒绝', () => {
    expect(() =>
      applyQualificationLaunchIsolation(
        {
          isReady: () => false,
          setPath: () => {
            throw new Error('覆盖失败');
          },
          getPath: () => paths.userDataRoot,
        },
        prepared,
      ),
    ).toThrow('覆盖失败');
  });

  it.each(['appData', 'userData', 'sessionData', 'logs', 'crashDumps', 'temp'])(
    '覆盖后%s读回不符时拒绝',
    (mismatch) => {
      const actual = new Map<string, string>();
      expect(() =>
        applyQualificationLaunchIsolation(
          {
            isReady: () => false,
            setPath: (key, value) => {
              actual.set(key, value);
            },
            getPath: (key) => {
              if (actual.size === 0) return paths.userDataRoot;
              return key === mismatch ? 'D:\\synthetic-other-root' : actual.get(key)!;
            },
          },
          prepared,
        ),
      ).toThrowError(new Error('资格隔离路径不一致'));
    },
  );
});
