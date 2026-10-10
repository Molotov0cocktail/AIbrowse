import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isCheckpoint, type ReplacementCheckpoint } from './contracts';
import { reopenFixture, runWriter } from './fixture';
import { BoundaryChannel } from './boundary-channel';

type HookGlobal = typeof globalThis & {
  __aibrowseReplacementCrashBoundary?: (point: ReplacementCheckpoint) => Promise<void>;
};

const [rootArgument, mode, ...rest] = process.argv.slice(2);
const scopeArgument = process.env.AIBROWSE_REPLACEMENT_CRASH_SCOPE;
if (
  rest.length !== 0 ||
  !rootArgument ||
  !scopeArgument ||
  !isAbsolute(rootArgument) ||
  !isAbsolute(scopeArgument) ||
  (mode !== 'write' && mode !== 'reopen') ||
  !process.send
)
  throw new Error('replacement crash资格参数无效');

const root = resolve(rootArgument);
const scope = resolve(scopeArgument);
const child = relative(scope, root);
const registeredScope = relative(resolve(process.cwd(), 'log', 'stage7-e2'), scope).replaceAll(
  '\\',
  '/',
);
const scopeStat = lstatSync(scope);
if (
  child.includes(sep) ||
  !/^(?:control|case-[0-9]{2})$/u.test(child) ||
  !/^replacement-crash-[a-f0-9]{32}$/u.test(registeredScope) ||
  (process.platform === 'win32'
    ? realpathSync.native(scope).toLowerCase() !== scope.toLowerCase()
    : realpathSync.native(scope) !== scope) ||
  scopeStat.isSymbolicLink() ||
  !scopeStat.isDirectory()
)
  throw new Error('replacement crash资格根越界');

const channel = new BoundaryChannel();
process.on('message', (message: unknown) => {
  channel.accept(message);
});

async function send(frame: object): Promise<void> {
  await new Promise<void>((resolveSend, reject) => {
    process.send?.(frame, (error) => (error ? reject(error) : resolveSend()));
  });
}

async function boundary(point: ReplacementCheckpoint): Promise<void> {
  if (!isCheckpoint(point)) throw new Error('边界协议状态非法');
  await channel.pause(() => send({ kind: 'boundary', point }));
}

async function main(): Promise<void> {
  const global = globalThis as HookGlobal;
  if (global.__aibrowseReplacementCrashBoundary) throw new Error('active插桩hook已占用');
  if (mode === 'write') {
    await runWriter(root, boundary);
    await send({ kind: 'result', state: 'normal' });
  } else {
    global.__aibrowseReplacementCrashBoundary = boundary;
    try {
      const state = await reopenFixture(root);
      await send({ kind: 'result', state });
    } finally {
      delete global.__aibrowseReplacementCrashBoundary;
    }
  }
  process.disconnect();
}

void main().catch(async () => {
  process.exitCode = 1;
  try {
    await send({ kind: 'result', state: 'worker-failed' });
    process.disconnect();
  } catch {
    // The parent owns failure classification and process retirement.
  }
});
