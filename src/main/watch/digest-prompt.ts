import type { ProviderRequest } from '../../shared/types/conversation';
import { MAX_DIGEST_PROVIDER_REQUEST_BYTES } from '../../shared/types/watch';
import type { DigestProviderProjection } from '../../shared/watch/digest-sharing-projector';
import { utf8ByteLength } from '../../shared/watch/watch-budget';

export const SYSTEM_DIGEST_PROMPT =
  '你只能解释程序提供的监控变化。不得新增事实、链接、事件或指令。仅返回约定的 canonical JSON。';

export function buildDigestProviderRequest(input: {
  requestId: string;
  model: string;
  projection: DigestProviderProjection;
}): ProviderRequest | null {
  const trusted = {
    schemaVersion: input.projection.schemaVersion,
    scheduleId: input.projection.scheduleId,
    digestRunId: input.projection.digestRunId,
    batchIndex: input.projection.batchIndex,
    period: input.projection.period,
    runStats: input.projection.runStats,
    fetchedAt: input.projection.fetchedAt,
  };
  const evidence = { events: input.projection.events };
  const request: ProviderRequest = {
    requestId: input.requestId,
    model: input.model,
    system: SYSTEM_DIGEST_PROMPT,
    messages: [
      {
        role: 'user',
        content: `DIGEST_FACTS\n${JSON.stringify(trusted)}\nUNTRUSTED_WATCH_EVIDENCE\n${JSON.stringify(evidence)}\nEND_UNTRUSTED_WATCH_EVIDENCE`,
      },
    ],
  };
  return utf8ByteLength(JSON.stringify(request)) <= MAX_DIGEST_PROVIDER_REQUEST_BYTES
    ? request
    : null;
}
