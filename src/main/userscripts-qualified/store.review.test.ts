import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QualifiedScriptId } from '../../shared/types/qualified-userscripts';
import type { CatalogEntry } from './catalog';
import { QualifiedScriptStore } from './store';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));

const directories: string[] = [];
const source = '// independent reviewer fixture\n';
const entry = (id: QualifiedScriptId): CatalogEntry => ({
  id,
  name: id,
  version: '1',
  runAt: 'document-start',
  includes: [],
  matches: ['https://www.baidu.com/*'],
  excludes: [],
  assets: [
    {
      key: 'source',
      kind: 'source',
      url: `https://fixture.invalid/${id}.js`,
      bytes: Buffer.byteLength(source),
      sha256: createHash('sha256').update(source).digest('hex').toUpperCase(),
    },
  ],
});
const catalog = { 'ac-baidu': entry('ac-baidu'), 'github-zh': entry('github-zh') };

function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'aibrowse-qualified-review-'));
  directories.push(directory);
  const options = { directory, testCatalog: catalog, fetchText: async () => source };
  return { directory, options, store: new QualifiedScriptStore(options) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('资格脚本独立持久化反例', () => {
  it.each(['enable', 'install'] as const)(
    '安装包被外部删除后%s不得报告启用成功',
    async (operation) => {
      const { directory, options, store } = setup();
      expect(await store.install('ac-baidu', () => true)).toEqual({ ok: true });
      expect(store.setEnabled('ac-baidu', false)).toEqual({ ok: true });
      fs.unlinkSync(join(directory, 'bundles', 'ac-baidu.json'));
      const result =
        operation === 'enable'
          ? store.setEnabled('ac-baidu', true)
          : await store.install('ac-baidu', () => true);
      expect(result.ok).toBe(false);
      expect(store.list()[0]?.enabled).toBe(false);
      expect(new QualifiedScriptStore(options).list()[0]?.enabled).toBe(false);
    },
  );

  it('状态文件原子替换失败不修改当前或重启值', async () => {
    const { options, store } = setup();
    await store.install('ac-baidu', () => true);
    expect(store.setValue('ac-baidu', 'key', 'before')).toEqual({ ok: true });
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('controlled write failure'), { code: 'EACCES' });
    });
    expect(store.setValue('ac-baidu', 'key', 'after').ok).toBe(false);
    expect(store.getValues('ac-baidu')).toEqual({ key: 'before' });
    rename.mockRestore();
    expect(new QualifiedScriptStore(options).getValues('ac-baidu')).toEqual({ key: 'before' });
  });

  it('数组元素访问器不得运行或保存', async () => {
    const { store } = setup();
    await store.install('ac-baidu', () => true);
    const getter = vi.fn(() => 'not-plain-json');
    const candidate: unknown[] = [];
    Object.defineProperty(candidate, '0', { enumerable: true, get: getter });
    expect(store.setValue('ac-baidu', 'array', candidate).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(store.getValues('ac-baidu')).toEqual({});
  });
});
