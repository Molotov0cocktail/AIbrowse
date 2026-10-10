import { DatabaseSync } from 'node:sqlite';
import { FIXTURE_DIGEST, MODES, type Mode, type MessageKind } from './protocol';

const mode = process.argv[2] as Mode;
const id = Number(process.argv[3]);
if (!MODES.includes(mode) || !Number.isSafeInteger(id) || id < 1 || id > 7 || !process.parentPort) {
  process.exit(2);
}
const port = process.parentPort;
setInterval(() => {}, 1000);
let heartbeatCount = 0;
const send = (kind: MessageKind, count = 0) =>
  port.postMessage(JSON.stringify({ id, kind, count, digest: FIXTURE_DIGEST }));
send('ready');
port.once('message', (event: { data: unknown }) => {
  if (event.data !== 'start') process.exit(3);
  if (mode === 'malformed') {
    port.postMessage('x'.repeat(257));
    return;
  }
  if (mode === 'flood') {
    for (let index = 0; index < 64; index++) send('heartbeat', index);
    return;
  }
  if (mode === 'late') {
    send('entered');
    setTimeout(() => send('validated', 1), 75);
    return;
  }
  const db = new DatabaseSync(':memory:', {
    enableForeignKeyConstraints: true,
    allowExtension: false,
  });
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-256;');
  if (mode === 'control') {
    const heartbeat = setInterval(() => send('heartbeat', ++heartbeatCount), 50);
    setTimeout(() => {
      clearInterval(heartbeat);
      const value = db.prepare('SELECT 1 AS value').get();
      if (value?.value !== 1) process.exit(4);
      db.close();
      send('validated', 1);
      setTimeout(() => process.exit(0), 50);
    }, 400);
    return;
  }
  // This fixed synchronous native query has constant-memory recursive state.
  // The parent observes an entered marker and absent completion/JS heartbeat.
  setInterval(() => send('heartbeat', ++heartbeatCount), 50);
  setTimeout(() => {
    send('entered');
    db.prepare(
      'WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<1000000000000) SELECT sum(x) FROM n',
    ).get();
    db.close();
    send('validated', 1);
  }, 25);
});
