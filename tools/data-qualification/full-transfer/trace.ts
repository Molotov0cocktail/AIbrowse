import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync } from 'node:fs';
import { need } from './contract';
import { writeAll } from './io';

/** Bounded durable checkpoints survive a native fail-stop that cannot run JS catch. */
export function createTrace(path: string, check: () => void) {
  check();
  const fd = openSync(path, 'wx');
  const hash = createHash('sha256');
  let bytes = 0,
    closed = false;
  return {
    append(value: unknown): void {
      check();
      need(!closed);
      const data = Buffer.from(JSON.stringify(value) + '\n');
      need(bytes + data.length <= 65536);
      writeAll(fd, data, bytes, check);
      bytes += data.length;
      hash.update(data);
      fsyncSync(fd);
      check();
    },
    close(): { bytes: number; sha256: string } {
      if (!closed) {
        closed = true;
        try {
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      check();
      return { bytes, sha256: hash.copy().digest('hex') };
    },
  };
}
