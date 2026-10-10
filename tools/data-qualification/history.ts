// This tool evaluates only migration modules from the local trusted Git history.
// It is not a database/container importer and must never receive user SQL.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import ts from 'typescript';
import type { DatabaseSync } from 'node:sqlite';

export const MIGRATION_MODULES = {
  sources: { path: 'src/main/sources/db/migrations.ts', symbol: 'MIGRATIONS' },
  research: {
    path: 'src/main/research/db/research-migrations.ts',
    symbol: 'RESEARCH_MIGRATIONS',
  },
  watch: { path: 'src/main/watch/db/watch-migrations.ts', symbol: 'WATCH_MIGRATIONS' },
} as const;
export type Domain = keyof typeof MIGRATION_MODULES;
export interface Step {
  version: number;
  statements: string[];
}
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export function git(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  }).trimEnd();
}
export function readHistoricalSteps(root: string, ref: string, domain: Domain) {
  if (!/^[a-f0-9]{40}$/.test(ref)) throw new Error('历史引用必须为完整提交 SHA');
  const descriptor = MIGRATION_MODULES[domain];
  const source = git(root, ['show', `${ref}:${descriptor.path}`]);
  const exports: Record<string, unknown> = {};
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  new Script(code, { filename: descriptor.path }).runInNewContext(
    {
      exports,
      require: (name: string) => {
        if (name !== './sqlite-driver' && name !== '../../sources/db/migrations') {
          throw new Error('历史迁移出现未允许的运行时依赖');
        }
        return {};
      },
    },
    { timeout: 1000 },
  );
  const value = exports[descriptor.symbol];
  if (!Array.isArray(value)) throw new Error('历史迁移列表缺失');
  const steps: Step[] = value.map((raw: unknown, index) => {
    if (raw === null || typeof raw !== 'object') throw new Error('历史迁移形状错误');
    const step = raw as Record<string, unknown>;
    if (
      step.version !== index + 1 ||
      !Array.isArray(step.statements) ||
      !step.statements.every((s: unknown) => typeof s === 'string')
    ) {
      throw new Error('历史迁移版本或语句非法');
    }
    return { version: index + 1, statements: [...step.statements] as string[] };
  });
  return { sourceHash: sha256(source), steps, statementsHash: sha256(JSON.stringify(steps)) };
}
export function applySteps(db: DatabaseSync, steps: Step[]): void {
  for (const step of steps) {
    db.exec('BEGIN');
    try {
      for (const sql of step.statements) db.exec(sql);
      db.exec(`PRAGMA user_version = ${step.version}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}
