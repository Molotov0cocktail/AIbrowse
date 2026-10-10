import { expect, it, vi } from 'vitest';
import { classifyFailure, observeThenForward } from './observations';
import { createTransferProtocol } from '../../../src/main/storage/transfer-protocol';
it('过期/超限observer不能吞原message或exit', () => {
  const failed = vi.fn(),
    forward = vi.fn();
  for (const value of [{ type: 'ready' }, { exit: 0 }])
    observeThenForward(
      value,
      () => {
        throw new Error('观察过期');
      },
      failed,
      forward,
    );
  expect(failed).toHaveBeenCalledTimes(2);
  expect(forward).toHaveBeenCalledTimes(2);
  expect(forward.mock.calls[1][0]).toEqual({ exit: 0 });
});
it('诊断只保留固定分类，不泄露敌手正文/路径/SQL', () => {
  const error = Object.assign(new Error('secret SQL C:\\private'), { code: 'ENOSPC' });
  expect(classifyFailure(error)).toEqual({ type: 'Error', code: 'ENOSPC' });
  error.name = 'secret';
  error.code = 'secret';
  expect(classifyFailure(error)).toEqual({ type: 'unknown', code: 'unclassified' });
});
it('无效worker正文在生产闭合parser之前不能进入trace，原帧仍转发', () => {
  const job = {
    operationId: '00000000-0000-4000-8000-000000000001',
    snapshotId: '00000000-0000-4000-8000-000000000002',
    action: 'backup' as const,
  };
  const protocol = createTransferProtocol(job),
    record = vi.fn(),
    forward = vi.fn(),
    failed = vi.fn();
  const raw = JSON.stringify({
    type: 'ready',
    operationId: job.operationId,
    extra: 'secret path SQL text',
  });
  observeThenForward(raw, (value) => record(protocol.receive(value)), failed, forward);
  expect(record).not.toHaveBeenCalled();
  expect(failed).toHaveBeenCalledOnce();
  expect(forward).toHaveBeenCalledExactlyOnceWith(raw);
});
