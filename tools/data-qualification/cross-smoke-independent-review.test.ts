import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// Execute the real PowerShell control flow with native launch replaced by a
// deterministic synchronous port. No native Job or Electron process is started.
function runControl(mode: 'control' | 'artifact' | 'deadline') {
  const evidence = resolve('log/stage7-e2/independent-cross-smoke-review-001');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, `${mode}-`));
  const repository = join(root, 'repository');
  const files = [
    'src/fixed.ts',
    'tools/build/fixed.ts',
    'package.json',
    'package-lock.json',
    'native/lifecycle-guardian/Guardian.cs',
    'tools/build/guardian.ps1',
    'electron.vite.config.ts',
    'tools/data-qualification/cross-smoke-readback.ts',
    'tools/data-qualification/cross-smoke-scope.ts',
    'tools/release-profile/JobProcess.cs',
    'node_modules/electron/dist/electron.exe',
    'node_modules/electron-vite/dist/cli.js',
    'node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js',
    'out/main/index.js',
    'out/preload/index.js',
    'out/renderer/index.html',
    'out/lifecycle-guardian/guardian.exe',
    'node.exe',
  ];
  for (const path of files) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(
      join(repository, path),
      path.includes('lib-q6ns0vZr')
        ? "ps.on('close', process.exit);"
        : path === 'package.json'
          ? JSON.stringify({ name: 'aibrowse', version: '1.0.0' })
          : 'initial-artifact',
      { flag: 'wx' },
    );
  }
  const original = readFileSync('tools/data-qualification/run-cross-smoke.ps1', 'utf8');
  const replacements: Array<[string, string]> = [
    [
      "$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))",
      `$repository = '${repository.replaceAll("'", "''")}'`,
    ],
    [
      '$node = (Get-Command node -ErrorAction Stop).Source',
      "$node = Join-Path $repository 'node.exe'",
    ],
    [
      "$reader = Join-Path $PSScriptRoot 'cross-smoke-readback.ts'",
      "$reader = Join-Path $repository 'tools/data-qualification/cross-smoke-readback.ts'",
    ],
    [
      "$scopeTool = Join-Path $PSScriptRoot 'cross-smoke-scope.ts'",
      "$scopeTool = Join-Path $repository 'tools/data-qualification/cross-smoke-scope.ts'",
    ],
    ['Add-Type -Path $jobSource', '# Native launch is substituted by the test port above.'],
    ['$clock = [Diagnostics.Stopwatch]::StartNew()', '$clock = [CrossReviewClock]::StartNew()'],
    [
      '$file.Write($bytes); $file.Flush($true)',
      `$file.Write($bytes); $file.Flush($true); if ($reviewMode -eq 'deadline' -and $Path.EndsWith('watch-check.result.json')) { [CrossReviewClock]::Ms=900001 }`,
    ],
  ];
  let instrumented = original;
  for (const [from, to] of replacements) {
    expect(instrumented.split(from)).toHaveLength(2);
    instrumented = instrumented.replace(from, to);
  }
  const setup = String.raw`
Add-Type -TypeDefinition @'
using System;
public sealed class CrossReviewClock {
  public static long Ms;
  public long ElapsedMilliseconds { get { return Ms; } }
  public static CrossReviewClock StartNew() { return new CrossReviewClock(); }
}
namespace AIbrowse.ReleaseProfile {
  public static class JobProcess {
    public static Func<string,string[],string,string,int,uint> Hook;
    public static void AssertContains(string id,uint pid) { }
    public static uint Execute(string exe,string[] args,string cwd,string id,int ms,Action<uint,long> started) {
      started(777,1); return Hook(exe,args,cwd,id,ms);
    }
  }
}
'@
$reviewMode = '${mode}'
$script:replaced = $false
[AIbrowse.ReleaseProfile.JobProcess]::Hook = {
  param($exe,$arguments,$cwd,$id,$milliseconds)
  if ($arguments.Count -eq 2 -and $arguments[0].EndsWith('cross-smoke-readback.ts')) {
    $request = [IO.File]::ReadAllText($arguments[1]) | ConvertFrom-Json
    [IO.File]::WriteAllText($request.output, '{"passed":true,"ledgerRetired":true,"runningId":"11111111-1111-4111-8111-111111111111"}')
  } elseif ($exe.EndsWith('electron.exe') -and $reviewMode -eq 'artifact' -and -not $script:replaced) {
    $script:replaced = $true
    [IO.File]::WriteAllText((Join-Path $repository 'out/main/index.js'),'replaced-during-process')
  }
  return [uint32]0
}
`;
  const firstLine = instrumented.indexOf('\n');
  instrumented = instrumented.slice(0, firstLine + 1) + setup + instrumented.slice(firstLine + 1);
  const harness = join(root, 'control.ps1');
  writeFileSync(harness, instrumented, { flag: 'wx' });
  let stdout: string;
  let exitCode = 0;
  try {
    stdout = execFileSync('pwsh', ['-NoProfile', '-File', harness, '-Variant', 'production'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 65536,
    });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; status: number };
    exitCode = failure.status;
    writeFileSync(join(root, 'failure.txt'), `${failure.message}\n${failure.stderr ?? ''}`, {
      flag: 'wx',
    });
    stdout = failure.stdout ?? '';
  }
  writeFileSync(join(root, 'stdout.txt'), stdout, { flag: 'wx' });
  const producedRoot = stdout.trim().split(/\r?\n/).at(-1)!;
  const result = JSON.parse(readFileSync(join(producedRoot, 'result.json'), 'utf8')) as {
    passed: boolean;
    elapsedMs: number;
    steps: Array<{ passed: boolean }>;
  };
  const completion = JSON.parse(readFileSync(join(producedRoot, 'completion.json'), 'utf8')) as {
    passed: boolean;
  };
  return { ...result, passed: result.passed && completion.passed && exitCode === 0 };
}

it('固定控制流正对照只经过模拟Job端口，十步全部成功', () => {
  const result = runControl('control');
  expect(result.passed).toBe(true);
  expect(result.steps).toHaveLength(10);
});

it('运行期间out制品变化，即使源文件和所有单步oracle通过也必须拒绝', () => {
  expect(runControl('artifact').passed).toBe(false);
});

it('最后一步结果写入耗尽原900秒，整轮不能仍报告通过', () => {
  const result = runControl('deadline');
  expect(result.elapsedMs).toBeGreaterThanOrEqual(900000);
  expect(result.passed).toBe(false);
});
