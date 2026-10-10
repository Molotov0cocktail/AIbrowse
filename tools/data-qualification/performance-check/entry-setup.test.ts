import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('DPAPI夹具在凭据与配置完成后经Electron正常退出持久化profile状态', () => {
  const source = readFileSync(join(import.meta.dirname, 'entry.ts'), 'utf8');
  const begin = source.indexOf('if (setupMode) {', source.indexOf('async function bootstrap'));
  const end = source.indexOf('createRequire(__filename)', begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  const setup = source.slice(begin, end);
  const stages = [
    'await app.whenReady()',
    "await credentials.set('openai-compatible'",
    'config.commitAuthorized(',
    "writeNew('fixture-port.json'",
    'server.close(() => resolve())',
    'app.quit()',
  ];
  let prior = -1;
  for (const stage of stages) {
    const current = setup.indexOf(stage);
    expect(current, stage).toBeGreaterThan(prior);
    prior = current;
  }
  expect(setup).not.toContain('app.exit(0)');
});
