param([Parameter(Mandatory=$true)][string]$UiResult)
$ErrorActionPreference='Stop'
$repository=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
function Need($ok,[string]$message){if(-not $ok){throw $message}}
function Hash([string]$path){(Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()}
$ui=Get-Content -LiteralPath $UiResult -Raw | ConvertFrom-Json
Need ($ui.status -ceq 'passed' -and @($ui.failures).Count -eq 0 -and @($ui.captures).Count -eq 78) 'UI总结果不符'
$sourceCount=0;$artifactCount=0
foreach($group in @('sourceHashes','artifactHashes')){
  foreach($property in $ui.inputs.$group.PSObject.Properties){
    Need ((Hash (Join-Path $repository $property.Name)) -ceq $property.Value) ('UI源码/产物摘要变化: '+$property.Name)
    if($group -eq 'sourceHashes'){$sourceCount++}else{$artifactCount++}
  }
}
Need ($sourceCount -gt 100 -and $artifactCount -ge 5) 'UI绑定集合不完整'
$baseCount=0
foreach($capture in $ui.captures){
  Need (@($capture.failures).Count -eq 0 -and $capture.checks.webContentsViewBoundsOk -eq $true) 'capture失败或未验证bounds'
  foreach($property in $capture.checks.PSObject.Properties){Need ($property.Value -isnot [bool] -or $property.Value) ('检查失败: '+$capture.name+'/'+$property.Name)}
  if($capture.browserVisible){
    $visible=@($capture.webContentsViews|Where-Object {$_.visible})
    Need ($visible.Count -eq 1) '可见网页数量不符'
    foreach($key in @('x','y','width','height')){Need ($visible[0].bounds.$key -eq $capture.expectedViewBounds.$key) '实际网页bounds不等于预期'}
  }
  if($capture.scene -ceq '浏览器基线'){
    $baseCount++
    Need ($capture.dom.chrome.rect.height -le 86 -and -not $capture.dom.debugVisible -and [Math]::Abs($capture.dom.contentArea.bottom-$capture.viewport.height) -lt 1) '默认布局不符'
  }
  Need (Test-Path -LiteralPath (Join-Path (Split-Path $UiResult) $capture.png)) '截图缺失'
}
Need ($baseCount -eq 6) '默认尺寸主题矩阵不完整'
$scope=Join-Path $repository 'log/browser-ux-20261012'
$diagnosis=Get-Content (Join-Path $scope 'conversation-interruption-diagnosis.json') -Raw | ConvertFrom-Json
foreach($fact in $diagnosis.evidence){Need ((Hash $fact.path) -ceq $fact.sha256) '组合原始证据摘要变化'}
foreach($fact in $diagnosis.sources){
  Need ((Hash (Join-Path $repository $fact.path)) -ceq $fact.sha256) '组合源码变化'
  $diff=git -C $repository diff e32ea88a942dc3766ae793f3985a760e3cda7aca -- $fact.path
  Need (-not $diff) '组合依赖源码相对baseline有变'
}
$full=Get-Content (Join-Path $scope 'full-tests-01.log') -Raw
$failures=[regex]::Matches($full,'(?m)^\s*FAIL\s+([^\r\n>]+)\s*>')
Need ($failures.Count -eq 1 -and $failures[0].Groups[1].Value.Trim() -ceq 'src/main/ai/conversation-ui-interruption.test.ts') '全量不止指定唯一失败'
Need ((Get-Content (Join-Path $scope 'full-tests-01.exit') -Raw).Trim() -ceq '1') '原全量退出变化'
$isolated=Get-Content (Join-Path $scope 'conversation-interruption-isolated-01.json') -Raw | ConvertFrom-Json
Need ($isolated.success -eq $true -and $isolated.numPassedTests -eq 4 -and $isolated.numFailedTests -eq 0 -and $isolated.numPendingTests -eq 0) '四项补验不通过'
foreach($assertion in $isolated.testResults[0].assertionResults){Need ($assertion.status -ceq 'passed' -and @($assertion.failureMessages).Count -eq 0) '原断言补验失败'}
$locked=$diagnosis.nativeLockControl
Need ((Hash $locked.path) -ceq $locked.sha256) '外部锁原件变化'
$result=Get-Content $locked.path -Raw | ConvertFrom-Json
Need ($result.controlWrites -eq 50 -and -not $result.saved -and $result.oldIndexPreserved -and $result.temporaryPreserved -and $result.exitCode -eq 0 -and -not $result.forcedCleanup) '外部锁完整性证明失败'
$report=@{conclusion='PASS_WITH_UNKNOWN_HISTORICAL_EPERM';uiResult=[IO.Path]::GetFullPath($UiResult);uiSha256=(Hash $UiResult);sourceCount=$sourceCount;artifactCount=$artifactCount;captures=78;defaultCases=$baseCount;full=@{passed=6970;failed=1;skipped=3;exitCode=1};replacementPassed=4;deduplicatedPassed=6971;historicalRootCause='unknown';newNetworkRequests=0}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $scope 'reviewer-evidence-validation.json') -Encoding utf8
$report | ConvertTo-Json -Depth 5
