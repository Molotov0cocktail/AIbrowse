# This test extracts only the quoting function; it never runs a speech engine.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'run-whisper.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw '运行器 PowerShell 语法解析失败。' }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'ConvertTo-WindowsArgument' }, $true)
. ([scriptblock]::Create($function.Extent.Text))
$cases = @('', 'plain', 'space path', '中文路径', 'C:\with space\', 'embedded"quote', 'before\"after', '"', '$(does-not-execute); & |')
$arguments = @('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--') + $cases
$process = New-Object Diagnostics.Process
$started = $false
try {
    $process.StartInfo.FileName = @(Get-Command node.exe -CommandType Application)[0].Source
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.Arguments = ($arguments | ForEach-Object { ConvertTo-WindowsArgument $_ }) -join ' '
    $started = $process.Start()
    $read = $process.StandardOutput.ReadToEndAsync()
    if (-not $process.WaitForExit(10000)) { throw '参数验证进程超时。' }
    if ($process.ExitCode -ne 0) { throw '参数验证进程失败。' }
    $actual = $read.Result | ConvertFrom-Json
    if ($actual.Count -ne $cases.Count) { throw '参数数量不符。' }
    for ($i = 0; $i -lt $cases.Count; $i++) {
        if ($actual[$i] -cne $cases[$i]) { throw ('参数转义验证失败，序号：' + $i) }
    }
    Write-Host ('语法与 Windows argv 转义通过：' + $cases.Count + ' 项；PowerShell ' + $PSVersionTable.PSVersion)
} finally {
    if ($started -and -not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }
    $process.Dispose()
}
