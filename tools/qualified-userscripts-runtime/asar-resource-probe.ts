import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { QUALIFIED_SCRIPT_CATALOG } from '../../src/main/userscripts-qualified/catalog';
import { readBuiltInQualifiedPackage } from '../../src/main/userscripts-qualified/package';

const root = process.env.AIBROWSE_QUALIFIED_PROBE_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('资格探针路径无效');
app.setPath('userData', path.join(root, 'profile'));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');

void app.whenReady().then(() => {
  const appPath = app.getAppPath();
  const packages = {
    'ac-baidu': 'ac-baidu.json',
    'github-zh': 'github-zh.json',
  } as const;
  const scripts = Object.values(QUALIFIED_SCRIPT_CATALOG).map((entry) => {
    const file = path.join(appPath, 'resources', 'qualified-userscripts', packages[entry.id]);
    const texts = readBuiltInQualifiedPackage(file, entry);
    return {
      id: entry.id,
      assets: texts.size,
      packageSha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex').toUpperCase(),
    };
  });
  fs.writeFileSync(
    path.join(root, 'result.json'),
    JSON.stringify({ completed: true, passed: true, appPath, scripts }, null, 2),
  );
  app.exit(0);
});
