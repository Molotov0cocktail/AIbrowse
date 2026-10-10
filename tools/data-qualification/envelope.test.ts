import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../../src/main/sources/db/sqlite-driver';
import { WATCH_MIGRATIONS } from '../../src/main/watch/db/watch-migrations';
import { RESEARCH_MIGRATIONS } from '../../src/main/research/db/research-migrations';
import { WatchRepository } from '../../src/main/watch/repository/watch-repository';
import { parseMessagesFile } from '../../src/main/ai/conversation-store';
import {
  validateChangeEvidencePair,
  validateDigestArtifactRow,
} from '../../src/main/watch/watch-row-validation';
import { MAX_EVENT_EVIDENCE_BYTES, MAX_WATCH_DB_BYTES } from '../../src/shared/types/watch';
import { MAX_TASK_PERSISTED_CHARS } from '../../src/shared/types/research';
import { populateWatch, fixtureId, jsonShape } from './fixtures';
import {
  appendDenseDigest,
  appendDenseEvent,
  denseEvidence,
  insertDenseResearch,
  prepareDigestParents,
  projectedConversationFixture,
  proposedFixedProtocolEnvelope,
} from './envelope-fixtures';

describe('E2剩余容量资格包络', () => {
  it('高密度Research表格通过真实Result校验和Repository预算', () => {
    const db = openDb(':memory:', { wal: false });
    try {
      for (const step of RESEARCH_MIGRATIONS) for (const sql of step.statements) db.exec(sql);
      const bytes = insertDenseResearch(db, 0);
      expect(bytes).toBeGreaterThan(MAX_TASK_PERSISTED_CHARS * 0.97);
      expect(bytes).toBeLessThanOrEqual(MAX_TASK_PERSISTED_CHARS);
    } finally {
      db.close();
    }
  });
  it('Watch非空事件、observation、journal、Digest夹具通过真实整库扫描', () => {
    const raw = new DatabaseSync(':memory:');
    const db = {
      path: ':memory:',
      isOpen: true,
      prepare: (sql: string) => raw.prepare(sql),
      exec: (sql: string) => raw.exec(sql),
      close: () => raw.close(),
    };
    try {
      for (const step of WATCH_MIGRATIONS) for (const sql of step.statements) db.exec(sql);
      populateWatch(raw);
      for (let i = 0; i < 201; i++) appendDenseEvent(db, i, 8);
      prepareDigestParents(db, 201);
      for (let i = 0; i < 101; i++) appendDenseDigest(db, i, 8);
      expect(validateChangeEvidencePair(denseEvidence(0))).not.toBeNull();
      expect(
        Buffer.byteLength(JSON.stringify(Array.from({ length: 3 }, (_, i) => denseEvidence(i)))),
      ).toBeLessThan(MAX_EVENT_EVIDENCE_BYTES);
      expect(validateDigestArtifactRow(raw.prepare('SELECT * FROM watch_digests').get()!)).toBe(
        true,
      );
      const repo = new WatchRepository(db);
      expect(repo.scanIntegrity()).toEqual({ ok: true, reason: null });
      expect(repo.estimateLogicalBytes()).toBeLessThan(MAX_WATCH_DB_BYTES);
    } finally {
      db.close();
    }
  });
  it('合法字段的toolCalls数量和文本增长不能误报有限最大值', () => {
    for (const count of [12, 64, 256]) {
      const fixture = projectedConversationFixture('回答', count);
      const parsed = parseMessagesFile(JSON.stringify(fixture));
      expect(parsed?.dropped).toBe(0);
      expect(parsed?.messages[0]?.toolCalls).toHaveLength(count);
      expect(jsonShape(fixture).depth).toBe(6);
    }
    const fixture = projectedConversationFixture('a'.repeat(16001), 0);
    expect(parseMessagesFile(JSON.stringify(fixture))?.messages[0]?.content).toHaveLength(16001);
  });
  it('未知嵌套字段通过有界输入预检后仍被闭合投影丢弃', () => {
    const fixture = {
      version: 2,
      messages: [
        {
          id: fixtureId(0),
          role: 'assistant',
          content: '合成',
          status: 'complete',
          createdAt: 0,
          extra: { nested: { deeper: { body: '未知字段不得进入持久化包络' } } },
        },
      ],
    };
    const parsed = parseMessagesFile(JSON.stringify(fixture));
    expect(parsed?.dropped).toBe(0);
    expect(parsed?.messages[0]).toEqual({
      id: fixtureId(0),
      role: 'assistant',
      content: '合成',
      status: 'complete',
      createdAt: 0,
    });
    expect(parsed?.messages[0]).not.toHaveProperty('extra');
  });
  it('四成员候选协议具有独立的确定性元数据包络', () => {
    const values = proposedFixedProtocolEnvelope();
    expect(values.manifest.members).toHaveLength(4);
    expect(Buffer.byteLength(JSON.stringify(values.manifest))).toBeLessThan(2048);
    expect(Buffer.byteLength(JSON.stringify(values.result))).toBeLessThan(1024);
    expect(jsonShape(values.manifest).depth).toBe(4);
  });
});
