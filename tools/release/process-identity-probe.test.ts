import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { beforeEach, expect, it, vi } from 'vitest';
import { probeControlledProcessIdentity } from './process-identity-probe';

const mock = vi.hoisted(() => ({ spawn: vi.fn(), read: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mock.spawn }));
vi.mock('node:fs', () => ({ readFileSync: mock.read }));

function child() {
  return Object.assign(new EventEmitter(), { stderr: new PassThrough() });
}
beforeEach(() => vi.clearAllMocks());

it('失败探针等待实际流关闭后保留有界stderr，不只丢弃非零码', async () => {
  const process = child();
  mock.spawn.mockReturnValue(process);
  let settled = false;
  const result = probeControlledProcessIdentity('fixed-journal', 123, 'ProductOriginal').catch(
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  process.emit('exit', 1);
  await Promise.resolve();
  expect(settled).toBe(false);
  process.stderr.write('固定身份探针错误：Win32Exception 5');
  process.emit('close', 1);
  expect(await result).toMatchObject({
    diagnostic: {
      label: 'ProductOriginal',
      pid: 123,
      exitCode: 1,
      stderr: '固定身份探针错误：Win32Exception 5',
      truncated: false,
    },
  });
  expect(mock.read).not.toHaveBeenCalled();
});

it('stderr洪泛只保留8192字节且不把失败报告当身份', async () => {
  const process = child();
  mock.spawn.mockReturnValue(process);
  const result = probeControlledProcessIdentity('fixed-journal', 123, 'ProductOriginal').catch(
    (error: unknown) => error,
  );
  process.stderr.write(Buffer.alloc(9000, 120));
  process.emit('close', 1);
  process.emit('exit', 1);
  expect(await result).toMatchObject({
    diagnostic: { stderr: 'x'.repeat(8192), truncated: true, capturedBytes: 8192 },
  });
  expect(mock.read).not.toHaveBeenCalled();
});

it('正常退出仍须通过原有身份报告校验', async () => {
  const process = child();
  mock.spawn.mockReturnValue(process);
  mock.read.mockReturnValue(
    JSON.stringify({
      version: 1,
      label: 'ProductOriginal',
      pid: 123,
      processCreatedFileTime: '100',
      imagePath: 'D:\\fixed\\AIbrowse.exe',
      packageStatus: 15700,
      packageFullName: '',
      probeRootFileId128: 'a'.repeat(32),
      probeRootVolumeSerial64: 'b'.repeat(16),
    }),
  );
  const result = probeControlledProcessIdentity('fixed-journal', 123, 'ProductOriginal');
  process.stderr.write('合成非错误提示');
  process.emit('close', 0);
  await expect(result).resolves.toMatchObject({ pid: 123, processCreatedFileTime: '100' });
  expect(mock.read).toHaveBeenCalledOnce();
});
