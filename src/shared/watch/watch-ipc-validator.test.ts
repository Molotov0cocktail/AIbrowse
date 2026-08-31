import { describe, expect, it } from 'vitest';
import {
  MAX_WATCH_IPC_INPUT_BYTES,
  MAX_WATCH_IPC_OUTPUT_BYTES,
  WATCH_IPC_CHANNELS,
  validateWatchIpcOutput,
  validateWatchIpcPayload,
} from './watch-ipc-validator';

describe('D9 Watch IPC 闭合 manifest 与输入验证', () => {
  it('精确暴露 24 个固定 channel', () => {
    expect(WATCH_IPC_CHANNELS).toHaveLength(24);
    expect(new Set(WATCH_IPC_CHANNELS).size).toBe(24);
    expect(WATCH_IPC_CHANNELS[0]).toBe('watch:listRules');
    expect(WATCH_IPC_CHANNELS.at(-1)).toBe('watch:subscribe');
  });

  it('拒绝未知键、accessor、symbol 与 prototype 非 Object.prototype', () => {
    expect(validateWatchIpcPayload('watch:getRule', { ruleId: crypto.randomUUID() }).ok).toBe(true);
    expect(
      validateWatchIpcPayload('watch:getRule', { ruleId: crypto.randomUUID(), url: 'x' }).ok,
    ).toBe(false);
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'ruleId', { enumerable: true, get: () => crypto.randomUUID() });
    expect(validateWatchIpcPayload('watch:getRule', accessor).ok).toBe(false);
    const symbol = { ruleId: crypto.randomUUID(), [Symbol('x')]: true };
    expect(validateWatchIpcPayload('watch:getRule', symbol).ok).toBe(false);
    expect(validateWatchIpcPayload('watch:getRule', Object.create(null)).ok).toBe(false);
  });

  it('输入字节预算 +1 fail-closed', () => {
    const value = 'x'.repeat(MAX_WATCH_IPC_INPUT_BYTES + 1);
    expect(
      validateWatchIpcPayload('watch:previewFeed', {
        mode: 'manual',
        sourceId: crypto.randomUUID(),
        feedUrl: value,
      }).ok,
    ).toBe(false);
  });

  it('结构化条件与域模型保持同一 exact schema', () => {
    const condition = {
      version: 1,
      combine: 'all',
      predicates: [
        {
          fieldKey: 'title',
          operator: 'contains',
          operand: '更新',
          caseSensitive: false,
        },
      ],
    };
    const base = {
      mode: 'settings',
      ruleId: crypto.randomUUID(),
      expectedVersion: 1,
      schedule: { kind: 'interval', intervalMinutes: 60 },
      notificationLevel: 'normal',
      showDetails: false,
    };
    expect(validateWatchIpcPayload('watch:updateRule', { ...base, condition }).ok).toBe(true);
    expect(
      validateWatchIpcPayload('watch:updateRule', {
        ...base,
        condition: { combine: 'all', predicates: condition.predicates },
      }).ok,
    ).toBe(false);
    for (const fieldKey of ['', '__proto__', 'a.b', 'a[0]', '0', '*'])
      expect(
        validateWatchIpcPayload('watch:updateRule', {
          ...base,
          condition: {
            version: 1,
            combine: 'all',
            predicates: [{ ...condition.predicates[0], fieldKey }],
          },
        }).ok,
      ).toBe(false);
    expect(
      validateWatchIpcPayload('watch:updateRule', {
        ...base,
        condition: {
          version: 1,
          combine: 'all',
          predicates: [{ fieldKey: 'title', operator: 'contains', operand: '更新' }],
        },
      }).ok,
    ).toBe(false);
  });

  it('输出拒绝未知顶层形状、敏感键、accessor 与字节预算 +1', () => {
    expect(
      validateWatchIpcOutput(
        { ok: true, value: { exportedRows: 1, exportedBytes: 10 } },
        'watch:exportEventsCsv',
      ),
    ).toBe(true);
    expect(
      validateWatchIpcOutput(
        { ok: true, value: { exportedRows: 1, exportedBytes: 10, extra: true } },
        'watch:exportEventsCsv',
      ),
    ).toBe(false);
    expect(validateWatchIpcOutput({ ok: true, value: { filePath: 'forbidden' } })).toBe(false);
    expect(
      validateWatchIpcOutput({
        ok: true,
        value: { text: 'x'.repeat(MAX_WATCH_IPC_OUTPUT_BYTES + 1) },
      }),
    ).toBe(false);
    expect(validateWatchIpcOutput({ success: true })).toBe(false);
    const accessor = { ok: true } as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => ({}) });
    expect(validateWatchIpcOutput(accessor)).toBe(false);
    expect(
      validateWatchIpcOutput(
        { ok: true, value: { ruleId: 'not-a-uuid', version: '1' } },
        'watch:createRule',
      ),
    ).toBe(false);
    expect(
      validateWatchIpcOutput(
        { ok: true, value: { exportedRows: -1, exportedBytes: 0 } },
        'watch:exportEventsCsv',
      ),
    ).toBe(false);
  });

  it('输出对分页 item 与嵌套 DTO 做 deep exact 验证', () => {
    const rule = {
      id: crypto.randomUUID(),
      version: 1,
      sourceId: crypto.randomUUID(),
      sourceName: '安全名称',
      kind: 'page',
      state: 'enabled',
      pauseReason: null,
      desiredEnabled: true,
      muted: false,
      accessMode: 'public',
      schedule: { kind: 'interval', intervalMinutes: 60 },
      condition: null,
      notificationLevel: 'normal',
      showDetails: false,
      targetDisplay: 'example.com/news',
      lastCheckedAt: null,
      lastChangedAt: null,
      nextDueAt: null,
      health: 'healthy',
      backoffUntil: null,
    };
    const output = { ok: true, value: { page: 1, pageSize: 50, total: 1, items: [rule] } };
    expect(validateWatchIpcOutput(output, 'watch:listRules')).toBe(true);
    expect(
      validateWatchIpcOutput(
        { ...output, value: { ...output.value, items: [{ ...rule, rawBody: 'secret' }] } },
        'watch:listRules',
      ),
    ).toBe(false);
    expect(
      validateWatchIpcOutput(
        {
          ...output,
          value: {
            ...output.value,
            items: [{ ...rule, schedule: { ...rule.schedule, cron: '*' } }],
          },
        },
        'watch:listRules',
      ),
    ).toBe(false);
  });
});
