// Compare executable sections and resources without changing either candidate.
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { NtExecutable, NtExecutableResource } from 'resedit';

const outputArgument = process.argv[2];
if (outputArgument !== undefined && outputArgument.trim() === '')
  throw new Error('比较证据输出路径不能为空');
const outputPath = resolve(outputArgument ?? 'log/browser-ux-20261012/packaging-comparison.json');
const outputDirectory = dirname(outputPath);
if (!existsSync(outputDirectory) || !statSync(outputDirectory).isDirectory())
  throw new Error('比较证据输出目录必须已存在');
const previous = readFileSync(resolve('output/win-unpacked/AIbrowse.exe'));
const candidate = readFileSync(resolve('release/win-unpacked/AIbrowse.exe'));
const hash = (value) => createHash('sha256').update(value).digest('hex');
const left = NtExecutable.from(previous);
const right = NtExecutable.from(candidate);
const a = left.getAllSections();
const b = right.getAllSections();
const sections = a.map((section, index) => ({
  name: section.info.name,
  sameBytes:
    b[index]?.info.name === section.info.name &&
    Buffer.from(section.data ?? new ArrayBuffer(0)).equals(
      Buffer.from(b[index].data ?? new ArrayBuffer(0)),
    ),
}));
const oldResources = NtExecutableResource.from(left).entries;
const newResources = NtExecutableResource.from(right).entries;
const key = (entry) => `${entry.type}/${entry.id}/${entry.lang}`;
const oldEntries = new Map(oldResources.map((entry) => [key(entry), entry]));
const newEntries = new Map(newResources.map((entry) => [key(entry), entry]));
const changedResources = [...new Set([...oldEntries.keys(), ...newEntries.keys()])].filter((id) => {
  const old = oldEntries.get(id);
  const current = newEntries.get(id);
  return (
    !old ||
    !current ||
    old.codepage !== current.codepage ||
    !Buffer.from(old.bin).equals(Buffer.from(current.bin))
  );
});
const result = {
  version: 1,
  previousExecutableSha256: hash(previous),
  candidateExecutableSha256: hash(candidate),
  oldSections: a.length,
  newSections: b.length,
  sections,
  oldResourceCount: oldResources.length,
  newResourceCount: newResources.length,
  changedResources,
  sameExtra: Buffer.from(left.getExtraData() ?? new ArrayBuffer(0)).equals(
    Buffer.from(right.getExtraData() ?? new ArrayBuffer(0)),
  ),
};
writeFileSync(outputPath, JSON.stringify(result, null, 2), { flag: 'wx' });
process.stdout.write(JSON.stringify(result) + '\n');
