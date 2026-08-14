// source-search-index 测试（B3，红→绿）：候选集查询（FTS/LIKE/短查询/URL 四条编译期
// 常量路径，全部参数绑定）、注入串只作数据、FTS 可用性判定与降级（决议 #62）、
// 诊断性 rebuild 与主表/FTS 一致性校验（失败不破坏现有索引）、有界候选。
// 使用真实 node:sqlite（与 source-service 测试同模式）；测试专用 SQL 仅限本文件
// （*.test.ts 测试设施，决议 #47）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DbHandle } from '../db/sqlite-driver';
import { runMigrations } from '../db/migrations';
import { SourceServiceImpl } from '../source-service';
import { SourceSearchIndex } from './source-search-index';
import { buildFtsQuery, likePrefix, likeSubstring } from '../domain/source-search-query';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-search-index-'));

let handle: DbHandle;
let service: SourceServiceImpl;
let index: SourceSearchIndex;

beforeEach(async () => {
  handle = openDb(join(root, `idx-${Math.random().toString(36).slice(2)}.db`));
  runMigrations(handle);
  service = new SourceServiceImpl({ db: handle });
  index = new SourceSearchIndex(handle);
  // 种子：中文/日文/英文 + blocked + 注：service 写入路径同时同步 FTS（决议 #54）
  await service.addManual({
    scope: 'page',
    url: 'https://example.com/benchmark',
    name: '基准测试站',
    tags: ['benchmark'],
    groupName: 'AI组',
    shareMode: 'full',
    userNote: '看大模型评测优先看这里',
    aiNote: 'AI 推断的中文备注',
  });
  await service.addManual({
    scope: 'page',
    url: 'https://example.com/ja',
    name: '日本語情報源',
    shareMode: 'full',
  });
  await service.addManual({
    scope: 'page',
    url: 'https://www.electronjs.org/docs',
    name: 'Electron Docs',
    shareMode: 'metadata',
    userNote: 'META_NOTE_SECRET',
  });
  await service.addManual({
    scope: 'page',
    url: 'https://example.com/hidden',
    name: '隐藏站',
    shareMode: 'blocked',
    userNote: 'BLOCKED_SECRET',
  });
});

afterEach(() => {
  try {
    service.dispose(); // 幂等；关闭句柄（测试文件内各用例独立建库）
  } catch {
    // dispose 失败不掩盖用例结果
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('searchCandidates — 四条路径（编译期常量 + 参数绑定）', () => {
  it('fts：中文 ≥3 字符 trigram 命中 name；日文命中；英文子串命中', () => {
    const ftsQ = buildFtsQuery('基准测试');
    expect(ftsQ.ok).toBe(true);
    if (!ftsQ.ok) return;
    const rows = index.searchCandidates({
      kind: 'fts',
      audience: 'agent',
      query: '基准测试',
      ftsQuery: ftsQ.query,
      candidateMax: 200,
    });
    expect(rows.map((r) => r.name)).toContain('基准测试站');
    const ja = buildFtsQuery('日本語');
    if (!ja.ok) return;
    const jaRows = index.searchCandidates({
      kind: 'fts',
      audience: 'agent',
      query: '日本語',
      ftsQuery: ja.query,
      candidateMax: 200,
    });
    expect(jaRows.map((r) => r.name)).toContain('日本語情報源');
    const en = buildFtsQuery('electronjs');
    if (!en.ok) return;
    const enRows = index.searchCandidates({
      kind: 'fts',
      audience: 'agent',
      query: 'electronjs',
      ftsQuery: en.query,
      candidateMax: 200,
    });
    expect(enRows.map((r) => r.name)).toContain('Electron Docs');
  });
  it('short1：仅精确；short2：精确+前缀+子串（tag/group 也参与）', () => {
    const r1 = index.searchCandidates({
      kind: 'short1',
      audience: 'user',
      query: '站',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(r1.map((r) => r.name)).not.toContain('基准测试站');
    const r2 = index.searchCandidates({
      kind: 'short2',
      audience: 'user',
      query: '测试',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(r2.map((r) => r.name)).toContain('基准测试站');
    const r3 = index.searchCandidates({
      kind: 'short2',
      audience: 'user',
      query: 'AI组',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(r3.map((r) => r.name)).toContain('基准测试站');
    const r4 = index.searchCandidates({
      kind: 'short2',
      audience: 'user',
      query: 'benchmark',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(r4.map((r) => r.name)).toContain('基准测试站');
  });
  it('url：canonicalKey/url 精确+前缀；like-long（FTS 不可用降级）精确+前缀+tag/group', () => {
    const ru = index.searchCandidates({
      kind: 'url',
      audience: 'agent',
      query: 'https://www.electronjs.org/docs',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(ru.map((r) => r.name)).toContain('Electron Docs');
    const rl = index.searchCandidates({
      kind: 'like-long',
      audience: 'user',
      query: '基准',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(rl.map((r) => r.name)).toContain('基准测试站');
  });
  it('blocked 过滤：agent 视角候选不含 blocked（short2/url 路径同样过滤）', () => {
    const rows = index.searchCandidates({
      kind: 'short2',
      audience: 'agent',
      query: '隐藏',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(rows).toHaveLength(0);
    const userRows = index.searchCandidates({
      kind: 'short2',
      audience: 'user',
      query: '隐藏',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(userRows.map((r) => r.name)).toContain('隐藏站');
  });
  it('有界候选：candidateMax 生效（LIMIT 编译期常量）', () => {
    const rows = index.searchCandidates({
      kind: 'short2',
      audience: 'user',
      query: 'example',
      ftsQuery: null,
      candidateMax: 1,
    });
    expect(rows.length).toBeLessThanOrEqual(1);
  });
  it('注入串在 FTS 与 LIKE 两条路径均只作数据（SRT-04 断言先行）', () => {
    const evil = "'; DROP TABLE sources; --";
    const ftsQ = buildFtsQuery(evil);
    const rows1 = index.searchCandidates({
      kind: 'fts',
      audience: 'user',
      query: evil,
      ftsQuery: ftsQ.ok ? ftsQ.query : null,
      candidateMax: 200,
    });
    expect(rows1).toHaveLength(0);
    const rows2 = index.searchCandidates({
      kind: 'short2',
      audience: 'user',
      query: "'; DROP TABLE sources; --",
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(rows2).toHaveLength(0);
    const count = handle.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number };
    expect(count.n).toBe(4); // 表与数据完好
    // 通配符/%/_/引号/反斜杠只作数据（LIKE ESCAPE）
    const wild = index.searchCandidates({
      kind: 'short2',
      audience: 'user',
      query: '%_\\',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(wild).toHaveLength(0);
  });
});

describe('isFtsAvailable — 决议 #62 范围界定', () => {
  it('正常建库 → true；sources_fts 被破坏/缺失 → false（建库后场景）', () => {
    expect(index.isFtsAvailable()).toBe(true);
    handle.exec('DROP TABLE sources_fts');
    expect(index.isFtsAvailable()).toBe(false);
  });
});

describe('FTS 降级：FTS 不可用 ≠ 数据库不可用（不伪装成功）', () => {
  it('FTS 表缺失时 like-long 路径仍可命中（降级为完整交付实现）', () => {
    handle.exec('DROP TABLE sources_fts');
    const rows = index.searchCandidates({
      kind: 'like-long',
      audience: 'user',
      query: '基准',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(rows.map((r) => r.name)).toContain('基准测试站');
  });
  it('FTS 表缺失时 note 检索不可用（候选集不含仅 note 命中的行）', () => {
    handle.exec('DROP TABLE sources_fts');
    const rows = index.searchCandidates({
      kind: 'like-long',
      audience: 'user',
      query: '大模型评测',
      ftsQuery: null,
      candidateMax: 200,
    });
    // '大模型评测' 仅出现在 userNote——LIKE 降级路径不检索 note，如实不命中
    expect(rows.map((r) => r.name)).not.toContain('基准测试站');
  });
});

describe('rebuildFts 与 verifyFtsConsistency — 诊断能力', () => {
  it('rebuild 前后行数与内容一致；一致性校验通过', () => {
    const before = index.verifyFtsConsistency();
    expect(before).toEqual({ ok: true, ftsCount: 4, sourceCount: 4, missingFromIndex: [] });
    index.rebuildFts();
    const after = index.verifyFtsConsistency();
    expect(after).toEqual({ ok: true, ftsCount: 4, sourceCount: 4, missingFromIndex: [] });
    // rebuild 后检索内容不变
    const ftsQ = buildFtsQuery('基准测试');
    if (ftsQ.ok) {
      const rows = index.searchCandidates({
        kind: 'fts',
        audience: 'user',
        query: '基准测试',
        ftsQuery: ftsQ.query,
        candidateMax: 200,
      });
      expect(rows.map((r) => r.name)).toContain('基准测试站');
    }
  });
  it('主表/FTS 不一致可检出：绕过 FTS 同步直插主表行 → 校验失败 → rebuild 修复并可检索', () => {
    // 测试专用 SQL（*.test.ts 测试设施）：直插主表行绕过 ftsInsert，制造
    // 「内容有行、索引缺行」的不一致（检索漏命中方向——FTS5 外部内容表语义下
    // 计数比对可检出的危险方向；滞留索引行在查询期被 FTS5 自动忽略）
    handle
      .prepare(
        `INSERT INTO sources (
          id, scope, canonical_key, url, name, group_id, priority, enabled, share_mode,
          trust_value, trust_asserted_by, trust_verification, user_note, ai_note,
          created_by, version, created_at, updated_at, deleted_at, last_used_at, last_usage_outcome
        ) VALUES (?, 'page', ?, ?, ?, NULL, 3, 1, 'metadata', 'unknown', 'user',
          'unverified', '', '', 'user', 1, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        '22222222-2222-4222-8222-222222222222',
        'https://example.com/missing-idx',
        'https://example.com/missing-idx',
        '缺失索引站',
        '2026-08-15T00:00:00.000Z',
        '2026-08-15T00:00:00.000Z',
      );
    const bad = index.verifyFtsConsistency();
    expect(bad.ok).toBe(false);
    expect(bad.missingFromIndex).toHaveLength(1); // 索引缺行方向（搜索漏命中）被检出
    index.rebuildFts();
    expect(index.verifyFtsConsistency()).toEqual({
      ok: true,
      ftsCount: 5,
      sourceCount: 5,
      missingFromIndex: [],
    });
    const ftsQ = buildFtsQuery('缺失索引站');
    if (ftsQ.ok) {
      const rows = index.searchCandidates({
        kind: 'fts',
        audience: 'user',
        query: '缺失索引站',
        ftsQuery: ftsQ.query,
        candidateMax: 200,
      });
      expect(rows.map((r) => r.name)).toContain('缺失索引站');
    }
  });
  it('rebuild 失败不得破坏数据与降级能力（FTS 表缺失 → 失败 → 主表完好、LIKE 降级可用）', () => {
    expect(index.verifyFtsConsistency().sourceCount).toBe(4);
    handle.exec('DROP TABLE sources_fts'); // 建库后 FTS 表被破坏（决议 #62 范围）
    expect(() => index.rebuildFts()).toThrow();
    const count = handle.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number };
    expect(count.n).toBe(4); // 主表数据完好
    expect(index.isFtsAvailable()).toBe(false);
    // LIKE 降级路径仍可用（完整交付实现，不伪装成功）
    const rows = index.searchCandidates({
      kind: 'like-long',
      audience: 'user',
      query: '基准测试站',
      ftsQuery: null,
      candidateMax: 200,
    });
    expect(rows.map((r) => r.name)).toContain('基准测试站');
  });
});

describe('likePrefix/likeSubstring — LIKE 模式构造（与候选 SQL 语义一致）', () => {
  it('转义 % _ \\；前缀/子串形态', () => {
    expect(likePrefix('%可靠')).toBe('\\%可靠%');
    expect(likeSubstring('100%')).toBe('%100\\%%');
  });
});
