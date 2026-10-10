import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseGuardianCompiler } from '../release/build-provenance';

describe.skipIf(process.platform !== 'win32')('deterministic Framework guardian build', () => {
  it('跨新输出根生成同字节，并拒绝真实语法失败且不发布成功manifest', () => {
    const scope = `log/stage7-e6/guardian-build-test-${randomUUID().replaceAll('-', '')}`;
    const root = resolve(scope);
    mkdirSync(root, { recursive: true });
    const run = (script: string, output: string) => {
      const result = spawnSync('pwsh', ['-NoProfile', '-File', script, '-OutputRoot', output], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 8192,
      });
      return {
        status: result.status,
        error: result.error?.name ?? null,
        signal: result.signal,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    };
    const first = run(resolve('tools/build/guardian.ps1'), `${scope}/one`);
    const second = run(resolve('tools/build/guardian.ps1'), `${scope}/two`);
    writeFileSync(join(root, 'compilation.json'), JSON.stringify({ first, second }, null, 2), {
      flag: 'wx',
    });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    for (const name of ['guardian.exe', 'manifest.json', 'compiler.json']) {
      expect(
        readFileSync(join(root, 'one', name)).equals(readFileSync(join(root, 'two', name))),
      ).toBe(true);
    }
    const compiler = parseGuardianCompiler(
      JSON.parse(readFileSync(join(root, 'one/compiler.json'), 'utf8')),
    );
    expect(compiler.options).toContain('deterministic');
    const rejectedArgs = spawnSync(join(root, 'one/guardian.exe'), [], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 4096,
    });
    writeFileSync(
      join(root, 'invalid-arguments.json'),
      JSON.stringify({
        status: rejectedArgs.status,
        error: rejectedArgs.error?.name ?? null,
        stdout: rejectedArgs.stdout,
        stderr: rejectedArgs.stderr,
      }),
      { flag: 'wx' },
    );
    expect(rejectedArgs.status).toBe(2);
    const brokenRoot = join(root, 'broken');
    mkdirSync(join(brokenRoot, 'tools/build'), { recursive: true });
    mkdirSync(join(brokenRoot, 'native/lifecycle-guardian'), { recursive: true });
    copyFileSync(resolve('tools/build/guardian.ps1'), join(brokenRoot, 'tools/build/guardian.ps1'));
    writeFileSync(
      join(brokenRoot, 'native/lifecycle-guardian/Guardian.cs'),
      'class Invalid { invalid syntax }',
      { flag: 'wx' },
    );
    const broken = run(join(brokenRoot, 'tools/build/guardian.ps1'), 'out/guardian');
    writeFileSync(join(root, 'syntax-error.json'), JSON.stringify(broken, null, 2), { flag: 'wx' });
    expect(broken.status).not.toBe(0);
    expect(broken.error).toBeNull();
    expect(existsSync(join(brokenRoot, 'out/guardian/manifest.json'))).toBe(false);
    expect(existsSync(join(brokenRoot, 'out/guardian/compiler.json'))).toBe(false);
    for (const name of ['guardian.exe', 'manifest.json', 'compiler.json']) {
      copyFileSync(join(root, 'one', name), join(brokenRoot, 'out/guardian', name));
    }
    const brokenExisting = run(join(brokenRoot, 'tools/build/guardian.ps1'), 'out/guardian');
    writeFileSync(
      join(root, 'syntax-error-existing.json'),
      JSON.stringify(brokenExisting, null, 2),
      { flag: 'wx' },
    );
    expect(brokenExisting.status).not.toBe(0);
    for (const name of ['guardian.exe', 'manifest.json', 'compiler.json']) {
      expect(
        readFileSync(join(brokenRoot, 'out/guardian', name)).equals(
          readFileSync(join(root, 'one', name)),
        ),
      ).toBe(true);
    }
  }, 65000);
});
