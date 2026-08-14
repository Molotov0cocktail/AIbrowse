// ConfirmManager 确认状态机测试（红→绿，A2）。契约源：doc/stage3/detailed-design.md §7.2 +
// threat-model §3.3：单 pending（每 run 步进式天然保证，违反时 fail-closed 立即 denied）、
// approve/deny、未知或已终结 id 返回 false、cancelAll 作废、幂等、无自动批准。
import { describe, expect, it } from 'vitest';
import { ConfirmManager, type ConfirmOutcome } from './confirm-manager';

const summary = { detail: '测试确认摘要' };

function settled(p: Promise<ConfirmOutcome>): Promise<ConfirmOutcome | 'timeout'> {
  return Promise.race([
    p,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30)),
  ]);
}

describe('ConfirmManager 确认状态机', () => {
  it('requestConfirm 建立 pending（含全部字段）；approve 决议 approved 且返回 true；pending 清空', async () => {
    const m = new ConfirmManager();
    const p = m.requestConfirm('run-1', 'call-1', 'browser.click', summary);
    const pending = m.getPending();
    expect(pending?.toolCallId).toBe('call-1');
    expect(pending?.runId).toBe('run-1');
    expect(pending?.toolName).toBe('browser.click');
    expect(pending?.summary).toEqual(summary);
    expect(typeof pending?.createdAt).toBe('number');
    expect(m.approve('call-1')).toBe(true);
    await expect(p).resolves.toBe('approved');
    expect(m.getPending()).toBeNull();
  });

  it('deny 决议 denied 且返回 true', async () => {
    const m = new ConfirmManager();
    const p = m.requestConfirm('run-1', 'call-1', 't', summary);
    expect(m.deny('call-1')).toBe(true);
    await expect(p).resolves.toBe('denied');
  });

  it('未知 id 与已终结 id：approve/deny 返回 false（幂等，不改变状态）', async () => {
    const m = new ConfirmManager();
    expect(m.approve('nobody')).toBe(false);
    expect(m.deny('nobody')).toBe(false);
    const p = m.requestConfirm('run-1', 'call-1', 't', summary);
    expect(m.deny('call-1')).toBe(true);
    await p;
    expect(m.approve('call-1')).toBe(false);
    expect(m.deny('call-1')).toBe(false);
    expect(m.getPending()).toBeNull();
  });

  it('approve 两次：第二次返回 false（幂等终局）', async () => {
    const m = new ConfirmManager();
    const p = m.requestConfirm('run-1', 'call-1', 't', summary);
    expect(m.approve('call-1')).toBe(true);
    expect(m.approve('call-1')).toBe(false);
    await expect(p).resolves.toBe('approved');
  });

  it('cancelAll 匹配 runId → 决议 cancelled；作废后 approve/deny 均 false', async () => {
    const m = new ConfirmManager();
    const p = m.requestConfirm('run-1', 'call-1', 't', summary);
    m.cancelAll('run-1');
    await expect(p).resolves.toBe('cancelled');
    expect(m.getPending()).toBeNull();
    expect(m.approve('call-1')).toBe(false);
    expect(m.deny('call-1')).toBe(false);
  });

  it('cancelAll 不匹配 runId 不影响 pending；二次 cancelAll 幂等无异常', async () => {
    const m = new ConfirmManager();
    const p = m.requestConfirm('run-1', 'call-1', 't', summary);
    m.cancelAll('run-2');
    expect(m.getPending()?.toolCallId).toBe('call-1');
    m.cancelAll('run-1');
    m.cancelAll('run-1');
    await expect(p).resolves.toBe('cancelled');
  });

  it('无自动批准：决议前 promise 保持未决', async () => {
    const m = new ConfirmManager();
    const p = m.requestConfirm('run-1', 'call-1', 't', summary);
    expect(await settled(p)).toBe('timeout');
    expect(m.approve('call-1')).toBe(true);
    await expect(p).resolves.toBe('approved');
  });

  it('单 pending：并发 requestConfirm 立即决议 denied（fail-closed），既有 pending 不受影响', async () => {
    const m = new ConfirmManager();
    const first = m.requestConfirm('run-1', 'call-1', 't', summary);
    await expect(m.requestConfirm('run-1', 'call-2', 't', summary)).resolves.toBe('denied');
    expect(m.getPending()?.toolCallId).toBe('call-1');
    expect(m.deny('call-2')).toBe(false); // 第二个从未进入 pending
    expect(m.approve('call-1')).toBe(true);
    await expect(first).resolves.toBe('approved');
  });

  it('approve 与 deny 竞争：先到先得，后到返回 false（确定性终局）', async () => {
    const m = new ConfirmManager();
    const p = m.requestConfirm('run-1', 'call-1', 't', summary);
    expect(m.approve('call-1')).toBe(true);
    expect(m.deny('call-1')).toBe(false);
    await expect(p).resolves.toBe('approved');
  });
});

// ---------- A5：pending 变化回调（确认请求可见性事件源，A6 UI 驱动） ----------

describe('ConfirmManager — onPendingChange 回调（A5 可见性事件源）', () => {
  it('pending 建立 → 回调（请求）；决议/作废 → 回调（null）；幂等', async () => {
    const changes: Array<{ toolCallId: string; toolName: string } | null> = [];
    const m = new ConfirmManager();
    m.onPendingChange = (req) => {
      changes.push(req === null ? null : { toolCallId: req.toolCallId, toolName: req.toolName });
    };
    const p = m.requestConfirm('run-1', 'call-1', 'browser.click', summary);
    expect(changes).toEqual([{ toolCallId: 'call-1', toolName: 'browser.click' }]);
    expect(m.deny('call-1')).toBe(true);
    await p;
    expect(changes).toEqual([{ toolCallId: 'call-1', toolName: 'browser.click' }, null]);
  });

  it('cancelAll 作废 → 回调（null）', async () => {
    const changes: Array<{ toolCallId: string } | null> = [];
    const m = new ConfirmManager();
    m.onPendingChange = (req) => {
      changes.push(req === null ? null : { toolCallId: req.toolCallId });
    };
    const p = m.requestConfirm('run-1', 'call-1', 't', summary);
    m.cancelAll('run-1');
    await expect(p).resolves.toBe('cancelled');
    expect(changes).toEqual([{ toolCallId: 'call-1' }, null]);
    m.cancelAll('run-1'); // 幂等：不再触发回调
    expect(changes).toHaveLength(2);
  });

  it('并发请求 fail-closed（立即 denied）不触发回调（未建立 pending）', async () => {
    const changes: unknown[] = [];
    const m = new ConfirmManager();
    m.onPendingChange = (req) => {
      changes.push(req);
    };
    const first = m.requestConfirm('run-1', 'call-1', 't', summary);
    await expect(m.requestConfirm('run-1', 'call-2', 't', summary)).resolves.toBe('denied');
    expect(changes).toHaveLength(1); // 只有第一个建立了 pending
    expect(m.approve('call-1')).toBe(true);
    await first;
  });
});
