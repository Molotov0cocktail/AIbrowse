export const CA_TARGETS = Object.freeze([
  { id: 'normal', url: 'https://emudhra.we-have-a-problem.com/', compromised: false },
  {
    id: 'emsign',
    url: 'https://dv-g3b-emudhra.we-have-a-problem.com/',
    compromised: true,
  },
  {
    id: 'sectigo-cross-sign',
    url: 'https://dv-g3b-aaa-emudhra.we-have-a-problem.com/',
    compromised: true,
  },
]);

export function errorCode(error) {
  const values = [error?.code, error?.cause?.code, error?.message, error?.cause?.message];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const chromium = value.match(/\bERR_[A-Z_]+\b/u);
    if (chromium) return chromium[0];
    if (/^[A-Z][A-Z0-9_]{1,79}$/u.test(value)) return value;
  }
  return 'UNKNOWN_ERROR';
}

export function classifyObservation(target, observation) {
  if (observation.outcome === 'response') {
    if (target.compromised) return 'REPAIR';
    return observation.status >= 200 && observation.status < 300 ? 'PASS' : 'BLOCKED';
  }
  if (
    target.compromised &&
    observation.outcome === 'error' &&
    ['CERT_REVOKED', 'ERR_CERT_REVOKED'].includes(observation.code)
  )
    return 'PASS';
  return 'BLOCKED';
}

export function classifyReport(rows, transports) {
  const required = new Set(
    transports.flatMap((transport) => CA_TARGETS.map((t) => `${transport}/${t.id}`)),
  );
  if (rows.length !== required.size) return 'BLOCKED';
  for (const row of rows) {
    const key = `${row.transport}/${row.target}`;
    if (!required.delete(key)) return 'BLOCKED';
    const target = CA_TARGETS.find((candidate) => candidate.id === row.target);
    if (row.verdict !== classifyObservation(target, row)) return 'BLOCKED';
  }
  if (required.size !== 0 || rows.some((row) => row.verdict === 'BLOCKED')) return 'BLOCKED';
  return rows.some((row) => row.verdict === 'REPAIR') ? 'REPAIR' : 'PASS';
}
