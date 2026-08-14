// source-change-set structure validation unit tests (B2): field whitelist, lengths,
// enums, URL shape, trust channel rules, defaults (adjudication #52), fingerprint.
import { describe, expect, it } from 'vitest';
import {
  computeChangeSetFingerprint,
  stripControlChars,
  validateChangeSet,
  validateManualAddInput,
  validateManualPatch,
} from './source-change-set';

const addOp = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: 'add',
  scope: 'page',
  url: 'https://example.com/p',
  ...over,
});

describe('validateChangeSet — 结构边界', () => {
  it('非数组 → source-invalid-change', () => {
    const r = validateChangeSet('not-an-array');
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('source-invalid-change');
  });

  it('0 项与 21 项 → source-limit；1 与 20 项 → 合法', () => {
    expect(validateChangeSet({ ops: [] }).errorCode).toBe('source-limit');
    expect(validateChangeSet({ ops: Array.from({ length: 21 }, () => addOp()) }).errorCode).toBe(
      'source-limit',
    );
    expect(validateChangeSet({ ops: [addOp()] }).ok).toBe(true);
    expect(
      validateChangeSet({
        ops: Array.from({ length: 20 }, () => addOp({ url: `https://e.com/${Math.random()}` })),
      }).ok,
    ).toBe(true);
  });

  it('未知 op kind → source-invalid-change', () => {
    const r = validateChangeSet({ ops: [{ kind: 'delete', sourceId: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('source-invalid-change');
  });
});

describe('validateChangeSet — add op', () => {
  it('缺 scope/url → 该 op invalid-change', () => {
    const r = validateChangeSet({ ops: [{ kind: 'add', url: 'https://e.com' }] });
    expect(r.ok).toBe(false);
    expect(r.opErrors[0]).toBe('source-invalid-change');
  });

  it('URL 非法（ftp/userinfo/控制字符）→ invalid-change', () => {
    for (const url of ['ftp://e.com', 'https://u:p@e.com', 'https://e.com/	x']) {
      const r = validateChangeSet({ ops: [addOp({ url })] });
      expect(r.ok, url).toBe(false);
    }
  });

  it('缺省冻结：name 默认生成 / priority 3 / shareMode 按 userNote / tags [] / group null / trust ai+unverified', () => {
    const r = validateChangeSet({ ops: [addOp()] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const op = r.ops[0] as {
        kind: 'add';
        name?: string;
        priority?: number;
        shareMode?: string;
        tags?: string[];
        trust?: unknown;
      };
      expect(op.name).toBe('example.com/p');
      expect(op.priority).toBe(3);
      expect(op.shareMode).toBe('metadata');
      expect(op.tags).toEqual([]);
      expect(op.trust).toEqual({ value: 'unknown', assertedBy: 'ai', verification: 'unverified' });
    }
  });

  it('userNote 非空 → shareMode 缺省 full', () => {
    const r = validateChangeSet({ ops: [addOp({ userNote: '备注' })] });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.ops[0] as { shareMode?: string }).shareMode).toBe('full');
  });

  it('模型不能设 blocked（决议 #36）→ invalid-change', () => {
    const r = validateChangeSet({ ops: [addOp({ shareMode: 'blocked' })] });
    expect(r.ok).toBe(false);
  });

  it('trust：assertedBy=user 拒绝；ai+official → verification 恒 unverified', () => {
    expect(
      validateChangeSet({ ops: [addOp({ trust: { value: 'official', assertedBy: 'user' } })] }).ok,
    ).toBe(false);
    const r = validateChangeSet({
      ops: [addOp({ trust: { value: 'official', assertedBy: 'ai' } })],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect((r.ops[0] as { trust?: unknown }).trust).toEqual({
        value: 'official',
        assertedBy: 'ai',
        verification: 'unverified',
      });
    }
  });

  it('未知字段（白名单外）→ invalid-change', () => {
    expect(validateChangeSet({ ops: [addOp({ extra: 1 })] }).ok).toBe(false);
  });

  it('长度边界：name 201 拒绝 / tag 33 拒绝 / tags 21 个拒绝 / groupName 65 拒绝 / note 2001 截断到 2000', () => {
    expect(validateChangeSet({ ops: [addOp({ name: 'x'.repeat(201) })] }).ok).toBe(false);
    expect(validateChangeSet({ ops: [addOp({ tags: ['x'.repeat(33)] })] }).ok).toBe(false);
    expect(
      validateChangeSet({ ops: [addOp({ tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })] })
        .ok,
    ).toBe(false);
    expect(validateChangeSet({ ops: [addOp({ groupName: 'g'.repeat(65) })] }).ok).toBe(false);
    const r = validateChangeSet({ ops: [addOp({ userNote: 'x'.repeat(2001) })] });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.ops[0] as { userNote?: string }).userNote).toHaveLength(2000);
  });

  it('tag 归一化：trim + NFC + 去重（保持首现）+ 空串丢弃', () => {
    // 'tagué'（分解形态 e+组合重音）NFC 后与 'tagué'（预组合）同串 → 去重
    const r = validateChangeSet({
      ops: [addOp({ tags: ['  TagOne ', 'tagué', 'tagué', '  ', 'TagOne'] })],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.ops[0] as { tags?: string[] }).tags).toEqual(['TagOne', 'tagué']);
  });

  it('priority 枚举：0/6/1.5/字符串 → invalid-change', () => {
    for (const p of [0, 6, 1.5, '3', null]) {
      expect(validateChangeSet({ ops: [addOp({ priority: p })] }).ok, String(p)).toBe(false);
    }
  });

  it('控制字符剔除（name/note 中 C0/bidi/零宽移除、\\t 保留）', () => {
    const r = validateChangeSet({ ops: [addOp({ name: 'a‮b\tc', userNote: 'n​x' })] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const op = r.ops[0] as { name?: string; userNote?: string };
      expect(op.name).toBe('ab\tc'); // bidi 剔除、\t 保留（logger 家族规则）
      expect(op.userNote).toBe('nx');
    }
  });

  it('groupName 空串 → 视为未提供（不建组）', () => {
    const r = validateChangeSet({ ops: [addOp({ groupName: '  ' })] });
    expect(r.ok).toBe(true);
  });
});

describe('validateChangeSet — update/disable/restore op', () => {
  const srcId = '11111111-1111-4111-8111-111111111111';

  it('patch 字段白名单：未知字段与 enabled 均拒绝（决议 #51）', () => {
    expect(
      validateChangeSet({
        ops: [{ kind: 'update', sourceId: srcId, expectedVersion: 1, patch: { extra: 1 } }],
      }).ok,
    ).toBe(false);
    expect(
      validateChangeSet({
        ops: [{ kind: 'update', sourceId: srcId, expectedVersion: 1, patch: { enabled: false } }],
      }).ok,
    ).toBe(false);
  });

  it('空 patch → invalid-change', () => {
    expect(
      validateChangeSet({
        ops: [{ kind: 'update', sourceId: srcId, expectedVersion: 1, patch: {} }],
      }).ok,
    ).toBe(false);
  });

  it('patch.url 变更需重新规范化（展示 URL 保留 fragment；canonicalKey 由 service 按实际 scope 计算）；非法 URL 拒绝', () => {
    const r = validateChangeSet({
      ops: [
        {
          kind: 'update',
          sourceId: srcId,
          expectedVersion: 1,
          patch: { url: 'HTTPS://Example.COM:443/b#f' },
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const op = r.ops[0] as { patch: { url?: string } };
      expect(op.patch.url).toBe('https://example.com/b#f');
    }
    expect(
      validateChangeSet({
        ops: [{ kind: 'update', sourceId: srcId, expectedVersion: 1, patch: { url: 'ftp://x' } }],
      }).ok,
    ).toBe(false);
  });

  it('update trust 通道规则同 add（user 拒绝、ai 恒 unverified）', () => {
    const bad = validateChangeSet({
      ops: [
        {
          kind: 'update',
          sourceId: srcId,
          expectedVersion: 1,
          patch: { trust: { value: 'official', assertedBy: 'user' } },
        },
      ],
    });
    expect(bad.ok).toBe(false);
  });

  it('patch.groupName=null → 移出分组（合法）；patch 全字段类型校验', () => {
    const r = validateChangeSet({
      ops: [
        {
          kind: 'update',
          sourceId: srcId,
          expectedVersion: 2,
          patch: {
            groupName: null,
            tags: ['a'],
            priority: 4,
            shareMode: 'full',
            userNote: 'n',
            aiNote: 'm',
            name: 'x',
            url: 'https://e.com/q',
          },
        },
      ],
    });
    expect(r.ok).toBe(true);
    expect(
      validateChangeSet({
        ops: [{ kind: 'update', sourceId: srcId, expectedVersion: 1, patch: { priority: 9 } }],
      }).ok,
    ).toBe(false);
    expect(
      validateChangeSet({
        ops: [
          { kind: 'update', sourceId: srcId, expectedVersion: 1, patch: { shareMode: 'blocked' } },
        ],
      }).ok,
    ).toBe(false);
  });

  it('disable/restore：sourceId UUID 形状 + expectedVersion 正整数', () => {
    expect(
      validateChangeSet({ ops: [{ kind: 'disable', sourceId: srcId, expectedVersion: 1 }] }).ok,
    ).toBe(true);
    expect(
      validateChangeSet({ ops: [{ kind: 'restore', sourceId: srcId, expectedVersion: 1 }] }).ok,
    ).toBe(true);
    expect(
      validateChangeSet({ ops: [{ kind: 'disable', sourceId: 'not-uuid', expectedVersion: 1 }] })
        .ok,
    ).toBe(false);
    expect(
      validateChangeSet({ ops: [{ kind: 'disable', sourceId: srcId, expectedVersion: 0 }] }).ok,
    ).toBe(false);
    expect(
      validateChangeSet({ ops: [{ kind: 'disable', sourceId: srcId, expectedVersion: 1.5 }] }).ok,
    ).toBe(false);
    expect(
      validateChangeSet({ ops: [{ kind: 'disable', sourceId: srcId, expectedVersion: '1' }] }).ok,
    ).toBe(false);
  });

  it('同 set 重复 sourceId（update/disable/restore）→ invalid-change 整体拒绝', () => {
    const r = validateChangeSet({
      ops: [
        { kind: 'update', sourceId: srcId, expectedVersion: 1, patch: { name: 'a' } },
        { kind: 'disable', sourceId: srcId, expectedVersion: 1 },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('source-invalid-change');
  });

  it('opErrors 逐项对齐（混合集合中仅坏 op 被标记）', () => {
    const r = validateChangeSet({
      ops: [addOp({ url: 'ftp://bad' }), addOp()],
    });
    expect(r.ok).toBe(false);
    expect(r.opErrors[0]).toBe('source-invalid-change');
    expect(r.opErrors[1]).toBeNull();
  });
});

describe('computeChangeSetFingerprint — 确定性哈希', () => {
  it('同 ops 同哈希；字段值不同/顺序不同 → 不同哈希', () => {
    const v = validateChangeSet({
      ops: [addOp(), { kind: 'add', scope: 'origin', url: 'https://example.org' }],
    });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const h1 = computeChangeSetFingerprint(v.ops);
    expect(computeChangeSetFingerprint(v.ops)).toBe(h1); // 确定性
    const v2 = validateChangeSet({
      ops: [addOp(), { kind: 'add', scope: 'origin', url: 'https://example.net' }],
    });
    expect(v2.ok).toBe(true);
    if (v2.ok) expect(computeChangeSetFingerprint(v2.ops)).not.toBe(h1);
    const v3 = validateChangeSet({
      ops: [{ kind: 'add', scope: 'origin', url: 'https://example.org' }, addOp()],
    });
    expect(v3.ok).toBe(true);
    if (v3.ok) expect(computeChangeSetFingerprint(v3.ops)).not.toBe(h1);
  });
});

describe('stripControlChars — 剔除规则（对齐 logger 家族）', () => {
  it('C0/DEL/bidi/零宽/BOM 剔除、\\t 保留、普通文本原样', () => {
    expect(stripControlChars('a\nb\rc\0de‮f​g﻿h')).toBe('abcdefgh');
    expect(stripControlChars('中\t文')).toBe('中\t文');
    expect(stripControlChars('普通 text-123')).toBe('普通 text-123');
  });
});

describe('validateManualAddInput / validateManualPatch — 手工通道', () => {
  it('手工可设 blocked；trust {value} → user/asserted；缺省 trust user/asserted', () => {
    const r = validateManualAddInput({
      scope: 'origin',
      url: 'https://example.com',
      shareMode: 'blocked',
      trust: { value: 'official' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.input!.shareMode).toBe('blocked');
      expect(r.input!.trust).toEqual({
        value: 'official',
        assertedBy: 'user',
        verification: 'asserted',
      });
    }
    const d = validateManualAddInput({ scope: 'origin', url: 'https://example.com' });
    expect(d.ok).toBe(true);
    if (d.ok)
      expect(d.input!.trust).toEqual({
        value: 'unknown',
        assertedBy: 'user',
        verification: 'asserted',
      });
  });

  it('手工非法输入安全返回（坏 URL/未知字段/超长）', () => {
    expect(validateManualAddInput({ scope: 'origin', url: 'ftp://x' }).ok).toBe(false);
    expect(validateManualAddInput({ scope: 'origin', url: 'https://e.com', extra: 1 }).ok).toBe(
      false,
    );
    expect(validateManualAddInput({ scope: 'origin', url: 'https://e.com', priority: 7 }).ok).toBe(
      false,
    );
  });

  it('patch：空对象拒绝；blocked 允许；未知字段拒绝；groupName null 合法', () => {
    expect(validateManualPatch({}).ok).toBe(false);
    expect(validateManualPatch({ shareMode: 'blocked' }).ok).toBe(true);
    expect(validateManualPatch({ enabled: false }).ok).toBe(false);
    expect(validateManualPatch({ groupName: null }).ok).toBe(true);
  });
});
