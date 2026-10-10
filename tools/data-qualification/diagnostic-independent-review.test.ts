import { afterEach, expect, it, vi } from 'vitest';
import { DiagnosticService } from '../../src/main/diagnostics/diagnostic-service';
import { createDiagnosticCandidate } from '../../src/main/diagnostics/diagnostic-projection';
import { RuntimeShutdown } from '../../src/main/storage/runtime-shutdown';
import { MaintenanceAdmission } from '../../src/main/storage/maintenance-admission';
import { runWithMaintenanceAdmission } from '../../src/main/storage/runtime-maintenance';

function snapshot() {
  return {
    application: { version: '0.1.0', buildId: 'a'.repeat(40) },
    runtime: { electron: '43.7.7', node: '24.18.0', chromium: '150.0.7339.249' },
    features: {
      browser: 'available',
      ai: 'available',
      sources: 'available',
      research: 'available',
      watch: 'available',
      storage: 'available',
    },
    errors: {
      startup: 0,
      storage: 0,
      browser: 0,
      provider: 0,
      research: 0,
      watch: 0,
      renderer: 0,
      other: 0,
    },
    counts: {
      tabs: 2,
      sessions: null,
      sources: null,
      researchTasks: null,
      watchRules: null,
      pendingOperations: null,
    },
    durationsMs: {
      startup: null,
      pageSnapshot: null,
      sourceSearch: null,
      researchRun: null,
      watchCycle: null,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function preview(service: DiagnosticService, owner = 'document') {
  const result = service.preview(owner);
  if (!result.ok) throw new Error('invalid synthetic preview');
  return result.preview;
}
afterEach(() => vi.restoreAllMocks());

it('真实经过五分钟即失效，系统时间回拨不能延长默认候选TTL', async () => {
  const wall = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const elapsed = vi.spyOn(performance, 'now').mockReturnValue(100);
  const showSaveDialog = vi.fn(async () => 'selected.json');
  const write = vi.fn(async () => undefined);
  const service = new DiagnosticService({
    snapshot: { snapshot },
    save: { showSaveDialog, write },
    isOwnerCurrent: () => true,
  });
  const p = preview(service);
  wall.mockReturnValue(900_000);
  elapsed.mockReturnValue(300_100);
  expect(await service.export('document', { sequence: p.sequence, digest: p.digest })).toEqual({
    ok: false,
    errorCode: 'expired',
  });
  expect(showSaveDialog).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
});

it('敏感嵌套getter、隐藏键与撤销Proxy不能执行或泄漏到投影', () => {
  const getter = vi.fn(() => 'private-canary');
  const input = snapshot();
  Object.defineProperty(input.runtime, 'node', { get: getter, enumerable: true });
  expect(() => createDiagnosticCandidate(input)).toThrow('诊断数据格式无效');
  expect(getter).not.toHaveBeenCalled();
  const hidden = snapshot();
  Object.defineProperty(hidden.counts, 'private', { value: 'private-canary', enumerable: false });
  expect(() => createDiagnosticCandidate(hidden)).toThrow('诊断数据格式无效');
  const revoked = Proxy.revocable(snapshot(), {});
  revoked.revoke();
  expect(() => createDiagnosticCandidate(revoked.proxy)).toThrow('诊断数据格式无效');
});

it('旧文档对话框占用期间新文档不可覆盖候选，退休排水直到回执且零写入', async () => {
  const dialog = deferred<string | null>();
  const dialogStarted = deferred<void>();
  let owner = 'old';
  const write = vi.fn(async () => undefined);
  const service = new DiagnosticService({
    snapshot: { snapshot },
    save: {
      showSaveDialog: () => {
        dialogStarted.resolve();
        return dialog.promise;
      },
      write,
    },
    isOwnerCurrent: (value) => value === owner,
  });
  const p = preview(service, owner);
  const operation = service.export(owner, { sequence: p.sequence, digest: p.digest });
  await dialogStarted.promise;
  owner = 'new';
  let drained = false;
  const drain = service.invalidateAndDrain('old').then(() => {
    drained = true;
  });
  expect(service.preview(owner)).toEqual({ ok: false, errorCode: 'busy' });
  await Promise.resolve();
  expect(drained).toBe(false);
  dialog.resolve('selected.json');
  expect(await operation).toEqual({ ok: false, errorCode: 'stale' });
  await drain;
  expect(write).not.toHaveBeenCalled();
  const fresh = preview(service, owner);
  expect(fresh.sequence).toBeGreaterThan(p.sequence);
  expect(await service.export('old', { sequence: fresh.sequence, digest: fresh.digest })).toEqual({
    ok: false,
    errorCode: 'stale',
  });
});

it('主root准入与退出排水等待实际写入，旧owner退休不伪造已开始写入的取消', async () => {
  const admission = new MaintenanceAdmission();
  const writeStarted = deferred<void>();
  const writeDone = deferred<void>();
  let bytes: Uint8Array | null = null;
  const service = new DiagnosticService({
    snapshot: { snapshot },
    save: {
      showSaveDialog: async () => 'selected.json',
      write: (_path, value) => {
        bytes = value;
        writeStarted.resolve();
        return writeDone.promise;
      },
    },
    isOwnerCurrent: () => admission.isOpen(),
  });
  const p = preview(service);
  const operation = runWithMaintenanceAdmission(admission, () =>
    service.export('document', { sequence: p.sequence, digest: p.digest }),
  );
  await writeStarted.promise;
  const close = vi.fn();
  const shutdown = new RuntimeShutdown({
    roots: [
      {
        beginShutdown: () => {
          admission.beginShutdown();
          void service.invalidateAndDrain();
        },
        drain: () => admission.drain(),
      },
    ],
    producers: [
      {
        beginShutdown: () => {
          void service.invalidateAndDrain();
        },
        drainBeforeClose: () => service.invalidateAndDrain(),
      },
    ],
    waitForUsage: async () => undefined,
    cleanupWorkspace: async () => ({ ok: true, retainedCount: 0 }),
    closeResources: close,
  });
  const stopping = shutdown.shutdown();
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
  await expect(runWithMaintenanceAdmission(admission, () => undefined)).rejects.toThrow();
  writeDone.resolve();
  expect(await operation).toEqual({ ok: true, digest: p.digest, byteLength: p.byteLength });
  await stopping;
  expect(close).toHaveBeenCalledOnce();
  expect(new TextDecoder().decode(bytes!)).toBe(p.json);
});
