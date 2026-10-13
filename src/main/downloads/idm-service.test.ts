import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdmDownloadService, normalizeIdmUrl } from './idm-service';

const IDM_X86 = 'C:\\Program Files (x86)\\Internet Download Manager\\IDMan.exe';

class FakeChild extends EventEmitter {
  readonly unref = vi.fn();
}

function childProcess(child = new FakeChild()): ChildProcess {
  return child as unknown as ChildProcess;
}

function availableService(
  options: {
    child?: FakeChild;
    spawn?: (
      file: string,
      args: readonly string[],
      options: Readonly<SpawnOptions>,
    ) => ChildProcess;
    fileCheck?: (candidate: string) => Promise<boolean>;
    timeout?: number;
  } = {},
): { service: IdmDownloadService; child: FakeChild; spawn: ReturnType<typeof vi.fn> } {
  const child = options.child ?? new FakeChild();
  const spawn = vi.fn(options.spawn ?? (() => childProcess(child)));
  const service = new IdmDownloadService({
    isExecutableFile: options.fileCheck ?? (async (candidate) => candidate === IDM_X86),
    spawnIdm: spawn,
    handoffTimeoutMs: options.timeout ?? 50,
  });
  return { service, child, spawn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeIdmUrl', () => {
  it.each([
    'https://example.com/file.zip',
    'http://localhost:8080/a?token=one%20two#part',
    'HTTPS://例子.测试/%E6%96%87%E4%BB%B6.zip',
  ])('accepts and canonicalizes an explicit web URL: %s', (url) => {
    expect(normalizeIdmUrl(url)).toBe(new URL(url).toString());
  });

  it.each([
    '',
    ' https://example.com/a',
    'https://example.com/a ',
    'https://example.com/a b',
    'https://example.com/a\tb',
    'https://example.com/a\nb',
    'https://example.com/a\u0000b',
    'https://example.com/a\u202eb',
    'https:\\example.com\\file.zip',
    'ftp://example.com/file.zip',
    'file:///C:/secret.txt',
    'javascript:alert(1)',
    'https://user@example.com/file.zip',
    'https://user:pass@example.com/file.zip',
    'example.com/file.zip',
  ])('rejects an unsafe or implicit value: %s', (url) => {
    expect(normalizeIdmUrl(url)).toBeNull();
  });

  it('rejects oversized values and never coerces hostile objects', () => {
    expect(normalizeIdmUrl(`https://example.com/${'a'.repeat(4096)}`)).toBeNull();
    const toString = vi.fn(() => 'https://example.com/file.zip');
    expect(normalizeIdmUrl({ toString })).toBeNull();
    expect(toString).not.toHaveBeenCalled();
  });
});

describe('IdmDownloadService', () => {
  it('reports availability without exposing the executable path', async () => {
    const fileCheck = vi.fn(async (candidate: string) => candidate === IDM_X86);
    const { service } = availableService({ fileCheck });
    await expect(service.getStatus()).resolves.toEqual({ available: true });
    expect(fileCheck.mock.calls).toEqual([
      ['C:\\Program Files\\Internet Download Manager\\IDMan.exe'],
      [IDM_X86],
    ]);
    const absent = new IdmDownloadService({ isExecutableFile: async () => false });
    await expect(absent.getStatus()).resolves.toEqual({ available: false });
  });

  it('uses one fixed executable and only the documented /d argument', async () => {
    const { service, child, spawn } = availableService();
    const result = service.send('https://example.com/file.zip?token=sensitive');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(spawn).toHaveBeenCalledWith(
      IDM_X86,
      ['/d', 'https://example.com/file.zip?token=sensitive'],
      { shell: false, stdio: 'ignore', windowsHide: false },
    );
    child.emit('spawn');
    await expect(result).resolves.toEqual({ ok: true });
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('keeps encoded flag-like and shell text inside the URL argument', async () => {
    const { service, child, spawn } = availableService();
    const result = service.send('https://example.com/%2Fn%20%26%20calc.exe');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const call = spawn.mock.calls[0]!;
    expect(call[1]).toEqual(['/d', 'https://example.com/%2Fn%20%26%20calc.exe']);
    expect(call[2]).toHaveProperty('shell', false);
    child.emit('spawn');
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('does not launch invalid input or an unavailable installation', async () => {
    const invalid = availableService();
    await expect(invalid.service.send({ url: 'https://example.com' })).resolves.toMatchObject({
      ok: false,
      code: 'invalid-url',
    });
    expect(invalid.spawn).not.toHaveBeenCalled();

    const unavailable = availableService({ fileCheck: async () => false });
    await expect(unavailable.service.send('https://example.com/a')).resolves.toMatchObject({
      ok: false,
      code: 'unavailable',
    });
    expect(unavailable.spawn).not.toHaveBeenCalled();
  });

  it('fails closed on synchronous spawn, error, early exit and timeout', async () => {
    const synchronous = availableService({
      spawn: () => {
        throw new Error('C:\\secret\\IDMan.exe token=sensitive');
      },
    });
    await expect(synchronous.service.send('https://example.com/a')).resolves.toMatchObject({
      ok: false,
      code: 'failed',
    });

    for (const event of ['error', 'exit'] as const) {
      const attempt = availableService();
      const result = attempt.service.send('https://example.com/a');
      await vi.waitFor(() => expect(attempt.spawn).toHaveBeenCalledOnce());
      attempt.child.emit(event, event === 'error' ? new Error('private') : 0);
      await expect(result).resolves.toMatchObject({ ok: false, code: 'failed' });
    }

    vi.useFakeTimers();
    const timeout = availableService({ timeout: 25 });
    const result = timeout.service.send('https://example.com/a');
    await vi.advanceTimersByTimeAsync(25);
    await expect(result).resolves.toMatchObject({ ok: false, code: 'failed' });
  });

  it('rejects concurrent requests while the first handoff is pending', async () => {
    const { service, child, spawn } = availableService();
    const first = service.send('https://example.com/first');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    await expect(service.send('https://example.com/second')).resolves.toMatchObject({
      ok: false,
      code: 'busy',
    });
    expect(spawn).toHaveBeenCalledOnce();
    child.emit('spawn');
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('rechecks the trusted UI lease after path probing and before spawn', async () => {
    let resolveCheck!: (value: boolean) => void;
    const checked = new Promise<boolean>((resolve) => {
      resolveCheck = resolve;
    });
    let current = true;
    const attempt = availableService({ fileCheck: () => checked });
    const result = attempt.service.send('https://example.com/a', () => current);
    current = false;
    resolveCheck(true);
    await expect(result).resolves.toMatchObject({ ok: false, code: 'closed' });
    expect(attempt.spawn).not.toHaveBeenCalled();
  });

  it('rechecks the trusted UI lease after native handoff acknowledgement', async () => {
    let current = true;
    const attempt = availableService();
    const result = attempt.service.send('https://example.com/a', () => current);
    await vi.waitFor(() => expect(attempt.spawn).toHaveBeenCalledOnce());
    current = false;
    attempt.child.emit('spawn');
    await expect(result).resolves.toMatchObject({ ok: false, code: 'closed' });
  });

  it('treats a throwing UI lease as closed without launching', async () => {
    const attempt = availableService();
    await expect(
      attempt.service.send('https://example.com/a', () => {
        throw new Error('stale document');
      }),
    ).resolves.toMatchObject({ ok: false, code: 'closed' });
    expect(attempt.spawn).not.toHaveBeenCalled();
  });

  it('disposes idempotently, cleans pending listeners and blocks future launches', async () => {
    const { service, child, spawn } = availableService();
    const pending = service.send('https://example.com/a');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(child.listenerCount('spawn')).toBe(1);
    service.dispose();
    service.dispose();
    await expect(pending).resolves.toMatchObject({ ok: false, code: 'closed' });
    expect(child.listenerCount('spawn')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.unref).toHaveBeenCalledOnce();
    await expect(service.send('https://example.com/b')).resolves.toMatchObject({
      ok: false,
      code: 'closed',
    });
    await expect(service.getStatus()).resolves.toEqual({ available: false });
    expect(spawn).toHaveBeenCalledOnce();
  });
});
