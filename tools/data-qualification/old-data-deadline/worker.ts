import { createHash } from 'node:crypto';
import { createReadStream, realpathSync } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  LIMITS,
  NODE_VERSION,
  isScene,
  need,
  requireScopeId,
  sceneDirectoryName,
  type Scene,
} from './contract';
import { executeInitialScene, reopenScene, type SceneResult } from './fixture';
import type { RuntimeProof, WorkerTerminal } from './supervisor';

async function hash(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const digest = createHash('sha256');
    const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolvePromise(digest.digest('hex')));
  });
}
async function runtimeProof(): Promise<RuntimeProof> {
  const workerPath = resolve(__filename);
  const value = await lstat(workerPath, { bigint: true });
  need(
    value.isFile() &&
      !value.isSymbolicLink() &&
      value.nlink === 1n &&
      realpathSync.native(workerPath).toLowerCase() === workerPath.toLowerCase(),
  );
  return {
    nodePath: resolve(process.execPath),
    nodeVersion: process.version,
    workerPath,
    workerSha256: await hash(workerPath),
  };
}
async function send(frame: WorkerTerminal | { kind: 'selected'; phase: string }): Promise<void> {
  need(process.send && process.connected);
  need(Buffer.byteLength(JSON.stringify(frame)) <= LIMITS.frameBytes);
  await new Promise<void>((resolvePromise, reject) => {
    process.send?.(frame, (error) => (error ? reject(error) : resolvePromise()));
  });
}
async function main(): Promise<void> {
  const [scopeId, rawScene, action, ...rest] = process.argv.slice(2);
  requireScopeId(scopeId);
  need(
    rest.length === 0 &&
      isScene(rawScene) &&
      (action === 'initial' || action === 'reopen') &&
      process.send &&
      process.platform === 'win32' &&
      process.arch === 'x64' &&
      process.version === NODE_VERSION,
  );
  const repository = resolve(__dirname, '../../..');
  const expectedRoot = join(repository, 'log', 'stage7-e2', scopeId, sceneDirectoryName(rawScene));
  need(action === 'initial' || rawScene !== 'normal');
  let result: SceneResult;
  if (action === 'initial') {
    let waits = 0;
    result = await executeInitialScene(expectedRoot, rawScene, {
      async wait() {
        need(rawScene !== 'normal' && waits++ === 0);
        await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, LIMITS.realDelayMs));
      },
      selected: (phase) => send({ kind: 'selected', phase }),
    });
    need(rawScene === 'normal' ? waits === 0 : waits === 1);
    if (rawScene !== 'normal') need(result.waitedMs >= LIMITS.realDelayMs);
  } else result = await reopenScene(expectedRoot, rawScene as Exclude<Scene, 'normal'>);
  await send({ kind: 'result', result, runtime: await runtimeProof() });
  process.disconnect?.();
}

void main().catch(() => {
  process.exitCode = 2;
  try {
    process.disconnect?.();
  } catch {
    // The parent still requires exit and close and will retain the failed scope.
  }
});
