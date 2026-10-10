namespace AIbrowse.PhysicalCapacity {
    // Inspect only the caller-held output file; no filename or mutation API.
    public static class Allocation {
        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct Standard {
            public long Allocated, End;
            public uint Links;
            public byte DeletePending, Directory;
        }
        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
        private static extern bool GetFileInformationByHandleEx(Microsoft.Win32.SafeHandles.SafeFileHandle file, int kind, out Standard info, uint size);
        public static long Read(System.IO.FileStream stream) {
            Standard info;
            if(!GetFileInformationByHandleEx(stream.SafeFileHandle,1,out info,(uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(Standard))) ||
                info.Links!=1 || info.Directory!=0 || info.DeletePending!=0 || info.End!=stream.Length || info.Allocated<info.End)
                throw new System.InvalidOperationException("物理输出分配量无效");
            return info.Allocated;
        }
    }
}
