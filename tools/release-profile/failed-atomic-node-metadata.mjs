import process from 'node:process';
import { lstatSync, realpathSync } from 'node:fs';

const [declaredRoot, resolvedRoot] = process.argv.slice(2);
if (declaredRoot === undefined || resolvedRoot === undefined) {
  throw new Error('缺少固定失败profile路径');
}

const observe = (path) => {
  const stat = lstatSync(path, { bigint: true });
  return {
    requested: path,
    realpath: realpathSync(path),
    realpathNative: realpathSync.native(path),
    isFile: stat.isFile(),
    isDirectory: stat.isDirectory(),
    isSymbolicLink: stat.isSymbolicLink(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
  };
};

const declaredTemporary = `${declaredRoot}\\credentials.json.tmp`;
const resolvedTemporary = `${resolvedRoot}\\credentials.json.tmp`;
process.stdout.write(
  JSON.stringify({
    version: 1,
    originalContentsRead: false,
    profileMutationPerformed: false,
    root: { alias: observe(declaredRoot), resolved: observe(resolvedRoot) },
    temporary: { alias: observe(declaredTemporary), resolved: observe(resolvedTemporary) },
  }),
);
