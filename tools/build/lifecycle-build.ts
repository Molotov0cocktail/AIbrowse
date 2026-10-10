import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

/** The helper is a fixed product dependency; its digest is protected inside ASAR. */
export function lifecycleBuild(root: string): Plugin {
  let manifest: Buffer;
  return {
    name: 'lifecycle-guardian-build',
    buildStart() {
      execFileSync('pwsh', ['-NoProfile', '-File', join(root, 'tools/build/guardian.ps1')], {
        cwd: root,
        windowsHide: true,
        stdio: 'pipe',
      });
      manifest = readFileSync(join(root, 'out/lifecycle-guardian/manifest.json'));
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'lifecycle-guardian-integrity.json',
        source: manifest,
      });
    },
  };
}
