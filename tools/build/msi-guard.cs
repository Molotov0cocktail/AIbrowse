using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

// This executable only inspects admission conditions. Windows Installer owns all mutations.
internal static class MsiAdmission
{
    private const long AdmissionLimitMs = 10000;
    private const string UpgradeCode = "__UPGRADE_CODE__";
    private const string ShortcutName = "__SHORTCUT_NAME__";
    private const string InstallLeaf = "__INSTALL_LEAF__";
    private static readonly string[] Incoming = { __INCOMING_FILES__ };
    private const uint Machine = 4;
    private static Stopwatch AdmissionBudget;
    private sealed class Product { internal string Code; internal string Root; internal HashSet<string> Files = new HashSet<string>(StringComparer.OrdinalIgnoreCase); }
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            AdmissionBudget = Stopwatch.StartNew();
            if (args.Length != 5 || (args[0] != "install" && args[0] != "remove")) throw new InvalidDataException("参数无效");
            if (!Environment.Is64BitProcess) throw new InvalidDataException("需要64位Windows");
            var operatingSystem = new OperatingSystemVersion(); operatingSystem.Size = (uint)Marshal.SizeOf(typeof(OperatingSystemVersion));
            if (RtlGetVersion(ref operatingSystem) != 0 || operatingSystem.Major < 10) throw new InvalidDataException("需要Windows 10或更新系统");
            RequireRollback();
            foreach (string name in new [] { "AIbrowse", "guardian" })
                foreach (Process process in Process.GetProcessesByName(name))
                    using (process) { throw new IOException("请先正常退出AIbrowse及其守护进程"); }
            List<Product> products = Products();
            RequireTime();
            string root = CanonicalRoot(args[1]);
            if (args[0] == "remove")
            {
                Product current = products.Find(p => p.Code.Equals(args[2], StringComparison.OrdinalIgnoreCase));
                if (current == null) throw new InvalidDataException("卸载产品未全机注册");
                if (!root.Equals(current.Root, StringComparison.OrdinalIgnoreCase)) throw new IOException("卸载实际目录与注册安装根不一致");
                RequireWritableOwnedFiles(current);
                RequireSafeTree(root);
                CheckShortcuts(root, true, args[3], args[4]);
            }
            else
            {
                if (products.Count > 1) throw new InvalidDataException("存在多个相关安装");
                if (products.Count == 1 && !products[0].Root.Equals(root, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("升级必须选择原安装目录");
                if (products.Count == 1) RequireWritableOwnedFiles(products[0]);
                RequireSafeTree(root);
                foreach (string member in Incoming)
                {
                    string destination = Path.Combine(root, member.Replace('/', '\\'));
                    if (Directory.Exists(destination) || (File.Exists(destination) && (products.Count == 0 || !products[0].Files.Contains(destination))))
                        throw new IOException("安装目标存在未注册的冲突文件");
                    string parent = Path.GetDirectoryName(destination);
                    while (!parent.Equals(root, StringComparison.OrdinalIgnoreCase))
                    {
                        if (File.Exists(parent)) throw new IOException("安装目录被文件占用");
                        parent = Path.GetDirectoryName(parent);
                    }
                }
                CheckShortcuts(root, products.Count == 1, args[3], args[4]);
            }
            return 0;
        }
        catch (Exception) { return 2; }
    }
    private static void RequireRollback()
    {
        foreach (RegistryHive hive in new [] { RegistryHive.LocalMachine, RegistryHive.CurrentUser })
            foreach (RegistryView view in new [] { RegistryView.Registry64, RegistryView.Registry32 })
                using (RegistryKey baseKey = RegistryKey.OpenBaseKey(hive, view))
                using (RegistryKey key = baseKey.OpenSubKey(@"Software\Policies\Microsoft\Windows\Installer", false))
                    if (key != null && Convert.ToInt32(key.GetValue("DisableRollback", 0)) != 0) throw new IOException("系统策略禁用安装回滚");
    }
    private static string CanonicalRoot(string input)
    {
        string candidate = input.EndsWith(@"\.", StringComparison.Ordinal) ? input.Substring(0, input.Length - 2) : input;
        candidate = candidate.TrimEnd('\\');
        if (candidate.Length < 3 || !Char.IsLetter(candidate[0]) || candidate[1] != ':' || candidate[2] != '\\') throw new InvalidDataException("安装根必须是完整绝对路径");
        string root = Path.GetFullPath(candidate).TrimEnd('\\');
        if (!root.Equals(candidate, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("安装根不是规范绝对路径");
        if (root.Length < 5 || root.Length > 170 || root[1] != ':' || root[2] != '\\' || root.IndexOf(':', 2) >= 0 || root.StartsWith(@"\\") || new DriveInfo(root.Substring(0,3)).DriveType != DriveType.Fixed)
            throw new InvalidDataException("安装根必须是本地绝对目录");
        foreach (string part in root.Substring(3).Split('\\'))
            if (part.Length == 0 || part.EndsWith(".") || part.EndsWith(" ")) throw new InvalidDataException("安装根包含非规范成员");
        string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        if (String.IsNullOrEmpty(programFiles) || !root.Equals(Path.Combine(programFiles, InstallLeaf), StringComparison.OrdinalIgnoreCase)) throw new IOException("安装根必须是固定受保护的全机目录");
        RequireProtected(programFiles);
        RequireAncestors(root);
        return root;
    }
    private static void RequireAncestors(string path)
    {
        for (string p = path; p != null; p = Path.GetDirectoryName(p))
        {
            try { if ((File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0) throw new IOException("安装路径含重解析点"); }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }
    private static void RequireSafeTree(string root)
    {
        RequireAncestors(root);
        if (File.Exists(root)) throw new IOException("安装根是文件");
        if (!Directory.Exists(root)) return;
        RequireProtected(root);
        var pending = new Stack<string>(); pending.Push(root); int count = 0;
        while (pending.Count > 0)
            foreach (string entry in Directory.EnumerateFileSystemEntries(pending.Pop()))
            {
                RequireTime();
                if (++count > 8192) throw new IOException("安装目录超出检查预算");
                FileAttributes attr = File.GetAttributes(entry);
                if ((attr & FileAttributes.ReparsePoint) != 0) throw new IOException("安装目录含链接");
                RequireProtected(entry);
                if ((attr & FileAttributes.Directory) != 0) pending.Push(entry);
                else RequireSingleLink(entry);
            }
    }
    private static void RequireProtected(string path)
    {
        FileSystemSecurity security = Directory.Exists(path) ? (FileSystemSecurity)Directory.GetAccessControl(path) : File.GetAccessControl(path);
        var trusted = new HashSet<string>(StringComparer.Ordinal) { "S-1-5-18", "S-1-5-32-544", "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464" };
        if (!trusted.Contains(security.GetOwner(typeof(SecurityIdentifier)).Value)) throw new IOException("安装成员所有者不是系统管理主体");
        FileSystemRights dangerous = FileSystemRights.WriteData | FileSystemRights.AppendData | FileSystemRights.WriteExtendedAttributes | FileSystemRights.WriteAttributes | FileSystemRights.ChangePermissions | FileSystemRights.TakeOwnership;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier)))
            if (rule.AccessControlType == AccessControlType.Allow && (rule.PropagationFlags & PropagationFlags.InheritOnly) == 0 && (rule.FileSystemRights & dangerous) != 0 && !trusted.Contains(rule.IdentityReference.Value)) throw new IOException("安装成员允许普通主体写入");
    }
    private static string ProductInfo(string product, string property)
    {
        uint size = 32767; var value = new StringBuilder((int)size);
        uint result = MsiGetProductInfoEx(product, null, Machine, property, value, ref size);
        if (result != 0) throw new IOException("无法读取全机MSI注册信息：" + result);
        return value.ToString();
    }
    private static List<Product> Products()
    {
        var products = new List<Product>();
        for (uint index = 0; index < 16; index++)
        {
            RequireTime();
            var code = new StringBuilder(39); uint result = MsiEnumRelatedProducts(UpgradeCode, 0, index, code);
            if (result == 259) return products;
            if (result != 0) throw new IOException("无法枚举MSI注册产品");
            var product = new Product { Code = code.ToString(), Root = CanonicalRoot(ProductInfo(code.ToString(), "InstallLocation")) };
            string cachedPackage = ProductInfo(product.Code, "LocalPackage");
            uint database = 0;
            try
            {
                Check(MsiOpenDatabase(cachedPackage, IntPtr.Zero, out database));
                var directories = Indexed(ReadRows(database, "SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`", 3));
                var components = ReadRows(database, "SELECT `Component`, `ComponentId`, `Directory_`, `Attributes`, `KeyPath` FROM `Component`", 5);
                var files = ReadRows(database, "SELECT `File`, `Component_`, `FileName` FROM `File`", 3);
                var registry = Indexed(ReadRows(database, "SELECT `Registry`, `Root`, `Key`, `Name`, `Value`, `Component_` FROM `Registry`", 6, 4097));
                if (components.Count != files.Count || registry.Count != 1) throw new IOException("MSI不是每文件一个注册组件及固定目录候选");
                string[] locator = registry["InstallLocationLocator"];
                string mainComponent = "C" + Digest("aibrowse.exe").Substring(0, 32);
                string locatorKey = @"Software\AIbrowse\Installer\" + UpgradeCode.Trim('{', '}') + @"\Products\[ProductCode]";
                if (locator[1] != "2" || locator[2] != locatorKey || locator[3] != "InstallLocation" || locator[4] != "[INSTALLDIR]" || locator[5] != mainComponent) throw new IOException("MSI目录候选作者形状无效");
                var byComponent = new Dictionary<string, string[]>(StringComparer.Ordinal);
                foreach (string[] file in files) byComponent.Add(file[1], file);
                if (!byComponent.ContainsKey(mainComponent)) throw new IOException("MSI目录候选缺少主文件组件");
                foreach (string[] component in components)
                {
                    RequireTime();
                    string[] file = byComponent[component[0]];
                    string parent = RelativeDirectory(component[2], directories, new HashSet<string>(StringComparer.Ordinal));
                    string relative = (parent.Length == 0 ? "" : parent + "/") + LongName(file[2]);
                    string id = "C" + Digest(relative.ToLowerInvariant()).Substring(0, 32);
                    string componentHash = Digest(UpgradeCode.Trim('{', '}').ToUpperInvariant() + "\0" + relative.ToLowerInvariant());
                    string expectedGuid = "{" + (componentHash.Substring(0,8) + "-" + componentHash.Substring(8,4) + "-5" + componentHash.Substring(13,3) + "-8" + componentHash.Substring(17,3) + "-" + componentHash.Substring(20,12)).ToUpperInvariant() + "}";
                    if (component[0] != id || file[0] != "F" + id.Substring(1) || !component[1].Equals(expectedGuid, StringComparison.OrdinalIgnoreCase) || component[3] != "256" || component[4] != file[0]) throw new IOException("MSI组件作者形状无效");
                    string actual = Path.GetFullPath(Path.Combine(product.Root, relative.Replace('/', '\\')));
                    uint length = 32767; var registered = new StringBuilder((int)length);
                    if (MsiGetComponentPathEx(product.Code, component[1], null, Machine, registered, ref length) != 3 || !registered.ToString().Equals(actual, StringComparison.OrdinalIgnoreCase)) throw new IOException("全机MSI组件注册不匹配");
                    if (!actual.StartsWith(product.Root + "\\", StringComparison.OrdinalIgnoreCase) || !product.Files.Add(actual)) throw new IOException("MSI组件注册越界或重复");
                }
            }
            finally { if (database != 0) MsiCloseHandle(database); }
            if (product.Files.Count == 0) throw new IOException("MSI组件集合为空");
            // The locator supplies a candidate only; MSI registration above is the ownership authority.
            using (RegistryKey baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64))
            using (RegistryKey locator = baseKey.OpenSubKey(@"Software\AIbrowse\Installer\" + UpgradeCode.Trim('{', '}') + @"\Products\" + product.Code, false))
            {
                if (locator == null || locator.GetValueKind("InstallLocation") != RegistryValueKind.String) throw new IOException("安装目录定位信息缺失或类型无效");
                string candidate = locator.GetValue("InstallLocation", null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
                if (candidate == null || !CanonicalRoot(candidate).Equals(product.Root, StringComparison.OrdinalIgnoreCase)) throw new IOException("安装目录候选与MSI注册根不一致");
            }
            RequireSafeTree(product.Root);
            products.Add(product);
        }
        throw new IOException("MSI产品超出检查预算");
    }
    private static List<string[]> ReadRows(uint database, string query, int columns, int rowBudget = 4096)
    {
        uint view = 0; var rows = new List<string[]>();
        try
        {
            Check(MsiDatabaseOpenView(database, query, out view)); Check(MsiViewExecute(view, 0));
            while (true)
            {
                RequireTime();
                uint record; uint result = MsiViewFetch(view, out record);
                if (result == 259) return rows;
                Check(result);
                try
                {
                    if (rows.Count >= rowBudget) throw new IOException("MSI表超出预算");
                    var row = new string[columns];
                    for (uint field = 1; field <= columns; field++) { uint length = 32767; var text = new StringBuilder((int)length); Check(MsiRecordGetString(record, field, text, ref length)); row[field - 1] = text.ToString(); }
                    rows.Add(row);
                }
                finally { MsiCloseHandle(record); }
            }
        }
        finally { if (view != 0) MsiCloseHandle(view); }
    }
    private static Dictionary<string, string[]> Indexed(List<string[]> rows)
    {
        var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
        foreach (string[] row in rows) result.Add(row[0], row);
        return result;
    }
    private static string LongName(string field)
    {
        string[] names = field.Split('|');
        if (names.Length > 2) throw new IOException("MSI长短文件名无效");
        string name = names[names.Length - 1];
        if (name.Length == 0 || name == "." || name == ".." || name.EndsWith(".") || name.EndsWith(" ") || name.IndexOfAny(new [] { '\\', '/', ':', '*', '?', '"', '<', '>', '|' }) >= 0) throw new IOException("MSI文件成员无效");
        foreach (char c in name) if (c < 32) throw new IOException("MSI文件成员无效");
        return name;
    }
    private static string RelativeDirectory(string id, Dictionary<string, string[]> directories, HashSet<string> visiting)
    {
        if (id == "INSTALLDIR") return "";
        if (visiting.Count >= 32 || !visiting.Add(id) || !directories.ContainsKey(id)) throw new IOException("MSI目录不是安装根的后代");
        string[] row = directories[id]; string parent = RelativeDirectory(row[1], directories, visiting);
        string path = (parent.Length == 0 ? "" : parent + "/") + LongName(row[2]);
        if (id != "D" + Digest(path.ToLowerInvariant()).Substring(0,32)) throw new IOException("MSI目录作者形状无效");
        return path;
    }
    private static string Digest(string input)
    {
        using (SHA256 algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(Encoding.UTF8.GetBytes(input))).Replace("-", "").ToLowerInvariant();
    }
    private static void CheckShortcuts(string root, bool registered, string desktop, string programs)
    {
        int index = 0;
        foreach (Environment.SpecialFolder folder in new [] { Environment.SpecialFolder.CommonDesktopDirectory, Environment.SpecialFolder.CommonPrograms })
        {
            RequireTime();
            string directory = Environment.GetFolderPath(folder);
            string supplied = (index++ == 0 ? desktop : programs);
            if (!supplied.Equals(directory + @"\.", StringComparison.OrdinalIgnoreCase)) throw new IOException("快捷方式目录必须是系统固定公共目录");
            RequireAncestors(directory); RequireProtected(directory);
            string path = Path.Combine(directory, ShortcutName + ".lnk");
            RequireAncestors(path);
            if (Directory.Exists(path)) throw new IOException("快捷方式被目录占用");
            if (!File.Exists(path)) continue;
            RequireSingleLink(path);
            RequireProtected(path);
            if (!registered) throw new IOException("快捷方式存在未知冲突");
            object instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
            try
            {
                ((IPersistFile)instance).Load(path, 0);
                var target = new StringBuilder(32767); ((IShellLink)instance).GetPath(target, target.Capacity, IntPtr.Zero, 4);
                if (!Path.GetFullPath(target.ToString()).Equals(Path.Combine(root, "AIbrowse.exe"), StringComparison.OrdinalIgnoreCase)) throw new IOException("快捷方式不属于注册产品");
            }
            finally { Marshal.FinalReleaseComObject(instance); }
        }
    }
    private static void Check(uint status) { if (status != 0) throw new IOException("Windows Installer只读查询失败：" + status); }
    private static void RequireTime()
    {
        if (AdmissionBudget == null || AdmissionBudget.ElapsedMilliseconds >= AdmissionLimitMs) throw new IOException("安装准入检查超时");
    }
    private static void RequireWritableOwnedFiles(Product product)
    {
        var files = new List<string>(product.Files); files.Sort(StringComparer.OrdinalIgnoreCase);
        foreach (string path in files) { RequireTime(); RequireWritableOwnedFile(path); }
    }
    private static void RequireWritableOwnedFile(string path)
    {
        const uint GenericWrite = 0x40000000, Delete = 0x00010000;
        using (SafeFileHandle handle = CreateFile(path, GenericWrite | Delete, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
            if (handle.IsInvalid) throw new IOException("已注册安装文件正被使用");
    }
    private static void RequireSingleLink(string path)
    {
        using (SafeFileHandle handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x00200000, IntPtr.Zero))
        {
            FileInformation info;
            if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) || info.NumberOfLinks != 1 || (info.Attributes & 0x400) != 0) throw new IOException("安装成员的文件身份不可安全确认");
        }
    }
    [StructLayout(LayoutKind.Sequential)] private struct FileInformation { internal uint Attributes; internal System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Write; internal uint Volume, SizeHigh, SizeLow, NumberOfLinks, IndexHigh, IndexLow; }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] private struct OperatingSystemVersion { internal uint Size, Major, Minor, Build, Platform; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)] internal string ServicePack; }
    [DllImport("ntdll.dll", CharSet=CharSet.Unicode)] private static extern uint RtlGetVersion(ref OperatingSystemVersion version);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInformation information);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)] private static extern uint MsiEnumRelatedProducts(string upgrade, uint reserved, uint index, StringBuilder product);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)] private static extern uint MsiGetProductInfoEx(string product, string sid, uint context, string property, StringBuilder value, ref uint length);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)] private static extern int MsiGetComponentPathEx(string product, string component, string sid, uint context, StringBuilder value, ref uint length);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)] private static extern uint MsiOpenDatabase(string file, IntPtr persistence, out uint database);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)] private static extern uint MsiDatabaseOpenView(uint database, string query, out uint view);
    [DllImport("msi.dll")] private static extern uint MsiViewExecute(uint view, uint record);
    [DllImport("msi.dll")] private static extern uint MsiViewFetch(uint view, out uint record);
    [DllImport("msi.dll", CharSet=CharSet.Unicode)] private static extern uint MsiRecordGetString(uint record, uint field, StringBuilder value, ref uint length);
    [DllImport("msi.dll")] private static extern uint MsiCloseHandle(uint handle);
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLink { void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int size, IntPtr data, uint flags); }
}
