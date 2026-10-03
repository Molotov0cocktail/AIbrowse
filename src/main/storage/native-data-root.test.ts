import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  opendirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import type { BigIntStats, PathLike } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveNativeDataRoot } from './native-data-root';

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    lstatSync: vi.fn(fs.lstatSync),
    mkdirSync: vi.fn(fs.mkdirSync),
    opendirSync: vi.fn(fs.opendirSync),
    readFileSync: vi.fn(fs.readFileSync),
    writeFileSync: vi.fn(fs.writeFileSync),
    realpathSync: Object.assign(vi.fn(fs.realpathSync), {
      native: vi.fn(fs.realpathSync.native),
    }),
  };
});

const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
let fixture: string;
let logical: string;
let native: string;
let virtualized: boolean;
const metadata = new Map<string, BigIntStats | Error>();
const nativePaths = new Map<string, string>();
const aliases = new Map<string, string>();

function mapped(path: PathLike): string {
  const value = String(path);
  const alias = aliases.get(value);
  if (alias !== undefined) return alias;
  if (virtualized && (value === logical || value.startsWith(logical + sep))) {
    return native + value.slice(logical.length);
  }
  return value;
}

function file(name: string): void {
  const path = join(native, name);
  fs.mkdirSync(resolve(path, '..'), { recursive: true });
  fs.writeFileSync(path, '合成内容');
}

function changedStats(path: string, change: Partial<BigIntStats>): BigIntStats {
  return Object.assign(fs.lstatSync(mapped(path), { bigint: true }), change);
}

beforeEach(() => {
  fixture = fs.mkdtempSync(join(tmpdir(), 'aibrowse-native-root-'));
  logical = join(fixture, 'declared');
  native = join(fixture, 'native');
  fs.mkdirSync(logical);
  fs.mkdirSync(native);
  virtualized = true;
  metadata.clear();
  nativePaths.clear();
  aliases.clear();
  vi.clearAllMocks();
  vi.mocked(lstatSync).mockImplementation((path) => {
    const override = metadata.get(String(path));
    if (override instanceof Error) throw override;
    return override ?? fs.lstatSync(mapped(path), { bigint: true });
  });
  vi.mocked(mkdirSync).mockImplementation((path) =>
    fs.mkdirSync(mapped(path), { recursive: true }),
  );
  vi.mocked(opendirSync).mockImplementation((path) => fs.opendirSync(mapped(path)));
  vi.mocked(realpathSync).mockImplementation((path) => fs.realpathSync(String(path)));
  vi.mocked(realpathSync.native).mockImplementation(
    (path) => nativePaths.get(String(path)) ?? fs.realpathSync.native(mapped(path)),
  );
});

afterEach(() => {
  // Only this test's unique synthetic directory is removed.
  expect(relative(tmpdir(), fixture)).toMatch(/^aibrowse-native-root-[^\\/]+$/);
  fs.rmSync(fixture, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('原生Node数据根', () => {
  it('采用native实体路径，普通realpath仍返回声明路径的反例可甄别', () => {
    file('credentials.json.tmp');
    expect(realpathSync(logical)).toBe(logical);
    vi.mocked(realpathSync).mockClear();
    expect(resolveNativeDataRoot(logical)).toBe(native);
    expect(realpathSync).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it('创建尚不存在的固定根，返回真实绝对路径', () => {
    virtualized = false;
    const missing = join(fixture, 'new', 'profile');
    expect(resolveNativeDataRoot(missing)).toBe(fs.realpathSync.native(missing));
    expect(fs.lstatSync(missing).isDirectory()).toBe(true);
    expect(mkdirSync).toHaveBeenCalledOnce();
  });

  it('同根空目录返回原路径，没有已存在的Node目录可枚举', () => {
    virtualized = false;
    expect(resolveNativeDataRoot(native)).toBe(native);
    expect(opendirSync).not.toHaveBeenCalled();
  });

  it('同根普通旧profile完整核验固定树，保留原路径和文件', () => {
    virtualized = false;
    file('credentials.json');
    file('sources/sources.db');
    file('watch/backups/manifest.json');
    file('Chromium/unknown');
    expect(resolveNativeDataRoot(native)).toBe(native);
    expect(opendirSync).toHaveBeenCalledWith(join(native, 'sources'), { bufferSize: 32 });
    expect(opendirSync).toHaveBeenCalledWith(join(native, 'watch', 'backups'), { bufferSize: 32 });
    expect(opendirSync).not.toHaveBeenCalledWith(join(native, 'Chromium'), expect.anything());
    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(fs.readFileSync(join(native, 'credentials.json'), 'utf8')).toBe('合成内容');
  });

  it('同根字符串相等但子成员native映射不同仍拒绝', () => {
    virtualized = false;
    file('sources/sources.db');
    nativePaths.set(join(native, 'sources', 'sources.db'), join(fixture, 'overlay', 'sources.db'));
    expect(realpathSync.native(native)).toBe(native);
    expect(() => resolveNativeDataRoot(native)).toThrow('本地数据目录路径不一致');
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('同根真实硬链接临时文件仍拒绝且保留原件', () => {
    virtualized = false;
    file('credentials.json.tmp');
    const target = join(fixture, 'same-root-hardlink-target');
    fs.linkSync(join(native, 'credentials.json.tmp'), target);
    expect(() => resolveNativeDataRoot(native)).toThrow('本地数据目录成员类型不受支持');
    expect(fs.lstatSync(target, { bigint: true }).nlink).toBe(2n);
    expect(fs.readFileSync(target, 'utf8')).toBe('合成内容');
  });

  it('相同对象旧树包含临时文件、数据库sidecar、备份和日志时仅核对元数据', () => {
    for (const name of [
      'credentials.json',
      'credentials.json.tmp',
      'provider-config.json',
      'provider-config.json.tmp',
      'conversations/session.json.tmp',
      'sources/sources.db',
      'sources/sources.db-wal',
      'research/research.db-shm',
      'watch/backups/manifest.json',
      'log/run.log',
    ])
      file(name);
    expect(resolveNativeDataRoot(logical)).toBe(native);
    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('真实目录junction拒绝且保留目标原件', () => {
    const target = join(fixture, 'junction-target');
    fs.mkdirSync(target);
    fs.writeFileSync(join(target, 'preserved.json'), '合成原件');
    fs.mkdirSync(join(native, 'watch'));
    fs.symlinkSync(target, join(native, 'watch', 'backups'), 'junction');
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录成员类型不受支持');
    expect(fs.readFileSync(join(target, 'preserved.json'), 'utf8')).toBe('合成原件');
  });

  it('真实硬链接临时文件拒绝且两个名字均保留', () => {
    file('credentials.json.tmp');
    const target = join(fixture, 'hardlink-target');
    fs.linkSync(join(native, 'credentials.json.tmp'), target);
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录成员类型不受支持');
    expect(fs.lstatSync(target, { bigint: true }).nlink).toBe(2n);
    expect(fs.readFileSync(target, 'utf8')).toBe('合成内容');
  });

  it('普通文件不能充当数据根或固定目录成员', () => {
    file('sources');
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录成员类型不受支持');
    expect(() => resolveNativeDataRoot(join(native, 'sources'))).toThrow(
      '本地数据目录成员类型不受支持',
    );
  });

  it('根本身为junction时拒绝', () => {
    const linked = join(fixture, 'linked');
    fs.symlinkSync(native, linked, 'junction');
    expect(() => resolveNativeDataRoot(linked)).toThrow('本地数据目录成员类型不受支持');
  });

  it('根身份不同则拒绝，不能退回声明路径', () => {
    metadata.set(logical, changedStats(logical, { ino: 987654321n }));
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录身份不一致');
    expect(opendirSync).not.toHaveBeenCalled();
  });

  it.each(['logical', 'native'])('固定成员只存在于%s视图时拒绝', (view) => {
    file('credentials.json');
    const missing = Object.assign(new Error('敏感路径'), { code: 'ENOENT' });
    metadata.set(join(view === 'logical' ? logical : native, 'credentials.json'), missing);
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录视图不一致');
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it.each(['logical', 'native'])('嵌套集合只在%s视图多一项时拒绝', (view) => {
    file('sources/shared.db');
    const alternate = join(fixture, 'alternate');
    fs.mkdirSync(alternate);
    fs.writeFileSync(join(alternate, 'shared.db'), '合成');
    fs.writeFileSync(join(alternate, 'extra.db'), '合成');
    const original = vi.mocked(opendirSync).getMockImplementation()!;
    vi.mocked(opendirSync).mockImplementation((path, options) => {
      if (String(path) === join(view === 'logical' ? logical : native, 'sources')) {
        return fs.opendirSync(alternate);
      }
      return original(path, options);
    });
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录视图不一致');
  });

  it('嵌套同名不同对象拒绝', () => {
    file('sources/sources.db');
    const path = join(logical, 'sources', 'sources.db');
    metadata.set(path, changedStats(path, { ino: 123456789n }));
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录身份不一致');
  });

  it.each(['credentials.json.tmp', 'provider-config.json.tmp', 'watch/watch.db'])(
    '硬链接文件%s拒绝',
    (name) => {
      file(name);
      const path = join(logical, name);
      metadata.set(path, changedStats(path, { nlink: 2n }));
      expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录成员类型不受支持');
    },
  );

  it('嵌套符号链接或junction拒绝', () => {
    file('watch/backups/manifest.json');
    const path = join(logical, 'watch', 'backups');
    metadata.set(path, changedStats(path, { isSymbolicLink: () => true }));
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录成员类型不受支持');
  });

  it.each(['outside', 'shifted'])('native解析出现%s位置偏移时拒绝', (kind) => {
    file('sources/sources.db');
    nativePaths.set(
      join(logical, 'sources', 'sources.db'),
      kind === 'outside' ? join(fixture, 'outside.db') : join(native, 'shifted.db'),
    );
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录路径不一致');
  });

  it('实体根再次native解析不一致时拒绝', () => {
    nativePaths.set(native, fixture);
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录路径不一致');
  });

  it('枚举后根身份变化拒绝', () => {
    file('log/run.log');
    const original = vi.mocked(opendirSync).getMockImplementation()!;
    vi.mocked(opendirSync).mockImplementation((path, options) => {
      const result = original(path, options);
      metadata.set(logical, changedStats(logical, { ino: 11223344n }));
      return result;
    });
    expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录身份不一致');
  });

  it.each([10_000, 12_000])('每视图%s项仍流式通过且句柄都关闭', (count) => {
    fs.mkdirSync(join(native, 'conversations'));
    const template = join(fixture, 'template');
    fs.writeFileSync(template, '合成');
    const stat = fs.lstatSync(template, { bigint: true });
    const originalMetadata = vi.mocked(lstatSync).getMockImplementation()!;
    vi.mocked(lstatSync).mockImplementation((path, options) => {
      return /[\\/]entry-\d+$/u.test(String(path)) ? stat : originalMetadata(path, options);
    });
    const originalNative = vi.mocked(realpathSync.native).getMockImplementation()!;
    vi.mocked(realpathSync.native).mockImplementation((path, options) => {
      return /[\\/]entry-\d+$/u.test(String(path)) ? mapped(path) : originalNative(path, options);
    });
    let reads = 0;
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    vi.mocked(opendirSync).mockImplementation((path) => {
      const dir = fs.opendirSync(mapped(path));
      let index = 0;
      vi.spyOn(dir, 'readSync').mockImplementation(() => {
        if (index === count) return null;
        reads++;
        return { name: `entry-${++index}` } as ReturnType<typeof dir.readSync>;
      });
      closes.push(vi.spyOn(dir, 'closeSync'));
      return dir;
    });
    expect(resolveNativeDataRoot(logical)).toBe(native);
    expect(reads).toBe(count * 2);
    expect(closes).toHaveLength(2);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  });

  it.each([32, 33])('固定成员树深度%s：边界核验且所有句柄关闭', (depth) => {
    const nested = ['watch', ...Array.from({ length: depth - 1 }, () => 'd')];
    fs.mkdirSync(join(native, ...nested), { recursive: true });
    let active = 0;
    let peak = 0;
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    vi.mocked(opendirSync).mockImplementation((path) => {
      const dir = fs.opendirSync(mapped(path));
      active++;
      peak = Math.max(peak, active);
      const originalClose = dir.closeSync.bind(dir);
      closes.push(
        vi.spyOn(dir, 'closeSync').mockImplementation(() => {
          originalClose();
          active--;
        }),
      );
      return dir;
    });
    if (depth === 32) {
      expect(resolveNativeDataRoot(logical)).toBe(native);
      expect(closes).toHaveLength(64);
    } else {
      expect(() => resolveNativeDataRoot(logical)).toThrow('本地数据目录层级超出核验边界');
      expect(opendirSync).not.toHaveBeenCalledWith(join(logical, ...nested), expect.anything());
      expect(closes).toHaveLength(32);
    }
    expect(active).toBe(0);
    expect(peak).toBeLessThanOrEqual(32);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  });

  it.each(['lstat', 'native'])('递归中%s失败会关闭当前与祖先全部句柄', (failure) => {
    file('watch/backups/manifest.json');
    const path = join(logical, 'watch', 'backups', 'manifest.json');
    if (failure === 'lstat') {
      metadata.set(path, new Error(fixture));
    } else {
      const original = vi.mocked(realpathSync.native).getMockImplementation()!;
      vi.mocked(realpathSync.native).mockImplementation((value, options) => {
        if (String(value) === path) throw new Error(fixture);
        return original(value, options);
      });
    }
    const closes: ReturnType<typeof vi.spyOn>[] = [];
    vi.mocked(opendirSync).mockImplementation((value) => {
      const dir = fs.opendirSync(mapped(value));
      closes.push(vi.spyOn(dir, 'closeSync'));
      return dir;
    });
    expect(() => resolveNativeDataRoot(logical)).toThrow(/^无法核验本地数据目录$/);
    expect(closes.length).toBeGreaterThanOrEqual(2);
    for (const close of closes) expect(close).toHaveBeenCalledOnce();
  });

  it('枚举异常关闭句柄，错误不携带路径或原始原因', () => {
    fs.mkdirSync(join(native, 'log'));
    const dir = fs.opendirSync(join(native, 'log'));
    vi.spyOn(dir, 'readSync').mockImplementation(() => {
      throw new Error(fixture);
    });
    const close = vi.spyOn(dir, 'closeSync');
    vi.mocked(opendirSync).mockReturnValueOnce(dir);
    expect(() => resolveNativeDataRoot(logical)).toThrow(/^无法核验本地数据目录$/);
    expect(close).toHaveBeenCalledOnce();
  });

  it('不扫描Chromium或未知根成员', () => {
    file('Chromium/unknown');
    file('unknown/path');
    expect(resolveNativeDataRoot(logical)).toBe(native);
    expect(opendirSync).not.toHaveBeenCalled();
  });

  it('相对路径输入拒绝且零创建', () => {
    expect(() => resolveNativeDataRoot('profile')).toThrow('本地数据目录路径不一致');
    expect(mkdirSync).not.toHaveBeenCalled();
  });
});
