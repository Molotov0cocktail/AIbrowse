import { randomUUID } from 'node:crypto';
import {
  isCreateTabGroupPayload,
  isSetTabGroupPayload,
  isTabGroupId,
  isUpdateTabGroupPayload,
  TAB_GROUP_LIMIT,
} from '../../shared/tab-groups';
import type {
  CreateTabGroupPayload,
  SetTabGroupPayload,
  TabGroupInfo,
  UpdateTabGroupPayload,
} from '../../shared/types/browser';

/** In-memory user-tab metadata. No navigation, persistence or page capabilities. */
export class TabGroups {
  private readonly groups = new Map<string, TabGroupInfo>();

  constructor(private readonly getUserTabIds: () => readonly string[]) {}

  snapshot(): TabGroupInfo[] {
    this.prune();
    const order = this.getUserTabIds();
    return [...this.groups.values()].map((group) => ({
      ...group,
      tabIds: order.filter((id) => group.tabIds.includes(id)),
    }));
  }

  create(payload: CreateTabGroupPayload): boolean {
    if (!isCreateTabGroupPayload(payload) || !this.getUserTabIds().includes(payload.tabId))
      return false;
    this.prune();
    if (this.groups.size >= TAB_GROUP_LIMIT) return false;
    this.removeMember(payload.tabId);
    const id = randomUUID();
    this.groups.set(id, {
      id,
      name: payload.name.trim(),
      color: payload.color,
      collapsed: false,
      tabIds: [payload.tabId],
    });
    return true;
  }

  update(payload: UpdateTabGroupPayload): boolean {
    if (!isUpdateTabGroupPayload(payload)) return false;
    this.prune();
    const group = this.groups.get(payload.groupId);
    if (group === undefined) return false;
    group.name = payload.name.trim();
    group.color = payload.color;
    group.collapsed = payload.collapsed;
    return true;
  }

  set(payload: SetTabGroupPayload): boolean {
    if (!isSetTabGroupPayload(payload) || !this.getUserTabIds().includes(payload.tabId))
      return false;
    this.prune();
    const target = payload.groupId === null ? null : this.groups.get(payload.groupId);
    if (target === undefined) return false;
    if (target?.tabIds.includes(payload.tabId)) return true;
    this.removeMember(payload.tabId);
    if (target !== null) target.tabIds.push(payload.tabId);
    return true;
  }

  ungroup(groupId: string): boolean {
    if (!isTabGroupId(groupId)) return false;
    this.prune();
    return this.groups.delete(groupId);
  }

  clear(): void {
    this.groups.clear();
  }

  private removeMember(tabId: string): void {
    for (const [id, group] of this.groups) {
      group.tabIds = group.tabIds.filter((member) => member !== tabId);
      if (group.tabIds.length === 0) this.groups.delete(id);
    }
  }

  private prune(): void {
    const users = new Set(this.getUserTabIds());
    for (const [id, group] of this.groups) {
      group.tabIds = group.tabIds.filter((member) => users.has(member));
      if (group.tabIds.length === 0) this.groups.delete(id);
    }
  }
}
