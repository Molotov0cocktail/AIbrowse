import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUDGET, assertFact } from './contract';

// A bounded census, not a claim that short-lived OS/SQLite files were all sampled.
export function diskCensus(root: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const visit = (directory: string, depth: number) => {
    assertFact(depth <= 16, '资格输出目录深度超限');
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      assertFact(!stat.isSymbolicLink(), '资格输出含链接');
      if (stat.isDirectory()) visit(path, depth + 1);
      else {
        files++;
        bytes += stat.size;
        assertFact(files <= 10000 && bytes <= BUDGET.diskBytes, '资格磁盘预算超限');
      }
    }
  };
  visit(root, 0);
  return { bytes, files };
}
