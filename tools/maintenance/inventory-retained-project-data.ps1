param([string]$OutputDirectory, [switch]$CheckOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$nativeSource=@'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public sealed class RetainedInventoryEntry {
    public string FullName;
    public uint Attributes;
    public long Length;
    public DateTime LastWriteTimeUtc;
    public bool IsDirectory { get { return (Attributes & 0x10) != 0; } }
}
public static class RetainedProjectInventory {
    const string Root=@"D:\AIbrowse";
    const int BufferSize=65536;
    [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
    [StructLayout(LayoutKind.Sequential)] struct TokenPrivilege { public uint Count; public Luid Luid; public uint Attributes; }
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process,uint access,out IntPtr token);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system,string name,out Luid luid);
    [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token,bool disable,ref TokenPrivilege state,uint length,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr security,uint creation,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(SafeFileHandle handle,int kind,IntPtr buffer,uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle,StringBuilder path,uint length,uint flags);
    public static void EnableBackup() {
        IntPtr token;
        if(!OpenProcessToken(GetCurrentProcess(),0x28,out token)) throw new Win32Exception();
        try {
            Luid luid;
            if(!LookupPrivilegeValue(null,"SeBackupPrivilege",out luid)) throw new Win32Exception();
            var state=new TokenPrivilege {Count=1,Luid=luid,Attributes=2};
            if(!AdjustTokenPrivileges(token,false,ref state,0,IntPtr.Zero,IntPtr.Zero)) throw new Win32Exception();
            int error=Marshal.GetLastWin32Error(); if(error!=0) throw new Win32Exception(error);
        } finally { CloseHandle(token); }
    }
    public static List<RetainedInventoryEntry> Enumerate(string path) {
        if(!Path.IsPathFullyQualified(path) || !Path.GetFullPath(path).Equals(path,StringComparison.Ordinal) ||
            (!path.Equals(Root,StringComparison.OrdinalIgnoreCase) && !path.StartsWith(Root+@"\",StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("Directory outside the canonical project scope");
        var result=new List<RetainedInventoryEntry>();
        using(var handle=CreateFileW(@"\\?\"+path,0x81,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
            if(handle.IsInvalid) throw new Win32Exception();
            IntPtr buffer=Marshal.AllocHGlobal(BufferSize);
            try {
                if(!GetFileInformationByHandleEx(handle,9,buffer,8)) throw new Win32Exception();
                uint actualAttributes=unchecked((uint)Marshal.ReadInt32(buffer));
                if((actualAttributes & 0x400)!=0 || (actualAttributes & 0x10)==0) throw new InvalidOperationException("Only ordinary directories are enumerated");
                var resolved=new StringBuilder(32768);
                uint resolvedLength=GetFinalPathNameByHandleW(handle,resolved,32768,0);
                if(resolvedLength==0 || resolvedLength>=32768 || !resolved.ToString().Equals(@"\\?\"+path,StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Resolved directory does not match project path");
                bool first=true;
                while(true) {
                    if(!GetFileInformationByHandleEx(handle,first?15:14,buffer,BufferSize)) {
                        int error=Marshal.GetLastWin32Error();
                        if(error==18) break;
                        throw new Win32Exception(error);
                    }
                    first=false;
                    int offset=0;
                    while(true) {
                        if(offset<0 || offset>BufferSize-68) throw new InvalidOperationException("Invalid directory entry offset");
                        int next=Marshal.ReadInt32(buffer,offset);
                        uint attributes=unchecked((uint)Marshal.ReadInt32(buffer,offset+56));
                        int nameBytes=Marshal.ReadInt32(buffer,offset+60);
                        if(nameBytes<0 || nameBytes%2!=0 || (long)offset+68+nameBytes>BufferSize ||
                            (next!=0 && (next<68+nameBytes || next%8!=0 || (long)offset+next>BufferSize-68)))
                            throw new InvalidOperationException("Invalid directory entry layout");
                        string name=Marshal.PtrToStringUni(IntPtr.Add(buffer,offset+68),nameBytes/2);
                        if(name!="." && name!="..") {
                            if(String.IsNullOrEmpty(name) || name.IndexOfAny(new char[]{'\\','/'})>=0) throw new InvalidOperationException("Invalid directory entry name");
                            result.Add(new RetainedInventoryEntry {FullName=path+@"\"+name,Attributes=attributes,
                                Length=Math.Max(0,Marshal.ReadInt64(buffer,offset+40)),LastWriteTimeUtc=DateTime.FromFileTimeUtc(Marshal.ReadInt64(buffer,offset+24))});
                        }
                        if(next==0) break;
                        offset+=next;
                    }
                }
            } finally { Marshal.FreeHGlobal(buffer); }
        }
        return result;
    }
}
'@
Add-Type -TypeDefinition $nativeSource
if($CheckOnly){Write-Output '项目元数据盘点脚本与原生枚举接口编译通过；未执行扫描。';return}
if(-not $OutputDirectory){throw '必须提供项目维护日志内的输出目录。'}
$root='D:\AIbrowse'
$output=[IO.Path]::GetFullPath($OutputDirectory).TrimEnd('\')
if (-not $output.StartsWith($root+'\log\maintenance\',[StringComparison]::OrdinalIgnoreCase)) { throw '输出目录越界。' }
$outputItem=Get-Item -LiteralPath $output -Force
if (-not $outputItem.PSIsContainer -or $outputItem.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '输出必须为普通目录。' }
$ancestor=[IO.Path]::GetDirectoryName($output)
while($ancestor){if((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw '输出目录祖先为链接。'};$ancestor=[IO.Path]::GetDirectoryName($ancestor.TrimEnd('\'))}
[RetainedProjectInventory]::EnableBackup()
$csv=Join-Path $output 'remaining-project-files.csv'
$summary=Join-Path $output 'remaining-project-summary.json'
if ((Test-Path -LiteralPath $csv) -or (Test-Path -LiteralPath $summary)) { throw '清单已存在，拒绝覆盖。' }
$currentOutput=$root+'\output'
$rows=[Collections.Generic.List[object]]::new()
$errors=[Collections.Generic.List[object]]::new()
$links=[Collections.Generic.List[object]]::new()
$queue=[Collections.Generic.Stack[string]]::new()
$queue.Push($root)
$directoryCount=0L
while($queue.Count) {
    $directory=$queue.Pop()
    try {
        foreach($item in [RetainedProjectInventory]::Enumerate($directory)) {
            if($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { $links.Add([pscustomobject]@{path=$item.FullName;type='reparse_point_not_followed'}); continue }
            if($item.IsDirectory) { $directoryCount++; $queue.Push($item.FullName); continue }
            $relative=$item.FullName.Substring($root.Length+1)
            $group=if($item.FullName.StartsWith($currentOutput+'\',[StringComparison]::OrdinalIgnoreCase)){'当前交付程序'}
                elseif($relative.StartsWith('log\local-archive\')){'迁入项目的历史资料'}
                elseif($relative.StartsWith('log\')){'历史报告及保留证据'}
                elseif($relative.StartsWith('.git\')){'Git历史'}
                elseif($relative.StartsWith('.local-dev\')){'项目开发缓存'}
                elseif($relative.StartsWith('.h3b-workspaces\')){'旧隔离目录保留项'}
                else{'源码工具及正式文档'}
            $rows.Add([pscustomobject]@{category=$group;path=$item.FullName;logicalBytes=$item.Length;lastWriteUtc=$item.LastWriteTimeUtc.ToString('o')})
        }
    } catch { $errors.Add([pscustomobject]@{path=$directory;message=$_.Exception.Message}) }
}
$rows | Sort-Object category,path | Export-Csv -LiteralPath $csv -NoTypeInformation -Encoding UTF8
$groups=@($rows | Group-Object category | ForEach-Object { [pscustomobject]@{category=$_.Name;files=$_.Count;logicalBytes=($_.Group|Measure-Object logicalBytes -Sum).Sum} })
$result=[ordered]@{finishedUtc=[DateTime]::UtcNow.ToString('o');scope='仅D:\AIbrowse目录元数据；不读取凭据或文件正文，不跟随链接，不修改ACL；输出文件在扫描完成后创建';backupPrivilegeEnabled=$true;enumeration='CreateFileW备份语义+FileFullDirectoryInfo';files=$rows.Count;directories=$directoryCount;logicalBytes=($rows|Measure-Object logicalBytes -Sum).Sum;groups=$groups;links=$links;errors=$errors}
$result|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $summary -Encoding UTF8
$groups|ConvertTo-Json -Depth 3
if($errors.Count){throw ('保留清单存在访问错误：'+$errors.Count)}
