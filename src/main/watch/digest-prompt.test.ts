import { describe, expect, it } from 'vitest';
import { buildDigestProviderRequest } from './digest-prompt';

describe('Digest prompt', () => {
  it('只接受已投影 DTO，完整 canonical request 无 tools 字段', () => {
    const request = buildDigestProviderRequest({
      requestId: 'req',
      model: 'model',
      projection: {
        schemaVersion: 1,
        scheduleId: 's',
        digestRunId: 'r',
        batchIndex: 0,
        period: {
          fromExclusive: '2026-08-30T00:00:00.000Z',
          toInclusive: '2026-08-31T00:00:00.000Z',
        },
        runStats: { changed: 0, unchanged: 0, failed: 0 },
        events: [],
        fetchedAt: '2026-08-31T00:00:00.000Z',
      },
    });
    expect(request).not.toBeNull();
    expect(request).not.toHaveProperty('tools');
    expect(request?.messages).toHaveLength(1);
  });
});
