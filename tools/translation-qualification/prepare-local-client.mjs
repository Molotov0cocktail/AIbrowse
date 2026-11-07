import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function assertPlainAncestors(input) {
  let current = path.resolve(input);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error('资产根路径祖先不能含链接');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

// Copy packaged program assets only, never browser profile storage or credentials.
export function prepareLocalClient(source, destination, inventory) {
  source = path.resolve(source);
  destination = path.resolve(destination);
  assertPlainAncestors(source);
  assertPlainAncestors(destination);
  if (fs.existsSync(destination)) throw new Error('程序副本目录必须全新');
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error('安装目录不能是链接');
  if (inventory.packageVersion !== '1.34.4' || !Array.isArray(inventory.entries))
    throw new Error('固定清单无效');
  const files = inventory.entries.filter((entry) => entry.kind !== 'directory');
  if (files.length < 1 || files.length > 200) throw new Error('资产数量越界');
  const planned = [];
  const seen = new Set();
  let total = 0;
  for (const entry of files) {
    if (
      typeof entry.path !== 'string' ||
      entry.path.includes('\\') ||
      entry.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..' || part.includes(':'))
    )
      throw new Error('资产相对路径无效');
    const key = entry.path.toLowerCase();
    if (seen.has(key)) throw new Error('资产路径重复');
    seen.add(key);
    let current = source;
    for (const part of entry.path.split('/')) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('资产路径不能含链接');
    }
    const stat = fs.statSync(current);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024) throw new Error('资产类型或大小越界');
    total += stat.size;
    if (total > 80 * 1024 * 1024) throw new Error('资产总量越界');
    const bytes = fs.readFileSync(current);
    const sha256 = digest(bytes);
    if (sha256 !== entry.sha256 || bytes.length !== entry.bytes)
      throw new Error(`程序资产与固定包不一致：${entry.path}`);
    if (entry.path === 'manifest.json') {
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (
        manifest.version !== '1.34.4' ||
        manifest.manifest_version !== 3 ||
        manifest.options_page !== 'options.html' ||
        manifest.action?.default_popup !== 'popup.html'
      )
        throw new Error('安装manifest与目标客户端不符');
    }
    planned.push({ path: entry.path, bytes, sha256, matchesReference: sha256 === entry.sha256 });
  }
  if (!seen.has('manifest.json')) throw new Error('缺少manifest');
  fs.mkdirSync(destination);
  for (const file of planned) {
    const target = path.join(destination, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.bytes, { flag: 'wx' });
  }
  return {
    version: '1.34.4',
    totalBytes: total,
    fileCount: planned.length,
    files: planned.map(({ path: relative, bytes, sha256, matchesReference }) => ({
      path: relative,
      bytes: bytes.length,
      sha256,
      matchesReference,
    })),
  };
}
