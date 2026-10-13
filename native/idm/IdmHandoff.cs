using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace AIbrowse.Idm {
  internal static class Protocol {
    internal const int MaxFrame = 48 * 1024;
    private static readonly int[] Limits = {12288, 12288, 16384, 768, 2048};
    internal static string[] Decode(byte[] input) {
      if (input.Length < 24 || input.Length > MaxFrame || input[0] != 'I' || input[1] != 'D' || input[2] != 'M' || input[3] != '1') throw new InvalidDataException();
      var fields = new string[5];
      var utf8 = new UTF8Encoding(false, true);
      using (var stream = new MemoryStream(input, false)) using (var reader = new BinaryReader(stream)) {
        stream.Position = 4;
        for (int i = 0; i < 5; i++) {
          uint length = reader.ReadUInt32();
          if (length > Limits[i] || length > stream.Length - stream.Position) throw new InvalidDataException();
          var bytes = reader.ReadBytes((int)length);
          try { fields[i] = utf8.GetString(bytes); } finally { Array.Clear(bytes, 0, bytes.Length); }
          if (!TextSafe(fields[i])) throw new InvalidDataException();
        }
        if (stream.Position != stream.Length) throw new InvalidDataException();
      }
      if (!UrlSafe(fields[0], false) || !UrlSafe(fields[1], true) || !FilenameSafe(fields[3])) throw new InvalidDataException();
      return fields;
    }
    private static bool TextSafe(string value) {
      for (int i = 0; i < value.Length; i++) {
        var category = CharUnicodeInfo.GetUnicodeCategory(value, i);
        if (category == UnicodeCategory.Control || category == UnicodeCategory.Format) return false;
        if (Char.IsHighSurrogate(value[i])) i++;
      }
      return true;
    }
    private static bool UrlSafe(string value, bool optional) {
      if (value.Length == 0) return optional;
      if (value.Length > 4096 || value.IndexOf('\\') >= 0) return false;
      foreach (char c in value) if (Char.IsWhiteSpace(c)) return false;
      Uri uri;
      return Uri.TryCreate(value, UriKind.Absolute, out uri) && (uri.Scheme == "http" || uri.Scheme == "https") && uri.Host.Length > 0 && uri.UserInfo.Length == 0;
    }
    private static bool FilenameSafe(string value) {
      if (value.Length == 0) return true;
      if (value.Length > 255 || value.IndexOfAny("<>:\"/\\|?*".ToCharArray()) >= 0 || value.EndsWith(".", StringComparison.Ordinal) || value.EndsWith(" ", StringComparison.Ordinal)) return false;
      string stem = value.Split('.')[0].ToUpperInvariant();
      if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL") return false;
      return !(stem.Length == 4 && (stem.StartsWith("COM", StringComparison.Ordinal) || stem.StartsWith("LPT", StringComparison.Ordinal)) && stem[3] >= '0' && stem[3] <= '9');
    }
  }

  // Flattened IUnknown vtable verified against Tonec's official IDMCOMAPI.zip:
  // e00eee4085c12328748e2c502f8514548bf62ece4302ba6c7d9caba0a9becc51.
  [ComImport, Guid("94D09862-1875-4FC9-B434-91CF25C840A1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface ILinkTransmitter2 {
    [PreserveSig] int SendLinkToIDM([MarshalAs(UnmanagedType.BStr)] string url, [MarshalAs(UnmanagedType.BStr)] string referer, [MarshalAs(UnmanagedType.BStr)] string cookie, [MarshalAs(UnmanagedType.BStr)] string data, [MarshalAs(UnmanagedType.BStr)] string user, [MarshalAs(UnmanagedType.BStr)] string password, [MarshalAs(UnmanagedType.BStr)] string path, [MarshalAs(UnmanagedType.BStr)] string filename, int flags);
    [PreserveSig] int SendLinkToIDM2([MarshalAs(UnmanagedType.BStr)] string url, [MarshalAs(UnmanagedType.BStr)] string referer, [MarshalAs(UnmanagedType.BStr)] string cookie, [MarshalAs(UnmanagedType.BStr)] string data, [MarshalAs(UnmanagedType.BStr)] string user, [MarshalAs(UnmanagedType.BStr)] string password, [MarshalAs(UnmanagedType.BStr)] string path, [MarshalAs(UnmanagedType.BStr)] string filename, int flags, [MarshalAs(UnmanagedType.Struct)] object userAgent, [MarshalAs(UnmanagedType.Struct)] object reserved);
    [PreserveSig] int SendLinksArray([MarshalAs(UnmanagedType.BStr)] string location, IntPtr array);
  }

  internal static class Handoff {
    [DllImport("ole32.dll", ExactSpelling=true)] private static extern int CoInitializeEx(IntPtr reserved, uint flags);
    [DllImport("ole32.dll", ExactSpelling=true)] private static extern void CoUninitialize();
    [DllImport("ole32.dll", ExactSpelling=true)] private static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out ILinkTransmitter2 result);

    private static bool ServerIsFixed() {
      bool found = false;
      foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 }) {
        using (var classes = RegistryKey.OpenBaseKey(RegistryHive.ClassesRoot, view))
        using (var key = classes.OpenSubKey("CLSID\\{AC746233-E9D3-49CD-862F-068F7B7CCCA4}\\LocalServer32", false)) {
          if (key == null) continue;
          if (key.GetValueKind("") != RegistryValueKind.String) return false;
          string path = key.GetValue("", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
          if (path == null) return false;
          if (path.Length >= 2 && path[0] == '"' && path[path.Length-1] == '"') path = path.Substring(1, path.Length-2);
          if (!String.Equals(path, @"C:\Program Files\Internet Download Manager\IDMan.exe", StringComparison.OrdinalIgnoreCase) && !String.Equals(path, @"C:\Program Files (x86)\Internet Download Manager\IDMan.exe", StringComparison.OrdinalIgnoreCase)) return false;
          if (!File.Exists(path) || (File.GetAttributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return false;
          found = true;
        }
      }
      return found;
    }

    [STAThread]
    private static int Main(string[] args) {
      if (args.Length != 0) return 2;
      try {
        byte[] input;
        using (var stdin = Console.OpenStandardInput()) using (var buffer = new MemoryStream()) {
          var chunk = new byte[4096];
          try {
            int count;
            while ((count = stdin.Read(chunk, 0, chunk.Length)) != 0) {
              if (buffer.Length + count > Protocol.MaxFrame) return 2;
              buffer.Write(chunk, 0, count);
            }
            input = buffer.ToArray();
          } finally { Array.Clear(chunk, 0, chunk.Length); Array.Clear(buffer.GetBuffer(), 0, (int)buffer.Length); }
        }
        string[] fields;
        try { fields = Protocol.Decode(input); } finally { Array.Clear(input, 0, input.Length); }
        if (!ServerIsFixed()) return 2;
        int initialized = CoInitializeEx(IntPtr.Zero, 2);
        if (initialized < 0) return 3;
        int status = -1;
        ILinkTransmitter2 transmitter = null;
        try {
          var clsid = new Guid("AC746233-E9D3-49CD-862F-068F7B7CCCA4");
          var iid = new Guid("94D09862-1875-4FC9-B434-91CF25C840A1");
          status = CoCreateInstance(ref clsid, IntPtr.Zero, 4, ref iid, out transmitter);
          if (status == 0 && transmitter != null) {
            // No POST, password, arbitrary save path, queue or silent flag.
            status = transmitter.SendLinkToIDM2(fields[0], EmptyNull(fields[1]), EmptyNull(fields[2]), null, null, null, null, EmptyNull(fields[3]), 0, EmptyNull(fields[4]), null);
          }
        } finally { if (transmitter != null) Marshal.FinalReleaseComObject(transmitter); Array.Clear(fields, 0, fields.Length); CoUninitialize(); }
        if (status != 0) return 3;
        using (var stdout = Console.OpenStandardOutput()) { var success = Encoding.ASCII.GetBytes("OK\n"); stdout.Write(success, 0, success.Length); }
        return 0;
      } catch { return 3; }
    }
    private static string EmptyNull(string value) { return value.Length == 0 ? null : value; }
  }
}
