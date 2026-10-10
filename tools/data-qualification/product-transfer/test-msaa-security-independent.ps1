[CmdletBinding()]
param([string]$Evidence = (Join-Path $PSScriptRoot '../../../log/stage7-e2/native-save-msaa-independent-review-001'))
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
[void][IO.Directory]::CreateDirectory($Evidence)
$output = Join-Path $Evidence 'independent-results.json'
if ([IO.File]::Exists($output)) { throw '证据输出已存在，须指定新的Evidence目录保留旧轮' }
$rows = [Collections.Generic.List[object]]::new()
function Record([string]$Name, [bool]$Pass, $Observed) {
    $rows.Add([ordered]@{ name = $Name; pass = $Pass; observed = $Observed })
}
$buttonPath = Join-Path $PSScriptRoot 'NativeSaveButton.cs'
$source = [IO.File]::ReadAllText($buttonPath)
# Compile the unchanged candidate. The fixture supplies an in-memory accessibility object;
# no native process, HWND, COM acquisition, UI action or archive operation is performed.
$fixture = @'
public static class IndependentMsaaReview {
    public static object State, Role, Name, Default;
    public static int Actions, Reads;
    private static readonly Type AccessibleType = BuildAccessibleType();
    public static object Get(string key, int child) {
        if (child != 0) throw new Exception("CHILDID_SELF不符");
        Reads++;
        if (key == "accState") return State;
        if (key == "accRole") return Role;
        if (key == "accName") return Name;
        if (key == "accDefaultAction") return Default;
        throw new Exception("属性越界");
    }
    public static void Action(int child) {
        if (child != 0) throw new Exception("CHILDID_SELF不符");
        Actions++;
    }
    private static Type BuildAccessibleType() {
        var a = System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("IndependentMsaa"), System.Reflection.Emit.AssemblyBuilderAccess.Run);
        var t = a.DefineDynamicModule("module").DefineType("MemoryAccessible", TypeAttributes.Public);
        foreach (string key in new [] { "accName", "accRole", "accState", "accDefaultAction" }) {
            var p = t.DefineProperty(key, PropertyAttributes.None, typeof(object), new [] { typeof(int) });
            var m = t.DefineMethod("get_" + key, MethodAttributes.Public | MethodAttributes.SpecialName, typeof(object), new [] { typeof(int) });
            var il = m.GetILGenerator();
            il.Emit(System.Reflection.Emit.OpCodes.Ldstr, key);
            il.Emit(System.Reflection.Emit.OpCodes.Ldarg_1);
            il.Emit(System.Reflection.Emit.OpCodes.Call, typeof(IndependentMsaaReview).GetMethod("Get"));
            il.Emit(System.Reflection.Emit.OpCodes.Ret);
            p.SetGetMethod(m);
        }
        var action = t.DefineMethod("accDoDefaultAction", MethodAttributes.Public, typeof(void), new [] { typeof(int) });
        var body = action.GetILGenerator();
        body.Emit(System.Reflection.Emit.OpCodes.Ldarg_1);
        body.Emit(System.Reflection.Emit.OpCodes.Call, typeof(IndependentMsaaReview).GetMethod("Action"));
        body.Emit(System.Reflection.Emit.OpCodes.Ret);
        return t.CreateType();
    }
    private sealed class Port : IAIbrowseSaveButtonPort {
        internal int Disposals, Opens;
        public long ElapsedMilliseconds { get { return 0; } }
        public bool IdentityMatches() { return true; }
        public IAIbrowseButtonAccessible OpenAccessible() {
            Opens++;
            var adapter = (SaveButtonAccessible)System.Runtime.CompilerServices.RuntimeHelpers.GetUninitializedObject(typeof(SaveButtonAccessible));
            typeof(SaveButtonAccessible).GetField("accessible", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(adapter, Activator.CreateInstance(AccessibleType));
            return adapter;
        }
        public void Dispose() { Disposals++; }
    }
    public static object Run(string fault) {
        State = 0; Role = 43; Name = "Save"; Default = "Press";
        Actions = Reads = 0;
        switch (fault) {
            case "state-null": State = null; break;
            case "state-bool": State = false; break;
            case "state-string": State = "0"; break;
            case "state-double": State = 0.25d; break;
            case "state-short": State = (short)0; break;
            case "role-string": Role = "43"; break;
            case "role-double": Role = 43.25d; break;
            case "action-integer": Default = 1; break;
            case "state-disabled": State = 1; break;
            case "state-invisible": State = 0x8000; break;
            case "state-offscreen": State = 0x10000; break;
            case "name-null": Name = null; break;
            case "action-null": Default = null; break;
            case "action-empty": Default = ""; break;
            case "role-other": Role = 42; break;
        }
        bool accepted = false, retryRejected = false;
        var port = new Port();
        using (var button = new AIbrowseNativeSaveButton(port, 1, "Save")) {
            try { button.Act(); accepted = true; } catch { }
            try { button.Act(); } catch { retryRejected = true; }
        }
        return new { fault, accepted, actions = Actions, reads = Reads, port.Opens, port.Disposals, retryRejected };
    }
}
public static class IndependentLifetimeReview {
    private sealed class Session : IAIbrowseButtonAccessible {
        private readonly Port port;
        internal Session(Port port) { this.port = port; }
        public SaveButtonMetadata Read() {
            port.Reads++;
            if (port.Fault == "second-read-null" && port.Reads == 2) return null;
            if (port.Fault == "second-read-name" && port.Reads == 2) return new SaveButtonMetadata { HResult=0, Role=43, Name="Cancel", DefaultAction="Press" };
            if (port.Fault == "read-expired") port.Time = 30000;
            return new SaveButtonMetadata { HResult=0, Role=43, State=0, Name="Save", DefaultAction="Press" };
        }
        public void Act() {
            port.Actions++;
            if (port.Fault == "action-expired") port.Time = 30000;
            if (port.Fault == "action-error") throw new InvalidOperationException();
        }
        public void Dispose() { port.Releases++; }
    }
    private sealed class Port : IAIbrowseSaveButtonPort {
        internal string Fault;
        internal long Time;
        internal int FailAt, Identities, Actions, Reads, Opens, Releases, Disposals;
        public long ElapsedMilliseconds { get { return Time; } }
        public bool IdentityMatches() { Identities++; return Identities != FailAt; }
        public IAIbrowseButtonAccessible OpenAccessible() { Opens++; return new Session(this); }
        public void Dispose() { Disposals++; }
    }
    public static object Run(string fault, int failAt) {
        var port = new Port { Fault=fault, FailAt=failAt };
        bool accepted=false, retryRejected=false;
        AIbrowseNativeSaveButton button=null;
        try {
            button=new AIbrowseNativeSaveButton(port, 1, "Save");
            if (fault=="disposed") button.Dispose();
            if (fault=="negative-clock") port.Time=-1;
            try { button.Act(); accepted=true; } catch { }
            try { button.Act(); } catch { retryRejected=true; }
        } catch { }
        finally { if(button!=null) { button.Dispose(); button.Dispose(); } }
        return new { fault, failAt, accepted, retryRejected, port.Identities, port.Actions, port.Reads, port.Opens, port.Releases, port.Disposals };
    }
}
public static class IndependentUiaClock { public static long Time; }
public sealed class IndependentUiaInfo {
    public string Id="1", Text="Save", Class="Button", Fault="";
    public int Pid=990, Handle=71;
    public bool Enabled=true, Offscreen=false;
    public void Check(string property) {
        if (Fault==property) throw new InvalidOperationException("固定属性读取失败");
        if (Fault==property+"-late") IndependentUiaClock.Time=30000;
    }
    public string AutomationId { get { Check("id"); return Id; } }
    public string Name { get { Check("name"); return Text; } }
    public string ClassName { get { Check("class"); return Class; } }
    public int ProcessId { get { Check("pid"); return Pid; } }
    public int NativeWindowHandle { get { Check("handle"); return Handle; } }
    public bool IsEnabled { get { Check("enabled"); return Enabled; } }
    public bool IsOffscreen { get { Check("offscreen"); return Offscreen; } }
}
public sealed class IndependentUiaNode {
    public readonly IndependentUiaInfo Info=new IndependentUiaInfo();
    public IndependentUiaInfo Current { get { Info.Check("current"); return Info; } }
}
'@
Add-Type -TypeDefinition ($source + $fixture)
$adapterCases = @('valid','state-null','state-bool','state-string','state-double','state-short','role-string','role-double','action-integer','state-disabled','state-invisible','state-offscreen','name-null','action-null','action-empty','role-other')
foreach ($case in $adapterCases) {
    $result = [IndependentMsaaReview]::Run($case)
    $expected = $case -ceq 'valid'
    Record ('MSAA属性闭合类型：' + $case) ($result.accepted -eq $expected -and $result.actions -eq [int]$expected -and $result.retryRejected -and $result.Disposals -eq 1) $result
}
$normal = [IndependentLifetimeReview]::Run('normal',0)
Record '正常动作双读、单次及释放' ($normal.accepted -and $normal.Reads -eq 2 -and $normal.Actions -eq 1 -and $normal.retryRejected -and $normal.Opens -eq $normal.Releases -and $normal.Disposals -eq 1) $normal
for ($i=1; $i -le $normal.Identities; $i++) {
    $result = [IndependentLifetimeReview]::Run('identity-drift',$i)
    Record ('第' + $i + '次身份复核拒绝漂移') (-not $result.accepted -and $result.Actions -eq 0 -and $result.Opens -eq $result.Releases -and $result.Disposals -eq 1) $result
}
foreach ($case in @('second-read-null','second-read-name','read-expired','action-expired','action-error','disposed','negative-clock')) {
    $result = [IndependentLifetimeReview]::Run($case,0)
    $actions = if ($case -in @('action-expired','action-error')) { 1 } else { 0 }
    Record ('动作生命周期：' + $case) (-not $result.accepted -and $result.Actions -eq $actions -and $result.retryRejected -and $result.Opens -eq $result.Releases -and $result.Disposals -eq 1) $result
}

# Execute the actual selection function with an in-memory, no-Invoke/no-ControlType tree.
$tokens=$null; $errors=$null
$driverPath=Join-Path $PSScriptRoot 'ui-driver.ps1'
$ast=[Management.Automation.Language.Parser]::ParseFile($driverPath,[ref]$tokens,[ref]$errors)
if ($errors.Count -ne 0) { throw '候选脚本解析失败' }
$selector=@($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Dialog-Button' },$true))
if ($selector.Count -ne 1) { throw '按钮选择函数不唯一' }
. ([scriptblock]::Create($selector[0].Extent.Text))
function Check-Time { if ([IndependentUiaClock]::Time -ge 30000) { throw '期限已到' } }
function Descendants($Root) { return $script:reviewNodes }
$ProcessId=990
foreach ($case in @('valid','cancel','duplicate','id-leading-zero','id-whitespace','id-other','name-case','name-whitespace','class-case','foreign-pid','no-hwnd','disabled','offscreen','limit-511','limit-512','current','id','class','handle','name','pid','enabled','offscreen-property','name-late')) {
    [IndependentUiaClock]::Time=0
    $node=[IndependentUiaNode]::new()
    $script:reviewNodes=@($node)
    $id='1'
    switch ($case) {
        cancel { $id='2'; $node.Info.Id='2'; $node.Info.Text='Cancel' }
        duplicate { $script:reviewNodes+= [IndependentUiaNode]::new() }
        id-leading-zero { $node.Info.Id='01' }
        id-whitespace { $node.Info.Id='1 ' }
        id-other { $node.Info.Id='2' }
        name-case { $node.Info.Text='save' }
        name-whitespace { $node.Info.Text='Save ' }
        class-case { $node.Info.Class='button' }
        foreign-pid { $node.Info.Pid=991 }
        no-hwnd { $node.Info.Handle=0 }
        disabled { $node.Info.Enabled=$false }
        offscreen { $node.Info.Offscreen=$true }
        { $_ -in @('limit-511','limit-512') } {
            $filler=[IndependentUiaNode]::new(); $filler.Info.Id='unknown'
            $count=if($case -ceq 'limit-511'){510}else{511}
            $script:reviewNodes+=@($filler)*$count
        }
        offscreen-property { $node.Info.Fault='offscreen' }
        { $_ -in @('current','id','class','handle','name','pid','enabled','name-late') } { $node.Info.Fault=$case }
    }
    $accepted=$false
    try { $chosen=Dialog-Button $null $id; $accepted=$chosen.Window -eq [IntPtr]71 } catch { }
    $expected=$case -in @('valid','cancel','limit-511')
    Record ('UIA闭合选择：' + $case) ($accepted -eq $expected) @{accepted=$accepted}
}

# Invoke only the pure archive proof validator through reflection.
Add-Type -Path (Join-Path $repository 'tools/release-profile/DisposableProfile.cs'), (Join-Path $repository 'tools/release-profile/ProfileIsolation.cs'), (Join-Path $repository 'tools/release-profile/JobProcess.cs')
$validator = [AIbrowse.ReleaseProfile.DisposableProfile].GetMethod('ProductButton', [Reflection.BindingFlags]'Static,NonPublic')
function Proof([int]$Id) {
    return [ordered]@{ version=1; mechanism='MSAA CHILDID_SELF'; controlId=$Id; nameClass=$(if ($Id -eq 1) {'save'} else {'cancel'}); hresult=0; role=43; available=$true; visible=$true; defaultActionPresent=$true; nativeIdentityVerified=$true }
}
function Accept-Proof([string]$Json, [int]$Id) {
    $document = [Text.Json.JsonDocument]::Parse($Json)
    try { [void]$validator.Invoke($null, [object[]]@($document.RootElement,$Id)); return $true } catch { return $false } finally { $document.Dispose() }
}
foreach ($id in @(1,2)) {
    $valid = Proof $id
    Record ('归档正常按钮' + $id) (Accept-Proof ($valid | ConvertTo-Json -Compress) $id) $null
    foreach ($field in @($valid.Keys)) {
        $missing = Proof $id; $missing.Remove($field)
        Record ('归档缺字段：' + $id + '/' + $field) (-not (Accept-Proof ($missing | ConvertTo-Json -Compress) $id)) $null
        $wrong = Proof $id; $wrong[$field] = $null
        Record ('归档null字段：' + $id + '/' + $field) (-not (Accept-Proof ($wrong | ConvertTo-Json -Compress) $id)) $null
    }
    foreach ($field in @('available','visible','defaultActionPresent','nativeIdentityVerified')) {
        $wrong = Proof $id; $wrong[$field]=$false
        Record ('归档否定事实：' + $id + '/' + $field) (-not (Accept-Proof ($wrong | ConvertTo-Json -Compress) $id)) $null
    }
    $extra=Proof $id; $extra['rawName']='PRIVATE_CANARY'
    Record ('归档未知字段：' + $id) (-not (Accept-Proof ($extra | ConvertTo-Json -Compress) $id)) $null
    $swapped=Proof (3-$id)
    Record ('归档保存取消互换：' + $id) (-not (Accept-Proof ($swapped | ConvertTo-Json -Compress) $id)) $null
    $json=$valid | ConvertTo-Json -Compress
    $duplicate=$json.Substring(0,$json.Length-1)+',"role":43}'
    Record ('归档重复字段：' + $id) (-not (Accept-Proof $duplicate $id)) $null
}
$result = [ordered]@{ baseline=(git -C $repository rev-parse HEAD); sourceSha256=(Get-FileHash -LiteralPath $buttonPath -Algorithm SHA256).Hash; actualUi=$false; actualJob=$false; actualArchive=$false; nativeAcquisition=$false; checks=$rows.Count; failed=@($rows | Where-Object { -not $_.pass }).Count; rows=$rows.ToArray() }
[IO.File]::WriteAllText($output, ($result | ConvertTo-Json -Depth 9), [Text.UTF8Encoding]::new($false))
@{ checks=$result.checks; failed=$result.failed; evidence=$output; actualUi=$false; actualJob=$false; actualArchive=$false } | ConvertTo-Json -Compress
if ($result.failed -ne 0) { throw '独立安全反例发现未闭合输入，结果已保留' }
