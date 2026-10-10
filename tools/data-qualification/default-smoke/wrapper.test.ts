import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';

const source = readFileSync('tools/data-qualification/default-smoke/run.ps1', 'utf8');

it('wrapper每轮强制选择单一Variant，dev使用真实spawn hook且无合并轮或重跑入口', () => {
  expect(source).toContain(
    "param([Parameter(Mandatory)][ValidateSet('dev','production')][string]$Variant)",
  );
  expect(source).not.toContain("foreach ($variant in @('dev','production'))");
  expect(source).toContain("@('--import',([Uri]::new($scopeTool).AbsoluteUri),$cli,'dev')");
  expect(source).toContain('[AIbrowse.ReleaseProfile.JobProcess]::Execute');
  expect(source).toContain('[AIbrowse.ReleaseProfile.JobProcess]::AssertContains');
  expect(source).toContain("else{@('.')}");
  expect(source).not.toMatch(/Remove-Item|Stop-Process|Get-Process|\.Kill\(|retry/i);
});

it('production只接受已存在且helper绑定完整的普通build，不与dev制品互认', () => {
  for (const text of [
    'function Assert-OrdinaryProductionBuild',
    'out/main/lifecycle-guardian-integrity.json',
    'out/lifecycle-guardian/manifest.json',
    '[Convert]::ToHexString($manifestBytes)',
    '普通build helper完整性绑定无效',
    "if ($Variant -eq 'production') { $ordinaryBuild = Assert-OrdinaryProductionBuild }",
    "if ($Variant -eq 'production') { $frozenOut = @(Snapshot-Files (Out-Paths) 33554432) }",
  ])
    expect(source).toContain(text);
  expect(source).not.toContain('dev构建与production就近绑定制品不一致');
  expect(source).not.toMatch(/npm(?:\.cmd)?['"]?,?\s*@?\('run','build'/i);
});

it('实际Node/Electron大于源码8MiB门，runtime按固定成员长度和hash冻结', () => {
  expect(statSync(process.execPath).size).toBeGreaterThan(8 * 1024 * 1024);
  expect(statSync('node_modules/electron/dist/electron.exe').size).toBeGreaterThan(8 * 1024 * 1024);
  expect(source).toContain(
    '$sourceBinding = @(Snapshot-Files $sourcePaths ([long]::MaxValue) 8388608)',
  );
  expect(source).toContain('$runtimeBinding = @(Snapshot-Files $runtimePaths)');
  expect(source).not.toContain(
    '$runtimeBinding = @(Snapshot-Files $runtimePaths ([long]::MaxValue) 8388608)',
  );
});

function invokeOrdinaryBuildPort(mismatch: boolean): { code: number; output: string } {
  const repository = mkdtempSync(join(tmpdir(), 'default-production-build-'));
  const helper = Buffer.from('fixed helper');
  const manifest = JSON.stringify({
    version: 1,
    bytes: helper.length,
    sha256: createHash('sha256').update(helper).digest('hex'),
  });
  for (const [relative, bytes] of [
    ['out/main/index.js', 'main'],
    ['out/main/lifecycle-guardian-integrity.json', mismatch ? '{"version":1}' : manifest],
    ['out/preload/index.js', 'preload'],
    ['out/renderer/index.html', 'renderer'],
    ['out/lifecycle-guardian/guardian.exe', helper],
    ['out/lifecycle-guardian/manifest.json', manifest],
  ] as const) {
    const path = join(repository, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  const start = source.indexOf('function Assert-OrdinaryProductionBuild {');
  const end = source.indexOf('\nfunction Measure-Artifacts', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const escaped = repository.replaceAll("'", "''");
  const port = join(repository, 'port.ps1');
  writeFileSync(
    port,
    `$ErrorActionPreference='Stop'\n$repository='${escaped}'\n${source.slice(start, end)}\nAssert-OrdinaryProductionBuild | ConvertTo-Json -Compress`,
  );
  try {
    return {
      code: 0,
      output: execFileSync('pwsh', ['-NoProfile', '-File', port], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 65536,
        stdio: 'pipe',
      }),
    };
  } catch (error) {
    const failure = error as Error & { status: number; stdout: string; stderr: string };
    return { code: failure.status, output: `${failure.stdout}\n${failure.stderr}` };
  }
}

it('production普通build端口接受完整helper绑定并拒绝旧式混合out', () => {
  expect(invokeOrdinaryBuildPort(false)).toMatchObject({ code: 0 });
  expect(invokeOrdinaryBuildPort(true).code).toBe(1);
});

it('wrapper固定600秒工作、30秒归零及读回收口、既有四类容量预算', () => {
  for (const text of [
    '$workBudgetMs = 600000',
    '$jobZeroReserveMs = 30000',
    '[Math]::Min(10000,(Work-RemainingMs)-30000)',
    '[Math]::Min([int]::MaxValue,(Work-RemainingMs)-30000)',
    'sourceOrToolFileBytes=8388608',
    'productSnapshotBytes=33554432',
    'privateLogBytes=8388608',
    'sampledArtifactBytes=268435456',
    'maxArtifactEntries=4096',
    'maxArtifactDepth=16',
  ])
    expect(source).toContain(text);
});

it('wrapper只启用默认SMOKE并隔离app日志和profile，源/运行时/制品前后冻结', () => {
  expect(source).toContain("SetEnvironmentVariable('AIBROWSE_SMOKE','1','Process')");
  expect(source).toContain("SetEnvironmentVariable('AIBROWSE_USER_DATA_DIR',$profile,'Process')");
  expect(source).not.toMatch(/AIBROWSE_(?:SESSION|SOURCES|SOURCES_UI|RESEARCH|WATCH|LIVE)_SMOKE/);
  expect(source).toContain("$appRoot=$prefix+'.app'");
  expect(source).toContain("foreach ($name in @('APPDATA','LOCALAPPDATA','TEMP','TMP'))");
  expect(source.match(/Snapshot-Files \$sourcePaths \(\[long\]::MaxValue\) 8388608/g)).toHaveLength(
    3,
  );
  expect(source.match(/Snapshot-Files \$runtimePaths/g)).toHaveLength(3);
  expect(source).toContain('最终普通build制品改变');
  expect(source).toContain("Assert-WorkOpen '最终原件写入前600秒工作预算已耗尽'");
  expect(source).toContain('if ((Work-ElapsedMs) -ge $workBudgetMs) { $passed=$false }');
});

it('最终源码/制品复核和每个持久化close之后仍检查原600秒期限', () => {
  const finalSource = source.indexOf('最终候选源码或工具改变');
  const finalArtifact = source.indexOf('最终普通build制品改变');
  const resultWrite = source.indexOf("Write-NewJson (Join-Path $root 'result.json')");
  const resultDeadline = source.indexOf('result关闭后600秒工作预算已耗尽');
  const completionWrite = source.indexOf("Write-NewJson (Join-Path $root 'completion.json')");
  const completionDeadline = source.indexOf(
    'if ((Work-ElapsedMs) -ge $workBudgetMs) { $passed=$false }',
    completionWrite,
  );
  expect(finalSource).toBeGreaterThan(-1);
  expect(finalArtifact).toBeGreaterThan(finalSource);
  expect(resultWrite).toBeGreaterThan(finalArtifact);
  expect(resultDeadline).toBeGreaterThan(resultWrite);
  expect(completionWrite).toBeGreaterThan(resultDeadline);
  expect(completionDeadline).toBeGreaterThan(completionWrite);
  expect(source).toContain('$available = [Math]::Max(0,$jobZeroReserveMs-$script:jobZeroCreditMs)');
});
