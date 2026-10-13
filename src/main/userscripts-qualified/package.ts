import { createHash } from 'node:crypto';
import { decodeUserScript, readBoundedRegularFile } from '../userscripts/store';
import type { CatalogEntry } from './catalog';

const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const fail = (): never => {
  throw new Error('本地脚本包与指定版本不符，请选择完整且未经修改的脚本包。');
};
function record(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}

export function decodeQualifiedPackage(
  bytes: Buffer,
  entry: CatalogEntry,
): ReadonlyMap<string, string> {
  if (bytes.length > MAX_PACKAGE_BYTES) return fail();
  let input: unknown;
  try {
    input = JSON.parse(decodeUserScript(bytes));
  } catch {
    return fail();
  }
  if (
    !record(input) ||
    Object.keys(input).sort().join(',') !== 'assets,format,id,version' ||
    input.format !== 1 ||
    input.id !== entry.id ||
    input.version !== entry.version ||
    !record(input.assets)
  )
    return fail();
  if (
    Object.keys(input.assets).sort().join(',') !==
    entry.assets
      .map((asset) => asset.key)
      .sort()
      .join(',')
  )
    return fail();
  const texts = new Map<string, string>();
  for (const asset of entry.assets) {
    const text = input.assets[asset.key];
    if (
      typeof text !== 'string' ||
      Buffer.byteLength(text) !== asset.bytes ||
      createHash('sha256').update(text).digest('hex').toUpperCase() !== asset.sha256
    )
      return fail();
    texts.set(asset.key, text);
  }
  return texts;
}

export function readQualifiedPackage(
  path: string,
  entry: CatalogEntry,
): ReadonlyMap<string, string> {
  try {
    return decodeQualifiedPackage(readBoundedRegularFile(path, MAX_PACKAGE_BYTES), entry);
  } catch {
    return fail();
  }
}
