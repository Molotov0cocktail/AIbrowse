import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileFact, same } from './io';
import { need } from './contract';
import { parseCounts, type Counts } from './counts';

const QUERIES = [
  ['sources.db', [['sources', 'SELECT count(*) AS n FROM sources']]],
  ['research.db', [['research', 'SELECT count(*) AS n FROM research_tasks']]],
  [
    'watch.db',
    [
      ['rules', 'SELECT count(*) AS n FROM watch_rules'],
      ['events', 'SELECT count(*) AS n FROM watch_events'],
      ['evidence', 'SELECT count(*) AS n FROM watch_event_items'],
      ['digests', 'SELECT count(*) AS n FROM watch_digests'],
    ],
  ],
] as const;
export function readCounts(work: string, check: () => void): Counts {
  const counts: Record<string, number> = {};
  const originals = QUERIES.map(([name]) => ({
    path: join(work, name),
    fact: fileFact(join(work, name)),
  }));
  for (const [name, statements] of QUERIES) {
    check();
    const db = new DatabaseSync(join(work, name), {
      readOnly: true,
      allowExtension: false,
      defensive: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      timeout: 0,
    });
    try {
      db.exec(
        'PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-8192;',
      );
      need(
        db.prepare('PRAGMA trusted_schema').get()?.trusted_schema === 0 &&
          db.prepare('PRAGMA query_only').get()?.query_only === 1,
      );
      for (const [key, query] of statements) {
        check();
        const value = db.prepare(query).get()?.n;
        check();
        need(typeof value === 'number' && Number.isSafeInteger(value));
        counts[key] = value;
      }
    } finally {
      db.close();
      check();
    }
  }
  for (const original of originals) {
    check();
    need(same(original.fact, fileFact(original.path)));
  }
  return parseCounts(counts);
}
export function createCountsController(
  operationId: string,
  options: {
    work(check: () => void): Promise<Counts>;
    send(value: string): void;
    exit(code: number): void;
    now?: () => number;
  },
): { receive(raw: unknown): void } {
  const now = options.now ?? (() => performance.now()),
    initDeadline = now() + 10000;
  let initialized = false,
    stopped = false;
  const stop = () => {
    if (!stopped) {
      stopped = true;
      clearTimeout(timer);
      options.exit(2);
    }
  };
  const timer = setTimeout(stop, 10000);
  timer.unref();
  return {
    receive(raw) {
      if (stopped) return;
      try {
        need(
          !initialized &&
            now() < initDeadline &&
            typeof raw === 'string' &&
            Buffer.byteLength(raw) <= 1024,
        );
        const frame = JSON.parse(raw) as {
          version: unknown;
          operationId: unknown;
          remainingMs: unknown;
        };
        need(
          frame &&
            typeof frame === 'object' &&
            Object.keys(frame).sort().join('|') === 'operationId|remainingMs|version' &&
            frame.version === 1 &&
            frame.operationId === operationId &&
            typeof frame.remainingMs === 'number' &&
            Number.isFinite(frame.remainingMs) &&
            frame.remainingMs > 0 &&
            frame.remainingMs <= 10000,
        );
        initialized = true;
        clearTimeout(timer);
        const deadline = now() + frame.remainingMs;
        const check = () => need(!stopped && now() < deadline);
        void Promise.resolve()
          .then(() => {
            check();
            return options.work(check);
          })
          .then((counts) => {
            check();
            options.send(JSON.stringify({ version: 1, operationId, counts: parseCounts(counts) }));
            setTimeout(() => {
              try {
                check();
                options.exit(0);
              } catch {
                stop();
              }
            }, 50);
          })
          .catch(stop);
      } catch {
        stop();
      }
    },
  };
}
