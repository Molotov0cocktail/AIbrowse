import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

interface Observation {
  type: 'edit' | 'comboBox' | 'other';
  id: string;
  enabled: boolean;
  pattern: boolean;
  readOnly: boolean;
  value: string;
}

const exact: Observation = {
  type: 'edit',
  id: '1001',
  enabled: true,
  pattern: true,
  readOnly: false,
  value: 'AIbrowse-backup.aibak',
};

// Extract the actual selection function. Only UIA ports are replaced by in-memory types.
// No UIAutomation assembly, windows, native Job, Electron, or profile is opened.
function select(rows: Observation[], repeat = 1) {
  const command = `$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest;
    [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);
    Add-Type -TypeDefinition @'
namespace Windows.Automation {
  public static class ControlType {
    public static readonly string Edit="edit", ComboBox="comboBox";
  }
  public sealed class ValueState { public bool IsReadOnly; public string Value; }
  public sealed class ValuePattern {
    public static readonly object Pattern=new object();
    public ValueState Current;
  }
  public sealed class NodeState {
    public string ControlType, AutomationId; public bool IsEnabled;
    public string Name { get { throw new System.Exception("PRIVATE_NAME_MUST_NOT_BE_READ"); } }
  }
  public sealed class SyntheticNode {
    public NodeState Current; public ValuePattern Value;
    public bool TryGetCurrentPattern(object id, out object pattern) {
      if (!object.ReferenceEquals(id, ValuePattern.Pattern)) throw new System.Exception("wrong pattern");
      pattern=Value; return Value!=null;
    }
  }
}
'@;
    $source=[IO.File]::ReadAllText($env:AIBROWSE_REVIEW_UI_SCRIPT);
    $tokens=$null; $errors=$null;
    $tree=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);
    if($errors.Count -ne 0){throw '脚本解析失败'};
    foreach($name in @('Get-FilenameAutomationIdClass','Get-FilenameValueClass','New-FilenameControlTypeDiagnostic','New-FilenameQualificationDiagnostic','Add-FilenameQualificationObservation','Filename-Input')) {
      $functions=@($tree.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true));
      if($functions.Count -ne 1){throw '受审实际函数不唯一'};
      . ([scriptblock]::Create($functions[0].Extent.Text));
    };
    $script:nodes=@(foreach($iteration in 1..([int]$env:AIBROWSE_REVIEW_REPEAT)) { foreach($row in (ConvertFrom-Json $env:AIBROWSE_REVIEW_ROWS)) {
      $node=[Windows.Automation.SyntheticNode]::new();
      $node.Current=[Windows.Automation.NodeState]::new();
      $node.Current.ControlType=$row.type; $node.Current.AutomationId=$row.id; $node.Current.IsEnabled=$row.enabled;
      if($row.pattern) {
        $node.Value=[Windows.Automation.ValuePattern]::new();
        $node.Value.Current=[Windows.Automation.ValueState]::new();
        $node.Value.Current.IsReadOnly=$row.readOnly; $node.Value.Current.Value=$row.value;
      };
      $node;
    }});
    function Descendants($Root){return $script:nodes};
    $diagnostic=[ordered]@{}; $accepted=$false; $selected=-1; $failure=$null;
    try {
      $chosen=Filename-Input $null $diagnostic;
      $accepted=$true;
      for($i=0;$i -lt $script:nodes.Count;$i++) {
        if([object]::ReferenceEquals($chosen.Element,$script:nodes[$i])){$selected=$i};
      };
    } catch { $failure=$_.Exception.Message };
    [ordered]@{accepted=$accepted;selected=$selected;failure=$failure;diagnostic=$diagnostic} | ConvertTo-Json -Depth 8 -Compress;`;
  const child = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: {
      ...process.env,
      AIBROWSE_REVIEW_UI_SCRIPT: resolve('tools/data-qualification/product-transfer/ui-driver.ps1'),
      AIBROWSE_REVIEW_ROWS: JSON.stringify(rows),
      AIBROWSE_REVIEW_REPEAT: String(repeat),
    },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  expect(child.status, child.stderr).toBe(0);
  const result = JSON.parse(child.stdout.trim()) as {
    accepted: boolean;
    selected: number;
    failure: string | null;
    diagnostic: {
      filenameQualification: {
        scannedNodes: number;
        qualifiedCandidate: number;
        controlType: Record<string, { total: number; value: Record<string, number> }>;
      };
    };
  };
  return { ...result, raw: child.stdout };
}

it.each([0, 1, 2])('实际Filename-Input严格识别%d个候选并在失败前保存计数', (count) => {
  const result = select(Array.from({ length: count }, () => exact));
  expect(result.accepted).toBe(count === 1);
  expect(result.selected).toBe(count === 1 ? 0 : -1);
  expect(result.diagnostic.filenameQualification.scannedNodes).toBe(count);
  expect(result.diagnostic.filenameQualification.qualifiedCandidate).toBe(count);
  expect(result.failure).toBe(count === 1 ? null : '文件名输入未取得唯一默认值与ValuePattern资格');
});

it('实际选择不会接受禁用、只读、缺模式、ComboBox、stem或大小写变体', () => {
  const rejected: Observation[] = [
    { ...exact, enabled: false },
    { ...exact, readOnly: true },
    { ...exact, pattern: false },
    { ...exact, type: 'comboBox' },
    { ...exact, type: 'other' },
    { ...exact, value: 'AIbrowse-backup' },
    { ...exact, value: 'aibrowse-backup.aibak' },
    { ...exact, value: '' },
  ];
  const result = select(rejected);
  expect(result.accepted).toBe(false);
  expect(result.diagnostic.filenameQualification.qualifiedCandidate).toBe(0);
  expect(result.diagnostic.filenameQualification.scannedNodes).toBe(8);
  expect(result.diagnostic.filenameQualification.controlType.edit.total).toBe(6);
  expect(result.diagnostic.filenameQualification.controlType.comboBox.total).toBe(1);
  expect(result.diagnostic.filenameQualification.controlType.other.total).toBe(1);
});

it('实际选择只返回精确Edit，私有值和未知ID只留固定分类且不读取Name', () => {
  const result = select([
    { ...exact, type: 'comboBox', id: 'FileNameControlHost', value: 'AIbrowse-backup' },
    { ...exact, id: 'PRIVATE_UNKNOWN_ID', value: 'C:\\PRIVATE_USER\\PRIVATE_FILE.aibak' },
    { ...exact, id: 'PRIVATE_UNKNOWN_ID' },
  ]);
  expect(result.accepted).toBe(true);
  expect(result.selected).toBe(2);
  expect(result.diagnostic.filenameQualification.qualifiedCandidate).toBe(1);
  expect(result.diagnostic.filenameQualification.controlType.edit.value).toEqual({
    empty: 0,
    exactDefault: 1,
    exactStem: 0,
    other: 1,
  });
  expect(result.raw).not.toMatch(/PRIVATE_|C:\\/);
});

it('512个输入的实际分类回执有界，重复候选仍全部拒绝', () => {
  const result = select([exact], 512);
  expect(result.accepted).toBe(false);
  expect(result.diagnostic.filenameQualification.scannedNodes).toBe(512);
  expect(result.diagnostic.filenameQualification.qualifiedCandidate).toBe(512);
  expect(Buffer.byteLength(result.raw, 'utf8')).toBeLessThan(65536);
});
