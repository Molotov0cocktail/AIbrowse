import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  linkSync,
  rmSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { copyBound, fileFact, readSmall, writeReceipt } from './io';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'full-transfer-'));
  roots.push(root);
  mkdirSync(join(root, 'target'));
  const source = join(root, 'source'),
    target = join(root, 'target/copy');
  const bytes = Buffer.alloc(131077, 'a');
  writeFileSync(source, bytes);
  return { root, source, target, bytes, sha: createHash('sha256').update(bytes).digest('hex') };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe('一次流式导入的原件与输出所有权', () => {
  it('非整块尾部及EOF完整读回，独立文件闭合', () => {
    const f = fixture(),
      copied = copyBound(f.source, f.target, f.bytes.length, f.sha, () => {});
    expect(readFileSync(f.target)).toEqual(f.bytes);
    expect(copied.fact.ino).not.toBe(fileFact(f.source).ino);
    copied.verify();
  });
  it('错误hash拒绝并保留部分结果，不能覆写后重试', () => {
    const f = fixture();
    expect(() => copyBound(f.source, f.target, f.bytes.length, '0'.repeat(64), () => {})).toThrow();
    expect(() => copyBound(f.source, f.target, f.bytes.length, f.sha, () => {})).toThrow();
    expect(readFileSync(f.source)).toEqual(f.bytes);
  });
  it('硬链接原件及输出替换均拒绝', () => {
    const f = fixture(),
      copied = copyBound(f.source, f.target, f.bytes.length, f.sha, () => {});
    renameSync(f.target, f.target + '.old');
    writeFileSync(f.target, f.bytes);
    expect(copied.verify).toThrow();
    linkSync(f.source, f.source + '.link');
    expect(() => fileFact(f.source)).toThrow();
  });
  it('最后关闭后的deadline不可恢复，原件不改写', () => {
    const f = fixture();
    let calls = 0;
    expect(() =>
      copyBound(f.source, f.target, f.bytes.length, f.sha, () => {
        if (++calls >= 5) throw new Error('期限');
      }),
    ).toThrow();
    expect(readFileSync(f.source)).toEqual(f.bytes);
    expect(readdirSync(join(f.root, 'target'))).toEqual(['copy']);
  });
  it('小回执闭合UTF8且wx原件不能替换', () => {
    const f = fixture(),
      path = join(f.root, 'receipt');
    const verify = writeReceipt(path, { ok: true }, () => {});
    verify();
    expect(readSmall(path, () => {}).value).toEqual({ ok: true });
    expect(() => writeReceipt(path, {}, () => {})).toThrow();
    writeFileSync(path, Buffer.from([0xff]));
    expect(() => readSmall(path, () => {})).toThrow();
    expect(verify).toThrow();
  });
  it('两个各800秒完成的操作在最后只按outer复核已关闭回执', () => {
    const f = fixture();
    let now = 800;
    const first = writeReceipt(join(f.root, 'first'), { done: true }, () => {
      if (now >= 1500) throw new Error('第一操作期限');
    });
    now = 1600;
    const second = writeReceipt(join(f.root, 'second'), { done: true }, () => {
      if (now >= 2300) throw new Error('第二操作期限');
    });
    const outer = () => {
      if (now >= 3060) throw new Error('整体期限');
    };
    expect(() => {
      first(outer);
      second(outer);
    }).not.toThrow();
  });
});
