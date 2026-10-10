import { createHash } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readPrivateLogs } from '../cross-smoke-readback.ts';
import { snapshotOut } from '../cross-smoke-scope.ts';
import { verifyDefaultSmokeEvidence } from './evidence.ts';
import { snapshotSmokeSources, type SourceMember } from './scope.ts';

const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_ARTIFACT_ENTRIES = 4096;
const MAX_ARTIFACT_DEPTH = 16;

interface ReadbackRequest {
  root: string;
  repository: string;
  appRoot: string;
  profile: string;
  buildReceipt: string;
  output: string;
  exitCode: number;
  jobZero: boolean;
}

function boundedFile(path: string, maxBytes: number): Buffer {
  const named = lstatSync(path, { bigint: true });
  if (
    !named.isFile() ||
    named.isSymbolicLink() ||
    named.nlink !== 1n ||
    named.size > BigInt(maxBytes)
  )
    throw new Error('默认冒烟证据类型或容量异常');
  const descriptor = openSync(path, 'r');
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (before.dev !== named.dev || before.ino !== named.ino || before.size !== named.size)
      throw new Error('默认冒烟证据身份改变');
    const output = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < output.length) {
      const count = readSync(descriptor, output, offset, output.length - offset, offset);
      if (count === 0) throw new Error('默认冒烟证据读取中断');
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    const finalName = lstatSync(path, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      finalName.dev !== before.dev ||
      finalName.ino !== before.ino
    )
      throw new Error('默认冒烟证据读取期间改变');
    return output;
  } finally {
    closeSync(descriptor);
  }
}

export function measureArtifacts(root: string): { bytes: number; entries: number } {
  let bytes = 0;
  let entries = 0;
  const walk = (path: string, depth: number): void => {
    if (depth > MAX_ARTIFACT_DEPTH) throw new Error('默认冒烟原件超过深度预算');
    const stat = lstatSync(path, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      (!stat.isDirectory() && !stat.isFile()) ||
      (stat.isFile() && stat.nlink !== 1n)
    )
      throw new Error('默认冒烟原件包含未知类型或链接');
    entries += 1;
    if (entries > MAX_ARTIFACT_ENTRIES) throw new Error('默认冒烟原件超过成员预算');
    if (stat.isFile()) {
      bytes += Number(stat.size);
      if (bytes > MAX_ARTIFACT_BYTES) throw new Error('默认冒烟原件超过字节预算');
      return;
    }
    const directory = opendirSync(path);
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync())
        walk(join(path, entry.name), depth + 1);
    } finally {
      directory.closeSync();
    }
  };
  walk(root, 0);
  return { bytes, entries };
}

function validLedger(path: string): boolean {
  const ledger = JSON.parse(boundedFile(path, 4096).toString('utf8')) as Record<string, unknown>;
  return (
    Object.keys(ledger).sort().join(',') === 'main,root,session,utility,version' &&
    ledger.version === 1 &&
    typeof ledger.root === 'string' &&
    /^[a-f0-9]{64}$/.test(ledger.root) &&
    typeof ledger.session === 'string' &&
    /^[a-f0-9]{32}$/.test(ledger.session) &&
    ledger.main === null &&
    ledger.utility === null
  );
}

function readRequest(path: string): ReadbackRequest {
  return JSON.parse(boundedFile(path, 4096).toString('utf8')) as ReadbackRequest;
}

export function runDefaultSmokeReadback(request: ReadbackRequest): void {
  const sources = JSON.parse(
    boundedFile(`${request.buildReceipt}.sources.json`, 1024 * 1024).toString('utf8'),
  ) as {
    version: number;
    source: SourceMember[];
  };
  if (
    sources.version !== 1 ||
    JSON.stringify(snapshotSmokeSources(request.repository)) !== JSON.stringify(sources.source) ||
    JSON.stringify(snapshotSmokeSources(request.appRoot)) !== JSON.stringify(sources.source)
  )
    throw new Error('默认冒烟安全自检源码快照改变');
  const receipt = JSON.parse(boundedFile(request.buildReceipt, 1024 * 1024).toString('utf8')) as {
    files: ReturnType<typeof snapshotOut>;
    log: { dev: string; ino: string };
  };
  if (JSON.stringify(snapshotOut(request.repository)) !== JSON.stringify(receipt.files))
    throw new Error('默认冒烟运行制品与启动绑定不符');
  const logs = readPrivateLogs(request.appRoot, receipt.log);
  const log = new TextDecoder('utf-8', { fatal: true }).decode(logs.bytes);
  const ledgerRetired = validLedger(join(request.profile, 'lifecycle-guardian/writers.json'));
  const passed = verifyDefaultSmokeEvidence({ ...request, ledgerRetired, log });
  const usageBeforeOutput = measureArtifacts(request.root);
  const logOutput = request.output.replace(/\.json$/, '.main-log.txt');
  writeFileSync(logOutput, logs.bytes, { flag: 'wx' });
  const result = {
    passed,
    ledgerRetired,
    usageBeforeOutput,
    logMembers: logs.members,
    logSha256: createHash('sha256').update(logs.bytes).digest('hex'),
  };
  writeFileSync(request.output, JSON.stringify(result), { flag: 'wx' });
  measureArtifacts(request.root);
  if (!passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error('默认冒烟读回参数非法');
  runDefaultSmokeReadback(readRequest(process.argv[2]!));
}
