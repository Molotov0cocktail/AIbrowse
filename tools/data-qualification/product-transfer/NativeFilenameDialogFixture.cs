using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.FilenameQualification
{
    // This ledger never treats edit text as proof of the selected Shell item.
    public sealed class ChoiceLedger
    {
        private readonly int ownerThread;
        private readonly string target, initial;
        private string eventPath;
        private bool entered, finished;
        public int Events { get; private set; }
        public string TextClass = "unavailable", EventClass = "unavailable", FinalClass = "unavailable";
        public ChoiceLedger(int thread, string target, string initial)
        {
            if (thread <= 0 || String.IsNullOrEmpty(target) || String.IsNullOrEmpty(initial) || target == initial)
                throw new InvalidOperationException("选择oracle初值无效");
            ownerThread = thread; this.target = target; this.initial = initial;
        }
        public static string Classify(string value, string target, string initial)
        {
            if (value == null) return "unavailable";
            if (String.Equals(value, target, StringComparison.Ordinal)) return "exact-target";
            if (String.Equals(value, initial, StringComparison.Ordinal)) return "exact-default";
            return "other";
        }
        public void BeginEvent(int thread, long elapsed)
        {
            Check(thread, elapsed);
            if (entered || Events != 0 || finished) throw new InvalidOperationException("原生选择事件重复或重入");
            entered = true; Events++;
        }
        public bool Observe(int thread, long elapsed, string text, string selected)
        {
            Check(thread, elapsed);
            if (!entered || Events != 1 || finished) throw new InvalidOperationException("原生选择事件状态无效");
            TextClass = Classify(text, target, "AIbrowse-backup");
            if (text == "AIbrowse-backup.aibak") TextClass = "exact-default";
            EventClass = Classify(selected, target, initial);
            eventPath = selected; entered = false;
            return EventClass == "exact-target" || EventClass == "exact-default";
        }
        public void Complete(int thread, long elapsed, int showResult, string selected)
        {
            Check(thread, elapsed);
            if (finished || entered || Events != 1 || showResult != 0 || eventPath == null ||
                (EventClass != "exact-target" && EventClass != "exact-default") ||
                !String.Equals(eventPath, selected, StringComparison.Ordinal))
                throw new InvalidOperationException("原生最终选择缺失或前后不一致");
            FinalClass = Classify(selected, target, initial); finished = true;
        }
        private void Check(int thread, long elapsed)
        {
            if (thread != ownerThread || elapsed < 0 || elapsed >= 30000)
                throw new InvalidOperationException("原生选择线程或原期限失配");
        }
        public bool Completed { get { return finished; } }
        public static string Decide(bool nativeTarget, bool msaa, bool fixture, string finalClass)
        {
            if (!nativeTarget || !fixture) return "failed";
            if (finalClass == "exact-target") return "not-reproduced";
            if (finalClass == "exact-default") return msaa ? "run-candidate" : "msaa-unavailable";
            return "failed";
        }
    }

    public sealed class DialogLifetime
    {
        private readonly int thread;
        private uint cookie;
        private bool advised, disposed, closeAttempted;
        public bool Unadvised { get; private set; }
        public bool Released { get; private set; }
        public DialogLifetime(int thread) { this.thread = thread; }
        public void AssertThread(int current) { if (current != thread || disposed) throw new InvalidOperationException("对话框生命周期线程或状态无效"); }
        public void Registered(int current, int hresult, uint cookie)
        {
            AssertThread(current);
            if (advised || hresult != 0) throw new InvalidOperationException("对话框事件注册无效");
            advised = true; this.cookie = cookie;
        }
        public void CloseOnce(int current, Func<int> close)
        {
            AssertThread(current);
            if (closeAttempted) return;
            closeAttempted = true;
            if (close() != 0) throw new InvalidOperationException("对话框取消未成功");
        }
        public void Finish(int current, Func<uint,int> unadvise, Action release)
        {
            if (disposed) return;
            AssertThread(current); disposed = true;
            bool ok = true;
            try { if (advised) { Unadvised = unadvise(cookie) == 0; ok = Unadvised; } }
            catch { ok = false; }
            finally { try { release(); Released = true; } catch { ok = false; } }
            if (!ok) throw new InvalidOperationException("对话框事件注销或COM释放失败");
        }
    }

    public static class ReceiptGate
    {
        public static string String(Dictionary<string, object> value, string key) { if (!(value[key] is string)) throw new InvalidOperationException("固定字符串字段无效"); return (string)value[key]; }
        public static bool Bool(Dictionary<string, object> value, string key) { if (!(value[key] is bool)) throw new InvalidOperationException("固定布尔字段无效"); return (bool)value[key]; }
        public static long Number(Dictionary<string, object> value, string key) { if (value[key] is int) return (int)value[key]; if (value[key] is long) return (long)value[key]; throw new InvalidOperationException("固定整数字段无效"); }
        public static void Validate(Dictionary<string, object> tool, Dictionary<string, object> result, string scenario)
        {
            if ((scenario != "reference" && scenario != "candidate") || Number(tool,"version") != 1 || Number(result,"version") != 1 ||
                String(tool,"purpose") != "qualification" ||
                String(tool,"scenario") != scenario || String(result,"scenario") != scenario ||
                !Bool(tool,"ok") || !Bool(result,"ok") || !Bool(tool,"editTarget") ||
                Number(tool,"writes") != 1 || Number(tool,"saveActions") != 1 ||
                Number(tool,"focusActions") != 2 || !Bool(tool,"editFocusVerified") || !Bool(tool,"saveFocusVerified") ||
                Number(tool,"elapsedMs") < 0 || Number(tool,"elapsedMs") >= 30000 ||
                Number(result,"elapsedMs") < 0 || Number(result,"elapsedMs") >= 30000 ||
                Number(result,"events") != 1 || Number(result,"showResult") != 0 ||
                !Bool(result,"unadvised") || !Bool(result,"released") || Bool(result,"cancelled") ||
                (Number(result,"options") & 0x2010040) != 0x2010040 ||
                String(result,"eventClass") != String(result,"finalClass") ||
                (String(result,"finalClass") != "exact-target" && String(result,"finalClass") != "exact-default") ||
                (String(result,"textClass") != "exact-target" && String(result,"textClass") != "exact-default" && String(result,"textClass") != "other" && String(result,"textClass") != "unavailable") ||
                String(tool,"failure") != "none" || String(result,"failure") != "none")
                throw new InvalidOperationException("原生场景终态回执不符");
            bool qualified = Bool(tool,"msaaQualified");
            if (scenario == "candidate" && !qualified) throw new InvalidOperationException("第二场缺少严格MSAA资格");
        }
    }

    internal static class FlatJson
    {
        internal static void Write(string file, Dictionary<string, object> value)
        {
            byte[] bytes = new UTF8Encoding(false, true).GetBytes(new JavaScriptSerializer().Serialize(value));
            if (bytes.Length > 65536) throw new InvalidOperationException("固定回执超限");
            string pending = file + ".pending";
            using (var stream = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
            File.Move(pending, file);
        }
        internal static Dictionary<string, object> Read(string file, params string[] keys)
        {
            string text;
            using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (stream.Length == 0 || stream.Length > 65536) throw new InvalidOperationException("固定回执大小无效");
                using (var reader = new StreamReader(stream, new UTF8Encoding(false, true))) text = reader.ReadToEnd();
            }
            // Consume the whole flat grammar before deserialization can overwrite a key.
            // Fixed field names are literal ASCII; escaped names are never accepted.
            string white = "[ \\t\\r\\n]*";
            string jsonString = "\"(?:[^\"\\\\\\x00-\\x1f]|\\\\(?:[\"\\\\/bfnrt]|u[0-9A-Fa-f]{4}))*\"";
            var member = new Regex("\\G" + white + "\"(?<key>[A-Za-z][A-Za-z0-9]*)\"" + white + ":" + white +
                "(?:" + jsonString + "|true|false|-?(?:0|[1-9][0-9]*))" + white, RegexOptions.CultureInvariant);
            var opening = Regex.Match(text, "\\A" + white + "\\{" + white, RegexOptions.CultureInvariant);
            if (!opening.Success) throw new InvalidOperationException("固定回执对象无效");
            var seen = new HashSet<string>(StringComparer.Ordinal);
            int position = opening.Length;
            if (position < text.Length && text[position] != '}')
            {
                while (true)
                {
                    Match match = member.Match(text, position);
                    if (!match.Success || !seen.Add(match.Groups["key"].Value) ||
                        Array.IndexOf(keys, match.Groups["key"].Value) < 0)
                        throw new InvalidOperationException("固定回执字段语法或重复字段无效");
                    position += match.Length;
                    if (position >= text.Length) throw new InvalidOperationException("固定回执不完整");
                    if (text[position] != ',') break;
                    position++;
                }
            }
            if (!Regex.IsMatch(text.Substring(position), "\\A\\}" + white + "\\z", RegexOptions.CultureInvariant) || seen.Count != keys.Length)
                throw new InvalidOperationException("固定回执尾部或字段无效");
            var result = new JavaScriptSerializer().DeserializeObject(text) as Dictionary<string, object>;
            if (result == null || result.Count != keys.Length) throw new InvalidOperationException("固定回执字段无效");
            foreach (string key in keys) if (!result.ContainsKey(key) || !seen.Contains(key) ||
                !(result[key] is string || result[key] is bool || result[key] is int || result[key] is long))
                    throw new InvalidOperationException("固定回执字段类型无效");
            return result;
        }
        internal static string String(Dictionary<string, object> value, string key) { return ReceiptGate.String(value,key); }
        internal static bool Bool(Dictionary<string, object> value, string key) { return ReceiptGate.Bool(value,key); }
        internal static long Number(Dictionary<string, object> value, string key) { return ReceiptGate.Number(value,key); }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Filter { [MarshalAs(UnmanagedType.LPWStr)] public string Name; [MarshalAs(UnmanagedType.LPWStr)] public string Spec; }
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        [PreserveSig] int SetFileTypes(uint count, [MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] Filter[] filters);
        [PreserveSig] int SetFileTypeIndex(uint index);
        [PreserveSig] int GetFileTypeIndex(out uint index);
        [PreserveSig] int Advise([MarshalAs(UnmanagedType.Interface)] IFileDialogEvents sink, out uint cookie);
        [PreserveSig] int Unadvise(uint cookie);
        [PreserveSig] int SetOptions(uint options);
        [PreserveSig] int GetOptions(out uint options);
        [PreserveSig] int SetDefaultFolder(IShellItem folder);
        [PreserveSig] int SetFolder(IShellItem folder);
        [PreserveSig] int GetFolder(out IShellItem folder);
        [PreserveSig] int GetCurrentSelection(out IShellItem selected);
        [PreserveSig] int SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        [PreserveSig] int GetFileName(out IntPtr name);
        [PreserveSig] int SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        [PreserveSig] int SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        [PreserveSig] int SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        [PreserveSig] int GetResult(out IShellItem result);
        [PreserveSig] int AddPlace(IShellItem item, int alignment);
        [PreserveSig] int SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        [PreserveSig] int Close(int result);
        [PreserveSig] int SetClientGuid(ref Guid guid);
        [PreserveSig] int ClearClientData();
        [PreserveSig] int SetFilter(IntPtr filter);
    }
    [ComImport, Guid("00000114-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleWindow { [PreserveSig] int GetWindow(out IntPtr window); [PreserveSig] int ContextSensitiveHelp([MarshalAs(UnmanagedType.Bool)] bool enter); }
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr value);
        [PreserveSig] int GetParent(out IShellItem parent);
        [PreserveSig] int GetDisplayName(uint kind, out IntPtr name);
        [PreserveSig] int GetAttributes(uint mask, out uint attributes);
        [PreserveSig] int Compare(IShellItem other, uint hint, out int order);
    }
    [ComVisible(true), Guid("973510db-7d7f-452b-8975-74a85828d354"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileDialogEvents
    {
        [PreserveSig] int OnFileOk(IFileDialog dialog);
        [PreserveSig] int OnFolderChanging(IFileDialog dialog, IShellItem folder);
        [PreserveSig] int OnFolderChange(IFileDialog dialog);
        [PreserveSig] int OnSelectionChange(IFileDialog dialog);
        [PreserveSig] int OnShareViolation(IFileDialog dialog, IShellItem item, out int response);
        [PreserveSig] int OnTypeChange(IFileDialog dialog);
        [PreserveSig] int OnOverwrite(IFileDialog dialog, IShellItem item, out int response);
    }

    public sealed class ScopeLease : IDisposable
    {
        private readonly List<SafeFileHandle> held = new List<SafeFileHandle>();
        public ScopeLease(string scope)
        {
            try
            {
                var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                foreach (string leaf in new[] { scope, Path.Combine(scope, "source"), Path.Combine(scope, "default"), Path.Combine(scope, "published"), Path.Combine(scope, "reference"), Path.Combine(scope, "candidate") })
                    for (string path = leaf; !String.IsNullOrEmpty(path); path = Path.GetDirectoryName(path)) paths.Add(path);
                foreach (string path in paths)
                {
                    SafeFileHandle handle = CreateFileW(path, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                    held.Add(handle); FileInformation info;
                    if (handle.IsInvalid || !GetFileInformationByHandle(handle, out info) || (info.Attributes & 0x410) != 0x10)
                        throw new InvalidOperationException("固定scope目录身份无效");
                }
            }
            catch { Dispose(); throw; }
        }
        public void Dispose() { foreach (SafeFileHandle handle in held) handle.Dispose(); held.Clear(); }
        [StructLayout(LayoutKind.Sequential)] private struct FileInformation { public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
    }

    [ComVisible(true), ClassInterface(ClassInterfaceType.None)]
    public sealed class DialogSession : IFileDialogEvents
    {
        private const int Cancelled = unchecked((int)0x800704c7);
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly long startedTick = Stopwatch.GetTimestamp();
        private readonly int thread = Thread.CurrentThread.ManagedThreadId;
        private readonly string scope, scenario, target, initial;
        private readonly ChoiceLedger ledger;
        private readonly DialogLifetime lifetime;
        private IFileDialog dialog;
        private uint cookie, options;
        private bool handshake, cancel, closed, fault;
        private string failure = "initialize";
        private int showResult = Cancelled;
        internal DialogSession(string scope, string scenario)
        {
            this.scope = scope; this.scenario = scenario;
            target = Path.Combine(scope, "published", "product-backup.aibak");
            initial = Path.Combine(scope, "default", "AIbrowse-backup.aibak");
            ledger = new ChoiceLedger(thread, target, initial);
            lifetime = new DialogLifetime(thread);
        }
        private void SameThread() { if (Thread.CurrentThread.ManagedThreadId != thread || Thread.CurrentThread.GetApartmentState() != ApartmentState.STA) throw new InvalidOperationException("对话框COM线程变化"); }
        private void Check() { SameThread(); lifetime.AssertThread(thread); if (clock.ElapsedMilliseconds >= 30000) throw new InvalidOperationException("对话框原期限已过"); }
        private static void Ok(int result) { if (result != 0) throw new InvalidOperationException("对话框API未返回S_OK"); }
        private static void Release(object value) { if (value != null && Marshal.IsComObject(value)) Marshal.FinalReleaseComObject(value); }
        private static string Text(IntPtr text)
        {
            if (text == IntPtr.Zero) throw new InvalidOperationException("原生文本指针为空");
            var result = new StringBuilder();
            for (int i = 0; i <= 4096; i++) { char c = (char)Marshal.ReadInt16(text, i * 2); if (c == 0) return result.ToString(); result.Append(c); }
            throw new InvalidOperationException("原生文本超限");
        }
        private string FileName()
        {
            IntPtr text = IntPtr.Zero;
            try { Check(); Ok(dialog.GetFileName(out text)); string value = Text(text); Check(); return value; }
            finally { if (text != IntPtr.Zero) Marshal.FreeCoTaskMem(text); }
        }
        private string Result()
        {
            IShellItem item = null; IntPtr text = IntPtr.Zero;
            try { Check(); Ok(dialog.GetResult(out item)); if (item == null) throw new InvalidOperationException("选择对象为空"); Ok(item.GetDisplayName(0x80058000, out text)); string value = Text(text); Check(); return value; }
            finally { if (text != IntPtr.Zero) Marshal.FreeCoTaskMem(text); Release(item); }
        }
        private void Close()
        {
            SameThread(); if (closed || dialog == null) return; closed = true; cancel = true;
            lifetime.CloseOnce(thread, delegate { return dialog.Close(Cancelled); });
        }
        internal int Run()
        {
            SameThread();
            int initialized = CoInitializeEx(IntPtr.Zero, 2);
            if (initialized != 0 && initialized != 1) throw new InvalidOperationException("STA COM初始化失败");
            bool success = false;
            try
            {
                using (var owner = new Form())
                using (var timer = new System.Windows.Forms.Timer())
                {
                    owner.Text = "AIbrowse 文件名资格夹具"; owner.Width = 420; owner.Height = 160;
                    owner.Show(); IntPtr ownerWindow = owner.Handle;
                    dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("c0b4e2f3-ba21-4773-8dba-335ec946eb8b"), true));
                    Check();
                    failure = "options";
                    uint oldOptions; Ok(dialog.GetOptions(out oldOptions));
                    uint required = oldOptions | 0x10000 | 0x02000000 | 0x40;
                    Ok(dialog.SetOptions(required)); Ok(dialog.GetOptions(out options)); if (options != required) throw new InvalidOperationException("对话框固定选项读回不符");
                    IShellItem folder = null;
                    failure = "default-folder";
                    try
                    {
                        Guid iid = typeof(IShellItem).GUID;
                        Ok(SHCreateItemFromParsingName(Path.Combine(scope, "default"), IntPtr.Zero, ref iid, out folder));
                        Ok(dialog.SetFolder(folder));
                    }
                    finally { Release(folder); }
                    Ok(dialog.SetFileTypes(1, new[] { new Filter { Name = "AIbrowse 备份", Spec = "*.aibak" } }));
                    Ok(dialog.SetFileTypeIndex(1)); Ok(dialog.SetDefaultExtension("aibak"));
                    Ok(dialog.SetFileName("AIbrowse-backup.aibak")); Ok(dialog.SetTitle("保存本地数据备份"));
                    failure = "advise";
                    int registration = dialog.Advise(this, out cookie); lifetime.Registered(thread, registration, cookie);
                    timer.Interval = 25;
                    timer.Tick += delegate
                    {
                        try
                        {
                            SameThread();
                            if (fault || clock.ElapsedMilliseconds >= 30000 || File.Exists(Path.Combine(scope, scenario, "cancel.signal"))) { if (!fault) failure = "cancel-or-deadline"; Close(); return; }
                            if (!handshake)
                            {
                                IntPtr window; Ok(((IOleWindow)dialog).GetWindow(out window));
                                if (window == IntPtr.Zero) throw new InvalidOperationException("原生对话框句柄为空");
                                using (Process current = Process.GetCurrentProcess())
                                    FlatJson.Write(Path.Combine(scope, scenario, "handshake.json"), new Dictionary<string, object> {
                                        {"version",1},{"scenario",scenario},{"pid",current.Id},{"created",current.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()},
                                        {"owner",ownerWindow.ToInt64().ToString()},{"dialog",window.ToInt64().ToString()},
                                        {"startedTick",startedTick.ToString()},{"frequency",Stopwatch.Frequency.ToString()}
                                    });
                                handshake = true; Check();
                            }
                        }
                        catch { fault = true; failure = "handshake-or-close"; try { Close(); } catch { } }
                    };
                    timer.Start();
                    try
                    {
                        failure = "show";
                        Check(); showResult = dialog.Show(ownerWindow); timer.Stop(); Check();
                        if (showResult == 0 && !fault && !cancel) { failure = "final-result"; ledger.Complete(thread, clock.ElapsedMilliseconds, showResult, Result()); }
                        success = !fault && !cancel && ledger.Completed;
                    }
                    finally { timer.Stop(); }
                }
            }
            catch { fault = true; success = false; }
            finally
            {
                try { SameThread(); lifetime.Finish(thread, delegate(uint registration) { return dialog.Unadvise(registration); }, delegate { Release(dialog); dialog = null; }); }
                catch { success = false; fault = true; failure = "unadvise-or-release"; }
                CoUninitialize();
            }
            if (clock.ElapsedMilliseconds >= 30000) { success = false; failure = "deadline"; }
            FlatJson.Write(Path.Combine(scope, scenario, "fixture.json"), new Dictionary<string, object> {
                {"version",1},{"scenario",scenario},{"ok",success},{"events",ledger.Events},{"textClass",ledger.TextClass},
                {"eventClass",ledger.EventClass},{"finalClass",ledger.FinalClass},{"showResult",showResult},
                {"options",(long)options},{"unadvised",lifetime.Unadvised},{"released",lifetime.Released},{"cancelled",cancel},
                {"elapsedMs",clock.ElapsedMilliseconds},{"failure",success?"none":failure}
            });
            return success && clock.ElapsedMilliseconds < 30000 ? 0 : 1;
        }
        public int OnFileOk(IFileDialog sender)
        {
            try
            {
                failure = "event-result";
                Check(); ledger.BeginEvent(thread, clock.ElapsedMilliseconds);
                bool known = ledger.Observe(thread, clock.ElapsedMilliseconds, FileName(), Result());
                if (!known) fault = true;
                return known ? 0 : 1;
            }
            catch { fault = true; return 1; }
        }
        private int Event() { try { Check(); return 0; } catch { fault = true; failure = "event-thread-or-deadline"; return 1; } }
        public int OnFolderChanging(IFileDialog sender, IShellItem folder) { return Event(); }
        public int OnFolderChange(IFileDialog sender) { return Event(); }
        public int OnSelectionChange(IFileDialog sender) { return Event(); }
        public int OnShareViolation(IFileDialog sender, IShellItem item, out int response) { response = 2; fault = true; failure = "share-violation"; return Event(); }
        public int OnTypeChange(IFileDialog sender) { return Event(); }
        public int OnOverwrite(IFileDialog sender, IShellItem item, out int response) { response = 2; fault = true; failure = "overwrite"; return Event(); }
        [DllImport("ole32.dll")] private static extern int CoInitializeEx(IntPtr reserved, uint model);
        [DllImport("ole32.dll")] private static extern void CoUninitialize();
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)] private static extern int SHCreateItemFromParsingName(string path, IntPtr bind, ref Guid iid, out IShellItem result);
    }

    public static class FilenameFixtureProgram
    {
        private static readonly Stopwatch clock = Stopwatch.StartNew();
        private static readonly List<Process> retained = new List<Process>();
        private static void Check() { if (clock.ElapsedMilliseconds >= 120000) throw new InvalidOperationException("最小资格总期限已过"); }
        private static string Quote(string text) { if (text.IndexOf('"') >= 0 || text.IndexOf('\0') >= 0 || text.IndexOf('\r') >= 0 || text.IndexOf('\n') >= 0 || text.EndsWith("\\", StringComparison.Ordinal)) throw new InvalidOperationException("固定参数无效"); return "\"" + text + "\""; }
        private static Process Start(string executable, string arguments, string scope)
        {
            Check();
            var start = new ProcessStartInfo(executable, arguments) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = scope };
            Process child = Process.Start(start); if (child == null) throw new InvalidOperationException("固定进程未启动");
            return child;
        }
        internal static void NoData(string scope)
        {
            if (Directory.GetFileSystemEntries(Path.Combine(scope, "default")).Length != 0 ||
                Directory.GetFileSystemEntries(Path.Combine(scope, "published")).Length != 0)
                throw new InvalidOperationException("最小资格产生了数据文件");
        }
        private static Dictionary<string, object> Case(string scope, string scenario, string pwsh, string purpose)
        {
            Check(); NoData(scope);
            Process fixture = Start(Path.Combine(scope, "fixture.exe"), Quote(scenario) + " " + Quote(scope), scope);
            {
                Process helper = null;
                var stage = Stopwatch.StartNew();
                try
                {
                    string handshake = Path.Combine(scope, scenario, "handshake.json");
                    while (!File.Exists(handshake)) { Check(); if (stage.ElapsedMilliseconds >= 30000 || fixture.HasExited) throw new InvalidOperationException("原生夹具身份未及时建立"); Thread.Sleep(25); }
                    var identity = FlatJson.Read(handshake, "version", "scenario", "pid", "created", "owner", "dialog", "startedTick", "frequency");
                    if (FlatJson.Number(identity, "version") != 1 || FlatJson.String(identity, "scenario") != scenario ||
                        FlatJson.Number(identity, "pid") != fixture.Id || FlatJson.String(identity, "created") != fixture.StartTime.ToUniversalTime().ToFileTimeUtc().ToString())
                        throw new InvalidOperationException("原生夹具身份回执失配");
                    string script = Path.Combine(scope, "source", "run-native-filename-commit-qualification.ps1");
                    helper = Start(pwsh, "-NoProfile -NonInteractive -File " + Quote(script) + " -Mode Helper -ScopeId " + Quote(Path.GetFileName(scope)) + " -Case " + scenario + " -Purpose " + purpose, scope);
                    while (!helper.WaitForExit(25)) { Check(); if (stage.ElapsedMilliseconds >= 35000) throw new InvalidOperationException("原生helper收口超时"); }
                    if (helper.ExitCode != 0) throw new InvalidOperationException("原生helper失败");
                    int left = (int)Math.Max(0, 35000 - stage.ElapsedMilliseconds);
                    if (!fixture.WaitForExit(left) || fixture.ExitCode != 0) throw new InvalidOperationException("原生夹具未完整退出");
                    var tool = FlatJson.Read(Path.Combine(scope, scenario, "helper.json"), "version", "scenario", "purpose", "ok", "editTarget", "msaaQualified", "writes", "saveActions", "focusActions", "editFocusVerified", "saveFocusVerified", "phase", "exceptionType", "nativeFocus", "focus", "focusRead", "elapsedMs", "failure");
                    var result = FlatJson.Read(Path.Combine(scope, scenario, "fixture.json"), "version", "scenario", "ok", "events", "textClass", "eventClass", "finalClass", "showResult", "options", "unadvised", "released", "cancelled", "elapsedMs", "failure");
                    Check(); NoData(scope);
                    ReceiptGate.Validate(tool,result,scenario);
                    return new Dictionary<string,object> { {"msaa",FlatJson.Bool(tool,"msaaQualified")},{"final",FlatJson.String(result,"finalClass")} };
                }
                finally
                {
                    bool helperStopped = StopOwned(helper, null);
                    bool fixtureStopped = StopOwned(fixture, Path.Combine(scope, scenario, "cancel.signal"));
                    if (!helperStopped || !fixtureStopped) throw new InvalidOperationException("精确子进程未确认退出，交固定Job收口");
                }
            }
        }
        private static bool StopOwned(Process child, string cancel)
        {
            if (child == null) return true;
            bool stopped = false;
            try
            {
                if (!child.HasExited)
                {
                    if (cancel != null)
                    {
                        if (!File.Exists(cancel)) using (FileStream signal = new FileStream(cancel, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) { signal.Flush(true); }
                        child.WaitForExit(250);
                    }
                    if (!child.HasExited) child.Kill();
                }
                stopped = child.WaitForExit(1000);
            }
            catch { stopped = false; }
            finally { if (stopped) child.Dispose(); else retained.Add(child); }
            return stopped;
        }
        private static int Campaign(string scope, string pwsh, string purpose)
        {
            string outcome = "failed"; bool completed = false; int cases = 0;
            try
            {
                cases++; var candidate = Case(scope, "candidate", pwsh, purpose);
                outcome = purpose == "qualification" && (bool)candidate["msaa"] && (string)candidate["final"] == "exact-target" ? "focus-candidate-qualified" : "focus-candidate-failed";
                completed = outcome == "focus-candidate-qualified";
                Check(); NoData(scope);
            }
            catch { outcome = "failed"; completed = false; }
            FlatJson.Write(Path.Combine(scope, "campaign.json"), new Dictionary<string,object> { {"version",1},{"purpose",purpose},{"completed",completed},{"outcome",outcome},{"cases",cases},{"elapsedMs",clock.ElapsedMilliseconds} });
            return completed && clock.ElapsedMilliseconds < 120000 ? 0 : 1;
        }
        [STAThread]
        public static int Main(string[] arguments)
        {
            try
            {
                if (arguments.Length != 2 || (arguments[0] != "campaign" && arguments[0] != "candidate")) return 2;
                string executable = Assembly.GetExecutingAssembly().Location;
                string scope = Path.GetDirectoryName(executable);
                if (scope != Path.GetFullPath(arguments[1]) || !Regex.IsMatch(Path.GetFileName(scope), "\\Anative-filename-commit-[a-f0-9]{32}\\z")) return 2;
                using (var lease = new ScopeLease(scope))
                {
                    var runtime = FlatJson.Read(Path.Combine(scope,"runtime.json"),"version","scopeId","runId","pwsh","purpose");
                    if (FlatJson.Number(runtime,"version") != 1 || FlatJson.String(runtime,"scopeId") != Path.GetFileName(scope) ||
                        FlatJson.String(runtime,"runId") != Path.GetFileName(scope).Substring(23)) return 2;
                    string purpose=FlatJson.String(runtime,"purpose");
                    if(purpose!="qualification" && purpose!="focus-diagnostic")return 2;
                    AssertJob(FlatJson.String(runtime,"runId")); NoData(scope);
                    string pwsh = FlatJson.String(runtime,"pwsh");
                    if (!Path.IsPathRooted(pwsh) || !File.Exists(pwsh) || Path.GetFileName(pwsh) != "pwsh.exe") return 2;
                    return arguments[0] == "campaign" ? Campaign(scope,pwsh,purpose) : new DialogSession(scope,arguments[0]).Run();
                }
            }
            catch { return 2; }
        }
        public static void AssertJob(string id)
        {
            if (!Regex.IsMatch(id,"\\A[a-f0-9]{32}\\z")) throw new InvalidOperationException("资格Job标识无效");
            using (SafeFileHandle job = OpenJobObjectW(4,false,"Local\\AIbrowse.FullTransfer.Job."+id))
            {
                bool member; IntPtr memory = Marshal.AllocHGlobal(144);
                try
                {
                    if (job.IsInvalid || !IsProcessInJob(GetCurrentProcess(),job,out member) || !member ||
                        !QueryInformationJobObject(job,9,memory,144,IntPtr.Zero) ||
                        unchecked((uint)Marshal.ReadInt32(memory,16)) != 0x2308 || Marshal.ReadInt32(memory,40) != 4)
                        throw new InvalidOperationException("资格进程未受固定Job持有");
                }
                finally { Marshal.FreeHGlobal(memory); }
            }
        }
        [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] private static extern SafeFileHandle OpenJobObjectW(uint access,bool inherit,string name);
        [DllImport("kernel32.dll")] private static extern IntPtr GetCurrentProcess();
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool IsProcessInJob(IntPtr process,SafeFileHandle job,out bool member);
        [DllImport("kernel32.dll", SetLastError=true)] private static extern bool QueryInformationJobObject(SafeFileHandle job,int type,IntPtr info,uint size,IntPtr returned);
    }
}
