import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdtempSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readBoundedFile } from './bounded-file';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    fstatSync: vi.fn(actual.fstatSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});

const dirs: string[] = [];
function file(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'aibrowse-bounded-'));
  dirs.push(dir);
  const path = join(dir, 'data.json');
  writeFileSync(path, content);
  return path;
}
afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('文件有界读取', () => {
  it('恰好上限可读，超限在读正文前拒绝并关闭句柄', () => {
    expect(readBoundedFile(file('1234'), 4)).toBe('1234');
    vi.clearAllMocks();
    expect(() => readBoundedFile(file('12345'), 4)).toThrow();
    expect(readSync).not.toHaveBeenCalled();
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it('fstat后文件增长时拒绝，分配与读取不随增长扩大', () => {
    const path = file('1234');
    vi.mocked(fstatSync).mockImplementationOnce(() => {
      const before = statSync(path);
      appendFileSync(path, 'x'.repeat(1024 * 1024));
      return before;
    });
    expect(() => readBoundedFile(path, 16)).toThrow();
    expect(readSync).toHaveBeenCalledOnce();
    expect(vi.mocked(readSync).mock.calls[0]?.[1].byteLength).toBe(5);
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it('读取失败也关闭句柄', () => {
    const path = file('data');
    vi.mocked(readSync).mockImplementationOnce(() => {
      throw new Error('受控读取失败');
    });
    expect(() => readBoundedFile(path, 16)).toThrow();
    expect(closeSync).toHaveBeenCalledOnce();
  });
});
