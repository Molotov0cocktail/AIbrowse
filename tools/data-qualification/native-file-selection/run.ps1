[CmdletBinding()]
param(
    [ValidateSet('Build','Run','Helper')][string]$Mode = 'Build',
    [ValidatePattern('^native-file-selection-[a-f0-9]{32}$')][string]$ScopeId,
    [ValidateSet('save','open')][string]$Case,
    [ValidateSet('selection-qualification','open-structure-observation')][string]$Purpose = 'selection-qualification'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$clock = [Diagnostics.Stopwatch]::StartNew()
$uiStartedTick = $null
$locks = [Collections.Generic.List[IO.FileStream]]::new()
function Get-SelectionFailureCodes {
    return @('runtime-host','runtime-sta','runtime-scope','runtime-binding','handshake-shape','clock-binding',
        'process-identity','dialog-identity','tree-limit','host-count','host-depth','host-subtree',
        'edit-count','edit-state','edit-handle','button-count','button-handle','button-pid','button-disabled',
        'button-offscreen','button-name','binding-changed','native-edit-identity','native-button-identity',
        'initial-value','target-state','readback','input-lease','helper-unexpected','helper-deadline')
}
function Throw-SelectionFailure([string]$Code) {
    if ($Code -cnotin (Get-SelectionFailureCodes)) { $Code='helper-unexpected' }
    $failure=[InvalidOperationException]::new('原生选择资格失败')
    $failure.Data['AIbrowse.SelectionFailure']=$Code
    throw $failure
}
function Get-SelectionFailure([Exception]$Failure) {
    for ($depth=0; $null -ne $Failure -and $depth -lt 8; $depth++) {
        $code=$Failure.Data['AIbrowse.SelectionFailure']
        if ($code -is [string] -and $code -cin (Get-SelectionFailureCodes)) { return $code }
        $Failure=$Failure.InnerException
    }
    return 'helper-unexpected'
}
function Assert-SelectionTreeRoom([int]$Count) {
    if ($Count -ge 512) { Throw-SelectionFailure 'tree-limit' }
}
function Reject-SelectionBinding([int]$Hosts,[int]$Accepted,[object[]]$Candidates,[uint32]$ExpectedPid,[string[]]$Names) {
    # Diagnostics only classify the original rejection; they never grant an action.
    if ($Hosts -eq 1 -and $Accepted -eq 1) { return }
    if ($Hosts -ne 1) { Throw-SelectionFailure 'host-count' }
    if ($Accepted -ne 0 -or $Candidates.Count -ne 1) { Throw-SelectionFailure 'button-count' }
    $candidate=$Candidates[0]
    if ($candidate.NativeWindowHandle -eq 0) { Throw-SelectionFailure 'button-handle' }
    if ($candidate.ProcessId -ne $ExpectedPid) { Throw-SelectionFailure 'button-pid' }
    if (-not $candidate.IsEnabled) { Throw-SelectionFailure 'button-disabled' }
    if ($candidate.IsOffscreen) { Throw-SelectionFailure 'button-offscreen' }
    if ($candidate.Name -cnotin $Names) { Throw-SelectionFailure 'button-name' }
    Throw-SelectionFailure 'button-count'
}
function Check-Time([long]$Limit = 120000) {
    if ($clock.ElapsedMilliseconds -ge $Limit) { Throw-SelectionFailure 'helper-deadline' }
    if ($null -ne $uiStartedTick) {
        $ticks=[Diagnostics.Stopwatch]::GetTimestamp()-$uiStartedTick
        if ($ticks -lt 0 -or $ticks -ge ([Diagnostics.Stopwatch]::Frequency*30)) { Throw-SelectionFailure 'helper-deadline' }
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
    if ('AIbrowse.SelectionQualification.EvidenceBudget' -as [type]) { [AIbrowse.SelectionQualification.EvidenceBudget]::Check([IO.Path]::GetDirectoryName($Path)) }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 8 -Compress))
    if ($bytes.Length -gt 65536) { throw '文件名资格回执过大' }
    $stream = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    try { $stream.Write($bytes); $stream.Flush($true) } finally { $stream.Dispose() }
    if ('AIbrowse.SelectionQualification.EvidenceBudget' -as [type]) { [AIbrowse.SelectionQualification.EvidenceBudget]::Check([IO.Path]::GetDirectoryName($Path)) }
}
function Check-JsonLexical([string]$Text) {
    # Consume original tokens before JsonDocument can decode property names.
    # A string followed by ':' is a field; escaped characters remain valid in values.
    $pattern='\G(?:[ \t\r\n]+|[{}\[\],:]|true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|(?<text>"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4}))*"))'
    $tokens=[regex]::new($pattern,[Text.RegularExpressions.RegexOptions]::CultureInvariant,[TimeSpan]::FromSeconds(1))
    $position=0
    while ($position -lt $Text.Length) {
        $token=$tokens.Match($Text,$position)
        if (-not $token.Success -or $token.Index -ne $position -or $token.Length -eq 0) { throw '固定JSON词法无效' }
        $position+=$token.Length
        if ($token.Groups['text'].Success) {
            $next=$position
            while ($next -lt $Text.Length -and $Text[$next] -cin @([char]' ',[char]9,[char]10,[char]13)) { $next++ }
            if ($next -lt $Text.Length -and $Text[$next] -ceq [char]':' -and $token.Value.Contains('\')) { throw '固定JSON字段名禁止转义' }
        }
    }
}
function Read-ClosedJson([string]$Path, [string[]]$Fields) {
    $file = Hold-File $Path 65536
    $bytes = [byte[]]::new([int]$file.stream.Length); $file.stream.ReadExactly($bytes)
    $text=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)
    Check-JsonLexical $text
    $document = [Text.Json.JsonDocument]::Parse([ReadOnlyMemory[byte]]::new($bytes))
    try {
        Check-JsonObject $document.RootElement 0
        $keys = @($document.RootElement.EnumerateObject() | ForEach-Object { $_.Name })
        if ($keys.Count -ne $Fields.Count -or @($keys | Select-Object -Unique).Count -ne $Fields.Count -or
            @($keys | Where-Object { $_ -cnotin $Fields }).Count -ne 0) { throw '文件名资格回执字段无效' }
        return $text | ConvertFrom-Json -AsHashtable
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
        $Expected -cnotin @('selection-qualification','open-structure-observation') -or $Actual -cne $Expected) { throw '固定目的绑定失配' }
}
function Hash-Again($File) {
    $File.stream.Position = 0
    if ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($File.stream)).ToLowerInvariant() -cne $File.hash) { throw '文件名资格来源漂移' }
}
function Assert-ExactNames([string]$Path, [string[]]$Names) {
    $entries=@(Get-ChildItem -LiteralPath $Path -Force)
    if ($entries.Count -ne $Names.Count -or @($entries | Where-Object { $_.Name -cnotin $Names }).Count -ne 0) { throw '构建目录闭包不符' }
}
function Assert-RuntimeHost {
    if ($PSVersionTable.PSEdition -ne 'Core' -or -not [Environment]::Is64BitProcess) { throw '需要现有64位PowerShell7' }
}
function Complete-WrapperResult($Report, [bool]$Qualified, [scriptblock]$Verify, [scriptblock]$Close) {
    Check-Time
    & $Verify
    Check-Time
    & $Close
    Check-Time
    $Report.qualified=$Qualified; $Report.terminal='wrapper-complete'
    $Report.elapsedMs=$clock.ElapsedMilliseconds
    $serialized=$Report | ConvertTo-Json -Compress
    Check-Time
    Write-Output $serialized
    Check-Time
}

if ($Mode -ceq 'Helper') {
    $native = $null; $button = $null; $deadline = $null; $inputLease = $null
    $report = [ordered]@{ version=1; scenario=$Case; purpose=$Purpose; ok=$false; editTarget=$false; buttonQualified=$false; writes=0; saveActions=0; selections=0; replacements=0; phase='preflight'; elapsedMs=0; failure='helper-failed' }
    $scope = [IO.Path]::GetDirectoryName($PSScriptRoot)
    try {
        $report.phase='runtime'
        try { Assert-RuntimeHost } catch { Throw-SelectionFailure 'runtime-host' }
        if ([Threading.Thread]::CurrentThread.GetApartmentState() -ne [Threading.ApartmentState]::STA) { Throw-SelectionFailure 'runtime-sta' }
        if ([string]::IsNullOrEmpty($Case) -or [IO.Path]::GetFileName($PSScriptRoot) -cne 'source' -or [IO.Path]::GetFileName($scope) -cne $ScopeId) { Throw-SelectionFailure 'runtime-scope' }
        Check-Parents $scope
        $runtime = Read-ClosedJson (Join-Path $scope 'runtime.json') @('version','scopeId','runId','pwsh','purpose')
        Assert-Purpose $Purpose $runtime.purpose
        if (-not (Is-Integer $runtime.version) -or $runtime.scopeId -isnot [string] -or $runtime.runId -isnot [string] -or $runtime.pwsh -isnot [string] -or
            $runtime.version -ne 1 -or $runtime.scopeId -cne $ScopeId -or $runtime.runId -cne $ScopeId.Substring(22)) { Throw-SelectionFailure 'runtime-binding' }
        # The framework assembly is loaded only for its narrow, non-UI membership check.
        [void][Reflection.Assembly]::LoadFrom((Join-Path $scope 'fixture.exe'))
        [AIbrowse.SelectionQualification.FilenameFixtureProgram]::AssertJob($runtime.runId)
        Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
        [void][Reflection.Assembly]::LoadFrom((Join-Path $scope 'helpers.dll'))
        $report.phase='handshake'
        $identity = Read-ClosedJson (Join-Path $scope "$Case/handshake.json") @('version','scenario','pid','created','owner','dialog','startedTick','frequency')
        foreach ($name in @('scenario','created','owner','dialog','startedTick','frequency')) { if ($identity[$name] -isnot [string]) { Throw-SelectionFailure 'handshake-shape' } }
        if (-not (Is-Integer $identity.version) -or $identity.version -ne 1 -or $identity.scenario -cne $Case -or -not (Is-Integer $identity.pid) -or $identity.pid -le 0 -or
            $identity.created -cnotmatch '^[1-9][0-9]{1,19}$' -or $identity.owner -cnotmatch '^[1-9][0-9]{0,18}$' -or $identity.dialog -cnotmatch '^[1-9][0-9]{0,18}$' -or
            $identity.startedTick -cnotmatch '^[1-9][0-9]{0,18}$' -or $identity.frequency -cne [Diagnostics.Stopwatch]::Frequency.ToString()) { Throw-SelectionFailure 'handshake-shape' }
        $uiStartedTick=[long]$identity.startedTick
        try { $deadline=[AIbrowseSelectionDeadline]::new($uiStartedTick,[long]$identity.frequency) } catch { Throw-SelectionFailure 'clock-binding' }
        Check-Time 30000
        $owner = [IntPtr]([long]$identity.owner); $dialog = [IntPtr]([long]$identity.dialog)
        $productPid = [uint32]$identity.pid
        $executable = Join-Path $scope 'fixture.exe'
        function Check-Identity {
            Check-Time 30000
            $process = [Diagnostics.Process]::GetProcessById($productPid)
            try {
                if ($process.HasExited -or $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $identity.created -or
                    -not [string]::Equals($process.MainModule.FileName,$executable,[StringComparison]::OrdinalIgnoreCase)) { Throw-SelectionFailure 'process-identity' }
            } finally { $process.Dispose() }
            [AIbrowse.SelectionQualification.FilenameFixtureProgram]::AssertJob($runtime.runId)
            Check-Time 30000
        }
        $title=if($Case -ceq 'open'){'打开本地数据备份'}else{'保存本地数据备份'}
        $buttonNames=if($Case -ceq 'open'){@('打开','打开(O)','打开(&O)','Open','&Open')}else{@('保存','保存(S)','保存(&S)','Save','&Save')}
        function Observe-OpenStructure {
            Check-Identity
            if ($Case -cne 'open' -or $Purpose -cne 'open-structure-observation') { throw '观察场景或目的不符' }
            $root=[Windows.Automation.AutomationElement]::FromHandle($dialog)
            if ($root.Current.ProcessId -ne $productPid -or $root.Current.Name -cne $title -or $root.Current.ClassName -cne '#32770') { Throw-SelectionFailure 'dialog-identity' }
            $records=[Collections.Generic.List[object]]::new();$records.Add($root);$hosts=0
            $walker=[Windows.Automation.TreeWalker]::ControlViewWalker
            for($i=0;$i -lt $records.Count;$i++) {
                Check-Identity;$child=$walker.GetFirstChild($records[$i]);Check-Identity
                while($null -ne $child) {
                    Check-Identity;Assert-SelectionTreeRoom $records.Count
                    $current=$child.Current
                    if($current.ProcessId -ne $productPid){Throw-SelectionFailure 'process-identity'}
                    $records.Add($child)
                    if($current.AutomationId -ceq 'FileNameControlHost'){$hosts++}
                    Check-Identity;$child=$walker.GetNextSibling($child);Check-Identity
                }
            }
            Check-Identity
            $structure=[AIbrowseOpenStructure]::Observe($productPid,$identity.created,$executable,$owner,$dialog,$deadline)
            Check-Identity
            $structure.Add('version',1);$structure.Add('purpose','open-structure-observation');$structure.Add('scenario','open');$structure.Add('status','complete')
            $structure.Add('uiaNodes',$records.Count);$structure.Add('hostCount',$hosts)
            $structure.Add('hostCountClass',$(if($hosts -eq 0){'zero'}elseif($hosts -eq 1){'one'}else{'many'}))
            Write-New (Join-Path $scope 'open/structure.json') $structure
            Check-Identity
        }
        function Get-Binding {
            Check-Identity
            $root = [Windows.Automation.AutomationElement]::FromHandle($dialog)
            if ($root.Current.ProcessId -ne $productPid -or $root.Current.Name -cne $title -or $root.Current.ClassName -cne '#32770') { Throw-SelectionFailure 'dialog-identity' }
            $records = [Collections.Generic.List[object]]::new()
            $records.Add(@{ node=$root; parent=-1 })
            $hosts = [Collections.Generic.List[int]]::new()
            $saves = [Collections.Generic.List[object]]::new()
            $buttonCandidates = [Collections.Generic.List[object]]::new()
            $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
            for ($i=0; $i -lt $records.Count; $i++) {
                $child = $walker.GetFirstChild($records[$i].node)
                while ($null -ne $child) {
                    Check-Time 30000
                    Assert-SelectionTreeRoom $records.Count
                    $index = $records.Count; $records.Add(@{ node=$child; parent=$i })
                    $current = $child.Current
                    if ($current.AutomationId -ceq 'FileNameControlHost') { $hosts.Add($index) }
                    if ($current.AutomationId -ceq '1' -and $current.ClassName -ceq 'Button') { $buttonCandidates.Add($current) }
                    if ($current.AutomationId -ceq '1' -and $current.ClassName -ceq 'Button' -and $current.NativeWindowHandle -ne 0 -and
                        $current.ProcessId -eq $productPid -and $current.IsEnabled -and -not $current.IsOffscreen -and
                        $current.Name -cin $buttonNames) { $saves.Add($child) }
                    $child = $walker.GetNextSibling($child)
                }
            }
            if ($hosts.Count -ne 1 -or $saves.Count -ne 1) { Reject-SelectionBinding $hosts.Count $saves.Count ($buttonCandidates.ToArray()) $productPid $buttonNames }
            $hostIndex = $hosts[0]; $depth=0
            for ($i=$records[$hostIndex].parent; $i -ge 0; $i=$records[$i].parent) { $depth++; if ($depth -gt 8) { Throw-SelectionFailure 'host-depth' } }
            $subtree = [Collections.Generic.HashSet[int]]::new(); [void]$subtree.Add($hostIndex)
            $inputs = [Collections.Generic.List[object]]::new()
            for ($i=$hostIndex+1; $i -lt $records.Count; $i++) {
                if (-not $subtree.Contains($records[$i].parent)) { continue }
                if ($subtree.Count -ge 17) { Throw-SelectionFailure 'host-subtree' }
                [void]$subtree.Add($i)
                $current = $records[$i].node.Current
                if ($current.AutomationId -ceq '1001' -and $current.ClassName -ceq 'Edit') { $inputs.Add($records[$i].node) }
            }
            if ($inputs.Count -ne 1) { Throw-SelectionFailure 'edit-count' }
            $hostNode=$records[$hostIndex].node; $editNode=$inputs[0]
            foreach ($node in @($hostNode,$editNode)) {
                if ($node.Current.ProcessId -ne $productPid -or -not $node.Current.IsEnabled -or $node.Current.IsOffscreen) { Throw-SelectionFailure 'edit-state' }
            }
            $edit=[IntPtr]$editNode.Current.NativeWindowHandle
            if ($edit -eq [IntPtr]::Zero) { Throw-SelectionFailure 'edit-handle' }
            Check-Identity
            return @{ root=$root; host=$hostNode; edit=$editNode; handle=$edit; save=$saves[0] }
        }
        if($Purpose -ceq 'open-structure-observation') {
            $report.phase='open-observation';Observe-OpenStructure
            $report.ok=$true;$report.failure='none';$report.phase='observed'
        } else {
        $report.phase='binding'; $binding = Get-Binding
        function Recheck {
            $current = Get-Binding
            foreach ($key in @('root','host','edit','save')) {
                if (-not [Windows.Automation.Automation]::Compare($current[$key],$binding[$key])) { Throw-SelectionFailure 'binding-changed' }
            }
            if ($current.handle -ne $binding.handle) { Throw-SelectionFailure 'binding-changed' }
            $native.Validate(); $button.Validate(); Check-Time 30000
        }
        $report.phase='native-edit'
        try { $native = [AIbrowseSelectionEdit]::new($productPid,$identity.created,$executable,$owner,$dialog,$binding.handle,$deadline) } catch { Throw-SelectionFailure 'native-edit-identity' }
        $saveHandle = [IntPtr]$binding.save.Current.NativeWindowHandle
        $saveName = [string]$binding.save.Current.Name
        $report.phase='native-button'
        try { $button = [AIbrowseSelectionButton]::new($productPid,$identity.created,$executable,$owner,$dialog,$saveHandle,$saveName,($Case -ceq 'open'),$deadline) } catch { Throw-SelectionFailure 'native-button-identity' }
        $report.phase='initial-recheck'; Recheck
        $report.phase='initial'
        $initial=$native.ReadText()
        if ($initial -cnotin @('AIbrowse-backup.aibak','AIbrowse-backup')) { Throw-SelectionFailure 'initial-value' }
        $button.Inspect(); $report.buttonQualified=$true
        $target=Join-Path $scope $(if($Case -ceq 'open'){'open-input/product-backup.aibak'}else{'published/product-backup.aibak'})
        if($Case -ceq 'open') { try { $inputLease=[AIbrowse.SelectionQualification.OpenInputLease]::new($target) } catch { Throw-SelectionFailure 'input-lease' } }
        elseif ((Test-Path -LiteralPath $target) -or @(Get-ChildItem -LiteralPath (Join-Path $scope 'default') -Force).Count -ne 0 -or @(Get-ChildItem -LiteralPath (Join-Path $scope 'published') -Force).Count -ne 0) { Throw-SelectionFailure 'target-state' }
        Recheck; $report.phase='select-replace'; $report.writes=1
        $native.ReplaceOnce($target,$initial)
        Recheck
        if ($native.ReadText() -cne $target) { Throw-SelectionFailure 'readback' }
        Recheck
        if ($native.ReadText() -cne $target) { Throw-SelectionFailure 'readback' }
        if ($null -ne $inputLease) { $inputLease.Verify() }
        Recheck; $report.editTarget=$true; $report.saveActions=1; $report.phase='button'
        $button.Act()
        Check-Time 30000
        if ($null -ne $inputLease) { $inputLease.Verify() }
        $report.ok=$true; $report.failure='none'; $report.phase='complete'
        }

    } catch {
        $report.ok=$false
        $report.failure=Get-SelectionFailure $_.Exception
    }
    finally {
        if ($null -ne $native) { $report.selections=$native.Selections; $report.replacements=$native.Replacements }
        foreach ($resource in @($button,$native,$inputLease)) { if ($null -ne $resource) { try { $resource.Dispose() } catch { $report.ok=$false; $report.failure='helper-release' } } }
        $report.elapsedMs=if($null -ne $deadline){$deadline.Elapsed}else{$clock.ElapsedMilliseconds}
        if ($report.elapsedMs -ge 30000) { $report.ok=$false; $report.failure='helper-deadline' }
        try { Check-Time 30000 } catch { $report.ok=$false; $report.failure='helper-deadline' }
        if ([IO.Path]::GetFileName($scope) -ceq $ScopeId -and $Case -cin @('save','open')) {
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
    'NativeSelectionFixture.cs'='tools/data-qualification/native-file-selection/NativeSelectionFixture.cs'
    'NativeSelectionEdit.cs'='tools/data-qualification/native-file-selection/NativeSelectionEdit.cs'
    'run.ps1'='tools/data-qualification/native-file-selection/run.ps1'
    'NativeSaveControl.cs'='tools/data-qualification/product-transfer/NativeSaveControl.cs'
    'NativeSaveButton.cs'='tools/data-qualification/product-transfer/NativeSaveButton.cs'
    'FixedTransferJob.cs'='tools/data-qualification/full-transfer/FixedTransferJob.cs'
}

$scope = $null; $scopeLease=$null; $openLease=$null; $ownsScope=$false; $stage='preflight'
try {
    if ($Mode -ceq 'Build') {
        Assert-RuntimeHost
        if (-not [string]::IsNullOrEmpty($ScopeId)) { throw 'Build固定生成新scope' }
        $ScopeId='native-file-selection-'+[Guid]::NewGuid().ToString('N')
        $scope=Join-Path $repository "log/stage7-e2/$ScopeId"
        Check-Parents ([IO.Path]::GetDirectoryName($scope))
        if (Test-Path -LiteralPath $scope) { throw '新scope已存在' }
        [void][IO.Directory]::CreateDirectory($scope)
        $ownsScope=$true; $stage='build'
        if (@(Get-ChildItem -LiteralPath $scope -Force).Count -ne 0) { throw '新scope非空' }
        foreach ($name in @('source','default','published','save','open','open-default','open-input')) { [void][IO.Directory]::CreateDirectory((Join-Path $scope $name)) }
        if ((Get-FileHash -LiteralPath (Join-Path $repository $sources['FixedTransferJob.cs']) -Algorithm SHA256).Hash.ToLowerInvariant() -cne 'be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167') { throw '共享Job固定来源失配' }
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
        foreach ($arg in @('/nologo','/target:winexe','/platform:x64','/optimize+','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',"/out:$binary",(Join-Path $scope 'source/NativeSelectionFixture.cs'))) { $start.ArgumentList.Add($arg) }
        $compilerProcess=[Diagnostics.Process]::Start($start)
        $stdout=$compilerProcess.StandardOutput.ReadToEndAsync(); $stderr=$compilerProcess.StandardError.ReadToEndAsync()
        if (-not $compilerProcess.WaitForExit(10000)) { $compilerProcess.Kill(); if ($compilerProcess.WaitForExit(1000)) { $compilerProcess.Dispose() }; throw '固定编译超时' }
        $compileExit=$compilerProcess.ExitCode; $compileOut=$stdout.GetAwaiter().GetResult(); $compileErr=$stderr.GetAwaiter().GetResult(); $compilerProcess.Dispose()
        Write-New (Join-Path $scope 'compile.json') @{ exit=$compileExit; stdout=$compileOut; stderr=$compileErr }
        if ($compileExit -ne 0) { throw '原生夹具编译失败' }
        Add-Type -Path @((Join-Path $scope 'source/NativeSaveControl.cs'),(Join-Path $scope 'source/NativeSaveButton.cs'),(Join-Path $scope 'source/NativeSelectionEdit.cs')) -OutputAssembly (Join-Path $scope 'helpers.dll')
        $helpers=Hold-File (Join-Path $scope 'helpers.dll')
        $exe=Hold-File $binary
        Write-New (Join-Path $scope 'build.json') @{ version=1; scopeId=$ScopeId; purpose=$Purpose; sources=$bindings; executable=$exe.hash; helpers=$helpers.hash }
        Check-Time
        [pscustomobject]@{ scopeId=$ScopeId; purpose=$Purpose; built=$true; actualUi=$false; actualJob=$false }
    } else {
        if ([string]::IsNullOrEmpty($ScopeId)) { throw 'Run必须指定已构建scope' }
        $scope=Join-Path $repository "log/stage7-e2/$ScopeId"
        Write-New (Join-Path $scope 'claim.json') @{ version=1; scopeId=$ScopeId; purpose=$Purpose; claimed=$true }
        $ownsScope=$true
        Assert-RuntimeHost
        Check-Parents $scope
        Assert-ExactNames (Join-Path $scope 'source') @($sources.Keys)
        Assert-ExactNames $scope @('source','default','published','save','open','open-default','open-input','fixture.exe','helpers.dll','compile.json','build.json','claim.json')
        if (Test-Path -LiteralPath (Join-Path $scope 'runtime.json')) { throw 'scope已开始运行，禁止重试' }
        $build=Read-ClosedJson (Join-Path $scope 'build.json') @('version','scopeId','purpose','sources','executable','helpers')
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
        if ($build.sources['FixedTransferJob.cs'] -cne 'be1fbf5623ae06da19848f33c5837c1c3ca42827935961d99453a1397cbcd167') { throw '共享Job固定来源失配' }
        $exe=Hold-File (Join-Path $scope 'fixture.exe'); $held.Add($exe)
        if ($exe.hash -cne $build.executable) { throw '夹具制品摘要失配' }
        $helpers=Hold-File (Join-Path $scope 'helpers.dll'); $held.Add($helpers)
        if ($build.helpers -isnot [string] -or $helpers.hash -cne $build.helpers) { throw 'helper制品摘要失配' }
        [void][Reflection.Assembly]::LoadFrom((Join-Path $scope 'fixture.exe'))
        $scopeLease=[AIbrowse.SelectionQualification.ScopeLease]::new($scope)
        Add-Type -Path (Join-Path $scope 'source/FixedTransferJob.cs')
        $directoryBindings=@{}
        foreach ($name in @('','source','default','published','save','open','open-default','open-input')) {
            $path=Join-Path $scope $name; Check-Parents $path
            $directoryBindings[$path]=[AIbrowse.FullTransfer.FixedTransferJob]::DirectoryIdentity($path)
        }
        foreach ($name in @('default','published','save','open','open-default','open-input')) { if (@(Get-ChildItem -LiteralPath (Join-Path $scope $name) -Force).Count -ne 0) { throw '固定场景初始目录非空' } }
        $inputPath=Join-Path $scope 'open-input/product-backup.aibak'
        $inputStream=[IO.File]::Open($inputPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
        try { $inputStream.Write([AIbrowse.SelectionQualification.OpenInputLease]::Content); $inputStream.Flush($true) } finally { $inputStream.Dispose() }
        $openLease=[AIbrowse.SelectionQualification.OpenInputLease]::new($inputPath)
        $runtime=[ordered]@{ version=1; scopeId=$ScopeId; runId=$ScopeId.Substring(22); pwsh=(Get-Process -Id $PID).Path; purpose=$Purpose }
        Write-New (Join-Path $scope 'runtime.json') $runtime
        $ownsScope=$true; $stage='job'
        [void](Hold-File (Join-Path $scope 'runtime.json') 65536)
        $job=[AIbrowse.FullTransfer.FixedTransferJob]::Execute('filename',(Join-Path $scope 'fixture.exe'),'campaign',$scope,$scope,$runtime.runId,[int](120000-$clock.ElapsedMilliseconds))
        Write-New (Join-Path $scope 'job.json') $job
        $stage='readback'
        if (-not $job.Started -or -not $job.ActualZero -or $job.OwnershipRetained -or -not $job.LimitsVerified -or $null -ne $job.ExitFailure) { throw '文件名资格未证明固定Job完整退出' }
        $openLease.Verify()
        [AIbrowse.SelectionQualification.EvidenceBudget]::Check($scope)
        foreach ($file in $held) { Hash-Again $file }
        foreach ($path in $directoryBindings.Keys) { if ([AIbrowse.FullTransfer.FixedTransferJob]::DirectoryIdentity($path) -cne $directoryBindings[$path]) { throw '固定scope目录身份漂移' } }
        $campaign=Read-ClosedJson (Join-Path $scope 'campaign.json') @('version','purpose','completed','outcome','cases','elapsedMs')
        Assert-Purpose $Purpose $campaign.purpose
        Check-Time
        if (-not (Is-Integer $campaign.version) -or $campaign.version -ne 1 -or $campaign.completed -isnot [bool] -or $campaign.outcome -isnot [string] -or
            -not (Is-Integer $campaign.cases) -or $campaign.cases -ne $(if($Purpose -ceq 'open-structure-observation'){1}else{2}) -or -not (Is-Integer $campaign.elapsedMs) -or $campaign.elapsedMs -lt 0 -or $campaign.elapsedMs -ge 120000) { throw '场景终态类型或期限无效' }
        $qualified=$Purpose -ceq 'selection-qualification' -and $job.Succeeded -and $campaign.completed -and $campaign.outcome -ceq 'selection-qualified' -and $campaign.cases -eq 2
        $observed=$Purpose -ceq 'open-structure-observation' -and $job.Succeeded -and $campaign.completed -and $campaign.outcome -ceq 'open-structure-observed' -and $campaign.cases -eq 1
        $report=[ordered]@{ version=1; scopeId=$ScopeId; purpose=$Purpose; qualified=$false; terminal='pending'; outcome=$campaign.outcome; actualZero=$job.ActualZero; sourceBinding=$build.executable; elapsedMs=$clock.ElapsedMilliseconds; productRun=$false }
        Write-New (Join-Path $scope 'result.json') $report
        Complete-WrapperResult $report $qualified {
            $openLease.Verify(); [AIbrowse.SelectionQualification.EvidenceBudget]::Check($scope)
        } {
            $openLease.Dispose(); $scopeLease.Dispose()
            foreach ($stream in $locks) { $stream.Dispose() }; $locks.Clear()
        }
        if (-not $qualified -and -not $observed) { exit 1 }
    }
} catch {
    if ($ownsScope -and -not (Test-Path -LiteralPath (Join-Path $scope 'failure.json'))) {
        Write-New (Join-Path $scope 'failure.json') @{ version=1; stage=$stage; failed=$true; elapsedMs=$clock.ElapsedMilliseconds; productRun=$false }
    }
    throw '文件名资格失败，保留原scope证据'
} finally {
    if ($null -ne $openLease) { $openLease.Dispose() }
    if ($null -ne $scopeLease) { $scopeLease.Dispose() }
    foreach ($stream in $locks) { $stream.Dispose() }
}
