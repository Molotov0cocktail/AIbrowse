import type { TabGroupInfo, TabInfo } from '../../../shared/types/browser';

export type TabBarLayoutItem =
  { kind: 'group'; group: TabGroupInfo } | { kind: 'tab'; tab: TabInfo };

export function buildTabBarLayout(
  tabs: TabInfo[],
  groups: TabGroupInfo[] | undefined,
  userTabIds: string[] | undefined,
  activeTabId: string | null,
): TabBarLayoutItem[] {
  if (groups === undefined || userTabIds === undefined) {
    return tabs.map((tab) => ({ kind: 'tab', tab }));
  }

  const userTabs = new Set(userTabIds);
  const assigned = new Map<string, TabGroupInfo>();
  const members = new Map<string, TabInfo[]>();
  for (const group of groups) {
    const groupMembers: TabInfo[] = [];
    const declaredMembers = new Set(group.tabIds);
    for (const tab of tabs) {
      if (userTabs.has(tab.id) && declaredMembers.has(tab.id) && !assigned.has(tab.id)) {
        assigned.set(tab.id, group);
        groupMembers.push(tab);
      }
    }
    if (groupMembers.length > 0) members.set(group.id, groupMembers);
  }

  const emittedGroups = new Set<string>();
  const layout: TabBarLayoutItem[] = [];
  for (const tab of tabs) {
    const group = assigned.get(tab.id);
    if (group === undefined) {
      layout.push({ kind: 'tab', tab });
      continue;
    }
    if (emittedGroups.has(group.id)) continue;
    emittedGroups.add(group.id);
    layout.push({ kind: 'group', group });
    for (const member of members.get(group.id) ?? []) {
      if (!group.collapsed || member.id === activeTabId) layout.push({ kind: 'tab', tab: member });
    }
  }
  return layout;
}
