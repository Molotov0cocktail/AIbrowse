$ErrorActionPreference = 'Stop'
$taskFixedExecutables = @('C:\Program Files (x86)\Internet Download Manager\IDMan.exe', 'C:\Program Files\Internet Download Manager\IDMan.exe')
$taskProcesses = @(Get-Process -Name IDMan -ErrorAction SilentlyContinue | ForEach-Object {
  $taskPath = $null; $taskPathError = $null
  try { $taskPath = $_.MainModule.FileName } catch { $taskPathError = $_.Exception.GetType().Name }
  [ordered]@{ id = $_.Id; sessionMatches = $_.SessionId -eq [Diagnostics.Process]::GetCurrentProcess().SessionId; fixedPathMatches = $taskPath -in $taskFixedExecutables; pathReadFailure = $taskPathError; responding = $_.Responding; hasMainWindow = $_.MainWindowHandle -ne [IntPtr]::Zero }
})
$taskInstallations = @($taskFixedExecutables | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | ForEach-Object {
  $taskFile = Get-Item -LiteralPath $_
  [ordered]@{ fixedLocation = [Array]::IndexOf($taskFixedExecutables, $_); bytes = $taskFile.Length; version = $taskFile.VersionInfo.FileVersion; sha256 = (Get-FileHash -LiteralPath $_).Hash.ToLowerInvariant(); signatureStatus = (Get-AuthenticodeSignature -LiteralPath $_).Status.ToString() }
})
$taskSettings = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\DownloadManager', $false)
$taskMatches = @()
$taskShowsStart = $null
try {
  if ($taskSettings) {
    $taskShowsStart = $taskSettings.GetValue('StartDlgShowing', $null) -eq 1
    foreach ($taskName in @('ExceptionServers', 'PanelExceptionServers')) {
      $taskValue = [string]$taskSettings.GetValue($taskName, '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $taskMatched = $false
      foreach ($taskPattern in ($taskValue -split '[\s;,|]+' | Where-Object { $_ })) {
        try {
          if ('127.0.0.1' -like $taskPattern -or 'http://127.0.0.1:49152/idm-probe-00000000000000000000000000000000.txt' -like $taskPattern) { $taskMatched = $true }
        } catch { }
      }
      $taskMatches += [ordered]@{ name = $taskName; explicitLoopback = $taskValue -match '(?i)127\.0\.0\.1|localhost|\[::1\]'; wildcardLoopback = $taskMatched }
      $taskValue = $null
    }
  }
} finally { if ($taskSettings) { $taskSettings.Dispose() } }
$taskCom = @(foreach ($taskView in @([Microsoft.Win32.RegistryView]::Registry32, [Microsoft.Win32.RegistryView]::Registry64)) {
  $taskBase = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot, $taskView)
  try {
    $taskKey = $taskBase.OpenSubKey('CLSID\{AC746233-E9D3-49CD-862F-068F7B7CCCA4}\LocalServer32', $false)
    try { [ordered]@{ view = $taskView.ToString(); present = $null -ne $taskKey; fixedPathMatches = $taskKey -and ([string]$taskKey.GetValue('')).Trim('"') -in $taskFixedExecutables } }
    finally { if ($taskKey) { $taskKey.Dispose() } }
  } finally { $taskBase.Dispose() }
})
[ordered]@{ observedAt = [DateTime]::UtcNow.ToString('O'); processes = $taskProcesses; installations = $taskInstallations; comRegistration = $taskCom; startDialogEnabled = $taskShowsStart; ignoreMatchProjection = $taskMatches; settingsChanged = 0; downloadListReads = 0; comCalls = 0 } | ConvertTo-Json -Depth 5
