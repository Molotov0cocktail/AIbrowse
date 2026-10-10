import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readControl, scopeAt, writeNew } from './contract';

const parent = mkdtempSync(join(tmpdir(), 'aibrowse-restore-check-tests-'));
const base = {
  version: 1,
  scene: 'R',
  phase: 'restore',
  deadline: Date.now() + 600_000,
  previousPid: null,
  previousSession: null,
};
function candidate(value: unknown): string {
  const path = join(parent, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
  return path;
}
describe('隔离恢复工具固定控制输入', () => {
  it('接受既定场景与空前代的初始阶段', () => {
    expect(readControl(candidate(base))).toEqual(base);
  });
  it.each([
    { ...base, scene: 'X' },
    { ...base, phase: 'run-script' },
    { ...base, destination: 'C:/Users/other' },
    { ...base, previousPid: 0 },
    { ...base, previousSession: '../other' },
    { ...base, deadline: 1.5 },
    [],
    null,
  ])('拒绝非固定字段、动作、身份和期限：%j', (value) => {
    expect(() => readControl(candidate(value))).toThrow();
  });
  it('拒绝超预算输入且原件保持', () => {
    const path = candidate({ ...base, extra: 'x'.repeat(4096) });
    const before = readFileSync(path);
    expect(() => readControl(path)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });
  it('成功回执不能覆盖之前的失败原件', () => {
    const path = candidate({ failure: true });
    expect(() => writeNew(path, { completed: true })).toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ failure: true });
  });
  it('运行根必须是工具专属随机目录', () => {
    const path = join(parent, `restore-check-${randomUUID().replaceAll('-', '')}`);
    mkdirSync(path);
    expect(scopeAt(path)).toBe(path);
    expect(() => scopeAt(parent)).toThrow();
  });
});
