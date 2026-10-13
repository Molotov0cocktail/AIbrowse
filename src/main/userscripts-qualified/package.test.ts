import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CatalogEntry } from './catalog';
import { decodeQualifiedPackage } from './package';

const text = '固定脚本原字节';
const entry: CatalogEntry = {
  id: 'ac-baidu',
  name: '夹具',
  version: '1',
  runAt: 'document-start',
  matches: [],
  includes: [],
  excludes: [],
  assets: [
    {
      key: 'source',
      kind: 'source',
      url: 'https://example.invalid/source',
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex').toUpperCase(),
    },
  ],
};
const pack = () => ({ format: 1, id: 'ac-baidu', version: '1', assets: { source: text } });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
describe('固定资产离线安装包', () => {
  it('仅返回匹配目录的原字节，不携带状态或路径', () => {
    expect([...decodeQualifiedPackage(bytes(pack()), entry)]).toEqual([['source', text]]);
  });
  it.each([
    { ...pack(), id: 'github-zh' },
    { ...pack(), version: '2' },
    { ...pack(), format: 2 },
    { ...pack(), values: { enabled: true } },
    { ...pack(), path: 'C:/private' },
    { ...pack(), assets: { source: text + '!' } },
    { ...pack(), assets: {} },
    { ...pack(), assets: { source: text, extra: 'code' } },
    { ...pack(), assets: { source: { text } } },
    null,
    [],
  ])('拒绝版本、字段或资产身份不一致的包 %#', (value) => {
    expect(() => decodeQualifiedPackage(bytes(value), entry)).toThrow('本地脚本包');
  });
  it('拒绝非法UTF8、畸形JSON与超量正文', () => {
    for (const value of [Buffer.from([0xff]), Buffer.from('{'), Buffer.alloc(16 * 1024 * 1024 + 1)])
      expect(() => decodeQualifiedPackage(value, entry)).toThrow('本地脚本包');
  });
});
