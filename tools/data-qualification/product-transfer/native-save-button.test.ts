import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const source = readFileSync(
  resolve('tools/data-qualification/product-transfer/NativeSaveButton.cs'),
  'utf8',
);
const signatures: Record<string, string> = {
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
  IsChild: 'parent, child',
};
// Isolate all OS and COM acquisition. The actual Win32 identity logic is executed.
let isolated = source.replace(
  /internal sealed class SaveButtonAccessible[\s\S]*?internal sealed class Win32SaveButtonPort/,
  'internal sealed class Win32SaveButtonPort',
);
const replaced: string[] = [];
isolated = isolated.replace(
  /\[DllImport\([^\n]*\)\]\r?\n\s*private static extern ([A-Za-z]+) ([A-Za-z0-9]+)\(([^;]*)\);/g,
  (_whole: string, result: string, name: string, parameters: string) => {
    if (!Object.hasOwn(signatures, name)) throw new Error('未限定原生端口');
    replaced.push(name);
    return `private static ${result} ${name}(${parameters}) { return NativeSaveFake.${name}(${signatures[name]}); }`;
  },
);
if (replaced.length !== Object.keys(signatures).length || isolated.includes('[DllImport'))
  throw new Error('原生端口隔离不完整');
isolated = isolated.replace(
  'return new SaveButtonAccessible(edit);',
  'return new ButtonSession(new ButtonPort());',
);
const fixture = `
public static class NativeSaveFake {
  public static string Mode, Text, Target;
  public static int Reads, Writes, Opens;
  public static SafeProcessHandle Held;
  public static uint GetCurrentProcessId() { return Mode=="same-process" ? 42u : 7u; }
  public static uint GetCurrentThreadId() { return 777; }
  public static SafeProcessHandle OpenProcess(uint access,bool inherit,uint id) {
    if(access!=0x101000 || inherit || id!=42) throw new Exception("进程权限不符");
    Opens++; Held=new SafeProcessHandle(new IntPtr(88),false); return Held;
  }
  public static uint GetProcessId(SafeProcessHandle process) { return Mode=="held-pid" ? 43u : 42u; }
  public static uint WaitForSingleObject(SafeProcessHandle process,uint ms) { return Mode=="exited" ? 0u : 258u; }
  public static bool GetProcessTimes(SafeProcessHandle p,out long c,out long e,out long k,out long u) {
    c=Mode=="created" ? 1000 : 999; e=k=u=0; return true;
  }
  public static bool QueryFullProcessImageNameW(SafeProcessHandle p,uint flags,StringBuilder path,ref uint size) {
    path.Append(Mode=="executable" ? @"C:\\other.exe" : @"C:\\product\\AIbrowse.exe"); return true;
  }
  public static bool IsWindow(IntPtr w) { return Mode!="missing"; }
  public static bool IsWindowEnabled(IntPtr w) { return Mode!="disabled"; }
  public static bool IsWindowVisible(IntPtr w) { return Mode!="hidden"; }
  public static uint GetWindowThreadProcessId(IntPtr w,out uint id) {
    id=(Mode=="foreign-pid" && w.ToInt64()==33) || (Mode=="main-pid" && w.ToInt64()==11) ? 43u : 42u;
    return Mode=="same-thread" ? 777u : 888u;
  }
  public static IntPtr GetWindow(IntPtr w,uint command) { return new IntPtr(Mode=="owner" ? 12 : 11); }
  public static int GetClassNameW(IntPtr w,StringBuilder name,int maximum) {
    string value=w.ToInt64()==22 ? "#32770" : Mode=="class" ? "Static" : "Button";
    name.Append(value); return value.Length;
  }
  public static int GetDlgCtrlID(IntPtr w) { return Mode=="id" ? 2 : 1; }
  public static IntPtr GetAncestor(IntPtr w,uint flags) {
    if(flags!=2) throw new Exception("根窗口模式不符"); return new IntPtr(Mode=="root" ? 11 : 22);
  }
  public static IntPtr GetWindowLongPtrW(IntPtr w,int index) {
    if(index!=-16) throw new Exception("样式模式不符");
    return new IntPtr(Mode=="style-zero" ? 0 : 0x40000000L | (Mode=="readonly" ? 0x800L : 0));
  }
  private static void Envelope(IntPtr window,uint message,uint expected,uint flags,uint timeout) {
    if(window.ToInt64()!=33 || message!=expected || flags!=0x23 || timeout==0 || timeout>1000)
      throw new Exception("固定消息封套不符");
  }
  public static IntPtr SendMessageTimeoutW(IntPtr w,uint m,UIntPtr wp,IntPtr lp,uint flags,uint timeout,out UIntPtr result) {
    Envelope(w,m,0xe,flags,timeout); if(wp!=UIntPtr.Zero || lp!=IntPtr.Zero) throw new Exception("长度参数不符");
    Reads++; result=new UIntPtr((uint)(Mode=="oversize" ? 4097 : Text.Length));
    return Mode=="read-timeout" ? IntPtr.Zero : new IntPtr(1);
  }
  public static IntPtr SendMessageTimeoutTextW(IntPtr w,uint m,UIntPtr wp,StringBuilder value,uint flags,uint timeout,out UIntPtr result) {
    Envelope(w,m,0xd,flags,timeout); if(wp.ToUInt64()!=4097 || value.Capacity!=4097) throw new Exception("读取缓冲区不符");
    Reads++; value.Append(Text); result=new UIntPtr((uint)(Text.Length+(Mode=="bad-count" ? 1 : 0)));
    return new IntPtr(1);
  }
  public static IntPtr SendMessageTimeoutSetW(IntPtr w,uint m,UIntPtr wp,string value,uint flags,uint timeout,out UIntPtr result) {
    Envelope(w,m,0xc,flags,timeout); if(wp!=UIntPtr.Zero || value!=Target) throw new Exception("写入参数不符");
    Writes++; Text=Mode=="readback" ? @"C:\\PRIVATE_USER\\SECRET.aibak" : value;
    result=new UIntPtr(Mode=="set-false" ? 0u : 1u);
    return Mode=="set-timeout" ? IntPtr.Zero : new IntPtr(1);
  }
  public static object Run(string mode) {
    Mode=mode; Text=""; Reads=Writes=Opens=0; Held=null;
    bool accepted=false; string failure=null;
    try {
      var button=new IntPtr(mode=="zero" ? 0 : mode=="broadcast" ? 0xffff : 33);
      using(var native=new AIbrowseNativeSaveButton(42,"999",@"C:\\product\\AIbrowse.exe",new IntPtr(11),new IntPtr(22),button,1,"Save",Stopwatch.StartNew())) {
        native.Inspect(); accepted=true;
      }
    } catch(Exception error) { failure=error.Message; }
    return new {mode,accepted,failure,opens=Opens,closed=Held==null || Held.IsClosed};
  }
  public static bool IsChild(IntPtr parent,IntPtr child) { return Mode!="child"; }
}
internal sealed class ButtonSession : IAIbrowseButtonAccessible {
 private readonly ButtonPort port;
 public ButtonSession(ButtonPort port) { this.port=port; }
 public SaveButtonMetadata Read() {
  port.Reads++;
  if(port.Mode=="read-late") port.Time=30000;
  return new SaveButtonMetadata {
   HResult=port.Mode=="hresult" ? 1 : 0,
   Name=port.Mode=="name" || (port.Mode=="second-name" && port.Reads==2) ? "PRIVATE_UNKNOWN" : "Save",
   Role=port.Mode=="role" ? 42 : 43,
   State=port.Mode=="unavailable" ? 1 : port.Mode=="invisible" ? 0x8000 : port.Mode=="offscreen" ? 0x10000 : 0,
   DefaultAction=port.Mode=="no-action" ? "" : "PRIVATE_ACTION"
  };
 }
 public void Act() { port.Actions++; if(port.Mode=="action-late") port.Time=30000; if(port.Mode=="action-throw") throw new Exception("固定错误"); }
 public void Dispose() { port.Releases++; }
}
internal sealed class ButtonPort : IAIbrowseSaveButtonPort {
 public string Mode="normal";
 public long Time;
 public int Actions, Reads, Releases, Disposals, Opens;
 public long ElapsedMilliseconds { get { return Time; } }
 public bool IdentityMatches() { return Mode!="identity" && !(Mode=="read-identity" && Reads>0); }
 public IAIbrowseButtonAccessible OpenAccessible() { Opens++; return new ButtonSession(this); }
 public void Dispose() { Disposals++; }
 public static object Run(string mode) {
  var port=new ButtonPort {Mode=mode,Time=mode=="expired" ? 30000 : mode=="one-ms" ? 29999 : 0};
  bool accepted=false,retryRejected=false; string failure=null; AIbrowseSaveButtonProof proof=null;
  try {
   using(var native=new AIbrowseNativeSaveButton(port,1,"Save")) {
    try { proof=native.Act(); accepted=true; } catch(Exception e) { failure=e.Message; }
    try { native.Act(); } catch { retryRejected=true; }
    native.Dispose();
   }
  } catch(Exception e) { failure=e.Message; }
  return new {mode,accepted,retryRejected,failure,proof,actions=port.Actions,reads=port.Reads,opens=port.Opens,releases=port.Releases,disposed=port.Disposals};
 }
}
public static class ButtonTests { public static object Run(string mode) { return ButtonPort.Run(mode); } }
`;
const nativeModes = [
  'normal',
  'same-process',
  'same-thread',
  'held-pid',
  'created',
  'executable',
  'exited',
  'foreign-pid',
  'main-pid',
  'owner',
  'class',
  'id',
  'root',
  'child',
  'disabled',
  'hidden',
  'missing',
  'style-zero',
  'zero',
  'broadcast',
];
const semanticModes = [
  'normal',
  'one-ms',
  'expired',
  'identity',
  'hresult',
  'name',
  'role',
  'unavailable',
  'invisible',
  'offscreen',
  'no-action',
  'second-name',
  'read-late',
  'read-identity',
  'action-late',
  'action-throw',
];
interface Row {
  mode: string;
  accepted: boolean;
  failure: string | null;
  closed?: boolean;
  actions: number;
  opens: number;
  reads: number;
  releases: number;
  disposed: number;
  retryRejected: boolean;
  proof: Record<string, unknown> | null;
}
let cached: { native: Row[]; semantic: Row[] } | undefined;
function results() {
  if (cached) return cached;
  const child = spawnSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition $env:AIBROWSE_BUTTON_SOURCE; $native=@(foreach($m in (ConvertFrom-Json $env:AIBROWSE_BUTTON_NATIVE)){[NativeSaveFake]::Run($m)}); $semantic=@(foreach($m in (ConvertFrom-Json $env:AIBROWSE_BUTTON_SEMANTIC)){[ButtonTests]::Run($m)}); @{native=$native;semantic=$semantic}|ConvertTo-Json -Depth 6 -Compress`,
    ],
    {
      env: {
        ...process.env,
        AIBROWSE_BUTTON_SOURCE: isolated + fixture,
        AIBROWSE_BUTTON_NATIVE: JSON.stringify(nativeModes),
        AIBROWSE_BUTTON_SEMANTIC: JSON.stringify(semanticModes),
      },
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).not.toMatch(/PRIVATE_UNKNOWN|PRIVATE_ACTION/);
  cached = JSON.parse(child.stdout) as { native: Row[]; semantic: Row[] };
  return cached;
}
it.each(nativeModes)('实际原生按钮身份逻辑：%s', (mode) => {
  const row = results().native.find((row) => row.mode === mode)!;
  expect(row.accepted, row.failure ?? '').toBe(mode === 'normal');
  expect(row.closed).toBe(true);
});
it.each(semanticModes)('实际MSAA动作语义、期限及一次调用：%s', (mode) => {
  const row = results().semantic.find((row) => row.mode === mode)!;
  expect(row.accepted, row.failure ?? '').toBe(['normal', 'one-ms'].includes(mode));
  expect(row.disposed).toBe(1);
  expect(row.releases).toBe(row.opens);
  expect(row.actions).toBe(
    ['normal', 'one-ms', 'action-late', 'action-throw'].includes(mode) ? 1 : 0,
  );
  if (row.opens) expect(row.retryRejected).toBe(true);
  if (row.accepted) {
    expect(row.reads).toBe(2);
    expect(row.proof).toEqual({
      version: 1,
      mechanism: 'MSAA CHILDID_SELF',
      controlId: 1,
      nameClass: 'save',
      hresult: 0,
      role: 43,
      available: true,
      visible: true,
      defaultActionPresent: true,
      nativeIdentityVerified: true,
    });
  }
});
it('008按钮形状与敌手选择反例执行实际PowerShell函数', () => {
  const child = spawnSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-File',
      resolve('tools/data-qualification/product-transfer/test-native-save-button.ps1'),
    ],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(JSON.parse(child.stdout)).toMatchObject({
    ok: true,
    checks: 11,
    actualUi: false,
    nativeCalls: false,
  });
});

// Execute the actual COM acquisition, reflection property/default action calls and release.
it('实际MSAA适配器只用OBJID_CLIENT与CHILDID_SELF且释放每个COM引用', () => {
  const start = source.indexOf('internal sealed class SaveButtonAccessible');
  const end = source.indexOf('internal sealed class Win32SaveButtonPort');
  const adapter = source
    .slice(start, end)
    .replace(
      /\[DllImport\("oleacc.dll"\)\]\s*private static extern int AccessibleObjectFromWindow\([^;]+;/,
      'private static int AccessibleObjectFromWindow(IntPtr w,uint o,ref Guid i,out IntPtr p) { return ComPort.Open(w,o,ref i,out p); }',
    )
    .replaceAll('Marshal.GetObjectForIUnknown', 'ComPort.ObjectForPointer')
    .replaceAll('Marshal.Release(', 'ComPort.Release(')
    .replaceAll('Marshal.IsComObject', 'ComPort.IsComObject')
    .replaceAll('Marshal.FinalReleaseComObject', 'ComPort.FinalReleaseComObject');
  expect(adapter).not.toContain('DllImport');
  const prefix = source.slice(0, source.indexOf('internal interface IAIbrowseSaveButtonPort'));
  const code =
    prefix +
    `internal sealed class SaveButtonMetadata { internal int HResult,Role,State;internal string Name,DefaultAction; }` +
    adapter +
    `
 public static class ComPort {
  public static string Mode;public static int PointerReleases,ObjectReleases,Actions,Reads;
  public static object Instance;
  public static int Open(IntPtr w,uint o,ref Guid i,out IntPtr p) {
   if(w.ToInt64()!=33 || o!=0xFFFFFFFC || i!=new Guid("618736e0-3c3d-11cf-810c-00aa00389b71")) throw new Exception("COM获取封套越界");
   p=Mode=="null" ? IntPtr.Zero : new IntPtr(44);return Mode=="sfalse" ? 1 : Mode=="negative" ? -1 : 0;
  }
  public static object ObjectForPointer(IntPtr p) { if(p.ToInt64()!=44)throw new Exception("指针越界");return Instance; }
  public static int Release(IntPtr p) { if(p.ToInt64()!=44)throw new Exception("释放指针越界");PointerReleases++;return 0; }
  public static bool IsComObject(object value) { if(!Object.ReferenceEquals(value,Instance))throw new Exception("对象变化");return true; }
  public static int FinalReleaseComObject(object value) { if(!Object.ReferenceEquals(value,Instance))throw new Exception("对象变化");ObjectReleases++;return 0; }
  public static object Property(string name,int child) {
   if(child!=0)throw new Exception("非CHILDID_SELF");Reads++;
   if(Mode=="property-throw")throw new Exception("固定属性失败");
   switch(name) {case "accName":return "Save";case "accRole":return 43;case "accState":return 0;case "accDefaultAction":return "PRIVATE_ACTION";default:throw new Exception("属性越界");}
  }
  public static void Action(int child) { if(child!=0)throw new Exception("非CHILDID_SELF");Actions++;if(Mode=="action-throw")throw new Exception("固定动作失败"); }
  private static object Build() {
   var assembly=System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(new AssemblyName("PureMsaa"+Guid.NewGuid().ToString("N")),System.Reflection.Emit.AssemblyBuilderAccess.Run);
   var type=assembly.DefineDynamicModule("main").DefineType("Accessible",TypeAttributes.Public);
   foreach(string name in new[]{"accName","accRole","accState","accDefaultAction"}) {
    var method=type.DefineMethod("get_"+name,MethodAttributes.Public|MethodAttributes.SpecialName|MethodAttributes.HideBySig,typeof(object),new[]{typeof(int)});
    var il=method.GetILGenerator();il.Emit(System.Reflection.Emit.OpCodes.Ldstr,name);il.Emit(System.Reflection.Emit.OpCodes.Ldarg_1);il.Emit(System.Reflection.Emit.OpCodes.Call,typeof(ComPort).GetMethod("Property"));il.Emit(System.Reflection.Emit.OpCodes.Ret);
    var property=type.DefineProperty(name,PropertyAttributes.None,typeof(object),new[]{typeof(int)});property.SetGetMethod(method);
   }
   var action=type.DefineMethod("accDoDefaultAction",MethodAttributes.Public,typeof(void),new[]{typeof(int)});
   var body=action.GetILGenerator();body.Emit(System.Reflection.Emit.OpCodes.Ldarg_1);body.Emit(System.Reflection.Emit.OpCodes.Call,typeof(ComPort).GetMethod("Action"));body.Emit(System.Reflection.Emit.OpCodes.Ret);
   return Activator.CreateInstance(type.CreateType());
  }
  public static object Run(string mode) {
   Mode=mode;PointerReleases=ObjectReleases=Actions=Reads=0;Instance=Build();bool accepted=false;
   try { using(var session=new SaveButtonAccessible(new IntPtr(33))) { var m=session.Read();if(m.HResult!=0 || m.Role!=43 || m.Name!="Save" || m.DefaultAction!="PRIVATE_ACTION")throw new Exception("投影变化");session.Act();accepted=true;session.Dispose(); } }catch{}
   return new {mode,accepted,pointerReleases=PointerReleases,objectReleases=ObjectReleases,actions=Actions,reads=Reads};
  }
 }`;
  const child = spawnSync(
    'pwsh.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop';Add-Type -TypeDefinition $env:AIBROWSE_COM_SOURCE; @(foreach($m in @('normal','sfalse','negative','null','property-throw','action-throw')){[ComPort]::Run($m)})|ConvertTo-Json -Compress`,
    ],
    {
      env: { ...process.env, AIBROWSE_COM_SOURCE: code },
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  const rows = JSON.parse(child.stdout) as Array<{
    mode: string;
    accepted: boolean;
    pointerReleases: number;
    objectReleases: number;
    actions: number;
    reads: number;
  }>;
  expect(rows).toHaveLength(6);
  for (const row of rows) {
    expect(row.accepted).toBe(row.mode === 'normal');
    expect(row.pointerReleases).toBe(row.mode === 'null' ? 0 : 1);
    expect(row.objectReleases).toBe(
      ['normal', 'property-throw', 'action-throw'].includes(row.mode) ? 1 : 0,
    );
    expect(row.actions).toBe(['normal', 'action-throw'].includes(row.mode) ? 1 : 0);
    if (row.mode === 'normal') expect(row.reads).toBe(4);
  }
  expect(child.stdout).not.toContain('PRIVATE_ACTION');
});
