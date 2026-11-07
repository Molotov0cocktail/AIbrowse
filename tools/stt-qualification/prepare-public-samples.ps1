[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [string]$Proxy = 'http://127.0.0.1:7890',
    [string]$AssetCacheDir,
    [long]$PriorDownloadedBytes = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Net.Http
Add-Type -AssemblyName System.IO.Compression.FileSystem
$destination = [System.IO.Path]::GetFullPath($OutputDir)
if (Test-Path -LiteralPath $destination) { throw '准备目录已存在，禁止覆盖证据' }
[void][System.IO.Directory]::CreateDirectory($destination)
$assetDir = Join-Path $destination 'assets'
$sampleDir = Join-Path $destination 'samples'
[void][System.IO.Directory]::CreateDirectory($assetDir)
[void][System.IO.Directory]::CreateDirectory($sampleDir)
$handler = [System.Net.Http.HttpClientHandler]::new()
$handler.Proxy = [System.Net.WebProxy]::new($Proxy)
$handler.UseProxy = $true
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromMinutes(5)
$client.DefaultRequestHeaders.UserAgent.ParseAdd('AIbrowse-STT-assessment/1.0')
$script:downloadedBytes = $PriorDownloadedBytes
$totalBudget = [long](300MB)
$assetRecords = [System.Collections.Generic.List[object]]::new()
$samples = [System.Collections.Generic.List[object]]::new()
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
public static class SttPcm16 {
    public static int Convert(string input, string output, long offset, int bytes) {
        int clipped = 0;
        using (var reader = new BinaryReader(File.OpenRead(input)))
        using (var writer = new BinaryWriter(File.Open(output, FileMode.CreateNew))) {
            int outputBytes = checked(bytes / 2);
            writer.Write(Encoding.ASCII.GetBytes("RIFF")); writer.Write(36 + outputBytes);
            writer.Write(Encoding.ASCII.GetBytes("WAVEfmt ")); writer.Write(16);
            writer.Write((short)1); writer.Write((short)1); writer.Write(16000); writer.Write(32000);
            writer.Write((short)2); writer.Write((short)16); writer.Write(Encoding.ASCII.GetBytes("data")); writer.Write(outputBytes);
            reader.BaseStream.Position = offset;
            for (int i = 0; i < bytes / 4; i++) {
                float value = reader.ReadSingle();
                if (float.IsNaN(value) || float.IsInfinity(value)) throw new InvalidDataException("Invalid audio sample");
                if (value < -1 || value > 1) clipped++;
                writer.Write((short)Math.Max(-32768, Math.Min(32767, Math.Round(value * 32768.0))));
            }
        }
        return clipped;
    }
}
'@

function Receive-BoundedFile([string]$Uri, [string]$Path, [long]$Limit) {
    $response = $client.GetAsync($Uri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    try {
        if (-not $response.IsSuccessStatusCode) { throw ('公开资源下载HTTP失败：' + [int]$response.StatusCode) }
        if ($response.Content.Headers.ContentLength -gt $Limit) { throw '公开资源超过单文件预算' }
        $inputStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $outputStream = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew)
        try {
            $buffer = New-Object byte[] 65536
            $count = [long]0
            while (($received = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $count += $received
                $script:downloadedBytes += $received
                if ($count -gt $Limit -or $script:downloadedBytes -gt $totalBudget) { throw '累计或单文件下载预算超限' }
                $outputStream.Write($buffer, 0, $received)
            }
        } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    } finally { $response.Dispose() }
}

function Get-WaveInfo([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $reader = [System.IO.BinaryReader]::new($stream)
    try {
        $ascii = [System.Text.Encoding]::ASCII
        if ($ascii.GetString($reader.ReadBytes(4)) -ne 'RIFF') { throw '样本不是RIFF WAV' }
        [void]$reader.ReadUInt32()
        if ($ascii.GetString($reader.ReadBytes(4)) -ne 'WAVE') { throw '样本不是WAVE' }
        $format = $null
        $dataBytes = [long]0
        $dataOffset = [long]0
        while ($stream.Position + 8 -le $stream.Length) {
            $tag = $ascii.GetString($reader.ReadBytes(4))
            $length = [long]$reader.ReadUInt32()
            $end = $stream.Position + $length
            if ($end -gt $stream.Length) { throw 'WAV块越界' }
            if ($tag -eq 'fmt ') {
                if ($length -lt 16) { throw 'WAV格式块不足' }
                $format = @{ encoding = $reader.ReadUInt16(); channels = $reader.ReadUInt16(); rate = $reader.ReadUInt32(); byteRate = $reader.ReadUInt32(); blockAlign = $reader.ReadUInt16(); bits = $reader.ReadUInt16() }
            }
            if ($tag -eq 'data') {
                if ($dataBytes -gt 0) { throw '样本含多个数据块，需另行规范化' }
                $dataOffset = $stream.Position
                $dataBytes = $length
            }
            $stream.Position = $end + ($length % 2)
        }
        $pcm16 = $format.encoding -eq 1 -and $format.bits -eq 16 -and $format.byteRate -eq 32000
        $float32 = $format.encoding -eq 3 -and $format.bits -eq 32 -and $format.byteRate -eq 64000
        if ($null -eq $format -or $format.channels -ne 1 -or $format.rate -ne 16000 -or (-not $pcm16 -and -not $float32) -or $dataBytes -le 0) { throw '样本须为16kHz单声道PCM16或Float32' }
        return @{ durationSeconds = $dataBytes / [double]$format.byteRate; sampleCount = $dataBytes / ($format.bits / 8); format = $format; dataOffset = $dataOffset; dataBytes = $dataBytes }
    } finally { $reader.Dispose(); $stream.Dispose() }
}

try {
    $modelRevision = '5359861c739e955e79d9a303bcbc70fb988958b1'
    $assets = @(
        @{ name = 'whisper-bin-x64.zip'; bytes = 8573270; sha256 = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'; url = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip' },
        @{ name = 'ggml-base-q5_1.bin'; bytes = 59707625; sha256 = '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'; url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/$modelRevision/ggml-base-q5_1.bin" },
        @{ name = 'ggml-small-q5_1.bin'; bytes = 190085487; sha256 = 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'; url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/$modelRevision/ggml-small-q5_1.bin" }
    )
    foreach ($asset in $assets) {
        if ($AssetCacheDir) {
            $path = Join-Path ([IO.Path]::GetFullPath($AssetCacheDir)) $asset.name
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw '复用资产不存在，禁止无诊断重新下载' }
        } else {
            $path = Join-Path $assetDir $asset.name
            Receive-BoundedFile $asset.url $path $asset.bytes
        }
        $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ((Get-Item -LiteralPath $path).Length -ne $asset.bytes -or $hash -ne $asset.sha256) { throw ('资产身份不匹配：' + $asset.name) }
        $assetRecords.Add(@{ name = $asset.name; path = $path; sha256 = $hash; bytes = $asset.bytes; source = $asset.url })
        Write-Output ('资产摘要验证通过：' + $asset.name)
    }
    # Inspect all archive destinations before extraction; never evaluate archive contents here.
    $zipPath = ($assetRecords | Where-Object name -eq 'whisper-bin-x64.zip').path
    $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
    $binaryDir = Join-Path $assetDir 'whisper'
    $prefix = $binaryDir.TrimEnd('\') + '\'
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    try {
        if ($archive.Entries.Count -gt 100) { throw 'CLI归档条目过多' }
        $expandedBytes = [long]0
        foreach ($entry in $archive.Entries) {
            $entryName = $entry.FullName.Replace('/', '\')
            $target = [System.IO.Path]::GetFullPath((Join-Path $binaryDir $entryName))
            $expandedBytes += $entry.Length
            if (-not $target.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or $entryName.Contains(':') -or -not $seen.Add($target) -or $expandedBytes -gt 100MB) { throw 'CLI归档路径或体积校验失败' }
        }
    } finally { $archive.Dispose() }
    [System.IO.Compression.ZipFile]::ExtractToDirectory($zipPath, $binaryDir)

    $revision = '70bb2e84b976b7e960aa89f1c648e09c59f894dd'
    $sets = @(
        @{ config = 'en_us'; language = 'en'; ids = @(1548, 1620, 1510, 1578) },
        @{ config = 'cmn_hans_cn'; language = 'zh'; ids = @(1579, 1605) },
        @{ config = 'ja_jp'; language = 'ja'; ids = @(1519, 1608) }
    )
    foreach ($set in $sets) {
        $metadataPath = Join-Path $sampleDir ($set.config + '-metadata.json')
        Receive-BoundedFile ('https://datasets-server.huggingface.co/first-rows?dataset=google%2Ffleurs&config=' + $set.config + '&split=validation') $metadataPath 2MB
        $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding utf8 | ConvertFrom-Json
        for ($index = 0; $index -lt $set.ids.Count; $index++) {
            $row = $metadata.rows[$index].row
            if ([int]$row.id -ne $set.ids[$index] -or -not ([string]$row.audio[0].src).Contains($revision)) { throw '固定语料身份发生变化' }
            $id = $set.config + '-' + $row.id
            $rawPath = Join-Path $sampleDir ($id + '.raw.wav')
            Receive-BoundedFile $row.audio[0].src $rawPath 2MB
            $wave = Get-WaveInfo $rawPath
            if ($wave.sampleCount -ne $row.num_samples) { throw '音频样本数与原文元数据不一致' }
            $path = Join-Path $sampleDir ($id + '.wav')
            $clipped = 0
            if ($wave.format.encoding -eq 3) {
                $clipped = [SttPcm16]::Convert($rawPath, $path, $wave.dataOffset, $wave.dataBytes)
            } else { [IO.File]::Copy($rawPath, $path, $false) }
            if ($clipped -gt 0) { throw '公开音频出现削波，停止以保持质量对照' }
            $preparedWave = Get-WaveInfo $path
            if ($preparedWave.format.encoding -ne 1 -or $preparedWave.sampleCount -ne $wave.sampleCount) { throw '音频规范化改变样本数或编码错误' }
            $samples.Add(@{ id = $id; language = $set.language; audioPath = $path; reference = $row.raw_transcription; normalizedReference = $row.transcription; durationSeconds = $wave.durationSeconds; sha256 = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant(); rawAudioPath = $rawPath; rawSha256 = (Get-FileHash -LiteralPath $rawPath -Algorithm SHA256).Hash.ToLowerInvariant(); conversion = '16kHz单声道Float32转PCM16，不重采样/裁剪/降噪；无削波'; datasetRow = $index; datasetId = $row.id; originalPath = $row.path; source = 'https://huggingface.co/datasets/google/fleurs'; revision = $revision; split = 'validation'; license = 'CC-BY-4.0' })
        }
        # Retain references and identity without expiring signed download URLs.
        $metadata.rows | ForEach-Object { $_.row.audio = @() }
        [System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json -Depth 30), [System.Text.UTF8Encoding]::new($false))
    }
    $duration = ($samples | Measure-Object -Property durationSeconds -Sum).Sum
    if ($samples.Count -ne 8 -or [Math]::Abs($duration - 94.76) -gt 0.01 -or $duration -gt 180) { throw '固定样本总量或时长不符' }
    $manifest = @{ schemaVersion = 1; createdAt = [DateTime]::UtcNow.ToString('o'); downloadedBytes = $script:downloadedBytes; downloadBudgetBytes = $totalBudget; assets = $assetRecords.ToArray(); samples = $samples.ToArray(); totalDurationSeconds = $duration; limitations = @('朗读短句，仅作可行性筛选', '参考文本未独立人工听审', '不代表真实观看共存结果') }
    [System.IO.File]::WriteAllText((Join-Path $destination 'manifest.json'), ($manifest | ConvertTo-Json -Depth 12), [System.Text.UTF8Encoding]::new($false))
    Write-Output ('准备完成：' + $samples.Count + '条，' + $duration + '秒；总下载字节：' + $script:downloadedBytes)
} finally { $client.Dispose(); $handler.Dispose() }
