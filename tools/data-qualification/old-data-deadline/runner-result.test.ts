import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EXPECTED_INITIAL, EXPECTED_REOPEN, need, type Scene } from './contract';
import type { SceneResult } from './fixture';

const source = readFileSync(resolve(__dirname, 'runner.ts'), 'utf8');
const ast = ts.createSourceFile('runner.ts', source, ts.ScriptTarget.Latest, true);
const declaration = ast.statements.find(
  (node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'expectedResult',
);
if (!declaration) throw new Error('实际runner结果判定函数缺失');
const expectedResult = runInNewContext(
  ts.transpileModule(declaration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2024 },
  }).outputText + '\nexpectedResult;',
  { need },
) as (actual: SceneResult, expected: object) => void;

function result(
  scene: Scene,
  action: 'initial' | 'reopen',
  expected: { state: string; code: string; journalPhase: string },
): SceneResult {
  return {
    scene,
    action,
    state: expected.state as SceneResult['state'],
    code: expected.code as SceneResult['code'],
    journalPhase: expected.journalPhase as SceneResult['journalPhase'],
    rollbackCopyRemaining: 0,
    rollbackCopyBudget: 0,
    selected: action === 'initial' && scene !== 'normal' ? 1 : 0,
    waitedMs: 0,
    rollbackSpaceCalls: 0,
    rollbackSpaceBytes: 0,
  };
}

describe('实际runner旧集合终态判定', () => {
  it('接受三个initial与两个reopen的精确journalPhase', () => {
    for (const scene of ['normal', 'inventory', 'backing-up'] as const) {
      const expected = EXPECTED_INITIAL[scene];
      expect(() => expectedResult(result(scene, 'initial', expected), expected)).not.toThrow();
    }
    for (const scene of ['inventory', 'backing-up'] as const) {
      const expected = EXPECTED_REOPEN[scene];
      expect(() => expectedResult(result(scene, 'reopen', expected), expected)).not.toThrow();
    }
  });

  it('相同state/code但journalPhase错误时必须拒绝', () => {
    const expected = EXPECTED_INITIAL.inventory;
    const actual: SceneResult = {
      ...result('inventory', 'initial', expected),
      journalPhase: 'backing-up',
    };
    expect(() => expectedResult(actual, expected)).toThrow('场景终态不符');
  });
});
