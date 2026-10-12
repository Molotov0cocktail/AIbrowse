using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.ReleaseProfile {
    public sealed class AuthorizedProfileEntry {
        public string RelativePath { get; set; }
        public string FinalPath { get; set; }
        public string Identity { get; set; }
        public uint Attributes { get; set; }
        public bool Directory { get; set; }
        public ulong Length { get; set; }
        public ulong Created { get; set; }
        public ulong Written { get; set; }
        public uint Links { get; set; }
    }

    public sealed class AuthorizedProfileView {
        public string Root { get; set; }
        public bool Exists { get; set; }
        public AuthorizedProfileEntry[] Entries { get; set; }
        public int Files { get; set; }
        public int Directories { get; set; }
        public ulong Bytes { get; set; }
    }

    public static class AuthorizedProfileMetadata {
        public const int MaximumEntries = 20000;
        public const int MaximumDepth = 32;
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandle(SafeFileHandle handle, byte[] information);
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int informationClass, byte[] information, uint length);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint length, uint flags);

        public static string Canonical(string path) {
            if (String.IsNullOrEmpty(path) || path.Length > 4096 || path.Length < 4 ||
                !Char.IsAsciiLetter(path[0]) || path[1] != ':' || path[2] != '\\' ||
                path.Contains('/') || path.Substring(2).Contains(':') || path.EndsWith("\\") ||
                !String.Equals(Path.GetFullPath(path), path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("拒绝非规范本地绝对路径。");
            foreach (var part in path.Substring(3).Split('\\')) {
                if (part.Length == 0 || part.EndsWith(" ") || part.EndsWith(".") || part.Contains('*') || part.Contains('?'))
                    throw new InvalidOperationException("拒绝路径别名或通配符。");
            }
            return path;
        }

        public static AuthorizedProfileEntry Read(string path, string relative) {
            // Access zero reads handle metadata only; OPEN_REPARSE_POINT never follows a leaf link.
            using (var handle = CreateFileW("\\\\?\\" + path, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
                if (handle.IsInvalid) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 2 || error == 3) return null;
                    throw new Win32Exception(error, "无法读取目录身份元数据。");
                }
                byte[] data = new byte[52], identity = new byte[24];
                if (!GetFileInformationByHandle(handle, data) || !GetFileInformationByHandleEx(handle, 18, identity, 24))
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "无法核验文件身份。");
                uint attributes = BitConverter.ToUInt32(data, 0);
                if ((attributes & 0x400) != 0) throw new InvalidOperationException("拒绝重解析点。");
                bool directory = (attributes & 0x10) != 0;
                uint links = BitConverter.ToUInt32(data, 40);
                if (!directory && links != 1) throw new InvalidOperationException("拒绝硬链接文件或未知链接计数。");
                var final = new StringBuilder(32768);
                uint count = GetFinalPathNameByHandleW(handle, final, 32768, 0);
                if (count == 0 || count >= 32768) throw new InvalidOperationException("无法解析最终绝对路径。");
                string finalPath = final.ToString();
                if (!finalPath.StartsWith("\\\\?\\", StringComparison.Ordinal)) throw new InvalidOperationException("未知最终路径格式。");
                finalPath = finalPath.Substring(4);
                Canonical(finalPath);
                return new AuthorizedProfileEntry {
                    RelativePath = relative, FinalPath = finalPath,
                    Identity = Convert.ToHexString(identity), Attributes = attributes, Directory = directory,
                    Length = directory ? 0 : ((ulong)BitConverter.ToUInt32(data, 32) << 32) | BitConverter.ToUInt32(data, 36),
                    Created = BitConverter.ToUInt64(data, 4), Written = BitConverter.ToUInt64(data, 20), Links = links
                };
            }
        }

        public static void AssertAncestors(string path) {
            Canonical(path);
            string current = Path.GetDirectoryName(path);
            while (current != null && current.Length > 3) {
                var entry = Read(current, "");
                if (entry == null || !entry.Directory || !String.Equals(entry.FinalPath, current, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("父路径缺失、不是目录或包含别名。");
                current = Path.GetDirectoryName(current);
            }
        }

        public static AuthorizedProfileView Snapshot(string root, string[] allowedRoots) {
            Canonical(root);
            AssertAncestors(root);
            var entries = new List<AuthorizedProfileEntry>();
            var pending = new Stack<(string Path, string Relative, int Depth)>();
            var result = new AuthorizedProfileView { Root = root, Entries = Array.Empty<AuthorizedProfileEntry>() };
            pending.Push((root, "", 0));
            while (pending.Count > 0) {
                var item = pending.Pop();
                if (item.Depth > MaximumDepth || entries.Count >= MaximumEntries)
                    throw new InvalidOperationException("目录元数据扫描超出预算。");
                var entry = Read(item.Path, item.Relative);
                if (entry == null) {
                    if (item.Depth == 0) return result;
                    throw new InvalidOperationException("枚举成员无法通过元数据句柄打开：" + item.Path);
                }
                bool expected = false;
                foreach (string allowed in allowedRoots) {
                    string exact = item.Relative.Length == 0 ? allowed : Path.Combine(allowed, item.Relative);
                    if (String.Equals(entry.FinalPath, exact, StringComparison.OrdinalIgnoreCase)) expected = true;
                }
                if (!expected) throw new InvalidOperationException("成员最终路径越出两个授权视图或相对定位不一致。");
                if (item.Depth == 0 && !entry.Directory) throw new InvalidOperationException("授权根不是目录。");
                entries.Add(entry);
                result.Exists = true;
                if (entry.Directory) {
                    if (item.Depth != 0) result.Directories++;
                    foreach (string child in System.IO.Directory.EnumerateFileSystemEntries(item.Path)) {
                        Canonical(child);
                        if (!String.Equals(Path.GetDirectoryName(child), item.Path, StringComparison.OrdinalIgnoreCase))
                            throw new InvalidOperationException("枚举路径越界。");
                        if (entries.Count + pending.Count >= MaximumEntries) throw new InvalidOperationException("目录成员数量超出预算。");
                        string relative = item.Relative.Length == 0 ? Path.GetFileName(child) : Path.Combine(item.Relative, Path.GetFileName(child));
                        pending.Push((child, relative, item.Depth + 1));
                    }
                } else { result.Files++; result.Bytes = checked(result.Bytes + entry.Length); }
            }
            entries.Sort((a, b) => StringComparer.OrdinalIgnoreCase.Compare(a.RelativePath, b.RelativePath));
            result.Entries = entries.ToArray();
            return result;
        }
    }
}
