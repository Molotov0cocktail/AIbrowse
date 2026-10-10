$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$sourcePath = Join-Path $repository 'tools/data-qualification/default-smoke/run.ps1'
$parseErrors = $null
$tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw '候选 PowerShell 解析失败' }
# This mock has no process or native APIs; execute the unchanged callback AST.
Add-Type -TypeDefinition @'
namespace AIbrowse.ReleaseProfile {
    public static class JobProcess {
        public static uint SeenPid;
        public static string SeenRun;
        public static void AssertContains(string runId, uint processId) {
            SeenRun = runId;
            SeenPid = processId;
        }
    }
}
'@
$results = [Collections.Generic.List[object]]::new()
foreach ($definition in @(
    @{name='prepareCallback'; receipt='prepareReceipt'; run='prepareId'},
    @{name='callback'; receipt='launchReceipt'; run='stepId'},
    @{name='readerCallback'; receipt='readerReceipt'; run='readerId'}
)) {
    $matches = @($ast.FindAll({ param($item)
        $item -is [Management.Automation.Language.AssignmentStatementAst] -and
        $item.Left -is [Management.Automation.Language.VariableExpressionAst] -and
        $item.Left.VariablePath.UserPath -eq $definition.name
    }, $true))
    if ($matches.Count -ne 1) { throw '回调 AST 不唯一' }
    Set-Variable -Name $definition.receipt -Value @{pid=0;created=0}
    Set-Variable -Name $definition.run -Value ('review-' + $definition.name)
    $passed = $false
    $detail = $null
    try {
        . ([scriptblock]::Create($matches[0].Extent.Text))
        $action = Get-Variable -Name $definition.name -ValueOnly
        $action.Invoke([uint32]123, [long]456)
        $receipt = Get-Variable -Name $definition.receipt -ValueOnly
        $passed = $receipt.pid -eq 123 -and $receipt.created -eq 456 -and
            [AIbrowse.ReleaseProfile.JobProcess]::SeenPid -eq 123 -and
            [AIbrowse.ReleaseProfile.JobProcess]::SeenRun -eq ('review-' + $definition.name)
        if (-not $passed) { $detail = '精确进程身份或 AssertContains 参数没有保持' }
    } catch { $detail = $_.Exception.Message }
    $results.Add([ordered]@{callback=$definition.name;line=$matches[0].Extent.StartLineNumber;passed=$passed;detail=$detail})
}
$results | ConvertTo-Json -Depth 8
if (@($results | Where-Object {-not $_.passed}).Count -ne 0) { exit 1 }
