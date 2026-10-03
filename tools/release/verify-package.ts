import { verifyPackagedDirectory } from './package-policy.ts';

const packageRoot = process.argv[2];
if (packageRoot === undefined) {
  process.stderr.write('用法：verify-package.ts <win-unpacked目录>\n');
  process.exitCode = 2;
} else {
  try {
    const result = await verifyPackagedDirectory(packageRoot);
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
    process.exitCode = 1;
  }
}
