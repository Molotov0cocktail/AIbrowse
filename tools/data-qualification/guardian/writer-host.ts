import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const filename = fileURLToPath(import.meta.url);

// Isolated qualification host. No production data root or renderer is involved.
if (process.argv[2] === 'leaf') {
  process.on('message', (message) => {
    if (message === 'init') {
      writeFileSync(join(process.argv[3]!, 'authorized-marker'), '已授权');
      process.send?.('initialized');
    }
    if (message === 'stop') process.exit(0);
    if (message === 'stop-delayed') setTimeout(() => process.exit(0), 200);
  });
  setTimeout(() => process.exit(2), 8000);
} else {
  const helper = process.argv[2]!,
    root = process.argv[3]!,
    scenario = process.argv[4]!;
  const nonce = randomBytes(16).toString('hex');
  const errorFile = openSync(join(root, 'guardian-errors.txt'), 'a');
  const guardian = spawn(
    helper,
    [root, String(process.pid), nonce, process.execPath, process.argv[5] ?? ''],
    {
      stdio: ['pipe', 'pipe', errorFile],
      windowsHide: true,
      detached: true,
    },
  );
  closeSync(errorFile);
  let buffer = '',
    sequence = 0;
  let pending: { resolve(): void; reject(error: Error): void; sequence: number } | null = null;
  const command = (body: string) =>
    new Promise<void>((resolve, reject) => {
      if (pending) return reject(new Error('并发资格请求'));
      pending = { resolve, reject, sequence: ++sequence };
      guardian.stdin!.write(`1|${nonce}|${sequence}|${body}\n`);
    });
  guardian.stdout!.on('data', (chunk) => {
    buffer += chunk.toString('ascii');
    if (buffer.length > 4096) process.exit(3);
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const frame = buffer.slice(0, end).split('|');
      buffer = buffer.slice(end + 1);
      if (frame[0] !== '1' || frame[1] !== nonce || frame.length !== 4) process.exit(3);
      if (frame[2] === '0' && frame[3] === 'ready') {
        process.send?.({ type: 'ready', guardianPid: guardian.pid });
        void run().catch(() => process.exit(4));
      } else if (pending && Number(frame[2]) === pending.sequence && frame[3] === 'ok') {
        const current = pending;
        pending = null;
        current.resolve();
      } else process.exit(3);
    }
  });
  guardian.on('exit', (code) => {
    process.send?.({ type: 'guardian-exit', code });
    process.exit(5);
  });
  guardian.on('error', () => process.exit(6));
  async function run() {
    if (scenario === 'idle') return;
    if (scenario === 'eof-unfinished') {
      guardian.stdin!.end();
      setTimeout(() => process.exit(0), 200);
      return;
    }
    if (scenario === 'finish-duplicate' || scenario === 'finish-timeout') {
      await command('finish');
      process.send?.({ type: 'finished' });
      if (scenario === 'finish-duplicate') await command('finish');
      return;
    }
    if (scenario === 'graceful-eof') {
      await command('finish');
      process.send?.({ type: 'finished' });
      guardian.stdin!.end();
      setTimeout(() => process.exit(0), 200);
      return;
    }
    if (scenario === 'relaunch') {
      await command('relaunch');
      await command('finish');
      process.send?.({ type: 'relaunch-ack' });
      return;
    }
    const leaf = spawn(process.execPath, [filename, 'leaf', root], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    });
    if (scenario === 'early-exit') {
      const exited = new Promise((resolve) => leaf.once('exit', resolve));
      leaf.send('stop');
      await exited;
      await command(`authorize|probe|${leaf.pid}`);
      throw new Error('已退出utility不应获得授权');
    }
    if (scenario === 'finish-authorize') await command('finish');
    await command(`authorize|probe|${leaf.pid}`);
    const ledger = JSON.parse(
      readFileSync(join(root, 'lifecycle-guardian', 'writers.json'), 'utf8'),
    );
    if (ledger.utility.pid !== leaf.pid || ledger.main.pid !== process.pid)
      throw new Error('账本未先于授权持久化');
    const initialized = new Promise((resolve) => leaf.once('message', resolve));
    leaf.send('init');
    await initialized;
    process.send?.({ type: 'authorized', leafPid: leaf.pid });
    if (scenario === 'retire-parent-exit') {
      setTimeout(() => process.exit(7), 50);
      await command(`retire|${leaf.pid}`);
      throw new Error('父退出前不应退休仍存活的utility');
    }
    if (scenario === 'retire-eof' || scenario === 'retire-duplicate') {
      leaf.send('stop-delayed');
      const retired = command(`retire|${leaf.pid}`);
      if (scenario === 'retire-eof') guardian.stdin!.end();
      else guardian.stdin!.write(`1|${nonce}|${sequence + 1}|retire|${leaf.pid}\n`);
      await retired;
      return;
    }
    if (scenario === 'early-retire') {
      leaf.send('stop-delayed');
      await command(`retire|${leaf.pid}`);
      const after = JSON.parse(
        readFileSync(join(root, 'lifecycle-guardian', 'writers.json'), 'utf8'),
      );
      if (after.utility !== null) throw new Error('等待实际退出后的记录未退休');
      process.send?.({ type: 'retired' });
      return;
    }
    if (scenario === 'finish-with-utility') await command('finish');
    if (scenario === 'retire') {
      const exited = new Promise((resolve) => leaf.once('exit', resolve));
      leaf.send('stop');
      await exited;
      await command(`retire|${leaf.pid}`);
      const after = JSON.parse(
        readFileSync(join(root, 'lifecycle-guardian', 'writers.json'), 'utf8'),
      );
      if (after.utility !== null) throw new Error('记录未退休');
      process.send?.({ type: 'retired' });
    }
  }
  process.on('message', (message) => {
    if (message === 'exit') process.exit(0);
    if (message === 'crash-guardian') guardian.kill();
  });
  setTimeout(() => process.exit(7), scenario === 'finish-timeout' ? 15_000 : 8000);
}
