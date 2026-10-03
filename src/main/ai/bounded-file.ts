import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

// Bound allocation and reads on the same descriptor, including growth after fstat.
// null represents absence only; callers must preserve unreadable existing files.
export function readBoundedFile(path: string, maxBytes: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('存储文件类型或大小无效');
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size) throw new Error('存储文件在读取期间变化');
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    closeSync(fd);
  }
}
