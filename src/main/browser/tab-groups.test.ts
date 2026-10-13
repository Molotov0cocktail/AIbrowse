import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isCreateTabGroupPayload,
  isSetTabGroupPayload,
  isUpdateTabGroupPayload,
  TAB_GROUP_LIMIT,
} from '../../shared/tab-groups';
import { TabGroups } from './tab-groups';

function harness(count = 3) {
  const users = Array.from({ length: count }, () => randomUUID());
  return { users, groups: new TabGroups(() => users) };
}

describe('用户分组闭合参数', () => {
  const tabId = randomUUID();
  const valid = { tabId, name: ' 阅读 ', color: 'blue' };
  it('仅接受有界名称、枚举颜色和UUID，不接受未知字段或继承字段', () => {
    expect(isCreateTabGroupPayload(valid)).toBe(true);
    for (const value of [
      null,
      [],
      {},
      { ...valid, extra: true },
      { ...valid, tabId: 'user' },
      { ...valid, name: '' },
      { ...valid, name: ' '.repeat(5) },
      { ...valid, name: '字'.repeat(41) },
      { ...valid, name: '秘密\u0000' },
      { ...valid, name: '阅读\n' },
      { ...valid, name: '\u0085阅读' },
      { ...valid, color: 'url(script)' },
      Object.create(valid) as unknown,
    ]) {
      expect(isCreateTabGroupPayload(value)).toBe(false);
    }
    expect(
      isUpdateTabGroupPayload({ groupId: tabId, name: '阅读', color: 'grey', collapsed: false }),
    ).toBe(true);
    expect(
      isUpdateTabGroupPayload({ groupId: tabId, name: '阅读', color: 'grey', collapsed: 0 }),
    ).toBe(false);
    expect(isSetTabGroupPayload({ tabId, groupId: null })).toBe(true);
    expect(isSetTabGroupPayload({ tabId, groupId: undefined })).toBe(false);
    expect(isSetTabGroupPayload({ tabId, groupId: tabId, taskOwned: false })).toBe(false);
  });
});

describe('主进程内存分组', () => {
  it('任务及未知Tab不可创建或加入；失败不改变已有组', () => {
    const { users, groups } = harness();
    expect(groups.create({ tabId: users[0]!, name: ' 阅读 ', color: 'blue' })).toBe(true);
    const before = groups.snapshot();
    expect(before[0]?.name).toBe('阅读');
    const foreign = randomUUID();
    expect(groups.create({ tabId: foreign, name: '任务', color: 'red' })).toBe(false);
    expect(groups.set({ tabId: foreign, groupId: before[0]!.id })).toBe(false);
    expect(groups.set({ tabId: users[0]!, groupId: foreign })).toBe(false);
    expect(groups.snapshot()).toEqual(before);
  });

  it('加入、幂等加入、转移、移出和取消分组保留用户Tab；空组删除', () => {
    const { users, groups } = harness();
    groups.create({ tabId: users[0]!, name: '甲', color: 'blue' });
    groups.create({ tabId: users[1]!, name: '乙', color: 'red' });
    const second = groups.snapshot()[1]!;
    expect(groups.set({ tabId: users[0]!, groupId: second.id })).toBe(true);
    expect(groups.set({ tabId: users[0]!, groupId: second.id })).toBe(true);
    expect(groups.snapshot()).toEqual([{ ...second, tabIds: users.slice(0, 2) }]);
    expect(groups.set({ tabId: users[0]!, groupId: null })).toBe(true);
    expect(groups.snapshot()[0]?.tabIds).toEqual([users[1]]);
    expect(groups.ungroup(second.id)).toBe(true);
    expect(groups.snapshot()).toEqual([]);
    expect(users).toHaveLength(3);
  });

  it('组上限拒绝原子化，不能通过新建丢失原组', () => {
    const { users, groups } = harness(TAB_GROUP_LIMIT + 1);
    for (const tabId of users.slice(0, TAB_GROUP_LIMIT)) {
      expect(groups.create({ tabId, name: '分组', color: 'green' })).toBe(true);
    }
    const before = groups.snapshot();
    expect(groups.create({ tabId: users[0]!, name: '替代', color: 'purple' })).toBe(false);
    expect(groups.create({ tabId: users[TAB_GROUP_LIMIT]!, name: '新增', color: 'purple' })).toBe(
      false,
    );
    expect(groups.snapshot()).toEqual(before);
  });

  it('关闭与意外销毁成员清理空组，状态快照不共享可变引用', () => {
    const { users, groups } = harness();
    groups.create({ tabId: users[0]!, name: '甲', color: 'yellow' });
    const state = groups.snapshot();
    state[0]!.tabIds.push(users[2]!);
    state[0]!.name = '伪造';
    expect(groups.snapshot()[0]?.tabIds).toEqual([users[0]]);
    expect(groups.snapshot()[0]?.name).toBe('甲');
    users.shift();
    expect(groups.snapshot()).toEqual([]);
    expect(
      groups.update({ groupId: state[0]!.id, name: '关闭后', color: 'grey', collapsed: true }),
    ).toBe(false);
  });

  it('重命名换色折叠与清理仅修改元数据', () => {
    const { users, groups } = harness();
    groups.create({ tabId: users[0]!, name: '甲', color: 'blue' });
    const id = groups.snapshot()[0]!.id;
    expect(groups.update({ groupId: id, name: ' 已改名 ', color: 'purple', collapsed: true })).toBe(
      true,
    );
    expect(groups.snapshot()[0]).toEqual({
      id,
      name: '已改名',
      color: 'purple',
      collapsed: true,
      tabIds: [users[0]],
    });
    groups.clear();
    expect(groups.snapshot()).toEqual([]);
    expect(users).toHaveLength(3);
  });
});
