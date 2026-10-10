import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

type Fault =
  | 'none'
  | 'readback-artifact'
  | 'production.result.json'
  | 'result.json'
  | 'completion.json'
  | 'stdout';

// Keep wrapper control flow and file IO. Only process launch and elapsed time use
// synchronous ports, so these checks cannot build or launch Electron/native Jobs.
function runWrapper(fault: Fault) {
  const evidence = resolve('log/stage7-e2/resume-default-smoke-review-001');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, `wrapper-${fault}-`));
  const repository = join(root, 'repository');
  const paths = [
    '.node-version',
    '.npmrc',
    'package.json',
    'package-lock.json',
    'electron.vite.config.ts',
    'eslint.config.mjs',
    'vitest.config.ts',
    'tsconfig.json',
    'tsconfig.node.json',
    'tsconfig.web.json',
    'src/fixed.ts',
    'tools/fixed.ts',
    'native/lifecycle-guardian/Guardian.cs',
    'tools/data-qualification/default-smoke/scope.ts',
    'tools/data-qualification/default-smoke/readback.ts',
    'tools/data-qualification/cross-smoke-scope.ts',
    'tools/release-profile/JobProcess.cs',
    'node.exe',
    'compiler.dll',
    'node_modules/electron/dist/electron.exe',
    'node_modules/electron-vite/package.json',
    'node_modules/electron-vite/dist/cli.js',
    'node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js',
    'out/main/index.js',
    'out/preload/index.js',
    'out/renderer/index.html',
    'out/lifecycle-guardian/guardian.exe',
  ];
  for (const path of paths) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(
      join(repository, path),
      path.includes('lib-q6ns0vZr') ? "ps.on('close', process.exit);" : 'fixed',
    );
  }
  const manifest = JSON.stringify({
    version: 1,
    bytes: 5,
    sha256: createHash('sha256').update('fixed').digest('hex'),
  });
  writeFileSync(join(repository, 'out/main/lifecycle-guardian-integrity.json'), manifest);
  writeFileSync(join(repository, 'out/lifecycle-guardian/manifest.json'), manifest);
  let source = readFileSync('tools/data-qualification/default-smoke/run.ps1', 'utf8');
  const replacements: Array<[string, string]> = [
    [
      "$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))",
      `$repository = '${repository.replaceAll("'", "''")}'`,
    ],
    [
      '$node = (Get-Command node -ErrorAction Stop).Source',
      "$node = Join-Path $repository 'node.exe'",
    ],
    [
      '$compilerAssembly = [Microsoft.CodeAnalysis.CSharp.CSharpCompilation].Assembly.Location',
      "$compilerAssembly = Join-Path $repository 'compiler.dll'",
    ],
    ['Add-Type -Path $jobSource', '# The test installed a pure synchronous process port.'],
    ['$clock = [Diagnostics.Stopwatch]::StartNew()', '$clock = [DefaultReviewClock]::new()'],
    [
      '$file.Write($bytes); $file.Flush($true)',
      `$file.Write($bytes); $file.Flush($true); if ([IO.Path]::GetFileName($Path) -eq '${fault}') { [DefaultReviewClock]::Ms=600001 }`,
    ],
    [
      'Write-Output $root',
      `Write-Output $root; if ('${fault}' -eq 'stdout') { [DefaultReviewClock]::Ms=600001 }`,
    ],
  ];
  for (const [from, to] of replacements) {
    expect(source.split(from)).toHaveLength(2);
    source = source.replace(from, to);
  }
  const setup = String.raw`
Add-Type -TypeDefinition @'
using System;
public sealed class DefaultReviewClock { public static long Ms; public long ElapsedMilliseconds { get { return Ms; } } }
namespace AIbrowse.ReleaseProfile {
 public static class JobProcess {
  public static Func<string[],uint> Hook;
  public static void AssertContains(string id,uint processId) { }
  public static uint Execute(string exe,string[] args,string cwd,string id,int ms,Action<uint,long> started) { started(777,123); return Hook(args); }
 }
}
'@
[AIbrowse.ReleaseProfile.JobProcess]::Hook = {
 param($arguments)
 if ($arguments.Count -eq 2 -and $arguments[0].EndsWith('readback.ts')) {
  $request = [IO.File]::ReadAllText($arguments[1]) | ConvertFrom-Json
  [IO.File]::WriteAllText($request.output, '{"passed":true,"ledgerRetired":true}')
  if ('${fault}' -eq 'readback-artifact') { [IO.File]::WriteAllText((Join-Path $repository 'out/main/index.js'), 'changed-at-readback-end') }
 }
 return [uint32]0
}
`;
  const firstLine = source.indexOf('\n') + 1;
  source = source.slice(0, firstLine) + setup + source.slice(firstLine);
  const script = join(root, 'control.ps1');
  writeFileSync(script, source);
  let code = 0;
  let stdout: string;
  try {
    stdout = execFileSync('pwsh', ['-NoProfile', '-File', script, '-Variant', 'production'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 65536,
      stdio: 'pipe',
    });
  } catch (error) {
    const failure = error as Error & { status: number; stdout?: string; stderr?: string };
    code = failure.status;
    stdout = failure.stdout ?? '';
    writeFileSync(join(root, 'failure.txt'), `${failure.message}\n${failure.stderr ?? ''}`);
  }
  writeFileSync(join(root, 'stdout.txt'), stdout);
  const produced = stdout.trim().split(/\r?\n/).at(-1)!;
  const result = JSON.parse(readFileSync(join(produced, 'result.json'), 'utf8')) as {
    passed: boolean;
    firstError: string | null;
  };
  const completion = JSON.parse(readFileSync(join(produced, 'completion.json'), 'utf8')) as {
    passed: boolean;
  };
  return { code, result, completion, passed: code === 0 && result.passed && completion.passed };
}

it('独立纯端口控制轮保留原 wrapper 成功路径', () => {
  expect(runWrapper('none')).toMatchObject({ code: 0, passed: true });
});

it('读回末尾改变 production 制品，不能重建基线接受漂移', () => {
  expect(runWrapper('readback-artifact').passed).toBe(false);
});

it.each(['production.result.json', 'result.json', 'completion.json', 'stdout'] as const)(
  '最后 %s 完成后跨越原600秒期限必须非零',
  (fault) => {
    expect(runWrapper(fault)).toMatchObject({ code: 1, passed: false });
  },
);
