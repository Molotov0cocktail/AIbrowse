import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { applySteps, git, readHistoricalSteps } from './history';
import {
  appendSources,
  conversationMessage,
  populateResearch,
  populateWatch,
  researchRows,
  sourceInput,
  jsonShape,
  watchRuleInput,
} from './fixtures';
import { validateManualAddInput } from '../../src/main/sources/domain/source-change-set';
import { parseMessagesFile, validateMessageShape } from '../../src/main/ai/conversation-store';
import { rowToResult, rowToTask } from '../../src/main/research/repository/research-repository';
import { validateRuleRow } from '../../src/main/watch/watch-row-validation';
import { MAX_TASK_PERSISTED_CHARS } from '../../src/shared/types/research';
import { validate } from '../../src/main/research/result-validator';
import { computeSourceLocatorFingerprint } from '../../src/shared/watch/watch-rule-state';

const root = process.cwd();
const baseline = git(root, ['rev-parse', 'HEAD']);

describe('E2容量资格夹具与证据边界', () => {
  it('拒绝非完整Git引用，不能从参数引入路径/选项', () => {
    expect(() => readHistoricalSteps(root, '--help', 'sources')).toThrow();
    expect(() => readHistoricalSteps(root, 'HEAD', 'sources')).toThrow();
  });
  it('最大Source字段通过现有业务输入校验且不截断', () => {
    const value = sourceInput(5);
    const validated = validateManualAddInput(value);
    expect(validated.ok).toBe(true);
    expect(validated.input?.userNote).toBe(value.userNote);
    expect(validated.input?.aiNote).toBe(value.aiNote);
    expect(validated.input?.url).toBe(value.url);
    expect(validated.input?.tags).toHaveLength(20);
  });
  it('三库真实Git迁移、极端字段写入、业务读回及完整性均可复核', () => {
    for (const domain of ['sources', 'research', 'watch'] as const) {
      const db = new DatabaseSync(':memory:');
      try {
        db.exec('PRAGMA foreign_keys = ON');
        applySteps(db, readHistoricalSteps(root, baseline, domain).steps);
        if (domain === 'sources') {
          appendSources(db, 0, 3);
          expect(db.prepare('SELECT count(*) n FROM source_tag_links').get()?.n).toBe(60);
          expect(
            db.prepare("SELECT count(*) n FROM sources_fts WHERE sources_fts MATCH '界界界'").get()
              ?.n,
          ).toBe(3);
        } else if (domain === 'research') {
          populateResearch(db);
          const rows = researchRows(0);
          expect(rowToTask(rows.task)).not.toBeNull();
          const result = rowToResult(rows.result);
          expect(result).not.toBeNull();
          expect(
            validate(
              { title: result!.title, summary: result!.summary, blocks: result!.blocks },
              {
                taskId: rows.task.id,
                candidates: [],
                evidence: [],
                claims: [],
                conflicts: [],
                verificationState: 'verified',
                now: rows.result.fetched_at,
                createId: () => rows.result.result_id,
              },
            ).ok,
          ).toBe(true);
          expect(
            Buffer.byteLength(JSON.stringify(result)) +
              Buffer.byteLength(JSON.stringify(rowToTask(rows.task))),
          ).toBeLessThan(MAX_TASK_PERSISTED_CHARS);
          expect(db.prepare('SELECT count(*) n FROM research_tasks').get()?.n).toBe(30);
        } else {
          populateWatch(db);
          const rules = db.prepare('SELECT * FROM watch_rules').all();
          expect(rules).toHaveLength(200);
          expect(rules.every((rule) => validateRuleRow(rule).ok)).toBe(true);
          expect(watchRuleInput(0).sourceLocatorFingerprint).toBe(
            computeSourceLocatorFingerprint({
              sourceId: watchRuleInput(0).sourceId,
              scope: 'page',
              canonicalKey: sourceInput(0).url,
              kind: 'feed',
              canonicalTargetUrl: sourceInput(0).url,
            }),
          );
        }
        expect(db.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      } finally {
        db.close();
      }
    }
  });
  it('旧会话接受递增助手正文；16000提问限制不能冒充助手输出上限', () => {
    for (const size of [16_000, 16_001, 1_048_576]) {
      const message = conversationMessage('界'.repeat(size));
      expect(validateMessageShape(message)?.content).toHaveLength(size);
      const parsed = parseMessagesFile(JSON.stringify({ version: 2, messages: [message] }));
      expect(parsed?.dropped).toBe(0);
      expect(parsed?.messages[0]?.content).toBe(message.content);
    }
  });
  it('转义UTF-16单元比中文字节更大，深度/条目测量明确定义', () => {
    const cjk = JSON.stringify(conversationMessage('界'.repeat(10)));
    const escape = JSON.stringify(conversationMessage('\u0000'.repeat(10)));
    expect(Buffer.byteLength(escape) - Buffer.byteLength(cjk)).toBe(30);
    expect(jsonShape({ a: [{ b: 'x' }] })).toEqual({ depth: 4, nodes: 4 });
  });
});
