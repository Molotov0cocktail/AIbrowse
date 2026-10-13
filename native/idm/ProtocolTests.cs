using System;
using System.IO;
using System.Text;

namespace AIbrowse.Idm {
  internal static class ProtocolTests {
    private static byte[] Frame(string[] fields) {
      using (var stream = new MemoryStream()) using (var writer = new BinaryWriter(stream)) {
        writer.Write(Encoding.ASCII.GetBytes("IDM1"));
        foreach (var field in fields) { byte[] bytes = Encoding.UTF8.GetBytes(field); writer.Write((uint)bytes.Length); writer.Write(bytes); }
        return stream.ToArray();
      }
    }
    private static void Reject(byte[] frame) { try { Protocol.Decode(frame); } catch { return; } throw new Exception("应拒绝非法协议"); }
    private static int Main() {
      string[] fields = {"https://example.com/file.zip", "https://example.com/", "session=secret", "资料.zip", "Test Browser"};
      byte[] valid = Frame(fields);
      if (Protocol.Decode(valid)[3] != fields[3]) throw new Exception("Unicode不一致");
      for (int field = 0; field < 5; field++) { var bad = (string[])fields.Clone(); bad[field] += "\0"; Reject(Frame(bad)); }
      foreach (string name in new[] {"../a", "C:\\a", "CON.txt", "LPT1", "file.", "file "}) { var bad = (string[])fields.Clone(); bad[3] = name; Reject(Frame(bad)); }
      foreach (string url in new[] {"file:///C:/a", "https://u:p@example.com/a", "https://example.com/a b", "https://"}) { var bad = (string[])fields.Clone(); bad[0] = url; Reject(Frame(bad)); }
      for (int count = 0; count < valid.Length; count++) { var truncated = new byte[count]; Array.Copy(valid, truncated, count); Reject(truncated); }
      var extra = new byte[valid.Length+1]; Array.Copy(valid, extra, valid.Length); Reject(extra);
      var huge = (string[])fields.Clone(); huge[2] = new string('a', 16385); Reject(Frame(huge));
      var invalidUtf8 = (byte[])valid.Clone(); invalidUtf8[8] = 0xc0; invalidUtf8[9] = 0xaf; Reject(invalidUtf8);
      Console.WriteLine("IDM协议原生验证通过"); return 0;
    }
  }
}
