import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

const source = readFileSync(
  resolve('tools/data-qualification/product-transfer/NativeSaveControl.cs'),
  'utf8',
);

// Replace only P/Invoke declarations with pure C# ports; execute all actual identity/message logic.
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
  SendMessageTimeoutW: 'window, message, wParam, lParam, flags, timeout, out result',
  SendMessageTimeoutTextW: 'window, message, wParam, value, flags, timeout, out result',
  SendMessageTimeoutSetW: 'window, message, wParam, value, flags, timeout, out result',
};
const replaced: string[] = [];
const isolated = source.replace(
  /\[DllImport\([^\n]*\)\]\r?\n\s*private static extern ([A-Za-z]+) ([A-Za-z0-9]+)\(([^;]*)\);/g,
  (_whole: string, result: string, name: string, parameters: string) => {
    if (!Object.hasOwn(signatures, name)) throw new Error('未限定的原生端口');
    replaced.push(name);
    return `private static ${result} ${name}(${parameters}) { return NativeSaveFake.${name}(${signatures[name]}); }`;
  },
);
if (replaced.length !== Object.keys(signatures).length || isolated.includes('[DllImport'))
  throw new Error('原生端口未全部隔离，禁止运行');

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
    string value=w.ToInt64()==22 ? "#32770" : Mode=="class" ? "Static" : "Edit";
    name.Append(value); return value.Length;
  }
  public static int GetDlgCtrlID(IntPtr w) { return Mode=="id" ? 1002 : 1001; }
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
  public static object Run(string mode,string target) {
    Mode=mode; Text="AIbrowse-backup.aibak"; Target=target; Reads=Writes=Opens=0; Held=null;
    bool accepted=false; string failure=null;
    try {
      var edit=new IntPtr(mode=="zero" ? 0 : mode=="broadcast" ? 0xffff : 33);
      using(var native=new AIbrowseNativeSaveControl(42,"999",@"C:\\product\\AIbrowse.exe",new IntPtr(11),new IntPtr(22),edit,Stopwatch.StartNew())) {
        if(mode.StartsWith("set-") || mode=="write" || mode=="readback" || mode=="invalid-target") native.WriteTarget(target);
        else if(native.ReadText()!=Text) throw new Exception("读取不一致");
        accepted=true;
      }
    } catch(Exception error) { failure=error.Message; }
    return new {mode,accepted,failure,reads=Reads,writes=Writes,opens=Opens,closed=Held==null || Held.IsClosed};
  }
}
internal sealed class DeadlineSavePort : IAIbrowseSaveControlPort {
  public long Time;
  public string Mode,Text="AIbrowse-backup.aibak";
  public int Sends,Disposed,Checks;
  public uint LastTimeout;
  public long ElapsedMilliseconds { get { return Time; } }
  public bool IdentityMatches() { Checks++; return Mode!="change-after" || Sends==0; }
  public ulong ReadLength(uint timeout) {
    Sends++;LastTimeout=timeout;
    if(Mode=="late") Time=30000;
    if(Mode=="changing-length" && Sends==3) return (ulong)Text.Length+1;
    return (ulong)Text.Length;
  }
  public string ReadText(uint timeout) { Sends++;LastTimeout=timeout;return Text; }
  public bool WriteTarget(string value,uint timeout) { Sends++;LastTimeout=timeout;Text=value;return true; }
  public void Dispose() { Disposed++; }
  public static object Run(string mode) {
    var port=new DeadlineSavePort { Mode=mode,Time=mode=="expired" ? 30000 : mode=="one-ms" ? 29999 : 0 };
    bool accepted=false; string failure=null;
    try { using(var native=new AIbrowseNativeSaveControl(port)) { native.ReadText();accepted=true;native.Dispose(); } }
    catch(Exception error) { failure=error.Message; }
    return new {mode,accepted,failure,sends=port.Sends,timeout=port.LastTimeout,disposed=port.Disposed};
  }
}
public static class DeadlineSaveTests { public static object Run(string mode) { return DeadlineSavePort.Run(mode); } }
`;

interface NativeResult {
  mode: string;
  accepted: boolean;
  failure: string | null;
  reads: number;
  writes: number;
  opens: number;
  closed: boolean;
}
interface DeadlineResult {
  mode: string;
  accepted: boolean;
  sends: number;
  timeout: number;
  disposed: number;
}
const modes = [
  'read',
  'write',
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
  'readonly',
  'disabled',
  'hidden',
  'missing',
  'style-zero',
  'zero',
  'broadcast',
  'oversize',
  'bad-count',
  'read-timeout',
  'set-timeout',
  'set-false',
  'readback',
  'invalid-target',
];
const deadlines = ['normal', 'expired', 'one-ms', 'late', 'change-after', 'changing-length'];
interface TestResults {
  native: NativeResult[];
  deadlines: DeadlineResult[];
  raw: string;
}
let cached: TestResults | undefined;
function results(): TestResults {
  if (cached) return cached;
  const command = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
    Add-Type -TypeDefinition $env:AIBROWSE_NATIVE_TEST_SOURCE;
    $native=@(foreach($mode in (ConvertFrom-Json $env:AIBROWSE_NATIVE_MODES)) {
      $target=if($mode -ceq 'invalid-target'){'relative.aibak'}else{'C:\\AIbrowse-synthetic-native-save-test\\candidate.aibak'};
      [NativeSaveFake]::Run($mode,$target)
    });
    $deadlines=@(foreach($mode in (ConvertFrom-Json $env:AIBROWSE_NATIVE_DEADLINES)) {[DeadlineSaveTests]::Run($mode)});
    [ordered]@{native=$native;deadlines=$deadlines}|ConvertTo-Json -Depth 5 -Compress;`;
  const child = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: {
      ...process.env,
      AIBROWSE_NATIVE_TEST_SOURCE: isolated + fixture,
      AIBROWSE_NATIVE_MODES: JSON.stringify(modes),
      AIBROWSE_NATIVE_DEADLINES: JSON.stringify(deadlines),
    },
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  expect(child.status, child.stderr).toBe(0);
  cached = {
    ...(JSON.parse(child.stdout.trim()) as Omit<TestResults, 'raw'>),
    raw: child.stdout,
  };
  return cached;
}

it.each(modes)('实际原生身份和三种消息逻辑：%s', (mode) => {
  const result = results().native.find((row) => row.mode === mode)!;
  expect(result.accepted, result.failure ?? undefined).toBe(mode === 'read' || mode === 'write');
  expect(result.closed).toBe(true);
  expect(result.writes).toBe(
    ['write', 'set-timeout', 'set-false', 'readback'].includes(mode) ? 1 : 0,
  );
  if (!['read', 'write', 'oversize', 'bad-count', 'read-timeout', 'readback'].includes(mode))
    expect(result.reads).toBe(0);
  expect(results().raw).not.toMatch(/PRIVATE_USER|SECRET\.aibak/);
});

it.each(deadlines)('实际公共文本引擎沿用原30秒期限并幂等释放：%s', (mode) => {
  const result = results().deadlines.find((row) => row.mode === mode)!;
  expect(result.accepted).toBe(mode === 'normal' || mode === 'one-ms');
  expect(result.disposed).toBe(1);
  if (mode === 'one-ms') expect(result.timeout).toBe(1);
  if (mode === 'expired') expect(result.sends).toBe(0);
  if (mode === 'late' || mode === 'change-after') expect(result.sends).toBe(1);
});

it('runner实际固定来源绑定包括原生helper，内容变化必须改变摘要', async () => {
  const runner = ts.createSourceFile(
    'run.ts',
    readFileSync(resolve('tools/data-qualification/product-transfer/run.ts'), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(runner) === 'sourceHashes')
      initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(runner);
  expect(initializer).toBeDefined();
  const code = ts.transpileModule(`return (${initializer!.getText(runner)})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2023 },
  }).outputText;
  const execute = new Function('readFile', 'createHash', 'resolve', 'step', code) as (
    read: (path: string) => Promise<Buffer>,
    hash: typeof createHash,
    path: (value: string) => string,
    step: (name: string, operation: () => Promise<Buffer>) => Promise<Buffer>,
  ) => Promise<Record<string, string>>;
  const helper = 'tools/data-qualification/product-transfer/NativeSaveControl.cs';
  const bind = (body: string) =>
    execute(
      async (path) => Buffer.from(path === helper ? body : 'unchanged'),
      createHash,
      (path) => path,
      (_name, operation) => operation(),
    );
  const before = await bind('helper-before');
  const after = await bind('helper-after');
  expect(before[helper]).toBe(createHash('sha256').update('helper-before').digest('hex'));
  expect(after[helper]).not.toBe(before[helper]);
});
