import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { verifyPackagedDirectory } from '../release/package-policy.ts';
import { parseBuildProvenance } from '../release/build-provenance.ts';
import { collectMsiFiles } from '../build/msi-build.ts';
import { verifyProfileIsolationJournal } from '../release/profile-isolation-policy.ts';

// Fixed runner: only the verified package, v1 synthetic profile and native close collector.
const [packageArgument, outputArgument, appDataArgument, journalArgument] = process.argv.slice(2);
if (!packageArgument || !outputArgument || !appDataArgument || !journalArgument)
  throw new Error('包启动验收缺少固定参数');
const packageRoot = resolve(packageArgument),
  output = resolve(outputArgument),
  journal = resolve(journalArgument);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (file: string) => hash(readFileSync(file));
const save = (name: string, value: unknown) =>
  writeFileSync(join(output, name), JSON.stringify(value, null, 2), { flag: 'wx' });
const sources = [
  'tools/release-profile/ProfileIsolation.cs',
  'tools/release-profile/JobProcess.cs',
  'tools/release-profile/profile-isolation.ps1',
  'tools/legacy-followup/package-smoke.ts',
  'tools/legacy-followup/package-smoke.ps1',
  'tools/legacy-followup/package-lease.cs',
  'tools/data-qualification/product-restore-process/SuccessorObserver.cs',
];
let failed = false;
function failure(error: unknown): void {
  if (failed) return;
  failed = true;
  const value = {
    passed: false,
    error: error instanceof Error ? error.message : '未知失败',
    forcedStopIsFailure: true,
  };
  writeFileSync(join(output, 'package-failure.pending'), JSON.stringify(value), { flag: 'wx' });
  renameSync(join(output, 'package-failure.pending'), join(output, 'package-failure.json'));
  process.exitCode = 1;
}
async function main(): Promise<void> {
  const profile = verifyProfileIsolationJournal(resolve(appDataArgument!), journal);
  if (
    profile.version !== 1 ||
    dirname(output) !== journal ||
    output !== join(journal, 'runner-output')
  )
    throw new Error('包验收只能使用真实v1隔离journal');
  const verification = await verifyPackagedDirectory(packageRoot);
  const provenancePath = join(dirname(packageRoot), 'build-provenance.json');
  const provenance = parseBuildProvenance(JSON.parse(readFileSync(provenancePath, 'utf8')));
  const git = (...args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
  if (
    !provenance.candidateEligible ||
    provenance.source.dirty ||
    provenance.source.gitSha !== git('rev-parse', 'HEAD') ||
    git('status', '--porcelain=v1', '--untracked-files=all') !== ''
  )
    throw new Error('实际包必须绑定当前干净源码');
  if (
    JSON.stringify(collectMsiFiles(packageRoot)) !== JSON.stringify(provenance.payload.packageFiles)
  )
    throw new Error('完整包成员与来源绑定不符');
  const binding = {
    runId: profile.runId,
    packageRoot,
    journal,
    provenanceSha256: digest(provenancePath),
    executableSha256: verification.executableSha256,
    guardianSha256: verification.guardianSha256,
    asarSha256: verification.asarSha256,
    sources: sources.map((path) => ({ path, sha256: digest(path) })),
    budget: {
      totalMs: 120000,
      bootMs: 45000,
      closeMs: 20000,
      exitMs: 30000,
      observedProcesses: 24,
    },
    providerCalls: 0,
  };
  save('package-binding.json', binding);
  const spec = {
    ...binding,
    bindingSha256: digest(join(output, 'package-binding.json')),
    runnerPid: process.pid,
  };
  save('package-spec.json', spec);
  const timer = setTimeout(() => failure(new Error('包验收原工作期限耗尽')), 110000);
  const env = { ...process.env };
  for (const name of Object.keys(env))
    if (
      name.startsWith('AIBROWSE_') ||
      ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'].includes(name)
    )
      delete env[name];
  env.AIBROWSE_PROFILE_TOOL_REPOSITORY = resolve('.');
  let stdout = '',
    stderr = '';
  try {
    const code = await new Promise<number | null>((done, reject) => {
      const child = spawn(
        'pwsh.exe',
        [
          '-NoProfile',
          '-File',
          resolve('tools/legacy-followup/package-smoke.ps1'),
          '-Spec',
          join(output, 'package-spec.json'),
        ],
        { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > 65536) reject(new Error('包验收输出超限'));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > 65536) reject(new Error('包验收错误输出超限'));
      });
      child.once('error', reject);
      child.once('close', done);
    });
    writeFileSync(join(output, 'package.stdout.txt'), stdout, { flag: 'wx' });
    writeFileSync(join(output, 'package.stderr.txt'), stderr, { flag: 'wx' });
    if (code !== 0) throw new Error('原生包启动/关闭验收失败');
    const result: unknown = JSON.parse(readFileSync(join(output, 'package-native.json'), 'utf8'));
    if (!result || typeof result !== 'object' || !('passed' in result) || result.passed !== true)
      throw new Error('原生包验收没有成功终态');
    for (const source of binding.sources)
      if (digest(source.path) !== source.sha256) throw new Error('包验收工具来源变化');
    if (
      digest(provenancePath) !== binding.provenanceSha256 ||
      provenance.source.gitSha !== git('rev-parse', 'HEAD') ||
      git('status', '--porcelain=v1', '--untracked-files=all') !== '' ||
      JSON.stringify(collectMsiFiles(packageRoot)) !==
        JSON.stringify(provenance.payload.packageFiles)
    )
      throw new Error('包验收后绑定变化');
    save('package-result.json', {
      passed: true,
      rootExitCode: code,
      binding,
      native: result,
      externalJobZero: '由外层隔离器在runner退出后确认',
      originalProfileRestore: '由外层隔离器在Job归零后确认',
    });
  } finally {
    clearTimeout(timer);
  }
}
void main().catch(failure);
