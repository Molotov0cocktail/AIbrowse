import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

// Author-maintained regression after the native-input replan; this is no longer independent evidence.
// Exercise the actual terminal AST with synthetic ports; no UIA or native calls.
function inspect(mode: 'normal' | 'owner-changed' | 'collection-late' | 'receipt-late') {
  const output = join(mkdtempSync(join(tmpdir(), 'host-structure-independent-')), 'receipt.json');
  const command = `$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
    Add-Type -TypeDefinition @'
public sealed class AIbrowseNativeSaveControl : System.IDisposable {
  public AIbrowseNativeSaveControl(uint pid,string created,string exe,System.IntPtr main,System.IntPtr dialog,System.IntPtr edit,object clock) {}
  public void Validate() {}
  public string ReadText() { return "AIbrowse-backup.aibak"; }
  public void Dispose() {}
}
public sealed class AIbrowseNativeSaveButton : System.IDisposable {
 public AIbrowseNativeSaveButton(object a,object b,object c,object d,object e,object f,object g,object h,object i) {}
 public void Validate() {}
 public object Inspect() { return new object(); }
 public void Dispose() {}
}
'@;
    $source=[IO.File]::ReadAllText($env:AIBROWSE_UI_SCRIPT);
    $tokens=$null;$errors=$null;
    $tree=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);
    if($errors.Count){throw '入口AST无效'};
    $check=$tree.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Check-Time'},$true);
    . ([scriptblock]::Create($check.Extent.Text));
    $tries=@($tree.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]});
    if($tries.Count -ne 1){throw '终态块未唯一绑定'};
    $switches=@($tries[0].Body.Statements|Where-Object {$_ -is [Management.Automation.Language.SwitchStatementAst]});
    if($switches.Count -ne 1){throw '动作块未唯一绑定'};
    $terminal='try {'+$source.Substring($switches[0].Extent.StartOffset,$tries[0].Extent.EndOffset-$switches[0].Extent.StartOffset);
    $Output=$env:AIBROWSE_UI_OUTPUT;$Action='InspectSaveDialog';$phase=$Action;$handle=[IntPtr]22;
    $ProcessId=42;$CreatedFileTime='999';$Executable='C:\\synthetic.exe';
    $diagnostic=[ordered]@{version=1;action=$Action;ok=$false;phase=$phase};
    $script:clockValue=0;$script:assertCalls=0;$script:collectCalls=0;$script:filenameCalls=0;$script:buttonCalls=0;
    $clock=[pscustomobject]@{};
    $clock|Add-Member ScriptProperty ElapsedMilliseconds {
      if($env:AIBROWSE_UI_MODE -ceq 'receipt-late' -and [IO.File]::Exists($Output) -and (Get-Item -LiteralPath $Output).Length -gt 0){return 30000};
      return $script:clockValue
    };
    function Save-Dialog($Main){return [pscustomobject]@{synthetic=$true}};
    function Assert-Dialog($Dialog,$Main){
      $script:assertCalls++;Check-Time;
      if($script:assertCalls -eq 2 -and $env:AIBROWSE_UI_MODE -ceq 'owner-changed'){throw '原生保存窗口不满足精确所有权与标题'};
      return [IntPtr]23
    };
    function Inspect-FilenameHostStructure($Dialog,$Diagnostic){
      $script:collectCalls++;
      $Diagnostic.filenameHostStructure=[ordered]@{version=1;status='complete';nodes=@()};
      if($env:AIBROWSE_UI_MODE -ceq 'collection-late'){$script:clockValue=30000}
    };
    function Get-NativeFilenameInput($Dialog,$Diagnostic){
      Inspect-FilenameHostStructure $Dialog $Diagnostic;
      return [pscustomobject]@{Window=[IntPtr]33;Element=[pscustomobject]@{Current=[pscustomobject]@{AutomationId='1001'}}}
    };
    function Assert-NativeFilenameInput($Binding,$Dialog,$Main,$Diagnostic,$Native){[void](Assert-Dialog $Dialog $Main)};
    function Get-FilenameAutomationIdClass($Value){return 'id-1001'};
    function Get-FilenameValueClass($Value){if($Value -cne 'AIbrowse-backup.aibak'){throw '默认值不匹配'};return 'exact-default'};
    function Filename-Input($Dialog,$Diagnostic){$script:filenameCalls++;throw '选择器不应执行'};
    function Assert-NativeDialogButton($Binding,$Dialog,$Main,$Id,$Native){$Native.Validate()};
    function Dialog-Button($Dialog,$Id){$script:buttonCalls++;return [pscustomobject]@{Window=[IntPtr](30+[int]$Id);Name='固定按钮';Element=[pscustomobject]@{Current=[pscustomobject]@{Name='固定按钮'}}}};
    $returned=$false;$failure=$null;
    try{. ([scriptblock]::Create($terminal));$returned=$true}catch{$failure=$_.Exception.Message};
    [ordered]@{returned=$returned;failure=$failure;assertCalls=$script:assertCalls;collectCalls=$script:collectCalls;filenameCalls=$script:filenameCalls;buttonCalls=$script:buttonCalls}|ConvertTo-Json -Compress;`;
  const child = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
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
  expect(child.status, child.stderr).toBe(0);
  return {
    result: JSON.parse(child.stdout) as {
      returned: boolean;
      failure: string | null;
      assertCalls: number;
      collectCalls: number;
      filenameCalls: number;
      buttonCalls: number;
    },
    receipt: JSON.parse(readFileSync(output, 'utf8')) as {
      ok: boolean;
      filenameHostStructure: { status: string };
    },
  };
}

it.each([
  ['normal', null],
  ['owner-changed', '原生保存窗口不满足精确所有权与标题'],
  ['collection-late', '产品界面动作超过固定期限'],
  ['receipt-late', '产品界面动作超过固定期限'],
] as const)('实际只读Inspect终态在%s下保持所有权和原期限检查', (mode, failure) => {
  const { result, receipt } = inspect(mode);
  expect(result).toEqual({
    returned: mode === 'normal',
    failure,
    assertCalls: mode === 'normal' || mode === 'receipt-late' ? 3 : 2,
    collectCalls: 1,
    filenameCalls: 0,
    buttonCalls: mode === 'normal' || mode === 'receipt-late' ? 2 : 0,
  });
  expect(receipt.ok).toBe(mode === 'normal' || mode === 'receipt-late');
  expect(receipt.filenameHostStructure.status).toBe('complete');
});
