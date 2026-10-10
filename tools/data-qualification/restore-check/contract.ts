import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

export const PHASES = [
  'boot',
  'backup',
  'restore',
  'partial',
  'gate',
  'successor',
  'cold',
] as const;
export type Phase = (typeof PHASES)[number];
export type Scene = 'R' | 'P';
export interface Control {
  version: 1;
  scene: Scene;
  phase: Phase;
  deadline: number;
  previousPid: number | null;
  previousSession: string | null;
}
export function need(value: unknown, message = '恢复检查条件不成立'): asserts value {
  if (!value) throw new Error(message);
}
export function scopeAt(path: string): string {
  const scope = resolve(path);
  need(/^restore-check-[a-f0-9]{32}$/u.test(basename(scope)));
  for (let current = scope; ; current = dirname(current)) {
    const s = lstatSync(current);
    need(s.isDirectory() && !s.isSymbolicLink());
    if (dirname(current) === current) return scope;
  }
}
export function readControl(path: string): Control {
  const s = lstatSync(path);
  need(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 4096);
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  need(value !== null && typeof value === 'object' && !Array.isArray(value));
  const v = value as Record<string, unknown>;
  need(
    Object.keys(v).sort().join('|') === 'deadline|phase|previousPid|previousSession|scene|version',
  );
  need(v.version === 1 && (v.scene === 'R' || v.scene === 'P'));
  need(PHASES.some((phase) => phase === v.phase));
  need(typeof v.deadline === 'number' && Number.isSafeInteger(v.deadline));
  need(
    v.previousPid === null || (Number.isSafeInteger(v.previousPid) && Number(v.previousPid) > 0),
  );
  need(
    v.previousSession === null ||
      (typeof v.previousSession === 'string' && /^[a-f0-9]{32}$/u.test(v.previousSession)),
  );
  return v as unknown as Control;
}
export function writeNew(path: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2);
  need(Buffer.byteLength(text) <= 2 * 1024 * 1024, '工具回执超出预算');
  writeFileSync(path, text, { flag: 'wx' });
}
