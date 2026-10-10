import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const source = readFileSync('tools/data-qualification/oversize-preflight/run.ps1', 'utf8');
const buildSource = readFileSync('tools/data-qualification/oversize-preflight/build.ts', 'utf8');

it('wrapper以声明参数和CreateNew intent形成一次性claim', () => {
  expect(source).toContain('[CmdletBinding()]');
  expect(source).toContain("[ValidatePattern('^oversize-preflight-[a-f0-9]{32}$')]");
  expect(source).not.toMatch(/\$args\b/u);
  expect(source).toContain("Join-Path $scope 'preflight-intent.json'");
  expect(source).toContain('[IO.FileMode]::CreateNew');
  expect(source).toContain(
    "if(Test-Path -LiteralPath $intentPath){throw '本scope已有claim，禁止重跑'}",
  );
});

it('wrapper冻结四个EOF、稀疏回读、预算、真实入口回执和闭合集', () => {
  for (const value of ['5368709121', '536870913', '67108865']) expect(source).toContain(value);
  expect(source).toContain('SparseFile]::Create');
  expect(source).toContain('AllocatedBytes -gt 1048576');
  expect(source).toContain('$totalAllocated -gt 16777216');
  expect(source).toContain('$disk.AvailableBytes -lt 1073741824');
  expect(source).toContain("Join-Path $scope 'complete.json'");
  expect(source).toContain('Assert-Closure');
  expect(source).toContain("[AIbrowse.FullTransfer.FixedTransferJob]::Execute('import'");
  expect(source).toContain("$result.phase='pending-wrapper-exit'");
  expect(source).toContain('requiresWrapperExit=$true');
});

it('新build-only证明精确绑定真实esbuild输入并集和三个制品', async () => {
  const repository = process.cwd();
  const output = execFileSync(
    process.execPath,
    ['--experimental-strip-types', 'tools/data-qualification/oversize-preflight/build.ts'],
    { cwd: repository, encoding: 'utf8', windowsHide: true, timeout: 30_000 },
  );
  const receipt = JSON.parse(output) as { scopeId: string; executed: boolean };
  expect(receipt.scopeId).toMatch(/^oversize-preflight-[a-f0-9]{32}$/u);
  expect(receipt.executed).toBe(false);
  const scope = join(repository, 'log/stage7-e2', receipt.scopeId);
  const proof = JSON.parse(readFileSync(join(scope, 'build-proof.json'), 'utf8')) as {
    sourceCommit: string;
    sources: Record<string, string>;
    artifacts: Record<string, { bytes: number; sha256: string }>;
    workerBundle: { inputs: Record<string, string>; sha256: string };
  };
  expect(proof.sourceCommit).toBe(
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repository,
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
  );
  expect(buildSource.match(/\['rev-parse', 'HEAD'\]/gu)).toHaveLength(2);
  expect(buildSource).not.toContain('54783cd0c3e22c1fb692b54fca95fc650e2ea15d');
  const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
  const rebuilt = await build({
    absWorkingDir: repository,
    entryPoints: ['tools/data-qualification/oversize-preflight/worker.ts'],
    outfile: join(scope, 'worker.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    metafile: true,
    write: false,
  });
  const inputNames = Object.keys(rebuilt.metafile.inputs).map((name) => name.replaceAll('\\', '/'));
  expect(Object.keys(proof.workerBundle.inputs).sort()).toEqual(inputNames.sort());
  expect(inputNames).toHaveLength(8);
  const expectedSources = new Set([
    ...readdirSync(join(repository, 'tools/data-qualification/oversize-preflight')).map(
      (name) => `tools/data-qualification/oversize-preflight/${name}`,
    ),
    ...inputNames,
    'package.json',
    'package-lock.json',
    'tools/data-qualification/full-transfer/FixedTransferJob.cs',
  ]);
  expect(Object.keys(proof.sources).sort()).toEqual([...expectedSources].sort());
  expect(expectedSources.size).toBe(19);
  for (const [name, hash] of Object.entries(proof.sources)) {
    expect(digest(readFileSync(join(repository, name)))).toBe(hash);
  }
  for (const name of inputNames) expect(proof.workerBundle.inputs[name]).toBe(proof.sources[name]);
  expect(Object.keys(proof.artifacts).sort()).toEqual([
    'FixedTransferJob.cs',
    'SparseFile.cs',
    'worker.cjs',
  ]);
  for (const [name, artifact] of Object.entries(proof.artifacts)) {
    expect(statSync(join(scope, name)).size).toBe(artifact.bytes);
    expect(digest(readFileSync(join(scope, name)))).toBe(artifact.sha256);
  }
  expect(proof.artifacts['SparseFile.cs']!.sha256).toBe(
    proof.sources['tools/data-qualification/oversize-preflight/SparseFile.cs'],
  );
  expect(proof.artifacts['FixedTransferJob.cs']!.sha256).toBe(
    proof.sources['tools/data-qualification/full-transfer/FixedTransferJob.cs'],
  );
  expect(rebuilt.outputFiles).toHaveLength(1);
  expect(digest(rebuilt.outputFiles[0]!.contents)).toBe(proof.artifacts['worker.cjs']!.sha256);
  expect(proof.workerBundle.sha256).toBe(proof.artifacts['worker.cjs']!.sha256);
  expect(readdirSync(scope).sort()).toEqual([
    'FixedTransferJob.cs',
    'SparseFile.cs',
    'build-proof.json',
    'worker.cjs',
  ]);
  process.stdout.write(
    JSON.stringify({
      scopeId: receipt.scopeId,
      sources: 19,
      artifacts: 3,
      bundleInputs: 8,
      proofSha256: digest(readFileSync(join(scope, 'build-proof.json'))),
      executed: false,
    }) + '\n',
  );
});
