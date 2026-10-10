// Author-maintained MSAA port adaptation; this run is regression, not independent review.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

// Independent review: preserve the production C# bodies and replace only the native declarations.
// The guard rejects every remaining P/Invoke, so these cases cannot touch a real window or process.
const path = resolve('tools/data-qualification/product-transfer/NativeSaveControl.cs');
const source = readFileSync(path, 'utf8');
const argumentsByMethod: Record<string, string> = {
  GetCurrentProcessId: '',
  GetCurrentThreadId: '',
  OpenProcess: 'access, inherit, id',
  GetProcessId: 'process',
  WaitForSingleObject: 'process, milliseconds',
  GetProcessTimes: 'process, out creation, out exit, out kernel, out user',
  QueryFullProcessImageNameW: 'process, flags, path, ref size',
  IsWindow: 'window',
  IsWindowEnabled: 'window',
  IsWindowVisible: 'window',
  GetWindowThreadProcessId: 'window, out id',
  GetWindow: 'window, command',
  GetClassNameW: 'window, name, maximum',
  GetDlgCtrlID: 'window',
  GetAncestor: 'window, flags',
  GetWindowLongPtrW: 'window, index',
  SendMessageTimeoutW: 'window, message, wParam, lParam, flags, timeout, out result',
  SendMessageTimeoutTextW: 'window, message, wParam, value, flags, timeout, out result',
  SendMessageTimeoutSetW: 'window, message, wParam, value, flags, timeout, out result',
};
const methods = new Set<string>();
const isolated = source.replace(
  /\[DllImport\([^\n]+\)\]\r?\n\s*private static extern (\w+) (\w+)\(([^;]+)\);|\[DllImport\([^\n]+\)\]\r?\n\s*private static extern (\w+) (\w+)\(\);/g,
  (
    _match: string,
    type: string,
    name: string,
    parameters: string,
    emptyType: string,
    emptyName: string,
  ) => {
    const method = name ?? emptyName;
    if (!Object.hasOwn(argumentsByMethod, method) || methods.has(method))
      throw new Error('独审拒绝未限定或重复原生声明');
    methods.add(method);
    return `private static ${type ?? emptyType} ${method}(${parameters ?? ''}) { return ReviewApi.${method}(${argumentsByMethod[method]}); }`;
  },
);
if (methods.size !== 19 || isolated.includes('DllImport') || isolated.includes('extern '))
  throw new Error('独审原生隔离不完整');

const fixture = String.raw`
public static class ReviewApi {
  public static string Mode, Text;
  public static int ChangeAfter, Messages, Writes;
  public static SafeProcessHandle Handle;
  public static readonly System.Collections.Generic.List<uint> Trace = new System.Collections.Generic.List<uint>();
  private static bool Changed { get { return ChangeAfter < 0 || Messages >= ChangeAfter; } }
  private static bool Fault(string key) { return Mode == key && Changed; }
  private static void Require(bool ok) { if(!ok) throw new Exception("独审假端口参数违反固定封套"); }
  private static void CheckHandle(SafeProcessHandle p) { Require(object.ReferenceEquals(p,Handle) && !p.IsClosed); }
  public static uint GetCurrentProcessId() { return 17; }
  public static uint GetCurrentThreadId() { return 19; }
  public static SafeProcessHandle OpenProcess(uint access,bool inherit,uint id) {
    Require(access==0x101000 && !inherit && id==41);
    Handle=new SafeProcessHandle(new IntPtr(Fault("open-denied")?0:123),false);return Handle;
  }
  public static uint GetProcessId(SafeProcessHandle p) { CheckHandle(p);return Fault("held-pid")?0u:41u; }
  public static uint WaitForSingleObject(SafeProcessHandle p,uint ms) {
    CheckHandle(p);Require(ms==0);return Fault("wait-failed")?0xffffffffu:Fault("exit")?0u:258u;
  }
  public static bool GetProcessTimes(SafeProcessHandle p,out long c,out long e,out long k,out long u) {
    CheckHandle(p);c=Fault("creation")?1002:1001;e=k=u=0;return !Fault("times-failed");
  }
  public static bool QueryFullProcessImageNameW(SafeProcessHandle p,uint flags,StringBuilder value,ref uint size) {
    CheckHandle(p);Require(flags==0 && size==32768);value.Append(Fault("image")?@"C:\private-review-canary\other.exe":@"C:\review-product\AIbrowse.exe");
    return !Fault("image-failed");
  }
  public static bool IsWindow(IntPtr w) { return !(Fault("lost-edit") && w.ToInt64()==303); }
  public static bool IsWindowEnabled(IntPtr w) { Require(w.ToInt64()==303);return !Fault("disabled"); }
  public static bool IsWindowVisible(IntPtr w) { Require(w.ToInt64()==303);return !Fault("hidden"); }
  public static uint GetWindowThreadProcessId(IntPtr w,out uint id) {
    id=(Fault("dialog-pid") && w.ToInt64()==202)||(Fault("edit-pid") && w.ToInt64()==303)?99u:41u;
    return Fault("thread-zero")?0u:Fault("same-thread")?19u:29u;
  }
  public static IntPtr GetWindow(IntPtr w,uint command) { Require(w.ToInt64()==202 && command==4);return new IntPtr(Fault("owner")?102:101); }
  public static int GetClassNameW(IntPtr w,StringBuilder value,int maximum) {
    Require(maximum==256);string name=w.ToInt64()==202 ? (Fault("dialog-class")?"Other":"#32770") : (Fault("edit-class")?"Other":"Edit");
    value.Append(name);return Fault("class-failed")?0:Fault("class-truncated")?255:name.Length;
  }
  public static int GetDlgCtrlID(IntPtr w) { Require(w.ToInt64()==303);return Fault("control-id")?0:1001; }
  public static IntPtr GetAncestor(IntPtr w,uint flags) { Require(w.ToInt64()==303 && flags==2);return new IntPtr(Fault("root")?101:202); }
  public static IntPtr GetWindowLongPtrW(IntPtr w,int index) {
    Require(w.ToInt64()==303 && index==-16);return new IntPtr(Fault("style-failed")?0:Fault("not-child")?0x10000000:0x40000000L|(Fault("readonly")?0x800:0));
  }
  private static void Message(IntPtr w,uint message,UIntPtr wp,uint flags,uint timeout) {
    Require(w.ToInt64()==303 && flags==0x23 && timeout>0 && timeout<=1000);
    Require(message==0xd ? wp.ToUInt64()==4097 : wp==UIntPtr.Zero);
    Require(message==0xc || message==0xd || message==0xe);Messages++;Trace.Add(message);
  }
  public static IntPtr SendMessageTimeoutW(IntPtr w,uint m,UIntPtr wp,IntPtr lp,uint flags,uint timeout,out UIntPtr result) {
    Require(m==0xe && lp==IntPtr.Zero);Message(w,m,wp,flags,timeout);
    ulong length=(ulong)Text.Length;
    if(Mode=="length-negative")length=ulong.MaxValue;
    if(Mode=="overestimate")length+=4;
    if(Mode=="last-length-change" && Messages==3)length++;
    result=new UIntPtr(length);return Fault("message-timeout")?IntPtr.Zero:new IntPtr(1);
  }
  public static IntPtr SendMessageTimeoutTextW(IntPtr w,uint m,UIntPtr wp,StringBuilder value,uint flags,uint timeout,out UIntPtr result) {
    Require(m==0xd && value.Capacity==4097);Message(w,m,wp,flags,timeout);
    value.Append(Text);result=new UIntPtr((ulong)Text.Length+(Mode=="receipt-count"?1UL:0UL));
    return Fault("message-timeout")?IntPtr.Zero:new IntPtr(1);
  }
  public static IntPtr SendMessageTimeoutSetW(IntPtr w,uint m,UIntPtr wp,string value,uint flags,uint timeout,out UIntPtr result) {
    Require(m==0xc);Message(w,m,wp,flags,timeout);Writes++;
    Text=Mode=="write-readback"?@"C:\private-review-canary\secret.aibak":value;
    result=new UIntPtr(Mode=="set-refused"?0u:1u);return Fault("message-timeout")?IntPtr.Zero:new IntPtr(1);
  }
  public static object Run(string mode,int at,bool write) {
    Mode=mode;ChangeAfter=at;Messages=Writes=0;Handle=null;Trace.Clear();
    Text=mode=="maximum"?new string('a',4096):mode=="oversize"?new string('a',4097):mode=="embedded-null"?"a\0b":mode=="unicode"?"文件名😀.aibak":"AIbrowse-backup.aibak";
    bool accepted=false;string failure=null;
    var main=new IntPtr(101);var dialog=new IntPtr(202);var edit=new IntPtr(303);
    if(mode=="same-hwnd")edit=dialog;
    if(mode=="negative-hwnd")edit=new IntPtr(-1);
    if(mode=="broadcast-hwnd")edit=new IntPtr(0xffff);
    try {
      using(var native=new AIbrowseNativeSaveControl(41,"1001",@"C:\review-product\AIbrowse.exe",main,dialog,edit,Stopwatch.StartNew())) {
        if(write)native.WriteTarget(@"C:\aibrowse-independent-synthetic-filename\candidate.aibak");
        else native.ReadText();
        accepted=true;
      }
    } catch(Exception e) { failure=e.Message; }
    return new { mode, at, write, accepted, failure, messages=Messages, writes=Writes, trace=Trace.ToArray(), closed=Handle==null||Handle.IsClosed };
  }
}
internal sealed class ReviewDeadline : IAIbrowseSaveControlPort {
  public long Now; public string Mode; public int Sent,Disposed;
  public readonly System.Collections.Generic.List<uint> Limits=new System.Collections.Generic.List<uint>();
  public long ElapsedMilliseconds { get { return Now; } }
  public bool IdentityMatches() { if(Mode=="expires-in-identity")Now=30000;return true; }
  private void Record(uint timeout) { Sent++;Limits.Add(timeout);if(Mode=="expires-after-send")Now=30000;else if(Mode=="clipped")Now++; }
  public ulong ReadLength(uint timeout) { Record(timeout);return 1; }
  public string ReadText(uint timeout) { Record(timeout);return "x"; }
  public bool WriteTarget(string value,uint timeout) { Record(timeout);return true; }
  public void Dispose() { Disposed++; }
  public static object Run(string mode) {
    var port=new ReviewDeadline { Mode=mode,Now=mode=="clipped"?29997:mode=="expired"?30000:mode=="negative-clock"?-1:0 };
    bool accepted=false;
    try { using(var native=new AIbrowseNativeSaveControl(port)){native.ReadText();accepted=true;native.Dispose();} }catch(InvalidOperationException){}
    return new { mode,accepted,sent=port.Sent,disposed=port.Disposed,limits=port.Limits.ToArray() };
  }
}
public static class ReviewDeadlines { public static object Run(string mode) { return ReviewDeadline.Run(mode); } }
`;

const identityFaults = [
  'wait-failed',
  'exit',
  'held-pid',
  'creation',
  'times-failed',
  'image',
  'image-failed',
  'dialog-pid',
  'edit-pid',
  'thread-zero',
  'same-thread',
  'lost-edit',
  'disabled',
  'hidden',
  'owner',
  'dialog-class',
  'edit-class',
  'class-failed',
  'class-truncated',
  'control-id',
  'root',
  'style-failed',
  'not-child',
  'readonly',
];
const initialFaults = ['open-denied', 'same-hwnd', 'negative-hwnd', 'broadcast-hwnd'];
const normalModes = ['normal', 'unicode', 'maximum', 'overestimate'];
const textFaults = [
  'oversize',
  'length-negative',
  'last-length-change',
  'receipt-count',
  'embedded-null',
];
const cases = [
  ...normalModes.map((mode) => ({ mode, at: -1, write: false })),
  ...[...initialFaults, ...identityFaults, ...textFaults].map((mode) => ({
    mode,
    at: -1,
    write: false,
  })),
  ...identityFaults.flatMap((mode) => [1, 2, 3].map((at) => ({ mode, at, write: false }))),
  ...identityFaults.map((mode) => ({ mode, at: 1, write: true })),
  ...[1, 2, 3].map((at) => ({ mode: 'message-timeout', at, write: false })),
  ...['normal', 'message-timeout', 'set-refused', 'write-readback'].map((mode) => ({
    mode,
    at: 1,
    write: true,
  })),
];
interface NativeResult {
  mode: string;
  at: number;
  write: boolean;
  accepted: boolean;
  failure: string | null;
  messages: number;
  writes: number;
  trace: number[];
  closed: boolean;
}
interface DeadlineResult {
  mode: string;
  accepted: boolean;
  sent: number;
  disposed: number;
  limits: number[];
}
interface ReviewResults {
  native: NativeResult[];
  deadlines: DeadlineResult[];
  raw: string;
}
let cache: ReviewResults | undefined;
function results(): ReviewResults {
  if (cache) return cache;
  const child = spawnSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      String.raw`
    $ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
    Add-Type -TypeDefinition $env:AIBROWSE_REVIEW_CSHARP;
    $rows=@(foreach($item in (ConvertFrom-Json $env:AIBROWSE_REVIEW_CASES)){[ReviewApi]::Run($item.mode,$item.at,$item.write)});
    $deadlines=@(foreach($mode in @('normal','clipped','expired','negative-clock','expires-in-identity','expires-after-send')){[ReviewDeadlines]::Run($mode)});
    [ordered]@{native=$rows;deadlines=$deadlines}|ConvertTo-Json -Depth 5 -Compress;
  `,
    ],
    {
      env: {
        ...process.env,
        AIBROWSE_REVIEW_CSHARP: isolated + fixture,
        AIBROWSE_REVIEW_CASES: JSON.stringify(cases),
      },
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  cache = {
    ...(JSON.parse(child.stdout) as Omit<ReviewResults, 'raw'>),
    raw: child.stdout,
  };
  return cache;
}

it.each(cases)('独立原生反例 $mode / 消息位置 $at / 写入 $write', ({ mode, at, write }) => {
  const result = results().native.find(
    (row) => row.mode === mode && row.at === at && row.write === write,
  )!;
  expect(result.accepted, result.failure ?? undefined).toBe(normalModes.includes(mode));
  expect(result.closed).toBe(true);
  expect(result.writes).toBe(write ? 1 : 0);
  if (identityFaults.includes(mode)) expect(result.messages).toBe(Math.max(0, at));
  if (initialFaults.includes(mode)) expect(result.messages).toBe(0);
  if (mode === 'message-timeout') expect(result.messages).toBe(at);
  if (mode === 'normal' && write) expect(result.trace).toEqual([0xc, 0xe, 0xd, 0xe]);
  expect(results().raw).not.toContain('private-review-canary');
});

it('独立单调期限反例在身份检查或调用间耗尽原30秒时停止，不续租', () => {
  for (const row of results().deadlines) {
    expect(row.accepted).toBe(row.mode === 'normal');
    expect(row.disposed).toBe(1);
    if (row.mode === 'clipped') expect(row.limits).toEqual([3, 2, 1]);
    if (['expired', 'negative-clock', 'expires-in-identity'].includes(row.mode))
      expect(row.sent).toBe(0);
    if (row.mode === 'expires-after-send') expect(row.sent).toBe(1);
  }
});

it('真实生产声明仅编译和反射：19个固定API及三个Unicode文本消息参数匹配', () => {
  const child = spawnSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      String.raw`
    $ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
    $types=Add-Type -Path $env:AIBROWSE_REVIEW_SOURCE -PassThru;
    $port=@($types|Where-Object Name -CEQ 'Win32SaveControlPort');
    if($port.Count -ne 1){throw '原生类型不唯一'};
    $rows=@(foreach($method in $port[0].GetMethods([Reflection.BindingFlags]'NonPublic,Static')){
      $attribute=[Reflection.CustomAttributeExtensions]::GetCustomAttribute($method,[Runtime.InteropServices.DllImportAttribute]);
      if($null -eq $attribute){continue};
      [ordered]@{name=$method.Name;dll=$attribute.Value;entry=$attribute.EntryPoint;charset=$attribute.CharSet.ToString();exact=$attribute.ExactSpelling;result=$method.ReturnType.FullName;parameters=@($method.GetParameters()|ForEach-Object {$_.ParameterType.FullName})}
    });$rows|ConvertTo-Json -Depth 5 -Compress;
  `,
    ],
    {
      env: { ...process.env, AIBROWSE_REVIEW_SOURCE: path },
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  const rows = JSON.parse(child.stdout) as Array<{
    name: string;
    dll: string;
    entry: string;
    charset: string;
    exact: boolean;
    result: string;
    parameters: string[];
  }>;
  expect(rows.map((row) => row.name).sort()).toEqual(Object.keys(argumentsByMethod).sort());
  for (const [name, fourth] of Object.entries({
    SendMessageTimeoutW: 'System.IntPtr',
    SendMessageTimeoutTextW: 'System.Text.StringBuilder',
    SendMessageTimeoutSetW: 'System.String',
  })) {
    expect(rows.find((row) => row.name === name)).toEqual({
      name,
      dll: 'user32.dll',
      entry: 'SendMessageTimeoutW',
      charset: 'Unicode',
      exact: true,
      result: 'System.IntPtr',
      parameters: [
        'System.IntPtr',
        'System.UInt32',
        'System.UIntPtr',
        fourth,
        'System.UInt32',
        'System.UInt32',
        'System.UIntPtr&',
      ],
    });
  }
});

it('独立执行真实动作分支：同字段新UIA元素、末次HWND变化及写超时均禁止Invoke', () => {
  const child = spawnSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      String.raw`
    $ErrorActionPreference='Stop';Set-StrictMode -Version Latest;
    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
    Add-Type -TypeDefinition @'
namespace IndependentFilename {
  public static class Automation { public static bool Compare(object x,object y){return object.ReferenceEquals(x,y);} }
  public sealed class InvokePattern { public static int Count;public void Invoke(){Count++;} }
}
public sealed class AIbrowseNativeSaveControl : System.IDisposable {
  public static string Mode,Text;public static int Reads,Writes,Checks,Disposals;
  public AIbrowseNativeSaveControl(uint p,string c,string e,System.IntPtr m,System.IntPtr d,System.IntPtr w,object clock){}
  public void Validate(){Checks++;}
  public string ReadText(){Reads++;return Mode=="changed-readback" && Writes>0?"PRIVATE_REVIEW_VALUE":Text;}
  public void WriteTarget(string value){Writes++;Text=value;if(Mode=="write-timeout")throw new System.InvalidOperationException("固定写超时");}
  public void Dispose(){Disposals++;}
  public static void Reset(string mode){Mode=mode;Text="AIbrowse-backup.aibak";Reads=Writes=Checks=Disposals=0;IndependentFilename.InvokePattern.Count=0;}
}
public sealed class AIbrowseNativeSaveButton : System.IDisposable {
 public AIbrowseNativeSaveButton(object a,object b,object c,object d,object e,object f,object g,object h,object i) {}
 public void Validate() {}
 public object Inspect() { return new object(); }
 public object Act() { IndependentFilename.InvokePattern.Count++;return new object(); }
 public void Dispose() {}
}
'@;
    $source=[IO.File]::ReadAllText($env:AIBROWSE_REVIEW_UI).Replace('[Windows.Automation.','[IndependentFilename.');
    $tokens=$null;$errors=$null;$tree=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);
    if($errors.Count -ne 0){throw '候选AST解析失败'};
    foreach($name in @('Check-Time','Assert-NativeFilenameInput','Get-FilenameAutomationIdClass','Get-FilenameValueClass')) {
      $items=@($tree.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true));
      if($items.Count -ne 1){throw '未唯一找到实际函数'};. ([scriptblock]::Create($items[0].Extent.Text));
    };
    $entry=@($tree.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]});
    $switch=@($entry[0].Body.Statements|Where-Object {$_ -is [Management.Automation.Language.SwitchStatementAst]});
    if($entry.Count -ne 1 -or $switch.Count -ne 1){throw '动作AST不唯一'};
    $actionBlock=[scriptblock]::Create($switch[0].Extent.Text);
    function Save-Dialog($Main){return [pscustomobject]@{fixed=$true}};
    function Assert-Dialog($Dialog,$Main){return [IntPtr]202};
    function Assert-NativeDialogButton($Binding,$Dialog,$Main,$Id,$Native){$Native.Validate()};
    function Dialog-Button($Dialog,$Id){return [pscustomobject]@{Window=[IntPtr](30+[int]$Id);Name=if($Id -ceq '1'){'保存'}else{'取消'};Element=[pscustomobject]@{Current=[pscustomobject]@{Name=if($Id -ceq '1'){'保存'}else{'取消'}}};Pattern=[IndependentFilename.InvokePattern]::new()}};
    function Get-NativeFilenameInput($Dialog,$Diagnostic){
      $script:reads++;
      $selectedHost=$script:originalHost;$selectedElement=$script:originalElement;$window=[IntPtr]303;
      if($script:reads -eq $script:changeAt){
        if($script:mode -ceq 'host-replaced'){$selectedHost=[pscustomobject]@{same='fields'}};
        if($script:mode -ceq 'element-replaced'){$selectedElement=[pscustomobject]@{Current=[pscustomobject]@{AutomationId='1001'}}};
        if($script:mode -ceq 'hwnd-replaced'){$window=[IntPtr]404};
        if($script:mode -ceq 'tree-failed'){throw '固定结构失败'};
      };
      return [pscustomobject]@{Host=$selectedHost;Element=$selectedElement;Window=$window};
    };
    $ProcessId=41;$CreatedFileTime='1001';$Executable='C:\review-product\AIbrowse.exe';$handle=[IntPtr]101;
    $Target='C:\aibrowse-independent-synthetic-filename\candidate.aibak';$clock=[pscustomobject]@{ElapsedMilliseconds=0};
    $rows=@(foreach($case in @(
      @{mode='normal';action='InspectSaveDialog';at=99},
      @{mode='normal';action='CancelSave';at=99},
      @{mode='normal';action='SaveBackup';at=99},
      @{mode='host-replaced';action='SaveBackup';at=2},
      @{mode='element-replaced';action='SaveBackup';at=3},
      @{mode='element-replaced';action='SaveBackup';at=7},
      @{mode='hwnd-replaced';action='SaveBackup';at=7},
      @{mode='tree-failed';action='SaveBackup';at=7},
      @{mode='write-timeout';action='SaveBackup';at=99},
      @{mode='changed-readback';action='SaveBackup';at=99}
    )) {
      $script:mode=$case.mode;$script:changeAt=$case.at;$script:reads=0;
      $script:originalHost=[pscustomobject]@{same='fields'};$script:originalElement=[pscustomobject]@{Current=[pscustomobject]@{AutomationId='1001'}};
      [AIbrowseNativeSaveControl]::Reset($case.mode);$diagnostic=[ordered]@{};$Action=$case.action;$accepted=$false;
      try{. $actionBlock;$accepted=$true}catch{};
      [ordered]@{mode=$case.mode;action=$Action;at=$case.at;accepted=$accepted;bindings=$script:reads;writes=[AIbrowseNativeSaveControl]::Writes;invokes=[IndependentFilename.InvokePattern]::Count;disposed=[AIbrowseNativeSaveControl]::Disposals;diagnostic=$diagnostic};
    });$rows|ConvertTo-Json -Depth 6 -Compress;
  `,
    ],
    {
      env: {
        ...process.env,
        AIBROWSE_REVIEW_UI: resolve('tools/data-qualification/product-transfer/ui-driver.ps1'),
      },
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  const rows = JSON.parse(child.stdout) as Array<{
    mode: string;
    action: string;
    at: number;
    accepted: boolean;
    bindings: number;
    writes: number;
    invokes: number;
    disposed: number;
  }>;
  expect(rows).toHaveLength(10);
  for (const row of rows) {
    expect(row.accepted, JSON.stringify(row)).toBe(row.mode === 'normal');
    expect(row.disposed).toBe(1);
    expect(row.invokes).toBe(row.mode === 'normal' && row.action !== 'InspectSaveDialog' ? 1 : 0);
    expect(row.writes).toBe(row.action === 'SaveBackup' && row.at > 3 ? 1 : 0);
    if (row.at < 99) expect(row.bindings).toBe(row.at);
  }
  expect(child.stdout).not.toContain('PRIVATE_REVIEW_VALUE');
});
