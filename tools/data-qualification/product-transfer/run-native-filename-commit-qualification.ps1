[CmdletBinding()]
param(
    [ValidateSet('Build','Run','Helper')][string]$Mode = 'Build',
    [ValidatePattern('^native-filename-commit-[a-f0-9]{32}$')][string]$ScopeId,
    [ValidateSet('candidate')][string]$Case,
    [ValidateSet('qualification','focus-diagnostic')][string]$Purpose = 'qualification'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -ne 'Core' -or -not [Environment]::Is64BitProcess) { throw '需要现有64位PowerShell7' }
$clock = [Diagnostics.Stopwatch]::StartNew()
$uiStartedTick = $null
$locks = [Collections.Generic.List[IO.FileStream]]::new()
function Check-Time([long]$Limit = 120000) {
    if ($clock.ElapsedMilliseconds -ge $Limit) { throw '文件名资格原期限已过' }
    if ($null -ne $uiStartedTick) {
        $ticks=[Diagnostics.Stopwatch]::GetTimestamp()-$uiStartedTick
        if ($ticks -lt 0 -or $ticks -ge ([Diagnostics.Stopwatch]::Frequency*30)) { throw '共享UI原期限已过' }
    }
}
function Check-Parents([string]$Path) {
    for ($current = $Path; -not [string]::IsNullOrEmpty($current); $current = [IO.Path]::GetDirectoryName($current)) {
        $item = Get-Item -LiteralPath $current -Force
        if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '文件名资格目录含链接或无效' }
    }
}
function Hold-File([string]$Path, [long]$Maximum = 1048576) {
    Check-Parents ([IO.Path]::GetDirectoryName($Path))
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '文件名资格来源无效' }
    $stream = [IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $locks.Add($stream)
    if ($stream.Length -le 0 -or $stream.Length -gt $Maximum) { throw '文件名资格来源大小无效' }
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($stream)).ToLowerInvariant()
    $stream.Position = 0
    return @{ stream=$stream; hash=$hash; path=$Path }
}
function Write-New([string]$Path, $Value) {
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 8 -Compress))
    if ($bytes.Length -gt 65536) { throw '文件名资格回执过大' }
    $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Read-ClosedJson([string]$Path, [string[]]$Fields) {
    $file = Hold-File $Path 65536
    $bytes = [byte[]]::new([int]$file.stream.Length); $file.stream.ReadExactly($bytes)
    $document = [Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($bytes))
    try {
        Check-JsonObject $document.RootElement 0
        $keys = @($document.RootElement.EnumerateObject() | ForEach-Object { $_.Name })
        if ($keys.Count -ne $Fields.Count -or @($keys | Select-Object -Unique).Count -ne $Fields.Count -or
            @($keys | Where-Object { $_ -cnotin $Fields }).Count -ne 0) { throw '文件名资格回执字段无效' }
        return [Text.UTF8Encoding]::new($false,$true).GetString($bytes) | ConvertFrom-Json -AsHashtable
    } finally { $document.Dispose() }
}
function Check-JsonObject($Element, [int]$Depth) {
    if ($Depth -gt 2 -or $Element.ValueKind -ne [Text.Json.JsonValueKind]::Object) { throw '固定JSON对象无效' }
    $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($property in $Element.EnumerateObject()) {
        if (-not $seen.Add($property.Name)) { throw '固定JSON重复字段' }
        switch ($property.Value.ValueKind) {
            Object { Check-JsonObject $property.Value ($Depth+1) }
            String { }
            True { }
            False { }
            Number { $integer=0L; if (-not $property.Value.TryGetInt64([ref]$integer)) { throw '固定JSON非整数' } }
            default { throw '固定JSON字段类型无效' }
        }
    }
}
function Is-Integer($Value) { return $Value -is [long] -or $Value -is [int] }
function Assert-Purpose($Expected, $Actual) {
    if ($Expected -isnot [string] -or $Actual -isnot [string] -or
        $Expected -cnotin @('qualification','focus-diagnostic') -or $Actual -cne $Expected) { throw '固定目的绑定失配' }
}
function Hash-Again($File) {
    $File.stream.Position = 0
    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($File.stream)).ToLowerInvariant() -cne $File.hash) { throw '文件名资格来源漂移' }
}

if ($Mode -ceq 'Helper') {
    $native = $null; $value = $null; $button = $null; $deadline = $null
    $report = [ordered]@{ version=1; scenario=$Case; purpose=$Purpose; ok=$false; editTarget=$false; msaaQualified=$false; writes=0; saveActions=0; focusActions=0; editFocusVerified=$false; saveFocusVerified=$false; phase='preflight'; exceptionType='none'; nativeFocus='not-read'; focus='none'; focusRead=$false; elapsedMs=0; failure='helper-failed' }
    $scope = [IO.Path]::GetDirectoryName($PSScriptRoot)
    try {
        if ([string]::IsNullOrEmpty($Case) -or [IO.Path]::GetFileName($PSScriptRoot) -cne 'source' -or [IO.Path]::GetFileName($scope) -cne $ScopeId) { throw 'helper只接受固定scope入口' }
        Check-Parents $scope
        $runtime = Read-ClosedJson (Join-Path $scope 'runtime.json') @('version','scopeId','runId','pwsh','purpose')
        Assert-Purpose $Purpose $runtime.purpose
        if (-not (Is-Integer $runtime.version) -or $runtime.scopeId -isnot [string] -or $runtime.runId -isnot [string] -or $runtime.pwsh -isnot [string] -or
            $runtime.version -ne 1 -or $runtime.scopeId -cne $ScopeId -or $runtime.runId -cne $ScopeId.Substring(23)) { throw '固定runtime绑定无效' }
        # The framework assembly is loaded only for its narrow, non-UI membership check.
        [void][Reflection.Assembly]::LoadFrom((Join-Path $scope 'fixture.exe'))
        [AIbrowse.FilenameQualification.FilenameFixtureProgram]::AssertJob($runtime.runId)
        Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
        Add-Type -Path @((Join-Path $PSScriptRoot 'NativeSaveControl.cs'),(Join-Path $PSScriptRoot 'NativeSaveButton.cs'),(Join-Path $PSScriptRoot 'NativeFilenameValueCandidate.cs'),(Join-Path $PSScriptRoot 'NativeFilenameFocus.cs'))
        $identity = Read-ClosedJson (Join-Path $scope "$Case/handshake.json") @('version','scenario','pid','created','owner','dialog','startedTick','frequency')
        foreach ($name in @('scenario','created','owner','dialog','startedTick','frequency')) { if ($identity[$name] -isnot [string]) { throw '固定窗口身份类型无效' } }
        if (-not (Is-Integer $identity.version) -or $identity.version -ne 1 -or $identity.scenario -cne $Case -or -not (Is-Integer $identity.pid) -or $identity.pid -le 0 -or
            $identity.created -cnotmatch '^[1-9][0-9]{1,19}$' -or $identity.owner -cnotmatch '^[1-9][0-9]{0,18}$' -or $identity.dialog -cnotmatch '^[1-9][0-9]{0,18}$' -or
            $identity.startedTick -cnotmatch '^[1-9][0-9]{0,18}$' -or $identity.frequency -cne [Diagnostics.Stopwatch]::Frequency.ToString()) { throw '固定窗口身份字段无效' }
        $uiStartedTick=[long]$identity.startedTick
        $deadline=[AIbrowseFilenameDeadline]::new($uiStartedTick,[long]$identity.frequency)
        Check-Time 30000
        $owner = [IntPtr]([long]$identity.owner); $dialog = [IntPtr]([long]$identity.dialog)
        $productPid = [uint32]$identity.pid
        $executable = Join-Path $scope 'fixture.exe'
        function Check-Identity {
            Check-Time 30000
            $process = [Diagnostics.Process]::GetProcessById($productPid)
            try {
                if ($process.HasExited -or $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $identity.created -or
                    -not [string]::Equals($process.MainModule.FileName,$executable,[StringComparison]::OrdinalIgnoreCase)) { throw '原生夹具进程身份变化' }
            } finally { $process.Dispose() }
            [AIbrowse.FilenameQualification.FilenameFixtureProgram]::AssertJob($runtime.runId)
            Check-Time 30000
        }
        function Get-Binding {
            Check-Identity
            $root = [Windows.Automation.AutomationElement]::FromHandle($dialog)
            if ($root.Current.ProcessId -ne $productPid -or $root.Current.Name -cne '保存本地数据备份' -or $root.Current.ClassName -cne '#32770') { throw '原生dialog资格变化' }
            $records = [Collections.Generic.List[object]]::new()
            $records.Add(@{ node=$root; parent=-1 })
            $hosts = [Collections.Generic.List[int]]::new()
            $saves = [Collections.Generic.List[object]]::new()
            $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
            for ($i=0; $i -lt $records.Count; $i++) {
                $child = $walker.GetFirstChild($records[$i].node)
                while ($null -ne $child) {
                    Check-Time 30000
                    if ($records.Count -ge 512) { throw '原生dialog整树超限' }
                    $index = $records.Count; $records.Add(@{ node=$child; parent=$i })
                    $current = $child.Current
                    if ($current.AutomationId -ceq 'FileNameControlHost') { $hosts.Add($index) }
                    if ($current.AutomationId -ceq '1' -and $current.ClassName -ceq 'Button' -and $current.NativeWindowHandle -ne 0 -and
                        $current.ProcessId -eq $productPid -and $current.IsEnabled -and -not $current.IsOffscreen -and
                        $current.Name -cin @('保存','保存(S)','保存(&S)','Save','&Save')) { $saves.Add($child) }
                    $child = $walker.GetNextSibling($child)
                }
            }
            if ($hosts.Count -ne 1 -or $saves.Count -ne 1) { throw '原生host或保存按钮不唯一' }
            $hostIndex = $hosts[0]; $depth=0
            for ($i=$records[$hostIndex].parent; $i -ge 0; $i=$records[$i].parent) { $depth++; if ($depth -gt 8) { throw '原生host祖先超限' } }
            $subtree = [Collections.Generic.HashSet[int]]::new(); [void]$subtree.Add($hostIndex)
            $inputs = [Collections.Generic.List[object]]::new()
            for ($i=$hostIndex+1; $i -lt $records.Count; $i++) {
                if (-not $subtree.Contains($records[$i].parent)) { continue }
                if ($subtree.Count -ge 17) { throw '原生host后代超限' }
                [void]$subtree.Add($i)
                $current = $records[$i].node.Current
                if ($current.AutomationId -ceq '1001' -and $current.ClassName -ceq 'Edit') { $inputs.Add($records[$i].node) }
            }
            if ($inputs.Count -ne 1) { throw '原生文件名输入不唯一' }
            $hostNode=$records[$hostIndex].node; $editNode=$inputs[0]
            foreach ($node in @($hostNode,$editNode)) {
                if ($node.Current.ProcessId -ne $productPid -or -not $node.Current.IsEnabled -or $node.Current.IsOffscreen) { throw '原生文件名UIA资格无效' }
            }
            $edit=[IntPtr]$editNode.Current.NativeWindowHandle
            if ($edit -eq [IntPtr]::Zero) { throw '原生Edit句柄为空' }
            Check-Identity
            return @{ root=$root; host=$hostNode; edit=$editNode; handle=$edit; save=$saves[0] }
        }
        $binding = Get-Binding
        function Recheck {
            $current = Get-Binding
            foreach ($key in @('root','host','edit','save')) {
                if (-not [Windows.Automation.Automation]::Compare($current[$key],$binding[$key])) { throw '原生控件关系变化' }
            }
            if ($current.handle -ne $binding.handle) { throw '原生Edit句柄变化' }
            $native.Validate(); $button.Validate(); Check-Time 30000
        }
        $native = [AIbrowseFilenamePorts]::Control($productPid,$identity.created,$executable,$owner,$dialog,$binding.handle,$deadline)
        if ($Purpose -ceq 'qualification') { $value = [AIbrowseFilenamePorts]::Value($productPid,$identity.created,$executable,$owner,$dialog,$binding.handle,$deadline) }
        $saveHandle = [IntPtr]$binding.save.Current.NativeWindowHandle
        $saveName = [string]$binding.save.Current.Name
        $button = [AIbrowseFilenamePorts]::Button($productPid,$identity.created,$executable,$owner,$dialog,$saveHandle,$saveName,$deadline)
        Recheck
        $focus=[AIbrowseNativeFilenameFocus]::new($productPid,$dialog,$binding.handle,$saveHandle,$deadline)
        $report.focusActions=1
        $report.phase='edit-focus-call'
        $binding.edit.SetFocus()
        $report.phase='edit-focus-recheck'
        Recheck
        $report.phase='edit-focus-native'
        if ($Purpose -ceq 'focus-diagnostic') {
            $projection=$focus.InspectEditDiagnostic()
            $report.nativeFocus=$projection.Judgment; $report.focus=$projection.Focus; $report.focusRead=$projection.FocusRead
            $report.editFocusVerified=$projection.Matched
            $report.phase='diagnostic-complete'; $report.failure='focus-diagnostic-complete'
        } else {
        $focus.AcceptEdit(); $report.editFocusVerified=$true
        $report.phase='qualification'
        $initial=$native.ReadText()
        if ($initial -cnotin @('AIbrowse-backup.aibak','AIbrowse-backup')) { throw '原生初值不在闭合集合' }
        [void]$button.Inspect()
        try { $report.msaaQualified=$value.Inspect($initial) }
        catch [FilenameValueQualificationException] { $report.msaaQualified=$false }
        Recheck
        if (-not $report.msaaQualified) { throw '候选MSAA资格不成立' }
        $target = Join-Path $scope 'published/product-backup.aibak'
        if (@(Get-ChildItem -LiteralPath (Join-Path $scope 'default') -Force).Count -ne 0 -or @(Get-ChildItem -LiteralPath (Join-Path $scope 'published') -Force).Count -ne 0) { throw '固定选择目录非空' }
        $report.writes=1
        $focus.AssertEdit()
        $value.WriteTarget($target,$initial)
        $focus.AssertEdit()
        Recheck
        if ($native.ReadText() -cne $target) { throw '原生目标读回失配' }
        Recheck
        if ($native.ReadText() -cne $target) { throw '保存前原生目标改变' }
        Recheck
        $focus.AssertEdit(); $report.focusActions=2
        $binding.save.SetFocus()
        Recheck; $focus.AcceptSave(); $report.saveFocusVerified=$true
        if ($native.ReadText() -cne $target) { throw '焦点提交后原生目标改变' }
        Recheck; $focus.AssertSave()
        $report.editTarget=$true; $report.saveActions=1
        [void]$button.Act()
        Check-Time 30000
        $report.ok=$true; $report.failure='none'
        }
    } catch {
        $report.ok=$false
        if ('AIbrowseNativeFilenameFocus' -as [type]) { $report.exceptionType=[AIbrowseNativeFilenameFocus]::ClassifyException($_.Exception) }
        else { $report.exceptionType='other' }
    }
    finally {
        foreach ($resource in @($button,$value,$native)) { if ($null -ne $resource) { try { $resource.Dispose() } catch { $report.ok=$false; $report.failure='helper-release' } } }
        $report.elapsedMs=if($null -ne $deadline){$deadline.ElapsedMilliseconds}else{$clock.ElapsedMilliseconds}
        if ($report.elapsedMs -ge 30000) { $report.ok=$false; $report.failure='helper-deadline' }
        try { Check-Time 30000 } catch { $report.ok=$false; $report.failure='helper-deadline' }
        if ([IO.Path]::GetFileName($scope) -ceq $ScopeId -and $Case -ceq 'candidate') {
            Write-New (Join-Path $scope "$Case/helper.json") $report
        }
        foreach ($stream in $locks) { $stream.Dispose() }
    }
    if (-not $report.ok) { exit 1 }
    try { Check-Time 30000 } catch { exit 1 }
    exit 0
}

if (-not [string]::IsNullOrEmpty($Case)) { throw '非helper模式不接受场景参数' }
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
$sources = [ordered]@{
    'NativeFilenameDialogFixture.cs'='tools/data-qualification/product-transfer/NativeFilenameDialogFixture.cs'
    'NativeFilenameValueCandidate.cs'='tools/data-qualification/product-transfer/NativeFilenameValueCandidate.cs'
    'NativeFilenameFocus.cs'='tools/data-qualification/product-transfer/NativeFilenameFocus.cs'
    'run-native-filename-commit-qualification.ps1'='tools/data-qualification/product-transfer/run-native-filename-commit-qualification.ps1'
    'NativeSaveControl.cs'='tools/data-qualification/product-transfer/NativeSaveControl.cs'
    'NativeSaveButton.cs'='tools/data-qualification/product-transfer/NativeSaveButton.cs'
    'FixedTransferJob.cs'='tools/data-qualification/full-transfer/FixedTransferJob.cs'
}
$scope = $null; $scopeLease=$null; $ownsScope=$false; $stage='preflight'
try {
    if ($Mode -ceq 'Build') {
        if (-not [string]::IsNullOrEmpty($ScopeId)) { throw 'Build固定生成新scope' }
        $ScopeId='native-filename-commit-'+[Guid]::NewGuid().ToString('N')
        $scope=Join-Path $repository "log/stage7-e2/$ScopeId"
        Check-Parents ([IO.Path]::GetDirectoryName($scope))
        if (Test-Path -LiteralPath $scope) { throw '新scope已存在' }
        [void][IO.Directory]::CreateDirectory($scope)
        $ownsScope=$true; $stage='build'
        if (@(Get-ChildItem -LiteralPath $scope -Force).Count -ne 0) { throw '新scope非空' }
        foreach ($name in @('source','default','published','reference','candidate')) { [void][IO.Directory]::CreateDirectory((Join-Path $scope $name)) }
        $bindings=[ordered]@{}
        foreach ($name in $sources.Keys) {
            $file=Hold-File (Join-Path $repository $sources[$name])
            $copy=[IO.File]::Open((Join-Path $scope "source/$name"),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
            try { $file.stream.CopyTo($copy); $copy.Flush($true) } finally { $copy.Dispose() }
            $bindings[$name]=$file.hash
        }
        $compiler=Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        $binary=Join-Path $scope 'fixture.exe'
        $start=[Diagnostics.ProcessStartInfo]::new($compiler)
        $start.UseShellExecute=$false; $start.CreateNoWindow=$true; $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
        foreach ($arg in @('/nologo','/target:winexe','/platform:x64','/optimize+','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',"/out:$binary",(Join-Path $scope 'source/NativeFilenameDialogFixture.cs'))) { $start.ArgumentList.Add($arg) }
        $compilerProcess=[Diagnostics.Process]::Start($start)
        $stdout=$compilerProcess.StandardOutput.ReadToEndAsync(); $stderr=$compilerProcess.StandardError.ReadToEndAsync()
        if (-not $compilerProcess.WaitForExit(10000)) { $compilerProcess.Kill(); if ($compilerProcess.WaitForExit(1000)) { $compilerProcess.Dispose() }; throw '固定编译超时' }
        $compileExit=$compilerProcess.ExitCode; $compileOut=$stdout.GetAwaiter().GetResult(); $compileErr=$stderr.GetAwaiter().GetResult(); $compilerProcess.Dispose()
        Write-New (Join-Path $scope 'compile.json') @{ exit=$compileExit; stdout=$compileOut; stderr=$compileErr }
        if ($compileExit -ne 0) { throw '原生夹具编译失败' }
        $exe=Hold-File $binary
        Write-New (Join-Path $scope 'build.json') @{ version=1; scopeId=$ScopeId; purpose=$Purpose; sources=$bindings; executable=$exe.hash }
        Check-Time
        [pscustomobject]@{ scopeId=$ScopeId; purpose=$Purpose; built=$true; actualUi=$false; actualJob=$false }
    } else {
        if ([string]::IsNullOrEmpty($ScopeId)) { throw 'Run必须指定已构建scope' }
        $scope=Join-Path $repository "log/stage7-e2/$ScopeId"
        Check-Parents $scope
        if (Test-Path -LiteralPath (Join-Path $scope 'runtime.json')) { throw 'scope已开始运行，禁止重试' }
        $build=Read-ClosedJson (Join-Path $scope 'build.json') @('version','scopeId','purpose','sources','executable')
        Assert-Purpose $Purpose $build.purpose
        if (-not (Is-Integer $build.version) -or $build.version -ne 1 -or $build.scopeId -isnot [string] -or $build.scopeId -cne $ScopeId -or
            $build.executable -isnot [string] -or $build.executable -cnotmatch '^[a-f0-9]{64}$' -or $build.sources -isnot [Collections.IDictionary] -or $build.sources.Count -ne $sources.Count) { throw '构建来源结构无效' }
        $held=[Collections.Generic.List[object]]::new()
        foreach ($name in $sources.Keys) {
            if (-not $build.sources.Contains($name) -or $build.sources[$name] -isnot [string] -or $build.sources[$name] -cnotmatch '^[a-f0-9]{64}$') { throw '构建来源闭包无效' }
            foreach ($path in @((Join-Path $repository $sources[$name]),(Join-Path $scope "source/$name"))) {
                $file=Hold-File $path; if ($file.hash -cne $build.sources[$name]) { throw '构建来源摘要失配' }; $held.Add($file)
            }
        }
        $exe=Hold-File (Join-Path $scope 'fixture.exe'); $held.Add($exe)
        if ($exe.hash -cne $build.executable) { throw '夹具制品摘要失配' }
        [void][Reflection.Assembly]::LoadFrom((Join-Path $scope 'fixture.exe'))
        $scopeLease=[AIbrowse.FilenameQualification.ScopeLease]::new($scope)
        Add-Type -Path (Join-Path $scope 'source/FixedTransferJob.cs')
        $directoryBindings=@{}
        foreach ($name in @('','source','default','published','reference','candidate')) {
            $path=Join-Path $scope $name; Check-Parents $path
            $directoryBindings[$path]=[AIbrowse.FullTransfer.FixedTransferJob]::DirectoryIdentity($path)
        }
        foreach ($name in @('default','published','reference','candidate')) { if (@(Get-ChildItem -LiteralPath (Join-Path $scope $name) -Force).Count -ne 0) { throw '固定场景初始目录非空' } }
        $runtime=[ordered]@{ version=1; scopeId=$ScopeId; runId=$ScopeId.Substring(23); pwsh=(Get-Process -Id $PID).Path; purpose=$Purpose }
        Write-New (Join-Path $scope 'runtime.json') $runtime
        $ownsScope=$true; $stage='job'
        [void](Hold-File (Join-Path $scope 'runtime.json') 65536)
        $job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute('filename',(Join-Path $scope 'fixture.exe'),'campaign',$scope,$scope,$runtime.runId,[int](120000-$clock.ElapsedMilliseconds))
        Write-New (Join-Path $scope 'job.json') $job
        $stage='readback'
        if (-not $job.Started -or -not $job.ActualZero -or $job.OwnershipRetained -or -not $job.LimitsVerified -or $null -ne $job.ExitFailure) { throw '文件名资格未证明固定Job完整退出' }
        foreach ($file in $held) { Hash-Again $file }
        foreach ($path in $directoryBindings.Keys) { if ([AIbrowse.FullTransfer.FixedTransferJob]::DirectoryIdentity($path) -cne $directoryBindings[$path]) { throw '固定scope目录身份漂移' } }
        $campaign=Read-ClosedJson (Join-Path $scope 'campaign.json') @('version','purpose','completed','outcome','cases','elapsedMs')
        Assert-Purpose $Purpose $campaign.purpose
        Check-Time
        if (-not (Is-Integer $campaign.version) -or $campaign.version -ne 1 -or $campaign.completed -isnot [bool] -or $campaign.outcome -isnot [string] -or
            -not (Is-Integer $campaign.cases) -or $campaign.cases -ne 1 -or -not (Is-Integer $campaign.elapsedMs) -or $campaign.elapsedMs -lt 0 -or $campaign.elapsedMs -ge 120000) { throw '场景终态类型或期限无效' }
        $qualified=$Purpose -ceq 'qualification' -and $job.Succeeded -and $campaign.completed -and $campaign.outcome -ceq 'focus-candidate-qualified' -and $campaign.cases -eq 1
        $report=[ordered]@{ version=1; scopeId=$ScopeId; purpose=$Purpose; qualified=$qualified; outcome=$campaign.outcome; actualZero=$job.ActualZero; sourceBinding=$build.executable; elapsedMs=$clock.ElapsedMilliseconds; productRun=$false }
        Write-New (Join-Path $scope 'result.json') $report
        Check-Time
        $report
        if (-not $qualified) { exit 1 }
    }
} catch {
    if ($ownsScope -and -not (Test-Path -LiteralPath (Join-Path $scope 'failure.json'))) {
        Write-New (Join-Path $scope 'failure.json') @{ version=1; stage=$stage; failed=$true; elapsedMs=$clock.ElapsedMilliseconds; productRun=$false }
    }
    throw '文件名资格失败，保留原scope证据'
} finally {
    if ($null -ne $scopeLease) { $scopeLease.Dispose() }
    foreach ($stream in $locks) { $stream.Dispose() }
}
