import { app } from 'electron';
import { basename, resolve, join } from 'node:path';
import { cpSync, mkdirSync, lstatSync } from 'node:fs';
import { initializeRuntimeQualification } from './harness';
import { isBuildId } from './contract';

// This entry is selected by the dedicated compiler mode, never by a runtime
// product switch. All paths come from the builder-owned candidate directory.
const root = resolve(__dirname, '../..');
if (
  !__E2_RUNTIME_QUALIFICATION__ ||
  __RELEASE__ ||
  app.isPackaged ||
  !isBuildId(basename(root)) ||
  process.argv.length !== 3 ||
  process.argv[2] !== '--runtime-qualification-run'
)
  throw new Error('固定资格启动范围不符');
for (const path of [root, join(root, 'fixtures')])
  if (lstatSync(path).isSymbolicLink()) throw new Error('资格路径不得经过链接');
const runtime = join(root, 'runtime');
mkdirSync(runtime);
const profile = join(runtime, 'profile');
mkdirSync(profile);
for (const name of ['sources', 'research', 'watch', 'conversations'])
  cpSync(join(root, 'fixtures', name), join(profile, name), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
app.setName('AIbrowse E2 主装配资格');
app.setPath('userData', profile);
app.setPath('sessionData', join(profile, 'session'));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
initializeRuntimeQualification(root);
void import('../../../src/main/index');
