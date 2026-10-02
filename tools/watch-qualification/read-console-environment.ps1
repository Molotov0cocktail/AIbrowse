param()
$ErrorActionPreference = 'Stop'

# Read-only Windows facts; no desktop, power, account or display settings are changed.
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class AIbrowseConsoleFacts {
  [DllImport("kernel32.dll")]
  public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);
}
'@

$processSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
$consoleSession = [AIbrowseConsoleFacts]::WTSGetActiveConsoleSessionId()
$remoteSession = [AIbrowseConsoleFacts]::GetSystemMetrics(0x1000) -ne 0
$interactive = [Environment]::UserInteractive
@{
  schema = 'watch-console-environment-v1'
  recordedUtc = [DateTime]::UtcNow.ToString('o')
  processSessionId = $processSession
  activeConsoleSessionId = $consoleSession
  userInteractive = $interactive
  remoteDesktopSession = $remoteSession
  attachedLocalConsole = ($consoleSession -ne [uint32]::MaxValue -and $consoleSession -eq $processSession -and $interactive -and -not $remoteSession)
  scope = '当前进程所属会话；不判定GPU、亮度、其它前台负载或远程协助软件'
} | ConvertTo-Json
