import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

interface ActionResult {
  action: 'InspectSaveDialog' | 'CancelSave' | 'SaveBackup';
  initial: string;
  accepted: boolean;
  writes: number;
  reads: number;
  invokes: number;
  disposed: number;
  written: string | null;
  failure: string | null;
}

// Execute the actual PowerShell action switch and classification function. The native control
// and UIA Invoke leaves are replaced with closed pure ports, so this never opens a window.
function run(initials: string[]): ActionResult[] {
  const command = String.raw`$ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
    Add-Type -TypeDefinition @'
using System;
public sealed class AIbrowseNativeSaveControl : IDisposable {
  public static string Initial, Text, Written;
  public static int Reads, Writes, Disposals;
  public AIbrowseNativeSaveControl(object a,object b,object c,object d,object e,object f,object g) { Text=Initial; }
  public void Validate() {}
  public string ReadText() { Reads++; return Text; }
  public void WriteTarget(string value) {
    if (!System.IO.Path.IsPathFullyQualified(value) || !value.EndsWith(".aibak",StringComparison.Ordinal)) throw new Exception("目标不是完整绝对aibak路径");
    Writes++; Written=value; Text=value;
  }
  public void Dispose() { Disposals++; }
}
public sealed class AIbrowseNativeSaveButton : IDisposable {
  public static int Actions;
  public AIbrowseNativeSaveButton(object a,object b,object c,object d,object e,object f,object g,object h,object i) {}
  public void Validate() {}
  public object Inspect() { return new object(); }
  public object Act() { Actions++; return new object(); }
  public void Dispose() {}
}
'@;
    $source=[IO.File]::ReadAllText($env:AIBROWSE_INITIAL_UI_SCRIPT);
    $tokens=$null;$errors=$null;
    $tree=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);
    if($errors.Count -ne 0){throw '脚本解析失败'};
    $classifiers=@($tree.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Get-FilenameValueClass'},$true));
    if($classifiers.Count -ne 1){throw '固定分类函数缺失'};
    . ([scriptblock]::Create($classifiers[0].Extent.Text));
    $tries=@($tree.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]});
    $switches=@($tries[0].Body.Statements|Where-Object {$_ -is [Management.Automation.Language.SwitchStatementAst]});
    if($tries.Count -ne 1 -or $switches.Count -ne 1){throw '实际动作分支缺失'};
    $actionSource=$switches[0].Extent.Text;
    $actions=@('InspectSaveDialog','CancelSave','SaveBackup');
    $target='C:\AIbrowse-initial-filename-test\product-backup.aibak';
    $rows=@(foreach($initial in (ConvertFrom-Json $env:AIBROWSE_INITIAL_VALUES)){
      foreach($actionName in $actions){
        [AIbrowseNativeSaveControl]::Initial=$initial;[AIbrowseNativeSaveControl]::Text=$null;
        [AIbrowseNativeSaveControl]::Written=$null;[AIbrowseNativeSaveControl]::Reads=0;
        [AIbrowseNativeSaveControl]::Writes=0;[AIbrowseNativeSaveControl]::Disposals=0;
        [AIbrowseNativeSaveButton]::Actions=0;$Action=$actionName;$Target=$target;$diagnostic=[ordered]@{};
        $root=[pscustomobject]@{};$handle=[IntPtr]11;$clock=[pscustomobject]@{};
        $ProcessId=42;$CreatedFileTime='999';$Executable='C:\product\AIbrowse.exe';
        function Save-Dialog($main){return [pscustomobject]@{}}
        function Assert-Dialog($dialog,$main){return [IntPtr]22}
        function Get-NativeFilenameInput($dialog,$state){return [pscustomobject]@{Window=[IntPtr]33;Element=[pscustomobject]@{Current=[pscustomobject]@{AutomationId='1001'}}}}
        function Assert-NativeFilenameInput($binding,$dialog,$main,$state,$native){$native.Validate()}
        function Dialog-Button($dialog,[string]$id){return [pscustomobject]@{Window=[IntPtr](30+[int]$id);Name=if($id -ceq '1'){'Save'}else{'Cancel'};Element=[pscustomobject]@{Current=[pscustomobject]@{Name=if($id -ceq '1'){'Save'}else{'Cancel'}}};Pattern=$id}}
        function Get-FilenameAutomationIdClass($value){return 'id-1001'}
        function Assert-NativeDialogButton($binding,$dialog,$main,$id,$native){$native.Validate()}
        $accepted=$true;$failure=$null;
        try{. ([scriptblock]::Create($actionSource))}catch{$accepted=$false;$failure=$_.Exception.Message}
        [pscustomobject]@{action=$actionName;initial=$initial;accepted=$accepted;writes=[AIbrowseNativeSaveControl]::Writes;reads=[AIbrowseNativeSaveControl]::Reads;invokes=[AIbrowseNativeSaveButton]::Actions;disposed=[AIbrowseNativeSaveControl]::Disposals;written=[AIbrowseNativeSaveControl]::Written;failure=$failure}
      }
    });$rows|ConvertTo-Json -Depth 4 -Compress;`;
  const child = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: {
      ...process.env,
      AIBROWSE_INITIAL_UI_SCRIPT: resolve(
        'tools/data-qualification/product-transfer/ui-driver.ps1',
      ),
      AIBROWSE_INITIAL_VALUES: JSON.stringify(initials),
    },
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout.trim()) as ActionResult[];
}

it('实际Inspect/Cancel/Save动作只接纳两个精确初值分类', () => {
  const legal = run(['AIbrowse-backup.aibak', 'AIbrowse-backup']);
  expect(legal).toHaveLength(6);
  for (const row of legal) {
    expect(row.accepted, JSON.stringify(row)).toBe(true);
    expect(row.disposed).toBe(1);
    expect(row.writes).toBe(row.action === 'SaveBackup' ? 1 : 0);
    expect(row.invokes).toBe(row.action === 'InspectSaveDialog' ? 0 : 1);
    if (row.action === 'SaveBackup')
      expect(row.written).toBe('C:\\AIbrowse-initial-filename-test\\product-backup.aibak');
    else expect(row.written).toBeFalsy();
  }
});

it.each([
  '',
  'aibrowse-backup',
  'AIbrowse-backup ',
  ' AIbrowse-backup',
  'C:\\AIbrowse-backup.aibak',
  'AIbrowse-backup.AIBAK',
  'AIbrowse-backup.zip',
])('实际动作拒绝非闭合初值且不写入或Invoke：%s', (initial) => {
  const rows = run([initial]);
  expect(rows).toHaveLength(3);
  for (const row of rows) {
    expect(row.accepted, JSON.stringify(row)).toBe(false);
    expect(row.writes).toBe(0);
    expect(row.invokes).toBe(0);
    expect(row.disposed).toBe(1);
  }
});
