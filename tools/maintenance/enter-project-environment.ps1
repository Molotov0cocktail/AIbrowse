# Dot-source this script in the development PowerShell before running project commands.
# Only the current process and its children inherit these paths; no user/machine settings change.

if ($MyInvocation.InvocationName -ne '.') {
    throw '请在当前开发 PowerShell 中执行：. .\tools\maintenance\enter-project-environment.ps1'
}

# Keep helper variables in a child scope while setting process-scoped environment variables.
& {
    $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $localRoot = Join-Path $projectRoot '.local-dev'
    $directories = @(
        $localRoot
        (Join-Path $localRoot 'cache')
        (Join-Path $localRoot 'cache\npm')
        (Join-Path $localRoot 'cache\electron')
        (Join-Path $localRoot 'cache\electron-builder')
        (Join-Path $localRoot 'temp')
    )

    foreach ($directory in $directories) {
        if (-not (Test-Path -LiteralPath $directory)) {
            [void][IO.Directory]::CreateDirectory($directory)
        }
        $item = Get-Item -LiteralPath $directory -Force -ErrorAction Stop
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "开发目录必须是项目内的普通目录，不能是文件或链接：$directory"
        }
    }

    [Environment]::SetEnvironmentVariable('npm_config_cache', (Join-Path $localRoot 'cache\npm'), 'Process')
    [Environment]::SetEnvironmentVariable('electron_config_cache', (Join-Path $localRoot 'cache\electron'), 'Process')
    [Environment]::SetEnvironmentVariable('ELECTRON_CACHE', (Join-Path $localRoot 'cache\electron'), 'Process')
    [Environment]::SetEnvironmentVariable('ELECTRON_BUILDER_CACHE', (Join-Path $localRoot 'cache\electron-builder'), 'Process')
    [Environment]::SetEnvironmentVariable('TEMP', (Join-Path $localRoot 'temp'), 'Process')
    [Environment]::SetEnvironmentVariable('TMP', (Join-Path $localRoot 'temp'), 'Process')
    Set-Location -LiteralPath $projectRoot
    Write-Host "当前开发终端的缓存和临时目录：$localRoot"
    Write-Host '仅本 PowerShell 及其子进程生效；关闭此终端即可结束。用户和系统环境变量未修改。'
}
