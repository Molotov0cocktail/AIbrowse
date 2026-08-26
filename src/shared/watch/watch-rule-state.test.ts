// D2 watch-rule-state tests: WatchSchedule exact validator、feed/session 组合、
// WatchRule 状态迁移矩阵（enabled/paused/deleted、desiredEnabled、全 PauseReason）、
// Source 生命周期协调（rowVersion 与 locator fingerprint 分离、restore 恢复门）与
// locator fingerprint 公式（detailed-design §3.1/§5/§10.3，决议决策 7–12）。
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  coordinateSourceRule,
  computeSourceLocatorFingerprint,
  transitionRuleState,
  validateRuleAccessMode,
  validateWatchSchedule,
  type HealthPauseReason,
  type RuleDependencyStatus,
  type WatchRuleCoordinationFields,
  type WatchRuleStateFields,
} from './watch-rule-state';

function fields(over: Partial<WatchRuleStateFields> = {}): WatchRuleStateFields {
  return { state: 'enabled', pauseReason: null, desiredEnabled: true, ...over };
}

const DEPS_OK: RuleDependencyStatus = {
  sourceExists: true,
  sourceEnabled: true,
  locatorUnchanged: true,
};
const DEPS_SOURCE_DISABLED: RuleDependencyStatus = {
  sourceExists: true,
  sourceEnabled: false,
  locatorUnchanged: true,
};
const DEPS_LOCATOR_CHANGED: RuleDependencyStatus = {
  sourceExists: true,
  sourceEnabled: true,
  locatorUnchanged: false,
};
const DEPS_SOURCE_MISSING: RuleDependencyStatus = {
  sourceExists: false,
  sourceEnabled: false,
  locatorUnchanged: true,
};

function coords(over: Partial<WatchRuleCoordinationFields> = {}): WatchRuleCoordinationFields {
  return {
    state: 'enabled',
    pauseReason: null,
    desiredEnabled: true,
    sourceRowVersion: 1,
    sourceLocatorFingerprint: 'fp-v1',
    ...over,
  };
}

describe('validateWatchSchedule — exact own-key 形状', () => {
  it('合法 interval（15/60/360/1440）', () => {
    for (const m of [15, 60, 360, 1440]) {
      const r = validateWatchSchedule({ kind: 'interval', intervalMinutes: m });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.schedule).toEqual({ kind: 'interval', intervalMinutes: m });
    }
  });

  it('非法 interval 值拒绝', () => {
    for (const bad of [5, 30, 1441, 0, -1, 60.5, NaN, Infinity, '15', null]) {
      const r = validateWatchSchedule({ kind: 'interval', intervalMinutes: bad });
      expect(r.ok, `intervalMinutes=${String(bad)} 应拒绝`).toBe(false);
    }
  });

  it('合法 daily（HH:mm 边界 + IANA 时区）', () => {
    for (const t of ['00:00', '23:59', '09:05']) {
      const r = validateWatchSchedule({
        kind: 'daily',
        localTime: t,
        timeZone: 'Asia/Shanghai',
      });
      expect(r.ok).toBe(true);
    }
    const r = validateWatchSchedule({ kind: 'daily', localTime: '12:30', timeZone: 'UTC' });
    expect(r.ok).toBe(true);
  });

  it('非法 daily 时间/时区拒绝', () => {
    for (const bad of ['24:00', '23:60', '9:05', '0905', '', 'ab:cd', '12:30:00']) {
      const r = validateWatchSchedule({
        kind: 'daily',
        localTime: bad,
        timeZone: 'UTC',
      });
      expect(r.ok, `localTime=${bad} 应拒绝`).toBe(false);
    }
    for (const tz of ['Not/AZone', '', 'UTC+8', 'Asia/Shanghai/Oops']) {
      const r = validateWatchSchedule({ kind: 'daily', localTime: '09:00', timeZone: tz });
      expect(r.ok, `timeZone=${tz} 应拒绝`).toBe(false);
    }
  });

  it('额外键 / 缺键 / 错误类型拒绝（exact own-key）', () => {
    expect(validateWatchSchedule({ kind: 'interval', intervalMinutes: 60, extra: 1 }).ok).toBe(
      false,
    );
    expect(validateWatchSchedule({ kind: 'interval' }).ok).toBe(false);
    expect(validateWatchSchedule({ kind: 'daily', localTime: '09:00' }).ok).toBe(false);
    expect(
      validateWatchSchedule({ kind: 'daily', localTime: '09:00', timeZone: 'UTC', x: 1 }).ok,
    ).toBe(false);
    expect(validateWatchSchedule({ kind: 'interval', intervalMinutes: '60' }).ok).toBe(false);
    expect(validateWatchSchedule(null).ok).toBe(false);
    expect(validateWatchSchedule('interval').ok).toBe(false);
    expect(validateWatchSchedule([{ kind: 'interval', intervalMinutes: 60 }]).ok).toBe(false);
    expect(validateWatchSchedule(undefined).ok).toBe(false);
  });

  it('未来版本 / 未知 kind 拒绝（fail-closed）', () => {
    expect(validateWatchSchedule({ kind: 'weekly', intervalMinutes: 60 }).ok).toBe(false);
    expect(validateWatchSchedule({ kind: 'cron', localTime: '09:00', timeZone: 'UTC' }).ok).toBe(
      false,
    );
    expect(validateWatchSchedule({ kind: 'interval', intervalMinutes: 60, version: 2 }).ok).toBe(
      false,
    );
  });

  it('原型链字段拒绝（不读取继承属性）', () => {
    const proto = { kind: 'interval', intervalMinutes: 60 };
    const evil = Object.create(proto) as Record<string, unknown>;
    const r = validateWatchSchedule(evil);
    expect(r.ok).toBe(false); // 无自有键，不按原型链匹配
    // 非 Object.prototype 原型（自定义原型）一律拒绝（fail-closed）
    const custom = { kind: 'interval', intervalMinutes: 60 } as Record<string, unknown>;
    Object.setPrototypeOf(custom, { marker: 1 });
    expect(validateWatchSchedule(custom).ok).toBe(false);
    // 普通对象不受影响
    expect(validateWatchSchedule({ kind: 'interval', intervalMinutes: 60 }).ok).toBe(true);
  });
});

describe('validateRuleAccessMode — feed 仅 public；session 仅 page', () => {
  it('合法组合', () => {
    expect(validateRuleAccessMode('feed', 'public').ok).toBe(true);
    expect(validateRuleAccessMode('page', 'public').ok).toBe(true);
    expect(validateRuleAccessMode('page', 'session').ok).toBe(true);
  });

  it('非法组合/非法值拒绝', () => {
    expect(validateRuleAccessMode('feed', 'session').ok).toBe(false);
    expect(validateRuleAccessMode('feed', 'bogus').ok).toBe(false);
    expect(validateRuleAccessMode('page', 'bogus').ok).toBe(false);
    expect(validateRuleAccessMode('bogus', 'public').ok).toBe(false);
    expect(validateRuleAccessMode('', '').ok).toBe(false);
  });
});

describe('WatchRule 状态迁移 — 用户动作', () => {
  it('user-pause：任何非 deleted → paused/user/false', () => {
    expect(transitionRuleState(fields(), { kind: 'user-pause' }, DEPS_OK)).toEqual({
      state: 'paused',
      pauseReason: 'user',
      desiredEnabled: false,
    });
    const fromSourcePause = fields({ state: 'paused', pauseReason: 'source-disabled' });
    expect(transitionRuleState(fromSourcePause, { kind: 'user-pause' }, DEPS_OK)).toEqual({
      state: 'paused',
      pauseReason: 'user',
      desiredEnabled: false,
    });
  });

  it('user-pause 对 deleted 是 no-op（deleted 终态不可复活）', () => {
    const deleted = fields({ state: 'deleted', pauseReason: null, desiredEnabled: false });
    expect(transitionRuleState(deleted, { kind: 'user-pause' }, DEPS_OK)).toBe(deleted);
  });

  it('user-enable：paused(user) + 依赖满足 → enabled', () => {
    const r = transitionRuleState(
      fields({ state: 'paused', pauseReason: 'user', desiredEnabled: false }),
      { kind: 'user-enable' },
      DEPS_OK,
    );
    expect(r).toEqual({ state: 'enabled', pauseReason: null, desiredEnabled: true });
  });

  it('user-enable：依赖不满足不得进入 enabled，并按阻断依赖标原因', () => {
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'user', desiredEnabled: false }),
        { kind: 'user-enable' },
        DEPS_SOURCE_DISABLED,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true });
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'user', desiredEnabled: false }),
        { kind: 'user-enable' },
        DEPS_LOCATOR_CHANGED,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'source-changed', desiredEnabled: true });
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'user', desiredEnabled: false }),
        { kind: 'user-enable' },
        DEPS_SOURCE_MISSING,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true });
  });

  it('user-enable：依赖阻断原因暂停不被 enable 复活（desiredEnabled=true 记录意图）', () => {
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true }),
        { kind: 'user-enable' },
        DEPS_SOURCE_DISABLED,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true });
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'source-changed', desiredEnabled: true }),
        { kind: 'user-enable' },
        DEPS_LOCATOR_CHANGED,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'source-changed', desiredEnabled: true });
  });

  it('user-enable：健康/依赖原因（login-required/robots 等）不被普通 enable 解除（§7 用户无 override）', () => {
    for (const reason of [
      'login-required',
      'captcha',
      'parse-changed',
      'robots-disallowed',
      'security-rejected',
      'dependency-unavailable',
    ] as const) {
      const r = transitionRuleState(
        fields({ state: 'paused', pauseReason: reason, desiredEnabled: true }),
        { kind: 'user-enable' },
        DEPS_OK,
      );
      expect(r).toEqual({ state: 'paused', pauseReason: reason, desiredEnabled: true });
    }
  });

  it('user-enable：deleted no-op；enabled 幂等', () => {
    const deleted = fields({ state: 'deleted', pauseReason: null, desiredEnabled: false });
    expect(transitionRuleState(deleted, { kind: 'user-enable' }, DEPS_OK)).toBe(deleted);
    const enabled = fields();
    expect(transitionRuleState(enabled, { kind: 'user-enable' }, DEPS_OK)).toEqual(enabled);
  });
});

describe('WatchRule 状态迁移 — Source 生命周期（prepare 语义）', () => {
  it('source-disable：enabled → paused/source-disabled，desiredEnabled 保留', () => {
    expect(transitionRuleState(fields(), { kind: 'source-disable' }, DEPS_SOURCE_DISABLED)).toEqual(
      { state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true },
    );
  });

  it('source-disable：不覆盖用户 pause（desiredEnabled=false 保留）', () => {
    const userPaused = fields({ state: 'paused', pauseReason: 'user', desiredEnabled: false });
    expect(transitionRuleState(userPaused, { kind: 'source-disable' }, DEPS_SOURCE_DISABLED)).toBe(
      userPaused,
    );
  });

  it('source-disable：不覆盖其他依赖/健康原因', () => {
    const health = fields({ state: 'paused', pauseReason: 'login-required', desiredEnabled: true });
    expect(transitionRuleState(health, { kind: 'source-disable' }, DEPS_SOURCE_DISABLED)).toBe(
      health,
    );
  });

  it('source-delete / source-locator-change：对应原因暂停且 desiredEnabled 保留', () => {
    expect(transitionRuleState(fields(), { kind: 'source-delete' }, DEPS_SOURCE_MISSING)).toEqual({
      state: 'paused',
      pauseReason: 'source-deleted',
      desiredEnabled: true,
    });
    expect(
      transitionRuleState(fields(), { kind: 'source-locator-change' }, DEPS_LOCATOR_CHANGED),
    ).toEqual({ state: 'paused', pauseReason: 'source-changed', desiredEnabled: true });
  });

  it('source 动作对 deleted 恒 no-op', () => {
    const deleted = fields({ state: 'deleted', pauseReason: null, desiredEnabled: false });
    for (const action of [
      { kind: 'source-disable' },
      { kind: 'source-delete' },
      { kind: 'source-locator-change' },
      { kind: 'source-restore' },
    ] as const) {
      expect(transitionRuleState(deleted, action, DEPS_OK)).toBe(deleted);
    }
  });
});

describe('WatchRule 状态迁移 — source-restore（commit 语义）', () => {
  it('source-disabled + desiredEnabled=true + 依赖满足 → 自动 enabled', () => {
    const r = transitionRuleState(
      fields({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true }),
      { kind: 'source-restore' },
      DEPS_OK,
    );
    expect(r).toEqual({ state: 'enabled', pauseReason: null, desiredEnabled: true });
  });

  it('source-deleted + desiredEnabled=true + 依赖满足 → 自动 enabled', () => {
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'source-deleted', desiredEnabled: true }),
        { kind: 'source-restore' },
        DEPS_OK,
      ),
    ).toEqual({ state: 'enabled', pauseReason: null, desiredEnabled: true });
  });

  it('用户 pause（desiredEnabled=false）永不自动恢复', () => {
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: false }),
        { kind: 'source-restore' },
        DEPS_OK,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: false });
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'user', desiredEnabled: false }),
        { kind: 'source-restore' },
        DEPS_OK,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'user', desiredEnabled: false });
  });

  it('locator 改变（source-changed）不能被 restore 自动恢复', () => {
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'source-changed', desiredEnabled: true }),
        { kind: 'source-restore' },
        DEPS_OK,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'source-changed', desiredEnabled: true });
  });

  it('非 source 原因（健康/依赖）不被 restore 自动恢复；依赖不满足 no-op', () => {
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'login-required', desiredEnabled: true }),
        { kind: 'source-restore' },
        DEPS_OK,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'login-required', desiredEnabled: true });
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true }),
        { kind: 'source-restore' },
        DEPS_SOURCE_DISABLED,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true });
    expect(
      transitionRuleState(
        fields({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true }),
        { kind: 'source-restore' },
        DEPS_LOCATOR_CHANGED,
      ),
    ).toEqual({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true });
  });

  it('enabled 状态 restore no-op', () => {
    const enabled = fields();
    expect(transitionRuleState(enabled, { kind: 'source-restore' }, DEPS_OK)).toBe(enabled);
  });
});

describe('WatchRule 状态迁移 — health-pause 与 delete', () => {
  it('health-pause：enabled → paused/<reason>，desiredEnabled 保留', () => {
    for (const reason of [
      'login-required',
      'captcha',
      'parse-changed',
      'robots-disallowed',
      'security-rejected',
      'dependency-unavailable',
    ] as const) {
      const r = transitionRuleState(fields(), { kind: 'health-pause', reason }, DEPS_OK);
      expect(r).toEqual({ state: 'paused', pauseReason: reason, desiredEnabled: true });
    }
  });

  it('health-pause 对 deleted no-op', () => {
    const deleted = fields({ state: 'deleted', pauseReason: null, desiredEnabled: false });
    expect(transitionRuleState(deleted, { kind: 'health-pause', reason: 'captcha' }, DEPS_OK)).toBe(
      deleted,
    );
  });

  it('delete：任何状态 → deleted/null/false（终态）', () => {
    for (const start of [
      fields(),
      fields({ state: 'paused', pauseReason: 'user', desiredEnabled: false }),
      fields({ state: 'paused', pauseReason: 'source-changed', desiredEnabled: true }),
    ]) {
      expect(transitionRuleState(start, { kind: 'delete' }, DEPS_OK)).toEqual({
        state: 'deleted',
        pauseReason: null,
        desiredEnabled: false,
      });
    }
  });
});

describe('状态迁移 — 非修改性/冻结输入与 muted 正交', () => {
  it('深冻结输入运行后恒等（不修改、不抛）', () => {
    function deepFreeze<T>(value: T): T {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const k of Object.getOwnPropertyNames(value)) {
          deepFreeze((value as Record<string, unknown>)[k]);
        }
      }
      return value;
    }
    const frozen = deepFreeze(
      fields({ state: 'paused', pauseReason: 'source-disabled', desiredEnabled: true }),
    );
    const deps = deepFreeze({ ...DEPS_OK });
    const out = transitionRuleState(frozen, { kind: 'source-restore' }, deps);
    expect(out).toEqual({ state: 'enabled', pauseReason: null, desiredEnabled: true });
    expect(frozen).toEqual({
      state: 'paused',
      pauseReason: 'source-disabled',
      desiredEnabled: true,
    });
  });

  it('muted 不在状态字段内（调度资格与 muted 正交——结构断言）', () => {
    const rule = { ...fields(), muted: true };
    const out = transitionRuleState(
      { state: rule.state, pauseReason: rule.pauseReason, desiredEnabled: rule.desiredEnabled },
      { kind: 'source-disable' },
      DEPS_SOURCE_DISABLED,
    );
    expect('muted' in out).toBe(false);
    expect(rule.muted).toBe(true); // 输入未被修改
  });
});

describe('computeSourceLocatorFingerprint — §10.3 身份公式', () => {
  const input = {
    sourceId: 's1',
    scope: 'page' as const,
    canonicalKey: 'https://example.com/page',
    kind: 'page' as const,
    canonicalTargetUrl: 'https://example.com/page',
  };

  it('确定性 + 完整 SHA-256 hex（64 字符）', () => {
    const a = computeSourceLocatorFingerprint(input);
    const b = computeSourceLocatorFingerprint(input);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('公式与设计一致：SHA-256(utf8("watch-locator-v1\\0" + ...))', () => {
    const raw =
      'watch-locator-v1\u0000s1\u0000page\u0000https://example.com/page\u0000page\u0000https://example.com/page';
    const expected = createHash('sha256').update(raw, 'utf8').digest('hex');
    expect(computeSourceLocatorFingerprint(input)).toBe(expected);
  });

  it('任一定位分量变化改变指纹', () => {
    const base = computeSourceLocatorFingerprint(input);
    const variants = [
      { ...input, sourceId: 's2' },
      { ...input, scope: 'origin' as const },
      { ...input, canonicalKey: 'https://other.example/page' },
      { ...input, kind: 'feed' as const },
      { ...input, canonicalTargetUrl: 'https://example.com/other' },
    ];
    for (const v of variants) {
      expect(computeSourceLocatorFingerprint(v)).not.toBe(base);
    }
  });
});

describe('coordinateSourceRule — Source 提交/运行前协调（§10.3 步骤 4/5）', () => {
  it('仅 rowVersion 变化 + fingerprint 相同：只更新 sourceRowVersion，不暂停', () => {
    const rule = coords({ state: 'enabled', pauseReason: null, desiredEnabled: true });
    const r = coordinateSourceRule(rule, { exists: true, enabled: true, rowVersion: 7 }, 'fp-v1');
    expect(r.sourceRowVersion).toBe(7);
    expect(r.state).toBe('enabled');
    expect(r.pauseReason).toBeNull();
    expect(r.sourceLocatorFingerprint).toBe('fp-v1');
  });

  it('fingerprint 改变 → 暂停 source-changed（绝不误判为普通 rowVersion 变化）', () => {
    const rule = coords({ state: 'enabled', pauseReason: null, desiredEnabled: true });
    const r = coordinateSourceRule(rule, { exists: true, enabled: true, rowVersion: 7 }, 'fp-v2');
    expect(r.state).toBe('paused');
    expect(r.pauseReason).toBe('source-changed');
    expect(r.desiredEnabled).toBe(true);
    expect(r.sourceLocatorFingerprint).toBe('fp-v1'); // 旧指纹保留，等待 rebaseline
  });

  it('fingerprint 改变后 restore 不能自动恢复（协调层保持 source-changed）', () => {
    const rule = coords({
      state: 'paused',
      pauseReason: 'source-changed',
      desiredEnabled: true,
      sourceRowVersion: 3,
    });
    const r = coordinateSourceRule(rule, { exists: true, enabled: true, rowVersion: 4 }, 'fp-v2');
    expect(r.state).toBe('paused');
    expect(r.pauseReason).toBe('source-changed');
  });

  it('restore：指纹相同 + enabled + desiredEnabled=true + source 原因 → 自动 enabled', () => {
    const rule = coords({
      state: 'paused',
      pauseReason: 'source-disabled',
      desiredEnabled: true,
    });
    const r = coordinateSourceRule(rule, { exists: true, enabled: true, rowVersion: 5 }, 'fp-v1');
    expect(r.state).toBe('enabled');
    expect(r.pauseReason).toBeNull();
    expect(r.sourceRowVersion).toBe(5);
  });

  it('用户 pause（desiredEnabled=false）永不自动恢复（协调层保持暂停）', () => {
    const rule = coords({
      state: 'paused',
      pauseReason: 'source-disabled',
      desiredEnabled: false,
    });
    const r = coordinateSourceRule(rule, { exists: true, enabled: true, rowVersion: 5 }, 'fp-v1');
    expect(r.state).toBe('paused');
    expect(r.pauseReason).toBe('source-disabled');
    expect(r.desiredEnabled).toBe(false);
  });

  it('Source 不存在 → 暂停 source-deleted', () => {
    const rule = coords({ state: 'enabled', pauseReason: null, desiredEnabled: true });
    const r = coordinateSourceRule(rule, { exists: false, enabled: false, rowVersion: 2 }, 'fp-v1');
    expect(r.state).toBe('paused');
    expect(r.pauseReason).toBe('source-deleted');
    expect(r.desiredEnabled).toBe(true);
  });

  it('Source disabled（指纹相同）→ 暂停 source-disabled', () => {
    const rule = coords({ state: 'enabled', pauseReason: null, desiredEnabled: true });
    const r = coordinateSourceRule(rule, { exists: true, enabled: false, rowVersion: 4 }, 'fp-v1');
    expect(r.state).toBe('paused');
    expect(r.pauseReason).toBe('source-disabled');
  });

  it('deleted 规则协调 no-op', () => {
    const rule = coords({
      state: 'deleted',
      pauseReason: null,
      desiredEnabled: false,
    });
    expect(
      coordinateSourceRule(rule, { exists: true, enabled: true, rowVersion: 9 }, 'fp-v2'),
    ).toBe(rule);
  });
});

describe('HealthPauseReason 类型闭合', () => {
  it('health-pause reason 只接受健康/依赖原因（类型级闭合由编译期保证）', () => {
    const reasons: readonly HealthPauseReason[] = [
      'login-required',
      'captcha',
      'parse-changed',
      'robots-disallowed',
      'security-rejected',
      'dependency-unavailable',
    ];
    for (const reason of reasons) {
      const r = transitionRuleState(fields(), { kind: 'health-pause', reason }, DEPS_OK);
      expect(r.pauseReason).toBe(reason);
    }
  });
});
