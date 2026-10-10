import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DiagnosticService } from './diagnostic-service';

function snapshot(tabs = 2) {
  return {
    application: { version: '1.2.3', buildId: 'a'.repeat(40) },
    runtime: { electron: '43.7.7', node: '24.18.0', chromium: '142.0.7444.175' },
    features: {
      browser: 'available',
      ai: 'degraded',
      sources: 'available',
      research: 'available',
      watch: 'disabled',
      storage: 'available',
    },
    errors: {
      startup: 0,
      storage: 0,
      browser: 1,
      provider: 0,
      research: 0,
      watch: 0,
      renderer: 0,
      other: 0,
    },
    counts: {
      tabs,
      sessions: null,
      sources: null,
      researchTasks: null,
      watchRules: null,
      pendingOperations: 0,
    },
    durationsMs: {
      startup: 120,
      pageSnapshot: null,
      sourceSearch: null,
      researchRun: null,
      watchCycle: null,
    },
  };
}

function harness() {
  let now = 1_000;
  let monotonicNow = 10;
  let currentOwner = 'document-a';
  let currentSnapshot: unknown = snapshot();
  const writes: Array<{ path: string; text: string }> = [];
  const service = new DiagnosticService({
    snapshot: { snapshot: () => currentSnapshot },
    save: {
      showSaveDialog: vi.fn(async () => 'selected.json'),
      write: vi.fn(async (path, bytes) => {
        writes.push({ path, text: new TextDecoder().decode(bytes) });
      }),
    },
    clock: { now: () => now },
    monotonicClock: { now: () => monotonicNow },
    isOwnerCurrent: (owner) => owner === currentOwner,
    ttlMs: 100,
  });
  return {
    service,
    writes,
    setNow: (value: number) => {
      now = value;
    },
    setMonotonicNow: (value: number) => {
      monotonicNow = value;
    },
    setOwner: (value: string) => {
      currentOwner = value;
    },
    setSnapshot: (value: unknown) => {
      currentSnapshot = value;
    },
  };
}

describe('DiagnosticService', () => {
  it('保存预览时冻结的同一JSON和digest，不重新采样', async () => {
    const h = harness();
    const preview = h.service.preview('document-a');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    h.setSnapshot(snapshot(99));
    const result = await h.service.export('document-a', {
      sequence: preview.preview.sequence,
      digest: preview.preview.digest,
    });
    expect(result).toEqual({
      ok: true,
      digest: preview.preview.digest,
      byteLength: preview.preview.byteLength,
    });
    expect(h.writes).toEqual([{ path: 'selected.json', text: preview.preview.json }]);
    expect(createHash('sha256').update(h.writes[0]!.text).digest('hex')).toBe(
      preview.preview.digest,
    );
    expect(h.writes[0]!.text).toContain('"tabs":2');
    expect(h.writes[0]!.text).not.toContain('99');
  });

  it('污染字段、无效快照和非当前文档均关闭失败且不泄漏输入', () => {
    const h = harness();
    h.setSnapshot({ ...snapshot(), apiKey: 'sk-secret-value' });
    expect(h.service.preview('document-a')).toEqual({ ok: false, errorCode: 'unavailable' });
    expect(JSON.stringify(h.service.preview('document-old'))).not.toContain('document-old');
  });

  it('拒绝错hash、错sequence、未知字段和过期候选且零写入', async () => {
    const h = harness();
    const result = h.service.preview('document-a');
    if (!result.ok) throw new Error('fixture');
    expect(
      await h.service.export('document-a', {
        sequence: result.preview.sequence,
        digest: 'b'.repeat(64),
      }),
    ).toEqual({ ok: false, errorCode: 'stale' });
    expect(
      await h.service.export('document-a', {
        sequence: result.preview.sequence + 1,
        digest: result.preview.digest,
      }),
    ).toEqual({ ok: false, errorCode: 'stale' });
    expect(
      await h.service.export('document-a', {
        sequence: result.preview.sequence,
        digest: result.preview.digest,
        path: 'x',
      }),
    ).toEqual({ ok: false, errorCode: 'invalid-payload' });
    h.setNow(result.preview.expiresAt + 1);
    h.setMonotonicNow(111);
    expect(
      await h.service.export('document-a', {
        sequence: result.preview.sequence,
        digest: result.preview.digest,
      }),
    ).toEqual({ ok: false, errorCode: 'expired' });
    expect(h.writes).toHaveLength(0);
  });

  it('墙上时间回拨不能延长单调时钟候选期限', async () => {
    const h = harness();
    const result = h.service.preview('document-a');
    if (!result.ok) throw new Error('fixture');
    h.setNow(1);
    h.setMonotonicNow(110);
    await expect(
      h.service.export('document-a', {
        sequence: result.preview.sequence,
        digest: result.preview.digest,
      }),
    ).resolves.toEqual({ ok: false, errorCode: 'expired' });
    expect(result.preview.expiresAt).toBe(1_100);
    expect(h.writes).toHaveLength(0);
  });

  it('对话框等待期间逐步复验真实owner；导航失效后等待完成但零写入', async () => {
    let resolveDialog!: (value: string | null) => void;
    const dialog = new Promise<string | null>((resolve) => {
      resolveDialog = resolve;
    });
    let current = true;
    const write = vi.fn(async () => undefined);
    const service = new DiagnosticService({
      snapshot: { snapshot },
      save: { showSaveDialog: () => dialog, write },
      isOwnerCurrent: () => current,
    });
    const preview = service.preview('document-a');
    if (!preview.ok) throw new Error('fixture');
    const exporting = service.export('document-a', {
      sequence: preview.preview.sequence,
      digest: preview.preview.digest,
    });
    current = false;
    resolveDialog('selected.json');
    await expect(exporting).resolves.toEqual({ ok: false, errorCode: 'stale' });
    expect(write).not.toHaveBeenCalled();
  });

  it('全局只允许单在途；invalidateAndDrain等待已开始写入的真实结果', async () => {
    let resolveWrite!: () => void;
    const writeDone = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const service = new DiagnosticService({
      snapshot: { snapshot },
      save: { showSaveDialog: async () => 'selected.json', write: () => writeDone },
      isOwnerCurrent: () => true,
    });
    const preview = service.preview('document-a');
    if (!preview.ok) throw new Error('fixture');
    const payload = { sequence: preview.preview.sequence, digest: preview.preview.digest };
    const exporting = service.export('document-a', payload);
    await Promise.resolve();
    expect(await service.export('document-a', payload)).toEqual({ ok: false, errorCode: 'busy' });
    expect(service.preview('document-a')).toEqual({ ok: false, errorCode: 'busy' });
    let drained = false;
    const drain = service.invalidateAndDrain('document-a').then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    resolveWrite();
    await expect(exporting).resolves.toMatchObject({ ok: true });
    await drain;
    expect(drained).toBe(true);
  });

  it('在调用同步重入的dialog端口前先持有单在途锁', async () => {
    let previewDuringDialog: ReturnType<DiagnosticService['preview']> | null = null;
    let exportDuringDialog: Promise<unknown> | null = null;
    const service = new DiagnosticService({
      snapshot: { snapshot },
      save: {
        showSaveDialog: () => {
          previewDuringDialog = service.preview('document-a');
          exportDuringDialog = service.export('document-a', payload);
          return Promise.resolve(null);
        },
        write: vi.fn(),
      },
      isOwnerCurrent: () => true,
    });
    const preview = service.preview('document-a');
    if (!preview.ok) throw new Error('fixture');
    const payload = { sequence: preview.preview.sequence, digest: preview.preview.digest };
    await expect(service.export('document-a', payload)).resolves.toEqual({
      ok: false,
      errorCode: 'cancelled',
    });
    expect(previewDuringDialog).toEqual({ ok: false, errorCode: 'busy' });
    await expect(exportDuringDialog).resolves.toEqual({ ok: false, errorCode: 'busy' });
  });

  it('用户取消与端口失败使用固定错误且不写入', async () => {
    const base = { snapshot: { snapshot }, isOwnerCurrent: () => true };
    const cancel = new DiagnosticService({
      ...base,
      save: { showSaveDialog: async () => null, write: vi.fn() },
    });
    const p1 = cancel.preview('a');
    if (!p1.ok) throw new Error('fixture');
    await expect(
      cancel.export('a', { sequence: p1.preview.sequence, digest: p1.preview.digest }),
    ).resolves.toEqual({ ok: false, errorCode: 'cancelled' });
    const fail = new DiagnosticService({
      ...base,
      save: {
        showSaveDialog: async () => 'x.json',
        write: async () => {
          throw new Error('C:/secret/key');
        },
      },
    });
    const p2 = fail.preview('a');
    if (!p2.ok) throw new Error('fixture');
    const output = await fail.export('a', {
      sequence: p2.preview.sequence,
      digest: p2.preview.digest,
    });
    expect(output).toEqual({ ok: false, errorCode: 'write-failed' });
    expect(JSON.stringify(output)).not.toContain('secret');
  });
});
