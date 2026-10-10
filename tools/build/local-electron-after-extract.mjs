import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const expectedExampleSha256 = '0eb2491b0a9ac94790389d39c09dd5005c6c1f0665842943829bbd0193f6cc4f';

/** Match normal cleanup before builder computes the ASAR integrity resource. */
export default function finishLocalElectronPackage(context) {
  const packageRoot = resolve(repository, 'release/win-unpacked');
  if (resolve(context.appOutDir) !== packageRoot) throw new Error('本地运行时包目录失配');
  for (const directory of [
    repository,
    join(repository, 'release'),
    packageRoot,
    join(packageRoot, 'resources'),
  ]) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('本地运行时包祖先失配');
  }
  const example = join(packageRoot, 'resources/default_app.asar');
  const version = join(packageRoot, 'version');
  const stat = lstatSync(example);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 110862)
    throw new Error('Electron示例身份失配');
  const digest = createHash('sha256').update(readFileSync(example)).digest('hex');
  if (digest !== expectedExampleSha256) throw new Error('Electron示例摘要失配');
  const versionStat = lstatSync(version);
  if (
    !versionStat.isFile() ||
    versionStat.isSymbolicLink() ||
    versionStat.nlink !== 1 ||
    versionStat.size !== 6 ||
    readFileSync(version, 'utf8') !== '43.7.7'
  )
    throw new Error('Electron版本文件失配');
  // Validate both members before changing either. Never widen the package policy.
  unlinkSync(example);
  unlinkSync(version);
}
