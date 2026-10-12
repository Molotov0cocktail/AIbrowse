$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../maintenance/enter-project-environment.ps1')
Add-Type -Path (Join-Path $PSScriptRoot 'resources-native.cs')
$probe = [AIbrowse.LegacyResources.ProcessProbe]::new($PID)
$events = [Collections.Generic.List[Threading.EventWaitHandle]]::new()
try {
  $warm = $probe.Capture()
  $before = $probe.Capture()
  for ($index = 0; $index -lt 32; $index++) { $events.Add([Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset)) }
  $during = $probe.Capture()
  foreach ($event in $events) { $event.Dispose() }
  $events.Clear()
  $after = $probe.Capture()
  $added = $during.Types['Event'] - $before.Types['Event']
  $removed = $during.Types['Event'] - $after.Types['Event']
  [pscustomobject]@{ added = $added; removed = $removed; before = $before; during = $during; after = $after } | ConvertTo-Json -Depth 8
  if ($added -lt 32 -or $removed -ne 32) { throw '句柄类型探针对合成 Event 增删不敏感' }
} finally {
  foreach ($event in $events) { $event.Dispose() }
  $probe.Dispose()
}
