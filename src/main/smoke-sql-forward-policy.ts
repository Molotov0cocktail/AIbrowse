// This classifies only the reviewed Watch driver forwarding statements, not arbitrary SQL.
export function isWatchDriverSqlForward(relativePath: string, line: string): boolean {
  return (
    relativePath.replace(/\\/g, '/') === 'main/watch/db/watch-driver.ts' &&
    /^(?:const statement = actual\.prepare\(sql\);|actual\.exec\(sql\);)$/.test(line.trim())
  );
}

// Exact reviewed modules, not a directory exemption. Repository scanners use compiled
// statements/parameters; storage modules own fixed PRAGMAs, catalogs and migrations.
const TRANSFER_SQL_LOCATIONS = new Set([
  'main/research/repository/research-transfer-validation.ts',
  'main/sources/repository/source-transfer-validation.ts',
  'main/watch/repository/watch-transfer-validation.ts',
  'main/watch/repository/watch-source-transfer-validation.ts',
  'main/storage/staging-sqlite.ts',
  'main/storage/startup-probe.ts',
  'main/storage/transfer-pipeline.ts',
  'main/storage/transfer-schema.ts',
]);

export function isReviewedTransferSqlLocation(relativePath: string, line: string): boolean {
  const path = relativePath.replace(/\\/g, '/');
  if (TRANSFER_SQL_LOCATIONS.has(path)) return true;
  // These exact orchestration calls prepare ownership/metadata, never SQL.
  const statement = line.trim();
  if (path === 'main/index.ts')
    return [
      ['const startupState = await datasetStartup.', 'prepare(requireNodeDataRoot());'].join(''),
      ['const prepared = await startupPreparation.', 'prepare({'].join(''),
    ].includes(statement);
  return (
    path === 'main/storage/recovery-transfer-runtime.ts' &&
    statement === ['await replacement.', 'prepare();'].join('')
  );
}
