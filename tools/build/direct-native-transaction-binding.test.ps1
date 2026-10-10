param(
  [string]$Source = (Join-Path $PSScriptRoot 'direct-native-transaction.ps1')
)
$ErrorActionPreference = 'Stop'
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw '事务录制器源码无法解析' }
$wanted = @('Require','Hash-Bytes','Read-BoundJson','Require-Closed','Require-Bool','Require-Integer','Require-String','Require-Sha','Require-Artifact','Require-ReportCandidate')
$functionText = @{}
foreach ($name in $wanted) {
  $definitions = @($ast.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name
  }, $true))
  if ($definitions.Count -ne 1) { throw ('辅助函数不唯一：' + $name) }
  $functionText[$name] = $definitions[0].Extent.Text
  Invoke-Expression $definitions[0].Extent.Text
}
function Rejects([scriptblock]$Case, [string]$Label) {
  try { & $Case; throw ('反例被接受：' + $Label) }
  catch { if ($_.Exception.Message -like '反例被接受：*') { throw }; Write-Output ('REJECTED:' + $Label) }
}
Require-Bool $true 'positive bool'
Require-Integer 1 'positive integer'
Require-String 'PASS' 'positive string'
Require-Sha ('a' * 64) 'positive sha'
Rejects { Require-Bool 'true' 'string true' } 'string-true'
Rejects { Require-Bool 1 'numeric true' } 'numeric-one'
Rejects { Require-Bool 'false' 'string false' } 'string-false'
Rejects { Require-Integer '1' 'string integer' } 'string-integer'
Rejects { Require-Closed ([pscustomobject]@{ schema = 1; extra = 1 }) @('schema') 'closed' } 'unknown-field'
$candidate = [pscustomobject]@{
  product = '{00000000-0000-0000-0000-000000000001}'
  artifacts = [pscustomobject]@{
    exe = [pscustomobject]@{ sha256 = ('a' * 64); bytes = 13 }
    msi = [pscustomobject]@{ sha256 = ('b' * 64); bytes = 17 }
  }
}
$candidateReport = [pscustomobject]@{
  candidate = [pscustomobject]@{
    productCode = $candidate.product
    exe = $candidate.artifacts.exe
    msi = $candidate.artifacts.msi
  }
}
Require-ReportCandidate $candidateReport 'positive report'
$candidateReport.candidate.productCode = @($candidate.product, '{00000000-0000-0000-0000-000000000002}')
Rejects { Require-ReportCandidate $candidateReport 'array product' } 'array-product-code'
$sourceText = [IO.File]::ReadAllText($Source)
foreach ($literal in @('final-clean-build-review.json','final-behavior-applicability-review.json','ordinal4-retirement-evidence.json','ordinal4RetirementEvidenceSha256')) {
  Require $sourceText.Contains($literal) ('缺少固定绑定：' + $literal)
}
Require (([regex]::Matches($sourceText, '\.durationMs -ge 0')).Count -ge 3) '事务耗时缺少非负数门'
$boundJsonText = $functionText['Read-BoundJson']
$lengthGate = $boundJsonText.IndexOf('$file.Length -gt 0')
$allocation = $boundJsonText.IndexOf('$bytes = New-Object byte[]')
Require (!$boundJsonText.Contains('ReadAllBytes') -and $boundJsonText.Contains("[IO.File]::Open(`$Path, 'Open', 'Read', 'Read')") -and $lengthGate -ge 0 -and $allocation -gt $lengthGate -and $boundJsonText.Contains('$file.ReadByte() -eq -1')) '有界JSON必须先核长度再分配并检查EOF'
Require (!$sourceText.Contains('ReadAllBytes') -and $sourceText.Contains("`$manifestInput = Read-BoundJson `$manifestPath 524288 '原矩阵清单'") -and $sourceText.Contains('$manifestInput.Sha256') -and $sourceText.Contains('$manifest = $manifestInput.Value')) '原清单必须复用同一有界字节输入'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('aibrowse-bound-json-' + [guid]::NewGuid().ToString('N') + '.json')
try {
  [IO.File]::WriteAllText($temporary, '{"schema":1,"verified":true}', [Text.UTF8Encoding]::new($false))
  $exactBytes = (Get-Item -LiteralPath $temporary).Length
  $bound = Read-BoundJson $temporary $exactBytes 'bound'
  $expected = Hash-Bytes $bound.Bytes
  [IO.File]::WriteAllText($temporary, '{"schema":1,"verified":false}', [Text.UTF8Encoding]::new($false))
  Require ($bound.Sha256 -ceq $expected -and $bound.Value.verified -eq $true) '同一字节缓冲绑定失败'
  Rejects { Read-BoundJson $temporary 1 'over-budget' } '超预算先拒绝'
  $probeText = $boundJsonText.Replace('function Read-BoundJson', 'function Read-BoundJson-AllocationProbe').Replace('$bytes = New-Object byte[] ([int]$file.Length)', "throw 'ALLOCATION_REACHED'")
  Require ($probeText.Contains("throw 'ALLOCATION_REACHED'") -and !$probeText.Contains('$bytes = New-Object byte[]')) '分配替身未生效'
  Invoke-Expression $probeText
  try { Read-BoundJson-AllocationProbe $temporary 1 'probe-over-budget'; throw '超预算替身被接受' }
  catch { Require ($_.Exception.Message -like '*字节超过预算*') '超预算输入在分配前未拒绝' }
  try { Read-BoundJson-AllocationProbe $temporary 4096 'probe-valid'; throw '分配替身未执行' }
  catch { Require ($_.Exception.Message -ceq 'ALLOCATION_REACHED') '分配替身正控失败' }
}
finally { [IO.File]::Delete($temporary) }
Write-Output 'PASS：严格JSON类型反例与同一字节缓冲绑定'
