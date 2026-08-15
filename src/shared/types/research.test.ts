// C1 research shared-types tests: compile-time contract asserted at runtime —
// every §6.8 budget constant (single source of truth), the adjudication #110
// field constants, the 11-code error table (adjudication #108), and the
// status/phase enums (adjudication #105). No magic numbers anywhere else.
import { describe, expect, it } from 'vitest';
import {
  MAX_CAPTURES_PER_TASK,
  MAX_CARDS_BODY_CHARS,
  MAX_CARDS_ITEMS,
  MAX_CARDS_TITLE_CHARS,
  MAX_CANDIDATE_NOTE_CHARS,
  MAX_CANDIDATE_TITLE_CHARS,
  MAX_CLAIMS_PER_TASK,
  MAX_CLAIM_TEXT_CHARS,
  MAX_CONFLICTS_PER_TASK,
  MAX_CONFLICT_POSITION_CHARS,
  MAX_CONFLICT_TOPIC_CHARS,
  MAX_EVIDENCE_EXCERPT_CHARS,
  MAX_EVIDENCE_FIELD_VALUE_CHARS,
  MAX_EVIDENCE_LOCATOR_FIELD_PATH_CHARS,
  MAX_EVIDENCE_PER_TASK,
  MAX_GOAL_CHARS,
  MAX_MARKDOWN_BLOCK_CHARS,
  MAX_PAGE_CAPTURE_CHARS,
  MAX_PAGE_READ_RETRIES,
  MAX_RANKING_DETAIL_CHARS,
  MAX_RANKING_ITEMS,
  MAX_RANKING_TITLE_CHARS,
  MAX_REQUEST_CONTEXT_CHARS,
  MAX_RESEARCH_ROUNDS,
  MAX_RESEARCH_TABS,
  MAX_RESEARCH_TOOL_STEPS,
  MAX_RESULT_BLOCKS,
  MAX_RESULT_CHARS,
  MAX_RESULT_SUMMARY_CHARS,
  MAX_RESULT_TITLE_CHARS,
  MAX_SELECTED_SOURCES,
  MAX_SOURCE_CANDIDATES,
  MAX_STORED_TASKS,
  MAX_TABLE_CELL_CHARS,
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MAX_TASK_PERSISTED_CHARS,
  MAX_TRANSCRIPT_REPLAY_ROUNDS,
  MAX_UNCERTAIN_TEXT_CHARS,
  RESEARCH_ERROR_CODES,
  RESEARCH_PHASES,
  RESEARCH_STATUSES,
  RESEARCH_TOTAL_TIMEOUT_MS,
} from './research';

describe('research 共享类型：预算常量单一事实源（§6.8 全表 + 决议 #110）', () => {
  it('§6.8 预算常量值精确匹配契约', () => {
    expect(MAX_GOAL_CHARS).toBe(2000);
    expect(MAX_SOURCE_CANDIDATES).toBe(24);
    expect(MAX_SELECTED_SOURCES).toBe(8);
    expect(MAX_RESEARCH_TABS).toBe(3);
    expect(MAX_PAGE_CAPTURE_CHARS).toBe(60000);
    expect(MAX_PAGE_READ_RETRIES).toBe(1);
    expect(MAX_CAPTURES_PER_TASK).toBe(16);
    expect(MAX_EVIDENCE_EXCERPT_CHARS).toBe(500);
    expect(MAX_EVIDENCE_FIELD_VALUE_CHARS).toBe(200);
    expect(MAX_EVIDENCE_PER_TASK).toBe(60);
    expect(MAX_CLAIMS_PER_TASK).toBe(30);
    expect(MAX_CONFLICTS_PER_TASK).toBe(10);
    expect(MAX_RESEARCH_ROUNDS).toBe(24);
    expect(MAX_RESEARCH_TOOL_STEPS).toBe(64);
    expect(RESEARCH_TOTAL_TIMEOUT_MS).toBe(1_800_000);
    expect(MAX_REQUEST_CONTEXT_CHARS).toBe(200_000);
    expect(MAX_TRANSCRIPT_REPLAY_ROUNDS).toBe(6);
    expect(MAX_RESULT_CHARS).toBe(200_000);
    expect(MAX_RESULT_BLOCKS).toBe(20);
    expect(MAX_TABLE_ROWS).toBe(200);
    expect(MAX_TABLE_COLUMNS).toBe(20);
    expect(MAX_CARDS_ITEMS).toBe(20);
    expect(MAX_RANKING_ITEMS).toBe(20);
    expect(MAX_TASK_PERSISTED_CHARS).toBe(500_000);
    expect(MAX_STORED_TASKS).toBe(30);
  });

  it('决议 #110 字段常量值精确匹配契约', () => {
    expect(MAX_CANDIDATE_TITLE_CHARS).toBe(200);
    expect(MAX_CANDIDATE_NOTE_CHARS).toBe(200);
    expect(MAX_CLAIM_TEXT_CHARS).toBe(500);
    expect(MAX_CONFLICT_TOPIC_CHARS).toBe(200);
    expect(MAX_CONFLICT_POSITION_CHARS).toBe(300);
    expect(MAX_RESULT_TITLE_CHARS).toBe(120);
    expect(MAX_RESULT_SUMMARY_CHARS).toBe(2000);
    expect(MAX_MARKDOWN_BLOCK_CHARS).toBe(4000);
    expect(MAX_TABLE_CELL_CHARS).toBe(200);
    expect(MAX_CARDS_TITLE_CHARS).toBe(120);
    expect(MAX_CARDS_BODY_CHARS).toBe(1000);
    expect(MAX_RANKING_TITLE_CHARS).toBe(120);
    expect(MAX_RANKING_DETAIL_CHARS).toBe(1000);
    expect(MAX_UNCERTAIN_TEXT_CHARS).toBe(1000);
    expect(MAX_EVIDENCE_LOCATOR_FIELD_PATH_CHARS).toBe(200);
  });

  it('错误码表为 11 码且无重复（决议 #108）', () => {
    expect(RESEARCH_ERROR_CODES).toHaveLength(11);
    expect(new Set(RESEARCH_ERROR_CODES).size).toBe(11);
    expect(RESEARCH_ERROR_CODES).toEqual([
      'research-invalid-goal',
      'research-busy',
      'research-not-found',
      'research-invalid-state',
      'research-unavailable',
      'research-sources-unavailable',
      'research-provider-unavailable',
      'research-budget-exhausted',
      'research-timeout',
      'research-task-limit',
      'research-internal',
    ]);
  });

  it('状态与相位枚举为契约全表', () => {
    expect(RESEARCH_STATUSES).toEqual([
      'created',
      'running',
      'completed',
      'failed',
      'cancelled',
      'interrupted',
    ]);
    expect(RESEARCH_PHASES).toEqual(['planning', 'reading', 'verifying', 'synthesizing']);
  });
});
