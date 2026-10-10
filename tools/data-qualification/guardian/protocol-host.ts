import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const pause = () => new Promise<void>((done) => setTimeout(done, 5));
function need(value: unknown): asserts value {
  if (!value) throw new Error('协议资格检查失败');
}
function save(path: string, value: string | Buffer) {
  need(!existsSync(path));
  const temporary = `${path}.publishing`;
  const handle = openSync(temporary, 'wx');
  try {
    writeFileSync(handle, value);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, path);
}

if (process.argv[2] === 'leaf') {
  const root = process.argv[3]!;
  need(realpathSync.native(root).toLowerCase() === resolve(root).toLowerCase());
  process.on('message', (message) => {
    if (message === 'init') {
      save(join(root, 'authorized-marker'), '已授权');
      process.send?.('initialized');
    } else if (message === 'stop') process.exit(0);
    else process.exit(3);
  });
  process.send?.('waiting');
  setTimeout(() => process.exit(2), 12_000);
} else {
  const [helper, dataRoot, evidenceRoot, mode, nonce] = process.argv.slice(2);
  need(helper && dataRoot && evidenceRoot && mode && nonce);
  need(['healthy', 'successor', 'receipt-empty-ads', 'tmp-collision'].includes(mode));
  need(/^[a-f0-9]{32}$/u.test(nonce));
  for (const path of [helper, dataRoot, evidenceRoot])
    need(realpathSync.native(path).toLowerCase() === resolve(path).toLowerCase());
  const started = performance.now();
  const timer = setTimeout(() => process.exit(7), 14_000);
  const deadline = () => need(performance.now() - started < 14_000);
  async function observed(role: string, pid: number) {
    save(join(evidenceRoot!, `observe-${role}.txt`), `${pid}\n`);
    const path = join(evidenceRoot!, `observed-${role}.txt`);
    while (!existsSync(path)) {
      deadline();
      await pause();
    }
    const text = readFileSync(path, 'ascii');
    const match = /^([1-9][0-9]{0,9})\|([1-9][0-9]{0,18})\n$/u.exec(text);
    need(match && match[1] === String(pid));
    return match[2]!;
  }
  const stdout = openSync(join(evidenceRoot, 'guardian-stdout.txt'), 'wx');
  const stderr = openSync(join(evidenceRoot, 'guardian-stderr.txt'), 'wx');
  const guardian = spawn(helper, [dataRoot, String(process.pid), nonce, process.execPath, ''], {
    detached: true,
    windowsHide: true,
    stdio: ['pipe', stdout, stderr],
  });
  closeSync(stdout);
  closeSync(stderr);
  guardian.on('error', () => process.exit(6));
  guardian.on('exit', () => process.exit(5));
  let expectedSequence = 0;
  async function frame(sequence: number, code: string) {
    need(sequence === expectedSequence++);
    for (;;) {
      deadline();
      const raw = readFileSync(join(evidenceRoot!, 'guardian-stdout.txt'), 'ascii');
      need(Buffer.byteLength(raw) <= 4096);
      const complete = raw
        .slice(0, raw.lastIndexOf('\n') + 1)
        .split('\n')
        .slice(0, -1);
      for (let i = 0; i < complete.length; i++) {
        const expected = `1|${nonce}|${i}|${i === 0 ? 'ready' : 'ok'}`;
        need(complete[i] === expected);
      }
      if (complete.length > sequence) {
        need(complete[sequence] === `1|${nonce}|${sequence}|${code}`);
        return;
      }
      await pause();
    }
  }
  async function command(sequence: number, body: string) {
    guardian.stdin!.write(`1|${nonce}|${sequence}|${body}\n`);
    await frame(sequence, 'ok');
  }
  async function run() {
    need(guardian.pid);
    await observed('guardian', guardian.pid);
    await frame(0, 'ready');
    const ledgerPath = join(dataRoot!, 'lifecycle-guardian', 'writers.json');
    save(join(evidenceRoot!, 'observe-ledger.txt'), '1\n');
    while (!existsSync(join(evidenceRoot!, 'observed-ledger.json'))) {
      deadline();
      await pause();
    }
    const before = readFileSync(ledgerPath);
    need(before.length <= 4096);
    const fact = JSON.parse(readFileSync(join(evidenceRoot!, 'observed-ledger.json'), 'utf8')) as {
      hash: string;
    };
    need(fact.hash === createHash('sha256').update(before).digest('hex'));
    save(join(evidenceRoot!, 'before-ledger.json'), before);
    if (mode === 'successor') {
      await command(1, 'finish');
      save(join(evidenceRoot!, 'host-complete.json'), '{"mode":"successor","passed":true}');
      guardian.stdin!.end();
      clearTimeout(timer);
      process.exit(0);
    }
    if (mode === 'receipt-empty-ads') {
      const handle = openSync(`${ledgerPath}:qualification-empty`, 'wx');
      try {
        need(fstatSync(handle).size === 0);
        fsyncSync(handle);
      } finally {
        closeSync(handle);
      }
    } else if (mode === 'tmp-collision') save(`${ledgerPath}.tmp`, '');
    const leaf = spawn(process.execPath, [script, 'leaf', dataRoot!], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    const messages: unknown[] = [];
    leaf.on('message', (message) => messages.push(message));
    const leafExit = new Promise<number | null>((done) => leaf.once('exit', done));
    leaf.on('error', () => process.exit(6));
    need(leaf.pid);
    const leafCreated = await observed('utility', leaf.pid);
    while (!messages.includes('waiting')) {
      deadline();
      await pause();
    }
    save(join(evidenceRoot!, 'armed.json'), JSON.stringify({ mode, utility: leaf.pid }));
    await command(1, `authorize|probe|${leaf.pid}`);
    const authorized = JSON.parse(readFileSync(ledgerPath, 'utf8')) as {
      main: { pid: number };
      utility: { pid: number; created: string };
    };
    need(authorized.main.pid === process.pid);
    need(authorized.utility.pid === leaf.pid && authorized.utility.created === leafCreated);
    leaf.send('init');
    while (!messages.includes('initialized')) {
      deadline();
      await pause();
    }
    need(mode === 'healthy');
    leaf.send('stop');
    need((await leafExit) === 0);
    await command(2, `retire|${leaf.pid}`);
    const retired = JSON.parse(readFileSync(ledgerPath, 'utf8')) as { utility: unknown };
    need(retired.utility === null);
    await command(3, 'finish');
    save(join(evidenceRoot!, 'host-complete.json'), '{"mode":"healthy","passed":true}');
    guardian.stdin!.end();
    clearTimeout(timer);
    process.exit(0);
  }
  void run().catch(() => process.exit(4));
}
