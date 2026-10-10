import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isReviewedTransferSqlLocation, isWatchDriverSqlForward } from './smoke-sql-forward-policy';

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

describe('SRT-12 E2 精确职责路径分类', () => {
  it('实际源码树的全部执行点通过原 SRT-12 分类，不漏扫分类器自身', () => {
    const smoke = readFileSync('src/main/smoke.ts', 'utf8');
    const start = smoke.indexOf('const sqlAllowed:');
    const end = smoke.indexOf('const sqlHits:', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const legacy = new Set(
      [...smoke.slice(start, end).matchAll(/'([^']+\.ts)'\s*:/g)].map((match) => match[1]),
    );
    expect(legacy.size).toBeGreaterThan(10);
    const unclassified: string[] = [];
    function scan(directory: string): void {
      for (const entry of readdirSync(join('src', directory), { withFileTypes: true })) {
        const path = directory ? directory + '/' + entry.name : entry.name;
        if (entry.isDirectory()) scan(path);
        else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.test.ts')) {
          for (const line of readFileSync(join('src', path), 'utf8').split('\n')) {
            if (!/\.(prepare|exec)\(/.test(line)) continue;
            if (
              /^(renderer|preload)\//.test(path) ||
              (!legacy.has(entry.name) &&
                !isWatchDriverSqlForward(path, line) &&
                !isReviewedTransferSqlLocation(path, line))
            )
              unclassified.push(path);
          }
        }
      }
    }
    scan('');
    expect(unclassified).toEqual([]);
  });
  it('分类器自身的字符串比较不产生额外 SQL 执行点', () => {
    const lines = readFileSync('src/main/smoke-sql-forward-policy.ts', 'utf8').split('\n');
    expect(lines.filter((line) => /\.(prepare|exec)\(/.test(line))).toEqual([]);
  });
  it.each([
    'main/research/repository/research-transfer-validation.ts',
    'main/sources/repository/source-transfer-validation.ts',
    'main/watch/repository/watch-transfer-validation.ts',
    'main/watch/repository/watch-source-transfer-validation.ts',
    'main/storage/staging-sqlite.ts',
    'main/storage/startup-probe.ts',
    'main/storage/transfer-pipeline.ts',
    'main/storage/transfer-schema.ts',
  ])('已审模块的真实 SQL 执行点有明确分类：%s', (path) => {
    const lines = readFileSync('src/' + path, 'utf8')
      .split('\n')
      .filter((line) => /\.(prepare|exec)\(/.test(line));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => isReviewedTransferSqlLocation(path, line))).toBe(true);
  });
  it('只排除 main 中启动协调器的确切非 SQL 调用', () => {
    expect(
      isReviewedTransferSqlLocation(
        'main/index.ts',
        'const startupState = await datasetStartup.prepare(requireNodeDataRoot());',
      ),
    ).toBe(true);
    for (const line of [
      'db.exec(rendererSql);',
      'db.prepare(payload.sql);',
      'const startupState = await datasetStartup.prepare(requireNodeDataRoot()); db.exec(input);',
    ]) {
      expect(isReviewedTransferSqlLocation('main/index.ts', line)).toBe(false);
    }
  });
  it('任意 storage 文件、其它目录同名文件和 renderer/preload 均不能获得授权', () => {
    for (const path of [
      'main/storage/new-reader.ts',
      'main/other/transfer-schema.ts',
      'renderer/transfer-schema.ts',
      'preload/startup-probe.ts',
      '../main/storage/transfer-schema.ts',
    ]) {
      expect(isReviewedTransferSqlLocation(path, 'db.exec(input);')).toBe(false);
    }
  });
  it.each([
    ['main/index.ts', 'const prepared = await startupPreparation.prepare({'],
    ['main/storage/recovery-transfer-runtime.ts', 'await replacement.prepare();'],
  ])('新增协调调用只在精确文件和精确语句分类：%s', (path, line) => {
    expect(isReviewedTransferSqlLocation(path, line)).toBe(true);
    for (const other of ['renderer/index.ts', 'main/storage/other.ts'])
      expect(isReviewedTransferSqlLocation(other, line)).toBe(false);
    for (const altered of [line + ' db.exec(input);', 'db.prepare(input);'])
      expect(isReviewedTransferSqlLocation(path, altered)).toBe(false);
  });
});
