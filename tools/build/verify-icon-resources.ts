import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { extractFile } from '@electron/asar';
import { NtExecutable, NtExecutableResource, Resource } from 'resedit';

const EXPECTED_SIZES = [16, 20, 24, 32, 48, 64, 128, 256] as const;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface IconFrame {
  readonly width: number;
  readonly height: number;
  readonly planes: number;
  readonly bitCount: number;
  readonly bytes: Buffer;
  readonly sha256: string;
}

interface PeFrameReport {
  readonly size: number;
  readonly iconId: number;
  readonly directoryBytes: number;
  readonly resourceBytes: number;
  readonly sha256: string;
  readonly sourceSha256: string;
  readonly exact: boolean;
  readonly encoding: 'png' | 'dib';
}

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const same = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && left.equals(right);

const ordinaryFile = (path: string): void => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`必须是单链接普通文件：${path}`);
  }
  if (realpathSync(path) !== path) throw new Error(`文件路径发生重定向：${path}`);
};

export function parseIco(bytes: Buffer): readonly IconFrame[] {
  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    throw new Error('ICO 文件头无效');
  }
  const count = bytes.readUInt16LE(4);
  if (count < 1 || bytes.length < 6 + count * 16) throw new Error('ICO 目录无效');
  const frames: IconFrame[] = [];
  let expectedOffset = 6 + count * 16;
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = bytes[entry] === 0 ? 256 : bytes[entry]!;
    const height = bytes[entry + 1] === 0 ? 256 : bytes[entry + 1]!;
    const colors = bytes[entry + 2]!;
    const reserved = bytes[entry + 3]!;
    const planes = bytes.readUInt16LE(entry + 4);
    const bitCount = bytes.readUInt16LE(entry + 6);
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    if (
      colors !== 0 ||
      reserved !== 0 ||
      planes !== 1 ||
      bitCount !== 32 ||
      length === 0 ||
      offset !== expectedOffset ||
      offset + length > bytes.length
    ) {
      throw new Error(`ICO 第 ${index + 1} 帧目录无效`);
    }
    const frame = bytes.subarray(offset, offset + length);
    if (!frame.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw new Error(`ICO 第 ${index + 1} 帧不是 PNG`);
    }
    frames.push({ width, height, planes, bitCount, bytes: frame, sha256: hash(frame) });
    expectedOffset += length;
  }
  if (expectedOffset !== bytes.length) throw new Error('ICO 含目录外附加数据');
  const sizes = frames.map((frame) => frame.width);
  if (
    frames.some((frame) => frame.width !== frame.height) ||
    sizes.join(',') !== EXPECTED_SIZES.join(',')
  ) {
    throw new Error(`ICO 尺寸集合无效：${sizes.join(',')}`);
  }
  return frames;
}

const frameMap = (frames: readonly IconFrame[]): ReadonlyMap<number, IconFrame> =>
  new Map(frames.map((frame) => [frame.width, frame]));

const resourceEncoding = (bytes: Buffer): 'png' | 'dib' => {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png';
  if (bytes.length >= 40 && bytes.readUInt32LE(0) === 40) return 'dib';
  throw new Error('RT_ICON 既不是 PNG 也不是 BITMAPINFOHEADER DIB');
};

function inspectPeIcon(
  path: string,
  sourceFrames: readonly IconFrame[],
  strictExact: boolean,
): {
  readonly groupId: string | number;
  readonly lang: string | number;
  readonly frames: PeFrameReport[];
} {
  ordinaryFile(path);
  const executable = NtExecutable.from(readFileSync(path), { ignoreCert: true });
  const resources = NtExecutableResource.from(executable);
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  if (groups.length !== 1) throw new Error(`${basename(path)} 必须恰好包含一个 RT_GROUP_ICON`);
  const group = groups[0]!;
  const source = frameMap(sourceFrames);
  const seen = new Set<number>();
  const frames = group.icons.map((item): PeFrameReport => {
    const width = item.width === 0 ? 256 : item.width;
    const height = item.height === 0 ? 256 : item.height;
    if (width !== height || seen.has(width))
      throw new Error(`${basename(path)} 图标尺寸重复或非正方形`);
    seen.add(width);
    const expected = source.get(width);
    if (expected === undefined)
      throw new Error(`${basename(path)} 含来源 ICO 没有的 ${width}px 帧`);
    const matches = resources.entries.filter(
      (entry) => entry.type === 3 && entry.id === item.iconID && entry.lang === group.lang,
    );
    if (matches.length !== 1) throw new Error(`${basename(path)} 的 RT_ICON 引用不唯一`);
    const bytes = Buffer.from(matches[0]!.bin);
    const exact = same(bytes, expected.bytes);
    if (strictExact && (!exact || item.dataSize !== bytes.length)) {
      throw new Error(`${basename(path)} 的 ${width}px RT_ICON 未原样绑定来源 ICO`);
    }
    if (item.planes !== 1 || item.bitCount !== 32) {
      throw new Error(`${basename(path)} 的 ${width}px RT_ICON 元数据无效`);
    }
    return {
      size: width,
      iconId: item.iconID,
      directoryBytes: item.dataSize,
      resourceBytes: bytes.length,
      sha256: hash(bytes),
      sourceSha256: expected.sha256,
      exact,
      encoding: resourceEncoding(bytes),
    };
  });
  if (strictExact && [...seen].sort((a, b) => a - b).join(',') !== EXPECTED_SIZES.join(',')) {
    throw new Error(`${basename(path)} 未包含来源 ICO 的全部八个尺寸`);
  }
  if (!strictExact && (!seen.has(16) || !seen.has(256) || seen.size < 4)) {
    throw new Error(`${basename(path)} 的 NSIS 图标尺寸覆盖不足`);
  }
  return { groupId: group.id, lang: group.lang, frames };
}

export const readMsiIcon = (
  path: string,
): { readonly bytes: Buffer; readonly shortcuts: string[] } => {
  ordinaryFile(path);
  const script = [
    "$ErrorActionPreference='Stop'",
    '$installer=New-Object -ComObject WindowsInstaller.Installer',
    '$database=$installer.OpenDatabase([IO.Path]::GetFullPath($args[0]),0)',
    "$view=$database.OpenView('SELECT `Name`, `Data` FROM `Icon`')",
    '$view.Execute();$rows=@()',
    "while($null-ne($record=$view.Fetch())){$size=$record.DataSize(2);$text=[string]$record.ReadStream(2,$size,1);$bytes=[byte[]]::new($text.Length);for($n=0;$n-lt$text.Length;$n++){$code=[int][char]$text[$n];if($code-gt255){throw'Icon流字符越界'};$bytes[$n]=[byte]$code};$rows+=@{name=$record.StringData(1);bytes=[Convert]::ToBase64String($bytes)}}",
    "$view.Close();if($rows.Count-ne1-or$rows[0].name-cne'AppIcon.exe'){throw'MSI Icon表形状无效'}",
    "$property=$database.OpenView('SELECT `Value` FROM `Property` WHERE `Property`=''ARPPRODUCTICON''')",
    "$property.Execute();$propertyRecord=$property.Fetch();if($null-eq$propertyRecord-or$propertyRecord.StringData(1)-cne'AppIcon.exe'-or$null-ne$property.Fetch()){throw'MSI ARPPRODUCTICON无效'};$property.Close()",
    "$shortcut=$database.OpenView('SELECT `Shortcut`, `Icon_` FROM `Shortcut`')",
    "$shortcut.Execute();$shortcuts=@();while($null-ne($record=$shortcut.Fetch())){if($record.StringData(2)-cne'AppIcon.exe'){throw'MSI快捷方式图标无效'};$shortcuts+=$record.StringData(1)};$shortcut.Close();if($shortcuts.Count-ne2){throw'MSI快捷方式数量无效'}",
    '@{bytes=$rows[0].bytes;shortcuts=$shortcuts}|ConvertTo-Json -Compress',
  ].join(';');
  const output = execFileSync(
    'pwsh',
    ['-NoProfile', '-NonInteractive', '-Command', `& { ${script} }`, path],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const value: unknown = JSON.parse(output);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('bytes' in value) ||
    typeof value.bytes !== 'string' ||
    !('shortcuts' in value) ||
    !Array.isArray(value.shortcuts) ||
    !value.shortcuts.every((item) => typeof item === 'string')
  ) {
    throw new Error('MSI 图标只读导出结果无效');
  }
  return { bytes: Buffer.from(value.bytes, 'base64'), shortcuts: value.shortcuts };
};

export function verifyIconResources(repository = resolve('.')): object {
  const metadata: unknown = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));
  if (
    typeof metadata !== 'object' ||
    metadata === null ||
    !('version' in metadata) ||
    typeof metadata.version !== 'string' ||
    !/^\d+\.\d+\.\d+$/u.test(metadata.version)
  ) {
    throw new Error('package version 无效');
  }
  const sourcePath = join(repository, 'resources/aibrowse.ico');
  const asarPath = join(repository, 'release/win-unpacked/resources/app.asar');
  const appPath = join(repository, 'release/win-unpacked/AIbrowse.exe');
  const stem = `AIbrowse-${metadata.version}-win-x64-internal`;
  const installerPath = join(repository, 'release', `${stem}.exe`);
  const msiPath = join(repository, 'release', `${stem}.msi`);
  for (const path of [sourcePath, asarPath, appPath, installerPath, msiPath]) ordinaryFile(path);
  const source = readFileSync(sourcePath);
  const frames = parseIco(source);
  const packaged = extractFile(asarPath, 'resources/aibrowse.ico');
  if (!same(source, packaged)) throw new Error('ASAR 图标与受控来源 ICO 字节不一致');
  const app = inspectPeIcon(appPath, frames, true);
  const installer = inspectPeIcon(installerPath, frames, false);
  const msi = readMsiIcon(msiPath);
  if (!same(msi.bytes, source)) throw new Error('MSI Icon 表与受控来源 ICO 字节不一致');
  return {
    passed: true,
    productExecuted: false,
    source: { path: sourcePath, bytes: source.length, sha256: hash(source), sizes: EXPECTED_SIZES },
    asar: { path: asarPath, sha256: hash(readFileSync(asarPath)), iconSha256: hash(packaged) },
    app: { path: appPath, sha256: hash(readFileSync(appPath)), ...app },
    installer: {
      path: installerPath,
      sha256: hash(readFileSync(installerPath)),
      ...installer,
      transformedFrames: installer.frames
        .filter((frame) => !frame.exact)
        .map((frame) => frame.size),
      renderValidationRequired: installer.frames.some((frame) => !frame.exact),
    },
    msi: {
      path: msiPath,
      sha256: hash(readFileSync(msiPath)),
      iconSha256: hash(msi.bytes),
      shortcuts: msi.shortcuts,
    },
  };
}

const invoked = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href;
if (invoked === import.meta.url) {
  if (process.argv.length !== 2) throw new Error('图标资源验证不接受外部路径参数');
  try {
    process.stdout.write(`${JSON.stringify(verifyIconResources(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
