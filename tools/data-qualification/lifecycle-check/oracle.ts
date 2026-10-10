import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createSmallFixture, DOMAINS, id } from '../product-restore-fixtures/seed';
import { readSmallSnapshot } from '../product-restore-fixtures/oracle';
import { verifyRuntimeSnapshot, type RuntimeAudit } from '../restore-check/runtime-oracle';

const scope = __dirname;
const command = process.argv[2];
const profile = join(scope, 'profile');
const clock = JSON.parse(readFileSync(join(scope, 'run-clock.json'), 'utf8')) as {
  startedAt: number;
};
if (
  process.argv.length !== 3 ||
  !['seed', 'exercise', 'main-fault', 'cold'].includes(command ?? '')
)
  throw new Error('固定离线oracle入口无效');
if (command === 'seed') createSmallFixture(profile, 'A');
else {
  const ledger = JSON.parse(
    readFileSync(join(profile, 'lifecycle-guardian/writers.json'), 'utf8'),
  ) as { main: unknown; utility: unknown };
  if (ledger.main !== null || ledger.utility !== null) throw new Error('writer账本未退休');
  const copy = join(scope, `${command}-copy`);
  mkdirSync(copy);
  const files: Record<string, string> = {};
  const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
  for (const domain of [...DOMAINS, 'conversations'] as const) {
    const expected =
      domain === 'conversations' ? ['index.json', `${id('A', 9000)}.json`] : [`${domain}.db`];
    if (readdirSync(join(profile, domain)).sort().join('|') !== expected.sort().join('|'))
      throw new Error('原件集合或sidecar不符');
    mkdirSync(join(copy, domain));
    for (const name of expected) {
      const original = join(profile, domain, name),
        target = join(copy, domain, name);
      const digest = sha(original);
      copyFileSync(original, target, 1);
      if (sha(original) !== digest || sha(target) !== digest) throw new Error('副本或原件摘要改变');
      files[`${domain}/${name}`] = digest;
    }
  }
  const prior = command === 'main-fault' ? 'exercise' : command === 'cold' ? 'main-fault' : null;
  const inherited: RuntimeAudit[] =
    prior === null
      ? []
      : (
          JSON.parse(readFileSync(join(scope, `${prior}-oracle.json`), 'utf8')) as {
            audits: RuntimeAudit[];
          }
        ).audits;
  const count = command === 'exercise' ? 1 : command === 'main-fault' ? 2 : 3;
  const result = verifyRuntimeSnapshot(
    readSmallSnapshot(copy, 'A').snapshot,
    'A',
    'source',
    count,
    clock.startedAt,
    Date.now(),
    inherited,
  );
  const output = join(scope, `${command}-oracle.json`);
  if (existsSync(output)) throw new Error('禁止覆盖离线原件');
  writeFileSync(output, JSON.stringify({ ...result, files }), { flag: 'wx' });
}
