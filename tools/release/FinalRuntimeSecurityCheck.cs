using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text.Json;

namespace AIbrowse.ReleaseProfile
{
    public static class FinalRuntimeSecurityCheck
    {
        private static string Hash(byte[] bytes) { return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant(); }
        private static void Write(string path, object value)
        {
            using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            { JsonSerializer.Serialize(stream, value); stream.Flush(true); }
        }

        private static object[] Snapshot(string root)
        {
            return new[] { "sources", "research", "watch" }.Select(domain => {
                string path = Path.Combine(root, domain, domain + ".db");
                using (var directory = DisposableNative.Open(Path.GetDirectoryName(path), true)) {
                var directoryIdentity = DisposableNative.Identity(directory, Path.GetDirectoryName(path), true);
                if (!String.Equals(directoryIdentity.FinalDos, "\\\\?\\" + Path.GetDirectoryName(path), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("数据库父目录偏离固定实体根");
                foreach (string suffix in new[] { "-wal", "-shm", "-journal" })
                    if (File.Exists(path + suffix) || Directory.Exists(path + suffix)) throw new InvalidOperationException("数据库尚非冷态");
                using (var handle = DisposableNative.Open(path, false, true)) {
                    var identity = DisposableNative.Identity(handle, path, false);
                    if (!String.Equals(identity.FinalDos, "\\\\?\\" + path, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("数据库偏离固定实体根");
                    long length = RandomAccess.GetLength(handle);
                    if (length < 1 || length > 16 * 1024 * 1024) throw new InvalidOperationException("合成数据库大小超界");
                    byte[] bytes = new byte[(int)length];
                    int read = 0;
                    while (read < bytes.Length) {
                        int count = RandomAccess.Read(handle, bytes.AsSpan(read), read);
                        if (count == 0) throw new EndOfStreamException();
                        read += count;
                    }
                    if (RandomAccess.GetLength(handle) != length) throw new InvalidOperationException("冷读取期间长度变化");
                    return (object)new { path, identity, bytes = length, sha256 = Hash(bytes) };
                }
                }
            }).ToArray();
        }

        public static void Run(string scope, string profileRoot, string firstEmptyText, string scene)
        {
            if (scene != "content-tamper" && scene != "loose-app-tamper") throw new InvalidOperationException("场景不在白名单");
            if (new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator))
                throw new InvalidOperationException("必须使用普通权限");
            string executable = Path.Combine(scope, scene, "AIbrowse.exe");
            string canary = Path.Combine(scope, scene + "-canary.txt");
            if (File.Exists(canary) || Directory.Exists(canary)) throw new InvalidOperationException("canary在启动前已存在");
            string runId = Guid.NewGuid().ToString("N");
            using (var first = JsonDocument.Parse(firstEmptyText))
            using (var lease = new DisposableLease(false)) {
                var evidence = first.RootElement;
                if (!evidence.GetProperty("ok").GetBoolean() || !evidence.GetProperty("empty").GetBoolean() ||
                    !String.Equals(lease.Declared, evidence.GetProperty("declaredProfile").GetString(), StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals(lease.Resolved, profileRoot, StringComparison.OrdinalIgnoreCase) ||
                    !String.Equals(lease.Resolved, evidence.GetProperty("resolvedProfile").GetString(), StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("首次空根与当前KnownFolder不属于同一现场");
                var expected = JsonSerializer.Deserialize<DisposableIdentity>(evidence.GetProperty("identity").GetRawText());
                DisposableProfile.Equal(expected, lease.Identity);
                var before = Snapshot(profileRoot);
                Write(Path.Combine(scope, scene + "-before.json"), new { root = lease.Identity, databases = before });
                bool returnedNaturally = false, released = false;
                uint? exitCode = null;
                string failure = "";
                var clock = new Stopwatch();
                DateTime budgetStartUtc = DateTime.UtcNow;
                try {
                    // Preparation is complete. The absolute gate includes atomic process creation.
                    clock.Start();
                    exitCode = JobProcess.Execute(executable, new string[0], Path.GetDirectoryName(executable), runId, 6000,
                        (pid, created) => Write(Path.Combine(scope, scene + "-process.json"), new {
                            pid, createdFileTime = created.ToString(), image = executable,
                            runId, atomicJob = true, budgetStartUtc, budgetMs = 6000
                        }), clock, null);
                    returnedNaturally = true;
                    released = true; // Execute only returns after querying actual ActiveProcesses == 0.
                    if (exitCode == 0) throw new InvalidOperationException("损坏包退出码为0，拒绝原因不充分");
                } catch (Exception error) { failure = error.Message; }
                long elapsedMs = clock.ElapsedMilliseconds;
                if (!released) {
                    try { JobProcess.ConfirmReleased(runId); released = true; }
                    catch (Exception error) { failure += "；" + error.Message; }
                }
                object[] after = null;
                bool unchanged = false;
                try {
                    if (!released) throw new InvalidOperationException("Job未退休，禁止读取可能仍活跃的数据库");
                    using (var current = new DisposableLease(false)) {
                        DisposableProfile.Equal(lease.Identity, current.Identity);
                        after = Snapshot(profileRoot);
                        unchanged = JsonSerializer.Serialize(before) == JsonSerializer.Serialize(after);
                        Write(Path.Combine(scope, scene + "-after.json"), new { root = current.Identity, databases = after });
                    }
                } catch (Exception error) { failure += "；" + error.Message; }
                bool canaryAbsent = !File.Exists(canary) && !Directory.Exists(canary);
                bool ok = returnedNaturally && exitCode != 0 && elapsedMs < 6000 && released && unchanged && canaryAbsent && failure == "";
                Write(Path.Combine(scope, scene + "-result.json"), new {
                    ok, scene, runId, exitCode, elapsedMs, returnedNaturally,
                    jobReleased = released, jobZeroMethod = returnedNaturally ? "Execute.ActiveProcesses==0" : "ConfirmReleased-after-failure",
                    profileUnchanged = unchanged, canaryAbsent, failure,
                    cleanupMayHaveTerminatedOwnedJob = !returnedNaturally,
                    credentialsRead = false, profileWrittenByTool = false
                });
                if (!ok) throw new InvalidOperationException("损坏包验证失败；证据和现场保留");
            }
        }
    }
}
