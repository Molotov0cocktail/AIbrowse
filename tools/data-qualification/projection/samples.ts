import { LIMITS, inspectShape } from './projection';
import { conversationMessage, fixtureId } from '../fixtures';

export const MEASUREMENT = Object.freeze({
  diskBytes: 256 * 1024 ** 2,
  operationMs: 30_000,
  jobMs: 30_000,
  jobCleanupMs: 30_000,
  chunkBytes: 64 * 1024,
});

export function fullFields() {
  return {
    version: 2,
    messages: [
      {
        ...conversationMessage('用户保留文本\u0000"\\界'),
        role: 'user',
        contextSource: {
          mode: 'selection',
          tabId: fixtureId(1),
          url: 'https://synthetic.invalid/path',
          title: '合成页面',
          capturedAt: 0,
          degraded: true,
          thin: true,
          selectionExcerpt: '摘录'.repeat(100),
          warnings: ['合成警告', '\u0000"\\'],
        },
      },
      {
        ...conversationMessage('工具轮文本'),
        id: fixtureId(1),
        status: 'error',
        errorCode: 'internal',
        toolCalls: [{ id: 'call-1', name: 'browser_read', arguments: '{"tabId":"synthetic"}' }],
        agentRun: {
          requestId: fixtureId(2),
          sessionId: fixtureId(0),
          status: 'error',
          stepsUsed: 12,
          maxSteps: 12,
          finalText: '合法终态文本\u0000界',
          toolStepCount: 1,
        },
      },
      {
        ...conversationMessage('工具摘要'),
        id: fixtureId(3),
        role: 'tool',
        toolCallId: 'call-1',
        toolStep: {
          id: 'call-1',
          toolCallId: 'call-1',
          name: 'browser_read',
          ok: false,
          contentPreview: '摘要'.repeat(100),
          errorCode: 'execution-failed',
          decision: 'confirmed',
          createdAt: 0,
        },
      },
    ],
  };
}

export function fiftyIndex() {
  return {
    version: 1,
    sessions: Array.from({ length: 50 }, (_, i) => ({
      id: fixtureId(i),
      title: '\u0001'.repeat(30),
      createdAt: Number.MAX_SAFE_INTEGER,
      updatedAt: Number.MAX_SAFE_INTEGER,
      ephemeral: false,
    })),
  };
}

export function denseSession(unit: string, callCount = 64, textUnits = 16_000) {
  const content = unit.repeat(textUnits);
  return {
    version: 2,
    messages: Array.from({ length: 200 }, (_, i) => ({
      ...conversationMessage(content),
      id: fixtureId(i),
      toolCalls: Array.from({ length: callCount }, (_, n) => ({
        id: `call-${n}`,
        name: 'browser_read',
        arguments: '{}',
      })),
      agentRun: {
        requestId: fixtureId(300),
        sessionId: fixtureId(301),
        status: 'done',
        stepsUsed: 12,
        maxSteps: 12,
        finalText: content,
        toolStepCount: 12,
      },
    })),
  };
}

export function exactMessage() {
  const base = conversationMessage('');
  return conversationMessage(
    'a'.repeat(LIMITS.messageBytes - Buffer.byteLength(JSON.stringify(base))),
  );
}

export function exactSession() {
  const messages = Array.from({ length: LIMITS.messages }, (_, i) => ({
    ...conversationMessage(''),
    id: fixtureId(i),
  }));
  const overhead = Buffer.byteLength(JSON.stringify({ version: 2, messages }));
  const fill = LIMITS.sessionBytes - overhead;
  const each = Math.floor(fill / messages.length);
  for (let i = 0; i < messages.length; i++)
    messages[i]!.content = 'a'.repeat(each + (i === 0 ? fill % messages.length : 0));
  return { version: 2, messages };
}

export function exactNodes() {
  const user = fullFields().messages[0]!;
  if (!('contextSource' in user)) throw new Error('固定用户消息夹具缺失');
  user.contextSource.warnings = [];
  const raw = { version: 2, messages: [user] };
  user.contextSource.warnings = Array.from(
    { length: LIMITS.nodes - inspectShape(raw).nodes },
    () => '',
  );
  return raw;
}

export const FIXED_SAMPLES = [
  { id: 'full-fields', create: fullFields, pretty: true },
  {
    id: 'known-large-cjk',
    create: () => ({ version: 2, messages: [conversationMessage('界'.repeat(1_048_576))] }),
    pretty: true,
  },
  { id: 'dense-ascii', create: () => denseSession('a'), pretty: true },
  { id: 'dense-cjk', create: () => denseSession('界'), pretty: true },
  { id: 'dense-escape', create: () => denseSession('\u0001'), pretty: true },
  { id: 'dense-toolcalls-256', create: () => denseSession('界', 256, 1), pretty: true },
  { id: 'nodes-262144', create: exactNodes, pretty: false },
  { id: 'message-4mib', create: () => ({ version: 2, messages: [exactMessage()] }), pretty: false },
  { id: 'session-64mib', create: exactSession, pretty: false },
] as const;
