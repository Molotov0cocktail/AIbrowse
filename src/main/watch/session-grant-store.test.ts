// D6 session-grant-store: 一次性 Session grant（detailed-design §8.1/§12.2、
// threat-model WT-09～WT-12、FIXED DECISIONS 7）。红→绿 oracle：TTL 边界
//（299,999ms 可消费 / 300,000ms 过期）、单次消费、失败也消费、重放/跨
// source/tab/origin/target 全拒、handle 不透明、clear/dispose 幂等。
import { describe, expect, it } from 'vitest';
import { SessionGrantStore } from './session-grant-store';
import { SESSION_GRANT_TTL_MS } from '../../shared/types/watch';

const time0 = 1_752_000_000_000;

function makeStore(nowMs: () => number = () => time0): SessionGrantStore {
  return new SessionGrantStore({ nowMs });
}

function issueOk(store: SessionGrantStore) {
  const r = store.issue({
    sourceId: 'src-1',
    previewTabId: 'tab-preview-1',
    finalOrigin: 'https://example.com',
    targetDigest: 'd1',
  });
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error('issue 失败');
  return r.handle;
}

function consume(
  store: SessionGrantStore,
  overrides: Partial<{
    handle: string;
    sourceId: string;
    previewTabId: string;
    finalOrigin: string;
    targetDigest: string;
    nowMs: number;
  }> = {},
) {
  const base = {
    handle: '',
    sourceId: 'src-1',
    previewTabId: 'tab-preview-1',
    finalOrigin: 'https://example.com',
    targetDigest: 'd1',
  };
  const merged = { ...base, ...overrides };
  const now = overrides.nowMs ?? time0;
  return store.consume(merged, now);
}

describe('SessionGrantStore — issue/consume 基本语义', () => {
  it('issue 返回不透明 base64url handle（43 字符，无绑定信息）', () => {
    const store = makeStore();
    const handle = issueOk(store);
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(store.recordCount()).toBe(1);
  });

  it('单次消费成功并原子移除记录', () => {
    const store = makeStore();
    const handle = issueOk(store);
    const c1 = store.consume(
      {
        handle,
        sourceId: 'src-1',
        previewTabId: 'tab-preview-1',
        finalOrigin: 'https://example.com',
        targetDigest: 'd1',
      },
      time0,
    );
    expect(c1).toEqual({
      ok: true,
      grant: {
        version: 1,
        origin: 'https://example.com',
        grantedAt: new Date(time0).toISOString(),
      },
    });
    expect(store.recordCount()).toBe(0);
  });

  it('重放同一 handle → not-found（已消费）', () => {
    const store = makeStore();
    const handle = issueOk(store);
    void consume(store, { handle });
    const again = consume(store, { handle });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe('not-found');
  });

  it('失败消费同样消耗记录（防重放探测）', () => {
    const store = makeStore();
    const handle = issueOk(store);
    const bad = consume(store, { handle, finalOrigin: 'https://evil.example' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('binding-mismatch');
    const replay = consume(store, { handle });
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe('not-found');
  });
});

describe('SessionGrantStore — 绑定矩阵', () => {
  it.each([
    ['sourceId', { sourceId: 'other-src' }],
    ['previewTabId', { previewTabId: 'other-tab' }],
    ['finalOrigin', { finalOrigin: 'https://evil.example' }],
    ['targetDigest', { targetDigest: 'other-digest' }],
  ] as const)('%s 不匹配 → binding-mismatch 且记录已消耗', (_label, overrides) => {
    const store = makeStore();
    const handle = issueOk(store);
    const r = consume(store, { handle, ...overrides });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('binding-mismatch');
    expect(store.recordCount()).toBe(0);
  });

  it('非法 handle 形状 → invalid-request（零查找）', () => {
    const store = makeStore();
    void issueOk(store);
    const r = consume(store, { handle: 'not-a-handle' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-request');
    expect(store.recordCount()).toBe(1); // 未消耗任何记录
  });

  // R1 修复：形状合法且确实存在的 handle，必须先原子删除再验证绑定——绑定值
  // 形状非法（空/超长 sourceId、非法 previewTabId/origin、空/超长 digest）同样消耗。
  it.each([
    ['空 sourceId', { sourceId: '' }],
    ['超长 sourceId', { sourceId: 'x'.repeat(129) }],
    ['非法 previewTabId（空）', { previewTabId: '' }],
    ['非法 previewTabId（超长）', { previewTabId: 't'.repeat(129) }],
    ['非法 origin（空）', { finalOrigin: '' }],
    ['非法 origin（非 URL）', { finalOrigin: 'not-a-url' }],
    ['空 digest', { targetDigest: '' }],
    ['超长 digest', { targetDigest: 'd'.repeat(257) }],
  ] as const)(
    '%s：首次失败且 recordCount 归零，正确绑定再消费 → not-found',
    (_label, overrides) => {
      const store = makeStore();
      const handle = issueOk(store);
      const r = consume(store, { handle, ...overrides });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('binding-mismatch');
      expect(store.recordCount()).toBe(0); // record 已被原子消耗
      const replay = consume(store, {
        handle,
        sourceId: 'src-1',
        previewTabId: 'tab-preview-1',
        finalOrigin: 'https://example.com',
        targetDigest: 'd1',
      });
      expect(replay.ok).toBe(false);
      if (!replay.ok) expect(replay.reason).toBe('not-found'); // 无法重放
    },
  );

  it('非法 handle 形状不得消耗无关记录（多记录场景）', () => {
    const store = makeStore();
    const h1 = issueOk(store);
    const h2 = issueOk(store);
    const r = consume(store, { handle: 'garbage-not-43-char' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('invalid-request');
    expect(store.recordCount()).toBe(2); // 两条记录均未受影响
    expect(consume(store, { handle: h1 }).ok).toBe(true);
    expect(consume(store, { handle: h2 }).ok).toBe(true);
  });

  it('issue 非法输入 → invalid-request 零登记', () => {
    const store = makeStore();
    expect(
      store.issue({ sourceId: '', previewTabId: 't', finalOrigin: 'o', targetDigest: 'd' }).ok,
    ).toBe(false);
    expect(
      store.issue({ sourceId: 's', previewTabId: 't', finalOrigin: 'not-a-url', targetDigest: 'd' })
        .ok,
    ).toBe(false);
    expect(store.recordCount()).toBe(0);
  });
});

describe('SessionGrantStore — TTL 边界', () => {
  it('now == expiresAt-1 可消费；now == expiresAt 已过期（消费后仍移除）', () => {
    const store = makeStore(() => time0);
    const handle = issueOk(store);
    const before = store.consume(
      {
        handle,
        sourceId: 'src-1',
        previewTabId: 'tab-preview-1',
        finalOrigin: 'https://example.com',
        targetDigest: 'd1',
      },
      time0 + SESSION_GRANT_TTL_MS - 1,
    );
    expect(before.ok).toBe(true);

    const store2 = makeStore(() => time0);
    const handle2 = issueOk(store2);
    const at = store2.consume(
      {
        handle: handle2,
        sourceId: 'src-1',
        previewTabId: 'tab-preview-1',
        finalOrigin: 'https://example.com',
        targetDigest: 'd1',
      },
      time0 + SESSION_GRANT_TTL_MS,
    );
    expect(at.ok).toBe(false);
    if (!at.ok) expect(at.reason).toBe('expired');
    expect(store2.recordCount()).toBe(0);
  });

  it('lazy expiry：过期记录未被 consume 前仍计数（无 timer）', () => {
    const store = makeStore(() => time0);
    const handle = issueOk(store);
    store.consume(
      {
        handle,
        sourceId: 'src-1',
        previewTabId: 'tab-preview-1',
        finalOrigin: 'https://example.com',
        targetDigest: 'd1',
      },
      time0 + SESSION_GRANT_TTL_MS * 2,
    );
    expect(store.recordCount()).toBe(0);
    void store;
  });
});

describe('SessionGrantStore — clear/dispose', () => {
  it('clear 清空全部记录并幂等；此后 consume 均 not-found', () => {
    const store = makeStore();
    const h1 = issueOk(store);
    const h2 = issueOk(store);
    expect(store.recordCount()).toBe(2);
    store.clear();
    expect(store.recordCount()).toBe(0);
    expect(consume(store, { handle: h1 }).ok).toBe(false);
    expect(consume(store, { handle: h2 }).ok).toBe(false);
    store.clear();
    expect(store.recordCount()).toBe(0);
  });

  it('consume 后直接可再 issue 同绑定（无跨记录状态）', () => {
    const store = makeStore();
    const h = issueOk(store);
    void consume(store, { handle: h });
    const h2 = issueOk(store);
    expect(consume(store, { handle: h2 }).ok).toBe(true);
  });
});
