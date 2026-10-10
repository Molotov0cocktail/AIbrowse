import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractFile, getRawHeader, statFile } from '@electron/asar';
import { parseBuildProvenance } from './build-provenance.ts';
import { verifyPackagedDirectory } from './package-policy.ts';

const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const hashPattern = /^[a-f0-9]{64}$/u;
export const cases = ['content-tamper', 'loose-app-tamper'] as const;
export const toolSources = [
  'tools/release/final-runtime-security-check.ts',
  'tools/release/final-runtime-security-check.ps1',
  'tools/release/FinalRuntimeSecurityCheck.cs',
  'tools/release/package-policy.ts',
  'tools/release/build-provenance.ts',
  'tools/release/installer-provenance.ts',
  'tools/build/msi-build.ts',
  'tools/build/msi-authoring.ts',
  'tools/release-profile/JobProcess.cs',
  'tools/release-profile/DisposableProfile.cs',
  'tools/release-profile/ProfileIsolation.cs',
  'tools/release-profile/ReleaseDataIdentity.cs',
] as const;

export function parseFirstEmpty(bytes: Buffer, expectedRoot: string): Record<string, unknown> {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  const record = value as Record<string, unknown>;
  assert(record.ok === true && record.empty === true);
  assert(typeof record.declaredProfile === 'string' && isAbsolute(record.declaredProfile));
  assert(typeof record.resolvedProfile === 'string' && isAbsolute(record.resolvedProfile));
  assert.equal(resolve(record.resolvedProfile).toLowerCase(), resolve(expectedRoot).toLowerCase());
  assert(record.identity !== null && typeof record.identity === 'object');
  const identity = record.identity as Record<string, unknown>;
  assert(typeof identity.FileId128 === 'string' && /^[a-f0-9]{32}$/iu.test(identity.FileId128));
  assert(
    typeof identity.VolumeSerial64 === 'string' && /^[a-f0-9]{16}$/iu.test(identity.VolumeSerial64),
  );
  assert(typeof identity.Sddl === 'string' && identity.Sddl.length > 0);
  return record;
}

export function whitespaceMutation(bytes: Buffer, offset: number): Buffer {
  assert(Number.isSafeInteger(offset) && offset >= 0 && offset < bytes.length);
  assert.equal(bytes[offset], 0x20);
  const result = Buffer.from(bytes);
  result[offset] = 0x09;
  return result;
}

function boundFile(path: string, expected?: string, maximum = 1024 * 1024): Buffer {
  const before = lstatSync(path, { bigint: true });
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
  assert(before.size >= 1n && before.size <= BigInt(maximum));
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  assert.deepEqual(
    [after.dev, after.ino, after.size, after.mtimeNs],
    [before.dev, before.ino, before.size, before.mtimeNs],
  );
  assert.equal(BigInt(bytes.length), before.size);
  if (expected !== undefined) {
    assert(hashPattern.test(expected));
    assert.equal(sha(bytes), expected);
  }
  return bytes;
}

function payload(root: string): { path: string; bytes: number; sha256: string }[] {
  const result: { path: string; bytes: number; sha256: string }[] = [];
  let total = 0;
  const visit = (directory: string): void => {
    const stat = lstatSync(directory);
    assert(stat.isDirectory() && !stat.isSymbolicLink());
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name);
      if (item.isDirectory()) visit(path);
      else {
        assert(item.isFile() && !item.isSymbolicLink());
        const bytes = boundFile(path, undefined, 512 * 1024 * 1024);
        total += bytes.length;
        assert(total <= 1024 * 1024 * 1024 && result.length < 256);
        result.push({
          path: relative(root, path).replaceAll('\\', '/'),
          bytes: bytes.length,
          sha256: sha(bytes),
        });
      }
    }
  };
  visit(root);
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function prepare(args: readonly string[]): Promise<void> {
  const prepareStarted = performance.now();
  assert.equal(
    args.length,
    7,
    '需要固定包、来源清单/hash、首次空根证据/hash、profile实体根及新scope',
  );
  const [
    packageArgument,
    manifestArgument,
    manifestSha,
    firstArgument,
    firstSha,
    rootArgument,
    scopeArgument,
  ] = args;
  for (const path of [
    packageArgument,
    manifestArgument,
    firstArgument,
    rootArgument,
    scopeArgument,
  ])
    assert(isAbsolute(path));
  const packageRoot = resolve(packageArgument);
  const profileRoot = resolve(rootArgument);
  const scope = resolve(scopeArgument);
  const repository = resolve(import.meta.dirname, '../..');
  assert.equal(dirname(scope).toLowerCase(), resolve(repository, 'log/stage7-e5').toLowerCase());
  assert(/^final-runtime-security-[a-f0-9]{32}$/u.test(relative(dirname(scope), scope)));
  assert(!existsSync(scope), 'scope已存在，不重放');
  const manifestBytes = boundFile(manifestArgument, manifestSha, 4 * 1024 * 1024);
  const manifest = parseBuildProvenance(JSON.parse(manifestBytes.toString('utf8')) as unknown);
  assert(manifest.candidateEligible && manifest.source.dirty === false, '仅最终洁净候选');
  const firstBytes = boundFile(firstArgument, firstSha);
  parseFirstEmpty(firstBytes, profileRoot);
  const verified = await verifyPackagedDirectory(packageRoot);
  const files = payload(packageRoot);
  assert.deepEqual(files, manifest.payload.packageFiles);
  assert.equal(verified.asarSha256, manifest.payload.asar.sha256);
  assert.equal(verified.executableSha256, manifest.payload.executable.sha256);
  mkdirSync(scope);
  try {
    writeFileSync(join(scope, 'source-manifest.json'), manifestBytes, { flag: 'wx' });
    writeFileSync(join(scope, 'first-empty.json'), firstBytes, { flag: 'wx' });
    const fixtures = [];
    for (const scene of cases) {
      const destination = join(scope, scene);
      mkdirSync(destination);
      for (const file of files) {
        const target = join(destination, file.path);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(join(packageRoot, file.path), target, constants.COPYFILE_EXCL);
        assert(performance.now() - prepareStarted < 180_000, '准备超过180秒，未启动产品');
      }
      assert.deepEqual(payload(destination), files);
      const asar = join(destination, 'resources/app.asar');
      const canary = join(scope, `${scene}-canary.txt`);
      let mutation: unknown;
      if (scene === 'content-tamper') {
        const member = 'out\\release\\main\\index.js';
        const main = extractFile(asar, member);
        const marker = main.indexOf(Buffer.from('\n  '));
        assert(marker >= 0);
        const info = statFile(asar, member, false);
        assert(!('files' in info) && !('link' in info) && !info.unpacked);
        const offset = 8 + getRawHeader(asar).headerSize + Number(info.offset) + marker + 1;
        const original = readFileSync(asar);
        const changed = whitespaceMutation(original, offset);
        writeFileSync(asar, changed);
        mutation = {
          offset,
          before: 32,
          after: 9,
          originalSha256: sha(original),
          changedSha256: sha(changed),
        };
      } else {
        // Retain the original ASAR bytes; only this exclusive copy is renamed.
        const { renameSync } = await import('node:fs');
        renameSync(asar, asar + '.removed');
        const loose = join(destination, 'resources/app');
        mkdirSync(loose);
        writeFileSync(join(loose, 'package.json'), '{"main":"index.js"}\n', { flag: 'wx' });
        writeFileSync(
          join(loose, 'index.js'),
          `require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'hit')\n`,
          { flag: 'wx' },
        );
        mutation = { removedAsarSha256: sha(readFileSync(asar + '.removed')) };
      }
      fixtures.push({
        scene,
        executable: join(destination, 'AIbrowse.exe'),
        canary,
        mutation,
        files: payload(destination),
      });
    }
    assert.deepEqual(payload(packageRoot), files, '原始包准备期间变化');
    const prepared = {
      schema: 1,
      scope,
      packageRoot,
      profileRoot,
      finalSourceManifestPath: resolve(manifestArgument),
      finalSourceManifestSha256: manifestSha,
      firstEmptyEvidencePath: resolve(firstArgument),
      firstEmptyEvidenceSha256: firstSha,
      source: manifest.source,
      verification: verified,
      originalFiles: files,
      fixtures,
      tools: toolSources.map((path) => ({
        path,
        sha256: sha(boundFile(join(repository, path), undefined, 4 * 1024 * 1024)),
      })),
      launchBudgetMs: 6000,
      prepareBudgetMs: 180_000,
      prepareElapsedMs: Math.ceil(performance.now() - prepareStarted),
      productExecuted: false,
      profileRead: false,
    };
    writeFileSync(join(scope, 'prepared.json'), JSON.stringify(prepared, null, 2) + '\n', {
      flag: 'wx',
    });
    process.stdout.write(
      JSON.stringify({ scope, preparedSha256: sha(readFileSync(join(scope, 'prepared.json'))) }) +
        '\n',
    );
  } catch (error: unknown) {
    writeFileSync(
      join(scope, 'prepare-failure.json'),
      JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : '准备失败',
        productExecuted: false,
      }) + '\n',
      { flag: 'wx' },
    );
    throw error;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await prepare(process.argv.slice(2));
}
