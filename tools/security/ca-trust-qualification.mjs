// Fixed public test hosts only. No credentials, trust overrides, retries or response bodies.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout, clearTimeout } from 'node:timers';
import { CA_TARGETS, classifyObservation, classifyReport, errorCode } from './ca-trust-oracle.mjs';

const script = fileURLToPath(import.meta.url);
const timeoutMs = 15_000;
const userAgent = 'AIbrowse-CA-Qualification/1';
const args = process.argv.slice(process.versions.electron ? 1 : 2);
function argument(name) {
  return args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
}
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function save(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}
function projectChain(socket) {
  const result = [];
  const seen = new Set();
  let cert = socket.getPeerCertificate(true);
  while (cert?.raw && result.length < 10) {
    const parsed = new crypto.X509Certificate(cert.raw);
    if (seen.has(parsed.fingerprint256)) break;
    seen.add(parsed.fingerprint256);
    result.push({
      sha256: parsed.fingerprint256,
      spkiSha256: crypto
        .createHash('sha256')
        .update(parsed.publicKey.export({ type: 'spki', format: 'der' }))
        .digest('hex'),
    });
    cert = cert.issuerCertificate;
  }
  return result;
}
function requestHttps(target) {
  return new Promise((resolve) => {
    let settled = false;
    let chain = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve({ ...result, chain });
    };
    const request = https.get(
      target.url,
      { agent: false, headers: { 'User-Agent': userAgent } },
      (response) => {
        const status = response.statusCode;
        response.destroy();
        finish({ outcome: 'response', status });
      },
    );
    const timer = setTimeout(() => finish({ outcome: 'error', code: 'ETIMEDOUT' }), timeoutMs);
    request.on('socket', (socket) =>
      socket.once('secureConnect', () => {
        chain = projectChain(socket);
      }),
    );
    request.on('error', (error) => finish({ outcome: 'error', code: errorCode(error) }));
  });
}
async function requestFetch(target, fetcher) {
  const controller = new globalThis.AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(target.url, {
      method: 'GET',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'User-Agent': userAgent },
      signal: controller.signal,
    });
    const status = response.status;
    await response.body?.cancel();
    return { outcome: 'response', status };
  } catch (error) {
    return { outcome: 'error', code: controller.signal.aborted ? 'ETIMEDOUT' : errorCode(error) };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
async function worker(root, kind) {
  let electron;
  let isolated;
  if (kind === 'electron') {
    electron = await import('electron');
    const profile = path.join(root, 'profile');
    fs.mkdirSync(profile);
    electron.app.setPath('userData', profile);
    electron.app.setPath('sessionData', profile);
    electron.app.commandLine.appendSwitch('disable-background-networking');
    await electron.app.whenReady();
    isolated = electron.session.fromPartition(`ca-trust-${crypto.randomUUID()}`, { cache: false });
    await isolated.setProxy({ mode: 'direct' });
    await isolated.netLog.startLogging(path.join(root, 'chromium-netlog.json'), {
      captureMode: 'default',
    });
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const allowed = new Set(CA_TARGETS.map((target) => target.url));
    let starts = 0;
    isolated.webRequest.onBeforeRequest((details, callback) => {
      starts += 1;
      callback({
        cancel: starts > CA_TARGETS.length || !allowed.has(details.url) || details.method !== 'GET',
      });
    });
  }
  const transports =
    argument('chromium-only') === '1'
      ? ['chromium-fetch']
      : ['node-https', 'node-fetch', ...(isolated ? ['chromium-fetch'] : [])];
  const rows = [];
  try {
    for (const transport of transports) {
      for (const target of CA_TARGETS) {
        const started = Date.now();
        fs.appendFileSync(
          path.join(root, `${kind}-attempts.jsonl`),
          `${JSON.stringify({ transport, target: target.id, startedAt: new Date().toISOString() })}\n`,
        );
        const observation =
          transport === 'node-https'
            ? await requestHttps(target)
            : await requestFetch(
                target,
                transport === 'node-fetch' ? globalThis.fetch : isolated.fetch.bind(isolated),
              );
        const row = {
          transport,
          target: target.id,
          ...observation,
          elapsedMs: Date.now() - started,
          verdict: classifyObservation(target, observation),
        };
        rows.push(row);
        fs.appendFileSync(
          path.join(root, `${kind}-observations.jsonl`),
          `${JSON.stringify(row)}\n`,
        );
      }
    }
    save(path.join(root, `${kind}-result.json`), {
      versions: process.versions,
      executableSha256: sha256(process.execPath),
      verdict: classifyReport(rows, transports),
      requests: rows.length,
      transports,
      rows,
    });
  } finally {
    await isolated?.closeAllConnections();
    await isolated?.netLog.stopLogging();
    if (electron) electron.app.exit(0);
  }
}
async function launch(executable, kind, root, chromiumOnly) {
  const env = {};
  for (const name of [
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.PATH = path.dirname(executable);
  const child = spawn(
    executable,
    [
      script,
      `--worker=${kind}`,
      `--evidence-root=${root}`,
      ...(chromiumOnly ? ['--chromium-only=1'] : []),
    ],
    {
      windowsHide: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const output = fs.createWriteStream(path.join(root, `${kind}-process.log`), { flags: 'wx' });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  let killed = false;
  const watchdog = setTimeout(() => {
    killed = true;
    child.kill();
  }, 170_000);
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  }).finally(() => {
    clearTimeout(watchdog);
    output.end();
  });
  const resultPath = path.join(root, `${kind}-result.json`);
  return {
    kind,
    exitCode,
    killed,
    result: fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : null,
  };
}
async function main() {
  const root = path.resolve(argument('evidence-root') ?? '');
  const allowed = path.resolve('log') + path.sep;
  if (!root.startsWith(allowed)) throw new Error('证据目录必须在项目log内');
  const kind = argument('worker');
  if (kind) {
    if (!['node', 'electron'].includes(kind) || !fs.existsSync(path.join(root, 'contract.json')))
      throw new Error('验证子进程参数无效');
    await worker(root, kind);
    return;
  }
  if (fs.existsSync(root)) throw new Error('必须使用新证据目录，保留旧结果');
  const nodeExe = path.resolve(argument('node-exe') ?? '');
  const electronExe = path.resolve(argument('electron-exe') ?? '');
  const only = argument('only');
  if (only !== undefined && !['node', 'electron', 'chromium'].includes(only))
    throw new Error('运行时选择无效');
  const selected = [
    ...(only !== 'electron' && only !== 'chromium' ? [{ executable: nodeExe, kind: 'node' }] : []),
    ...(only !== 'node' ? [{ executable: electronExe, kind: 'electron' }] : []),
  ];
  for (const { executable } of selected)
    if (!fs.statSync(executable).isFile()) throw new Error('运行时无效');
  fs.mkdirSync(root, { recursive: true });
  save(path.join(root, 'contract.json'), {
    purpose: '验证eMudhra受影响原链和Sectigo交叉链在两种运行时三类网络路径的原生拒绝',
    startedAt: new Date().toISOString(),
    requestBudget:
      only === 'chromium'
        ? 3
        : selected.reduce((sum, runtime) => sum + (runtime.kind === 'node' ? 6 : 9), 0),
    timeoutMs,
    retries: 0,
    targets: CA_TARGETS,
    scriptSha256: sha256(script),
    oracleSha256: sha256(path.join(path.dirname(script), 'ca-trust-oracle.mjs')),
    runtimes: selected.map(({ executable, kind }) => ({ kind, sha256: sha256(executable) })),
    oracle:
      '正常站2xx且两受影响站分别返回CERT_REVOKED/ERR_CERT_REVOKED；超时、网络错误或普通CA错误为BLOCKED；受影响站任意HTTP响应为REPAIR',
    boundary:
      '固定GET、无凭据/正文保存、无证书覆盖、禁止重定向、隔离Chromium分区和profile、开发runtime资格不冒称发行包启动通过',
  });
  const results = [];
  for (const { executable, kind } of selected)
    results.push(await launch(executable, kind, root, only === 'chromium'));
  const verdict = results.some(
    (result) =>
      result.exitCode !== 0 ||
      result.killed ||
      !result.result ||
      result.result.verdict === 'BLOCKED',
  )
    ? 'BLOCKED'
    : results.some((result) => result.result.verdict === 'REPAIR')
      ? 'REPAIR'
      : 'PASS';
  save(path.join(root, 'result.json'), { verdict, results });
  process.stdout.write(
    `${JSON.stringify({ root, verdict, requests: results.map((result) => result.result?.requests ?? null) })}\n`,
  );
  process.exitCode = verdict === 'PASS' ? 0 : 1;
}
// Electron's ready event waits for ESM evaluation to finish. Do not top-level-await it.
void main().catch(() => {
  process.stderr.write('CA资格执行失败；保留已生成的请求及错误证据\n');
  process.exitCode = 1;
  if (process.versions.electron) {
    void import('electron').then(({ app }) => app.exit(1));
  }
});
