// Provider error normalization: pure function, zero environment deps.
// Contract source: doc/stage2/detailed-design.md §5.1 (status-code matrix + redaction line:
// normalized errors and logs never contain response bodies / request headers / API keys;
// provider response text never reaches the UI).
import type {
  NormalizedErrorCode,
  NormalizedProviderError,
} from '../../../shared/types/conversation';

export interface ErrorNormalizeContext {
  requestId: string;
  providerId: string | null;
  model: string | null;
}

export type NormalizeInput =
  | { kind: 'not-configured'; requestId: string }
  | {
      kind: 'http';
      context: ErrorNormalizeContext;
      httpStatus: number;
      // Used ONLY for the 400/422 context-overflow indicator sniff; never enters any output.
      responseText?: string | null;
    }
  | {
      kind: 'network' | 'timeout' | 'aborted' | 'parse' | 'internal';
      context: ErrorNormalizeContext;
    };

const MESSAGES: Record<NormalizedErrorCode, string> = {
  'not-configured': '尚未配置 AI Provider 或 API Key，请先在设置中配置',
  'invalid-key': 'API Key 无效或无权限，请检查设置',
  'rate-limit': '请求过于频繁，请稍后重试',
  timeout: '请求超时，请稍后重试',
  network: '网络连接失败，请检查网络与代理设置',
  'context-too-long': '内容超出模型限制，请新开会话或缩短问题',
  'provider-error': '服务响应异常',
  aborted: '已中止',
  busy: '上一条回答还在生成中',
  'not-found': '会话不存在或已删除',
  internal: '内部错误，详情见日志',
};

const SERVER_UNAVAILABLE_MESSAGE = '服务暂时不可用，请稍后重试';
const PARSE_FAILURE_MESSAGE = '服务响应解析失败';

function makeError(
  code: NormalizedErrorCode,
  message: string,
  retryable: boolean,
  requestId: string,
  providerId: string | null,
  model: string | null,
  httpStatus?: number,
): NormalizedProviderError {
  const error: NormalizedProviderError = { code, message, retryable, providerId, model, requestId };
  if (httpStatus !== undefined) error.httpStatus = httpStatus;
  return error;
}

// Context-overflow indicators per §5.1 (context_length / maximum context / tokens etc.).
// Deterministic; used only for 400/422 responses.
export function isContextTooLongIndicator(text: string): boolean {
  return /context_length|maximum\s+context|context\s+length|context\s+window|max_tokens|too\s+long|tokens/i.test(
    text,
  );
}

export function normalizeProviderError(input: NormalizeInput): NormalizedProviderError {
  if (input.kind === 'not-configured') {
    return makeError(
      'not-configured',
      MESSAGES['not-configured'],
      false,
      input.requestId,
      null,
      null,
    );
  }
  const { requestId, providerId, model } = input.context;
  switch (input.kind) {
    case 'network':
      return makeError('network', MESSAGES.network, true, requestId, providerId, model);
    case 'timeout':
      return makeError('timeout', MESSAGES.timeout, true, requestId, providerId, model);
    case 'aborted':
      return makeError('aborted', MESSAGES.aborted, false, requestId, providerId, model);
    case 'parse':
      return makeError(
        'provider-error',
        PARSE_FAILURE_MESSAGE,
        false,
        requestId,
        providerId,
        model,
      );
    case 'internal':
      return makeError('internal', MESSAGES.internal, false, requestId, providerId, model);
    case 'http': {
      const status = input.httpStatus;
      // Out-of-range input: safe fallback (no exception, no status echoed).
      if (!Number.isInteger(status) || status < 400 || status > 599) {
        return makeError(
          'provider-error',
          MESSAGES['provider-error'],
          false,
          requestId,
          providerId,
          model,
        );
      }
      if (status === 401 || status === 403) {
        return makeError(
          'invalid-key',
          MESSAGES['invalid-key'],
          false,
          requestId,
          providerId,
          model,
          status,
        );
      }
      if (status === 429) {
        return makeError(
          'rate-limit',
          MESSAGES['rate-limit'],
          true,
          requestId,
          providerId,
          model,
          status,
        );
      }
      if (
        (status === 400 || status === 422) &&
        input.responseText !== null &&
        input.responseText !== undefined &&
        isContextTooLongIndicator(input.responseText)
      ) {
        return makeError(
          'context-too-long',
          MESSAGES['context-too-long'],
          false,
          requestId,
          providerId,
          model,
          status,
        );
      }
      if (status >= 500) {
        return makeError(
          'provider-error',
          SERVER_UNAVAILABLE_MESSAGE,
          true,
          requestId,
          providerId,
          model,
          status,
        );
      }
      // Other 4xx: message carries the status code only — never the response body (§5.1).
      return makeError(
        'provider-error',
        `服务请求被拒绝（状态码 ${status}）`,
        false,
        requestId,
        providerId,
        model,
        status,
      );
    }
  }
}
