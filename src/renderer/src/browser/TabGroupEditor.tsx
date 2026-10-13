import { useEffect, useMemo, useState } from 'react';
import { TAB_GROUP_COLORS } from '../../../shared/tab-groups';
import type {
  CreateTabGroupPayload,
  SetTabGroupPayload,
  TabGroupColor,
  TabGroupInfo,
  TabInfo,
  UpdateTabGroupPayload,
} from '../../../shared/types/browser';
import './tab-groups.css';

const COLOR_LABELS: Record<TabGroupColor, string> = {
  grey: '灰色',
  blue: '蓝色',
  red: '红色',
  yellow: '黄色',
  green: '绿色',
  purple: '紫色',
};

interface TabGroupEditorProps {
  tabs: TabInfo[];
  groups: TabGroupInfo[];
  userTabIds: string[];
  selectedTabId: string;
  issue?: string | null;
  onClose: () => void;
  onSelectTab: (tabId: string) => void;
  onCreate: (payload: CreateTabGroupPayload) => void;
  onUpdate: (payload: UpdateTabGroupPayload) => void;
  onSetGroup: (payload: SetTabGroupPayload) => void;
  onUngroup: (groupId: string) => void;
}

function tabLabel(tab: TabInfo): string {
  return tab.title.trim() === '' ? '新标签页' : tab.title;
}

export function TabGroupEditor({
  tabs,
  groups,
  userTabIds,
  selectedTabId,
  issue = null,
  onClose,
  onSelectTab,
  onCreate,
  onUpdate,
  onSetGroup,
  onUngroup,
}: TabGroupEditorProps) {
  const userTabSet = useMemo(() => new Set(userTabIds), [userTabIds]);
  const userTabs = tabs.filter((tab) => userTabSet.has(tab.id));
  const selectedTab = userTabs.find((tab) => tab.id === selectedTabId) ?? userTabs[0] ?? null;
  const selectedGroup =
    selectedTab === null
      ? null
      : (groups.find((group) => group.tabIds.includes(selectedTab.id)) ?? null);
  const [name, setName] = useState(selectedGroup?.name ?? '新分组');
  const [color, setColor] = useState<TabGroupColor>(selectedGroup?.color ?? 'blue');

  useEffect(() => {
    setName(selectedGroup?.name ?? '新分组');
    setColor(selectedGroup?.color ?? 'blue');
  }, [selectedGroup?.id, selectedGroup?.name, selectedGroup?.color]);

  const normalizedName = name.trim();
  const validName = normalizedName.length >= 1 && normalizedName.length <= 40;

  return (
    <section className="tab-group-editor" aria-label="标签分组编辑器">
      <div className="tab-group-editor-heading">
        <div>
          <strong>{selectedGroup === null ? '创建新分组' : '编辑分组'}</strong>
          <span>右键标签页也可打开这里</span>
        </div>
        <button type="button" onClick={onClose} aria-label="关闭标签分组编辑器">
          ×
        </button>
      </div>

      <div className="tab-group-tab-list" aria-label="选择标签页">
        {userTabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            aria-pressed={tab.id === selectedTab?.id}
            title={tab.url}
            onClick={() => onSelectTab(tab.id)}
          >
            {tabLabel(tab)}
          </button>
        ))}
      </div>

      {issue !== null && (
        <p className="tab-group-editor-issue" role="alert">
          {issue}
        </p>
      )}

      {selectedTab === null ? (
        <p className="tab-group-empty">当前没有可分组的用户标签页。</p>
      ) : (
        <div className="tab-group-editor-controls">
          <label className="tab-group-name-field">
            <span>分组名称</span>
            <input
              value={name}
              maxLength={40}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>

          <fieldset className="tab-group-colors">
            <legend>颜色</legend>
            {TAB_GROUP_COLORS.map((option) => (
              <label key={option} title={COLOR_LABELS[option]}>
                <input
                  type="radio"
                  name="tab-group-color"
                  value={option}
                  checked={color === option}
                  onChange={() => setColor(option)}
                />
                <span className={`tab-group-color-swatch tab-group-color-${option}`} />
                <span>{COLOR_LABELS[option]}</span>
              </label>
            ))}
          </fieldset>

          <div className="tab-group-editor-actions">
            {selectedGroup === null ? (
              <button
                type="button"
                className="tab-group-primary-action"
                disabled={!validName}
                onClick={() => onCreate({ tabId: selectedTab.id, name: normalizedName, color })}
              >
                创建新分组
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="tab-group-primary-action"
                  disabled={!validName}
                  onClick={() =>
                    onUpdate({
                      groupId: selectedGroup.id,
                      name: normalizedName,
                      color,
                      collapsed: selectedGroup.collapsed,
                    })
                  }
                >
                  保存名称和颜色
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onUpdate({
                      groupId: selectedGroup.id,
                      name: selectedGroup.name,
                      color: selectedGroup.color,
                      collapsed: !selectedGroup.collapsed,
                    })
                  }
                >
                  {selectedGroup.collapsed ? '展开分组' : '折叠分组'}
                </button>
                <button
                  type="button"
                  onClick={() => onSetGroup({ tabId: selectedTab.id, groupId: null })}
                >
                  移出此标签
                </button>
                <button type="button" onClick={() => onUngroup(selectedGroup.id)}>
                  取消分组
                </button>
              </>
            )}
          </div>

          <div className="tab-group-existing-groups" aria-label="已有分组">
            {groups
              .filter((group) => group.id !== selectedGroup?.id)
              .map((group) => (
                <button
                  type="button"
                  key={group.id}
                  onClick={() => onSetGroup({ tabId: selectedTab.id, groupId: group.id })}
                >
                  <span className={`tab-group-dot tab-group-color-${group.color}`} />
                  {selectedGroup === null ? `加入“${group.name}”` : `移到“${group.name}”`}
                </button>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}
