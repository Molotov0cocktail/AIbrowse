import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

const scope = resolve(
  'log/stage7-e2',
  `cross-dev-preload-independent-${randomUUID().replaceAll('-', '')}`,
);
mkdirSync(scope);
const allowed = new Set([
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'USERPROFILE',
  'USERDOMAIN',
  'USERNAME',
  'COMSPEC',
  'PATHEXT',
  'PATH',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
]);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())),
);
writeFileSync(
  join(scope, 'intent.json'),
  JSON.stringify({
    purpose: '从wrapper真实AST提取dev参数，实际Node空eval核验Windows原生路径红态和file URI绿态',
    maxProcesses: 3,
    perProcessMs: 10000,
    maxOutputBytesPerProcess: 128 * 1024,
    electron: false,
    build: false,
    crossRequestPresent: Object.keys(env).some(
      (key) => key.toUpperCase() === 'AIBROWSE_CROSS_REQUEST',
    ),
  }),
  { flag: 'wx' },
);

function run(label: string, executable: string, args: string[]) {
  const result = spawnSync(executable, args, {
    cwd: resolve('.'),
    env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 128 * 1024,
  });
  writeFileSync(
    join(scope, `${label}.json`),
    JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: result.error?.name ?? null,
      stdout: result.stdout,
      stderr: result.stderr,
    }),
    { flag: 'wx' },
  );
  return result;
}

it('wrapper实际dev参数经Windows URI转换后真实Node preloader退出0，原生路径控制仍失败', () => {
  expect(process.platform).toBe('win32');
  expect(Object.keys(env).some((key) => key.toUpperCase() === 'AIBROWSE_CROSS_REQUEST')).toBe(
    false,
  );
  // Parse only the parameter assignment, never invoke the wrapper or its CLI.
  const extraction = run('ast', 'pwsh', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    String.raw`
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$repository = (Get-Location).Path
$wrapper = Join-Path $repository 'tools/data-qualification/run-cross-smoke.ps1'
$ast = [Management.Automation.Language.Parser]::ParseFile($wrapper,[ref]$tokens,[ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'wrapper AST解析失败' }
$matches = @($ast.FindAll({ param($candidate)
  $candidate -is [Management.Automation.Language.AssignmentStatementAst] -and
  $candidate.Left.Extent.Text -ceq '$arguments'
},$true))
if ($matches.Count -ne 1) { throw 'wrapper参数赋值不唯一' }
$Variant = 'dev'
$scopeTool = Join-Path $repository 'tools/data-qualification/cross-smoke-scope.ts'
$cli = Join-Path $repository 'node_modules/electron-vite/dist/cli.js'
$expression = $matches[0].Right.Extent.Text
$resolvedArguments = @(& ([ScriptBlock]::Create($expression)))
[ordered]@{ expression=$expression; arguments=$resolvedArguments } | ConvertTo-Json -Compress
`,
  ]);
  expect(extraction.error).toBeUndefined();
  expect(extraction.signal).toBeNull();
  expect(extraction.status).toBe(0);
  const parameters = JSON.parse(extraction.stdout) as { expression: string; arguments: string[] };
  const modulePath = resolve('tools/data-qualification/cross-smoke-scope.ts');
  expect(parameters.expression).toContain('([Uri]::new($scopeTool).AbsoluteUri)');
  expect(parameters.arguments).toEqual([
    '--import',
    pathToFileURL(modulePath).href,
    resolve('node_modules/electron-vite/dist/cli.js'),
    'dev',
  ]);

  const red = run('native-path-red', process.execPath, ['--import', modulePath, '--eval', '']);
  expect(red.error).toBeUndefined();
  expect(red.signal).toBeNull();
  expect(red.status).toBe(1);
  expect(red.stderr).toContain('ERR_UNSUPPORTED_ESM_URL_SCHEME');
  expect(red.stderr).toContain("Received protocol 'd:'");

  // Reuse the first two actual wrapper arguments; replace only Electron CLI with empty eval.
  const green = run('actual-uri-green', process.execPath, [
    ...parameters.arguments.slice(0, 2),
    '--eval',
    '',
  ]);
  expect(green.error).toBeUndefined();
  expect(green.signal).toBeNull();
  expect(green.status).toBe(0);
  expect(green.stdout).toBe('');
  expect(green.stderr).not.toContain('ERR_UNSUPPORTED_ESM_URL_SCHEME');
}, 30000);
