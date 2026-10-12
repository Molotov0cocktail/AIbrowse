import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/main/ai/provider/fake-provider';
import { mapMessages } from '../../src/main/ai/provider/openai-compatible';
import {
  buildRoundAssistantMessage,
  replayToProviderMessages,
} from '../../src/main/ai/agent/agent-history';
import { emptyPlan, emptyResult, researchFixture } from './models-fixtures';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-model-diagnosis-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe('模型兼容与候选根因诊断', () => {
  it.each([false, true])('明确URL目标在Sources匹配=%s时均能进入捕获', async (withSource) => {
    const rounds = [
      [{ text: emptyPlan }],
      [{ text: '{"selectedCandidateIds":[]}' }],
      [{ text: '{"vendorCandidateIds":[],"claims":[],"conflicts":[]}' }],
      [{ text: emptyResult }],
    ];
    const fixture = researchFixture(root, new FakeProvider({ rounds }), 'fake', withSource);
    try {
      await fixture.runtime.run();
      expect(fixture.task()?.status, JSON.stringify(fixture.task())).toBe('completed');
      expect(fixture.task()?.stats.candidateCount).toBe(1);
      expect(fixture.observed.captureCalls).toBe(1);
      expect(fixture.observed.searchCalls).toBe(0);
      expect(fixture.task()?.stats.evidenceCount).toBe(0);
    } finally {
      fixture.close();
    }
  });

  it('Research真实运行编排的第二请求保留工具组但丢弃同轮reasoning', async () => {
    const provider = new FakeProvider({
      rounds: [
        [
          { kind: 'reasoning', text: 'SYNTHETIC_REASONING_CANARY' },
          {
            kind: 'toolCalls',
            toolCalls: [{ id: 'call-1', name: 'source_list', arguments: '{"page":0}' }],
          },
        ],
        [{ text: emptyPlan }],
        [{ text: '{"selectedCandidateIds":[]}' }],
        [{ text: '{"vendorCandidateIds":[],"claims":[],"conflicts":[]}' }],
        [{ text: emptyResult }],
      ],
    });
    const fixture = researchFixture(root, provider, 'fake');
    try {
      await fixture.runtime.run();
      expect(fixture.task()?.status, JSON.stringify(fixture.task())).toBe('completed');
      const second = provider.getRequests()[1]!;
      expect(second.messages.some((message) => message.role === 'tool')).toBe(true);
      expect(second.messages.find((message) => message.toolCalls)?.reasoning).toBeUndefined();
      expect(JSON.stringify(mapMessages(second))).not.toContain('reasoning_content');
      expect(JSON.stringify(second)).not.toContain('SYNTHETIC_REASONING_CANARY');
    } finally {
      fixture.close();
    }
  });

  it('跨run重放保留完整工具协议组且不恢复未持久化reasoning', () => {
    const toolCalls = [{ id: 'call-1', name: 'source_list', arguments: '{"page":0}' }];
    const assistant = buildRoundAssistantMessage({
      id: 'assistant-1',
      text: '',
      toolCalls,
      now: 0,
    });
    const replay = replayToProviderMessages([
      assistant,
      {
        id: 'tool-1',
        role: 'tool',
        toolCallId: 'call-1',
        content: '合成结果',
        createdAt: 0,
        status: 'complete',
      },
    ]);
    expect(replay).toHaveLength(2);
    expect(mapMessages({ system: '合成系统', messages: replay })[1]).toHaveProperty('tool_calls');
    expect(mapMessages({ system: '合成系统', messages: replay })[1]).not.toHaveProperty(
      'reasoning_content',
    );
    const currentRun = { ...replay[0]!, reasoning: 'SYNTHETIC_REASONING_CANARY' };
    expect(mapMessages({ system: '合成系统', messages: [currentRun] })[1]).toHaveProperty(
      'reasoning_content',
      'SYNTHETIC_REASONING_CANARY',
    );
  });
});
