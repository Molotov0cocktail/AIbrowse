param([Parameter(Mandatory)][string]$Token, [switch]$InspectOnly, [switch]$ReadSmallDialog, [switch]$SelfTest)
$ErrorActionPreference = 'Stop'
if ($Token -notmatch '^idm-probe-[a-f0-9]{32}$') { throw '探针标记非法' }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
public static class IdmProbeDialog {
  private delegate bool Callback(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr data);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr window, Callback callback, IntPtr data);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr param, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr one, IntPtr two);
  [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  private static string Text(IntPtr window) {
    var text = new StringBuilder(8192); UIntPtr result;
    if (SendMessageTimeout(window, 0x000d, new UIntPtr(8192), text, 2, 200, out result) == IntPtr.Zero) return "";
    return text.ToString();
  }
  private static string ClassName(IntPtr window) {
    var text = new StringBuilder(256); GetClassName(window, text, 256); return text.ToString();
  }
  private static bool ButtonLabel(string value, bool start) {
    value = value.Replace("&", "").Trim();
    return Regex.IsMatch(value, start ? @"^(开始下载|Start Download)(\([A-Za-z]\))?$" : @"^(取消|Cancel)(\([A-Za-z]\))?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
  }
  private static bool IsConfirmation(string className, bool visible, bool found, bool start, bool cancel) {
    return className == "#32770" && visible && found && start && cancel;
  }
  public static bool SelfTest() {
    return IsConfirmation("#32770", true, true, true, true)
      && !IsConfirmation("IDMMainWindow", true, true, true, true)
      && !IsConfirmation("#32770", false, true, true, true)
      && !IsConfirmation("#32770", true, false, true, true)
      && !IsConfirmation("#32770", true, true, false, true)
      && !IsConfirmation("#32770", true, true, true, false)
      && ButtonLabel("开始下载(&S)", true) && ButtonLabel("&Start Download", true)
      && ButtonLabel("取消(&C)", false) && ButtonLabel("Cancel", false)
      && !ButtonLabel("Start Download completed", true) && !ButtonLabel("Cancelled", false);
  }
  public static long Find(string token) {
    var allowed = new HashSet<uint>();
    foreach (var process in Process.GetProcessesByName("IDMan")) using (process) {
      try {
        string path = process.MainModule.FileName;
        if (String.Equals(path, @"C:\Program Files (x86)\Internet Download Manager\IDMan.exe", StringComparison.OrdinalIgnoreCase) || String.Equals(path, @"C:\Program Files\Internet Download Manager\IDMan.exe", StringComparison.OrdinalIgnoreCase)) allowed.Add((uint)process.Id);
      } catch { }
    }
    long match = 0;
    EnumWindows(delegate(IntPtr window, IntPtr unused) {
      uint pid; GetWindowThreadProcessId(window, out pid); if (!allowed.Contains(pid)) return true;
      string className = ClassName(window); bool visible = IsWindowVisible(window);
      if (className != "#32770" || !visible) return true;
      bool found = Text(window).IndexOf(token, StringComparison.Ordinal) >= 0, start = false, cancel = false;
      EnumChildWindows(window, delegate(IntPtr child, IntPtr ignored) {
        string value = Text(child);
        if (value.IndexOf(token, StringComparison.Ordinal) >= 0) found = true;
        if (ClassName(child) == "Button" && IsWindowVisible(child)) { start |= ButtonLabel(value, true); cancel |= ButtonLabel(value, false); }
        return true;
      }, IntPtr.Zero);
      if (IsConfirmation(className, visible, found, start, cancel)) { if (match != 0) {match = -1;return false;} match = window.ToInt64(); }
      return true;
    }, IntPtr.Zero);
    return match;
  }
  public static bool Close(long handle, string token) {
    if (handle <= 0 || Find(token) != handle) return false;
    return PostMessage(new IntPtr(handle), 0x0010, IntPtr.Zero, IntPtr.Zero);
  }
  public static bool Exists(long handle) { return IsWindow(new IntPtr(handle)); }
  public static string Inspect() {
    var allowed = new HashSet<uint>(); foreach (var process in Process.GetProcessesByName("IDMan")) using (process) { try { if (process.MainModule.FileName.EndsWith(@"\Internet Download Manager\IDMan.exe", StringComparison.OrdinalIgnoreCase)) allowed.Add((uint)process.Id); } catch { } }
    var result = new List<string>();
    EnumWindows(delegate(IntPtr window, IntPtr unused) {
      uint pid;GetWindowThreadProcessId(window,out pid);if(!allowed.Contains(pid)||!IsWindowVisible(window))return true;
      var cls = new StringBuilder(256);GetClassName(window,cls,256);
      int children=0;bool start=false,cancel=false,loopback=false;string marker="";var categories=new HashSet<string>();
      EnumChildWindows(window,delegate(IntPtr child,IntPtr ignored){children++;var text=new StringBuilder(8192);UIntPtr count;SendMessageTimeout(child,0x000d,new UIntPtr(8192),text,2,200,out count);string value=text.ToString();foreach(var keyword in new[]{"序列号","注册","过期","许可","expired","serial","license","error","错误","正在运行","管理员","administrator","试用","trial","下载"})if(value.IndexOf(keyword,StringComparison.OrdinalIgnoreCase)>=0)categories.Add(keyword);start|=value.Contains("开始下载")||value.Contains("Start Download");cancel|=value.Contains("取消")||value.Contains("Cancel");loopback|=value.Contains("127.0.0.1");var match=Regex.Match(value,"idm-probe-[a-f0-9]{32}");if(match.Success)marker=match.Value;return true;},IntPtr.Zero);
      result.Add("{\"class\":\""+cls.ToString()+"\",\"children\":"+children+",\"start\":"+start.ToString().ToLowerInvariant()+",\"cancel\":"+cancel.ToString().ToLowerInvariant()+",\"loopback\":"+loopback.ToString().ToLowerInvariant()+",\"marker\":\""+marker+"\",\"categories\":\""+String.Join("|",new List<string>(categories).ToArray())+"\"}");return true;
    },IntPtr.Zero);return "["+String.Join(",",result.ToArray())+"]";
  }
  public static string[] ReadSmallDialog() {
    var allowed = new HashSet<uint>(); foreach(var process in Process.GetProcessesByName("IDMan"))using(process){try{if(process.MainModule.FileName.EndsWith(@"\Internet Download Manager\IDMan.exe",StringComparison.OrdinalIgnoreCase))allowed.Add((uint)process.Id);}catch{}}
    var output=new List<string>();
    EnumWindows(delegate(IntPtr window,IntPtr unused){uint pid;GetWindowThreadProcessId(window,out pid);if(!allowed.Contains(pid)||!IsWindowVisible(window))return true;var cls=new StringBuilder(256);GetClassName(window,cls,256);if(cls.ToString()!="#32770")return true;var children=new List<IntPtr>();EnumChildWindows(window,delegate(IntPtr child,IntPtr ignored){children.Add(child);return true;},IntPtr.Zero);if(children.Count>4)return true;foreach(var child in children){var value=new StringBuilder(8192);UIntPtr count;SendMessageTimeout(child,0x000d,new UIntPtr(8192),value,2,200,out count);output.Add(value.ToString());}return true;},IntPtr.Zero);return output.ToArray();
  }
}
'@
if ($SelfTest) {
  if (-not [IdmProbeDialog]::SelfTest()) { throw '原生确认窗口分类反例失败' }
  [ordered]@{ passed = $true; platformCalls = 0; windowActions = 0 } | ConvertTo-Json -Compress
  exit 0
}
if ($ReadSmallDialog) { [IdmProbeDialog]::ReadSmallDialog() | ConvertTo-Json; exit 0 }
if ($InspectOnly) { [IdmProbeDialog]::Inspect(); exit 0 }
$deadline = [DateTime]::UtcNow.AddSeconds(20)
while ([DateTime]::UtcNow -lt $deadline) {
  $window = [IdmProbeDialog]::Find($Token)
  if ($window -lt 0) { throw '匹配到多个IDM探针窗口，拒绝操作' }
  if ($window -gt 0) {
    Start-Sleep -Milliseconds 350
    if (-not [IdmProbeDialog]::Close($window, $Token)) { throw '探针窗口重新验证失败' }
    $closeDeadline = [DateTime]::UtcNow.AddSeconds(4)
    while ([IdmProbeDialog]::Exists($window) -and [DateTime]::UtcNow -lt $closeDeadline) { Start-Sleep -Milliseconds 100 }
    [ordered]@{ found = $true; closed = -not [IdmProbeDialog]::Exists($window); clickedStart = $false } | ConvertTo-Json -Compress
    exit 0
  }
  Start-Sleep -Milliseconds 100
}
[ordered]@{ found = $false; closed = $false; clickedStart = $false; diagnostics = [IdmProbeDialog]::Inspect() } | ConvertTo-Json -Compress
exit 1
