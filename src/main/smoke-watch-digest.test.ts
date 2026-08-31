import { describe, expect, it } from 'vitest';
import { runWatchDigestSmokeScenario } from './smoke-watch-digest';

describe('D8 focused smoke', () => {
  it('真实 v4/journal/cycle/claim/writeback 完成且精确清理', async () => {
    await expect(runWatchDigestSmokeScenario()).resolves.toBeUndefined();
  });
});
