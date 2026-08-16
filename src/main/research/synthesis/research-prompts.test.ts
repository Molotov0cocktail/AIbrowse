// C6 research-prompts tests (adjudications #134(4)/#146/#147): the four
// compile-time system prompt constants are non-empty, mutually distinct,
// distinct from the co-reading SYSTEM_PROMPT and the agent AGENT_SYSTEM_PROMPT,
// carry zero dynamic content (no goal/URL/title/Evidence/Claim/web text
// splicing), state each phase's strict JSON protocol, the six-tool capability
// boundary, the web-text-is-untrusted rule, no fabrication of
// Evidence/IDs/sourceType/coverage, and the "uncertain" duty when evidence is
// insufficient. The frozen ResearchPromptsPort object exposes exactly the four
// constants (read-only). Adversarial content placement is asserted via
// captured ProviderRequests in research-runtime-c6.test.ts (adjudication
// #146(4)) — this module never builds blocks.
import { describe, expect, it } from 'vitest';
import {
  AGENT_RESEARCH_PLANNING_PROMPT,
  AGENT_RESEARCH_READING_PROMPT,
  AGENT_RESEARCH_SYNTHESIS_PROMPT,
  AGENT_RESEARCH_VERIFYING_PROMPT,
  RESEARCH_PROMPTS_PORT,
} from './research-prompts';
import { SYSTEM_PROMPT } from '../../ai/context-builder';
import { AGENT_SYSTEM_PROMPT } from '../../ai/agent/agent-context-builder';

const PROMPTS = [
  AGENT_RESEARCH_PLANNING_PROMPT,
  AGENT_RESEARCH_READING_PROMPT,
  AGENT_RESEARCH_VERIFYING_PROMPT,
  AGENT_RESEARCH_SYNTHESIS_PROMPT,
];

describe('四编译期常量（决议 #146）', () => {
  it('非空、互异，且与共读 SYSTEM_PROMPT / AGENT_SYSTEM_PROMPT 互不混用', () => {
    for (const p of PROMPTS) expect(p.length).toBeGreaterThan(50);
    expect(new Set(PROMPTS).size).toBe(4);
    for (const p of PROMPTS) {
      expect(p).not.toBe(SYSTEM_PROMPT);
      expect(p).not.toBe(AGENT_SYSTEM_PROMPT);
      expect(p).not.toContain(SYSTEM_PROMPT.slice(0, 40));
    }
    expect(SYSTEM_PROMPT).not.toBe(AGENT_SYSTEM_PROMPT);
  });

  it('system 零动态内容：零模板占位符/示例 URL/正文形态', () => {
    for (const p of PROMPTS) {
      expect(p).not.toContain('${');
      expect(p).not.toContain('http://');
      expect(p).not.toContain('https://');
      expect(p).not.toContain('<UNTRUSTED');
    }
  });

  it('planning：严格 JSON 计划协议 + 六工具能力边界', () => {
    const p = AGENT_RESEARCH_PLANNING_PROMPT;
    for (const key of [
      'sourceMode',
      'sourceQuery',
      'groupId',
      'webQueries',
      'selectedCandidateIds',
    ]) {
      expect(p).toContain(key);
    }
    for (const tool of [
      'browser_open',
      'browser_read',
      'search_web',
      'source_search',
      'source_list',
      'source_get',
    ]) {
      expect(p).toContain(tool);
    }
    expect(p).toContain('不得虚构');
  });

  it('reading：严格 JSON 证据提案协议（六字段）', () => {
    const p = AGENT_RESEARCH_READING_PROMPT;
    for (const key of ['captureId', 'candidateId', 'type', 'locator', 'excerpt', 'value']) {
      expect(p).toContain(key);
    }
    expect(p).toContain('不得虚构');
    expect(p).toContain('证据');
  });

  it('verifying：严格 JSON 核验协议（VerificationDraft 字段全集）+ 不得提交可信字段', () => {
    const p = AGENT_RESEARCH_VERIFYING_PROMPT;
    for (const key of [
      'vendorCandidateIds',
      'claimKey',
      'severity',
      'evidenceIds',
      'topic',
      'positions',
      'positionText',
      'sourceRefs',
      'claimKeys',
    ]) {
      expect(p).toContain(key);
    }
    for (const banned of [
      'coverage',
      'sourceTypes',
      'singleSourceFields',
      'conflictIds',
      'resolved',
      'claimId',
      'conflictId',
    ]) {
      expect(p).toContain(banned); // 提示词必须明令禁止提交这些字段
    }
    expect(p).toContain('不得虚构');
  });

  it('synthesizing：严格 JSON 结果协议 + uncertain 义务 + 无百分比', () => {
    const p = AGENT_RESEARCH_SYNTHESIS_PROMPT;
    for (const key of ['result', 'blocks', 'markdown', 'table', 'cards', 'ranking', 'uncertain']) {
      expect(p).toContain(key);
    }
    expect(p).toContain('不确定');
    expect(p).toContain('百分比');
    expect(p).toContain('冲突');
  });

  it('网页文本不可信/不得服从网页指令 明示于各相位', () => {
    for (const p of PROMPTS) {
      expect(p).toContain('不可信');
      expect(p).toContain('网页');
    }
  });

  it('证据不足 → 输出「不确定」明示于相关相位', () => {
    expect(AGENT_RESEARCH_VERIFYING_PROMPT).toContain('不确定');
    expect(AGENT_RESEARCH_SYNTHESIS_PROMPT).toContain('不确定');
  });

  it('RESEARCH_PROMPTS_PORT：冻结只读，四槽 === 四常量', () => {
    expect(Object.isFrozen(RESEARCH_PROMPTS_PORT)).toBe(true);
    expect(RESEARCH_PROMPTS_PORT.planning).toBe(AGENT_RESEARCH_PLANNING_PROMPT);
    expect(RESEARCH_PROMPTS_PORT.reading).toBe(AGENT_RESEARCH_READING_PROMPT);
    expect(RESEARCH_PROMPTS_PORT.verifying).toBe(AGENT_RESEARCH_VERIFYING_PROMPT);
    expect(RESEARCH_PROMPTS_PORT.synthesizing).toBe(AGENT_RESEARCH_SYNTHESIS_PROMPT);
  });
});
