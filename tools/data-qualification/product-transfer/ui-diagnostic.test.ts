import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

interface QualificationDiagnostic {
  version: number;
  scannedNodes: number;
  controlType: Record<
    'edit' | 'comboBox' | 'other',
    {
      total: number;
      enabled: number;
      valuePattern: number;
      writableValuePattern: number;
      value: { empty: number; exactDefault: number; exactStem: number; other: number };
      automationId: {
        empty: number;
        id1001: number;
        fileNameControlHost: number;
        other: number;
      };
    }
  >;
  qualifiedCandidate: number;
}

function invoke(observations: string): { diagnostic: QualificationDiagnostic; raw: string } {
  const command = `$ErrorActionPreference='Stop';
    Set-StrictMode -Version Latest;
    $source=[IO.File]::ReadAllText($env:AIBROWSE_UI_SCRIPT);
    $tokens=$null; $errors=$null;
    $tree=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);
    if($errors.Count -ne 0){throw '脚本解析失败'};
    foreach($name in @('Get-FilenameAutomationIdClass','Get-FilenameValueClass','New-FilenameControlTypeDiagnostic','New-FilenameQualificationDiagnostic','Add-FilenameQualificationObservation')) {
      $nodes=@($tree.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq $name},$true));
      if($nodes.Count -ne 1){throw "纯诊断函数缺失: $name"};
      . ([scriptblock]::Create($nodes[0].Extent.Text));
    };
    $state=New-FilenameQualificationDiagnostic;
    ${observations}
    $state | ConvertTo-Json -Depth 5 -Compress;`;
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: {
      ...process.env,
      AIBROWSE_UI_SCRIPT: resolve('tools/data-qualification/product-transfer/ui-driver.ps1'),
    },
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  expect(result.status, result.stderr).toBe(0);
  return {
    diagnostic: JSON.parse(result.stdout.trim()) as QualificationDiagnostic,
    raw: result.stdout,
  };
}

it('文件名资格失败保留分层计数且未知ID与私有文本不进入诊断', () => {
  const secret = 'C:\\Users\\private-user\\secret-file.aibak';
  const { diagnostic, raw } = invoke(`
    Add-FilenameQualificationObservation $state 'other' $null $false $false $null $null;
    Add-FilenameQualificationObservation $state 'edit' '' $false $false $null $null;
    Add-FilenameQualificationObservation $state 'edit' '1001' $true $false $null $null;
    Add-FilenameQualificationObservation $state 'comboBox' 'FileNameControlHost' $true $true $false 'AIbrowse-backup';
    Add-FilenameQualificationObservation $state 'edit' '${secret.replaceAll("'", "''")}' $true $true $false '${secret.replaceAll("'", "''")}';
    Add-FilenameQualificationObservation $state 'edit' '1001' $true $true $false 'AIbrowse-backup.aibak';`);
  expect(diagnostic.version).toBe(1);
  expect(diagnostic.scannedNodes).toBe(6);
  expect(diagnostic.controlType.other).toEqual({
    total: 1,
    enabled: 0,
    valuePattern: 0,
    writableValuePattern: 0,
    value: { empty: 0, exactDefault: 0, exactStem: 0, other: 0 },
    automationId: { empty: 1, id1001: 0, fileNameControlHost: 0, other: 0 },
  });
  expect(diagnostic.controlType.comboBox).toEqual({
    total: 1,
    enabled: 1,
    valuePattern: 1,
    writableValuePattern: 1,
    value: { empty: 0, exactDefault: 0, exactStem: 1, other: 0 },
    automationId: { empty: 0, id1001: 0, fileNameControlHost: 1, other: 0 },
  });
  expect(diagnostic.controlType.edit).toEqual({
    total: 4,
    enabled: 3,
    valuePattern: 2,
    writableValuePattern: 2,
    value: { empty: 0, exactDefault: 1, exactStem: 0, other: 1 },
    automationId: { empty: 1, id1001: 2, fileNameControlHost: 0, other: 1 },
  });
  expect(diagnostic.qualifiedCandidate).toBe(1);
  expect(raw).not.toContain('private-user');
  expect(raw).not.toContain('secret-file');
});

it.each([
  { matches: 0, expected: 0 },
  { matches: 1, expected: 1 },
  { matches: 2, expected: 2 },
])('诊断可甄别 $matches 个精确候选且不改变唯一性门槛', ({ matches, expected }) => {
  const rows = Array.from(
    { length: matches },
    () =>
      "Add-FilenameQualificationObservation $state 'edit' '1001' $true $true $false 'AIbrowse-backup.aibak';",
  ).join('\n');
  const { diagnostic } = invoke(rows);
  expect(diagnostic.qualifiedCandidate).toBe(expected);
});

it('ComboBox或隐藏扩展名只进入诊断，不计为合格Edit候选', () => {
  const { diagnostic } = invoke(`
    Add-FilenameQualificationObservation $state 'comboBox' 'FileNameControlHost' $true $true $false 'AIbrowse-backup.aibak';
    Add-FilenameQualificationObservation $state 'edit' '1001' $true $true $false 'AIbrowse-backup';`);
  expect(diagnostic.controlType.comboBox.value.exactDefault).toBe(1);
  expect(diagnostic.controlType.edit.value.exactStem).toBe(1);
  expect(diagnostic.qualifiedCandidate).toBe(0);
});

it('成功回执也不保留文件名控件的原始Name或未知AutomationId', () => {
  const source = readFileSync(
    resolve('tools/data-qualification/product-transfer/ui-driver.ps1'),
    'utf8',
  );
  expect(source).not.toContain('filenameName');
  expect(source).not.toContain('filenameId =');
  expect(source).toContain('filenameIdClass = Get-FilenameAutomationIdClass');
});
