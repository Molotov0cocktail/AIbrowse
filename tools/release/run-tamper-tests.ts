import { spawn } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createConnection, createServer } from 'node:net';

import { extractFile, getRawHeader, statFile } from '@electron/asar';

import { PACKAGED_EXECUTABLE, verifyPackagedDirectory } from './package-policy.ts';
import {
  probeControlledProcessIdentity,
  type ControlledProcessIdentity,
} from './process-identity-probe.ts';
import { verifyProfileIsolationJournal } from './profile-isolation-policy.ts';

interface LaunchObservation {
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stayedAliveForProbe: boolean;
  cliInspectListening: boolean;
  nodeOptionsInspectListening: boolean;
  remoteDebuggingListening: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  processIdentity?: ControlledProcessIdentity;
}

interface AppDataProbeObservation {
  appData: string;
  userData: string;
  sessionData: string;
  exited: true;
  exitCode: 0;
}

const packageRootArgument = process.argv[2];
const evidenceRootArgument = process.argv[3];
const expectedAppDataArgument = process.argv[4];
const profileJournalArgument = process.argv[5];
if (
  packageRootArgument === undefined ||
  evidenceRootArgument === undefined ||
  expectedAppDataArgument === undefined ||
  profileJournalArgument === undefined
) {
  process.stderr.write(
    '用法：run-tamper-tests.ts <win-unpacked目录> <证据目录> <合成AppData目录> <隔离journal目录>\n',
  );
  process.exit(2);
}

const packageRoot = resolve(packageRootArgument);
const evidenceRoot = resolve(evidenceRootArgument);
const expectedAppDataRoot = resolve(expectedAppDataArgument);
const profileJournalRoot = resolve(profileJournalArgument);
const runRoot = join(evidenceRoot, `run-${Date.now()}`);
mkdirSync(runRoot, { recursive: true });

const boundedByteCounter = () => {
  let bytes = 0;
  return {
    add(chunk: Buffer): void {
      bytes = Math.min(bytes + chunk.length, 65_536);
    },
    value(): number {
      return bytes;
    },
  };
};

const terminateOwnedProcessTree = async (pid: number): Promise<void> => {
  await new Promise<void>((resolveTask) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => resolveTask());
    killer.once('exit', () => resolveTask());
  });
};

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const reserveLoopbackPort = async (excludedPort?: number): Promise<number> => {
  while (true) {
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      const server = createServer();
      server.once('error', rejectPort);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close(() => rejectPort(new Error('无法分配调试端口')));
          return;
        }
        server.close((error) => {
          if (error === undefined) resolvePort(address.port);
          else rejectPort(error);
        });
      });
    });
    if (port !== excludedPort) return port;
  }
};

const isLoopbackPortListening = async (port: number): Promise<boolean> =>
  new Promise((resolveProbe) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(100);
    socket.once('connect', () => {
      socket.destroy();
      resolveProbe(true);
    });
    const rejectProbe = (): void => {
      socket.destroy();
      resolveProbe(false);
    };
    socket.once('error', rejectProbe);
    socket.once('timeout', rejectProbe);
  });

const launchAndObserve = async (
  root: string,
  nodeOptionsCanary: string,
  forbiddenUserDataOverride: string,
  probeMs: number,
  processIdentityLabel?: 'TamperOriginal',
): Promise<LaunchObservation> => {
  const executable = join(root, PACKAGED_EXECUTABLE);
  const stdout = boundedByteCounter();
  const stderr = boundedByteCounter();
  const cliInspectPort = await reserveLoopbackPort();
  const nodeOptionsInspectPort = await reserveLoopbackPort(cliInspectPort);
  let remoteDebuggingPort = await reserveLoopbackPort(nodeOptionsInspectPort);
  while (remoteDebuggingPort === cliInspectPort) {
    remoteDebuggingPort = await reserveLoopbackPort(nodeOptionsInspectPort);
  }
  if (existsSync(forbiddenUserDataOverride)) {
    throw new Error('受禁 userData 覆盖路径在启动前已存在');
  }
  const child = spawn(
    executable,
    [
      `--inspect=${String(cliInspectPort)}`,
      `--remote-debugging-port=${String(remoteDebuggingPort)}`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        AIBROWSE_SMOKE: '1',
        AIBROWSE_USER_DATA_DIR: forbiddenUserDataOverride,
        ELECTRON_RENDERER_URL: 'http://127.0.0.1:9/',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: `--inspect=${String(nodeOptionsInspectPort)} --require=${nodeOptionsCanary}`,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  let exited = false;
  const exitPromise = new Promise<void>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('exit', (code, receivedSignal) => {
      exited = true;
      exitCode = code;
      signal = receivedSignal;
      resolveExit();
    });
  });
  if (child.pid === undefined) throw new Error('未取得release EXE主进程PID');
  let processIdentity: ControlledProcessIdentity | undefined;
  try {
    processIdentity =
      processIdentityLabel === undefined
        ? undefined
        : await probeControlledProcessIdentity(profileJournalRoot, child.pid, processIdentityLabel);
  } catch (error: unknown) {
    if (!exited) {
      await terminateOwnedProcessTree(child.pid);
      await Promise.race([exitPromise, delay(5_000)]);
    }
    throw error;
  }
  let cliInspectListening = false;
  let nodeOptionsInspectListening = false;
  let remoteDebuggingListening = false;
  const deadline = Date.now() + probeMs;
  while (!exited && Date.now() < deadline) {
    const [cliListening, nodeOptionsListening, remoteListening] = await Promise.all([
      isLoopbackPortListening(cliInspectPort),
      isLoopbackPortListening(nodeOptionsInspectPort),
      isLoopbackPortListening(remoteDebuggingPort),
    ]);
    cliInspectListening ||= cliListening;
    nodeOptionsInspectListening ||= nodeOptionsListening;
    remoteDebuggingListening ||= remoteListening;
    await Promise.race([exitPromise, delay(100)]);
  }
  const stayedAliveForProbe = !exited;
  if (!exited && child.pid !== undefined) {
    await terminateOwnedProcessTree(child.pid);
    await Promise.race([
      exitPromise,
      new Promise<void>((resolveTimer) => setTimeout(resolveTimer, 5_000)),
    ]);
  }
  if (!exited) throw new Error('无法确认 release EXE 及其子进程已退出');
  if (existsSync(forbiddenUserDataOverride)) {
    throw new Error('release EXE 触碰了受禁 userData 覆盖路径');
  }
  return {
    exited,
    exitCode,
    signal,
    stayedAliveForProbe,
    cliInspectListening,
    nodeOptionsInspectListening,
    remoteDebuggingListening,
    stdoutBytes: stdout.value(),
    stderrBytes: stderr.value(),
    ...(processIdentity === undefined ? {} : { processIdentity }),
  };
};

const probeActualAppData = async (): Promise<AppDataProbeObservation> => {
  const reportPath = join(runRoot, 'app-data-probe.json');
  const electronPath = resolve('node_modules', 'electron', 'dist', 'electron.exe');
  const probePath = resolve('tools', 'release', 'probe-app-data.mjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const probe = spawn(electronPath, [probePath, reportPath], {
    env,
    windowsHide: true,
    stdio: 'ignore',
  });
  const exitPromise = new Promise<number | null>((resolveExit, rejectExit) => {
    probe.once('error', rejectExit);
    probe.once('exit', resolveExit);
  });
  const outcome = await Promise.race([exitPromise, delay(10_000).then(() => 'timeout' as const)]);
  if (outcome === 'timeout') {
    if (probe.pid !== undefined) await terminateOwnedProcessTree(probe.pid);
    const terminated = await Promise.race([
      exitPromise.then(() => true),
      delay(5_000).then(() => false),
    ]);
    if (!terminated) throw new Error('无法确认超时AppData探针及其子进程已退出');
    throw new Error('AppData探针超过10秒有界期限');
  }
  if (outcome !== 0) throw new Error(`AppData探针退出码 ${String(outcome)}`);
  const parsed: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('appData' in parsed) ||
    typeof parsed.appData !== 'string' ||
    !('userData' in parsed) ||
    typeof parsed.userData !== 'string' ||
    !('sessionData' in parsed) ||
    typeof parsed.sessionData !== 'string'
  ) {
    throw new Error('AppData 探针结果形状无效');
  }
  return {
    appData: resolve(parsed.appData),
    userData: resolve(parsed.userData),
    sessionData: resolve(parsed.sessionData),
    exited: true,
    exitCode: 0,
  };
};

const tamperMainWhitespace = (asarPath: string): void => {
  const archivePath = 'out/release/main/index.js';
  const archiveLookupPath = archivePath.replaceAll('/', '\\');
  const main = extractFile(asarPath, archiveLookupPath);
  const marker = main.indexOf(Buffer.from('\n  '));
  if (marker < 0) throw new Error('main bundle 中没有可等价替换的缩进空白');
  const info = statFile(asarPath, archiveLookupPath, false);
  if ('files' in info || 'link' in info || info.unpacked) {
    throw new Error('main bundle 不是 ASAR 内普通文件');
  }
  const fileOffset = Number.parseInt(info.offset, 10);
  if (!Number.isSafeInteger(fileOffset) || fileOffset < 0)
    throw new Error('main bundle offset 无效');
  const absoluteOffset = 8 + getRawHeader(asarPath).headerSize + fileOffset + marker + 1;
  const descriptor = openSync(asarPath, 'r+');
  try {
    writeSync(descriptor, Buffer.from('\t'), 0, 1, absoluteOffset);
  } finally {
    closeSync(descriptor);
  }
};

const main = async (): Promise<void> => {
  const verified = await verifyPackagedDirectory(packageRoot);
  const appDataProbe = await probeActualAppData();
  const actualAppData = appDataProbe.appData;
  if (actualAppData.toLowerCase() !== expectedAppDataRoot.toLowerCase()) {
    throw new Error(`当前 Windows KnownFolder 不属于声明的隔离账户：${actualAppData}`);
  }
  const profileIsolation = verifyProfileIsolationJournal(expectedAppDataRoot, profileJournalRoot);
  const canaryPath = join(runRoot, 'node-options-canary.cjs');
  const canaryHit = join(runRoot, 'node-options-canary-hit.txt');
  writeFileSync(
    canaryPath,
    `require('node:fs').writeFileSync(${JSON.stringify(canaryHit)}, 'hit')\n`,
    'utf8',
  );

  const original = await launchAndObserve(
    packageRoot,
    canaryPath,
    join(runRoot, 'forbidden-user-data-override'),
    3_000,
    'TamperOriginal',
  );
  if (!original.stayedAliveForProbe) throw new Error('原始 release EXE 未保持运行至正控观察点');
  if (existsSync(canaryHit)) throw new Error('NODE_OPTIONS canary 被执行');
  if (
    original.cliInspectListening ||
    original.nodeOptionsInspectListening ||
    original.remoteDebuggingListening
  ) {
    throw new Error('原始 release EXE 打开了受禁调试监听端口');
  }

  const contentTamperRoot = join(runRoot, 'content-tamper');
  cpSync(packageRoot, contentTamperRoot, { recursive: true, errorOnExist: true });
  tamperMainWhitespace(join(contentTamperRoot, 'resources', 'app.asar'));
  const contentTamper = await launchAndObserve(
    contentTamperRoot,
    canaryPath,
    join(runRoot, 'forbidden-user-data-override'),
    6_000,
  );
  if (contentTamper.stayedAliveForProbe || !contentTamper.exited) {
    throw new Error('修改 ASAR main 内容后 EXE 未拒绝运行');
  }

  const looseAppRoot = join(runRoot, 'loose-app-tamper');
  cpSync(packageRoot, looseAppRoot, { recursive: true, errorOnExist: true });
  const resources = join(looseAppRoot, 'resources');
  const removedAsar = join(resources, 'app.asar.removed');
  const appAsar = join(resources, 'app.asar');
  renameSync(appAsar, removedAsar);
  const looseApp = join(resources, 'app');
  mkdirSync(looseApp, { recursive: true });
  writeFileSync(join(looseApp, 'package.json'), '{"main":"index.js"}\n', 'utf8');
  const looseCanary = join(runRoot, 'loose-app-canary.txt');
  writeFileSync(
    join(looseApp, 'index.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(looseCanary)}, 'hit')\n`,
    'utf8',
  );
  const looseAppTamper = await launchAndObserve(
    looseAppRoot,
    canaryPath,
    join(runRoot, 'forbidden-user-data-override'),
    6_000,
  );
  if (looseAppTamper.stayedAliveForProbe || !looseAppTamper.exited || existsSync(looseCanary)) {
    throw new Error('移走有效 ASAR 并加入裸 app 后 EXE 未安全拒绝');
  }

  const report = {
    ok: true,
    package: {
      asarSha256: verified.asarSha256,
      asarHeaderSha256: verified.asarHeaderSha256,
      executableSha256: verified.executableSha256,
      integrityResource: verified.integrityResource,
    },
    original,
    contentTamper,
    looseAppTamper,
    canaries: {
      nodeOptionsExecuted: existsSync(canaryHit),
      looseAppExecuted: existsSync(looseCanary),
    },
    appData: actualAppData,
    appDataProbe,
    profileIsolation,
    evidenceDirectory: runRoot,
  };
  writeFileSync(join(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '未知错误';
  const failure = { ok: false, error: message, evidenceDirectory: runRoot };
  writeFileSync(join(runRoot, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
});
