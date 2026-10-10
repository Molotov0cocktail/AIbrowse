import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it('实际Node strip-types入口可以导入身份错误类，构造诊断不启动探针', () => {
  const url = pathToFileURL(resolve('tools/release/process-identity-probe.ts')).href;
  const code = `import { ControlledProcessProbeError } from ${JSON.stringify(url)};
    const diagnostic={label:'ProductOriginal',pid:1,exitCode:2,stderr:'',capturedBytes:0,truncated:false};
    const error=new ControlledProcessProbeError(diagnostic);
    if(error.diagnostic!==diagnostic||!(error instanceof Error))process.exit(2);
    process.stdout.write('PASS');`;
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', code],
    { encoding: 'utf8', timeout: 10000, windowsHide: true },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toBe('PASS');
});

it('实际ProductTransfer入口无参数只报受控错误，不在模块加载阶段崩溃', () => {
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', resolve('tools/data-qualification/product-transfer/run.ts')],
    { encoding: 'utf8', timeout: 10000, windowsHide: true },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Error：资格准备或执行失败，原件保留');
  expect(result.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
});
