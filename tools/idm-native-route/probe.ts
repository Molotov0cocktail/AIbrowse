import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IdmNativeDownloadService } from '../../src/main/downloads/idm-native-service';

const root = process.cwd();
const output = join(root, 'log/builtin-tools-20261013', `idm-real-${randomUUID()}`);
await mkdir(output, { recursive: true });
const token = `idm-probe-${randomUUID().replaceAll('-', '')}`;
const requests: Array<{
  method: string;
  pathMatches: boolean;
  cookieMatches: boolean;
  refererMatches: boolean;
  agentMatches: boolean;
}> = [];
const server = createServer((request, response) => {
  requests.push({
    method: request.method ?? '',
    pathMatches: request.url === `/${token}.txt`,
    cookieMatches: request.headers.cookie === 'idm_probe=fixture',
    refererMatches: request.headers.referer === `http://127.0.0.1:${port}/fixture`,
    agentMatches: request.headers['user-agent'] === 'AIbrowse IDM integration probe',
  });
  if (requests.length > 4) {
    response.writeHead(429);
    response.end();
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${token}.txt"`,
    'Content-Length': '24',
  });
  response.end('AIbrowse IDM test data.\r\n');
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('本地探针监听失败');
const port = address.port;
const helperPath = join(root, 'out/idm/idm-handoff.exe');
const manifest = JSON.parse(await readFile(join(root, 'out/idm/manifest.json'), 'utf8')) as {
  sha256: string;
  bytes: number;
};
const service = new IdmNativeDownloadService({
  helperPath,
  expectedSha256: manifest.sha256,
  expectedBytes: manifest.bytes,
});
const observer = spawn(
  'pwsh',
  ['-NoProfile', '-File', join(root, 'tools/idm-native-route/native-dialog.ps1'), '-Token', token],
  { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
);
let observed = '';
let errors = '';
observer.stdout.on('data', (data: Buffer) => {
  if (observed.length < 4096) observed += data.toString();
});
observer.stderr.on('data', (data: Buffer) => {
  if (errors.length < 4096) errors += data.toString();
});
const observerDone = new Promise<number | null>((resolve, reject) => {
  observer.once('close', resolve);
  observer.once('error', reject);
});
let outcome: unknown;
let passed: boolean;
try {
  const status = await service.getStatus();
  const result = await service.send({
    url: `http://127.0.0.1:${port}/${token}.txt`,
    referer: `http://127.0.0.1:${port}/fixture`,
    cookie: 'idm_probe=fixture',
    filename: `${token}.txt`,
    userAgent: 'AIbrowse IDM integration probe',
  });
  const observerExit = await observerDone;
  const observedResult: unknown = JSON.parse(observed.trim());
  passed =
    status.available &&
    result.ok &&
    observerExit === 0 &&
    observedResult !== null &&
    typeof observedResult === 'object' &&
    Reflect.get(observedResult, 'found') === true &&
    Reflect.get(observedResult, 'closed') === true &&
    Reflect.get(observedResult, 'clickedStart') === false;
  outcome = {
    status,
    result,
    observerExit,
    observer: observed.trim(),
    observerErrors: errors.trim(),
    requests,
    helperSha256: createHash('sha256')
      .update(await readFile(helperPath))
      .digest('hex'),
    providerCalls: 0,
    remoteNetwork: 0,
    toolRealUserProfileReads: 0,
  };
} finally {
  service.dispose();
  observer.kill();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
await writeFile(join(output, 'result.json'), JSON.stringify(outcome, null, 2));
process.stdout.write(`${output}\n${JSON.stringify(outcome)}\n`);
process.exitCode = passed ? 0 : 1;
