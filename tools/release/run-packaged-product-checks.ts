import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join, relative, resolve } from 'node:path';

import { PACKAGED_EXECUTABLE, verifyPackagedDirectory } from './package-policy.ts';
import { probeControlledProcessIdentity } from './process-identity-probe.ts';
import {
  assertConversationAdvanced,
  assertDatabaseIdentityUnchanged,
  assertStableFileUnchanged,
  inspectReadOnlyDatabase,
  snapshotConversationFiles,
  snapshotStableFile,
  type DatabaseEvidence,
} from './product-restart-evidence.ts';
import { verifyProfileIsolationJournal } from './profile-isolation-policy.ts';

interface UiActionResult {
  ok: true;
  action: string;
  [key: string]: unknown;
}

interface ProviderObservation {
  requests: number;
  authorizedRequests: number;
  validRequests: number;
  forbiddenRedirectRequests: number;
  requestPaths: string[];
}

interface DataFileIdentity {
  relativePath: string;
  fileId128: string;
  volumeSerial64: string;
}

interface DataFileIdentityReport {
  checkpoint: 'BeforeRestart' | 'AfterRestart';
  files: DataFileIdentity[];
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
    '用法：run-packaged-product-checks.ts <win-unpacked目录> <证据目录> <合成AppData目录> <隔离journal目录>\n',
  );
  process.exit(2);
}

const packageRoot = resolve(packageRootArgument);
const evidenceRoot = resolve(evidenceRootArgument);
const expectedAppDataRoot = resolve(expectedAppDataArgument);
const profileJournalRoot = resolve(profileJournalArgument);
const runRoot = join(evidenceRoot, `run-${Date.now()}`);
mkdirSync(runRoot, { recursive: true });

const delay = async (milliseconds: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const waitUntil = async (
  predicate: () => boolean,
  failure: string,
  timeoutMs = 15_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  throw new Error(failure);
};

const closeServer = async (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) resolveClose();
      else rejectClose(error);
    });
  });

const listenLoopback = async (server: Server): Promise<number> =>
  new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        rejectListen(new Error('受控 Provider 未取得 TCP 端口'));
      } else {
        resolveListen(address.port);
      }
    });
  });

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

const runUiAction = async (
  processId: number,
  action: string,
  extraArguments: string[] = [],
  extraEnvironment: NodeJS.ProcessEnv = {},
): Promise<UiActionResult> => {
  const outputPath = join(runRoot, `ui-${action}-${Date.now()}.json`);
  const scriptPath = resolve('tools', 'release', 'product-ui-driver.ps1');
  const args = [
    '-NoProfile',
    '-File',
    scriptPath,
    '-Action',
    action,
    '-ProcessId',
    String(processId),
    '-Output',
    outputPath,
    ...extraArguments,
  ];
  const result = await new Promise<{ code: number | null; stderr: string }>((resolveAction) => {
    const child = spawn('pwsh.exe', args, {
      cwd: resolve('.'),
      env: { ...process.env, ...extraEnvironment },
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_384) stderr += chunk.toString('utf8').slice(0, 16_384 - stderr.length);
    });
    child.once('error', (error) => resolveAction({ code: null, stderr: error.message }));
    child.once('exit', (code) => resolveAction({ code, stderr }));
  });
  if (result.code !== 0) {
    writeFileSync(join(runRoot, `ui-${action}-failure.txt`), result.stderr, 'utf8');
    throw new Error(`产品 UIA 动作失败：${action}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(outputPath, 'utf8'));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('ok' in parsed) ||
    parsed.ok !== true ||
    !('action' in parsed) ||
    parsed.action !== action
  ) {
    throw new Error(`产品 UIA 动作结果无效：${action}`);
  }
  return parsed as UiActionResult;
};

const probeDataFileIdentities = async (
  checkpoint: 'BeforeRestart' | 'AfterRestart',
): Promise<DataFileIdentityReport> => {
  const script = resolve('tools', 'release-profile', 'disposable-profile.ps1');
  const execution = await new Promise<{ code: number | null; probeProcessId: number }>(
    (resolveExit, rejectExit) => {
      const child = spawn(
        'pwsh.exe',
        [
          '-NoProfile',
          '-File',
          script,
          '-Action',
          'ProbeDataFiles',
          '-Journal',
          profileJournalRoot,
          '-Checkpoint',
          checkpoint,
        ],
        { cwd: resolve('.'), windowsHide: true, stdio: 'ignore' },
      );
      if (child.pid === undefined) {
        rejectExit(new Error('未取得数据库FileID探针进程PID'));
        return;
      }
      const probeProcessId = child.pid;
      child.once('error', rejectExit);
      child.once('exit', (code) => resolveExit({ code, probeProcessId }));
    },
  );
  if (execution.code !== 0) throw new Error(`冷重启数据库FileID探针失败：${checkpoint}`);
  const path = join(profileJournalRoot, 'runner-output', `data-files-${checkpoint}.json`);
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('冷重启数据库FileID报告形状无效');
  }
  const report = parsed as Record<string, unknown>;
  if (
    report.version !== 1 ||
    report.checkpoint !== checkpoint ||
    report.probeProcessId !== execution.probeProcessId ||
    !Array.isArray(report.files)
  ) {
    throw new Error('冷重启数据库FileID报告头无效');
  }
  const expected = new Set(['sources/sources.db', 'research/research.db', 'watch/watch.db']);
  const files: DataFileIdentity[] = report.files.map((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error('冷重启数据库FileID条目无效');
    }
    const entry = raw as Record<string, unknown>;
    const alias = entry.alias;
    const resolved = entry.resolved;
    if (
      typeof entry.relativePath !== 'string' ||
      !expected.delete(entry.relativePath) ||
      typeof alias !== 'object' ||
      alias === null ||
      Array.isArray(alias) ||
      typeof resolved !== 'object' ||
      resolved === null ||
      Array.isArray(resolved)
    ) {
      throw new Error('冷重启数据库FileID条目路径或视图无效');
    }
    const aliasIdentity = alias as Record<string, unknown>;
    const resolvedIdentity = resolved as Record<string, unknown>;
    if (
      typeof aliasIdentity.FileId128 !== 'string' ||
      !/^[0-9a-f]{32}$/iu.test(aliasIdentity.FileId128) ||
      typeof aliasIdentity.VolumeSerial64 !== 'string' ||
      !/^[0-9a-f]{16}$/iu.test(aliasIdentity.VolumeSerial64) ||
      aliasIdentity.FileId128 !== resolvedIdentity.FileId128 ||
      aliasIdentity.VolumeSerial64 !== resolvedIdentity.VolumeSerial64
    ) {
      throw new Error('冷重启数据库声明/实体FileID不一致');
    }
    return {
      relativePath: entry.relativePath,
      fileId128: aliasIdentity.FileId128,
      volumeSerial64: aliasIdentity.VolumeSerial64,
    };
  });
  if (expected.size !== 0 || files.length !== 3) throw new Error('冷重启数据库FileID集合不完整');
  return { checkpoint, files };
};

const assertDataFileIdentitiesUnchanged = (
  before: DataFileIdentityReport,
  after: DataFileIdentityReport,
): void => {
  const afterByPath = new Map(after.files.map((file) => [file.relativePath, file]));
  for (const file of before.files) {
    const current = afterByPath.get(file.relativePath);
    if (
      current === undefined ||
      current.fileId128 !== file.fileId128 ||
      current.volumeSerial64 !== file.volumeSerial64
    ) {
      throw new Error(`冷重启未复用同一数据库FileID：${file.relativePath}`);
    }
  }
};

const readJsonObject = (path: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('产品持久化 JSON 形状无效');
  }
  return value as Record<string, unknown>;
};

const inspectProductDatabases = (profileRoot: string): Record<string, DatabaseEvidence> => ({
  sources: inspectReadOnlyDatabase(join(profileRoot, 'sources', 'sources.db'), [
    'sources',
    'source_groups',
    'change_journal',
  ]),
  research: inspectReadOnlyDatabase(join(profileRoot, 'research', 'research.db'), [
    'research_tasks',
    'research_results',
  ]),
  watch: inspectReadOnlyDatabase(join(profileRoot, 'watch', 'watch.db'), [
    'watch_rules',
    'watch_runs',
    'watch_events',
  ]),
});

const assertProductDatabasesUnchanged = (
  before: Record<string, DatabaseEvidence>,
  after: Record<string, DatabaseEvidence>,
): void => {
  for (const name of ['sources', 'research', 'watch']) {
    const first = before[name];
    const second = after[name];
    if (first === undefined || second === undefined) throw new Error('冷重启数据库证据集合缺失');
    assertDatabaseIdentityUnchanged(first, second, after[name]!.file.path);
  }
};

const verifyProviderBinding = (profileRoot: string, baseUrl: string): string => {
  const config = readJsonObject(join(profileRoot, 'provider-config.json'));
  const credentials = readJsonObject(join(profileRoot, 'credentials.json'));
  if (config.version !== 2 || !Array.isArray(config.providers) || config.providers.length !== 1) {
    throw new Error('确认后 Provider 配置没有形成唯一 v2 条目');
  }
  const provider = config.providers[0];
  if (typeof provider !== 'object' || provider === null || Array.isArray(provider)) {
    throw new Error('Provider 配置条目形状无效');
  }
  const entry = provider as Record<string, unknown>;
  const binding = entry.binding;
  if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
    throw new Error('Provider 目标绑定缺失');
  }
  const bindingRecord = binding as Record<string, unknown>;
  const generations = credentials.generations;
  if (typeof generations !== 'object' || generations === null || Array.isArray(generations)) {
    throw new Error('凭据世代缺失');
  }
  const generation = (generations as Record<string, unknown>)['openai-compatible'];
  if (
    bindingRecord.target !== baseUrl ||
    typeof bindingRecord.generation !== 'string' ||
    bindingRecord.generation !== generation
  ) {
    throw new Error('Provider 目标绑定与凭据世代不一致');
  }
  return bindingRecord.generation;
};

const scanProfileForPlaintexts = (
  root: string,
  needles: Readonly<Record<string, Buffer>>,
): {
  hits: Record<string, string[]>;
  scannedBytes: number;
  scannedEntries: number;
  scannedFiles: number;
} => {
  const hits = Object.fromEntries(Object.keys(needles).map((name) => [name, [] as string[]]));
  const maxNeedleBytes = Math.max(...Object.values(needles).map((needle) => needle.length));
  const maxBytes = 512 * 1024 * 1024;
  const maxEntries = 20_000;
  let scannedBytes = 0;
  let scannedEntries = 0;
  let scannedFiles = 0;
  const pendingDirectories = [root];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      scannedEntries += 1;
      if (scannedEntries > maxEntries) {
        throw new Error('合成 profile 明文扫描超出固定条目预算，不能授予零泄漏结论');
      }
      const stat = lstatSync(path);
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error('合成 profile 出现符号链接');
      }
      if (entry.isDirectory() && stat.isDirectory()) {
        pendingDirectories.push(path);
      } else if (entry.isFile() && stat.isFile()) {
        scannedFiles += 1;
        const descriptor = openSync(path, 'r');
        try {
          const chunk = Buffer.allocUnsafe(1024 * 1024);
          let tail = Buffer.alloc(0);
          while (true) {
            const bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
            if (bytesRead === 0) break;
            scannedBytes += bytesRead;
            if (scannedBytes > maxBytes) {
              throw new Error('合成 profile 明文扫描超出固定字节预算，不能授予零泄漏结论');
            }
            const searchable = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
            const relativePath = path.slice(root.length + 1);
            for (const [name, needle] of Object.entries(needles)) {
              if (searchable.indexOf(needle) >= 0 && !hits[name]!.includes(relativePath)) {
                hits[name]!.push(relativePath);
              }
            }
            tail = searchable.subarray(Math.max(0, searchable.length - maxNeedleBytes + 1));
          }
        } finally {
          closeSync(descriptor);
        }
      } else {
        throw new Error('合成 profile 出现未知或变化中的文件系统条目');
      }
    }
  }
  for (const values of Object.values(hits)) values.sort();
  return { hits, scannedBytes, scannedEntries, scannedFiles };
};

interface ProfileInventoryEntry {
  path: string;
  type: 'directory' | 'file';
  size: string;
  dev: string;
  ino: string;
}

const inventoryProfile = (root: string): ProfileInventoryEntry[] => {
  const maximumEntries = 20_000;
  const results: ProfileInventoryEntry[] = [];
  const pendingDirectories = [root];
  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    const entries = readdirSync(directory, { withFileTypes: true }).sort((first, second) =>
      first.name.localeCompare(second.name),
    );
    for (const entry of entries) {
      if (results.length >= maximumEntries) {
        throw new Error('合成 profile 清单超出固定条目预算');
      }
      const path = join(directory, entry.name);
      const stat = lstatSync(path, { bigint: true });
      if (entry.isSymbolicLink() || stat.isSymbolicLink()) {
        throw new Error('合成 profile 清单遇到符号链接');
      }
      const normalizedPath = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory() && stat.isDirectory()) {
        results.push({
          path: normalizedPath,
          type: 'directory',
          size: stat.size.toString(),
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
        });
        pendingDirectories.push(path);
      } else if (entry.isFile() && stat.isFile()) {
        results.push({
          path: normalizedPath,
          type: 'file',
          size: stat.size.toString(),
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
        });
      } else {
        throw new Error('合成 profile 清单遇到未知或变化中的文件系统条目');
      }
    }
  }
  return results.sort((first, second) => first.path.localeCompare(second.path));
};

const main = async (): Promise<void> => {
  const verified = await verifyPackagedDirectory(packageRoot);
  const profileIsolation = verifyProfileIsolationJournal(expectedAppDataRoot, profileJournalRoot);
  const profileRoot = join(expectedAppDataRoot, 'aibrowse');
  const profileBefore = inventoryProfile(profileRoot);
  if (
    profileBefore.length !== 1 ||
    profileBefore[0]?.path !== '.aibrowse-e1-synthetic-owner.json' ||
    profileBefore[0].type !== 'file'
  ) {
    throw new Error('Product资格只接受固定首轮owner marker profile；拒绝认领非空旧状态');
  }
  const forbiddenUserData = join(runRoot, 'forbidden-user-data-override');
  const nodeOptionsCanary = join(runRoot, 'node-options-canary.cjs');
  const nodeOptionsHit = join(runRoot, 'node-options-canary-hit.txt');
  writeFileSync(
    nodeOptionsCanary,
    `require('node:fs').writeFileSync(${JSON.stringify(nodeOptionsHit)}, 'hit')\n`,
    'utf8',
  );
  const syntheticKey = `E1-SYNTHETIC-${randomUUID()}`;
  const forbiddenEnvironmentKey = `E1-FORBIDDEN-ENV-${randomUUID()}`;
  const model = 'e1-synthetic-model';
  let providerMode: 'success' | 'redirect' = 'success';
  let providerResponseMarker = 'E1-PROVIDER-OK';
  let requests = 0;
  let authorizedRequests = 0;
  let validRequests = 0;
  let forbiddenRedirectRequests = 0;
  let hostileRendererRequests = 0;
  const requestPaths: string[] = [];

  const forbiddenServer = createServer((request, response) => {
    forbiddenRedirectRequests += 1;
    request.resume();
    response.writeHead(204).end();
  });
  const forbiddenPort = await listenLoopback(forbiddenServer);
  const hostileRendererServer = createServer((request, response) => {
    hostileRendererRequests += 1;
    request.resume();
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<title>HOSTILE-RENDERER-CANARY</title>');
  });
  const hostileRendererPort = await listenLoopback(hostileRendererServer);
  const providerServer = createServer((request, response) => {
    requests += 1;
    requestPaths.push(request.url ?? '');
    if (request.headers.authorization === `Bearer ${syntheticKey}`) authorizedRequests += 1;
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 1024 * 1024) chunks.push(chunk);
    });
    request.once('end', () => {
      const parsed: unknown = (() => {
        try {
          return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
        } catch {
          return null;
        }
      })();
      if (
        bytes <= 1024 * 1024 &&
        request.method === 'POST' &&
        request.url === '/v1/chat/completions' &&
        typeof parsed === 'object' &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).model === model
      ) {
        validRequests += 1;
      }
      if (providerMode === 'redirect') {
        response.writeHead(307, {
          location: `http://127.0.0.1:${String(forbiddenPort)}/credential-target`,
        });
        response.end();
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(providerResponseMarker)}}}]}\n\n` +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n',
      );
    });
  });
  const providerPort = await listenLoopback(providerServer);
  const baseUrl = `http://127.0.0.1:${String(providerPort)}/v1`;

  const executable = join(packageRoot, PACKAGED_EXECUTABLE);
  const providerConfigPath = join(profileRoot, 'provider-config.json');
  if (existsSync(providerConfigPath)) {
    throw new Error('Product资格必须在不存在Provider配置的固定首轮profile上运行');
  }
  const productEnvironment = {
    ...process.env,
    AIBROWSE_SMOKE: '1',
    AIBROWSE_LIVE_PROVIDER: '1',
    AIBROWSE_TEST_API_KEY: forbiddenEnvironmentKey,
    AIBROWSE_USER_DATA_DIR: forbiddenUserData,
    ELECTRON_RENDERER_URL: `http://127.0.0.1:${String(hostileRendererPort)}/hostile-renderer`,
    ELECTRON_RUN_AS_NODE: '1',
    NODE_OPTIONS: `--require=${nodeOptionsCanary}`,
  };
  let product: ChildProcess | null = null;
  let productExited = false;
  try {
    product = spawn(executable, ['--force-renderer-accessibility'], {
      cwd: packageRoot,
      env: productEnvironment,
      windowsHide: false,
      stdio: 'ignore',
    });
    product.once('error', () => {
      productExited = true;
    });
    product.once('exit', () => {
      productExited = true;
    });
    if (product.pid === undefined) throw new Error('未取得产品主进程 PID');
    const productPid = product.pid;
    const productProcessIdentity = await probeControlledProcessIdentity(
      profileJournalRoot,
      productPid,
      'ProductOriginal',
    );
    await delay(2_000);
    if (productExited) throw new Error('实际产品 EXE 在UI检查前退出');

    await runUiAction(productPid, 'Snapshot');
    await runUiAction(productPid, 'ConfigureCancel', ['-BaseUrl', baseUrl, '-Model', model], {
      AIBROWSE_E1_SYNTHETIC_KEY: syntheticKey,
    });
    if (requests !== 0) throw new Error('取消原生确认前后出现了 Provider 网络请求');
    if (existsSync(providerConfigPath)) {
      throw new Error('取消原生确认后 Provider 配置仍被提交');
    }
    await runUiAction(productPid, 'ConfigureConfirm', ['-BaseUrl', baseUrl]);
    const generation = verifyProviderBinding(profileRoot, baseUrl);
    const productCreatedFile = lstatSync(providerConfigPath, { bigint: true });
    if (!productCreatedFile.isFile()) throw new Error('实际产品未创建预期Provider配置普通文件');
    if (
      profileIsolation.nodeView !== undefined &&
      productCreatedFile.dev.toString() !== profileIsolation.nodeView.declared.dev
    ) {
      throw new Error('实际产品创建文件与Node所见disposable profile不在同一卷视图');
    }
    if (requests !== 0) throw new Error('主动提问前出现了 Provider 网络请求');

    await runUiAction(productPid, 'SubmitPrompt', [
      '-Question',
      '合成Provider成功路径',
      '-ResponseMarker',
      'E1-PROVIDER-OK',
    ]);
    await waitUntil(() => requests >= 1, '受控 Provider 未收到实际产品请求');
    providerMode = 'redirect';
    const requestsBeforeRedirect = requests;
    await runUiAction(productPid, 'SubmitPrompt', ['-Question', '合成Provider重定向反例']);
    await waitUntil(() => requests > requestsBeforeRedirect, '实际产品未发起重定向反例请求');
    await delay(750);
    if (forbiddenRedirectRequests !== 0) throw new Error('Provider 凭据请求跟随到未授权重定向目标');

    await runUiAction(productPid, 'Minimize');
    const second = spawn(executable, ['--force-renderer-accessibility'], {
      cwd: packageRoot,
      env: productEnvironment,
      windowsHide: false,
      stdio: 'ignore',
    });
    const secondExit = await Promise.race([
      new Promise<number | null>((resolveExit, rejectExit) => {
        second.once('error', rejectExit);
        second.once('exit', resolveExit);
      }),
      delay(10_000).then(() => 'timeout' as const),
    ]);
    if (secondExit === 'timeout') {
      if (second.pid !== undefined) await terminateOwnedProcessTree(second.pid);
      throw new Error('第二产品实例未在有界时间内退出');
    }
    if (secondExit !== 0) throw new Error(`第二产品实例退出码异常：${String(secondExit)}`);
    await runUiAction(productPid, 'VerifyRestoredForeground');

    if (existsSync(forbiddenUserData)) throw new Error('release 触碰了受禁 userData 覆盖路径');
    if (existsSync(nodeOptionsHit)) throw new Error('release 执行了 NODE_OPTIONS canary');
    if (hostileRendererRequests !== 0) throw new Error('release 请求了环境注入的 renderer URL');
    await terminateOwnedProcessTree(productPid);
    await waitUntil(() => productExited, '无法确认实际产品主进程退出', 5_000);
    product = null;
    await delay(500);

    const providerConfigBeforeRestart = snapshotStableFile(providerConfigPath, 256 * 1024);
    const credentialsBeforeRestart = snapshotStableFile(
      join(profileRoot, 'credentials.json'),
      9 * 1024 * 1024,
    );
    const generationBeforeRestart = verifyProviderBinding(profileRoot, baseUrl);
    if (generationBeforeRestart !== generation) throw new Error('冷重启前Provider世代意外变化');
    for (const temporary of [
      join(profileRoot, 'provider-config.json.tmp'),
      join(profileRoot, 'credentials.json.tmp'),
    ]) {
      if (existsSync(temporary)) throw new Error('冷重启前原子持久化残留临时文件');
    }
    const conversationsBeforeRestart = snapshotConversationFiles(profileRoot);
    const databasesBeforeRestart = inspectProductDatabases(profileRoot);
    const databaseFilesBeforeRestart = await probeDataFileIdentities('BeforeRestart');

    providerMode = 'success';
    providerResponseMarker = 'E1-PROVIDER-RESTART-OK';
    const requestsBeforeRestart = requests;
    productExited = false;
    product = spawn(executable, ['--force-renderer-accessibility'], {
      cwd: packageRoot,
      env: productEnvironment,
      windowsHide: false,
      stdio: 'ignore',
    });
    product.once('error', () => {
      productExited = true;
    });
    product.once('exit', () => {
      productExited = true;
    });
    if (product.pid === undefined) throw new Error('未取得冷重启产品主进程 PID');
    const restartPid = product.pid;
    const restartProcessIdentity = await probeControlledProcessIdentity(
      profileJournalRoot,
      restartPid,
      'ProductRestart',
    );
    await delay(2_000);
    if (productExited) throw new Error('实际产品 EXE 在冷重启UI检查前退出');
    const restartedUiState = await runUiAction(restartPid, 'VerifyRestartedState', [
      '-BaseUrl',
      baseUrl,
      '-Model',
      model,
      '-ResponseMarker',
      'E1-PROVIDER-OK',
    ]);
    if (requests !== requestsBeforeRestart)
      throw new Error('冷重启读取配置与会话时意外发起Provider请求');
    await runUiAction(restartPid, 'SubmitPrompt', [
      '-Question',
      '合成Provider冷重启恢复路径',
      '-ResponseMarker',
      providerResponseMarker,
    ]);
    await waitUntil(() => requests > requestsBeforeRestart, '冷重启后未使用已保存Provider发起请求');
    await delay(250);
    if (requests !== requestsBeforeRestart + 1) throw new Error('冷重启后Provider请求数量异常');
    await terminateOwnedProcessTree(restartPid);
    await waitUntil(() => productExited, '无法确认冷重启产品主进程退出', 5_000);
    product = null;
    await delay(500);

    const providerConfigAfterRestart = snapshotStableFile(providerConfigPath, 256 * 1024);
    const credentialsAfterRestart = snapshotStableFile(
      join(profileRoot, 'credentials.json'),
      9 * 1024 * 1024,
    );
    assertStableFileUnchanged(
      providerConfigBeforeRestart,
      providerConfigAfterRestart,
      'Provider配置',
    );
    assertStableFileUnchanged(credentialsBeforeRestart, credentialsAfterRestart, 'Provider凭据');
    const generationAfterRestart = verifyProviderBinding(profileRoot, baseUrl);
    if (generationAfterRestart !== generationBeforeRestart) {
      throw new Error('冷重启后Provider凭据世代或目标绑定变化');
    }
    const conversationsAfterRestart = snapshotConversationFiles(profileRoot);
    assertConversationAdvanced(conversationsBeforeRestart, conversationsAfterRestart);
    const databasesAfterRestart = inspectProductDatabases(profileRoot);
    assertProductDatabasesUnchanged(databasesBeforeRestart, databasesAfterRestart);
    const databaseFilesAfterRestart = await probeDataFileIdentities('AfterRestart');
    assertDataFileIdentitiesUnchanged(databaseFilesBeforeRestart, databaseFilesAfterRestart);
    if (existsSync(forbiddenUserData)) throw new Error('冷重启release触碰了受禁 userData 覆盖路径');
    if (existsSync(nodeOptionsHit)) throw new Error('冷重启release执行了 NODE_OPTIONS canary');
    if (hostileRendererRequests !== 0)
      throw new Error('冷重启release请求了环境注入的 renderer URL');

    const plaintextScan = scanProfileForPlaintexts(profileRoot, {
      syntheticKey: Buffer.from(syntheticKey),
      forbiddenEnvironmentKey: Buffer.from(forbiddenEnvironmentKey),
    });
    const plaintextHits = plaintextScan.hits.syntheticKey!;
    if (plaintextHits.length > 0) {
      throw new Error(`合成 Provider Key 以明文落盘：${plaintextHits.join(', ')}`);
    }
    const forbiddenEnvironmentHits = plaintextScan.hits.forbiddenEnvironmentKey!;
    if (forbiddenEnvironmentHits.length > 0) {
      throw new Error(
        `release 消费了受禁环境 Provider Key：${forbiddenEnvironmentHits.join(', ')}`,
      );
    }
    const profileAfter = inventoryProfile(profileRoot);
    if (
      profileAfter.some(
        (entry) =>
          ['provider-config.json.tmp', 'credentials.json.tmp'].includes(entry.path) ||
          /^(?:conversations|sources|research|watch|log)\/.*\.tmp$/u.test(entry.path),
      )
    ) {
      throw new Error('产品退出后Node持久化目录残留原子写临时文件');
    }
    const beforeByPath = new Map(profileBefore.map((entry) => [entry.path, entry]));
    const addedEntries = profileAfter.filter((entry) => !beforeByPath.has(entry.path));
    const changedEntries = profileAfter.filter((entry) => {
      const before = beforeByPath.get(entry.path);
      return before !== undefined && JSON.stringify(before) !== JSON.stringify(entry);
    });
    const addedPaths = new Set(addedEntries.map((entry) => entry.path));
    for (const required of [
      'provider-config.json',
      'credentials.json',
      'sources/sources.db',
      'research/research.db',
      'watch/watch.db',
    ]) {
      if (!addedPaths.has(required))
        throw new Error(`实际产品未在固定profile生成预期文件：${required}`);
    }
    if (
      ![...addedPaths].some((path) =>
        /^log\/aibrowse-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/u.test(path),
      )
    ) {
      throw new Error('实际产品未在固定profile生成预期日志文件');
    }
    const providerObservation: ProviderObservation = {
      requests,
      authorizedRequests,
      validRequests,
      forbiddenRedirectRequests,
      requestPaths,
    };
    if (authorizedRequests !== requests || validRequests !== requests || requests < 3) {
      throw new Error('受控 Provider 的授权请求计数不符合预期');
    }
    const report = {
      ok: true,
      package: {
        asarSha256: verified.asarSha256,
        asarHeaderSha256: verified.asarHeaderSha256,
        executableSha256: verified.executableSha256,
      },
      profileIsolation,
      product: {
        executable: PACKAGED_EXECUTABLE,
        accessibilitySwitch: true,
        secondInstanceExitCode: secondExit,
        processIdentity: productProcessIdentity,
        restartProcessIdentity,
        createdFile: {
          relativePath: 'provider-config.json',
          dev: productCreatedFile.dev.toString(),
          ino: productCreatedFile.ino.toString(),
        },
        profileDelta: {
          before: profileBefore,
          added: addedEntries,
          changed: changedEntries,
          afterEntryCount: profileAfter.length,
        },
      },
      provider: {
        ...providerObservation,
        generation,
        coldRestart: {
          requestsBeforeRestart,
          requestsAfterRestart: requests,
          generationBeforeRestart,
          generationAfterRestart,
          configBefore: providerConfigBeforeRestart,
          configAfter: providerConfigAfterRestart,
          credentialsBefore: credentialsBeforeRestart,
          credentialsAfter: credentialsAfterRestart,
        },
        syntheticKeyPlaintextFiles: plaintextHits,
        forbiddenEnvironmentKeyPlaintextFiles: forbiddenEnvironmentHits,
        plaintextScan: {
          scannedFiles: plaintextScan.scannedFiles,
          scannedEntries: plaintextScan.scannedEntries,
          scannedBytes: plaintextScan.scannedBytes,
          maxEntries: 20_000,
          maxBytes: 512 * 1024 * 1024,
        },
      },
      persistence: {
        conversation: {
          beforeRestart: conversationsBeforeRestart,
          afterRestart: conversationsAfterRestart,
          restartedUiState,
          newTurnPersisted: true,
        },
        emptyDatabaseReopen: {
          limitation: '只证明空业务库同对象、schema与完整性；不声称已有业务行跨重启保留',
          beforeRestart: databasesBeforeRestart,
          afterRestart: databasesAfterRestart,
          fileIdBeforeRestart: databaseFilesBeforeRestart,
          fileIdAfterRestart: databaseFilesAfterRestart,
        },
      },
      canaries: {
        nodeOptionsExecuted: existsSync(nodeOptionsHit),
        forbiddenUserDataTouched: existsSync(forbiddenUserData),
        hostileRendererRequests,
      },
      evidenceDirectory: runRoot,
    };
    writeFileSync(join(runRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (product?.pid !== undefined && !productExited) await terminateOwnedProcessTree(product.pid);
    await Promise.allSettled([
      closeServer(providerServer),
      closeServer(forbiddenServer),
      closeServer(hostileRendererServer),
    ]);
  }
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '未知错误';
  const failure = { ok: false, error: message, evidenceDirectory: runRoot };
  writeFileSync(join(runRoot, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
  process.stderr.write(`${JSON.stringify(failure, null, 2)}\n`);
  process.exitCode = 1;
});
