import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { UserScriptService } from './service';
import {
  decodeUserScript,
  readBoundedRegularFile,
  UserScriptStore,
  type StoredUserScript,
} from './store';
import { parseUserScript } from './metadata';

const roots: string[] = [];
function root(): string {
  const result = fs.mkdtempSync(join(tmpdir(), 'aibrowse-userscripts-'));
  roots.push(result);
  return result;
}
function script(body = 'document.title = "已执行";'): StoredUserScript {
  const source = `// ==UserScript==\n// @name 本地脚本\n// @match https://example.com/*\n// @grant none\n// ==/UserScript==\n${body}`;
  const metadata = parseUserScript(source);
  if (!metadata.ok) throw new Error(metadata.message);
  return {
    source,
    summary: {
      ...metadata.value,
      id: randomUUID(),
      installedAt: new Date().toISOString(),
      sourceBytes: Buffer.byteLength(source),
      enabled: true,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true });
});

describe('用户脚本有界原子存储', () => {
  it('原子保存并从源码重新派生安全摘要，跨实例恢复', () => {
    const directory = join(root(), 'scripts');
    const store = new UserScriptStore(directory);
    const entry = script();
    store.save([entry]);
    expect(new UserScriptStore(directory).list()).toEqual([entry]);
    const persisted = JSON.parse(fs.readFileSync(join(directory, 'scripts.json'), 'utf8')) as {
      scripts: Array<Record<string, unknown>>;
    };
    expect(Object.keys(persisted.scripts[0]).sort()).toEqual([
      'enabled',
      'id',
      'installedAt',
      'sourceBase64',
    ]);
    store.list()[0].summary.enabled = false;
    expect(store.list()[0].summary.enabled).toBe(true);
  });
  it.each([
    '{',
    'null',
    '[]',
    '{"version":2,"scripts":[]}',
    '{"version":1,"scripts":[],"extra":true}',
    '{"version":1,"scripts":[{"id":"../bad"}]}',
  ])('损坏文件保留、不执行、不允许覆盖（%#）', (raw) => {
    const directory = root();
    const path = join(directory, 'scripts.json');
    fs.writeFileSync(path, raw);
    const store = new UserScriptStore(directory);
    expect(store.getError()).not.toBeNull();
    expect(store.list()).toEqual([]);
    expect(() => store.save([script()])).toThrow('无法保存');
    expect(fs.readFileSync(path, 'utf8')).toBe(raw);
  });
  it.each(['writeFileSync', 'fsyncSync', 'renameSync'] as const)(
    '%s失败保持磁盘和内存，不泄露异常路径',
    (operation) => {
      const directory = root();
      const entry = script();
      new UserScriptStore(directory).save([entry]);
      const before = fs.readFileSync(join(directory, 'scripts.json'));
      const store = new UserScriptStore(directory, {
        ...fs,
        [operation]: () => {
          throw new Error('private-secret-path');
        },
      });
      expect(() => store.save([])).toThrow('用户脚本无法保存，原设置保持不变。');
      expect(store.list()).toEqual([entry]);
      expect(fs.readFileSync(join(directory, 'scripts.json'))).toEqual(before);
      expect(fs.readdirSync(directory)).toEqual(['scripts.json']);
    },
  );
  it('外部合法替换也不会被旧内存覆盖，锁定本轮执行', () => {
    const directory = root();
    const first = new UserScriptStore(directory);
    first.save([script()]);
    const external = new UserScriptStore(directory);
    external.save([]);
    const before = fs.readFileSync(join(directory, 'scripts.json'));
    expect(() => first.save([])).toThrow();
    expect(first.list()).toEqual([]);
    expect(first.getError()).not.toBeNull();
    expect(fs.readFileSync(join(directory, 'scripts.json'))).toEqual(before);
  });
  it('限制条目数、总源码量和单源码量', () => {
    const store = new UserScriptStore(root());
    expect(() => store.save(Array.from({ length: 51 }, () => script()))).toThrow();
    const large = `/*${'x'.repeat(250 * 1024)}*/`;
    expect(() => store.save(Array.from({ length: 34 }, () => script(large)))).toThrow();
    expect(store.list()).toEqual([]);
  });
  it('目录代替文件、非法UTF8、读取期间变化均拒绝', () => {
    const directory = root();
    const file = join(directory, 'candidate.user.js');
    fs.mkdirSync(file);
    expect(() => readBoundedRegularFile(file, 1024)).toThrow();
    expect(() => decodeUserScript(Buffer.from([0xff, 0xfe]))).toThrow();
    const other = join(directory, 'changed.user.js');
    fs.writeFileSync(other, 'before');
    const io = {
      ...fs,
      readSync: (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: null,
      ): number => {
        const count = fs.readSync(fd, buffer, offset, length, position);
        fs.writeFileSync(other, 'after-is-longer');
        return count;
      },
    };
    expect(() => readBoundedRegularFile(other, 1024, io)).toThrow();
  });
});

describe('用户脚本服务导入与异步文档所有权', () => {
  it('确认前不保存，摘要无源码/路径，确认后启用、严格修改、跨实例恢复', async () => {
    const directory = root();
    const file = join(directory, 'test.user.js');
    const entry = script();
    fs.writeFileSync(file, entry.source);
    let previews = 0;
    const storeDirectory = join(directory, 'store');
    const service = new UserScriptService({
      storeDirectory,
      dialogs: {
        chooseFile: async () => file,
        confirmImport: async (summary) => {
          previews += 1;
          expect(JSON.stringify(summary)).not.toContain(entry.source);
          expect(JSON.stringify(summary)).not.toContain(file);
          expect(fs.existsSync(storeDirectory)).toBe(false);
          return true;
        },
      },
    });
    const imported = await service.importScript(() => true);
    expect(imported).toMatchObject({ ok: true, value: { enabled: true, name: '本地脚本' } });
    if (!imported.ok || imported.value === null) return;
    expect(previews).toBe(1);
    expect(service.getEnabledScripts()).toHaveLength(1);
    expect(service.setEnabled({ id: imported.value.id, enabled: false, extra: 1 }).ok).toBe(false);
    expect(service.setEnabled({ id: imported.value.id, enabled: false })).toMatchObject({
      ok: true,
      value: { enabled: false },
    });
    expect(service.getEnabledScripts()).toEqual([]);
    expect(service.remove({ id: imported.value.id })).toEqual({ ok: true, value: null });
    expect(service.list()).toEqual({ ok: true, value: [] });
    expect(new UserScriptStore(storeDirectory).list()).toEqual([]);
  });
  it('当前文档在文件选择后失效时，不读文件或展示确认', async () => {
    const selection = deferred<string | null>();
    let current = true;
    let confirmed = false;
    const service = new UserScriptService({
      storeDirectory: root(),
      dialogs: {
        chooseFile: () => selection.promise,
        confirmImport: async () => {
          confirmed = true;
          return true;
        },
      },
    });
    const pending = service.importScript(() => current);
    current = false;
    selection.resolve('never-read.user.js');
    expect(await pending).toMatchObject({ ok: false, code: 'stale' });
    expect(confirmed).toBe(false);
  });
  it('确认挂起期间关闭/并发导入，均不绕过所有权或写盘', async () => {
    const directory = root();
    const file = join(directory, 'test.user.js');
    fs.writeFileSync(file, script().source);
    const confirmation = deferred<boolean>();
    const service = new UserScriptService({
      storeDirectory: join(directory, 'store'),
      dialogs: { chooseFile: async () => file, confirmImport: () => confirmation.promise },
    });
    const pending = service.importScript(() => true);
    await Promise.resolve();
    expect(await service.importScript(() => true)).toMatchObject({
      ok: false,
      code: 'unavailable',
    });
    service.dispose();
    confirmation.resolve(true);
    expect(await pending).toMatchObject({ ok: false, code: 'stale' });
    expect(fs.existsSync(join(directory, 'store'))).toBe(false);
    expect(service.getEnabledScripts()).toEqual([]);
  });
  it('取消和不支持权限不会保存；重复源码不会重复安装', async () => {
    const directory = root();
    const file = join(directory, 'test.user.js');
    fs.writeFileSync(file, script().source);
    let accepted = false;
    const service = new UserScriptService({
      storeDirectory: join(directory, 'store'),
      dialogs: { chooseFile: async () => file, confirmImport: async () => accepted },
    });
    expect(await service.importScript(() => true)).toEqual({ ok: true, value: null });
    expect(service.getEnabledScripts()).toEqual([]);
    accepted = true;
    expect((await service.importScript(() => true)).ok).toBe(true);
    expect(await service.importScript(() => true)).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
  });
});
