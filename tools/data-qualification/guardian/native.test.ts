import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rename, link, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

const helper = resolve('out/lifecycle-guardian/guardian.exe');
const script = resolve('tools/data-qualification/guardian/writer-host.ts');
async function root() {
  return mkdtemp(resolve('log/stage7-e2/guardian-native-'));
}
function host(directory: string, scenario: string, appRoot = '') {
  const child = spawn(process.execPath, [script, helper, directory, scenario, appRoot], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const received: Array<Record<string, unknown>> = [];
  child.on('message', (value) => {
    if (typeof value === 'object' && value !== null)
      received.push(value as Record<string, unknown>);
  });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  async function message(type: string) {
    const deadline = performance.now() + 2500;
    while (performance.now() < deadline) {
      const value = received.find((item) => item.type === type);
      if (value) return value;
      if (child.exitCode !== null) throw new Error(`资格host提前退出：${child.exitCode}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`资格等待超时：${type}`);
  }
  return { child, exited, message };
}
async function cleanup(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const ended = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill();
  await Promise.race([
    ended,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('自有host实际退出未知')), 2500),
    ),
  ]);
}
it('finish确认后EOF不抢杀仍在正常退出的main，精确退出后才退休', async () => {
  const directory = await root();
  const current = host(directory, 'graceful-eof');
  try {
    expect(await current.exited).toBe(0);
    const deadline = performance.now() + 2500;
    while (
      JSON.parse(await readFile(join(directory, 'lifecycle-guardian', 'writers.json'), 'utf8'))
        .main !== null
    ) {
      if (performance.now() >= deadline) throw new Error('finish后精确退出凭据超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally {
    await cleanup(current.child);
  }
}, 10_000);
it('retire通知早于Windows实际退出时等待同一handle，不能立即误杀main', async () => {
  const directory = await root();
  const current = host(directory, 'early-retire');
  try {
    await current.message('retired');
    expect(
      JSON.parse(await readFile(join(directory, 'lifecycle-guardian', 'writers.json'), 'utf8'))
        .utility,
    ).toBeNull();
    current.child.send('exit');
    await current.exited;
  } finally {
    await cleanup(current.child);
  }
}, 10_000);
it.each(['retire-parent-exit', 'retire-eof', 'retire-duplicate'])(
  'retire等待期间%s不能跳过精确退出或重新领期限',
  async (scenario) => {
    const directory = await root();
    const current = host(directory, scenario);
    try {
      expect(await current.exited).toBe(scenario === 'retire-parent-exit' ? 7 : 91);
      const deadline = performance.now() + 2500;
      while (
        JSON.parse(await readFile(join(directory, 'lifecycle-guardian', 'writers.json'), 'utf8'))
          .main !== null
      ) {
        if (performance.now() >= deadline) throw new Error('retire失败后实际退出凭据超时');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      await cleanup(current.child);
    }
  },
  10_000,
);
it.each(['eof-unfinished', 'finish-duplicate', 'finish-authorize', 'finish-with-utility'])(
  '非法正常关闭%s仍安全强停，不取得finish豁免',
  async (scenario) => {
    const directory = await root();
    const current = host(directory, scenario);
    try {
      expect(await current.exited).toBe(91);
    } finally {
      await cleanup(current.child);
    }
  },
  10_000,
);
it('finish之后没有EOF或main实际退出，也不能超过原10s期限继续运行', async () => {
  const directory = await root();
  const current = host(directory, 'finish-timeout');
  try {
    await current.message('finished');
    const started = performance.now();
    expect(await current.exited).toBe(91);
    expect(performance.now() - started).toBeLessThan(11_000);
  } finally {
    await cleanup(current.child);
  }
}, 13_000);
it('原生登记先于授权，实际退出后才退休；父退出后下代可准入', async () => {
  const directory = await root();
  const first = host(directory, 'retire');
  try {
    await first.message('retired');
    expect(await readFile(join(directory, 'authorized-marker'), 'utf8')).toBe('已授权');
    first.child.send('exit');
    await first.exited;
    // The native owner clears its receipt only after actual Job zero.
    const deadline = performance.now() + 2500;
    while (
      JSON.parse(await readFile(join(directory, 'lifecycle-guardian', 'writers.json'), 'utf8'))
        .main !== null
    ) {
      if (performance.now() >= deadline) throw new Error('Job归零凭据超时');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const next = host(directory, 'idle');
    try {
      await next.message('ready');
      next.child.send('exit');
      await next.exited;
    } finally {
      await cleanup(next.child);
    }
  } finally {
    await cleanup(first.child);
  }
}, 10_000);
it('guardian硬退出后保留writer记录，新guardian验证旧精确实例退出', async () => {
  const directory = await root();
  const first = host(directory, 'hold');
  try {
    await first.message('authorized');
    const before = await readFile(join(directory, 'lifecycle-guardian', 'writers.json'), 'utf8');
    first.child.send('crash-guardian');
    await first.exited;
    expect(await readFile(join(directory, 'lifecycle-guardian', 'writers.json'), 'utf8')).toBe(
      before,
    );
    const next = host(directory, 'idle');
    try {
      await next.message('ready');
      next.child.send('exit');
      await next.exited;
    } finally {
      await cleanup(next.child);
    }
  } finally {
    await cleanup(first.child);
  }
}, 10_000);
it('畸形既有账本不被覆盖且main未获准入', async () => {
  const directory = await root();
  const ledger = join(directory, 'lifecycle-guardian');
  await mkdir(ledger);
  await writeFile(join(ledger, 'owner.lock'), '');
  await writeFile(join(ledger, 'writers.json'), 'unknown');
  const child = host(directory, 'idle');
  try {
    await child.exited;
    expect(await readFile(join(ledger, 'writers.json'), 'utf8')).toBe('unknown');
  } finally {
    await cleanup(child.child);
  }
}, 10_000);
it.each(['missing', 'temporary', 'duplicate'])(
  '既有%s账本保留且不得获得ready',
  async (kind) => {
    const directory = await root();
    const ledger = join(directory, 'lifecycle-guardian');
    await mkdir(ledger);
    await writeFile(join(ledger, 'owner.lock'), '');
    const bytes = kind === 'duplicate' ? '{"version":1,"version":1}' : 'unknown';
    const path = join(ledger, kind === 'temporary' ? 'writers.json.tmp' : 'writers.json');
    if (kind !== 'missing') await writeFile(path, bytes);
    const current = host(directory, 'idle');
    try {
      expect(await current.exited).toBe(5);
      if (kind !== 'missing') expect(await readFile(path, 'utf8')).toBe(bytes);
    } finally {
      await cleanup(current.child);
    }
  },
  10_000,
);
it('旧guardian持锁时新请求关闭，不能覆盖正在授权的main记录', async () => {
  const directory = await root();
  const first = host(directory, 'idle');
  try {
    await first.message('ready');
    const before = await readFile(join(directory, 'lifecycle-guardian', 'writers.json'));
    const second = host(directory, 'idle');
    try {
      expect(await second.exited).toBe(5);
    } finally {
      await cleanup(second.child);
    }
    expect(await readFile(join(directory, 'lifecycle-guardian', 'writers.json'))).toEqual(before);
    expect(first.child.exitCode).toBeNull();
    first.child.send('exit');
    await first.exited;
  } finally {
    await cleanup(first.child);
  }
}, 10_000);
it('固定重启只在旧main退出与账本退休后从Job外启动', async () => {
  const directory = await root();
  const appRoot = join(directory, 'app');
  await mkdir(appRoot);
  await writeFile(join(appRoot, 'package.json'), '{"main":"index.cjs"}');
  await writeFile(
    join(appRoot, 'index.cjs'),
    "const fs=require('node:fs'),p=require('node:path');const r=p.dirname(__dirname);const x=JSON.parse(fs.readFileSync(p.join(r,'lifecycle-guardian','writers.json'),'utf8'));if(x.main!==null||x.utility!==null)process.exit(3);fs.writeFileSync(p.join(r,'relaunched'),'已退休');",
  );
  const first = host(directory, 'relaunch', appRoot);
  try {
    await first.message('relaunch-ack');
    await expect(readFile(join(directory, 'relaunched'))).rejects.toMatchObject({ code: 'ENOENT' });
    first.child.send('exit');
    await first.exited;
    const deadline = performance.now() + 2500;
    for (;;) {
      try {
        expect(await readFile(join(directory, 'relaunched'), 'utf8')).toBe('已退休');
        break;
      } catch (error) {
        if (performance.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  } finally {
    await cleanup(first.child);
  }
}, 10_000);
it('登记时utility已经退出，原生拒绝并终止已受管main，不产生数据IO', async () => {
  const directory = await root();
  const current = host(directory, 'early-exit');
  try {
    await current.message('ready');
    expect(await current.exited).not.toBe(0);
    await expect(readFile(join(directory, 'authorized-marker'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await cleanup(current.child);
  }
}, 10_000);
it.for(['symlink', 'hardlink', 'junction'])(
  '有效旧账本换成%s也不得恢复准入或改变目标原件',
  { timeout: 10_000 },
  async (kind, context) => {
    const directory = await root();
    const first = host(directory, 'idle');
    try {
      await first.message('ready');
      first.child.send('exit');
      await first.exited;
      const final = join(directory, 'lifecycle-guardian', 'writers.json');
      const deadline = performance.now() + 2500;
      for (;;) {
        try {
          if (JSON.parse(await readFile(final, 'utf8')).main !== null) throw new Error('尚未退休');
          await readFile(join(directory, 'lifecycle-guardian', 'owner.lock'));
          break;
        } catch (error) {
          if (performance.now() >= deadline) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const retained =
        kind === 'junction' ? join(directory, 'retained-ledger') : final + '.retained';
      await rename(kind === 'junction' ? join(directory, 'lifecycle-guardian') : final, retained);
      const retainedFile = kind === 'junction' ? join(retained, 'writers.json') : retained;
      const before = await readFile(retainedFile);
      if (kind === 'symlink') {
        try {
          await symlink(retained, final, 'file');
        } catch (error) {
          if (
            process.platform === 'win32' &&
            error instanceof Error &&
            'code' in error &&
            error.code === 'EPERM'
          )
            context.skip('本机没有创建文件符号链接权限；原失败保留，不授此类型实测通过');
          throw error;
        }
      } else if (kind === 'junction')
        await symlink(retained, join(directory, 'lifecycle-guardian'), 'junction');
      else await link(retained, final);
      const next = host(directory, 'idle');
      try {
        expect(await next.exited).toBe(5);
      } finally {
        await cleanup(next.child);
      }
      expect(await readFile(retainedFile)).toEqual(before);
    } finally {
      await cleanup(first.child);
    }
  },
);
