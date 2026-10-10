import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const packageRoot = process.argv[2];
const evidenceRoot = process.argv[3];
const expectedAppDataRoot = process.argv[4];
const journalRoot = process.argv[5];
if (
  packageRoot === undefined ||
  evidenceRoot === undefined ||
  expectedAppDataRoot === undefined ||
  journalRoot === undefined
) {
  process.stderr.write(
    '用法：run-release-checks.ts <win-unpacked目录> <证据目录> <AppData目录> <journal目录>\n',
  );
  process.exit(2);
}

const resolvedEvidence = resolve(evidenceRoot);

const runFixedCheck = async (
  name: 'product' | 'tamper',
  script: string,
): Promise<{ name: string; exitCode: number }> => {
  const output = join(resolvedEvidence, name);
  mkdirSync(output, { recursive: false });
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolveRun) => {
      const child = spawn(
        process.execPath,
        [
          '--experimental-strip-types',
          resolve('tools', 'release', script),
          resolve(packageRoot),
          output,
          resolve(expectedAppDataRoot),
          resolve(journalRoot),
        ],
        { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < 1024 * 1024)
          stdout += chunk.toString('utf8').slice(0, 1024 * 1024 - stdout.length);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 1024 * 1024)
          stderr += chunk.toString('utf8').slice(0, 1024 * 1024 - stderr.length);
      });
      child.once('error', (error) => resolveRun({ code: null, stdout, stderr: error.message }));
      child.once('exit', (code) => resolveRun({ code, stdout, stderr }));
    },
  );
  writeFileSync(join(output, 'runner.stdout.txt'), result.stdout, 'utf8');
  writeFileSync(join(output, 'runner.stderr.txt'), result.stderr, 'utf8');
  if (result.code !== 0) throw new Error(`固定${name}资格失败`);
  return { name, exitCode: result.code };
};

const main = async (): Promise<void> => {
  // Product must run first because its cancellation oracle requires no existing
  // provider-config. A failure stops the sequence and preserves the profile.
  const product = await runFixedCheck('product', 'run-packaged-product-checks.ts');
  const tamper = await runFixedCheck('tamper', 'run-tamper-tests.ts');
  const report = { ok: true, order: ['product', 'tamper'], results: [product, tamper] };
  writeFileSync(
    join(resolvedEvidence, 'combined-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '未知错误';
  const failure = { ok: false, error: message, order: ['product', 'tamper'] };
  writeFileSync(
    join(resolvedEvidence, 'combined-failure.json'),
    `${JSON.stringify(failure, null, 2)}\n`,
    'utf8',
  );
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
});
