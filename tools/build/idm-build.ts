import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** Build the fixed COM handoff helper and protect its digest inside the application. */
export function idmBuild(root: string): Plugin {
  let manifest: string;
  return {
    name: 'idm-handoff-build',
    buildStart() {
      const helperPath = join(root, 'out/idm/idm-handoff.exe');
      execFileSync(
        'pwsh',
        [
          '-NoProfile',
          '-File',
          join(root, 'native/idm/build.ps1'),
          '-OutputPath',
          'out/idm/idm-handoff.exe',
        ],
        { cwd: root, windowsHide: true, stdio: 'pipe' },
      );
      const stat = statSync(helperPath);
      if (!stat.isFile() || stat.size < 1 || stat.size > 512 * 1024)
        throw new Error('IDM 接管程序构建产物无效');
      const bytes = readFileSync(helperPath);
      manifest = JSON.stringify({
        version: 1,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'idm-handoff-integrity.json', source: manifest });
    },
  };
}
