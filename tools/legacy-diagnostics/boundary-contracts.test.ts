import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAddressBarInput } from '../../src/shared/url';
import { openSourcesStore } from '../../src/main/sources/sources-store';
import { pageLocatorKey, safeProjectionUrl } from '../../src/main/watch/page-projector';
import {
  verifyEvidence,
  type EvidenceVerifyInput,
} from '../../src/main/research/evidence-validator';

describe('遗留边界的实际反例', () => {
  it('不同query目标脱敏后投影URL相同，不能仅凭旧投影恢复历史目标', () => {
    const first = 'https://example.invalid/report?account=one';
    const second = 'https://example.invalid/report?account=two';
    expect(pageLocatorKey(first)).not.toBe(pageLocatorKey(second));
    expect(safeProjectionUrl(first)).toBe('https://example.invalid/report');
    expect(safeProjectionUrl(second)).toBe(safeProjectionUrl(first));
  });

  it('引用存在性校验接受脱离否定上下文的真实子串，但拒绝捏造的摘录', () => {
    const url = 'https://example.invalid/evidence';
    const section = '没有证据能证明产品安全，不应把这句话解释为安全结论。';
    const input: EvidenceVerifyInput = {
      proposal: {
        captureId: 'capture-1',
        candidateId: 'candidate-1',
        type: 'quote',
        locator: { kind: 'text', excerpt: '产品安全' },
        excerpt: '产品安全',
        value: null,
      },
      evidenceId: 'evidence-1',
      taskId: 'task-1',
      captures: [
        {
          captureId: 'capture-1',
          taskId: 'task-1',
          candidateId: 'candidate-1',
          tabId: 'tab-1',
          url,
          title: '合成证据',
          accessTime: '2026-10-12T00:00:00.000Z',
          documentId: '1',
          contentHash: 'a'.repeat(64),
          summary: { sectionCount: 1, tableCount: 0, headingCount: 0, charCount: section.length },
          failed: false,
          failureReason: null,
        },
      ],
      candidates: [
        {
          id: 'candidate-1',
          url,
          displayUrl: url,
          canonicalKey: url,
          title: '合成证据',
          scope: 'page',
          discoveredVia: ['sources'],
          sourceId: 'source-1',
          trust: { value: 'unknown', assertedBy: 'ai', verification: 'unverified' },
          priority: null,
          lastUsedAt: null,
          note: null,
          sortKey: 'fixed',
        },
      ],
      contents: new Map([
        [
          'capture-1',
          {
            captureId: 'capture-1',
            canonicalText: section,
            textSections: [section],
            tables: [],
            fields: {},
          },
        ],
      ]),
    };
    expect(verifyEvidence(input).ok).toBe(true);
    expect(
      verifyEvidence({
        ...input,
        proposal: {
          captureId: 'capture-1',
          candidateId: 'candidate-1',
          type: 'quote',
          locator: { kind: 'text', excerpt: '已经全面验证' },
          excerpt: '已经全面验证',
          value: null,
        },
      }),
    ).toMatchObject({ ok: false, code: 'excerpt-not-in-content' });
  });

  it('修复后未加协议与完整 HTTPS 中文域名都可规范化', () => {
    expect(resolveAddressBarInput('例子.测试')).toBe('https://xn--fsqu00a.xn--0zwm56d/');
    expect(resolveAddressBarInput('https://例子.测试/')).toBe('https://xn--fsqu00a.xn--0zwm56d/');
    expect(resolveAddressBarInput('xn--fsqu00a.xn--0zwm56d')).toBe(
      'https://xn--fsqu00a.xn--0zwm56d/',
    );
  });

  it('真实信源服务写入的合成备注在 SQLite 原始字节中可读，blocked 仍不对 AI 开放', async () => {
    // Keep the synthetic database as diagnostic evidence; never open a user profile.
    const evidenceRoot = resolve('log/legacy-diagnosis-20261012/boundaries');
    mkdirSync(evidenceRoot, { recursive: true });
    const root = mkdtempSync(join(evidenceRoot, 'plaintext-'));
    const dbPath = join(root, 'sources.db');
    const canary = `SYNTHETIC_NOTE_${randomUUID()}`;
    const outcome = openSourcesStore({ dbPath, backupsDir: join(root, 'backups') });
    expect(outcome.mode).toBe('normal');
    if (outcome.mode !== 'normal') throw new Error('合成信源库装配失败');
    try {
      const created = await outcome.service.addManual({
        scope: 'page',
        url: 'https://example.invalid/diagnostic',
        name: '合成隐私边界',
        userNote: canary,
        shareMode: 'blocked',
      });
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error('合成信源创建失败');
      const userView = await outcome.service.get(created.source.id, 'user');
      expect(userView.ok && userView.source.userNote).toBe(canary);
      const agentView = await outcome.service.get(created.source.id, 'agent');
      expect(agentView.ok).toBe(false);
    } finally {
      outcome.service.dispose();
    }
    const bytes = readFileSync(dbPath);
    expect(bytes.subarray(0, 16).toString()).toBe('SQLite format 3\0');
    expect(bytes.includes(Buffer.from(canary))).toBe(true);
  });
});
