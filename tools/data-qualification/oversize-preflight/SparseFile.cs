using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.OversizePreflight
{
    public sealed class SparseFileFact
    {
        public string Identity;
        public long Length;
        public long AllocatedBytes;
        public bool Sparse;
        public uint Links;
        public uint Attributes;
        public long CreationTime;
        public long LastWriteTime;
        public long ChangeTime;
        public string HeaderSha256;
    }

    public static class SparseFile
    {
        private const uint FSCTL_SET_SPARSE = 0x000900C4;
        private const uint FILE_ATTRIBUTE_SPARSE_FILE = 0x00000200;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;

        [StructLayout(LayoutKind.Sequential)]
        private struct FileBasicInfo
        {
            public long CreationTime;
            public long LastAccessTime;
            public long LastWriteTime;
            public long ChangeTime;
            public uint FileAttributes;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FileAttributeTagInfo
        {
            public uint FileAttributes;
            public uint ReparseTag;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct FileStandardInfo
        {
            public long AllocationSize;
            public long EndOfFile;
            public uint NumberOfLinks;
            [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
            [MarshalAs(UnmanagedType.U1)] public bool Directory;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeviceIoControl(
            SafeFileHandle handle, uint controlCode, IntPtr input, uint inputBytes,
            IntPtr output, uint outputBytes, out uint returned, IntPtr overlapped);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandleEx(
            SafeFileHandle handle, int informationClass, out FileAttributeTagInfo information, uint size);

        [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetFileInformationByHandleEx")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileStandardInformation(
            SafeFileHandle handle, int informationClass, out FileStandardInfo information, uint size);

        [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "GetFileInformationByHandleEx")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileBasicInformation(
            SafeFileHandle handle, int informationClass, out FileBasicInfo information, uint size);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(
            SafeFileHandle handle, out ByHandleFileInformation information);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern SafeFileHandle CreateFileW(
            string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

        public static SparseFileFact Inspect(FileStream stream)
        {
            return InspectHandle(stream.SafeFileHandle, stream.Length);
        }

        private static SparseFileFact InspectHandle(SafeFileHandle handle, long? expectedLength)
        {
            FileAttributeTagInfo attributes;
            FileStandardInfo standard;
            ByHandleFileInformation identity;
            FileBasicInfo basic;
            if (!GetFileInformationByHandleEx(handle, 9, out attributes, (uint)Marshal.SizeOf(typeof(FileAttributeTagInfo))) ||
                !GetFileStandardInformation(handle, 1, out standard, (uint)Marshal.SizeOf(typeof(FileStandardInfo))) ||
                !GetFileInformationByHandle(handle, out identity) ||
                !GetFileBasicInformation(handle, 0, out basic, (uint)Marshal.SizeOf(typeof(FileBasicInfo))))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || standard.Directory ||
                (attributes.FileAttributes & 0x4800) != 0 || standard.DeletePending ||
                (expectedLength.HasValue && standard.EndOfFile != expectedLength.Value) || standard.EndOfFile < 0 ||
                standard.AllocationSize < 0 || identity.NumberOfLinks != 1 ||
                standard.NumberOfLinks != 1 || basic.FileAttributes != attributes.FileAttributes)
                throw new InvalidOperationException("稀疏文件身份无效");
            return new SparseFileFact {
                Identity = identity.VolumeSerialNumber.ToString("x8") + ":" + identity.FileIndexHigh.ToString("x8") + identity.FileIndexLow.ToString("x8"),
                Length = standard.EndOfFile,
                AllocatedBytes = standard.AllocationSize,
                Sparse = (attributes.FileAttributes & FILE_ATTRIBUTE_SPARSE_FILE) != 0,
                Links = identity.NumberOfLinks,
                Attributes = attributes.FileAttributes,
                CreationTime = basic.CreationTime,
                LastWriteTime = basic.LastWriteTime,
                ChangeTime = basic.ChangeTime
            };
        }

        public static long AddAllocation(long total, long allocation)
        {
            const long limit = 16777216;
            if (total < 0 || total > limit || allocation < 0 || allocation > limit - total)
                throw new InvalidOperationException("工具落盘预算超限或分配量无效");
            return checked(total + allocation);
        }

        private static string HeaderHash(FileStream stream)
        {
            var bytes = new byte[(int)Math.Min(64, stream.Length)];
            stream.Position = 0;
            stream.ReadExactly(bytes);
            stream.Position = 0;
            return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        }

        public static SparseFileFact Create(string path, long length, byte[] header)
        {
            if (String.IsNullOrEmpty(path) || !Path.IsPathRooted(path) || length < 1 || header == null || header.Length < 1 || header.Length > 4096 || header.LongLength > length)
                throw new InvalidOperationException("稀疏文件参数无效");
            SparseFileFact created;
            using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read, 4096, FileOptions.WriteThrough))
            {
                uint returned;
                if (!DeviceIoControl(stream.SafeFileHandle, FSCTL_SET_SPARSE, IntPtr.Zero, 0, IntPtr.Zero, 0, out returned, IntPtr.Zero))
                    throw new Win32Exception(Marshal.GetLastWin32Error());
                var sparse = Inspect(stream);
                if (!sparse.Sparse) throw new InvalidOperationException("稀疏属性回读失败");
                stream.Position = 0;
                stream.Write(header, 0, header.Length);
                stream.SetLength(length);
                stream.Flush(true);
                var result = Inspect(stream);
                if (!result.Sparse || result.Length != length) throw new InvalidOperationException("稀疏文件构造回读失败");
                result.HeaderSha256 = HeaderHash(stream);
                created = result;
            }
            // Windows finalizes write timestamps when the writing handle closes.
            var closed = InspectPath(path);
            if (closed.Identity != created.Identity || closed.Length != created.Length ||
                closed.Attributes != created.Attributes || closed.CreationTime != created.CreationTime ||
                closed.AllocatedBytes != created.AllocatedBytes)
                throw new InvalidOperationException("创建句柄与关闭后原件不一致");
            closed.HeaderSha256 = created.HeaderSha256;
            return closed;
        }

        public static SparseFileFact InspectPath(string path)
        {
            if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidOperationException("不允许重解析文件");
            // Metadata access coexists with our held read/write claim. Existing locks still deny new writers.
            using (var handle = CreateFileW(path, 0x80, 3, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
            {
                if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
                return InspectHandle(handle, null);
            }
        }
    }
}
