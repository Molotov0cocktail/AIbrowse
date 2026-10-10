// Fixed synthetic capacity qualification. It never reads a profile or an untrusted container.
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { parseIndexFile, parseMessagesFile } from '../../../src/main/ai/conversation-store';
import { fixtureId } from '../fixtures';
import {
  LIMITS,
  checkBytes,
  inspectShape,
  projectIndex,
  projectSession,
  requireFact,
  sessionChunks,
  type Projection,
} from './projection';
import { FIXED_SAMPLES, MEASUREMENT, fiftyIndex } from './samples';
import {
  FixedFrameWriter,
  capacityArithmetic,
  conversationHeader,
  conversationPlan,
  maximumMetadata,
  type Submember,
} from './layout';

const root = __dirname;
requireFact(
  process.platform === 'win32' && process.arch === 'x64' && /^v24\./.test(process.version),
  'shape',
);
requireFact(process.argv.length === 3 && process.argv[2] === '--qualification-run', 'shape');
requireFact(
  /^projection-[a-f0-9]{32}$/.test(basename(root)) &&
    basename(dirname(root)) === 'stage7-e2' &&
    basename(dirname(dirname(root))) === 'log',
  'id',
);
for (const path of [resolve(root, '../../..'), resolve(root, '../..'), dirname(root), root])
  requireFact(!lstatSync(path).isSymbolicLink(), 'id');
const runtime = join(root, 'runtime');
mkdirSync(runtime);
globalThis.fetch = async () => {
  throw new Error('固定离线资格禁止网络');
};
const started = performance.now();
const entries: Record<string, unknown>[] = [];
let sampledPeakRss = 0;
let rssSamples = 0;
let completed = false;
let failure: string | null = null;
let streamEvidence: Record<string, unknown> | null = null;

function sample(): void {
  sampledPeakRss = Math.max(sampledPeakRss, process.memoryUsage().rss);
  rssSamples++;
  requireFact(performance.now() - started <= MEASUREMENT.operationMs, 'bytes');
}
function diskBytes(path: string): number {
  let bytes = 0;
  for (const name of readdirSync(path)) {
    const child = join(path, name);
    const info = lstatSync(child);
    requireFact(!info.isSymbolicLink(), 'id');
    bytes += info.isDirectory() ? diskBytes(child) : info.size;
  }
  checkBytes(bytes, MEASUREMENT.diskBytes);
  return bytes;
}
function digest(chunks: Iterable<Buffer>): { length: number; sha256: string } {
  const hash = createHash('sha256');
  let length = 0;
  for (const chunk of chunks) {
    hash.update(chunk);
    length += chunk.length;
    sample();
  }
  return { length, sha256: hash.digest('hex') };
}
function readSession(path: string): Projection {
  checkBytes(lstatSync(path).size, LIMITS.sessionBytes);
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  sample();
  return projectSession(raw, sample);
}
writeFileSync(
  join(runtime, 'measurement-plan.json'),
  JSON.stringify(
    {
      purpose: '闭合Conversation合成投影资格，非历史最大值、非产品导入器',
      limits: LIMITS,
      measurement: MEASUREMENT,
      samples: FIXED_SAMPLES.map(({ id, pretty }) => ({ id, pretty })),
      oracle:
        '实际旧格式零丢弃；已允许字段不裁切；闭合输出/字节/节点/深度；50子成员真实流写的长度、摘要与EOF；任何失败停止并保留',
    },
    null,
    2,
  ),
);

try {
  sample();
  const sampleDigests = new Map<string, { length: number; sha256: string }>();
  for (const spec of FIXED_SAMPLES) {
    const before = performance.now();
    const rawPath = join(runtime, `${spec.id}.legacy.json`);
    {
      const raw = spec.create();
      const text = JSON.stringify(raw, null, spec.pretty ? 2 : undefined);
      sample();
      checkBytes(Buffer.byteLength(text), LIMITS.sessionBytes);
      writeFileSync(rawPath, text, { flag: 'wx' });
    }
    global.gc?.();
    const legacyStarted = performance.now();
    let legacy = parseMessagesFile(readFileSync(rawPath, 'utf8'));
    requireFact(legacy !== null && legacy.dropped === 0, 'shape');
    const legacyMessages = legacy.messages.length;
    const legacyMs = performance.now() - legacyStarted;
    sample();
    legacy = null;
    global.gc?.();
    const projectionStarted = performance.now();
    const projected = readSession(rawPath);
    const projectionMs = performance.now() - projectionStarted;
    const encoded = digest(sessionChunks(projected.value));
    requireFact(
      encoded.length === projected.compactBytes && projected.excludedFields === 0,
      'bytes',
    );
    if (spec.id === 'known-large-cjk')
      requireFact(projected.maximumMessageBytes === 3_145_839, 'bytes');
    if (spec.id === 'message-4mib')
      requireFact(projected.maximumMessageBytes === LIMITS.messageBytes, 'bytes');
    if (spec.id === 'nodes-262144')
      requireFact(projected.outputShape.nodes === LIMITS.nodes, 'nodes');
    if (spec.id === 'session-64mib')
      requireFact(projected.compactBytes === LIMITS.sessionBytes, 'bytes');
    sampleDigests.set(spec.id, encoded);
    entries.push({
      id: spec.id,
      legacyMessages,
      legacyBytes: lstatSync(rawPath).size,
      legacyDropped: 0,
      inputShape: projected.inputShape,
      projectedShape: projected.outputShape,
      projectedBytes: projected.compactBytes,
      maximumMessageBytes: projected.maximumMessageBytes,
      excludedFields: projected.excludedFields,
      sha256: encoded.sha256,
      legacyParseMs: legacyMs,
      projectionMs,
      totalMs: performance.now() - before,
    });
    diskBytes(root);
    global.gc?.();
  }
  const rawIndex = fiftyIndex();
  const indexPath = join(runtime, 'index.legacy.json');
  writeFileSync(indexPath, JSON.stringify(rawIndex, null, 2), { flag: 'wx' });
  checkBytes(lstatSync(indexPath).size, LIMITS.indexBytes);
  const legacyIndex = parseIndexFile(readFileSync(indexPath, 'utf8'));
  requireFact(
    legacyIndex !== null && legacyIndex.dropped === 0 && legacyIndex.sessions.length === 50,
    'count',
  );
  const index = projectIndex(JSON.parse(readFileSync(indexPath, 'utf8')));
  const indexBody = Buffer.from(JSON.stringify(index.value));
  entries.push({
    id: 'index-50',
    legacyBytes: lstatSync(indexPath).size,
    projectedBytes: index.compactBytes,
    inputShape: index.inputShape,
    projectedShape: index.outputShape,
    count: 50,
  });
  const emptyBody = Buffer.from('{"version":2,"messages":[]}');
  const empty = digest([emptyBody]);
  const largest = sampleDigests.get('session-64mib');
  requireFact(largest !== undefined, 'count');
  const ids = rawIndex.sessions.map((entry) => entry.id);
  const members: Submember[] = [
    { id: 'index', ...digest([indexBody]) },
    ...ids.map((id, i) => ({ id, ...(i === 0 ? largest : empty) })),
  ];
  for (let i = 1; i < ids.length; i++) {
    const path = join(runtime, `${fixtureId(i)}.legacy.json`);
    writeFileSync(path, emptyBody, { flag: 'wx' });
    requireFact(parseMessagesFile(readFileSync(path, 'utf8'))?.dropped === 0, 'shape');
  }
  const plan = conversationPlan(ids, members);
  const output = join(runtime, 'conversations.synthetic.bin');
  const descriptor = openSync(output, 'wx');
  let written = 0;
  const streamHash = createHash('sha256');
  const sink = (buffer: Buffer) => {
    for (let offset = 0; offset < buffer.length;) {
      const chunk = buffer.subarray(
        offset,
        Math.min(offset + MEASUREMENT.chunkBytes, buffer.length),
      );
      const count = writeSync(descriptor, chunk);
      requireFact(count > 0, 'bytes');
      streamHash.update(chunk.subarray(0, count));
      written += count;
      offset += count;
      sample();
    }
  };
  const writeStarted = performance.now();
  try {
    sink(conversationHeader(plan.count, plan.length));
    const writer = new FixedFrameWriter(members, sink);
    for (let i = 0; i < members.length; i++) {
      const member = members[i]!;
      writer.begin(member);
      if (i === 0) writer.chunk(indexBody);
      else if (i === 1)
        for (const chunk of sessionChunks(
          readSession(join(runtime, 'session-64mib.legacy.json')).value,
        ))
          writer.chunk(chunk);
      else writer.chunk(emptyBody);
      writer.end();
    }
    writer.finish();
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  requireFact(written === plan.length && lstatSync(output).size === plan.length, 'bytes');
  const writtenHash = streamHash.digest('hex');
  const readDescriptor = openSync(output, 'r');
  const readHash = createHash('sha256');
  let readBytes = 0;
  try {
    const buffer = Buffer.alloc(MEASUREMENT.chunkBytes);
    for (;;) {
      const count = readSync(readDescriptor, buffer);
      if (count === 0) break;
      readBytes += count;
      checkBytes(readBytes, plan.length);
      readHash.update(buffer.subarray(0, count));
      sample();
    }
  } finally {
    closeSync(readDescriptor);
  }
  requireFact(readBytes === plan.length && readHash.digest('hex') === writtenHash, 'bytes');
  streamEvidence = {
    submembers: members.length,
    sessions: ids.length,
    declaredBytes: plan.length,
    writtenBytes: written,
    actualFileBytes: lstatSync(output).size,
    exactEof: true,
    sha256: writtenHash,
    readBytes,
    readHashMatches: true,
    writeFlushReadMs: performance.now() - writeStarted,
  };
  const metadata = maximumMetadata();
  entries.push({
    id: 'maximum-manifest',
    bytes: Buffer.byteLength(JSON.stringify(metadata.manifest)),
    ...inspectShape(metadata.manifest),
  });
  entries.push({
    id: 'maximum-result',
    bytes: Buffer.byteLength(JSON.stringify(metadata.result)),
    ...inspectShape(metadata.result),
  });
  sample();
  diskBytes(root);
  completed = true;
} catch (error) {
  failure = error instanceof Error ? error.message.slice(0, 256) : '受控资格失败';
  process.exitCode = 1;
} finally {
  writeFileSync(
    join(runtime, 'report.json'),
    JSON.stringify(
      {
        buildId: basename(root),
        completed,
        productE2Pass: false,
        failure,
        node: process.version,
        limits: LIMITS,
        measurement: MEASUREMENT,
        arithmetic: capacityArithmetic(),
        entries,
        streamEvidence,
        durationMs: performance.now() - started,
        directoryBytesBeforeReport: diskBytes(root),
        rss: {
          samples: rssSamples,
          sampledPeakBytes: sampledPeakRss,
          processResourceUsageMaxRssKiB: process.resourceUsage().maxRSS,
          scope: '本次Node合成运行；采样峰值可能漏掉同步区间峰值，未执行完整维护或Electron UI',
        },
      },
      null,
      2,
    ),
  );
}
