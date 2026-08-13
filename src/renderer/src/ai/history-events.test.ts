// history-events 纯 reducer 单测（§6.1 引用链先于生成落地 + §8.1 终态收敛）：
// ask 乐观追加 user 消息 / turn-done 补全 contextSource 并追加终态 assistant 消息 /
// 磁盘历史已带 contextSource 时只追加不覆盖 / replace 整体替换。
import { describe, expect, it } from 'vitest';
import type { ContextSource, ConversationMessage } from '../../../shared/types/conversation';
import { reduceHistory } from './history-events';

const source: ContextSource = {
  mode: 'snapshot',
  tabId: 't1',
  url: 'https://example.com/',
  title: '示例页',
  capturedAt: 1000,
  degraded: false,
  thin: false,
  selectionExcerpt: null,
  warnings: [],
};

const userMessage = (content: string, withSource = false): ConversationMessage => ({
  id: 'u1',
  role: 'user',
  content,
  createdAt: 1,
  status: 'complete',
  ...(withSource ? { contextSource: source } : {}),
});

const assistantMessage = (content: string): ConversationMessage => ({
  id: 'a1',
  role: 'assistant',
  content,
  createdAt: 2,
  status: 'complete',
});

describe('reduceHistory', () => {
  it('replace 整体替换历史（切换会话）', () => {
    const replaced = [userMessage('旧历史', true)];
    expect(reduceHistory(replaced, { type: 'replace', messages: [] })).toEqual([]);
    expect(reduceHistory([], { type: 'replace', messages: replaced })).toEqual(replaced);
  });

  it('append-user 乐观追加（无 contextSource）', () => {
    const next = reduceHistory([], { type: 'append-user', message: userMessage('提问') });
    expect(next).toHaveLength(1);
    expect(next[0]?.contextSource).toBeUndefined();
  });

  it('turn-done 补全乐观 user 消息的 contextSource 并追加终态消息', () => {
    let history = reduceHistory([], { type: 'append-user', message: userMessage('提问') });
    history = reduceHistory(history, {
      type: 'turn-done',
      message: assistantMessage('回答'),
      contextSource: source,
    });
    expect(history).toHaveLength(2);
    expect(history[0]?.role).toBe('user');
    expect(history[0]?.contextSource).toEqual(source);
    expect(history[1]?.role).toBe('assistant');
    expect(history[1]?.content).toBe('回答');
  });

  it('磁盘历史已带 contextSource 时 turn-done 只追加，不覆盖', () => {
    const otherSource = { ...source, url: 'https://other.example/' };
    const history = reduceHistory([userMessage('历史提问', true)], {
      type: 'turn-done',
      message: assistantMessage('回答'),
      contextSource: otherSource,
    });
    expect(history[0]?.contextSource).toEqual(source); // 原值保留
    expect(history[1]?.content).toBe('回答');
  });

  it('turn-done 时无待补全 user 消息 → 仅追加终态消息', () => {
    const history = reduceHistory([], {
      type: 'turn-done',
      message: assistantMessage('回答'),
      contextSource: source,
    });
    expect(history).toHaveLength(1);
    expect(history[0]?.content).toBe('回答');
  });

  it('多轮追问：每轮 turn-done 正确补全各自 user 消息', () => {
    let history: ConversationMessage[] = [];
    history = reduceHistory(history, { type: 'append-user', message: userMessage('第一问') });
    history = reduceHistory(history, {
      type: 'turn-done',
      message: assistantMessage('第一答'),
      contextSource: source,
    });
    history = reduceHistory(history, { type: 'append-user', message: userMessage('第二问') });
    history = reduceHistory(history, {
      type: 'turn-done',
      message: assistantMessage('第二答'),
      contextSource: { ...source, capturedAt: 2000 },
    });
    expect(history.map((m) => m.content)).toEqual(['第一问', '第一答', '第二问', '第二答']);
    expect(history[0]?.contextSource?.capturedAt).toBe(1000);
    expect(history[2]?.contextSource?.capturedAt).toBe(2000);
  });
});
