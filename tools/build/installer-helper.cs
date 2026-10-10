using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Web.Script.Serialization;

internal static class InstallerHelper
{
    private const string ManifestName = ".aibrowse-owned-v1.json";
    private const string UninstallerName = "Uninstall AIbrowse.exe";
    private const string NewSuffix = ".aibrowse-new";
    private const string OldSuffix = ".aibrowse-old";
    private const string JournalSuffix = ".aibrowse-install-journal";
    private const string CurrentManifestSha256 = "__AIBROWSE_MANIFEST_SHA256__";

    private sealed class Entry { internal string Path; internal long Bytes; internal string Sha256; }
    private sealed class Manifest { internal readonly List<Entry> Files = new List<Entry>(); }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length != 2) throw new InvalidDataException("参数数量无效");
            string action = args[0];
            string root = CanonicalRoot(args[1]);
            if (action == "recover") Recover(root);
            else if (action == "inspect-new") InspectNew(root);
            else if (action == "commit") Commit(root);
            else if (action == "rollback") Rollback(root);
            else if (action == "finalize") FinalizeCommit(root);
            else if (action == "uninstall") Uninstall(root);
            else throw new InvalidDataException("动作无效");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("AIbrowse 安装事务失败：" + error.GetType().Name);
            return 2;
        }
    }

    private static void InspectNew(string root)
    {
        string stage = root + NewSuffix;
        RequireSafeAncestors(root);
        RequireSafeTree(stage);
        string sourceManifest = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "installer-owned-v1.json");
        if (!Hash(sourceManifest).Equals(CurrentManifestSha256, StringComparison.Ordinal))
            throw new InvalidDataException("owned manifest与安装器来源不一致");
        Manifest manifest = LoadManifest(sourceManifest);
        File.Copy(sourceManifest, Path.Combine(stage, ManifestName), false);
        VerifyOwnedTree(stage, manifest, true);
    }

    private static void Commit(string root)
    {
        string stage = root + NewSuffix;
        string old = root + OldSuffix;
        string journal = root + JournalSuffix;
        if (File.Exists(journal) || Directory.Exists(old)) throw new IOException("存在未完成安装事务");
        Manifest next = LoadManifest(Path.Combine(stage, ManifestName));
        VerifyOwnedTree(stage, next, true);
        bool hadOld = Directory.Exists(root);
        if (hadOld) VerifyOwnedTree(root, LoadManifest(Path.Combine(root, ManifestName)), true);
        WriteJournal(journal, "prepared");
        try
        {
            if (hadOld) Directory.Move(root, old);
            WriteJournal(journal, hadOld ? "old-moved" : "prepared-no-old");
            Directory.Move(stage, root);
            VerifyOwnedTree(root, next, true);
            WriteJournal(journal, hadOld ? "new-published" : "new-published-no-old");
        }
        catch
        {
            RestoreOld(root, old, journal, hadOld);
            throw;
        }
    }

    private static void Recover(string root)
    {
        string journal = root + JournalSuffix;
        if (!File.Exists(journal)) return;
        string state = ReadJournal(journal);
        string old = root + OldSuffix;
        string stage = root + NewSuffix;
        if (state == "finalizing")
        {
            if (Directory.Exists(old)) DeleteOwnedTree(old, true);
            File.Delete(journal);
            return;
        }
        if (Directory.Exists(old))
        {
            if (Directory.Exists(root)) DeleteOwnedTree(root, true);
            Directory.Move(old, root);
        }
        else if (state == "new-published-no-old" && Directory.Exists(root))
        {
            VerifyOwnedTree(root, LoadManifest(Path.Combine(root, ManifestName)), true);
        }
        if (Directory.Exists(stage)) DeleteOwnedTree(stage, true);
        File.Delete(journal);
    }

    private static void Rollback(string root)
    {
        Recover(root);
    }

    private static void FinalizeCommit(string root)
    {
        string journal = root + JournalSuffix;
        string state = ReadJournal(journal);
        if (state != "new-published" && state != "new-published-no-old")
            throw new InvalidDataException("事务尚未发布");
        VerifyOwnedTree(root, LoadManifest(Path.Combine(root, ManifestName)), true);
        WriteJournal(journal, "finalizing");
        string old = root + OldSuffix;
        if (Directory.Exists(old)) DeleteOwnedTree(old, true);
        File.Delete(journal);
    }

    private static void Uninstall(string root)
    {
        if (File.Exists(root + JournalSuffix) || Directory.Exists(root + NewSuffix) || Directory.Exists(root + OldSuffix))
            throw new IOException("存在未完成安装事务");
        DeleteOwnedTree(root, false);
    }

    private static void RestoreOld(string root, string old, string journal, bool hadOld)
    {
        if (Directory.Exists(root)) DeleteOwnedTree(root, true);
        if (hadOld && Directory.Exists(old)) Directory.Move(old, root);
        if (File.Exists(journal)) File.Delete(journal);
    }

    private static void DeleteOwnedTree(string root, bool includeUninstaller)
    {
        Manifest manifest = LoadManifest(Path.Combine(root, ManifestName));
        VerifyOwnedTree(root, manifest, true);
        foreach (Entry entry in manifest.Files) File.Delete(ResolveMember(root, entry.Path));
        File.Delete(Path.Combine(root, ManifestName));
        if (includeUninstaller) File.Delete(Path.Combine(root, UninstallerName));
        foreach (string directory in EnumerateSafeTree(root).Directories.OrderByDescending(p => p.Length))
            Directory.Delete(directory, false);
        if (includeUninstaller) Directory.Delete(root, false);
    }

    private sealed class Tree
    {
        internal readonly HashSet<string> Files = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        internal readonly List<string> Directories = new List<string>();
    }

    private static Tree EnumerateSafeTree(string root)
    {
        RequireSafeAncestors(root);
        Tree tree = new Tree();
        Queue<string> pending = new Queue<string>();
        pending.Enqueue(root);
        while (pending.Count != 0)
        {
            string directory = pending.Dequeue();
            RejectReparse(directory);
            foreach (string child in Directory.GetFileSystemEntries(directory))
            {
                RejectReparse(child);
                FileAttributes attributes = File.GetAttributes(child);
                if ((attributes & FileAttributes.Directory) != 0)
                {
                    tree.Directories.Add(child);
                    pending.Enqueue(child);
                }
                else tree.Files.Add(RelativePath(root, child));
            }
        }
        return tree;
    }

    private static void VerifyOwnedTree(string root, Manifest manifest, bool requireUninstaller)
    {
        Tree tree = EnumerateSafeTree(root);
        HashSet<string> expected = new HashSet<string>(manifest.Files.Select(e => e.Path), StringComparer.OrdinalIgnoreCase);
        expected.Add(ManifestName);
        if (requireUninstaller) expected.Add(UninstallerName);
        if (!tree.Files.SetEquals(expected)) throw new InvalidDataException("安装目录含未知、缺失或重复文件");
        foreach (Entry entry in manifest.Files)
        {
            string path = ResolveMember(root, entry.Path);
            FileInfo info = new FileInfo(path);
            if (!info.Exists || info.Length != entry.Bytes || !Hash(path).Equals(entry.Sha256, StringComparison.Ordinal))
                throw new InvalidDataException("owned payload 校验失败");
        }
        if (requireUninstaller)
        {
            FileInfo uninstaller = new FileInfo(Path.Combine(root, UninstallerName));
            if (!uninstaller.Exists || uninstaller.Length <= 0 || uninstaller.Length > 32 * 1024 * 1024)
                throw new InvalidDataException("卸载器无效");
        }
    }

    private static Manifest LoadManifest(string path)
    {
        FileInfo info = new FileInfo(path);
        if (!info.Exists || info.Length <= 0 || info.Length > 1024 * 1024) throw new InvalidDataException("owned manifest 无效");
        object raw = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024, RecursionLimit = 8 }.DeserializeObject(File.ReadAllText(path, Encoding.UTF8));
        IDictionary<string, object> root = raw as IDictionary<string, object>;
        if (root == null || root.Count != 2 || !root.ContainsKey("version") || !root.ContainsKey("files") || Convert.ToInt32(root["version"], CultureInfo.InvariantCulture) != 1)
            throw new InvalidDataException("owned manifest schema 无效");
        IList rows = root["files"] as IList;
        if (rows == null || rows.Count == 0 || rows.Count > 4096) throw new InvalidDataException("owned manifest 条目无效");
        Manifest result = new Manifest();
        string previous = null;
        foreach (object rawRow in rows)
        {
            IDictionary<string, object> row = rawRow as IDictionary<string, object>;
            if (row == null || row.Count != 3 || !row.ContainsKey("path") || !row.ContainsKey("bytes") || !row.ContainsKey("sha256"))
                throw new InvalidDataException("owned manifest 条目schema无效");
            Entry entry = new Entry {
                Path = Convert.ToString(row["path"], CultureInfo.InvariantCulture),
                Bytes = Convert.ToInt64(row["bytes"], CultureInfo.InvariantCulture),
                Sha256 = Convert.ToString(row["sha256"], CultureInfo.InvariantCulture)
            };
            ValidateMember(entry.Path);
            if (entry.Bytes <= 0 || entry.Sha256 == null || entry.Sha256.Length != 64 || entry.Sha256.Any(c => !(c >= '0' && c <= '9') && !(c >= 'a' && c <= 'f')))
                throw new InvalidDataException("owned manifest 摘要无效");
            if (previous != null && StringComparer.Ordinal.Compare(previous, entry.Path) >= 0) throw new InvalidDataException("owned manifest 未排序唯一");
            previous = entry.Path;
            result.Files.Add(entry);
        }
        return result;
    }

    private static string CanonicalRoot(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value.IndexOf('\0') >= 0) throw new InvalidDataException("安装根无效");
        string full = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
        if (Path.GetPathRoot(full).Equals(full, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装根不得为卷根");
        return full;
    }

    private static void RequireSafeAncestors(string root)
    {
        string current = root;
        while (!String.IsNullOrEmpty(current) && !Path.GetPathRoot(current).Equals(current, StringComparison.OrdinalIgnoreCase))
        {
            if (Directory.Exists(current) || File.Exists(current)) RejectReparse(current);
            current = Path.GetDirectoryName(current);
        }
    }
    private static void RequireSafeTree(string root) { if (!Directory.Exists(root)) throw new DirectoryNotFoundException(); EnumerateSafeTree(root); }
    private static void RejectReparse(string path) { if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new IOException("拒绝reparse路径"); }

    private static string ResolveMember(string root, string member)
    {
        ValidateMember(member);
        string path = Path.GetFullPath(Path.Combine(root, member.Replace('/', Path.DirectorySeparatorChar)));
        if (!path.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("成员越界");
        return path;
    }
    private static void ValidateMember(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length > 260 || value[0] == '/' || value.IndexOf('\\') >= 0 || value.IndexOf(':') >= 0 || value.Split('/').Any(p => p.Length == 0 || p == "." || p == ".."))
            throw new InvalidDataException("成员路径无效");
    }
    private static string RelativePath(string root, string path) { return path.Substring(root.Length + 1).Replace(Path.DirectorySeparatorChar, '/'); }
    private static string Hash(string path) { using (SHA256 sha = SHA256.Create()) using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant(); }

    private static void WriteJournal(string path, string state)
    {
        string temp = path + ".tmp";
        using (FileStream stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        {
            byte[] bytes = Encoding.ASCII.GetBytes("AIBROWSE-INSTALL-V1\n" + state + "\n");
            stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
        }
        if (File.Exists(path)) File.Replace(temp, path, null); else File.Move(temp, path);
    }
    private static string ReadJournal(string path)
    {
        string[] lines = File.ReadAllLines(path, Encoding.ASCII);
        if (lines.Length != 2 || lines[0] != "AIBROWSE-INSTALL-V1") throw new InvalidDataException("安装journal无效");
        string state = lines[1];
        if (state != "prepared" && state != "prepared-no-old" && state != "old-moved" && state != "new-published" && state != "new-published-no-old" && state != "finalizing") throw new InvalidDataException("安装journal状态无效");
        return state;
    }
}
