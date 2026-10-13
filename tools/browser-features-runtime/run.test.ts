import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inside, phasePassed } from './run';

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
      facts: { isolation: true, scriptsPersisted: true, persistedExecution: true },
    };
    expect(phasePassed(valid, 'reopen')).toBe(true);
    expect(phasePassed({ ...valid, facts: { isolation: true } }, 'reopen')).toBe(false);
    expect(phasePassed({ ...valid, willQuit: false }, 'reopen')).toBe(false);
    expect(phasePassed({ ...valid, error: '失败' }, 'reopen')).toBe(false);
    expect(phasePassed(valid, 'write')).toBe(false);
    expect(phasePassed(null, 'reopen')).toBe(false);
  });
});
