[CmdletBinding()]
param()

# Exercise only parsed environment helpers and Node --version; never invoke a launcher or fixture.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$qualificationRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
$sentinels = @{
    NODE_OPTIONS = '--drain-qualification-invalid-option'
    NODE_PATH = 'drain-qualification-no-module-path'
    ELECTRON_RUN_AS_NODE = '1'
    AIBROWSE_SMOKE = 'environment-test-only'
}
$original = @{}
foreach ($name in $sentinels.Keys) { $original[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
$results = @()
try {
    foreach ($name in @('drain', 'utility', 'container')) {
        $source = if ($name -eq 'container') { Join-Path $qualificationRoot 'run-container-io.ps1' } else { Join-Path $qualificationRoot "$name/run.ps1" }
        $tokens = $null
        $errors = $null
        $ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
        if ($errors.Count -ne 0) { throw '启动器 PowerShell 解析失败。' }
        $functions = @($ast.FindAll({ param($item)
            $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -in @('Enter-FixedEnvironment', 'Restore-FixedEnvironment')
        }, $true))
        if ($functions.Count -ne 2) { throw '启动器固定环境辅助函数不完整。' }
        $nativeCommands = @($ast.FindAll({ param($item)
            $item -is [System.Management.Automation.Language.CommandAst] -and $item.InvocationOperator -eq 'Ampersand'
        }, $true))
        if ($nativeCommands.Count -ne $(if ($name -eq 'utility') { 2 } else { 1 })) { throw '启动器本机调用边界发生变化。' }
        foreach ($command in $nativeCommands) {
            $parent = $command.Parent
            while ($null -ne $parent -and $parent -isnot [System.Management.Automation.Language.TryStatementAst]) { $parent = $parent.Parent }
            if ($null -eq $parent -or $null -eq $parent.Finally -or $parent.Finally.Extent.Text -notmatch 'Restore-FixedEnvironment') { throw '本机预检或复验不在环境恢复作用域内。' }
        }
        $helpers = [scriptblock]::Create(($functions.Extent.Text -join "`n"))
        $results += & {
            . $helpers
            foreach ($key in $sentinels.Keys) { [Environment]::SetEnvironmentVariable($key, $sentinels[$key], 'Process') }
            $legacyOutput = @(& $node --version 2>&1)
            $legacyExit = $LASTEXITCODE
            if ($legacyExit -eq 0) { throw '未隔离环境的预设红态未出现。' }
            $saved = Enter-FixedEnvironment
            try {
                foreach ($key in $sentinels.Keys) {
                    if ($null -ne [Environment]::GetEnvironmentVariable($key, 'Process')) { throw '环境注入未被移除。' }
                }
                $version = & $node --version
                if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v24\.') { throw '隔离后 Node 预检失败。' }
            } finally { Restore-FixedEnvironment $saved }
            foreach ($key in $sentinels.Keys) {
                if ([Environment]::GetEnvironmentVariable($key, 'Process') -cne $sentinels[$key]) { throw '正常预检后环境未恢复。' }
            }
            $saved = Enter-FixedEnvironment
            $caught = $false
            try {
                try { throw '固定异常恢复反例' }
                finally { Restore-FixedEnvironment $saved }
            } catch { $caught = $_.Exception.Message -ceq '固定异常恢复反例' }
            foreach ($key in $sentinels.Keys) {
                if ([Environment]::GetEnvironmentVariable($key, 'Process') -cne $sentinels[$key]) { throw '异常预检后环境未恢复。' }
            }
            if (-not $caught) { throw '异常恢复反例未执行。' }
            [ordered]@{ launcher = $name; sourceSha256 = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant(); legacyExit = $legacyExit; legacyRejected = $legacyOutput.Count -gt 0; isolatedNode = $version; normalRestore = $true; exceptionalRestore = $true; protectedNativeCalls = $nativeCommands.Count; fixtureStarted = $false }
        }
    }
} finally {
    foreach ($name in $original.Keys) {
        $value = if ($null -eq $original[$name]) { [NullString]::Value } else { $original[$name] }
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}
$results | ConvertTo-Json -Depth 5
