// Pure-function tests for provider error normalization (red→green: matrix tests landed first).
// Contract source: doc/stage2/detailed-design.md §5.1 (redaction: errors never contain
// response bodies / request headers / API keys; response body text never reaches the UI).
import { describe, expect, it } from 'vitest';
import {
  isContextTooLongIndicator,
  normalizeProviderError,
  type ErrorNormalizeContext,
} from './error-normalize';

const CTX: ErrorNormalizeContext = {
  requestId: 'req-1',
  providerId: 'openai-compatible',
  model: 'test-model',
};

describe('normalizeProviderError — HTTP 状态码矩阵（§5.1）', () => {
  it('401/403 → invalid-key（不可重试，仅状态码入错误）', () => {
    for (const status of [401, 403]) {
      const err = normalizeProviderError({
        kind: 'http',
        context: CTX,
        httpStatus: status,
        responseText: null,
      });
      expect(err.code).toBe('invalid-key');
      expect(err.retryable).toBe(false);
      expect(err.message).toBe('API Key 无效或无权限，请检查设置');
      expect(err.httpStatus).toBe(status);
      expect(err.requestId).toBe('req-1');
      expect(err.providerId).toBe('openai-compatible');
      expect(err.model).toBe('test-model');
    }
  });

  it('429 → rate-limit（可重试）', () => {
    const err = normalizeProviderError({ kind: 'http', context: CTX, httpStatus: 429 });
    expect(err.code).toBe('rate-limit');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('请求过于频繁，请稍后重试');
  });

  it('400/422 + 上下文超限指征 → context-too-long（不可重试）', () => {
    const bodies = [
      "This model's maximum context length is 8192 tokens.",
      'error: context_length exceeded (400)',
      'context window limit reached',
    ];
    for (const status of [400, 422]) {
      for (const body of bodies) {
        const err = normalizeProviderError({
          kind: 'http',
          context: CTX,
          httpStatus: status,
          responseText: body,
        });
        expect(err.code).toBe('context-too-long');
        expect(err.retryable).toBe(false);
        expect(err.message).toBe('内容超出模型限制，请新开会话或缩短问题');
        expect(err.httpStatus).toBe(status);
      }
    }
  });

  it('400 无指征 → provider-error（其余 4xx 文案含状态码、不可重试）', () => {
    const err = normalizeProviderError({
      kind: 'http',
      context: CTX,
      httpStatus: 400,
      responseText: 'bad request: invalid json body',
    });
    expect(err.code).toBe('provider-error');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('服务请求被拒绝（状态码 400）');
  });

  it('其余 4xx（如 418）→ provider-error（文案含状态码）', () => {
    const err = normalizeProviderError({ kind: 'http', context: CTX, httpStatus: 418 });
    expect(err.code).toBe('provider-error');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('服务请求被拒绝（状态码 418）');
  });

  it('5xx → provider-error（可重试，服务暂时不可用）', () => {
    for (const status of [500, 502, 503]) {
      const err = normalizeProviderError({ kind: 'http', context: CTX, httpStatus: status });
      expect(err.code).toBe('provider-error');
      expect(err.retryable).toBe(true);
      expect(err.message).toBe('服务暂时不可用，请稍后重试');
      expect(err.httpStatus).toBe(status);
    }
  });

  it('非法状态码（越界输入）→ provider-error 兜底，不抛异常、不带状态码', () => {
    for (const status of [0, 99, 399, 600, 3.5, Number.NaN]) {
      const err = normalizeProviderError({ kind: 'http', context: CTX, httpStatus: status });
      expect(err.code).toBe('provider-error');
      expect(err.retryable).toBe(false);
      expect(err.httpStatus).toBeUndefined();
    }
  });
});

describe('normalizeProviderError — 非 HTTP 条件（§5.1）', () => {
  it('network → 可重试', () => {
    const err = normalizeProviderError({ kind: 'network', context: CTX });
    expect(err.code).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('网络连接失败，请检查网络与代理设置');
  });

  it('timeout → 可重试（连接/空闲/总超时统一归 time）', () => {
    const err = normalizeProviderError({ kind: 'timeout', context: CTX });
    expect(err.code).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect(err.message).toBe('请求超时，请稍后重试');
  });

  it('aborted → 已中止（不可重试）', () => {
    const err = normalizeProviderError({ kind: 'aborted', context: CTX });
    expect(err.code).toBe('aborted');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('已中止');
  });

  it('parse → provider-error（解析失败文案，不可重试）', () => {
    const err = normalizeProviderError({ kind: 'parse', context: CTX });
    expect(err.code).toBe('provider-error');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('服务响应解析失败');
  });

  it('not-configured → providerId/model 为 null（尚未配置提示）', () => {
    const err = normalizeProviderError({ kind: 'not-configured', requestId: 'req-2' });
    expect(err.code).toBe('not-configured');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('尚未配置 AI Provider 或 API Key，请先在设置中配置');
    expect(err.providerId).toBeNull();
    expect(err.model).toBeNull();
    expect(err.requestId).toBe('req-2');
  });

  it('internal → 不可重试', () => {
    const err = normalizeProviderError({ kind: 'internal', context: CTX });
    expect(err.code).toBe('internal');
    expect(err.retryable).toBe(false);
    expect(err.message).toBe('内部错误，详情见日志');
  });
});

describe('normalizeProviderError — 脱敏红线（§5.1）', () => {
  it('错误不含响应体与 API Key（含 sk- 形态密钥）', () => {
    const key = 'sk-proj-test-1234567890abcdef';
    const body = `{"error":{"message":"maximum context length exceeded","secret":"${key}"}}`;
    const err = normalizeProviderError({
      kind: 'http',
      context: CTX,
      httpStatus: 400,
      responseText: body,
    });
    expect(err.code).toBe('context-too-long'); // 指征判定正常，但响应体内容不得进入输出
    for (const value of Object.values(err)) {
      if (typeof value === 'string') {
        expect(value).not.toContain(key);
        expect(value).not.toContain('maximum context');
        expect(value).not.toContain('secret');
      }
    }
  });

  it('任意归一化错误序列化后不含 sk- 形态密钥', () => {
    const inputs = [
      { kind: 'http', context: CTX, httpStatus: 401, responseText: 'sk-abcde-fghij-1234567890' },
      { kind: 'network', context: CTX },
      { kind: 'timeout', context: CTX },
      { kind: 'parse', context: CTX },
      { kind: 'aborted', context: CTX },
      { kind: 'not-configured', requestId: 'req-3' },
      { kind: 'internal', context: CTX },
    ] as const;
    for (const input of inputs) {
      const err = normalizeProviderError(input);
      expect(JSON.stringify(err)).not.toMatch(/sk-/i);
    }
  });
});

describe('isContextTooLongIndicator — 上下文超限指征判定（确定性）', () => {
  it('识别 context_length / maximum context / tokens / context window 指征', () => {
    expect(isContextTooLongIndicator('error: context_length exceeded')).toBe(true);
    expect(isContextTooLongIndicator("This model's maximum context length is 8192 tokens.")).toBe(
      true,
    );
    expect(isContextTooLongIndicator('context window limit reached')).toBe(true);
    expect(isContextTooLongIndicator('max_tokens parameter out of range')).toBe(true);
  });

  it('无关文本不误判', () => {
    expect(isContextTooLongIndicator('bad request: invalid json body')).toBe(false);
    expect(isContextTooLongIndicator('')).toBe(false);
  });
});

describe('normalizeProviderError — 输出形状', () => {
  it('字段完整且 httpStatus 仅按需存在', () => {
    const err = normalizeProviderError({ kind: 'parse', context: CTX });
    expect(Object.keys(err).sort()).toEqual(
      ['code', 'message', 'model', 'providerId', 'requestId', 'retryable'].sort(),
    );
    expect(err.httpStatus).toBeUndefined();
  });
});
