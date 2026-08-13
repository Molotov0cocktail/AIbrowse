// OpenAI-compatible adapter: native fetch + hand-rolled SSE parsing, zero vendor SDK and
// zero Electron imports (dependency-direction discipline: LLMProvider must never touch
// webContents / Electron APIs). Keys are fetched from SecureCredentialStore per request and
// never cached or logged. Contract source: doc/stage2/detailed-design.md §3.3/§5.1/§8.2.
import { logDebug, logWarn } from '../../logger';
import type { SecureCredentialStore } from '../credential-store';
import type { ProviderConfig } from '../../../shared/types/conversation';
import type {
  NormalizedProviderError,
  ProviderEvent,
  ProviderMessage,
  ProviderMetadata,
  ProviderRequest,
  ProviderUsage,
} from '../../../shared/types/conversation';
import { normalizeProviderError, type ErrorNormalizeContext } from './error-normalize';
import type { LLMProvider } from './llm-provider';

// Timeout constants (design Q10): connect 15s / idle chunk 60s / total 300s, in one place.
export const PROVIDER_TIMEOUTS = {
  connectMs: 15_000,
  idleMs: 60_000,
  totalMs: 300_000,
} as const;

export interface ProviderTimeouts {
  connectMs: number;
  idleMs: number;
  totalMs: number;
}

// Which timer (or the external signal) aborted the request — determines the error code.
type AbortPhase = 'external' | 'connect' | 'idle' | 'total' | null;

// —— Pure SSE helpers (unit-tested; the fetch wiring is smoke-verified at S3+) ——

// Parse one '\n\n'-delimited frame: join its data: lines (SSE spec: one optional leading
// space stripped). Frames without data lines (comments/keep-alives) return null.
export function parseSseFrame(frameText: string): string | null {
  const dataLines: string[] = [];
  for (const line of frameText.split('\n')) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  return dataLines.length === 0 ? null : dataLines.join('\n');
}

export type SseChunkEvent =
  | { type: 'delta'; text: string; usage?: ProviderUsage } // choices[0].delta.content; some
  | { type: 'usage'; usage: ProviderUsage } // servers put the last delta + usage in one frame
  | { type: 'done-marker' } // [DONE]
  | { type: 'skip' } // Known empty frames (role-only first frame, empty choices)
  | { type: 'error' }; // Illegal JSON / unexpected structure → parse failure

// Interpret one SSE data payload. Deterministic; malformed input never throws.
export function interpretSsePayload(payload: string): SseChunkEvent {
  const trimmed = payload.trim();
  if (trimmed === '[DONE]') return { type: 'done-marker' };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { type: 'error' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { type: 'error' };
  const record = json as Record<string, unknown>;
  const usage = extractUsage(record);
  const choices = record.choices;
  if (!Array.isArray(choices)) {
    // Usage-only final frames are a known variant even without a choices array.
    return usage === null ? { type: 'error' } : { type: 'usage', usage };
  }
  if (choices.length === 0) return usage === null ? { type: 'skip' } : { type: 'usage', usage };
  const first = choices[0];
  if (typeof first !== 'object' || first === null) {
    return usage === null ? { type: 'error' } : { type: 'usage', usage };
  }
  const delta = (first as Record<string, unknown>).delta;
  if (typeof delta === 'object' && delta !== null) {
    const content = (delta as Record<string, unknown>).content;
    if (typeof content === 'string') {
      const event: SseChunkEvent = { type: 'delta', text: content };
      if (usage !== null) event.usage = usage;
      return event;
    }
  }
  // Known variants without content (role frame / empty delta).
  return usage === null ? { type: 'skip' } : { type: 'usage', usage };
}

function extractUsage(record: Record<string, unknown>): ProviderUsage | null {
  const usage = record.usage;
  if (typeof usage !== 'object' || usage === null) return null;
  const tokens = usage as Record<string, unknown>;
  const result: ProviderUsage = {};
  if (typeof tokens.prompt_tokens === 'number') result.inputTokens = tokens.prompt_tokens;
  if (typeof tokens.completion_tokens === 'number') result.outputTokens = tokens.completion_tokens;
  return result.inputTokens === undefined && result.outputTokens === undefined ? null : result;
}

// IR → wire messages: system maps to its own message; user/assistant pass through untouched
// (the UNTRUSTED_WEB_CONTENT block is already inside user content — no joining here, §3.3).
export function mapMessages(request: ProviderRequest): ProviderMessage[] {
  return [{ role: 'system', content: request.system }, ...request.messages];
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly metadata: ProviderMetadata;
  private readonly baseUrl: string;

  constructor(
    private readonly config: ProviderConfig,
    private readonly store: SecureCredentialStore,
    private readonly timeouts: ProviderTimeouts = PROVIDER_TIMEOUTS,
  ) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, ''); // Defensive; config-store also strips
    this.metadata = {
      id: config.providerId,
      label: config.providerId,
      streaming: true,
      supportsToolCalling: false,
      defaultContextLimitTokens: 128000, // Reference metadata only; real budget is char-based (§7.5)
    };
  }

  async *stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent> {
    const context: ErrorNormalizeContext = {
      requestId: request.requestId,
      providerId: this.config.providerId,
      model: request.model,
    };
    // Key fetched per request, never cached; nothing about the key is ever logged.
    const apiKey = await this.store.get(this.config.providerId);
    if (apiKey === null || apiKey === '') {
      logWarn(
        'provider',
        `未找到 API Key（${context.providerId}/${context.model ?? '-'}，req=${context.requestId}）`,
      );
      yield {
        type: 'error',
        error: normalizeProviderError({ kind: 'not-configured', requestId: context.requestId }),
      };
      return;
    }

    const controller = new AbortController();
    let phase: AbortPhase = null;
    const onExternalAbort = (): void => {
      phase = 'external';
      controller.abort();
    };
    signal.addEventListener('abort', onExternalAbort, { once: true });
    if (signal.aborted) onExternalAbort();
    const connectTimer = setTimeout(() => {
      phase = 'connect';
      controller.abort();
    }, this.timeouts.connectMs);
    const totalTimer = setTimeout(() => {
      phase = 'total';
      controller.abort();
    }, this.timeouts.totalMs);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdle = (): void => {
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        phase = 'idle';
        controller.abort();
      }, this.timeouts.idleMs);
    };
    try {
      logDebug(
        'provider',
        `开始流式请求 provider=${context.providerId} model=${context.model ?? '-'} req=${context.requestId}`,
      );
      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: request.model,
            stream: true,
            messages: mapMessages(request),
          }),
          signal: controller.signal,
        });
      } catch {
        yield { type: 'error', error: this.mapFailure(phase, context) };
        return;
      }
      clearTimeout(connectTimer);

      if (!response.ok) {
        // Response body read ONLY for the 400/422 context-overflow sniff; never logged,
        // never included in the error (provider text never reaches the UI, §5.1).
        const responseText = await this.readErrorBody(response);
        logWarn(
          'provider',
          `HTTP ${response.status}（${context.providerId}/${context.model ?? '-'}，req=${context.requestId}）`,
        );
        yield {
          type: 'error',
          error: normalizeProviderError({
            kind: 'http',
            context,
            httpStatus: response.status,
            responseText,
          }),
        };
        return;
      }
      if (response.body === null) {
        yield { type: 'error', error: normalizeProviderError({ kind: 'parse', context }) };
        return;
      }

      resetIdle();
      const decoder = new TextDecoder();
      let buffer = '';
      let usage: ProviderUsage | undefined;
      try {
        for await (const chunk of response.body) {
          resetIdle();
          // Normalize CRLF line endings so '\n\n' framing holds for servers that emit \r\n.
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
          let separator: number;
          while ((separator = buffer.indexOf('\n\n')) !== -1) {
            const frameText = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            const payload = parseSseFrame(frameText);
            if (payload === null) continue; // Comment/keep-alive frame
            const event = interpretSsePayload(payload);
            if (event.type === 'error') {
              logWarn(
                'provider',
                `流解析失败（${context.providerId}/${context.model ?? '-'}，req=${context.requestId}）`,
              );
              yield { type: 'error', error: normalizeProviderError({ kind: 'parse', context }) };
              return;
            }
            if (event.type === 'usage') {
              usage = event.usage;
              continue;
            }
            if (event.type === 'skip') continue;
            if (event.type === 'done-marker') {
              yield { type: 'done', usage };
              return;
            }
            if (event.usage !== undefined) usage = event.usage; // Last delta + usage in one frame
            if (event.text !== '') yield { type: 'delta', text: event.text };
          }
        }
        // Stream ended cleanly without [DONE]: tolerate and finish (usage from last frame).
        const tail = parseSseFrame(buffer);
        if (tail !== null) {
          const event = interpretSsePayload(tail);
          if (event.type === 'error') {
            yield { type: 'error', error: normalizeProviderError({ kind: 'parse', context }) };
            return;
          }
          if (event.type === 'usage') usage = event.usage;
          else if (event.type === 'delta') {
            if (event.usage !== undefined) usage = event.usage;
            if (event.text !== '') yield { type: 'delta', text: event.text };
          }
        }
        yield { type: 'done', usage };
      } catch {
        yield { type: 'error', error: this.mapFailure(phase, context) };
      }
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      if (idleTimer !== null) clearTimeout(idleTimer);
      signal.removeEventListener('abort', onExternalAbort);
    }
  }

  // Distinguish external abort / our timeouts / plain network failure → error code (§5.1).
  private mapFailure(phase: AbortPhase, context: ErrorNormalizeContext): NormalizedProviderError {
    if (phase === 'external') return normalizeProviderError({ kind: 'aborted', context });
    if (phase !== null) return normalizeProviderError({ kind: 'timeout', context });
    return normalizeProviderError({ kind: 'network', context });
  }

  private async readErrorBody(response: Response): Promise<string | null> {
    try {
      return (await response.text()).slice(0, 2000);
    } catch {
      return null;
    }
  }
}
