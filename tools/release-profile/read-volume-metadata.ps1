[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class ReleaseProfileVolumeMetadata {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string p, uint a, uint s, IntPtr x, uint d, uint f, IntPtr t);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle f, byte[] b);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle h, StringBuilder p, uint n, uint f);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle h, int c, byte[] b, uint n);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetVolumeInformationByHandleW(SafeFileHandle h, StringBuilder v, uint vs, out uint s, out uint m, out uint f, StringBuilder fs, uint ns);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool GetVolumePathNameW(string p, StringBuilder v, uint n);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint QueryDosDeviceW(string d, StringBuilder t, uint n);

    public static object Inspect(string p) {
        using (var h = CreateFileW(p, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
            if (h.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] b = new byte[52], id = new byte[24];
            var fs = new StringBuilder(64);
            if (!GetFileInformationByHandle(h, b) || !GetFileInformationByHandleEx(h, 18, id, 24) ||
                !GetVolumeInformationByHandleW(h, null, 0, out uint serial, out _, out _, fs, 64))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            var paths = new Dictionary<string, object>();
            foreach (uint flag in new uint[] { 0, 1, 2 }) {
                var final = new StringBuilder(512);
                uint length = GetFinalPathNameByHandleW(h, final, 512, flag);
                paths.Add(flag.ToString(), new { value = final.ToString(), error = length == 0 ? Marshal.GetLastWin32Error() : 0 });
            }
            var volume = new StringBuilder(512);
            bool foundVolume = GetVolumePathNameW(p, volume, 512);
            int volumeError = foundVolume ? 0 : Marshal.GetLastWin32Error();
            var device = new StringBuilder(512);
            uint deviceLength = QueryDosDeviceW(p.Substring(0, 2), device, 512);
            return new { requested = p, finalPaths = paths, attributes = BitConverter.ToUInt32(b, 0).ToString("X8"),
                legacySerial = BitConverter.ToUInt32(b, 28).ToString("X8"), volumeSerial = serial.ToString("X8"),
                fileIdVolume = BitConverter.ToUInt64(id, 0).ToString("X16"), fileId128 = Convert.ToHexString(id, 8, 16),
                fileSystem = fs.ToString(), volumePath = volume.ToString(), volumePathError = volumeError,
                dosDevice = device.ToString(), dosDeviceError = deviceLength == 0 ? Marshal.GetLastWin32Error() : 0 };
        }
    }
}
'@
Add-Type -TypeDefinition $source
$appDataPath = [Environment]::GetFolderPath('ApplicationData')
$paths = [Collections.Generic.List[string]]::new()
$paths.Add([IO.Path]::GetPathRoot($repository))
$current = [IO.Path]::GetPathRoot($appDataPath)
$paths.Add($current)
foreach ($part in $appDataPath.Substring($current.Length).Split([IO.Path]::DirectorySeparatorChar)) {
    $current = Join-Path $current $part
    $paths.Add($current)
}
$paths.Add((Join-Path $appDataPath 'aibrowse'))
if ($paths.Count -gt 12) { throw '固定 KnownFolder 元数据路径数量超出预算。' }
$rows = @($paths | Select-Object -Unique | ForEach-Object { [ReleaseProfileVolumeMetadata]::Inspect($_) })
$output = Join-Path $repository ('log\stage7-e1\profile-isolation\metadata-volume-paths-' + [Guid]::NewGuid().ToString('N') + '.json')
@{ originalContentsRead = $false; actualProfileMoved = $false; metadata = $rows } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $output -Encoding utf8
Write-Output ('只读卷与路径元数据已保留：' + $output)
