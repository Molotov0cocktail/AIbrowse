import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BACKUP_FILES,
  BACKUP_IDS,
  readBackupContainer,
  writeBackupContainer,
  type WriteBackupOptions,
} from '../../src/main/storage/backup-container';
import {
  readConversationMember,
  writeConversationMember,
} from '../../src/main/storage/conversation-member';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
afterEach(() => vi.restoreAllMocks());
const root = join(process.cwd(), 'log/stage7-e2/independent-container-review-001');
fs.mkdirSync(root, { recursive: true });
const snapshotId = '11111111-1111-4111-8111-111111111111';
const control = () => ({
  signal: new AbortController().signal,
  deadline: performance.now() + 5000,
});

it.each(['container-write', 'container-read', 'conversation-write', 'conversation-read'] as const)(
  '%s最终整组输出读回期间原件变化不能遗漏最终复核',
  (kind) => {
    const folder = fs.mkdtempSync(join(root, 'completion-'));
    const source = join(folder, 'source');
    fs.mkdirSync(source);
    const packed = join(folder, 'packed.bin');
    const staging = join(folder, 'staging');
    const files = {} as WriteBackupOptions['files'];
    for (const id of BACKUP_IDS) {
      const path = join(source, BACKUP_FILES[id]);
      fs.writeFileSync(path, `合成${id}`);
      files[id] = { path, snapshotId, schemaVersion: id === 'watch' ? 5 : 1 };
    }
    const conversation = join(folder, 'conversation');
    fs.mkdirSync(conversation);
    const indexPath = join(conversation, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({ version: 1, sessions: [] }));
    const containerOptions = {
      snapshotDirectory: source,
      outputPath: packed,
      snapshotId,
      files,
      productVersion: '0.1.0',
      control: control(),
    };
    const conversationOptions = {
      sourceDirectory: conversation,
      outputPath: packed,
      snapshotId,
      control: control(),
    };
    if (kind === 'container-read') writeBackupContainer(containerOptions);
    if (kind === 'conversation-read') writeConversationMember(conversationOptions);
    const originalPath = kind.endsWith('read')
      ? packed
      : kind === 'container-write'
        ? files.watch!.path
        : indexPath;
    const trigger = kind.endsWith('write')
      ? packed
      : join(staging, kind === 'container-read' ? BACKUP_FILES.sources : 'index.json');
    const before = fs.readFileSync(originalPath);
    const originalOpen = fs.openSync;
    let readbackOpens = 0;
    let changed = false;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (args[0] === trigger && args[1] !== 'wx' && ++readbackOpens === 2) {
        fs.appendFileSync(originalPath, '受控原件变化');
        changed = true;
      }
      return fd;
    });
    let error: unknown;
    try {
      if (kind === 'container-write') writeBackupContainer(containerOptions);
      else if (kind === 'container-read')
        readBackupContainer({ inputPath: packed, stagingDirectory: staging, control: control() });
      else if (kind === 'conversation-write') writeConversationMember(conversationOptions);
      else
        readConversationMember({
          inputPath: packed,
          stagingDirectory: staging,
          snapshotId,
          control: control(),
        });
    } catch (caught) {
      error = caught;
    }
    expect(changed).toBe(true);
    expect(fs.readFileSync(originalPath).subarray(0, before.length)).toEqual(before);
    expect(error).toBeInstanceOf(Error);
  },
);
