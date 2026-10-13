import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IdmNativeDownloadService,
  encodeIdmHandoff,
  normalizeIdmMetadata,
  verifyIdmHelper,
} from './idm-native-service';

const identity = {
  helperPath: 'D:\\app\\idm-handoff.exe',
  expectedSha256: '0'.repeat(64),
  expectedBytes: 1,
};
const metadata = {
  url: 'https://example.com/final.zip',
  referer: 'https://example.com/',
  cookie: 'session=secret',
  filename: '资料.zip',
  userAgent: 'Test Browser',
};
class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
}
afterEach(() => vi.useRealTimers());

describe('IDM 原生固定协议', () => {
  it('只接受闭合元数据，严格拒绝URL与头注入及任意保存路径', () => {
    expect(normalizeIdmMetadata(metadata)).toEqual(metadata);
    for (const bad of [
      { ...metadata, cookie: 'a=1\r\nX:a' },
      { ...metadata, referer: 'https://u:p@example.com/' },
      { ...metadata, filename: '../secret.zip' },
      { ...metadata, filename: 'C:\\secret.zip' },
      { ...metadata, filename: 'CON.txt' },
      { ...metadata, userAgent: 'a\u0000b' },
      { ...metadata, cookie: 'a'.repeat(16385) },
      { ...metadata, url: 'file:///tmp/a' },
      { ...metadata, flags: 1 },
    ])
      expect(normalizeIdmMetadata(bad)).toBeNull();
  });
  it('固定五字段采用UTF8长度帧且秘密只在stdin字节中', () => {
    const data = encodeIdmHandoff(metadata);
    expect(data.subarray(0, 4).toString()).toBe('IDM1');
    let offset = 4;
    const fields = [];
    while (offset < data.length) {
      const length = data.readUInt32LE(offset);
      offset += 4;
      fields.push(data.subarray(offset, offset + length).toString('utf8'));
      offset += length;
    }
    expect(fields).toEqual([
      metadata.url,
      metadata.referer,
      metadata.cookie,
      metadata.filename,
      metadata.userAgent,
    ]);
  });
  it('元数据不进入argv，COM成功回执前不报告成功', async () => {
    const child = new FakeChild();
    const launch = vi.fn<
      (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess
    >(() => child as unknown as ChildProcess);
    const service = new IdmNativeDownloadService(identity, {
      verifyHelper: async () => true,
      isExecutableFile: async () => true,
      spawnHelper: launch,
    });
    const result = service.send(metadata);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(launch.mock.calls[0]?.[1]).toEqual([]);
    child.stdout.write('OK\n');
    child.emit('close', 0);
    expect(await result).toEqual({ ok: true });
    service.dispose();
  });
  it('异步探测后租约撤销不启动任何helper', async () => {
    let current = true;
    const launch = vi.fn();
    const service = new IdmNativeDownloadService(identity, {
      verifyHelper: async () => true,
      isExecutableFile: async () => {
        current = false;
        return true;
      },
      spawnHelper: launch,
    });
    expect((await service.send(metadata, () => current)).ok).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
  it('超时只终止自己创建的helper，拒绝并发与迟到输出', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const service = new IdmNativeDownloadService(identity, {
      verifyHelper: async () => true,
      isExecutableFile: async () => true,
      spawnHelper: () => child as unknown as ChildProcess,
      timeoutMs: 25,
    });
    const pending = service.send(metadata);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(await service.send(metadata)).toMatchObject({ ok: false, code: 'busy' });
    await vi.advanceTimersByTimeAsync(26);
    expect(await pending).toMatchObject({ ok: false, code: 'failed' });
    expect(child.kill).toHaveBeenCalledOnce();
    child.stdout.write('OK\n');
    child.emit('close', 0);
    service.dispose();
  });
  it('固定helper需同时满足大小、SHA256和普通文件身份', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'idm-integrity-'));
    try {
      const file = join(dir, 'test.exe');
      const bytes = Buffer.from('fixed helper fixture');
      await writeFile(file, bytes);
      const good = {
        helperPath: file,
        expectedSha256: createHash('sha256').update(bytes).digest('hex'),
        expectedBytes: bytes.length,
      };
      expect(await verifyIdmHelper(good)).toBe(true);
      expect(await verifyIdmHelper({ ...good, expectedSha256: '0'.repeat(64) })).toBe(false);
      expect(await verifyIdmHelper({ ...good, expectedBytes: bytes.length + 1 })).toBe(false);
      expect(await verifyIdmHelper({ ...good, helperPath: dir })).toBe(false);
      expect(await verifyIdmHelper({ ...good, expectedBytes: 512 * 1024 + 1 })).toBe(false);
      await writeFile(file, Buffer.alloc(bytes.length));
      expect(await verifyIdmHelper(good)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('helper身份失败不会spawn，服务关闭会撤销自己正在等待的helper', async () => {
    const launch = vi.fn();
    const rejected = new IdmNativeDownloadService(identity, {
      isExecutableFile: async () => true,
      verifyHelper: async () => false,
      spawnHelper: launch,
    });
    expect(await rejected.send(metadata)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(launch).not.toHaveBeenCalled();
    const child = new FakeChild();
    const active = new IdmNativeDownloadService(identity, {
      isExecutableFile: async () => true,
      verifyHelper: async () => true,
      spawnHelper: () => child as unknown as ChildProcess,
    });
    const pending = active.send(metadata);
    await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
    active.dispose();
    expect(await pending).toMatchObject({ ok: false, code: 'closed' });
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it.each(['OK\nsecret', 'OK\r\n', '', 'x'.repeat(20)])(
    '固定成功消息以外均拒绝 %j',
    async (output) => {
      const child = new FakeChild();
      const service = new IdmNativeDownloadService(identity, {
        isExecutableFile: async () => true,
        verifyHelper: async () => true,
        spawnHelper: () => child as unknown as ChildProcess,
      });
      const pending = service.send(metadata);
      await vi.waitFor(() => expect(child.stdin.writableEnded).toBe(true));
      child.stdout.write(output);
      child.emit('close', 0);
      expect(await pending).toMatchObject({ ok: false });
      service.dispose();
    },
  );
});
