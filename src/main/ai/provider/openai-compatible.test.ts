// Pure-part tests for the OpenAI-compatible adapter: SSE framing/interpreting + message
// mapping (fetch/timeout wiring is exercised by the smoke matrix at S3+).
// Contract source: doc/stage2/detailed-design.md §3.3/§8.2;
// A1 tool-calling extension: doc/stage3/detailed-design.md §3.1（聚合校验后输出，
// 分片仅适配器内部状态，决议 #30）。
import { describe, expect, it } from 'vitest';
import {
  applyToolCallFragments,
  finalizeToolCalls,
  interpretSsePayload,
  mapMessages,
  parseSseFrame,
  streamSseBody,
  type ToolCallSlot,
} from './openai-compatible';
import type {
  NormalizedErrorCode,
  ProviderEvent,
  ProviderRequest,
} from '../../../shared/types/conversation';

const PARSE_CONTEXT = { requestId: 'req-1', providerId: 'p', model: 'm' };

// Feed raw body chunks into the SSE pipeline and collect every ProviderEvent.
async function feedSse(chunks: string[]): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  const body: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next: async (): Promise<IteratorResult<Uint8Array>> =>
          i < chunks.length
            ? { done: false, value: new TextEncoder().encode(chunks[i++]) }
            : { done: true, value: undefined },
      };
    },
  };
  for await (const event of streamSseBody(body, PARSE_CONTEXT)) {
    events.push(event);
  }
  return events;
}

// Single complete SSE frame string (data: payload + '\n\n').
const frame = (payload: string): string => `data: ${payload}\n\n`;
// Tool-call delta payload with the given function.arguments fragment.
const toolFrame = (index: number, args: string): string =>
  JSON.stringify({
    choices: [
      {
        delta: { tool_calls: [{ index, function: { arguments: args } }] },
        finish_reason: null,
      },
    ],
  });
// First fragment of a call: carries id + function name, empty arguments.
const toolStartFrame = (index: number, id: string, name: string): string =>
  JSON.stringify({
    choices: [
      {
        delta: {
          tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }],
        },
        finish_reason: null,
      },
    ],
  });
// Frame that only carries finish_reason (empty delta).
const finishFrame = (reason: string): string =>
  frame(`{"choices":[{"delta":{},"finish_reason":"${reason}"}]}`);

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

// —— A1 扩展（doc/stage3/detailed-design.md §3.1）：SSE tool_calls 聚合解析 ——

describe('interpretSsePayload — tool_calls 帧判定（A1）', () => {
  it('首分片（id+name+空 arguments）→ tool-delta 分片', () => {
    expect(
      interpretSsePayload(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      ),
    ).toEqual({
      type: 'tool-delta',
      fragments: [{ index: 0, id: 'call_1', name: 'get_weather', arguments: '' }],
    });
  });

  it('arguments 分片帧 → tool-delta 分片（无 id/name）', () => {
    expect(interpretSsePayload(toolFrame(0, '{"city":'))).toEqual({
      type: 'tool-delta',
      fragments: [{ index: 0, arguments: '{"city":' }],
    });
  });

  it('同帧多工具（多个 index 条目）→ 多个分片', () => {
    expect(
      interpretSsePayload(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'a' } },
                  { index: 1, function: { arguments: 'b' } },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      ),
    ).toEqual({
      type: 'tool-delta',
      fragments: [
        { index: 0, arguments: 'a' },
        { index: 1, arguments: 'b' },
      ],
    });
  });

  it('content 与 tool_calls 同帧 → delta 携带 toolFragments（两者不互斥）', () => {
    expect(
      interpretSsePayload(
        JSON.stringify({
          choices: [
            {
              delta: {
                content: '即将调用',
                tool_calls: [{ index: 0, function: { arguments: 'x' } }],
              },
              finish_reason: null,
            },
          ],
        }),
      ),
    ).toEqual({
      type: 'delta',
      text: '即将调用',
      toolFragments: [{ index: 0, arguments: 'x' }],
    });
  });

  it('finish_reason 与末分片同帧 → tool-delta 携带 finishReason', () => {
    expect(
      interpretSsePayload(
        JSON.stringify({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, function: { arguments: '}' } }] },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    ).toEqual({
      type: 'tool-delta',
      fragments: [{ index: 0, arguments: '}' }],
      finishReason: 'tool_calls',
    });
  });

  it('delta 空对象 + finish_reason → finish 事件', () => {
    expect(interpretSsePayload('{"choices":[{"delta":{},"finish_reason":"stop"}]}')).toEqual({
      type: 'finish',
      reason: 'stop',
    });
  });

  it('content + finish_reason 同帧（普通文本流末帧）→ delta 携带 finishReason', () => {
    expect(
      interpretSsePayload('{"choices":[{"delta":{"content":"完"},"finish_reason":"stop"}]}'),
    ).toEqual({ type: 'delta', text: '完', finishReason: 'stop' });
  });

  it('tool_calls 非法帧 → error（→ provider-error，不产出分片）', () => {
    // 非数组
    expect(interpretSsePayload('{"choices":[{"delta":{"tool_calls":"x"}}]}')).toEqual({
      type: 'error',
    });
    // 条目非对象
    expect(interpretSsePayload('{"choices":[{"delta":{"tool_calls":[42]}}]}')).toEqual({
      type: 'error',
    });
    // 缺 index
    expect(
      interpretSsePayload(
        '{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"x"}}]}}]}',
      ),
    ).toEqual({ type: 'error' });
    // index 非整数
    expect(
      interpretSsePayload(
        '{"choices":[{"delta":{"tool_calls":[{"index":1.5,"function":{"arguments":"x"}}]}}]}',
      ),
    ).toEqual({ type: 'error' });
    // function 非对象
    expect(
      interpretSsePayload('{"choices":[{"delta":{"tool_calls":[{"index":0,"function":"x"}]}}]}'),
    ).toEqual({ type: 'error' });
    // function.arguments 非字符串
    expect(
      interpretSsePayload(
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":7}}]}}]}',
      ),
    ).toEqual({ type: 'error' });
    // 条目只有 index、无 id 无 function → 无可累积内容
    expect(interpretSsePayload('{"choices":[{"delta":{"tool_calls":[{"index":0}]}}]}')).toEqual({
      type: 'error',
    });
  });
});

describe('applyToolCallFragments / finalizeToolCalls — 分槽累积与聚合校验（A1）', () => {
  it('按 index 分槽：跨帧 arguments 拼接、id/name 首分片携带', () => {
    const slots = new Map<number, ToolCallSlot>();
    expect(
      applyToolCallFragments(slots, [
        { index: 0, id: 'call_1', name: 'get_weather', arguments: '{"city":' },
        { index: 1, id: 'call_2', name: 'search.web', arguments: '{"q":' },
      ]),
    ).toBe('ok');
    expect(
      applyToolCallFragments(slots, [
        { index: 0, arguments: '"Paris"}' },
        { index: 1, arguments: '"docs"}' },
      ]),
    ).toBe('ok');
    expect([...slots.values()]).toEqual([
      { id: 'call_1', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { id: 'call_2', name: 'search.web', arguments: '{"q":"docs"}' },
    ]);
    expect([...slots.keys()]).toEqual([0, 1]);
  });

  it('防御性非法分片 → illegal（index 非整数 / 非字符串字段）', () => {
    const slots = new Map<number, ToolCallSlot>();
    expect(applyToolCallFragments(slots, [{ index: -1, arguments: '' }])).toBe('illegal');
    expect(applyToolCallFragments(slots, [{ index: 0.5, arguments: '' }])).toBe('illegal');
    expect(
      applyToolCallFragments(slots, [{ index: 0, id: 42 as unknown as string, arguments: '' }]),
    ).toBe('illegal');
    expect(applyToolCallFragments(slots, [{ index: 0, arguments: 7 as unknown as string }])).toBe(
      'illegal',
    );
  });

  it('finalize：按 index 升序输出完整 ProviderToolCall[]', () => {
    const slots = new Map<number, ToolCallSlot>([
      [2, { id: 'c2', name: 'browser.back', arguments: '{}' }],
      [0, { id: 'c0', name: 'browser.read', arguments: '{"tabId":null}' }],
      [1, { id: 'c1', name: 'browser.find', arguments: '{"text":"安全"}' }],
    ]);
    const result = finalizeToolCalls(slots);
    expect(result).toEqual({
      ok: true,
      calls: [
        { id: 'c0', name: 'browser.read', arguments: '{"tabId":null}' },
        { id: 'c1', name: 'browser.find', arguments: '{"text":"安全"}' },
        { id: 'c2', name: 'browser.back', arguments: '{}' },
      ],
    });
  });

  it('finalize：arguments 非法 JSON → 失败（不产出半截工具调用）', () => {
    const slots = new Map<number, ToolCallSlot>([
      [0, { id: 'c0', name: 'browser.read', arguments: '{"unclosed"' }],
    ]);
    expect(finalizeToolCalls(slots)).toEqual({ ok: false });
  });

  it('finalize：arguments 合法 JSON 但非对象（数字/字符串/null/数组）→ 失败', () => {
    for (const argumentsText of ['42', '"str"', 'null', '[1,2]']) {
      const slots = new Map<number, ToolCallSlot>([
        [0, { id: 'c0', name: 'browser.read', arguments: argumentsText }],
      ]);
      expect(finalizeToolCalls(slots)).toEqual({ ok: false });
    }
  });

  it('finalize：id/name 为空 → 失败；空 slots → ok 空数组', () => {
    expect(
      finalizeToolCalls(new Map([[0, { id: '', name: 'browser.read', arguments: '{}' }]])),
    ).toEqual({ ok: false });
    expect(finalizeToolCalls(new Map([[0, { id: 'c0', name: '', arguments: '{}' }]]))).toEqual({
      ok: false,
    });
    expect(finalizeToolCalls(new Map())).toEqual({ ok: true, calls: [] });
  });
});

describe('streamSseBody — SSE 管道（toolCalls 聚合产出，恰好在 done 之前，A1）', () => {
  it('arguments 跨帧拼接 + finish_reason=tool_calls 收尾 → toolCalls 恰好在 done 之前', async () => {
    const events = await feedSse([
      frame(toolStartFrame(0, 'call_a', 'get_weather')),
      frame(toolFrame(0, '{"city":')),
      frame(toolFrame(0, '"Paris"')),
      frame(toolFrame(0, '}')),
      finishFrame('tool_calls'),
      frame('[DONE]'),
    ]);
    expect(events).toEqual([
      {
        type: 'toolCalls',
        toolCalls: [{ id: 'call_a', name: 'get_weather', arguments: '{"city":"Paris"}' }],
      },
      { type: 'done' },
    ]);
    // toolCalls 恰好位于 done 之前
    expect(events.findIndex((e) => e.type === 'toolCalls')).toBe(
      events.findIndex((e) => e.type === 'done') - 1,
    );
  });

  it('首分片 id/name + 跨帧 arguments → 完整调用；同帧多工具按 index 升序', async () => {
    const events = await feedSse([
      frame(
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_0',
                    type: 'function',
                    function: { name: 'browser.read', arguments: '' },
                  },
                  {
                    index: 1,
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'browser.find', arguments: '' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        }),
      ),
      frame(toolFrame(1, '{"text":')),
      frame(toolFrame(0, '{"tabId":')),
      frame(toolFrame(1, '"安全"}')),
      frame(toolFrame(0, 'null}')),
      frame('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'),
      frame('[DONE]'),
    ]);
    expect(events).toEqual([
      {
        type: 'toolCalls',
        toolCalls: [
          { id: 'call_0', name: 'browser.read', arguments: '{"tabId":null}' },
          { id: 'call_1', name: 'browser.find', arguments: '{"text":"安全"}' },
        ],
      },
      { type: 'done' },
    ]);
  });

  it('content 与 tool_calls 同帧 → 文本 delta 先于 toolCalls 事件', async () => {
    const events = await feedSse([
      frame(
        JSON.stringify({
          choices: [
            {
              delta: {
                content: '即将调用工具。',
                tool_calls: [
                  { index: 0, id: 'c0', function: { name: 'browser.read', arguments: '{}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
      frame('[DONE]'),
    ]);
    expect(events).toEqual([
      { type: 'delta', text: '即将调用工具。' },
      { type: 'toolCalls', toolCalls: [{ id: 'c0', name: 'browser.read', arguments: '{}' }] },
      { type: 'done' },
    ]);
  });

  it('末帧 usage 透传到 done（toolCalls 与 usage 同帧不丢）', async () => {
    const events = await feedSse([
      frame(toolStartFrame(0, 'call_b', 'browser.read')),
      frame(toolFrame(0, '{"x":1}')),
      frame(
        JSON.stringify({
          choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          usage: { prompt_tokens: 5, completion_tokens: 2 },
        }),
      ),
      frame('[DONE]'),
    ]);
    expect(events).toEqual([
      {
        type: 'toolCalls',
        toolCalls: [{ id: 'call_b', name: 'browser.read', arguments: '{"x":1}' }],
      },
      { type: 'done', usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
  });

  it('非法帧（缺 index）→ 单一 provider-error 终结，无 done、无半截工具调用', async () => {
    const events = await feedSse([
      frame(toolFrame(0, '{"city":')),
      frame('{"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"x"}}]}}]}'),
      frame('[DONE]'),
    ]);
    expect(events).toHaveLength(1);
    const only = events[0];
    expect(only.type).toBe('error');
    if (only.type === 'error') {
      expect(only.error.code as NormalizedErrorCode).toBe('provider-error');
      expect(only.error.requestId).toBe('req-1');
    }
  });

  it('arguments 拼接后 JSON.parse 失败 → provider-error（finish 帧触发校验）', async () => {
    const events = await feedSse([
      frame(toolFrame(0, '{"unclosed"')),
      frame('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'),
      frame('[DONE]'),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].type === 'error' && events[0].error.code).toBe('provider-error');
  });

  it('finish_reason=stop 但存在累积槽 → 不产出 toolCalls（半成品不暴露）', async () => {
    const events = await feedSse([
      frame('{"choices":[{"delta":{"content":"回答"}}]}'),
      frame(toolFrame(0, '{"x":')),
      frame('{"choices":[{"delta":{},"finish_reason":"stop"}]}'),
      frame('[DONE]'),
    ]);
    expect(events).toEqual([{ type: 'delta', text: '回答' }, { type: 'done' }]);
  });

  it('[DONE] 无 finish 帧 → 直接 done（无 toolCalls 事件）', async () => {
    const events = await feedSse([frame('[DONE]')]);
    expect(events).toEqual([{ type: 'done' }]);
  });

  it('无 [DONE] 干净结束（tail 帧含 finish_reason）→ toolCalls 后 done', async () => {
    const events = await feedSse([
      frame(toolStartFrame(0, 'call_c', 'browser.back')),
      frame(toolFrame(0, '{}')),
      finishFrame('tool_calls'),
    ]);
    expect(events).toEqual([
      {
        type: 'toolCalls',
        toolCalls: [{ id: 'call_c', name: 'browser.back', arguments: '{}' }],
      },
      { type: 'done' },
    ]);
  });

  it('CRLF 帧归一化（\\r\\n\\r\\n 分帧）与注释/空行帧跳过', async () => {
    const crlf = (payload: string): string => `data: ${payload}\r\n\r\n`;
    const events = await feedSse([
      ': keep-alive\n\n',
      crlf(toolStartFrame(0, 'call_d', 'browser.read')),
      crlf(toolFrame(0, '{}')),
      crlf('{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}'),
      crlf('[DONE]'),
    ]);
    expect(events).toEqual([
      {
        type: 'toolCalls',
        toolCalls: [{ id: 'call_d', name: 'browser.read', arguments: '{}' }],
      },
      { type: 'done' },
    ]);
  });
});

describe('mapMessages — tool 消息与 assistant toolCalls 重放（A1）', () => {
  it('role=tool → 线格式 tool_call_id + content', () => {
    const request: ProviderRequest = {
      requestId: 'req-1',
      model: 'test',
      system: 'sys',
      messages: [{ role: 'tool', content: '已打开页面', toolCallId: 'call_9' }],
    };
    expect(mapMessages(request)).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'tool', content: '已打开页面', tool_call_id: 'call_9' },
    ]);
  });

  it('assistant + toolCalls → 线格式 tool_calls 数组（id/type/function）', () => {
    const request: ProviderRequest = {
      requestId: 'req-1',
      model: 'test',
      system: 'sys',
      messages: [
        {
          role: 'assistant',
          content: '需要读取页面',
          toolCalls: [{ id: 'call_1', name: 'browser.read', arguments: '{"tabId":null}' }],
        },
      ],
    };
    expect(mapMessages(request)).toEqual([
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: '需要读取页面',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'browser.read', arguments: '{"tabId":null}' },
          },
        ],
      },
    ]);
  });

  it('tool 消息缺 toolCallId → tool_call_id 空串（防御，调用方校验前置）', () => {
    const request: ProviderRequest = {
      requestId: 'req-1',
      model: 'test',
      system: 'sys',
      messages: [{ role: 'tool', content: 'x' }],
    };
    expect(mapMessages(request)[1]).toEqual({ role: 'tool', content: 'x', tool_call_id: '' });
  });
});
