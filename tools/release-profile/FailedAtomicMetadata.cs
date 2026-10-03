using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Win32.SafeHandles;

namespace AIbrowse.ReleaseProfile
{
    // Read-only metadata probe for a failed disposable-profile atomic write.
    public static class FailedAtomicMetadata
    {
        public static string Inspect(string journalPath)
        {
            string journal = Path.GetFullPath(journalPath);
            string manifestPath = Path.Combine(journal, "manifest.json");
            DisposableManifest manifest = JsonSerializer.Deserialize<DisposableManifest>(
                File.ReadAllText(manifestPath), new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new InvalidOperationException("失败journal manifest无效");
            string expectedDeclared = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "aibrowse");
            if (manifest.Version != 2 || !String.Equals(manifest.DeclaredProfile, expectedDeclared, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("只允许检查固定KnownFolder/aibrowse失败profile");
            if (!String.Equals(new DirectoryInfo(journal).Name, "journal-" + manifest.RunId, StringComparison.Ordinal))
                throw new InvalidOperationException("journal目录与runId不一致");

            string resolved = Path.GetFullPath(manifest.ResolvedProfile);
            string aliasTemporary = Path.Combine(expectedDeclared, "credentials.json.tmp");
            string resolvedTemporary = Path.Combine(resolved, "credentials.json.tmp");
            string aliasTarget = Path.Combine(expectedDeclared, "credentials.json");
            string resolvedTarget = Path.Combine(resolved, "credentials.json");
            if (!File.Exists(aliasTemporary) || !File.Exists(resolvedTemporary))
                throw new InvalidOperationException("失败原件缺少credentials.json.tmp");
            if (File.Exists(aliasTarget) || File.Exists(resolvedTarget))
                throw new InvalidOperationException("失败原件的credentials.json目标不再缺失");

            using SafeFileHandle aliasRoot = DisposableNative.Open(expectedDeclared, true, false, 3);
            using SafeFileHandle resolvedRoot = DisposableNative.Open(resolved, true, false, 3);
            using SafeFileHandle aliasTmp = DisposableNative.Open(aliasTemporary, false, false, 3);
            using SafeFileHandle resolvedTmp = DisposableNative.Open(resolvedTemporary, false, false, 3);
            DisposableIdentity aliasRootIdentity = DisposableNative.Identity(aliasRoot, expectedDeclared, true);
            DisposableIdentity resolvedRootIdentity = DisposableNative.Identity(resolvedRoot, resolved, true);
            DisposableIdentity aliasTmpIdentity = DisposableNative.Identity(aliasTmp, aliasTemporary, false);
            DisposableIdentity resolvedTmpIdentity = DisposableNative.Identity(resolvedTmp, resolvedTemporary, false);
            AssertSame(aliasRootIdentity, resolvedRootIdentity, "声明/实体profile根");
            AssertSame(aliasTmpIdentity, resolvedTmpIdentity, "声明/实体临时文件");
            if (aliasRootIdentity.FileId128 != manifest.RootIdentity.FileId128 ||
                aliasRootIdentity.VolumeSerial64 != manifest.RootIdentity.VolumeSerial64)
                throw new InvalidOperationException("当前profile根与失败manifest不一致");
            if (aliasRootIdentity.VolumeSerial64 != aliasTmpIdentity.VolumeSerial64)
                throw new InvalidOperationException("临时文件与profile根不在同一卷");

            string processReportPath = Directory.GetFiles(Path.Combine(journal, "runner-output"), "process-ProductOriginal-*.json").Single();
            using JsonDocument processReport = JsonDocument.Parse(File.ReadAllText(processReportPath));
            JsonElement process = processReport.RootElement;
            string imagePath = process.GetProperty("imagePath").GetString() ?? "";
            int packageStatus = process.GetProperty("packageStatus").GetInt32();
            string packageName = process.GetProperty("packageFullName").GetString() ?? "";
            if (packageStatus != 15700 || packageName != "" ||
                !String.Equals(imagePath, Path.GetFullPath(manifest.PackageExecutable), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("实际产品进程身份不符合NO_PACKAGE与固定EXE路径证据");

            return JsonSerializer.Serialize(new {
                version = 1,
                runId = manifest.RunId,
                originalContentsRead = false,
                profileMutationPerformed = false,
                root = new { alias = aliasRootIdentity, resolved = resolvedRootIdentity },
                temporary = new { alias = aliasTmpIdentity, resolved = resolvedTmpIdentity },
                target = new {
                    aliasPath = aliasTarget,
                    resolvedPath = resolvedTarget,
                    existsAlias = false,
                    existsResolved = false,
                    parentIdentity = resolvedRootIdentity
                },
                productProcess = new {
                    evidencePath = processReportPath,
                    imagePath,
                    packageStatus,
                    packageFullName = packageName,
                    noPackage = true,
                    probeRootFileId128 = process.GetProperty("probeRootFileId128").GetString(),
                    probeRootVolumeSerial64 = process.GetProperty("probeRootVolumeSerial64").GetString()
                }
            });
        }

        private static void AssertSame(DisposableIdentity first, DisposableIdentity second, string label)
        {
            if (first.FileId128 != second.FileId128 || first.VolumeSerial64 != second.VolumeSerial64 ||
                first.Sddl != second.Sddl || first.Attributes != second.Attributes)
                throw new InvalidOperationException(label + "不是同一对象视图");
        }
    }
}
