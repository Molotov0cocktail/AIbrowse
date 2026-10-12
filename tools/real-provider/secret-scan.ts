// Only the newly created synthetic campaign root may be supplied by the launcher.
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export function scanSecretFootprint(
  root: string,
  secret: Uint8Array,
  maxFiles = 512,
  maxBytes = 64 * 1024 * 1024,
) {
  const result = { passed: false, files: 0, bytes: 0, matches: 0, failure: null as string | null };
  try {
    if (secret.length === 0 || realpathSync(root) !== resolve(root))
      throw new Error('scan-root-or-secret');
    let entries = 0;
    const started = performance.now();
    const walk = (directory: string, depth: number): void => {
      if (depth > 16 || lstatSync(directory).isSymbolicLink())
        throw new Error('scan-path-boundary');
      const handle = opendirSync(directory);
      try {
        for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
          if (++entries > 1024 || performance.now() - started > 5000)
            throw new Error('scan-budget');
          const path = join(directory, entry.name);
          const stat = lstatSync(path);
          if (stat.isSymbolicLink()) throw new Error('scan-path-boundary');
          if (stat.isDirectory()) {
            walk(path, depth + 1);
            continue;
          }
          if (!stat.isFile()) throw new Error('scan-file-kind');
          result.files++;
          result.bytes += stat.size;
          if (result.files > maxFiles || result.bytes > maxBytes) throw new Error('scan-budget');
          const descriptor = openSync(path, 'r');
          try {
            if (fstatSync(descriptor).size !== stat.size) throw new Error('scan-file-changed');
            const bytes = Buffer.alloc(stat.size);
            let offset = 0;
            while (offset < bytes.length) {
              const length = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
              if (length === 0) throw new Error('scan-file-changed');
              offset += length;
            }
            if (fstatSync(descriptor).size !== stat.size) throw new Error('scan-file-changed');
            if (bytes.includes(Buffer.from(secret.buffer, secret.byteOffset, secret.byteLength)))
              result.matches++;
          } finally {
            closeSync(descriptor);
          }
        }
      } finally {
        handle.closeSync();
      }
    };
    walk(root, 0);
    result.passed = result.matches === 0;
    if (!result.passed) result.failure = 'plaintext-match';
  } catch (error) {
    result.failure =
      error instanceof Error &&
      [
        'scan-root-or-secret',
        'scan-path-boundary',
        'scan-file-kind',
        'scan-budget',
        'scan-file-changed',
      ].includes(error.message)
        ? error.message
        : 'scan-unavailable';
  }
  return result;
}
