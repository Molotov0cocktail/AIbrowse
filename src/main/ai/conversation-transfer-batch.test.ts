import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { ConversationMessage } from '../../shared/types/conversation';
import { ConversationStore } from './conversation-store';
import { projectSession } from './conversation-transfer';

const ids = ['pass', 'file', 'text', 'dynamic'];
const assistant: ConversationMessage = {
  id: 'round',
  role: 'assistant',
  content: '',
  createdAt: 1,
  status: 'complete',
  toolCalls: ids.map((id) => ({ id, name: 'browser_fill', arguments: '{}' })),
};
function result(id: string): ConversationMessage {
  return {
    id: `result-${id}`,
    role: 'tool',
    content: '',
    createdAt: 2,
    status: 'complete',
    toolCallId: id,
    toolStep: {
      id,
      toolCallId: id,
      name: 'browser_fill',
      ok: false,
      contentPreview: '禁止填写',
      errorCode: 'forbidden',
      decision: 'forbidden',
      createdAt: 2,
    },
  };
}
const user: ConversationMessage = {
  id: 'user',
  role: 'user',
  content: '填写表单',
  createdAt: 0,
  status: 'complete',
};

it('persists every prefix of one assistant round with four tool results and reloads unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'rt05-batch-'));
  try {
    const store = new ConversationStore(root);
    const sessionId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const messages = [user, assistant];
    expect(store.saveMessages(sessionId, messages)).toBe(true);
    for (const id of ids) {
      messages.push(result(id));
      expect(store.saveMessages(sessionId, messages), `tool result ${id}`).toBe(true);
      expect(store.loadMessages(sessionId)).toEqual(messages);
    }
    expect(store.getStorageStatus()).toEqual({ state: 'ready', code: null });
    expect(projectSession({ version: 2, messages }).value.messages).toEqual(messages);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(
  [
    [result('pass')],
    [assistant, result('unknown')],
    [assistant, result('pass'), result('pass')],
    [assistant, result('pass'), user, result('file')],
    [assistant, result('pass'), { ...assistant, toolCalls: [] }, result('file')],
    [assistant, result('pass'), assistant, result('pass')],
  ].map((messages) => ({ messages })),
)(
  'rejects orphaned, duplicated or closed-round tool links without dropping rows (%#)',
  ({ messages }) => {
    expect(() => projectSession({ version: 2, messages })).toThrow('link');
  },
);
