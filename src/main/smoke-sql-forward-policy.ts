// This classifies only the reviewed Watch driver forwarding statements, not arbitrary SQL.
export function isWatchDriverSqlForward(relativePath: string, line: string): boolean {
  return (
    relativePath.replace(/\\/g, '/') === 'main/watch/db/watch-driver.ts' &&
    /^(?:const statement = actual\.prepare\(sql\);|actual\.exec\(sql\);)$/.test(line.trim())
  );
}
