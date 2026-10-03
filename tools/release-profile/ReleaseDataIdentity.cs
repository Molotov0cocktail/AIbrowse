using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.ReleaseProfile
{
    public static class ReleaseDataIdentity
    {
        private static readonly string[] RelativeDatabasePaths = new[] {
            "sources/sources.db", "research/research.db", "watch/watch.db"
        };

        public static string Record(string journalPath, string checkpoint)
        {
            if (checkpoint != "BeforeRestart" && checkpoint != "AfterRestart")
                throw new InvalidOperationException("数据文件身份检查点不在固定白名单");
            string journal = Path.GetFullPath(journalPath).TrimEnd(Path.DirectorySeparatorChar);
            DisposableManifest manifest = DisposableProfile.Load(journal);
            uint probeProcessId = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
            JobProcess.AssertContains(manifest.RunId, probeProcessId);
            using DisposableLease lease = new DisposableLease(false);
            DisposableProfile.CheckMarker(manifest, lease);

            var files = new List<object>();
            foreach (string relative in RelativeDatabasePaths)
            {
                string platformRelative = relative.Replace('/', Path.DirectorySeparatorChar);
                string aliasPath = Path.Combine(lease.Declared, platformRelative);
                string resolvedPath = Path.Combine(lease.Resolved, platformRelative);
                using SafeFileHandle alias = DisposableNative.Open(aliasPath, false, false, 3);
                using SafeFileHandle actual = DisposableNative.Open(resolvedPath, false, false, 3);
                DisposableIdentity aliasIdentity = DisposableNative.Identity(alias, aliasPath, false);
                DisposableIdentity resolvedIdentity = DisposableNative.Identity(actual, resolvedPath, false);
                if (aliasIdentity.FileId128 != resolvedIdentity.FileId128 ||
                    aliasIdentity.VolumeSerial64 != resolvedIdentity.VolumeSerial64 ||
                    aliasIdentity.Sddl != resolvedIdentity.Sddl ||
                    aliasIdentity.VolumeSerial64 != lease.Identity.VolumeSerial64)
                    throw new InvalidOperationException("数据库声明/实体视图身份不一致：" + relative);
                files.Add(new { relativePath = relative, alias = aliasIdentity, resolved = resolvedIdentity });
            }
            DisposableProfile.CheckMarker(manifest, lease);

            string output = Path.Combine(journal, "runner-output", "data-files-" + checkpoint + ".json");
            string json = JsonSerializer.Serialize(new {
                version = 1, runId = manifest.RunId, checkpoint, probeProcessId,
                rootIdentity = lease.Identity, files
            });
            using FileStream stream = new FileStream(output, FileMode.CreateNew, FileAccess.Write, FileShare.Read);
            byte[] bytes = new UTF8Encoding(false).GetBytes(json);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
            return output;
        }
    }
}
