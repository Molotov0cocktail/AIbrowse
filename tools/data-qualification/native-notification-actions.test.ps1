$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'native-notification-actions.ps1'
$text = [IO.File]::ReadAllText($source)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw '通知动作源码无法解析' }
function Need([bool]$Value, [string]$Message) { if (!$Value) { throw $Message } }
$functions = @{}
foreach ($name in @('Assert-App','Trusted-Document','Browser-Document','Find-TargetCard','Same-TargetCardIdentity','Close-NotificationCenter')) {
  $found = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $true))
  Need ($found.Count -eq 1) ('函数不唯一：' + $name)
  $functions[$name] = $found[0].Extent.Text
}
Need ($functions['Assert-App'].Contains('$ExpectedImageSha256')) '每步App身份未绑定选定映像摘要'
Need ($functions['Browser-Document'].Contains('监控此页') -and $functions['Browser-Document'].Contains('← 返回浏览')) '浏览视图语义门缺失'
$card = $functions['Find-TargetCard']
$boundary = $card.IndexOf('$elements=')
$bodyRead = $card.IndexOf('$bodyCondition=')
Need ($boundary -ge 0 -and $bodyRead -gt $boundary -and !$card.Contains('Nodes $card') -and !$card.Contains('$card.Current.Name')) '单卡边界必须先于卡片文本读取'
Need ($card.Contains('$elements.Count -le 24') -and $card.Contains('$bounds.Contains($childBounds)') -and $card.Contains('AIbrowse 监控提醒') -and $card.Contains('受保护来源发生变化')) '目标卡片节点、几何或固定文本门缺失'
Need ($card.Contains('$card.GetRuntimeId()') -and $card.Contains('$runtimeId.Count -gt 32') -and $card.Contains('runtimeId=[int[]]$runtimeId.Clone()')) '目标卡片RuntimeId有界读取缺失'
$sameCard = $functions['Same-TargetCardIdentity']
Invoke-Expression $sameCard
$first = [pscustomobject]@{status='ready';shellPid=41;shellStartTicks=42;shellPath='C:\Windows\SystemApps\ShellExperienceHost.exe';nodeCount=6;left=10;top=20;width=300;height=120;runtimeId=[int[]](1,2,3)}
$same = [pscustomobject]@{status='ready';shellPid=41;shellStartTicks=42;shellPath='C:\Windows\SystemApps\ShellExperienceHost.exe';nodeCount=6;left=10;top=20;width=300;height=120;runtimeId=[int[]](1,2,3)}
$replacement = [pscustomobject]@{status='ready';shellPid=41;shellStartTicks=42;shellPath='C:\Windows\SystemApps\ShellExperienceHost.exe';nodeCount=6;left=10;top=20;width=300;height=120;runtimeId=[int[]](9,8,7)}
Need (Same-TargetCardIdentity $first $same) '相同RuntimeId实体正控失败'
Need (!(Same-TargetCardIdentity $first $replacement)) '同位同文案替换卡片未拒绝'
Need (!(Same-TargetCardIdentity $first ([pscustomobject]@{status='ready';shellPid=41;shellStartTicks=42;shellPath='C:\Windows\SystemApps\ShellExperienceHost.exe';nodeCount=6;left=10;top=20;width=300;height=120;runtimeId=[int[]]@()}))) '空RuntimeId未拒绝'
Need (!$text.Contains('40000') -and !$text.Contains('cardNodes') -and !$text.Contains('cardRootName')) '旧无界文本或40秒路线未退役'
$toastStart = $text.IndexOf("if(`$Action -eq 'toast')")
$historicalStart = $text.IndexOf("elseif(`$Action -eq 'historical-observe')", $toastStart)
Need ($toastStart -ge 0 -and $historicalStart -gt $toastStart) '旧toast退役分支缺失'
$toast = $text.Substring($toastStart, $historicalStart - $toastStart)
Need ($toast.Contains('legacy 40-second toast automation is retired') -and !$toast.Contains('.Invoke()')) '旧toast必须受控拒绝'
$liveStart = $text.IndexOf("elseif(`$Action -eq 'live-toast')", $historicalStart)
$closeStart = $text.IndexOf("elseif(`$Action -eq 'close')", $liveStart)
Need ($liveStart -gt $historicalStart -and $closeStart -gt $liveStart) 'live-toast分支缺失'
$live = $text.Substring($liveStart, $closeStart - $liveStart)
Need (([regex]::Matches($live, 'Find-TargetCard')).Count -eq 2 -and ([regex]::Matches($live, 'Browser-Document')).Count -eq 2) 'live-toast观察与动作前复验次数不闭合'
Need ($live.Contains('$liveClock.ElapsedMilliseconds -lt 10000') -and $live.Contains('Same-TargetCardIdentity $target $again') -and $live.Contains('runtimeId=@($again.runtimeId)') -and $live.Contains('trustedApplicationRootAfterInvoke') -and $live.Contains('routeVerified=$false') -and $live.Contains('NOT_ASSERTED')) 'live-toast预算、identity、边界或诚实路由结论缺失'
Need ($live.IndexOf('$again=Find-TargetCard') -lt $live.IndexOf('.Invoke()') -and $live.Contains('Close-NotificationCenter')) 'live-toast未在动作前复验或finally未关闭中心'
Write-Output 'PASS：通知单卡边界、动作前复验、旧toast退役与路由诚实边界'
