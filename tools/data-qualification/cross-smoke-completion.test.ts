import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// Keep the actual wrapper's IO and final return; only native launch and clock
// are substituted. These cases never create an Electron or native Job process.
function run(
  late: 'none' | 'artifact' | 'watch-check.result.json' | 'result.json' | 'completion.json',
) {
  const evidence = resolve('log/stage7-e2/cross-smoke-repair-completion');
  mkdirSync(evidence, { recursive: true });
  const root = mkdtempSync(join(evidence, 'case-'));
  const repository = join(root, 'repository');
  for (const file of [
    'src/fixed.ts',
    'tools/build/guardian.ps1',
    'native/lifecycle-guardian/Guardian.cs',
    'electron.vite.config.ts',
    'package.json',
    'package-lock.json',
    'node.exe',
    'node_modules/electron/dist/electron.exe',
    'node_modules/electron-vite/dist/cli.js',
    'node_modules/electron-vite/dist/chunks/lib-q6ns0vZr.js',
    'tools/data-qualification/cross-smoke-readback.ts',
    'tools/data-qualification/cross-smoke-scope.ts',
    'tools/release-profile/JobProcess.cs',
    'out/main/index.js',
    'out/preload/index.js',
    'out/renderer/index.html',
    'out/lifecycle-guardian/guardian.exe',
  ]) {
    mkdirSync(dirname(join(repository, file)), { recursive: true });
    writeFileSync(
      join(repository, file),
      file.includes('lib-q6ns0vZr') ? "ps.on('close', process.exit);" : 'fixed',
    );
  }
  let source = readFileSync('tools/data-qualification/run-cross-smoke.ps1', 'utf8');
  const changes: Array<[string, string]> = [
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
    ['Add-Type -Path $jobSource', '# The test uses a synchronous native port.'],
    ['$clock = [Diagnostics.Stopwatch]::StartNew()', '$clock = [CompletionClock]::new()'],
    [
      '$file.Write($bytes); $file.Flush($true)',
      `$file.Write($bytes); $file.Flush($true); if ([IO.Path]::GetFileName($Path) -eq '${late}') { [CompletionClock]::Ms=900001 }`,
    ],
  ];
  for (const [from, to] of changes) {
    expect(source.split(from)).toHaveLength(2);
    source = source.replace(from, to);
  }
  const setup = String.raw`
Add-Type -TypeDefinition @'
using System;
public sealed class CompletionClock { public static long Ms; public long ElapsedMilliseconds { get { return Ms; } } }
namespace AIbrowse.ReleaseProfile {
 public static class JobProcess {
  public static Func<string[],uint> Hook;
  public static uint Execute(string exe,string[] args,string cwd,string id,int ms,Action<uint,long> started) { started(777,1); return Hook(args); }
 }
}
'@
[AIbrowse.ReleaseProfile.JobProcess]::Hook = {
 param($arguments)
 if ($arguments.Count -eq 2 -and $arguments[0].EndsWith('cross-smoke-readback.ts')) {
  $request = [IO.File]::ReadAllText($arguments[1]) | ConvertFrom-Json
  [IO.File]::WriteAllText($request.output, '{"passed":true,"ledgerRetired":true,"runningId":"11111111-1111-4111-8111-111111111111"}')
 } elseif ('${late}' -eq 'artifact' -and $arguments.Count -eq 1 -and $arguments[0] -eq '.') {
  [IO.File]::WriteAllText((Join-Path $repository 'out/main/index.js'), 'changed-during-application')
 }
 return [uint32]0
}
`;
  const first = source.indexOf('\n') + 1;
  const script = join(root, 'control.ps1');
  writeFileSync(script, source.slice(0, first) + setup + source.slice(first));
  let code = 0;
  let stdout: string;
  try {
    stdout = execFileSync('pwsh', ['-NoProfile', '-File', script, '-Variant', 'production'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 65536,
    });
  } catch (error) {
    const failure = error as Error & { status: number; stdout: string; stderr: string };
    code = failure.status;
    stdout = failure.stdout;
    writeFileSync(join(root, 'failure.txt'), `${failure.message}\n${failure.stderr}`);
  }
  writeFileSync(join(root, 'stdout.txt'), stdout);
  const produced = stdout.trim().split(/\r?\n/).at(-1)!;
  return {
    code,
    result: JSON.parse(readFileSync(join(produced, 'result.json'), 'utf8')) as { passed: boolean },
    completion: JSON.parse(readFileSync(join(produced, 'completion.json'), 'utf8')) as {
      passed: boolean;
    },
  };
}
it('成功必须完整result/completion以及最后原期限内exit0', () => {
  const result = run('none');
  expect(result).toMatchObject({ code: 0, result: { passed: true }, completion: { passed: true } });
});
it('应用期间改变out集合，即便其余成功证据成立也拒绝', () => {
  expect(run('artifact')).toMatchObject({
    code: 1,
    result: { passed: false },
    completion: { passed: false },
  });
});
it('最后step原IO逾期不能产生整轮成功', () => {
  expect(run('watch-check.result.json')).toMatchObject({
    code: 1,
    result: { passed: false },
    completion: { passed: false },
  });
});
it.each(['result.json', 'completion.json'] as const)(
  '最后%s写入晚于原期限必须非零，不采信提前passed',
  (late) => {
    const result = run(late);
    expect(result.code).toBe(1);
    if (late === 'result.json') expect(result.completion.passed).toBe(false);
  },
);
