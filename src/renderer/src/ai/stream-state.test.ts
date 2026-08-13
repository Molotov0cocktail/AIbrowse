// stream-state 纯 reducer 单测（§8.1/§8.3 + §13.1 S4 部分）：
// delta 追加 / turn-done 收敛（complete 全文 / aborted 保留部分 / error 文案）/
// requestId 不匹配的竞态残留忽略 / ask 同步拒绝 / 新一轮重置。
import { describe, expect, it } from 'vitest';
import type {
  ConversationMessage,
  NormalizedProviderError,
} from '../../../shared/types/conversation';
import { INITIAL_STREAM_STATE, reduceStream, type StreamState } from './stream-state';

const msg = (content: string, status: ConversationMessage['status']): ConversationMessage => ({
  id: 'm1',
  role: 'assistant',
  content,
  createdAt: 1,
  status,
});

const err = (code: NormalizedProviderError['code'], message: string): NormalizedProviderError => ({
  code,
  message,
  retryable: false,
  providerId: 'fake',
  model: 'fake-model',
  requestId: 'r1',
});

const start = (state: StreamState): StreamState =>
  reduceStream(state, { type: 'start', requestId: 'r1', sessionId: 's1' });

describe('reduceStream', () => {
  it('start 重置上一轮状态并进入 streaming', () => {
    const prev: StreamState = {
      requestId: 'r0',
      sessionId: 's0',
      text: '旧回答',
      status: 'done',
      doneStatus: 'complete',
      errorMessage: '旧错误',
    };
    expect(reduceStream(prev, { type: 'start', requestId: 'r1', sessionId: 's1' })).toEqual({
      requestId: 'r1',
      sessionId: 's1',
      text: '',
      status: 'streaming',
      doneStatus: null,
      errorMessage: null,
    });
  });

  it('chunk 逐块追加（不聚合）', () => {
    let state = start(INITIAL_STREAM_STATE);
    state = reduceStream(state, { type: 'chunk', requestId: 'r1', delta: '你好' });
    state = reduceStream(state, { type: 'chunk', requestId: 'r1', delta: '，世界' });
    expect(state.text).toBe('你好，世界');
    expect(state.status).toBe('streaming');
  });

  it('requestId 不匹配的 chunk 按竞态残留忽略', () => {
    const state = start(INITIAL_STREAM_STATE);
    const next = reduceStream(state, { type: 'chunk', requestId: 'r-other', delta: '串扰' });
    expect(next).toBe(state); // 不可变：原状态原样返回
  });

  it('已终态后到达的 chunk 忽略', () => {
    let state = start(INITIAL_STREAM_STATE);
    state = reduceStream(state, {
      type: 'turn-done',
      requestId: 'r1',
      message: msg('完成', 'complete'),
      error: null,
    });
    const next = reduceStream(state, { type: 'chunk', requestId: 'r1', delta: '多余' });
    expect(next.text).toBe('完成');
  });

  it('turn-done 收敛：complete 以终态全文为准', () => {
    let state = start(INITIAL_STREAM_STATE);
    state = reduceStream(state, { type: 'chunk', requestId: 'r1', delta: '部分' });
    state = reduceStream(state, {
      type: 'turn-done',
      requestId: 'r1',
      message: msg('完整回答', 'complete'),
      error: null,
    });
    expect(state).toEqual({
      requestId: 'r1',
      sessionId: 's1',
      text: '完整回答',
      status: 'done',
      doneStatus: 'complete',
      errorMessage: null,
    });
  });

  it('turn-done 收敛：aborted 保留部分 + 无错误文案', () => {
    const state = reduceStream(start(INITIAL_STREAM_STATE), {
      type: 'turn-done',
      requestId: 'r1',
      message: msg('第一段，', 'aborted'),
      error: err('aborted', '已中止'),
    });
    expect(state.text).toBe('第一段，');
    expect(state.doneStatus).toBe('aborted');
    expect(state.status).toBe('done');
  });

  it('turn-done 收敛：error 保留部分 + 错误文案', () => {
    const state = reduceStream(start(INITIAL_STREAM_STATE), {
      type: 'turn-done',
      requestId: 'r1',
      message: msg('生成到一半', 'error'),
      error: err('timeout', '请求超时，请稍后重试'),
    });
    expect(state.text).toBe('生成到一半');
    expect(state.doneStatus).toBe('error');
    expect(state.errorMessage).toBe('请求超时，请稍后重试');
  });

  it('requestId 不匹配的 turn-done 忽略（他轮/他会话终态）', () => {
    const state = start(INITIAL_STREAM_STATE);
    const next = reduceStream(state, {
      type: 'turn-done',
      requestId: 'r-other',
      message: msg('别人的回答', 'complete'),
      error: null,
    });
    expect(next).toBe(state);
  });

  it('rejected 记录拒绝文案；在途时到达的 rejected 忽略（每会话单在途）', () => {
    const idle = reduceStream(INITIAL_STREAM_STATE, {
      type: 'rejected',
      message: '上一条回答还在生成中',
    });
    expect(idle.errorMessage).toBe('上一条回答还在生成中');
    expect(idle.status).toBe('idle');

    const inFlight = start(INITIAL_STREAM_STATE);
    expect(
      reduceStream(inFlight, { type: 'rejected', message: '竞态拒绝' }).errorMessage,
    ).toBeNull();
  });

  it('rejected 后 start 清空错误文案', () => {
    const rejected = reduceStream(INITIAL_STREAM_STATE, { type: 'rejected', message: 'x' });
    expect(start(rejected).errorMessage).toBeNull();
  });
});
