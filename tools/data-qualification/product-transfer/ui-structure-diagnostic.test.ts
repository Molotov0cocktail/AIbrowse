import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

interface Row {
  parent: number;
  id?: string;
  type?: string;
  className?: string;
  processId?: number;
  enabled?: boolean;
  offscreen?: boolean;
  pattern?: boolean;
  readOnly?: boolean;
  forbidDetails?: boolean;
  nativeHandle?: number;
}

interface Structure {
  status: string;
  scannedNodes: number;
  hostCount: number;
  ancestorCount: number;
  descendantCount: number;
  nodes: Array<{
    index: number;
    parent: number;
    relation: string;
    automationIdClass: string;
    controlTypeClass: string;
    windowClass: string;
    sameProcess: boolean;
    enabled: boolean;
    offscreen: boolean;
    valuePattern: boolean;
    readOnly: boolean | null;
  }>;
}

const root: Row = { parent: -1, type: 'Window', className: '#32770' };
const host: Row = {
  parent: 0,
  id: 'FileNameControlHost',
  type: 'Custom',
  className: 'FileNameControlHost',
  pattern: true,
};

// Run actual PowerShell functions against a synthetic tree, without loading UIA or Win32.
// Name/Value always throw; unrelated nodes also reject detailed property reads.
function inspect(
  rows: Row[],
  terminal = false,
  select = false,
  action = 'InspectSaveDialog',
  mode = 'normal',
) {
  const output = join(mkdtempSync(join(tmpdir(), 'product-ui-structure-')), 'receipt.json');
  const command = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest;
    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
    Add-Type -TypeDefinition @'
namespace AIbrowseFake.Automation {
  public static class Automation {
    public static bool Compare(object left,object right) { return object.ReferenceEquals(left,right); }
  }
  public sealed class InvokePattern {
    public static int Invocations;
    public void Invoke() { Invocations++; }
  }
  public static class Shared { public static SyntheticNode Selected; }
  public sealed class ControlType {
    public string ProgrammaticName;
  }
  public sealed class ValueState {
    public bool IsReadOnly;
    public string Value { get { throw new System.Exception("PRIVATE_VALUE_MUST_NOT_BE_READ"); } }
  }
  public sealed class ValuePattern {
    public static readonly object Pattern=new object();
    public ValueState Current;
  }
  public sealed class NodeState {
    public string AutomationId, ClassValue;
    public bool IsEnabled, IsOffscreen, ForbidDetails;
    public int ProcessId, NativeWindowHandle;
    public ControlType ControlType;
    public string ClassName { get {
      if (ForbidDetails) throw new System.Exception("UNRELATED_DETAILS_MUST_NOT_BE_READ");
      return ClassValue;
    } }
    public string Name { get { throw new System.Exception("PRIVATE_NAME_MUST_NOT_BE_READ"); } }
  }
  public sealed class SyntheticNode {
    public NodeState Current; public ValuePattern Value; public SyntheticNode Parent;
    public readonly System.Collections.Generic.List<SyntheticNode> Children=new System.Collections.Generic.List<SyntheticNode>();
    public bool TryGetCurrentPattern(object id, out object pattern) {
      if (Current.ForbidDetails) throw new System.Exception("UNRELATED_PATTERN_MUST_NOT_BE_READ");
      if (!object.ReferenceEquals(id,ValuePattern.Pattern)) throw new System.Exception("wrong pattern");
      pattern=Value; return Value!=null;
    }
  }
  public sealed class TreeWalker {
    public static readonly TreeWalker ControlViewWalker=new TreeWalker();
    public SyntheticNode GetFirstChild(SyntheticNode node) { return node.Children.Count==0 ? null : node.Children[0]; }
    public SyntheticNode GetNextSibling(SyntheticNode node) {
      if (node.Parent==null) return null;
      int index=node.Parent.Children.IndexOf(node)+1;
      return index<node.Parent.Children.Count ? node.Parent.Children[index] : null;
    }
  }
}
public sealed class AIbrowseNativeSaveControl : System.IDisposable {
  public static int Writes,Reads,Disposals;
  public static string Text="AIbrowse-backup.aibak";
  public AIbrowseNativeSaveControl(uint pid,string created,string exe,System.IntPtr main,System.IntPtr dialog,System.IntPtr edit,object clock) {}
  public void Validate() {}
  public string ReadText() {
    Reads++;
    string mode=System.Environment.GetEnvironmentVariable("AIBROWSE_UI_NATIVE_MODE");
    if(mode=="changed-handle" && Reads==1) AIbrowseFake.Automation.Shared.Selected.Current.NativeWindowHandle++;
    if(mode=="changed-host" && Reads==1) {
      var selected=AIbrowseFake.Automation.Shared.Selected;
      var previous=selected.Parent;
      var replacement=new AIbrowseFake.Automation.SyntheticNode {Current=previous.Current,Value=previous.Value,Parent=previous.Parent};
      replacement.Children.Add(selected); selected.Parent=replacement;
      previous.Parent.Children[previous.Parent.Children.IndexOf(previous)]=replacement;
    }
    if(mode=="initial-other" || (mode=="changed-value" && Writes>0) || (mode=="before-save" && Reads==3)) return @"C:\\PRIVATE_NATIVE\\SECRET.aibak";
    return Text;
  }
  public void WriteTarget(string value) {
    Writes++;Text=value;
    if(System.Environment.GetEnvironmentVariable("AIBROWSE_UI_NATIVE_MODE")=="write-timeout") throw new System.Exception("固定原生写入超时");
  }
  public void Dispose() { Disposals++; }
}
public sealed class AIbrowseNativeSaveButton : System.IDisposable {
 public AIbrowseNativeSaveButton(object a,object b,object c,object d,object e,object f,object g,object h,object i) {}
 public void Validate() {}
 public object Inspect() { return new object(); }
 public object Act() { AIbrowseFake.Automation.InvokePattern.Invocations++;return new object(); }
 public void Dispose() {}
}
'@;
    $source=[IO.File]::ReadAllText($env:AIBROWSE_UI_SCRIPT).Replace('[Windows.Automation.','[AIbrowseFake.Automation.');
    $tokens=$null; $errors=$null;
    $tree=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);
    if($errors.Count -ne 0){throw '脚本解析失败'};
    foreach($function in @($tree.FindAll({param($node)
      $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
      ($node.Name -cin @('Check-Time','Get-FilenameAutomationIdClass','Get-FilenameValueClass','Inspect-FilenameHostStructure','Get-NativeFilenameInput','Assert-NativeFilenameInput') -or $node.Name.StartsWith('Get-FilenameStructure'))
    },$true))) { . ([scriptblock]::Create($function.Extent.Text)) };
    $script:nodes=@(foreach($row in (ConvertFrom-Json $env:AIBROWSE_UI_ROWS)) {
      $node=[AIbrowseFake.Automation.SyntheticNode]::new();
      $node.Current=[AIbrowseFake.Automation.NodeState]::new();
      $node.Current.AutomationId=$row.id; $node.Current.ClassValue=$row.className;
      $node.Current.ControlType=[AIbrowseFake.Automation.ControlType]::new();
      $node.Current.ControlType.ProgrammaticName='ControlType.'+$row.type;
      $node.Current.IsEnabled=$row.enabled; $node.Current.IsOffscreen=$row.offscreen;
      $node.Current.ProcessId=$row.processId; $node.Current.ForbidDetails=$row.forbidDetails;
      $node.Current.NativeWindowHandle=$row.nativeHandle;
      if($row.nativeHandle -eq 313){[AIbrowseFake.Automation.Shared]::Selected=$node};
      if($row.pattern) {
        $node.Value=[AIbrowseFake.Automation.ValuePattern]::new();
        $node.Value.Current=[AIbrowseFake.Automation.ValueState]::new();
        $node.Value.Current.IsReadOnly=$row.readOnly;
      };
      $node;
    });
    $rows=@(ConvertFrom-Json $env:AIBROWSE_UI_ROWS);
    for($i=1;$i -lt $rows.Count;$i++) {
      $script:nodes[$i].Parent=$script:nodes[$rows[$i].parent];
      $script:nodes[$rows[$i].parent].Children.Add($script:nodes[$i]);
    };
    $ProcessId=42; $CreatedFileTime='999';$Executable='C:\\synthetic.exe';$Target='C:\\synthetic\\target.aibak';$clock=[pscustomobject]@{ElapsedMilliseconds=0};
    $diagnostic=[ordered]@{version=1;action='InspectSaveDialog';ok=$false;phase='InspectSaveDialog'};
    $script:filenameCalls=0; $script:buttonCalls=0;
    $accepted=$false; $failure=$null; $selected=-1;
    try {
      if($env:AIBROWSE_UI_TERMINAL -ceq 'yes') {
        function Save-Dialog($Main){return $script:nodes[0]};
        function Assert-Dialog($Dialog,$Main){return [IntPtr]23};
        function Filename-Input($Dialog,$Diagnostic){$script:filenameCalls++;return [pscustomobject]@{Element=$script:nodes[0]}};
        function Assert-NativeDialogButton($Binding,$Dialog,$Main,$Id,$Native){$Native.Validate()};
        function Dialog-Button($Dialog,$Id){$script:buttonCalls++;return [pscustomobject]@{Window=[IntPtr](30+[int]$Id);Name='固定按钮';Element=[pscustomobject]@{Current=[pscustomobject]@{Name='固定按钮'}};Pattern=[AIbrowseFake.Automation.InvokePattern]::new()}};
        $tries=@($tree.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]});
        $sw=@($tries[0].Body.Statements | Where-Object {$_ -is [Management.Automation.Language.SwitchStatementAst]});
        $terminal='try {'+$source.Substring($sw[0].Extent.StartOffset,$tries[0].Extent.EndOffset-$sw[0].Extent.StartOffset);
        $Output=$env:AIBROWSE_UI_OUTPUT; $Action=$env:AIBROWSE_UI_ACTION; $phase=$Action; $handle=[IntPtr]22;
        . ([scriptblock]::Create($terminal));
      } elseif($env:AIBROWSE_UI_SELECT -ceq 'yes') {
        $binding=Get-NativeFilenameInput $script:nodes[0] $diagnostic;
        $selected=$binding.Window.ToInt64();
      } else { Inspect-FilenameHostStructure $script:nodes[0] $diagnostic };
      $accepted=$true;
    } catch { $failure=$_.Exception.Message };
    [ordered]@{accepted=$accepted;failure=$failure;diagnostic=$diagnostic;selected=$selected;filenameCalls=$script:filenameCalls;buttonCalls=$script:buttonCalls;writes=[AIbrowseNativeSaveControl]::Writes;invocations=[AIbrowseFake.Automation.InvokePattern]::Invocations;disposals=[AIbrowseNativeSaveControl]::Disposals} | ConvertTo-Json -Depth 8 -Compress;`;
  const child = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: {
      ...process.env,
      AIBROWSE_UI_SCRIPT: resolve('tools/data-qualification/product-transfer/ui-driver.ps1'),
      AIBROWSE_UI_ROWS: JSON.stringify(
        rows.map((row) => ({
          id: '',
          type: 'Pane',
          className: '',
          processId: 42,
          enabled: true,
          offscreen: false,
          pattern: false,
          readOnly: false,
          forbidDetails: false,
          nativeHandle: 0,
          ...row,
        })),
      ),
      AIBROWSE_UI_OUTPUT: output,
      AIBROWSE_UI_TERMINAL: terminal ? 'yes' : 'no',
      AIBROWSE_UI_SELECT: select ? 'yes' : 'no',
      AIBROWSE_UI_ACTION: action,
      AIBROWSE_UI_NATIVE_MODE: mode,
    },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout.trim()) as {
    accepted: boolean;
    failure: string | null;
    diagnostic: { ok: boolean; filenameHostStructure: Structure };
    filenameCalls: number;
    buttonCalls: number;
    selected: number;
    writes: number;
    invocations: number;
    disposals: number;
  };
  return {
    ...result,
    raw: child.stdout,
    receipt: terminal
      ? (JSON.parse(readFileSync(output, 'utf8')) as typeof result.diagnostic)
      : null,
  };
}

it('原生选择器接受host下唯一Pane代理的Edit类1001句柄且不读取Value', () => {
  const result = inspect(
    [
      root,
      host,
      { parent: 1, id: '1001', type: 'Pane', className: 'Edit', nativeHandle: 313 },
      {
        parent: 0,
        id: '1001',
        type: 'Edit',
        className: 'Edit',
        nativeHandle: 414,
        forbidDetails: true,
      },
    ],
    false,
    true,
  );
  expect(result.accepted).toBe(true);
  expect(result.selected).toBe(313);
});

it('实际Inspect分支仅做只读原生资格，不执行写入或按钮Invoke', () => {
  const result = inspect(
    [root, host, { parent: 1, id: '1001', className: 'Edit', nativeHandle: 313 }],
    true,
  );
  expect(result.accepted, result.failure ?? undefined).toBe(true);
  expect(result.filenameCalls).toBe(0);
  expect(result.buttonCalls).toBe(2);
  expect(result.writes + result.invocations).toBe(0);
  expect(result.disposals).toBe(1);
  expect(result.receipt?.ok).toBe(true);
  expect(result.receipt?.filenameHostStructure.status).toBe('complete');
  expect(result.failure).toBeNull();
});

it.each([
  { name: '无候选', rows: [root, host] },
  {
    name: '重复候选',
    rows: [
      root,
      host,
      { parent: 1, id: '1001', className: 'Edit', nativeHandle: 313 },
      { parent: 1, id: '1001', className: 'Edit', nativeHandle: 414 },
    ],
  },
  { name: '零句柄', rows: [root, host, { parent: 1, id: '1001', className: 'Edit' }] },
  {
    name: '其它类',
    rows: [root, host, { parent: 1, id: '1001', className: 'PRIVATE_CLASS', nativeHandle: 313 }],
  },
  {
    name: '其它ID',
    rows: [root, host, { parent: 1, id: 'PRIVATE_ID', className: 'Edit', nativeHandle: 313 }],
  },
  {
    name: '异PID输入',
    rows: [
      root,
      host,
      { parent: 1, id: '1001', className: 'Edit', nativeHandle: 313, processId: 43 },
    ],
  },
  {
    name: '异PID host',
    rows: [
      root,
      { ...host, processId: 43 },
      { parent: 1, id: '1001', className: 'Edit', nativeHandle: 313 },
    ],
  },
  {
    name: '禁用输入',
    rows: [
      root,
      host,
      { parent: 1, id: '1001', className: 'Edit', nativeHandle: 313, enabled: false },
    ],
  },
  {
    name: '隐藏输入',
    rows: [
      root,
      host,
      { parent: 1, id: '1001', className: 'Edit', nativeHandle: 313, offscreen: true },
    ],
  },
])('原生选择器拒绝$name且不继续动作', ({ rows }) => {
  const result = inspect(rows, true);
  expect(result.accepted).toBe(false);
  expect(result.receipt?.ok).toBe(false);
  expect(result.writes + result.invocations + result.buttonCalls).toBe(0);
  expect(result.raw).not.toContain('PRIVATE_');
});

it.each(['CancelSave', 'SaveBackup'])('实际%s仅在资格和读回成立后执行固定动作', (action) => {
  const result = inspect(
    [root, host, { parent: 1, id: '1001', className: 'Edit', nativeHandle: 313 }],
    true,
    false,
    action,
  );
  expect(result.accepted, result.failure ?? undefined).toBe(true);
  expect(result.writes).toBe(action === 'SaveBackup' ? 1 : 0);
  expect(result.invocations).toBe(1);
  expect(result.disposals).toBe(1);
  expect(result.receipt?.ok).toBe(true);
});

it.each([
  'initial-other',
  'changed-handle',
  'changed-host',
  'changed-value',
  'before-save',
  'write-timeout',
])('实际保存遇%s立即停止且不回显原生文本', (mode) => {
  const result = inspect(
    [root, host, { parent: 1, id: '1001', className: 'Edit', nativeHandle: 313 }],
    true,
    false,
    'SaveBackup',
    mode,
  );
  expect(result.accepted).toBe(false);
  expect(result.receipt?.ok).toBe(false);
  expect(result.writes).toBe(
    ['changed-value', 'before-save', 'write-timeout'].includes(mode) ? 1 : 0,
  );
  expect(result.invocations).toBe(0);
  expect(result.disposals).toBe(1);
  expect(result.raw).not.toMatch(/PRIVATE_NATIVE|SECRET\.aibak/);
});

it('唯一host只投影祖先和后代的固定分类，Name和Value均不读取', () => {
  const result = inspect([
    root,
    { parent: 0, id: 'PRIVATE_ANCESTOR_ID', className: 'PRIVATE_CLASS' },
    { ...host, parent: 1 },
    { parent: 2, id: '1001', type: 'Edit', className: 'Edit', pattern: true },
    { parent: 0, id: 'PRIVATE_UNRELATED_ID', forbidDetails: true },
  ]);
  expect(result.accepted).toBe(true);
  expect(result.diagnostic.filenameHostStructure).toMatchObject({
    status: 'complete',
    scannedNodes: 5,
    hostCount: 1,
    ancestorCount: 2,
    descendantCount: 1,
  });
  expect(result.diagnostic.filenameHostStructure.nodes).toEqual([
    expect.objectContaining({ index: 0, parent: -1, relation: 'ancestor', windowClass: 'dialog' }),
    expect.objectContaining({
      index: 1,
      parent: 0,
      relation: 'ancestor',
      automationIdClass: 'other',
      windowClass: 'other',
    }),
    expect.objectContaining({
      index: 2,
      parent: 1,
      relation: 'host',
      automationIdClass: 'file-name-control-host',
      controlTypeClass: 'custom',
      valuePattern: true,
      readOnly: false,
    }),
    expect.objectContaining({
      index: 3,
      parent: 2,
      relation: 'descendant',
      automationIdClass: 'id-1001',
      controlTypeClass: 'edit',
      windowClass: 'edit',
    }),
  ]);
  expect(result.raw).not.toContain('PRIVATE_');
  expect(Buffer.byteLength(result.raw)).toBeLessThan(65536);
});

it.each([0, 2])('%d个host都拒绝局部结构投影', (count) => {
  const result = inspect([root, ...Array.from({ length: count }, () => host)]);
  expect(result.accepted).toBe(false);
  expect(result.diagnostic.filenameHostStructure).toMatchObject({
    status: 'host-nonunique',
    hostCount: count,
    nodes: [],
  });
});

it('模式缺失、只读、禁用、离屏和异PID只记录事实，未知类型只留other', () => {
  const result = inspect([
    root,
    { ...host, pattern: false, enabled: false, offscreen: true, processId: 43 },
    {
      parent: 1,
      id: 'private-id',
      type: 'PRIVATE_TYPE',
      className: 'PRIVATE_CLASS',
      pattern: true,
      readOnly: true,
    },
  ]);
  expect(result.accepted).toBe(true);
  expect(result.diagnostic.filenameHostStructure.nodes[1]).toMatchObject({
    enabled: false,
    offscreen: true,
    sameProcess: false,
    valuePattern: false,
    readOnly: null,
  });
  expect(result.diagnostic.filenameHostStructure.nodes[2]).toMatchObject({
    controlTypeClass: 'other',
    windowClass: 'other',
    readOnly: true,
  });
  expect(result.raw).not.toMatch(/PRIVATE_|private-id/);
});

it.each([512, 513])('整树%d节点含根的预算边界不会被截断为成功', (count) => {
  const result = inspect([
    root,
    host,
    ...Array.from({ length: count - 2 }, () => ({ parent: 0, forbidDetails: true })),
  ]);
  expect(result.accepted).toBe(count === 512);
  expect(result.diagnostic.filenameHostStructure.scannedNodes).toBe(512);
  expect(result.diagnostic.filenameHostStructure.status).toBe(
    count === 512 ? 'complete' : 'tree-budget',
  );
});

it.each([8, 9])('%d层祖先含对话框根的边界必须明确收口', (count) => {
  const ancestors = Array.from({ length: count - 1 }, (_, index) => ({ parent: index }));
  const result = inspect([root, ...ancestors, { ...host, parent: count - 1 }]);
  expect(result.accepted).toBe(count === 8);
  expect(result.diagnostic.filenameHostStructure.status).toBe(
    count === 8 ? 'complete' : 'ancestor-budget',
  );
});

it.each([16, 17])('%d个后代的边界不能把不完整子树当完成', (count) => {
  const result = inspect([root, host, ...Array.from({ length: count }, () => ({ parent: 1 }))]);
  expect(result.accepted).toBe(count === 16);
  expect(result.diagnostic.filenameHostStructure.status).toBe(
    count === 16 ? 'complete' : 'descendant-budget',
  );
});

it('host子树包含全部层级且回执内父序号不引用无关兄弟', () => {
  const result = inspect([
    root,
    host,
    { parent: 0, forbidDetails: true },
    { parent: 1, type: 'ComboBox', className: 'ComboBoxEx32' },
    { parent: 3, type: 'Edit', className: 'Edit', pattern: true },
  ]);
  expect(result.accepted).toBe(true);
  expect(result.diagnostic.filenameHostStructure.nodes.map(({ parent }) => parent)).toEqual([
    -1, 0, 1, 2,
  ]);
  expect(result.diagnostic.filenameHostStructure.descendantCount).toBe(2);
  expect(result.diagnostic.filenameHostStructure.nodes[2]?.windowClass).toBe('combo-box-ex32');
});

it('最大25条局部结构通过真实只读回执序列化且不写入或Invoke', () => {
  const ancestors = Array.from({ length: 7 }, (_, index) => ({ parent: index }));
  const result = inspect(
    [
      root,
      ...ancestors,
      { ...host, parent: 7 },
      { parent: 8, id: '1001', className: 'Edit', nativeHandle: 313 },
      ...Array.from({ length: 15 }, () => ({ parent: 8 })),
    ],
    true,
  );
  expect(result.accepted, result.failure ?? undefined).toBe(true);
  expect(result.receipt?.filenameHostStructure.nodes).toHaveLength(25);
  expect(result.receipt?.filenameHostStructure.nodes[24]?.sameProcess).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(result.receipt))).toBeLessThan(65536);
  expect(result.filenameCalls + result.writes + result.invocations).toBe(0);
});

it('属性读取错误只留下固定分类，不回显异常正文或继续旧选择器', () => {
  const result = inspect([root, { ...host, forbidDetails: true }], true);
  expect(result.accepted).toBe(false);
  expect(result.receipt?.filenameHostStructure.status).toBe('read-failed');
  expect(result.receipt?.filenameHostStructure.nodes).toEqual([]);
  expect(result.raw).not.toContain('UNRELATED_PATTERN_MUST_NOT_BE_READ');
  expect(result.filenameCalls + result.buttonCalls).toBe(0);
});
