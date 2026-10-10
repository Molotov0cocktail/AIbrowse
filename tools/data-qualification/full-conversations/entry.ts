import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PREPARE_MS, prepareFullConversations, requireScope } from './main';

const scope = resolve(__dirname);
requireScope(scope);
const started = performance.now();
let completed = false;
let verifyCompletion: (() => void) | null = null;
try {
  if (process.argv.length !== 3) throw new Error('固定夹具入口参数无效');
  verifyCompletion = prepareFullConversations(scope, process.argv[2]!, () => {
    if (performance.now() - started >= PREPARE_MS) throw new Error('夹具准备期限已到，现场已保留');
  });
  completed = true;
} catch {
  process.exitCode = 2;
} finally {
  // A proof alone never grants success: the outer Job also needs this receipt and actual exit.
  if (performance.now() - started >= PREPARE_MS) {
    completed = false;
    process.exitCode = 2;
  }
  writeFileSync(
    join(scope, 'prepare-result.json'),
    JSON.stringify({
      version: 1,
      completed,
      productE2Pass: false,
      durationMs: performance.now() - started,
      error: completed ? null : '夹具准备失败，现场已保留',
    }),
    { flag: 'wx' },
  );
  try {
    if (completed) verifyCompletion?.();
  } catch {
    completed = false;
    process.exitCode = 2;
  }
  if (performance.now() - started >= PREPARE_MS) {
    completed = false;
    process.exitCode = 2;
  }
  console.log(JSON.stringify({ completed, productE2Pass: false }));
}
