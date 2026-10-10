import { expect, it } from 'vitest';
import { ConfirmManager } from './confirm-manager';

it('pending同步通知中取消，原确认Promise也必须settle', async () => {
  const manager = new ConfirmManager();
  manager.addPendingChangeListener((change) => {
    if (change.kind === 'pending') manager.cancelAll(change.request.runId);
  });
  let result: string | null = null;
  const operation = manager.requestConfirm('run', 'call', 'source_apply_changes', {
    detail: '合成摘要',
  });
  void operation.then((value) => {
    result = value;
  });
  await Promise.resolve();
  expect(manager.getPending()).toBeNull();
  expect(result).toBe('cancelled');
  await operation;
});

it('取消终态同步通知中的新确认保留独立resolver', async () => {
  const manager = new ConfirmManager();
  let next: Promise<string> | undefined;
  manager.addPendingChangeListener((change) => {
    if (change.kind === 'settled' && change.toolCallId === 'first') {
      next = manager.requestConfirm('next', 'second', 'source_apply_changes', {
        detail: '第二次合成摘要',
      });
    }
  });
  const first = manager.requestConfirm('run', 'first', 'source_apply_changes', {
    detail: '合成摘要',
  });
  manager.cancelAll('run');
  expect(await first).toBe('cancelled');
  expect(manager.getPending()?.toolCallId).toBe('second');
  manager.deny('second');
  expect(await next).toBe('denied');
});
