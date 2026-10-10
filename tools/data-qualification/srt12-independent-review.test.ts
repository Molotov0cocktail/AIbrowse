import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import {
  isReviewedTransferSqlLocation,
  isWatchDriverSqlForward,
} from '../../src/main/smoke-sql-forward-policy';

const source = ts.createSourceFile(
  'smoke.ts',
  readFileSync('src/main/smoke.ts', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
function declaration(name: string): string {
  const found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) {
      const block = node.parent.parent.parent;
      if (
        ts.isBlock(block) &&
        block.statements.some(
          (statement) =>
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.some(
              (entry) => entry.name.getText(source) === 'sqlAllowed',
            ),
        )
      )
        found.push(`const ${node.getText(source)};`);
    }
    node.forEachChild(visit);
  }
  const scenarios = source.statements.filter(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'runSrtScenarios',
  );
  expect(scenarios).toHaveLength(1);
  visit(scenarios[0]!);
  expect(found).toHaveLength(1);
  return found[0]!;
}

// Run the actual smoke collector on an in-memory tree. Never load Electron/main.
function collect(files: Record<string, string>): { sql: string[]; renderer: string[] } {
  const srcRoot = join('D:', 'srt12-independent', 'src');
  const directories = new Map<string, Map<string, boolean>>();
  const contents = new Map<string, string>();
  for (const [relative, content] of Object.entries(files)) {
    let directory = srcRoot;
    const parts = relative.split('/');
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]!;
      const isDirectory = index < parts.length - 1;
      const entries = directories.get(directory) ?? new Map<string, boolean>();
      entries.set(name, isDirectory);
      directories.set(directory, entries);
      directory = join(directory, name);
    }
    contents.set(directory, content);
  }
  const program = ts.transpileModule(
    [
      declaration('sqlAllowed'),
      'const sqlHits = [], rendererPreloadSql = [];',
      declaration('collectFiles'),
      'collectFiles(srcRoot); ({ sql: sqlHits, renderer: rendererPreloadSql });',
    ].join('\n'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  return runInNewContext(
    program,
    {
      srcRoot,
      sep,
      join,
      isReviewedTransferSqlLocation,
      isWatchDriverSqlForward,
      readdirSync: (directory: string) =>
        [...(directories.get(directory) ?? [])].map(([name, isDirectory]) => ({
          name,
          isDirectory: () => isDirectory,
        })),
      readFileSync: (path: string) => {
        const value = contents.get(path);
        if (value === undefined) throw new Error('独立夹具缺失');
        return value;
      },
    },
    { timeout: 1000 },
  ) as { sql: string[]; renderer: string[] };
}

it('实际SRT12收集器接纳已审八模块和精确非SQL准备语句', () => {
  const paths = [
    'main/research/repository/research-transfer-validation.ts',
    'main/sources/repository/source-transfer-validation.ts',
    'main/watch/repository/watch-transfer-validation.ts',
    'main/watch/repository/watch-source-transfer-validation.ts',
    'main/storage/staging-sqlite.ts',
    'main/storage/startup-probe.ts',
    'main/storage/transfer-pipeline.ts',
    'main/storage/transfer-schema.ts',
    'main/smoke-sql-forward-policy.ts',
    'main/storage/recovery-transfer-runtime.ts',
  ];
  const files = Object.fromEntries(
    paths.map((path) => [path, readFileSync('src/' + path, 'utf8')]),
  );
  const mainLines = readFileSync('src/main/index.ts', 'utf8')
    .split('\n')
    .filter((line) => /\.(prepare|exec)\(/.test(line));
  expect(mainLines).toHaveLength(2);
  files['main/index.ts'] = mainLines.join('\n');
  expect(collect(files)).toEqual({ sql: [], renderer: [] });
});

it('分类器本身没有整文件豁免，原连续prepare字符串仍会被真实收集器拒绝', () => {
  const source = readFileSync('src/main/smoke-sql-forward-policy.ts', 'utf8');
  expect(collect({ 'main/smoke-sql-forward-policy.ts': source }).sql).toEqual([]);
  const previousLiteral =
    "const text = 'const startupState = await datasetStartup.prepare(requireNodeDataRoot());';";
  expect(collect({ 'main/smoke-sql-forward-policy.ts': previousLiteral }).sql).toHaveLength(1);
});

it('实际收集器仍拒绝main动态SQL及精确路径碰撞，renderer/preload独立禁SQL', () => {
  const result = collect({
    'main/index.ts': [
      'db.exec(rendererSql);',
      'db.prepare(payload.sql);',
      'const startupState = await datasetStartup.prepare(requireNodeDataRoot()); db.exec(input);',
    ].join('\n'),
    'main/storage/unreviewed.ts': 'db.exec(input);',
    'main/other/transfer-schema.ts': 'db.exec(input);',
    'renderer/transfer-schema.ts': 'db.exec(input);',
    'preload/startup-probe.ts': 'db.exec(input);',
  });
  expect(result.sql).toHaveLength(7);
  expect(result.sql.filter((hit) => hit.startsWith('index.ts:'))).toHaveLength(3);
  expect(result.renderer).toHaveLength(2);
});
