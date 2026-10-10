import { describe, expect, it } from 'vitest';
import {
  FIXTURE_DIGEST,
  OperationGate,
  parseMessage,
  QUALIFICATION,
  resolveUiAsset,
} from './protocol';

const message = (kind = 'validated', id = 1) =>
  JSON.stringify({ id, kind, count: 1, digest: FIXTURE_DIGEST });

describe('E2独立utility资格协议反例', () => {
  it('UI自定义协议只允许固定两资产，拒绝任意主进程或路径请求', () => {
    expect(resolveUiAsset('e2qualification://app/ui.html', 'GET')).toBe('ui.html');
    expect(resolveUiAsset('e2qualification://app/renderer.js', 'GET')).toBe('renderer.js');
    for (const url of [
      'e2qualification://app/main.js',
      'e2qualification://app/worker.js',
      'e2qualification://app/../ui.html',
      'e2qualification://app/%2e%2e/ui.html',
      'e2qualification://other/ui.html',
      'file:///ui.html',
      'e2qualification://app/ui.html?path=main.js',
      'e2qualification://app/ui.html#main',
      'e2qualification://app:80/ui.html',
      'e2qualification://user@app/ui.html',
    ])
      expect(resolveUiAsset(url, 'GET')).toBeNull();
    expect(resolveUiAsset('e2qualification://app/ui.html', 'POST')).toBeNull();
  });
  it('结果收到但进程未退出不得切换，正常退出后才可授予资格', () => {
    const gate = new OperationGate(1);
    gate.receive(message());
    expect(gate.canSwitch()).toBe(false);
    gate.confirmExit(0);
    expect(gate.canSwitch()).toBe(true);
  });
  it('超时后的迟到成功与exit0均不能复活操作', () => {
    const gate = new OperationGate(1);
    gate.fail('deadline');
    gate.receive(message());
    gate.confirmExit(0);
    expect(gate.canSwitch()).toBe(false);
    expect(gate.late).toBe(1);
    expect(gate.failure).toBe('deadline');
  });
  it('没有成功结果的exit0和成功结果后的异常退出均拒绝', () => {
    for (const ready of [true, false]) {
      const gate = new OperationGate(1);
      if (ready) gate.receive(message());
      gate.confirmExit(ready ? 1 : 0);
      expect(gate.canSwitch()).toBe(false);
    }
  });
  it('拒绝任意路径、SQL、错误ID、畸形、超长与重复结果', () => {
    for (const value of [
      null,
      {},
      message('validated', 2),
      'x'.repeat(257),
      '{',
      JSON.stringify({ id: 1, kind: 'validated', count: 1, digest: FIXTURE_DIGEST, path: '../db' }),
      JSON.stringify({
        id: 1,
        kind: 'validated',
        count: 1,
        digest: FIXTURE_DIGEST,
        sql: 'SELECT 1',
      }),
    ]) {
      expect(parseMessage(value, 1)).toBeNull();
    }
    const gate = new OperationGate(1);
    gate.receive(message());
    gate.receive(message());
    gate.confirmExit(0);
    expect(gate.canSwitch()).toBe(false);
  });
  it('消息总数超限后不再累计或处理敌手正文', () => {
    const gate = new OperationGate(1);
    for (let i = 0; i < 100; i++) gate.receive(message('heartbeat'));
    expect(gate.messages).toBe(QUALIFICATION.messageCount + 1);
    expect(gate.failure).toBe('flood');
    expect(gate.bytes).toBeLessThanOrEqual(QUALIFICATION.totalMessageBytes);
    gate.confirmExit(0);
    expect(gate.canSwitch()).toBe(false);
  });
});
