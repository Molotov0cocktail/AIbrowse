import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DbHandle } from './db/sqlite-driver';
import { runMigrations } from './db/migrations';
import { SourceServiceImpl } from './source-service';
import { SourceRepository } from './repository/source-repository';
import * as manifest from '../watch/qualification/manifest';
import type { QualificationSeedAuthorization } from '../watch/qualification/seed-authorization';

// Native launch authority is a separate integration gate; this test controls only its verdict.
const authority = vi.hoisted(() => ({
  grants: new WeakMap<object, { path: string; completed: boolean }>(),
  complete: vi.fn(),
}));
vi.mock('../watch/qualification/seed-authorization', () => ({
  assertQualificationSeedDatabase(auth: object, kind: string, path: string): void {
    if (kind !== 'sources' || authority.grants.get(auth)?.path !== path)
      throw new Error('测试授权数据库不匹配');
  },
  assertQualificationSeedAuthorization(
    auth: object,
    phase: string,
    descriptor: string,
    expanded: string,
    m0: number,
  ): void {
    const grant = authority.grants.get(auth);
    if (
      grant === undefined ||
      grant.completed ||
      phase !== 'sources' ||
      m0 !== Date.parse('2026-09-07T12:00:00.000Z') ||
      descriptor !== '3f59d95d74d373ef57e80eb56d05c4c9620a6e2bc2db8637ce5ddee48b5b85c3' ||
      expanded !== '5652b57e407b728e78a090b56aa84a73bc81f6b977e8a9e6211d3a48c15b6beb'
    )
      throw new Error('测试授权无效');
  },
  completeQualificationSeed(auth: object, phase: string): void {
    authority.complete(auth, phase);
    const grant = authority.grants.get(auth);
    if (grant === undefined || grant.completed) throw new Error('测试授权已消费');
    grant.completed = true;
  },
}));

const root = mkdtempSync(join(tmpdir(), 'aibrowse-qualification-source-'));
const M0 = Date.parse('2026-09-07T12:00:00.000Z');
let sequence = 0;
let handle: DbHandle;
let service: SourceServiceImpl;
let auth: QualificationSeedAuthorization;
const observer = {
  prepare: vi.fn(() => ({ ok: true as const })),
  commit: vi.fn(() => ({ ok: true as const })),
  abort: vi.fn(),
};

beforeEach(() => {
  vi.stubGlobal('__WATCH_QUALIFICATION__', true);
  handle = openDb(join(root, 'seed-' + sequence++ + '.db'));
  runMigrations(handle);
  service = new SourceServiceImpl({ db: handle, now: () => M0, observer });
  auth = Object.freeze({}) as QualificationSeedAuthorization;
  authority.grants.set(auth, { path: handle.path, completed: false });
  authority.complete.mockReset();
  observer.prepare.mockClear();
  observer.commit.mockClear();
  observer.abort.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  service.dispose();
  vi.unstubAllGlobals();
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(
  descriptor = manifest.H3B_DESCRIPTOR_SHA256,
  expanded = manifest.H3B_EXPANDED_SHA256,
): void {
  service.seedWatchResourceQualificationSourcesV1(auth, descriptor, expanded, M0);
}
function count(): number {
  return (handle.prepare('SELECT COUNT(*) AS n FROM sources').get() as { n: number }).n;
}

describe('Sources 资格窄播种事务', () => {
  it('真实空库100条Source、FTS逐行mirror和Service投影全部相等且无observer/journal', () => {
    const read = vi.spyOn(service, 'getSourceWatchProjection');
    seed();
    expect(count()).toBe(100);
    expect(read).toHaveBeenCalledTimes(100);
    const repo = new SourceRepository(handle);
    for (const source of manifest.createQualificationSources(M0)) {
      const projection = service.getSourceWatchProjection(source.id);
      expect(projection).toEqual({
        status: 'found',
        projection: {
          sourceId: source.id,
          rowVersion: 1,
          enabled: true,
          deletedAt: null,
          scope: 'page',
          canonicalKey: source.canonicalKey,
        },
      });
      expect(repo.getSourceById(source.id)?.name).toBe(source.name);
      expect(
        handle
          .prepare('SELECT rowid FROM sources_fts WHERE sources_fts MATCH ?')
          .all('"' + source.name + '"'),
      ).toHaveLength(1);
    }
    expect(handle.prepare('SELECT COUNT(*) AS n FROM sources_fts_docsize').get()).toEqual({
      n: 100,
    });
    expect(
      handle
        .prepare(
          'SELECT (SELECT COUNT(*) FROM source_groups) AS groups, (SELECT COUNT(*) FROM source_tags) AS tags, (SELECT COUNT(*) FROM source_tag_links) AS links, (SELECT COUNT(*) FROM change_journal) AS journal',
        )
        .get(),
    ).toEqual({ groups: 0, tags: 0, links: 0, journal: 0 });
    expect(observer.prepare).not.toHaveBeenCalled();
    expect(observer.commit).not.toHaveBeenCalled();
    expect(observer.abort).not.toHaveBeenCalled();
    expect(authority.complete).toHaveBeenCalledExactlyOnceWith(auth, 'sources');
    expect(() => seed()).toThrow();
    expect(count()).toBe(100);
  });

  it('普通build、伪授权、其它DB授权与错误hash零写入', () => {
    vi.stubGlobal('__WATCH_QUALIFICATION__', false);
    expect(() => seed()).toThrow();
    vi.stubGlobal('__WATCH_QUALIFICATION__', true);
    expect(() =>
      service.seedWatchResourceQualificationSourcesV1(
        {} as QualificationSeedAuthorization,
        manifest.H3B_DESCRIPTOR_SHA256,
        manifest.H3B_EXPANDED_SHA256,
        M0,
      ),
    ).toThrow();
    expect(() => seed('bad')).toThrow();
    expect(() => seed(undefined, 'bad')).toThrow();
    authority.grants.set(auth, { path: handle.path + '.other', completed: false });
    expect(() => seed()).toThrow();
    expect(count()).toBe(0);
  });

  it.each(['group', 'tag', 'journal', 'fts-ghost'])('拒绝已有%s且不删除已有内容', (kind) => {
    if (kind === 'group')
      handle
        .prepare('INSERT INTO source_groups VALUES (?,?,?,NULL)')
        .run('group', 'existing', new Date(M0).toISOString());
    if (kind === 'tag')
      handle
        .prepare('INSERT INTO source_tags VALUES (?,?,?)')
        .run('tag', 'existing', new Date(M0).toISOString());
    if (kind === 'journal')
      handle
        .prepare(
          "INSERT INTO change_journal(idempotency_key,change_type,before_payload,after_payload,source_ids,applied_at) VALUES (?,'manual','{}','{}','[]',?)",
        )
        .run('existing', new Date(M0).toISOString());
    if (kind === 'fts-ghost')
      handle
        .prepare('INSERT INTO sources_fts(rowid,name,url,user_note,ai_note) VALUES (1,?,?,?,?)')
        .run('ghost', 'https://example.com/', '', '');
    expect(() => seed()).toThrow();
    expect(count()).toBe(0);
    expect(authority.complete).not.toHaveBeenCalled();
  });

  it('拒绝已有合法Source且保留它', async () => {
    const added = await service.addManual({ scope: 'page', url: 'https://example.com/existing' });
    expect(added.ok).toBe(true);
    expect(() => seed()).toThrow();
    expect(count()).toBe(1);
  });

  it.each([
    'write-error',
    'fts-missing',
    'fts-content',
    'projection-missing',
    'projection-unavailable',
    'row-drift',
  ])('中途%s使全部Source/FTS事务回滚', (failure) => {
    const insert = SourceRepository.prototype.insertSource;
    const fts = SourceRepository.prototype.ftsInsert;
    let writes = 0;
    if (failure === 'write-error' || failure === 'row-drift') {
      vi.spyOn(SourceRepository.prototype, 'insertSource').mockImplementation(function (
        this: SourceRepository,
        row,
      ) {
        if (++writes === 40) {
          if (failure === 'write-error') throw new Error('受控写失败');
          return insert.call(this, { ...row, name: 'drift' });
        }
        return insert.call(this, row);
      });
    }
    if (failure === 'fts-missing' || failure === 'fts-content') {
      vi.spyOn(SourceRepository.prototype, 'ftsInsert').mockImplementation(function (
        this: SourceRepository,
        rowid,
        name,
        url,
        note,
        aiNote,
      ) {
        if (++writes === 40) {
          if (failure === 'fts-missing') return;
          return fts.call(this, rowid, 'wrong-index-content', url, note, aiNote);
        }
        fts.call(this, rowid, name, url, note, aiNote);
      });
    }
    if (failure === 'projection-missing')
      vi.spyOn(service, 'getSourceWatchProjection').mockReturnValueOnce({ status: 'missing' });
    if (failure === 'projection-unavailable')
      vi.spyOn(service, 'getSourceWatchProjection').mockReturnValueOnce({ status: 'unavailable' });
    expect(() => seed()).toThrow();
    expect(count()).toBe(0);
    expect(handle.prepare('SELECT COUNT(*) AS n FROM sources_fts_docsize').get()).toEqual({ n: 0 });
    expect(authority.complete).not.toHaveBeenCalled();
  });

  it('仅实际COMMIT完成后才推进授权', () => {
    const exec = handle.exec.bind(handle);
    let committed = false;
    vi.spyOn(handle, 'exec').mockImplementation((sql) => {
      exec(sql);
      if (sql === 'COMMIT') committed = true;
    });
    authority.complete.mockImplementationOnce(() => {
      expect(committed).toBe(true);
    });
    seed();
    expect(count()).toBe(100);
  });

  it.each(['duplicate', 'invalid-id', 'noncanonical', 'short-set'])(
    '拒绝固定生成器的%s偏离且不留下部分数据',
    (failure) => {
      const sources = manifest.createQualificationSources(M0);
      if (failure === 'duplicate') sources[45]!.id = sources[0]!.id;
      if (failure === 'invalid-id') sources[45]!.id = 'not-a-source-id';
      if (failure === 'noncanonical') sources[45]!.canonicalKey += '#fragment';
      if (failure === 'short-set') sources.pop();
      vi.spyOn(manifest, 'createQualificationSources').mockReturnValueOnce(sources);
      expect(() => seed()).toThrow();
      expect(count()).toBe(0);
      expect(handle.prepare('SELECT COUNT(*) AS n FROM sources_fts_docsize').get()).toEqual({
        n: 0,
      });
      expect(authority.complete).not.toHaveBeenCalled();
    },
  );

  it('COMMIT失败完整回滚，不把授权状态当数据库已提交', () => {
    const exec = handle.exec.bind(handle);
    vi.spyOn(handle, 'exec').mockImplementation((sql) => {
      if (sql === 'COMMIT') throw new Error('受控提交失败');
      exec(sql);
    });
    expect(() => seed()).toThrow();
    expect(count()).toBe(0);
    expect(handle.prepare('SELECT COUNT(*) AS n FROM sources_fts_docsize').get()).toEqual({ n: 0 });
    expect(authority.complete).not.toHaveBeenCalled();
  });
});
