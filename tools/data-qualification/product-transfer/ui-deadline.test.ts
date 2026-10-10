import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// Execute the real PowerShell terminal path with a synthetic UI and clock.
// No UIAutomation, Electron, native Job, or product profile is opened.
function invoke(mode: 'normal' | 'action-late' | 'receipt-late') {
  const output = join(mkdtempSync(join(tmpdir(), 'product-ui-deadline-')), 'receipt.json');
  const command = `$ErrorActionPreference='Stop';
    $source=[IO.File]::ReadAllText($env:AIBROWSE_UI_SCRIPT);
    $tokens=$null; $errors=$null;
    $tree=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);
    if($errors.Count -ne 0){throw '脚本解析失败'};
    $checks=@($tree.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Check-Time'},$true));
    if($checks.Count -ne 1){throw '固定时限函数缺失'};
    . ([scriptblock]::Create($checks[0].Extent.Text));
    $tries=@($tree.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]});
    if($tries.Count -ne 1){throw '固定终态块缺失'};
    $sw=@($tries[0].Body.Statements | Where-Object {$_ -is [Management.Automation.Language.SwitchStatementAst]});
    if($sw.Count -ne 1){throw '实际动作分支缺失'};
    $terminal='try {'+$source.Substring($sw[0].Extent.StartOffset,$tries[0].Extent.EndOffset-$sw[0].Extent.StartOffset);
    $Output=$env:AIBROWSE_UI_OUTPUT; $Action='WaitCancelled'; $phase='WaitCancelled';
    $diagnostic=[ordered]@{version=1;action=$Action;ok=$false;phase=$phase};
    $script:uiClock=0; $clock=[pscustomobject]@{};
    $clock | Add-Member ScriptProperty ElapsedMilliseconds {
      if($env:AIBROWSE_UI_MODE -ceq 'receipt-late' -and [IO.File]::Exists($Output) -and (Get-Item -LiteralPath $Output).Length -gt 0){return 30000};
      return $script:uiClock
    };
    function Wait-For([scriptblock]$Read){if($env:AIBROWSE_UI_MODE -ceq 'action-late'){$script:uiClock=30000};return $true};
    . ([scriptblock]::Create($terminal));`;
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: {
      ...process.env,
      AIBROWSE_UI_SCRIPT: resolve('tools/data-qualification/product-transfer/ui-driver.ps1'),
      AIBROWSE_UI_OUTPUT: output,
      AIBROWSE_UI_MODE: mode,
    },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  return { result, receipt: JSON.parse(readFileSync(output, 'utf8')) as { ok: boolean } };
}

it('实际终态块的按期控制可以成功写回执', () => {
  const { result, receipt } = invoke('normal');
  expect(result.status, result.stderr).toBe(0);
  expect(receipt.ok).toBe(true);
});

it('实际UI调用返回已到30秒时不得写成功回执', () => {
  const { result, receipt } = invoke('action-late');
  expect(result.status, result.stderr).not.toBe(0);
  expect(receipt.ok).toBe(false);
});

it('实际回执写入及关闭跨越原30秒时即使已有回执也不得exit0', () => {
  const { result } = invoke('receipt-late');
  expect(result.status, result.stderr).not.toBe(0);
});
