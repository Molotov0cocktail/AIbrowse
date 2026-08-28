// D5 M6: 结构红线静态扫描（threat-model §3.1/§7.1、FIXED DECISIONS 8、AGENTS §3）。
// - Scheduler 对象图零 Browser/DB/HTTP/Provider/Notification 能力；
// - Scheduler 提交回调只含 ruleId(+trigger)（类型级精确断言）；
// - Coordinator/Gate 零 Electron import；
// - 日志脱敏：watch 模块 logger 调用不得拼接 URL/path/query/正文；
// - SRT-12 SQL 分类：新增 watch 模块零 .prepare/.exec 直调（无需白名单条目）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WatchSchedulerOptions } from './watch-scheduler';

const SRC = join(__dirname, '..', '..');

function sourceFile(rel: string): string {
  return readFileSync(join(SRC, rel), 'utf8');
}

function importTargets(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*import\s+[^'"]*?from\s+['"]([^'"]+)['"]/);
    if (m) out.push(m[1]!);
    const m2 = line.match(/^\s*import\s+['"]([^'"]+)['"]/);
    if (m2) out.push(m2[1]!);
  }
  return out;
}

const FORBIDDEN_CAPABILITY = [
  'electron',
  'node:sqlite',
  'sqlite-driver',
  'watch-driver',
  'node:http',
  'node:https',
  'provider',
  'notification',
  'browser',
];

describe('M6 结构红线（Scheduler 零能力 / 零 Electron / 日志脱敏 / SQL 分类）', () => {
  it('M6① watch-scheduler.ts 对象图零 Browser/DB/HTTP/Provider/Notification 能力', () => {
    const content = sourceFile('main/watch/watch-scheduler.ts');
    const targets = importTargets(content);
    for (const t of targets) {
      for (const forbidden of FORBIDDEN_CAPABILITY) {
        expect(t.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    }
    // 只允许 node:crypto 与 shared 纯模块
    expect(targets.some((t) => t.startsWith('node:') && t !== 'node:crypto')).toBe(false);
    expect(targets.some((t) => t.startsWith('../logger'))).toBe(false);
    expect(targets.some((t) => t.includes('repository'))).toBe(false);
    expect(targets.some((t) => t.includes('db/'))).toBe(false);
  });

  it('M6② Scheduler 提交回调只含 ruleId(+trigger)（类型级精确）', () => {
    type OnDueEntry = Parameters<NonNullable<WatchSchedulerOptions['onDue']>>[0][number];
    type Keys = keyof OnDueEntry;
    type AssertSame<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
    const exact: AssertSame<Keys, 'ruleId' | 'trigger'> = true;
    expect(exact).toBe(true);
    // 触发值闭合为 catch-up|scheduled
    type Trigger = OnDueEntry['trigger'];
    const t: AssertSame<Trigger, 'catch-up' | 'scheduled'> = true;
    expect(t).toBe(true);
  });

  it('M6③ Coordinator/HostRequestGate 零 Electron import；Coordinator 只经窄端口消费能力', () => {
    for (const rel of [
      'main/watch/watch-run-coordinator.ts',
      'main/watch/host-request-gate.ts',
      'main/watch/watch-scheduler.ts',
    ]) {
      const content = sourceFile(rel);
      for (const t of importTargets(content)) {
        expect(t.toLowerCase()).not.toContain('electron');
      }
    }
    const coord = sourceFile('main/watch/watch-run-coordinator.ts');
    // 协调器能力只经注入端口：对 repository/lifecycle-coordinator 的 import 必须全部
    // 为类型导入（type-only，运行时不持有实现），否则属直接能力依赖。
    const implImports = coord
      .split('\n')
      .filter(
        (l) =>
          /^\s*import\b/.test(l) &&
          /repository\/watch-repository|watch-lifecycle-coordinator/.test(l),
      );
    expect(implImports.length).toBeGreaterThan(0);
    for (const line of implImports) {
      expect(line.trim().startsWith('import type')).toBe(true);
    }
  });

  it('M6④ 日志脱敏：watch 模块 logger 调用零 URL/path/query/正文拼接', () => {
    const badPatterns = [
      /\$\{[^}]*\.feedUrl/,
      /\$\{[^}]*\.pageUrl/,
      /queryString/,
      /searchParams/,
      /pathname/,
    ];
    for (const rel of [
      'main/watch/watch-scheduler.ts',
      'main/watch/watch-run-coordinator.ts',
      'main/watch/host-request-gate.ts',
      'main/watch/repository/watch-repository.ts',
    ]) {
      const content = sourceFile(rel);
      for (const pattern of badPatterns) {
        expect(content).not.toMatch(pattern);
      }
    }
  });

  it('M6⑤ 新增 watch 模块零 .prepare/.exec 直调（SRT-12 白名单无需追加条目）', () => {
    for (const rel of [
      'main/watch/watch-scheduler.ts',
      'main/watch/watch-run-coordinator.ts',
      'main/watch/host-request-gate.ts',
    ]) {
      const content = sourceFile(rel);
      for (const line of content.split('\n')) {
        expect(line).not.toMatch(/\.(prepare|exec)\(/);
      }
    }
  });
});
