[CmdletBinding()]
param()

# Author-maintained MSAA fixture adaptation; this run is not independent review.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$evidence = Join-Path $repository 'log/stage7-e2/native-save-button-completion-001/stem-author-regression'
[void][IO.Directory]::CreateDirectory($evidence)
$results = [Collections.Generic.List[object]]::new()
function Check([string]$Name, [bool]$Condition) {
    $results.Add(@{ name = $Name; pass = $Condition })
    [IO.File]::WriteAllText((Join-Path $evidence 'results.json'), (@{ cases = $results.ToArray(); passed = @($results | Where-Object pass).Count; actualUi = $false; actualArchive = $false; nativeCalls = $false } | ConvertTo-Json -Depth 8))
    if (-not $Condition) { throw ('独审反例失败：' + $Name) }
}
function Slice([string]$Source, [string]$Start, [string]$End) {
    $first = $Source.IndexOf($Start, [StringComparison]::Ordinal)
    $last = $Source.IndexOf($End, [StringComparison]::Ordinal)
    if ($first -lt 0 -or $last -le $first -or $Source.LastIndexOf($Start, [StringComparison]::Ordinal) -ne $first) { throw '独审源码边界不唯一' }
    return $Source.Substring($first, $last - $first)
}
function Json($Value) { ConvertTo-Json -InputObject $Value -Depth 30 -Compress }
function Copy-Value($Value) { Json $Value | ConvertFrom-Json -AsHashtable }

# Execute the real action branch with pure window ports and the real native text protocol.
$driver = [IO.File]::ReadAllText((Join-Path $repository 'tools/data-qualification/product-transfer/ui-driver.ps1'))
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($driver, [ref]$tokens, [ref]$parseErrors)
Check 'PS动作源码解析' ($parseErrors.Count -eq 0)
foreach ($name in @('Get-FilenameValueClass', 'Get-FilenameAutomationIdClass')) {
    $functions = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true))
    Check ('唯一生产函数：' + $name) ($functions.Count -eq 1)
    . ([scriptblock]::Create($functions[0].Extent.Text))
}
$branches = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.SwitchStatementAst] }, $true) | ForEach-Object { $_.Clauses } | Where-Object { $_.Item1.Extent.Text.Contains("'InspectSaveDialog'") })
Check '唯一生产保存动作分支' ($branches.Count -eq 1)
$body = $branches[0].Item2.Extent.Text
$actionCode = [scriptblock]::Create($body.Substring(1, $body.Length - 2))
$native = [IO.File]::ReadAllText((Join-Path $repository 'tools/data-qualification/product-transfer/NativeSaveControl.cs'))
$nativePure = $native.Substring(0, $native.IndexOf('internal sealed class Win32SaveControlPort', [StringComparison]::Ordinal))
$ports = @'
internal sealed class Win32SaveControlPort : IAIbrowseSaveControlPort {
    public static string Text;
    public static int Reads, Writes, Disposals, BadRead;
    public static long Clock;
    public Win32SaveControlPort(uint p,string c,string e,IntPtr m,IntPtr d,IntPtr w,Stopwatch s) {
        if(p!=51 || c!="10001" || m.ToInt64()!=71 || d.ToInt64()!=73 || w.ToInt64()!=79) throw new Exception("端口参数越界");
    }
    public long ElapsedMilliseconds { get { return Clock; } }
    public bool IdentityMatches() { return true; }
    public ulong ReadLength(uint timeout) { if(timeout<1 || timeout>1000) throw new Exception("期限越界"); return 4096; }
    public string ReadText(uint timeout) { Reads++; return Reads==BadRead?Text.ToUpperInvariant():Text; }
    public bool WriteTarget(string value,uint timeout) { Writes++; Text=value; return true; }
    public void Dispose() { Disposals++; }
}
public static class InitialStemPort {
    public static void Reset(string value,int fault,long time) {
        Win32SaveControlPort.Text=value; Win32SaveControlPort.BadRead=fault; Win32SaveControlPort.Clock=time;
        Win32SaveControlPort.Reads=Win32SaveControlPort.Writes=Win32SaveControlPort.Disposals=0;
        InitialStemButtons.InvokePattern.Saves=InitialStemButtons.InvokePattern.Cancels=0;
    }
    public static int Reads { get { return Win32SaveControlPort.Reads; } }
    public static int Writes { get { return Win32SaveControlPort.Writes; } }
    public static int Disposals { get { return Win32SaveControlPort.Disposals; } }
    public static string Text { get { return Win32SaveControlPort.Text; } }
}
namespace InitialStemButtons {
    public sealed class InvokePattern {
        public static int Saves,Cancels;
        public string Id;
        public InvokePattern(string id) { Id=id; }
        public void Invoke() { if(Id=="1") Saves++; else if(Id=="2") Cancels++; else throw new Exception("按钮越界"); }
    }
}
public sealed class AIbrowseNativeSaveButton : IDisposable {
    private readonly int id;
    public AIbrowseNativeSaveButton(object a,object b,object c,object d,object e,object f,int id,object h,object i) { this.id=id; }
    public void Validate() {}
    public object Inspect() { return new object(); }
    public object Act() { if(id==1) InitialStemButtons.InvokePattern.Saves++; else InitialStemButtons.InvokePattern.Cancels++; return new object(); }
    public void Dispose() {}
}
'@
Check '动作替身不含原生声明' (-not (($nativePure + $ports) -match '\[DllImport|extern '))
Add-Type -TypeDefinition ($nativePure + $ports)
function Save-Dialog([IntPtr]$Main) { return [pscustomobject]@{ marker = 'dialog' } }
function Assert-Dialog($Dialog, [IntPtr]$Main) { return [IntPtr]73 }
function Get-NativeFilenameInput($Dialog, $Diagnostic) { return [pscustomobject]@{ Window = [IntPtr]79; Element = [pscustomobject]@{ Current = [pscustomobject]@{ AutomationId = '1001' } } } }
function Assert-NativeFilenameInput($Binding, $Dialog, [IntPtr]$Main, $Diagnostic, $Native) { $Native.Validate() }
function Assert-NativeDialogButton($Binding,$Dialog,$Main,$Id,$Native) { $Native.Validate() }
function Dialog-Button($Dialog, [string]$Id) { return [pscustomobject]@{ Window = [IntPtr](30+[int]$Id); Name = $(if ($Id -ceq '1') { '保存' } else { '取消' }); Pattern = [InitialStemButtons.InvokePattern]::new($Id); Element = [pscustomobject]@{ Current = [pscustomobject]@{ Name = $(if ($Id -ceq '1') { '保存' } else { '取消' }) } } } }
function Run-Action([string]$Initial, [string]$Action, [string]$Target, [int]$Fault = 0, [long]$Time = 0) {
    [InitialStemPort]::Reset($Initial, $Fault, $Time)
    $ProcessId = [uint32]51; $CreatedFileTime = '10001'; $Executable = 'C:\synthetic\AIbrowse.exe'
    $handle = [IntPtr]71; $clock = [Diagnostics.Stopwatch]::StartNew(); $diagnostic = [ordered]@{}
    $accepted = $true
    try { & $actionCode } catch { $accepted = $false }
    return @{ accepted = $accepted; writes = [InitialStemPort]::Writes; reads = [InitialStemPort]::Reads; disposed = [InitialStemPort]::Disposals; saves = [InitialStemButtons.InvokePattern]::Saves; cancels = [InitialStemButtons.InvokePattern]::Cancels; diagnostic = $diagnostic; finalText = [InitialStemPort]::Text }
}
$target = Join-Path $evidence ('abs-' + [Guid]::NewGuid().ToString('N') + '.aibak')
foreach ($initial in @('AIbrowse-backup.aibak', 'AIbrowse-backup')) {
    foreach ($action in @('InspectSaveDialog', 'CancelSave', 'SaveBackup')) {
        $r = Run-Action $initial $action $target
        $save = $action -ceq 'SaveBackup'; $cancel = $action -ceq 'CancelSave'
        $expectedClass = if ($initial -ceq 'AIbrowse-backup') { 'exact-stem' } else { 'exact-default' }
        Check ($initial + '／' + $action) ($r.accepted -and $r.diagnostic.filenameInitialValueClass -ceq $expectedClass -and $r.disposed -eq 1 -and $r.writes -eq [int]$save -and $r.saves -eq [int]$save -and $r.cancels -eq [int]$cancel -and $r.reads -eq $(if ($save) { 4 } else { 1 }) -and (!$save -or $r.finalText -ceq $target))
    }
}
$rejectedNames = @('', ' ', 'aibrowse-backup', 'AIbrowse-Backup', 'AIbrowse-backup.AIBAK', 'AIbrowse-backup.aibak ', 'AIbrowse-backup ', ' AIbrowse-backup', '.\AIbrowse-backup', 'C:\AIbrowse-backup', 'AIbrowse-backup.txt', "AIbrowse-backup`n", "AIbrowse-backup`0", 'AIbrowse-backup.aibak.aibak', 'ＡIbrowse-backup')
foreach ($initial in $rejectedNames) {
    foreach ($action in @('InspectSaveDialog', 'CancelSave', 'SaveBackup')) {
        $r = Run-Action $initial $action $target
        Check ('拒绝初值分类外／' + $rejectedNames.IndexOf($initial) + '／' + $action) (!$r.accepted -and $r.writes -eq 0 -and $r.saves -eq 0 -and $r.cancels -eq 0 -and $r.disposed -eq 1)
    }
}
foreach ($fault in @(2, 3, 4)) {
    $r = Run-Action 'AIbrowse-backup' 'SaveBackup' $target $fault
    Check ('stem完整目标第' + $fault + '次读取不符') (!$r.accepted -and $r.writes -eq 1 -and $r.saves -eq 0 -and $r.disposed -eq 1)
}
foreach ($invalidTarget in @('AIbrowse-backup.aibak', 'C:\synthetic\AIbrowse-backup', 'C:\synthetic\backup.AIBAK', "C:\synthetic\backup`0.aibak")) {
    $r = Run-Action 'AIbrowse-backup' 'SaveBackup' $invalidTarget
    Check ('拒绝非法完整目标／' + $results.Count) (!$r.accepted -and $r.writes -eq 0 -and $r.saves -eq 0 -and $r.disposed -eq 1)
}
$r = Run-Action 'AIbrowse-backup' 'SaveBackup' $target 0 30000
Check 'stem不延长原30秒' (!$r.accepted -and $r.writes -eq 0 -and $r.saves -eq 0 -and $r.disposed -eq 1)

# Compile exact production validators and ReadProduct; all IO ports below are memory only.
$profileSource = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'DisposableProfile.cs'))
$identities = Slice $profileSource '    public sealed class DisposableIdentity' '    public sealed class TamperBinding'
$common = Slice $profileSource '        private static JsonDocument ParseCompletedEvidence' '        private static string ValidateCompletedArchiveElements'
$validators = Slice $profileSource '        private static readonly string[] ProductTransferSources' '        private sealed class CompletedArchiveEvidence'
$reader = Slice $profileSource '            private void ReadProduct(' '            internal CompletedArchiveEvidence('
$header = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using File = InitialStemReview.FakeFile;
using Directory = InitialStemReview.FakeDirectory;
namespace InitialStemReview {
public static class FakeFile { public static bool Exists(string path) { return false; } }
public static class FakeDirectory {
    public static bool Exists(string path) { return false; }
    public static IEnumerable<string> EnumerateFileSystemEntries(string path) { return new[] { Path.Combine(path,"product-backup.aibak") }; }
}
'@
$loaderPorts = @'
public sealed class Reader {
    public readonly Dictionary<string,string> Metadata = new Dictionary<string,string>();
    public readonly Dictionary<string,string> Digests = new Dictionary<string,string>();
    public readonly List<string> ReadKeys = new List<string>();
    public DisposableManifest Manifest;
    public string Journal = @"C:\synthetic-review\journal";
    public string Kind = "completed-tamper";
    public Reader(string manifest) { Manifest=JsonSerializer.Deserialize<DisposableManifest>(manifest); }
    private static string Repository() { return @"C:\synthetic-review\repository"; }
    private void CheckBudget() {}
    private void PinDirectory(string path) {}
    private JsonDocument ReadJson(string path,int maximum) { return ParseCompletedEvidence(Metadata[path],maximum); }
    private string ReadHash(string path,long maximum,string key,out long count,long? expectedLength=null) {
        ReadKeys.Add(key); count=64;
        if(maximum<64 || (expectedLength.HasValue && expectedLength.Value!=64)) throw new Exception("夹具预算不符");
        return Digests.TryGetValue(key,out string value)?value:new string('a',64);
    }
    public void Run(string terminal) { ReadProduct(terminal,Path.Combine("runner-output","product-transfer"),Path.Combine(Journal,"runner-output","product-transfer")); }
'@
$isolatedReader = $header + $identities + $loaderPorts + $common + $validators + $reader + "`n}}"
Check '归档替身不含原生或归档转换入口' (-not ($isolatedReader -match '\[DllImport|extern |ArchiveTransition\(|JobProcess\.(Execute|ConfirmReleased)|System\.IO\.File\.'))
Add-Type -TypeDefinition $isolatedReader

# The synthetic evidence is authored here from the contract, without loading earlier test fixtures.
$hash = 'a' * 64; $runId = '2' * 32
$manifest = @{ Version = 2; RunId = $runId; DeclaredProfile = 'C:\synthetic-review\profile'; ResolvedProfile = 'C:\synthetic-review\profile'; PackageExecutable = 'C:\synthetic-review\package\AIbrowse.exe'; BindingJournal = ''; RootIdentity = @{ FileId128 = '3' * 32; VolumeSerial64 = '4' * 16 } }
$limits = @{ runnerMs = 480000; outerJobMs = 600000; outerExitMs = 30000; uiMs = 30000; jobProcesses = 24; main = 1; guardian = 1; chromium = 16; utilityIncludingChromiumService = 2; toolProcesses = 4 }
$profile = @{ version = 2; runId = $runId; syntheticFileId = '3' * 32; nodeView = @{ declared = @{ dev = '8'; ino = '9' }; resolved = @{ dev = '8'; ino = '9' } } }
$sources = @{}
$sourcePaths = @([regex]::Matches((Slice $validators '        private static readonly string[] ProductTransferSources' '        private static void ProductFact'), '"(tools/[^"\r\n]+)"') | ForEach-Object { $_.Groups[1].Value })
Check '工具来源固定16项并含自绑定' ($sourcePaths.Count -eq 16 -and $sourcePaths -ccontains 'tools/release-profile/DisposableProfile.cs' -and $sourcePaths -ccontains 'tools/data-qualification/product-transfer/NativeSaveControl.cs')
foreach ($path in $sourcePaths) { $sources[$path] = $hash }
$package = @{ packageRoot = 'C:\synthetic-review\package'; executable = 'AIbrowse.exe'; executableSha256 = $hash; asar = 'resources/app.asar'; asarSha256 = $hash; asarHeaderSha256 = $hash; guardianSha256 = $hash; integrityResource = @{ file = 'resources/app.asar'; alg = 'sha256'; value = $hash }; fuseVersion = '1'; files = @(); rendererAssets = @(); externalPackages = @() }
$product = @{ pid = 51; label = 'ProductOriginal'; processCreatedFileTime = '10001'; imagePath = $manifest.PackageExecutable; packageStatus = 15700; packageFullName = ''; probeRootFileId128 = '3' * 32; probeRootVolumeSerial64 = '4' * 16 }
$process = Copy-Value $product; $process.version = 1; $process.runId = $runId
$members = @(); $ids = @('sources', 'research', 'watch', 'conversations'); $schemas = @(1, 1, 5, 1)
for ($i = 0; $i -lt 4; $i++) { $members += @{ id = $ids[$i]; present = $false; schemaVersion = $schemas[$i]; bytes = 0; sha256 = $null } }
$backup = @{ bytes = 64; sha256 = $hash; snapshotId = '55555555-5555-5555-5555-555555555555'; productVersion = '0.1.0'; members = $members }
$job = @{ version = 1; hardTotalLimit = 24; limitFlags = 8200; sampledCounts = @{ main = 0; guardian = 0; chromium = 0; utility = 0; tools = 1 }; total = 1; identities = @(@{ Pid = 61; CreatedFileTime = 10002; Image = 'C:\synthetic-review\node.exe' }) }
$nodes = @()
foreach ($i in 0..3) {
    $nodes += @{ index = $i; parent = $i - 1; relation = $(if ($i -lt 2) { 'ancestor' } elseif ($i -eq 2) { 'host' } else { 'descendant' }); automationIdClass = $(if ($i -eq 2) { 'file-name-control-host' } elseif ($i -eq 3) { 'id-1001' } else { 'empty' }); controlTypeClass = 'pane'; windowClass = $(if ($i -eq 3) { 'edit' } else { 'other' }); sameProcess = $true; enabled = $true; offscreen = $false; valuePattern = $false; readOnly = $null }
}
$dialog = @{ version = 1; action = 'InspectSaveDialog'; ok = $true; phase = 'identity'; elapsedMs = 29; filenameHostStructure = @{ version = 1; status = 'complete'; scannedNodes = 91; hostCount = 1; ancestorCount = 2; descendantCount = 1; nodes = $nodes }; filenameNativeSelection = @{ status = 'uia-bound'; candidates = 1; nativeHandlePresent = $true }; filenameInitialValueClass = 'exact-stem'; dialog = @{ hwnd = 73; owner = 71; processId = 51; filenameIdClass = 'id-1001'; filenameControlType = 'native-edit'; saveName = 'Save'; cancelName = 'Cancel'; mechanism = 'Win32 fixed text / MSAA default action' } }
$saveProof = @{ version = 1; mechanism = 'MSAA CHILDID_SELF'; controlId = 1; nameClass = 'save'; hresult = 0; role = 43; available = $true; visible = $true; defaultActionPresent = $true; nativeIdentityVerified = $true }
$cancelProof = $saveProof.Clone(); $cancelProof.controlId = 2; $cancelProof.nameClass = 'cancel'
$dialog.dialog.saveButton = $saveProof; $dialog.dialog.cancelButton = $cancelProof
$cancel = $dialog | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable; $cancel.action = 'CancelSave'; $cancel.buttonAction = $cancelProof.Clone()
$save = $dialog | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable; $save.action = 'SaveBackup'; $save.buttonAction = $saveProof.Clone()
$nonClaims = @('完整容量', '恢复确认与重启', '独立机器', 'SQLite业务语义', '真实Provider')
$launch = @{ version = 1; scenario = 'small-backup-cancel-save-readback'; ok = $false; limits = $limits; nonClaims = $nonClaims; profile = $profile; toolSources = $sources; package = $package; phase = 'package'; productArguments = @('--force-renderer-accessibility'); environmentOverrides = @(); providerCalls = 0 }
$report = @{ version = 1; scenario = 'small-backup-cancel-save-readback'; ok = $true; limits = $limits; nonClaims = $nonClaims; profile = $profile; toolSources = $sources; package = $package; product = $product; dialogQualification = $dialog; cancelAction = $cancel; saveAction = $save; backup = $backup; finalJobSample = $job; phase = 'exit'; elapsedMs = 111; productExited = $true; productExitCode = 0; pendingOriginals = @(); unconfirmedChildren = 0; requiresOuterTerminal = $true }
$terminal = @{ version = 1; runId = $runId; ok = $true; result = 0; jobReleased = $true; markerValidated = $true; failureType = ''; failureMessage = '' }
$baselineFixture = @{ launch = $launch; report = $report; dialog = $dialog; cancel = $cancel; save = $save; backup = $backup; job = $job; process = $process; terminal = $terminal }
function Run-Reader($Fixture, [string]$BadSource = '') {
    $reader = [InitialStemReview.Reader]::new((Json $manifest))
    $base = 'runner-output\product-transfer\'
    foreach ($pair in @(@('launch', 'launch-contract.json'), @('report', 'report.json'), @('dialog', 'ui-4-InspectSaveDialog.json'), @('cancel', 'ui-6-CancelSave.json'), @('save', 'ui-12-SaveBackup.json'), @('backup', 'backup-readback.json'), @('job', 'job-18.json'))) { $reader.Metadata.Add($base + $pair[1], (Json $Fixture[$pair[0]])) }
    $reader.Metadata.Add('runner-output\process-ProductOriginal-51.json', (Json $Fixture.process))
    if ($BadSource) { $reader.Digests.Add('source/' + $BadSource, ('b' * 64)) }
    $accepted = $true
    try { $reader.Run((Json $Fixture.terminal)) } catch { $accepted = $false }
    return @{ accepted = $accepted; kind = $reader.Kind; keys = $reader.ReadKeys.ToArray() }
}
foreach ($classification in @('exact-default', 'exact-stem', '', 'other', 'empty', 'Exact-stem', 'exact-stem ', ' exact-stem', "exact-stem`n", 'AIbrowse-backup', 'exact-default|exact-stem')) {
    $fixture = Copy-Value $baselineFixture
    $fixture.dialog.filenameInitialValueClass = $classification; $fixture.report.dialogQualification = Copy-Value $fixture.dialog
    $r = Run-Reader $fixture
    $valid = $classification -cin @('exact-default', 'exact-stem')
    Check ('归档初值／' + $classification) ($r.accepted -eq $valid -and (!$valid -or ($r.kind -ceq 'completed-product-transfer-small-backup' -and $r.keys.Count -eq 20)))
}
foreach ($classification in @('exact-default', 'other', $null, 7, @('exact-stem'))) {
    $fixture = Copy-Value $baselineFixture; $fixture.report.dialogQualification.filenameInitialValueClass = $classification
    $r = Run-Reader $fixture
    Check ('拒绝raw与report不一致／' + $results.Count) (!$r.accepted -and $r.keys.Count -eq 0)
}
foreach ($classification in @($null, 7, $true, @('exact-stem'), @{ value = 'exact-stem' })) {
    $fixture = Copy-Value $baselineFixture; $fixture.dialog.filenameInitialValueClass = $classification
    $fixture.report.dialogQualification = Copy-Value $fixture.dialog
    $r = Run-Reader $fixture
    Check ('拒绝同步伪造非字符串分类／' + $results.Count) (!$r.accepted -and $r.keys.Count -eq 0)
}
$mutations = @(
    @{ name = 'host越过祖先'; change = { param($d) $d.filenameHostStructure.nodes[2].parent = 0 } },
    @{ name = '后代脱离host'; change = { param($d) $d.filenameHostStructure.nodes[3].parent = 1 } },
    @{ name = 'host异进程'; change = { param($d) $d.filenameHostStructure.nodes[2].sameProcess = $false } },
    @{ name = '输入不可见'; change = { param($d) $d.filenameHostStructure.nodes[3].offscreen = $true } },
    @{ name = '输入非Edit'; change = { param($d) $d.filenameHostStructure.nodes[3].windowClass = 'other' } },
    @{ name = 'host重复计数'; change = { param($d) $d.filenameHostStructure.hostCount = 2 } },
    @{ name = '候选重复计数'; change = { param($d) $d.filenameNativeSelection.candidates = 2 } },
    @{ name = '空HWND'; change = { param($d) $d.dialog.hwnd = 0 } },
    @{ name = 'owner同HWND'; change = { param($d) $d.dialog.owner = 73 } },
    @{ name = 'dialog异PID'; change = { param($d) $d.dialog.processId = 52 } },
    @{ name = '原生按钮变名'; change = { param($d) $d.dialog.saveName = 'Run' } },
    @{ name = '原30秒耗尽'; change = { param($d) $d.elapsedMs = 30000 } },
    @{ name = '分类未知字段'; change = { param($d) $d.privateText = 'synthetic-canary' } }
)
foreach ($mutation in $mutations) {
    $fixture = Copy-Value $baselineFixture
    & $mutation.change $fixture.dialog
    $fixture.report.dialogQualification = Copy-Value $fixture.dialog
    $r = Run-Reader $fixture
    Check ('stem仍拒绝结构反例／' + $mutation.name) (!$r.accepted -and $r.keys.Count -eq 0)
}
foreach ($path in $sourcePaths) {
    $r = Run-Reader (Copy-Value $baselineFixture) $path
    Check ('stem逐一拒绝来源摘要变化／' + $path) (!$r.accepted -and $r.kind -ceq 'completed-tamper' -and $r.keys -ccontains ('source/' + $path))
}
$fixture = Copy-Value $baselineFixture
$fixture.terminal.jobReleased = $false
$r = Run-Reader $fixture
Check 'stem仍拒绝Job未释放' (!$r.accepted -and $r.keys.Count -eq 0)
Write-Output ('初值历史独审反例的作者回归通过：' + $results.Count + '项；无原生调用、UI、Job或归档转换')
