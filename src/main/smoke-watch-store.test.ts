import { afterEach, describe, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

import { runWatchStoreSmokeScenario } from './smoke-watch-store';

describe('Watch store 冒烟的固定业务时钟', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['2026-10-02T12:00:00.000Z', '2027-01-15T12:00:00.000Z'])(
    '真实日期%s超过夹具保留期时仍验证恢复',
    async (date) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(date));
      await expect(runWatchStoreSmokeScenario()).resolves.toBeUndefined();
    },
  );
});
