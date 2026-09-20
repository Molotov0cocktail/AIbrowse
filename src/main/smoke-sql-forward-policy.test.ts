import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isWatchDriverSqlForward } from './smoke-sql-forward-policy';

describe('SRT-12 Watch连接观察转发分类', () => {
  it('只分类真实固定driver中的两个原样参数转发点', () => {
    const path = 'main/watch/db/watch-driver.ts';
    const lines = readFileSync('src/' + path, 'utf8')
      .split('\n')
      .filter((line) => /\.(prepare|exec)\(/.test(line));
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => isWatchDriverSqlForward(path, line))).toBe(true);
  });
  it('其它目录同名文件、renderer、业务SQL或参数改写均不获允许', () => {
    for (const path of [
      'renderer/watch-driver.ts',
      'main/other/watch-driver.ts',
      '../main/watch/db/watch-driver.ts',
    ]) {
      expect(isWatchDriverSqlForward(path, 'actual.exec(sql);')).toBe(false);
    }
    for (const line of [
      "actual.exec('DELETE FROM watch_rules');",
      'actual.exec(sql + extra);',
      'actual.prepare(other);',
      'other.exec(sql);',
      'actual.exec(sql); mutate();',
    ]) {
      expect(isWatchDriverSqlForward('main/watch/db/watch-driver.ts', line)).toBe(false);
    }
  });
});
