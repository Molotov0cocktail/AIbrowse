namespace AIbrowse.PhysicalFullTransfer {
    public static class Allocation {
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct Standard {
            public long Allocated, End;
            public uint Links;
            public byte DeletePending, Directory;
        }
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct Basic {
            public long CreationTime, LastAccessTime, LastWriteTime, ChangeTime;
            public uint Attributes;
        }
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle file, int kind, out Standard info, uint size);
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true, EntryPoint="GetFileInformationByHandleEx")]
        private static extern bool GetBasic(Microsoft.Win32.SafeHandles.SafeFileHandle file, int kind, out Basic info, uint size);
        public static long Read(System.IO.FileStream stream) {
            Standard standard;
            Basic basic;
            if(!GetFileInformationByHandleEx(stream.SafeFileHandle,1,out standard,(uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(Standard))) ||
                !GetBasic(stream.SafeFileHandle,0,out basic,(uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(Basic))) ||
                standard.Links!=1 || standard.Directory!=0 || standard.DeletePending!=0 || standard.End!=stream.Length || standard.Allocated<standard.End ||
                (basic.Attributes & 0xA00u)!=0)
                throw new System.InvalidOperationException("物理输出不是完整分配的普通非稀疏非压缩文件");
            return standard.Allocated;
        }
    }
}
