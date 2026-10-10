import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkMsiIdentity, type MsiIdentity } from './msi-authoring.ts';
const scope = resolve(process.argv[2] ?? '');
const build = JSON.parse(readFileSync(join(scope, 'build.json'), 'utf8')) as {
  fixture: boolean;
  upgrade: string;
  identity: MsiIdentity;
  artifacts: { path: string; sha256: string }[];
};
const guard = join(scope, 'msi-guard.exe');
const hash = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
if (
  !build.fixture ||
  build.identity.scope !== 'fixture' ||
  build.upgrade !== build.identity.upgrade ||
  build.artifacts.find((f) => f.path === 'msi-guard.exe')?.sha256 !== hash(readFileSync(guard))
)
  throw new Error('只允许已绑定的编译夹具guard');
checkMsiIdentity(build.identity);
const probeRoot = join(scope, `read-only-guard-probe-${randomUUID().replaceAll('-', '')}`);
mkdirSync(probeRoot);
const cases = [
  { name: 'user-writable 中文 空格', action: 'install', expected: 2 },
  { name: 'wrong-root-remove', action: 'remove', expected: 2 },
  { name: 'relative-root', action: 'install', expected: 2 },
  { name: 'drive-relative-root', action: 'install', expected: 2 },
  { name: 'dot-member', action: 'install', expected: 2 },
];
const results = [];
for (const test of cases) {
  const root = join(probeRoot, test.name);
  mkdirSync(root);
  const sentinel = join(root, 'unknown.txt');
  writeFileSync(sentinel, '未知文件必须原样保留\n', { flag: 'wx' });
  const inputRoot =
    test.name === 'relative-root'
      ? test.name
      : test.name === 'drive-relative-root'
        ? 'D:relative-root'
        : test.name === 'dot-member'
          ? `${root}\\..\\dot-member`
          : root;
  const before = hash(readFileSync(sentinel));
  const execution = spawnSync(
    guard,
    [test.action, inputRoot, '{00000000-0000-0000-0000-000000000000}', 'unused', 'unused'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true },
  );
  const after = hash(readFileSync(sentinel));
  const result = {
    ...test,
    exit: execution.status,
    before,
    after,
  };
  results.push(result);
  writeFileSync(join(probeRoot, `${test.name}.json`), JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
  });
  if (execution.status !== test.expected || before !== after)
    throw new Error(`只读guard反例失败：${test.name}`);
}

const helperSource = join(probeRoot, 'owned-file-probe.cs');
const helper = join(probeRoot, 'owned-file-probe.exe');
writeFileSync(
  helperSource,
  `using System;
using System.IO;
using System.Reflection;
using System.Threading;
internal static class GuardOwnedFileProbe {
  [STAThread] private static int Main(string[] args) {
    try {
      if (args.Length == 3 && args[0] == "hold") {
        using (var stream = new FileStream(args[1], FileMode.Open, FileAccess.Read, FileShare.Read)) {
          File.WriteAllText(args[2] + ".ready", "ready");
          for (int index = 0; index < 400 && !File.Exists(args[2]); index++) Thread.Sleep(25);
          if (!File.Exists(args[2])) return 3;
        }
        return 0;
      }
      if (args.Length == 3 && args[0] == "probe") {
        var assembly = Assembly.LoadFrom(args[1]);
        var type = assembly.GetType("MsiAdmission", true);
        var method = type.GetMethod("RequireWritableOwnedFile", BindingFlags.NonPublic | BindingFlags.Static);
        if (method == null) return 4;
        method.Invoke(null, new object[] { args[2] });
        return 0;
      }
      return 4;
    } catch { return 2; }
  }
}`,
  { flag: 'wx' },
);
const compiler = join(
  process.env.WINDIR ?? 'C:\\Windows',
  'Microsoft.NET/Framework64/v4.0.30319/csc.exe',
);
const compiled = spawnSync(
  compiler,
  [
    '/nologo',
    '/target:winexe',
    '/platform:x64',
    '/optimize+',
    '/warnaserror+',
    `/out:${helper}`,
    helperSource,
  ],
  { encoding: 'utf8', timeout: 10_000, windowsHide: true },
);
if (compiled.status !== 0) throw new Error('旧文件锁探针编译失败');
const owned = join(probeRoot, 'registered-old-only.bin');
const release = join(probeRoot, 'release.lock');
writeFileSync(owned, '已注册旧版独有文件\n', { flag: 'wx' });
const ownedBefore = { sha256: hash(readFileSync(owned)), mode: statSync(owned).mode };
const holder = spawn(helper, ['hold', owned, release], { windowsHide: true, stdio: 'ignore' });
const holderExitPromise = new Promise<number | null>((resolveExit) =>
  holder.once('exit', (code) => resolveExit(code)),
);
await new Promise<void>((resolveReady, rejectReady) => {
  const deadline = Date.now() + 2_000;
  const poll = (): void => {
    if (existsSync(`${release}.ready`)) resolveReady();
    else if (Date.now() >= deadline) rejectReady(new Error('旧文件锁未就绪'));
    else setTimeout(poll, 10);
  };
  poll();
});
const locked = spawnSync(helper, ['probe', guard, owned], {
  timeout: 2_000,
  windowsHide: true,
});
writeFileSync(release, 'release', { flag: 'wx' });
const holderExit = await holderExitPromise;
const unlocked = spawnSync(helper, ['probe', guard, owned], {
  timeout: 2_000,
  windowsHide: true,
});
const ownedAfter = { sha256: hash(readFileSync(owned)), mode: statSync(owned).mode };
if (
  locked.status !== 2 ||
  holderExit !== 0 ||
  unlocked.status !== 0 ||
  JSON.stringify(ownedAfter) !== JSON.stringify(ownedBefore)
)
  throw new Error('已注册旧文件锁准入反例失败');
results.push({
  name: 'registered-old-only-read-lock',
  lockedExit: locked.status,
  unlockedExit: unlocked.status,
  unchanged: true,
});
writeFileSync(
  join(probeRoot, 'results.json'),
  JSON.stringify({ passed: results.length, results, installed: false }, null, 2) + '\n',
  { flag: 'wx' },
);
console.log(`${results.length}项真实guard探针通过，未执行MSI安装：${probeRoot}`);
