// Pure-part tests for the OpenAI-compatible adapter: SSE framing/interpreting + message
// mapping (fetch/timeout wiring is exercised by the smoke matrix at S3+).
// Contract source: doc/stage2/detailed-design.md §3.3/§8.2.
import { describe, expect, it } from 'vitest';
import { interpretSsePayload, mapMessages, parseSseFrame } from './openai-compatible';
import type { ProviderRequest } from '../../../shared/types/conversation';

describe('parseSseFrame — SSE 分帧（\\n\\n）后的帧内解析', () => {
  it('提取 data: 行负载并剥离单个前导空格', () => {
    expect(parseSseFrame('data: {"a":1}')).toBe('{"a":1}');
    expect(parseSseFrame('data:hello')).toBe('hello');
  });

  it('多 data: 行拼接为单条负载（换行连接）', () => {
    expect(parseSseFrame('data: line1\ndata: line2')).toBe('line1\nline2');
  });

  it('无 data: 行（注释/心跳/其他字段）→ null', () => {
    expect(parseSseFrame(': keep-alive')).toBeNull();
    expect(parseSseFrame('event: ping')).toBeNull();
    expect(parseSseFrame('')).toBeNull();
  });
});

describe('interpretSsePayload — 帧负载判定（确定性）', () => {
  it('[DONE] → done-marker', () => {
    expect(interpretSsePayload('[DONE]')).toEqual({ type: 'done-marker' });
    expect(interpretSsePayload('  [DONE]  ')).toEqual({ type: 'done-marker' });
  });

  it('delta content → delta（choices[0].delta.content）', () => {
    expect(interpretSsePayload('{"choices":[{"delta":{"content":"你好"}}]}')).toEqual({
      type: 'delta',
      text: '你好',
    });
  });

  it('role 首帧（content 空串）→ delta 空串（由调用方跳过）', () => {
    expect(
      interpretSsePayload('{"choices":[{"delta":{"role":"assistant","content":""}}]}'),
    ).toEqual({ type: 'delta', text: '' });
  });

  it('usage 帧 → usage（prompt/completion tokens）', () => {
    expect(
      interpretSsePayload('{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}'),
    ).toEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } });
  });

  it('末帧 content 与 usage 同帧 → delta 携带 usage（不丢最后一段内容）', () => {
    expect(
      interpretSsePayload(
        '{"choices":[{"delta":{"content":"x"}}],"usage":{"completion_tokens":1}}',
      ),
    ).toEqual({ type: 'delta', text: 'x', usage: { outputTokens: 1 } });
  });

  it('空 choices 数组 / delta 无 content → skip（已知帧形态容错）', () => {
    expect(interpretSsePayload('{"choices":[]}')).toEqual({ type: 'skip' });
    expect(interpretSsePayload('{"choices":[{"delta":{}}]}')).toEqual({ type: 'skip' });
  });

  it('非法 JSON → error（→ provider-error 解析失败）', () => {
    expect(interpretSsePayload('not json')).toEqual({ type: 'error' });
    expect(interpretSsePayload('')).toEqual({ type: 'error' });
  });

  it('非预期结构（无 choices/usage、choices 非数组）→ error', () => {
    expect(interpretSsePayload('{"foo":1}')).toEqual({ type: 'error' });
    expect(interpretSsePayload('{"choices":"x"}')).toEqual({ type: 'error' });
    expect(interpretSsePayload('[1,2]')).toEqual({ type: 'error' });
    expect(interpretSsePayload('null')).toEqual({ type: 'error' });
  });
});

describe('mapMessages — IR → wire 消息映射（适配器不做拼接）', () => {
  it('system 独立映射为首条消息，user/assistant 原样透传', () => {
    const request: ProviderRequest = {
      requestId: 'req-1',
      model: 'test',
      system: '你是助手',
      messages: [
        { role: 'user', content: '问题' },
        { role: 'assistant', content: '回答' },
      ],
    };
    expect(mapMessages(request)).toEqual([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '回答' },
    ]);
  });
});
