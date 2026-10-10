import * as fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BACKUP_FILES,
  BACKUP_IDS,
  parseBackupManifest,
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
const id = '22222222-2222-4222-8222-222222222222';
const control = () => ({
  signal: new AbortController().signal,
  deadline: performance.now() + 5000,
});
function container() {
  const folder = fs.mkdtempSync(join(root, 'container-'));
  const source = join(folder, 'source');
  fs.mkdirSync(source);
  const files = {} as WriteBackupOptions['files'];
  for (const name of BACKUP_IDS) {
    const path = join(source, BACKUP_FILES[name]);
    fs.writeFileSync(path, `合成-${name}`);
    files[name] = { path, snapshotId, schemaVersion: name === 'watch' ? 5 : 1 };
  }
  return {
    folder,
    options: {
      snapshotDirectory: source,
      files,
      outputPath: join(folder, 'backup.aib'),
      snapshotId,
      productVersion: '0.1.0',
      control: control(),
    },
  };
}
it('较早完成的容器暂存成员在后续写入前被替换时不能确认完整输出', () => {
  const input = container();
  writeBackupContainer(input.options);
  const staging = join(input.folder, 'staging');
  const first = join(staging, BACKUP_FILES.sources);
  const originalOpen = fs.openSync;
  let replaced = false;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === join(staging, BACKUP_FILES.research) && args[1] === 'wx') {
      fs.renameSync(first, join(staging, 'owned-source-preserved.db'));
      fs.writeFileSync(first, '异身份合成哨兵');
      replaced = true;
    }
    return originalOpen(...args);
  });
  expect(() =>
    readBackupContainer({
      inputPath: input.options.outputPath,
      stagingDirectory: staging,
      control: control(),
    }),
  ).toThrow();
  expect(replaced).toBe(true);
  expect(fs.readFileSync(first, 'utf8')).toBe('异身份合成哨兵');
});

it('Conversation已写index在后续会话输出时替换不得作为正确投影返回', () => {
  const folder = fs.mkdtempSync(join(root, 'conversation-'));
  const source = join(folder, 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(
    join(source, 'index.json'),
    JSON.stringify({
      version: 1,
      sessions: [{ id, title: '合成', createdAt: 1, updatedAt: 2, ephemeral: false }],
    }),
  );
  const inputPath = join(folder, 'member.bin');
  writeConversationMember({
    sourceDirectory: source,
    outputPath: inputPath,
    snapshotId,
    control: control(),
  });
  const staging = join(folder, 'staging');
  const indexPath = join(staging, 'index.json');
  const originalOpen = fs.openSync;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    if (args[0] === join(staging, `${id}.json`) && args[1] === 'wx') {
      fs.renameSync(indexPath, join(staging, 'owned-index-preserved.json'));
      fs.writeFileSync(indexPath, '异身份合成哨兵');
    }
    return originalOpen(...args);
  });
  expect(() =>
    readConversationMember({
      inputPath,
      stagingDirectory: staging,
      snapshotId,
      control: control(),
    }),
  ).toThrow();
  expect(fs.readFileSync(indexPath, 'utf8')).toBe('异身份合成哨兵');
});

it('输出已读回后的最终原件复核期间取消不能返回完成', () => {
  const input = container();
  const abort = new AbortController();
  input.options.control = { signal: abort.signal, deadline: performance.now() + 5000 };
  const originalRead = fs.readSync;
  const originalLstat = fs.lstatSync;
  const originalOpen = fs.openSync;
  let outputReadFd: number | null = null;
  let outputReadbackEnded = false;
  vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpen(...args);
    if (args[0] === input.options.outputPath && args[1] !== 'wx') outputReadFd = fd;
    return fd;
  });
  vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
    const count = originalRead(...args);
    if (args[0] === outputReadFd && count === 0) outputReadbackEnded = true;
    return count;
  });
  vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
    const stat = originalLstat(...args);
    if (outputReadbackEnded && args[0] === input.options.files.conversations!.path) abort.abort();
    return stat;
  });
  expect(() => writeBackupContainer(input.options)).toThrow();
  expect(abort.signal.aborted).toBe(true);
  expect(fs.existsSync(input.options.outputPath)).toBe(true);
});

it('manifest产品版本只接受闭合可打印字符，末尾换行不应被美元锚点放行', () => {
  const input = container();
  const manifest = writeBackupContainer(input.options).manifest;
  manifest.productVersion = '0.1.0\n';
  expect(() => parseBackupManifest(Buffer.from(JSON.stringify(manifest)))).toThrow();
});

it.each(['container', 'conversation'] as const)(
  '%s写入输出完成后不能在最终原件检查时认领异身份替代物',
  (kind) => {
    const input = container();
    const source = join(input.folder, 'conversation-source');
    fs.mkdirSync(source);
    const indexPath = join(source, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({ version: 1, sessions: [] }));
    const outputPath = input.options.outputPath;
    const originalRead = fs.readSync;
    const originalLstat = fs.lstatSync;
    const originalOpen = fs.openSync;
    let readFd: number | null = null;
    let readbackEnded = false;
    let replaced = false;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (args[0] === outputPath && args[1] !== 'wx') readFd = fd;
      return fd;
    });
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args);
      if (args[0] === readFd && count === 0) readbackEnded = true;
      return count;
    });
    const trigger = kind === 'container' ? input.options.files.conversations!.path : indexPath;
    vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = originalLstat(...args);
      if (readbackEnded && !replaced && args[0] === trigger) {
        fs.renameSync(outputPath, join(input.folder, 'owned-output-preserved.bin'));
        fs.writeFileSync(outputPath, '异身份合成哨兵');
        replaced = true;
      }
      return stat;
    });
    let error: unknown;
    try {
      if (kind === 'container') writeBackupContainer(input.options);
      else
        writeConversationMember({
          sourceDirectory: source,
          outputPath,
          snapshotId,
          control: control(),
        });
    } catch (caught) {
      error = caught;
    }
    expect(replaced).toBe(true);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('异身份合成哨兵');
    expect(error).toBeInstanceOf(Error);
  },
);

it.each(['cancel', 'deadline'] as const)(
  'Conversation最终原件复核期间发生%s不能返回成功',
  (kind) => {
    const folder = fs.mkdtempSync(join(root, 'final-control-'));
    const source = join(folder, 'source');
    fs.mkdirSync(source);
    const indexPath = join(source, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify({ version: 1, sessions: [] }));
    const outputPath = join(folder, 'member.bin');
    const controller = new AbortController();
    const operationControl = { signal: controller.signal, deadline: performance.now() + 5000 };
    const originalRead = fs.readSync;
    const originalLstat = fs.lstatSync;
    const originalOpen = fs.openSync;
    let readFd: number | null = null;
    let readbackEnded = false;
    let changed = false;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (args[0] === outputPath && args[1] !== 'wx') readFd = fd;
      return fd;
    });
    vi.spyOn(fs, 'readSync').mockImplementation((...args: Parameters<typeof fs.readSync>) => {
      const count = originalRead(...args);
      if (args[0] === readFd && count === 0) readbackEnded = true;
      return count;
    });
    vi.spyOn(fs, 'lstatSync').mockImplementation((...args: Parameters<typeof fs.lstatSync>) => {
      const stat = originalLstat(...args);
      if (readbackEnded && args[0] === indexPath) {
        if (kind === 'cancel') controller.abort();
        else vi.spyOn(performance, 'now').mockReturnValue(operationControl.deadline + 1);
        changed = true;
      }
      return stat;
    });
    let error: unknown;
    try {
      writeConversationMember({
        sourceDirectory: source,
        outputPath,
        snapshotId,
        control: operationControl,
      });
    } catch (caught) {
      error = caught;
    }
    expect(changed).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(error).toBeInstanceOf(Error);
  },
);
