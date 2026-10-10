import { createHash } from 'node:crypto';
import { opendirSync, type BigIntStats } from 'node:fs';
import { JsonReadError, parseBoundedJson } from './bounded-json';
import {
  LIMITS,
  ProjectionError,
  projectIndex,
  projectSession,
  sessionChunks,
  type JsonObject,
} from '../ai/conversation-transfer';
import {
  BackupContainerError,
  BACKUP_LIMITS,
  TransferDirectory,
  TransferInput,
  TransferOutput,
  assertFileUnchanged,
  checkTransferControl,
  readLength,
  requireTransfer,
  transferBoundary,
  uuidBytes,
  isTransferUuid,
  verifyTransferOutputs,
  type FileDigest,
  type OperationControl,
} from './backup-container';
export interface WriteConversationOptions {
  sourceDirectory: string;
  outputPath: string;
  snapshotId: string;
  control: OperationControl;
}
export interface ReadConversationOptions {
  inputPath: string;
  stagingDirectory: string;
  snapshotId: string;
  control: OperationControl;
}
const MAGIC = Buffer.from('AICONV01', 'ascii');
const HEADER_BYTES = 32;
const CHILD_BYTES = 77;
function conversationBoundary<T>(work: () => T): T {
  return transferBoundary(() => {
    try {
      return work();
    } catch (error) {
      if (error instanceof ProjectionError)
        throw new BackupContainerError(
          ['bytes', 'count', 'depth', 'nodes'].includes(error.code)
            ? 'budget-exceeded'
            : 'invalid-conversation',
        );
      if (error instanceof JsonReadError)
        throw new BackupContainerError(
          error.code === 'budget-exceeded' ? 'budget-exceeded' : 'invalid-conversation',
        );
      throw error;
    }
  });
}
function parse(bytes: Buffer, limit: number): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new BackupContainerError('invalid-conversation');
  }
  return parseBoundedJson(text, { bytes: limit, depth: LIMITS.inputDepth, nodes: LIMITS.nodes });
}
function ids(index: JsonObject): string[] {
  return (index.sessions as JsonObject[]).map((session) => {
    requireTransfer(isTransferUuid(session.id), 'invalid-conversation');
    return session.id;
  });
}
function childHeader(id: string, bytes: number, sha256: string): Buffer {
  const header = Buffer.alloc(CHILD_BYTES);
  header[0] = id === 'index' ? 1 : 2;
  if (id !== 'index') {
    requireTransfer(isTransferUuid(id), 'invalid-conversation');
    header.write(id, 1, 36, 'ascii');
  }
  header.writeBigUInt64BE(BigInt(bytes), 37);
  Buffer.from(sha256, 'hex').copy(header, 45);
  return header;
}
function digestChunks(chunks: Iterable<Buffer>): FileDigest {
  const hash = createHash('sha256');
  let bytes = 0;
  for (const chunk of chunks) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}
function writeChild(
  output: TransferOutput,
  id: string,
  expectedBytes: number,
  chunks: () => Iterable<Buffer>,
  control: OperationControl,
): void {
  checkTransferControl(control);
  const digest = digestChunks(chunks());
  requireTransfer(digest.bytes === expectedBytes, 'integrity-failed');
  output.write(childHeader(id, digest.bytes, digest.sha256));
  for (const chunk of chunks()) {
    checkTransferControl(control);
    output.write(chunk);
  }
  checkTransferControl(control);
}
function perSession(control: OperationControl): OperationControl {
  return {
    signal: control.signal,
    deadline: Math.min(control.deadline, performance.now() + 20000),
  };
}
function readJsonFile(
  path: string,
  limit: number,
  control: OperationControl,
): { value: unknown; identity: BigIntStats } {
  const input = new TransferInput(path, limit, control);
  try {
    const bytes = input.read(input.size);
    input.finish();
    const value = parse(bytes, limit);
    checkTransferControl(control);
    return { value, identity: input.identity };
  } finally {
    input.close();
  }
}
function names(directory: TransferDirectory, control: OperationControl): string[] {
  directory.assertCurrent();
  const entries: string[] = [];
  const folded = new Set<string>();
  const handle = opendirSync(directory.path, { bufferSize: 1 });
  try {
    while (true) {
      checkTransferControl(control);
      const entry = handle.readSync();
      if (entry === null) break;
      requireTransfer(entries.length < 51, 'budget-exceeded');
      const name = entry.name;
      requireTransfer(
        name === 'index.json' || (name.endsWith('.json') && isTransferUuid(name.slice(0, -5))),
        'invalid-conversation',
      );
      requireTransfer(!folded.has(name.toLowerCase()), 'invalid-conversation');
      folded.add(name.toLowerCase());
      entries.push(name);
    }
  } finally {
    handle.closeSync();
  }
  return entries.sort();
}
/** Projects a caller-owned, quiescent private snapshot; an absent root is handled by the outer manifest. */
export function writeConversationMember(options: WriteConversationOptions): {
  bytes: number;
  sha256: string;
  sessions: number;
} {
  return conversationBoundary(() => {
    checkTransferControl(options.control);
    uuidBytes(options.snapshotId);
    const directory = new TransferDirectory(options.sourceDirectory);
    const originalNames = names(directory, options.control);
    const checked: Array<{ path: string; identity: BigIntStats }> = [];
    let index: ReturnType<typeof projectIndex>;
    if (originalNames.length === 0) index = projectIndex({ version: 1, sessions: [] });
    else {
      requireTransfer(originalNames.includes('index.json'), 'invalid-conversation');
      const path = directory.file('index.json');
      const raw = readJsonFile(path, LIMITS.indexBytes, options.control);
      checked.push({ path, identity: raw.identity });
      index = projectIndex(raw.value);
    }
    const sessionIds = ids(index.value);
    const known = new Set(sessionIds.map((id) => `${id.toLowerCase()}.json`));
    requireTransfer(
      originalNames.every((name) => name === 'index.json' || known.has(name.toLowerCase())),
      'invalid-conversation',
    );
    const sourceNames = new Map(originalNames.map((name) => [name.toLowerCase(), name]));
    const output = new TransferOutput(
      options.outputPath,
      BACKUP_LIMITS.conversations,
      options.control,
    );
    try {
      const header = Buffer.alloc(HEADER_BYTES);
      MAGIC.copy(header);
      header.writeUInt32BE(1, 8);
      header.writeUInt32BE(sessionIds.length + 1, 12);
      uuidBytes(options.snapshotId).copy(header, 16);
      output.write(header);
      writeChild(
        output,
        'index',
        index.compactBytes,
        () => [Buffer.from(JSON.stringify(index.value))],
        options.control,
      );
      for (const id of sessionIds) {
        const control = perSession(options.control);
        checkTransferControl(control);
        const filename = sourceNames.get(`${id.toLowerCase()}.json`);
        let raw: unknown = { version: 2, messages: [] };
        if (filename !== undefined) {
          const path = directory.file(filename);
          const read = readJsonFile(path, LIMITS.sessionBytes, control);
          raw = read.value;
          checked.push({ path, identity: read.identity });
        }
        const session = projectSession(raw, () => checkTransferControl(control));
        writeChild(output, id, session.compactBytes, () => sessionChunks(session.value), control);
      }
      requireTransfer(
        JSON.stringify(names(directory, options.control)) === JSON.stringify(originalNames),
        'input-changed',
      );
      for (const file of checked) assertFileUnchanged(file.path, file.identity);
      const written = output.finish();
      requireTransfer(
        JSON.stringify(names(directory, options.control)) === JSON.stringify(originalNames),
        'input-changed',
      );
      for (const file of checked) assertFileUnchanged(file.path, file.identity);
      verifyTransferOutputs([output], options.control, () => {
        requireTransfer(
          JSON.stringify(names(directory, options.control)) === JSON.stringify(originalNames),
          'input-changed',
        );
        for (const file of checked) assertFileUnchanged(file.path, file.identity);
      });
      return { ...written, sessions: sessionIds.length };
    } finally {
      output.close();
    }
  });
}
function readChild(input: TransferInput, id: string, limit: number): Buffer {
  const header = input.read(CHILD_BYTES);
  const bytes = readLength(header, 37, limit);
  const sha = header.subarray(45).toString('hex');
  requireTransfer(header.equals(childHeader(id, bytes, sha)), 'invalid-conversation');
  const body = input.read(bytes);
  requireTransfer(createHash('sha256').update(body).digest('hex') === sha, 'integrity-failed');
  return body;
}
function writeProjection(
  directory: TransferDirectory,
  name: string,
  chunks: Iterable<Buffer>,
  bytes: number,
  control: OperationControl,
): TransferOutput {
  const output = new TransferOutput(
    directory.file(name),
    name === 'index.json' ? LIMITS.indexBytes : LIMITS.sessionBytes,
    control,
  );
  try {
    for (const chunk of chunks) {
      directory.assertCurrent();
      output.write(chunk);
    }
    const result = output.finish();
    requireTransfer(result.bytes === bytes, 'integrity-failed');
    return output;
  } finally {
    output.close();
  }
}
/** Creates a new private directory; failed outputs remain for the caller's recovery lifecycle. */
export function readConversationMember(options: ReadConversationOptions): {
  bytes: number;
  sha256: string;
  sessions: number;
} {
  return conversationBoundary(() => {
    uuidBytes(options.snapshotId);
    const input = new TransferInput(
      options.inputPath,
      BACKUP_LIMITS.conversations,
      options.control,
    );
    try {
      const header = input.read(HEADER_BYTES);
      requireTransfer(header.subarray(0, 8).equals(MAGIC), 'invalid-conversation');
      requireTransfer(header.readUInt32BE(8) === 1, 'unsupported-version');
      const count = header.readUInt32BE(12);
      requireTransfer(count >= 1 && count <= 51, 'budget-exceeded');
      requireTransfer(
        header.subarray(16).equals(uuidBytes(options.snapshotId)),
        'integrity-failed',
      );
      const index = projectIndex(
        parse(readChild(input, 'index', LIMITS.indexBytes), LIMITS.indexBytes),
      );
      const sessionIds = ids(index.value);
      requireTransfer(count === sessionIds.length + 1, 'invalid-conversation');
      const directory = new TransferDirectory(options.stagingDirectory, true);
      const outputs = [
        writeProjection(
          directory,
          'index.json',
          [Buffer.from(JSON.stringify(index.value))],
          index.compactBytes,
          options.control,
        ),
      ];
      for (const id of sessionIds) {
        const control = perSession(options.control);
        const session = projectSession(
          parse(readChild(input, id, LIMITS.sessionBytes), LIMITS.sessionBytes),
          () => checkTransferControl(control),
        );
        outputs.push(
          writeProjection(
            directory,
            `${id}.json`,
            sessionChunks(session.value),
            session.compactBytes,
            control,
          ),
        );
      }
      directory.assertCurrent();
      const received = input.finish();
      input.close();
      verifyTransferOutputs(outputs, options.control, () => {
        assertFileUnchanged(input.path, input.identity);
        directory.assertCurrent();
      });
      return { ...received, sessions: sessionIds.length };
    } finally {
      input.close();
    }
  });
}
