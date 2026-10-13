import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QualifiedScriptId, ScriptValue } from '../../shared/types/qualified-userscripts';
import type { CatalogAsset, CatalogEntry } from './catalog';
import { QualifiedScriptStore } from './store';

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(join(tmpdir(), 'aibrowse-qualified-scripts-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function asset(key: string, kind: CatalogAsset['kind'], url: string, text: string): CatalogAsset {
  const bytes = Buffer.from(text, 'utf8');
  return {
    key,
    kind,
    url,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase(),
  };
}

const fixtureTexts = new Map([
  ['https://fixtures.test/ac.user.js', '// ac source\n'],
  ['https://fixtures.test/ac-require.js', 'globalThis.acRequired = true;\n'],
  ['https://fixtures.test/ac-style.css', 'body { color: red; }\n'],
  ['https://fixtures.test/github.user.js', '// github source\n'],
  ['https://fixtures.test/github-dictionary.js', 'globalThis.dictionary = {};\n'],
]);

const testCatalog: Readonly<Record<QualifiedScriptId, CatalogEntry>> = {
  'ac-baidu': {
    id: 'ac-baidu',
    name: 'AC 测试脚本',
    version: '1',
    runAt: 'document-start',
    matches: [],
    includes: ['https://example.test/*'],
    excludes: [],
    assets: [
      asset('source', 'source', 'https://fixtures.test/ac.user.js', '// ac source\n'),
      asset(
        'require-0',
        'require',
        'https://fixtures.test/ac-require.js',
        'globalThis.acRequired = true;\n',
      ),
      asset('style', 'resource', 'https://fixtures.test/ac-style.css', 'body { color: red; }\n'),
    ],
  },
  'github-zh': {
    id: 'github-zh',
    name: 'GitHub 测试脚本',
    version: '1',
    runAt: 'document-end',
    matches: ['https://github.com/*'],
    includes: [],
    excludes: [],
    assets: [
      asset('source', 'source', 'https://fixtures.test/github.user.js', '// github source\n'),
      asset(
        'require-0',
        'require',
        'https://fixtures.test/github-dictionary.js',
        'globalThis.dictionary = {};\n',
      ),
    ],
  },
};

function fixtureFetch() {
  return vi.fn(async (url: string, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error('aborted');
    const text = fixtureTexts.get(url);
    if (text === undefined) throw new Error(`unexpected URL: ${url}`);
    return text;
  });
}

function createStore(directory = temporaryDirectory(), fetchText = fixtureFetch()) {
  return {
    directory,
    fetchText,
    store: new QualifiedScriptStore({ directory, fetchText, testCatalog }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('资格脚本安装与持久化', () => {
  it('缺少状态和安装包是正常未安装状态', () => {
    const { store } = createStore();

    expect(store.list()).toEqual([
      {
        id: 'ac-baidu',
        name: 'AC 测试脚本',
        version: '1',
        installed: false,
        enabled: false,
        issue: null,
      },
      {
        id: 'github-zh',
        name: 'GitHub 测试脚本',
        version: '1',
        installed: false,
        enabled: false,
        issue: null,
      },
    ]);
    expect(store.getEnabled()).toEqual([]);
  });

  it('全部固定资产验证完成后才原子安装并可重启读取', async () => {
    const { directory, fetchText, store } = createStore();
    const result = await store.install('ac-baidu', () => true);

    expect(result).toEqual({ ok: true });
    expect(fetchText.mock.calls.map(([url]) => url)).toEqual([
      'https://fixtures.test/ac.user.js',
      'https://fixtures.test/ac-require.js',
      'https://fixtures.test/ac-style.css',
    ]);
    expect(store.list()[0]).toMatchObject({ installed: true, enabled: true, issue: null });
    expect(store.getEnabled()).toEqual([
      {
        entry: testCatalog['ac-baidu'],
        source: '// ac source\n',
        requires: ['globalThis.acRequired = true;\n'],
        resources: { style: 'body { color: red; }\n' },
        values: {},
      },
    ]);
    expect(
      fs
        .readdirSync(directory, { recursive: true })
        .filter((path) => String(path).endsWith('.tmp')),
    ).toEqual([]);

    const restarted = new QualifiedScriptStore({
      directory,
      fetchText: fixtureFetch(),
      testCatalog,
    });
    expect(restarted.list()[0]).toMatchObject({ installed: true, enabled: true, issue: null });
    expect(restarted.getEnabled()[0]?.source).toBe('// ac source\n');
  });

  it('哈希不一致时不产生已安装状态或bundle', async () => {
    const directory = temporaryDirectory();
    const fetchText = fixtureFetch();
    fetchText.mockImplementation(async (url: string) =>
      url.endsWith('ac-require.js') ? 'tampered' : (fixtureTexts.get(url) ?? ''),
    );
    const store = new QualifiedScriptStore({ directory, fetchText, testCatalog });

    const result = await store.install('ac-baidu', () => true);

    expect(result.ok).toBe(false);
    expect(store.list()[0]).toMatchObject({ installed: false, enabled: false, issue: null });
    expect(fs.existsSync(join(directory, 'bundles', 'ac-baidu.json'))).toBe(false);
    expect(fs.existsSync(join(directory, 'state.json'))).toBe(false);
  });

  it('离线固定资产安装不访问网络并可重启读取', async () => {
    const { directory, fetchText, store } = createStore();
    const providedTexts = new Map([
      ['source', '// ac source\n'],
      ['require-0', 'globalThis.acRequired = true;\n'],
      ['style', 'body { color: red; }\n'],
    ]);

    await expect(store.install('ac-baidu', () => true, providedTexts)).resolves.toEqual({
      ok: true,
    });
    expect(fetchText).not.toHaveBeenCalled();
    expect(store.getEnabled()[0]).toMatchObject({
      source: '// ac source\n',
      requires: ['globalThis.acRequired = true;\n'],
      resources: { style: 'body { color: red; }\n' },
    });
    const restarted = new QualifiedScriptStore({ directory, fetchText, testCatalog });
    expect(restarted.list()[0]).toMatchObject({ installed: true, enabled: true, issue: null });
  });

  it.each([
    [
      '缺少资产',
      new Map([
        ['source', '// ac source\n'],
        ['require-0', 'globalThis.acRequired = true;\n'],
      ]),
    ],
    [
      '额外资产',
      new Map([
        ['source', '// ac source\n'],
        ['require-0', 'globalThis.acRequired = true;\n'],
        ['style', 'body { color: red; }\n'],
        ['extra', 'unexpected'],
      ]),
    ],
    [
      '摘要不符',
      new Map([
        ['source', '// tampered\n'],
        ['require-0', 'globalThis.acRequired = true;\n'],
        ['style', 'body { color: red; }\n'],
      ]),
    ],
  ])('离线安装拒绝%s且不回退网络', async (_label, providedTexts) => {
    const { directory, fetchText, store } = createStore();

    expect((await store.install('ac-baidu', () => true, providedTexts)).ok).toBe(false);
    expect(fetchText).not.toHaveBeenCalled();
    expect(store.list()[0]).toMatchObject({ installed: false, enabled: false, issue: null });
    expect(fs.existsSync(join(directory, 'bundles', 'ac-baidu.json'))).toBe(false);
    expect(fs.existsSync(join(directory, 'state.json'))).toBe(false);
  });

  it('已有完整安装也必须先验证传入的离线资产', async () => {
    const { fetchText, store } = createStore();
    await store.install('ac-baidu', () => true);
    fetchText.mockClear();
    const tampered = new Map([
      ['source', '// tampered\n'],
      ['require-0', 'globalThis.acRequired = true;\n'],
      ['style', 'body { color: red; }\n'],
    ]);

    expect((await store.install('ac-baidu', () => true, tampered)).ok).toBe(false);
    expect(fetchText).not.toHaveBeenCalled();
    expect(store.list()[0]).toMatchObject({ installed: true, enabled: true, issue: null });
  });

  it('并发安装返回忙，下载期间不提前报告已安装', async () => {
    const first = deferred<string>();
    const fetchText = fixtureFetch();
    fetchText.mockImplementationOnce(() => first.promise);
    const { store } = createStore(temporaryDirectory(), fetchText);

    const installing = store.install('ac-baidu', () => true);
    expect(store.list()[0]).toMatchObject({ installed: false, enabled: false });
    await expect(store.install('ac-baidu', () => true)).resolves.toEqual({
      ok: false,
      message: '该脚本正在安装，请稍后重试。',
    });

    first.resolve('// ac source\n');
    await expect(installing).resolves.toEqual({ ok: true });
  });

  it('禁用请求会取消忽略AbortSignal的迟到安装', async () => {
    const first = deferred<string>();
    const fetchText = fixtureFetch();
    fetchText.mockImplementationOnce(() => first.promise);
    const { directory, store } = createStore(temporaryDirectory(), fetchText);
    const installing = store.install('ac-baidu', () => true);

    expect(store.setEnabled('ac-baidu', false)).toEqual({
      ok: false,
      message: '脚本尚未安装。',
    });
    first.resolve('// ac source\n');

    await expect(installing).resolves.toEqual({ ok: true, cancelled: true });
    expect(store.list()[0]).toMatchObject({ installed: false, enabled: false });
    expect(fs.existsSync(join(directory, 'bundles', 'ac-baidu.json'))).toBe(false);
  });

  it('删除与安装竞态以删除胜出，迟到下载不能重建脚本', async () => {
    const first = deferred<string>();
    const fetchText = fixtureFetch();
    fetchText.mockImplementationOnce(() => first.promise);
    const { directory, store } = createStore(temporaryDirectory(), fetchText);
    const installing = store.install('ac-baidu', () => true);

    expect(store.remove('ac-baidu')).toEqual({ ok: true });
    first.resolve('// ac source\n');

    await expect(installing).resolves.toEqual({ ok: true, cancelled: true });
    expect(store.list()[0]).toMatchObject({ installed: false, enabled: false, issue: null });
    expect(fs.existsSync(join(directory, 'bundles', 'ac-baidu.json'))).toBe(false);
  });

  it('完整的禁用安装包再次安装时只重新启用而不联网', async () => {
    const { store, fetchText } = createStore();
    await store.install('ac-baidu', () => true);
    expect(store.setEnabled('ac-baidu', false)).toEqual({ ok: true });
    fetchText.mockClear();

    await expect(store.install('ac-baidu', () => true)).resolves.toEqual({ ok: true });

    expect(fetchText).not.toHaveBeenCalled();
    expect(store.list()[0]).toMatchObject({ installed: true, enabled: true });
  });

  it('内存中的完整安装包被外部删除后先失效，下一次显式安装才重新下载', async () => {
    const { directory, store, fetchText } = createStore();
    await store.install('ac-baidu', () => true);
    expect(store.setEnabled('ac-baidu', false)).toEqual({ ok: true });
    fs.unlinkSync(join(directory, 'bundles', 'ac-baidu.json'));
    fetchText.mockClear();

    expect((await store.install('ac-baidu', () => true)).ok).toBe(false);
    expect(fetchText).not.toHaveBeenCalled();
    expect(store.list()[0]).toMatchObject({ installed: false, enabled: false });

    await expect(store.install('ac-baidu', () => true)).resolves.toEqual({ ok: true });
    expect(fetchText).toHaveBeenCalledTimes(3);
    expect(store.list()[0]).toMatchObject({ installed: true, enabled: true, issue: null });
  });

  it('外部改写为语义有效的bundle也按完整身份失效并持久停用', async () => {
    const { directory, store, fetchText } = createStore();
    await store.install('ac-baidu', () => true);
    const bundlePath = join(directory, 'bundles', 'ac-baidu.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
    const externallyModified = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
    fs.writeFileSync(bundlePath, externallyModified);
    fetchText.mockClear();

    expect(store.setEnabled('ac-baidu', true).ok).toBe(false);
    expect(fetchText).not.toHaveBeenCalled();
    expect(fs.readFileSync(bundlePath)).toEqual(externallyModified);
    expect(store.list()[0]).toMatchObject({ installed: false, enabled: false });
    expect(store.list()[0]?.issue).toContain('原文件已保留');

    const restarted = new QualifiedScriptStore({ directory, fetchText, testCatalog });
    expect(restarted.list()[0]).toMatchObject({ installed: false, enabled: false });
    expect(restarted.list()[0]?.issue).toContain('事务未完成');
    expect(restarted.setEnabled('ac-baidu', true).ok).toBe(false);

    await expect(store.install('ac-baidu', () => true)).resolves.toEqual({ ok: true });
    const backups = fs
      .readdirSync(join(directory, 'bundles'))
      .filter((name) => name.startsWith('ac-baidu.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(join(directory, 'bundles', backups[0]!))).toEqual(externallyModified);
  });

  it('正常删除同时移除bundle、状态和值', async () => {
    const { directory, store } = createStore();
    await store.install('ac-baidu', () => true);
    expect(store.setValue('ac-baidu', 'key', 'value')).toEqual({ ok: true });

    expect(store.remove('ac-baidu')).toEqual({ ok: true });

    expect(store.list()[0]).toMatchObject({ installed: false, enabled: false, issue: null });
    expect(store.getValues('ac-baidu')).toEqual({});
    expect(fs.existsSync(join(directory, 'bundles', 'ac-baidu.json'))).toBe(false);
    const restarted = new QualifiedScriptStore({
      directory,
      fetchText: fixtureFetch(),
      testCatalog,
    });
    expect(restarted.list()[0]).toMatchObject({ installed: false, enabled: false, issue: null });
  });

  it('损坏bundle保留原件并禁用，显式重装时备份后恢复', async () => {
    const { directory, store } = createStore();
    await store.install('ac-baidu', () => true);
    const bundlePath = join(directory, 'bundles', 'ac-baidu.json');
    fs.appendFileSync(bundlePath, 'broken');
    const broken = fs.readFileSync(bundlePath);

    const restarted = new QualifiedScriptStore({
      directory,
      fetchText: fixtureFetch(),
      testCatalog,
    });
    expect(restarted.list()[0]).toMatchObject({ installed: false, enabled: false });
    expect(restarted.list()[0]?.issue).toContain('原文件已保留');
    expect(fs.readFileSync(bundlePath)).toEqual(broken);

    await expect(restarted.install('ac-baidu', () => true)).resolves.toEqual({ ok: true });
    const backups = fs
      .readdirSync(join(directory, 'bundles'))
      .filter((name) => name.startsWith('ac-baidu.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(join(directory, 'bundles', backups[0]!))).toEqual(broken);
    expect(restarted.list()[0]).toMatchObject({ installed: true, enabled: true, issue: null });
  });

  it('损坏状态保留原件并拒绝覆盖', async () => {
    const { directory, store } = createStore();
    await store.install('ac-baidu', () => true);
    const statePath = join(directory, 'state.json');
    fs.writeFileSync(statePath, 'broken-state');
    const broken = fs.readFileSync(statePath);

    const restarted = new QualifiedScriptStore({
      directory,
      fetchText: fixtureFetch(),
      testCatalog,
    });
    expect(restarted.list().every((status) => !status.enabled && status.issue !== null)).toBe(true);
    expect(restarted.setEnabled('ac-baidu', true).ok).toBe(false);
    expect(fs.readFileSync(statePath)).toEqual(broken);
  });

  it('删除失败前先持久停用，迟到状态不会重新启用', async () => {
    const { directory, store } = createStore();
    await store.install('ac-baidu', () => true);
    const bundlePath = join(directory, 'bundles', 'ac-baidu.json');
    fs.rmSync(bundlePath);
    fs.mkdirSync(bundlePath);

    const result = store.remove('ac-baidu');

    expect(result.ok).toBe(false);
    const restarted = new QualifiedScriptStore({
      directory,
      fetchText: fixtureFetch(),
      testCatalog,
    });
    expect(restarted.list()[0]).toMatchObject({ enabled: false });
  });

  it('GM值成功持久化且输入输出均不共享可变引用', async () => {
    const { directory, store } = createStore();
    await store.install('ac-baidu', () => true);
    const value: ScriptValue = { nested: ['original'] };

    expect(store.setValue('ac-baidu', 'settings', value)).toEqual({ ok: true });
    (value as { nested: string[] }).nested[0] = 'changed-input';
    const first = store.getValues('ac-baidu');
    expect(first).toEqual({ settings: { nested: ['original'] } });
    (first.settings as { nested: string[] }).nested[0] = 'changed-output';
    expect(store.getValues('ac-baidu')).toEqual({ settings: { nested: ['original'] } });

    const restarted = new QualifiedScriptStore({
      directory,
      fetchText: fixtureFetch(),
      testCatalog,
    });
    expect(restarted.getValues('ac-baidu')).toEqual({ settings: { nested: ['original'] } });
  });

  it.each([
    ['非有限数值', Number.NaN],
    ['undefined', undefined],
    ['超长字符串', 'x'.repeat(64 * 1024 + 1)],
    ['原型对象', Object.assign(Object.create({ inherited: true }), { own: true })],
    ['污染键', JSON.parse('{"__proto__":true}')],
  ])('拒绝%s且不修改原值', async (_label, candidate) => {
    const { store } = createStore();
    await store.install('ac-baidu', () => true);
    expect(store.setValue('ac-baidu', 'safe', 'before')).toEqual({ ok: true });

    expect(store.setValue('ac-baidu', 'safe', candidate as ScriptValue).ok).toBe(false);
    expect(store.getValues('ac-baidu')).toEqual({ safe: 'before' });
  });

  it('拒绝访问器、循环、深度、节点和总JSON预算反例', async () => {
    const { store } = createStore();
    await store.install('ac-baidu', () => true);
    const accessor = {};
    Object.defineProperty(accessor, 'secret', { enumerable: true, get: () => 'x' });
    const cycle: unknown[] = [];
    cycle.push(cycle);
    let deep: ScriptValue = 'leaf';
    for (let index = 0; index < 13; index += 1) deep = [deep];
    const nodes = Array.from({ length: 10_001 }, () => null);

    for (const candidate of [accessor, cycle, deep, nodes]) {
      expect(store.setValue('ac-baidu', 'rejected', candidate as ScriptValue).ok).toBe(false);
    }
    expect(store.setValue('ac-baidu', 'a', 'x'.repeat(64 * 1024))).toEqual({ ok: true });
    expect(store.setValue('ac-baidu', 'b', 'x'.repeat(64 * 1024))).toEqual({ ok: true });
    expect(store.setValue('ac-baidu', 'c', 'x'.repeat(64 * 1024))).toEqual({ ok: true });
    expect(store.setValue('ac-baidu', 'd', 'x'.repeat(64 * 1024)).ok).toBe(false);
    expect(store.getValues('ac-baidu')).not.toHaveProperty('d');
  });

  it('数组只接受闭合的普通数据索引且不会执行访问器', async () => {
    const { store } = createStore();
    await store.install('ac-baidu', () => true);
    const getter = vi.fn(() => 'secret');
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, '0', { enumerable: true, get: getter });
    const sparse = new Array<unknown>(1);
    const extra: unknown[] = ['value'];
    Object.defineProperty(extra, 'extra', { value: true, enumerable: true });
    const symbol = Symbol('extra');
    const symbolProperty: unknown[] = ['value'];
    Object.defineProperty(symbolProperty, symbol, { value: true, enumerable: true });
    const hidden: unknown[] = ['value'];
    Object.defineProperty(hidden, '0', {
      value: 'value',
      enumerable: false,
      configurable: true,
      writable: true,
    });

    for (const candidate of [accessor, sparse, extra, symbolProperty, hidden]) {
      expect(store.setValue('ac-baidu', 'array', candidate).ok).toBe(false);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(store.getValues('ac-baidu')).toEqual({});
    expect(store.setValue('ac-baidu', 'array', ['safe', { nested: true }])).toEqual({ ok: true });
    expect(store.getValues('ac-baidu')).toEqual({ array: ['safe', { nested: true }] });
  });

  it('状态文件竞态导致写失败时不持久化新值', async () => {
    const { directory, store } = createStore();
    await store.install('ac-baidu', () => true);
    expect(store.setValue('ac-baidu', 'key', 'before')).toEqual({ ok: true });
    const statePath = join(directory, 'state.json');
    const before = fs.readFileSync(statePath);
    fs.appendFileSync(statePath, ' ');

    expect(store.setValue('ac-baidu', 'key', 'after').ok).toBe(false);
    expect(fs.readFileSync(statePath)).toEqual(Buffer.concat([before, Buffer.from(' ')]));

    fs.writeFileSync(statePath, before);
    const restarted = new QualifiedScriptStore({
      directory,
      fetchText: fixtureFetch(),
      testCatalog,
    });
    expect(restarted.getValues('ac-baidu')).toEqual({ key: 'before' });
  });

  it('dispose中止安装，忽略迟到下载结果且不写文件', async () => {
    const first = deferred<string>();
    const fetchText = fixtureFetch();
    fetchText.mockImplementationOnce(() => first.promise);
    const { directory, store } = createStore(temporaryDirectory(), fetchText);
    const installing = store.install('ac-baidu', () => true);

    store.dispose();
    first.resolve('// ac source\n');

    await expect(installing).resolves.toEqual({ ok: true, cancelled: true });
    expect(fs.existsSync(join(directory, 'bundles', 'ac-baidu.json'))).toBe(false);
    expect(fs.existsSync(join(directory, 'state.json'))).toBe(false);
  });
});
