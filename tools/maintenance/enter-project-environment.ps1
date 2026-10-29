# Dot-source this script in the development PowerShell before running project commands.
# Only the current process and its children inherit these paths; no user/machine settings change.

if ($MyInvocation.InvocationName -ne '.') {
    throw '请在当前开发 PowerShell 中执行：. .\tools\maintenance\enter-project-environment.ps1'
}

# Keep helper variables in a child scope while setting process-scoped environment variables.
& {
    $projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $localRoot = Join-Path $projectRoot '.local-dev'
    $nodeVersion = [IO.File]::ReadAllText((Join-Path $projectRoot '.node-version')).Trim()
    if ($nodeVersion -cnotmatch '^24\.[0-9]+\.[0-9]+$') { throw '项目 Node 版本声明无效' }
    $nodeDirectory = Join-Path $localRoot ('node-v' + $nodeVersion + '/node-v' + $nodeVersion + '-win-x64')
    if (Test-Path -LiteralPath (Join-Path $nodeDirectory 'node.exe')) {
        $env:PATH = $nodeDirectory + [IO.Path]::PathSeparator + $env:PATH
    }
    if ((& node --version) -cne ('v' + $nodeVersion)) {
        throw "需要项目固定 Node $nodeVersion；请先在 .local-dev 安装经官方摘要核验的 Windows x64 运行时"
    }
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
