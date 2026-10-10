import { expect, it } from 'vitest';
import { parseDataTransferStatus } from '../../src/preload/data-transfer-status';

const status = {
  operationId: null,
  action: null,
  state: 'recovery-required',
  code: 'recovery',
  message: '请选择备份',
  canCancel: false,
  canRecoverOriginal: false,
  availableActions: ['restore'],
};

it('可经结构化克隆传输的稀疏能力数组不能投影成undefined action', () => {
  const frame = structuredClone({ ...status, availableActions: new Array(1) });
  expect(frame.availableActions).toHaveLength(1);
  expect(Object.hasOwn(frame.availableActions, 0)).toBe(false);
  expect(() => parseDataTransferStatus(frame)).toThrow('本地数据状态无效');
});

it('合法仅恢复能力产生独立且闭合的动作数组', () => {
  const frame = structuredClone(status);
  const projected = parseDataTransferStatus(frame);
  expect(projected.availableActions).toEqual(['restore']);
  expect(projected.availableActions).not.toBe(frame.availableActions);
});
