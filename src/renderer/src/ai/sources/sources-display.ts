// Sources 面板纯展示函数（B5）——可单测、零副作用。provenance 必须区分
// 「用户标定」与「AI 推断·未核验」（决议 #75）；分享模式三态中文说明（§8.2）；
// SourceErrorCode 十码中文文案；恢复态/不可用态中文原因与建议（决议 #74——建议仅用
// 「应用数据目录」等安全标签，renderer 不得获得绝对数据库/备份路径）；快速添加
// 结果中文文案（决议 #72）。note/name/tag 等文本仅作 React 纯文本渲染（决议 #78，
// 本模块输出字符串由组件以文本节点渲染，无 HTML/Markdown 解释）。
import type {
  QuickAddResult,
  SourceErrorCode,
  SourceShareMode,
  SourceTrust,
  SourceTrustValue,
  SourcesState,
} from '../../../../shared/types/sources';

export const TRUST_VALUE_LABELS: Record<SourceTrustValue, string> = {
  official: '官方来源',
  primary: '一手来源',
  secondary: '二手来源',
  community: '社区来源',
  unknown: '未知',
};

export function trustValueLabel(value: SourceTrustValue): string {
  return TRUST_VALUE_LABELS[value] ?? value;
}

// 决议 #75：provenance 展示必须区分来源
export function trustProvenanceLabel(trust: SourceTrust): string {
  return trust.assertedBy === 'user' ? '用户标定' : 'AI 推断·未核验';
}

export function trustFullLabel(trust: SourceTrust): string {
  return `${trustValueLabel(trust.value)}（${trustProvenanceLabel(trust)}）`;
}

export function shareModeLabel(mode: SourceShareMode): string {
  switch (mode) {
    case 'full':
      return '完整';
    case 'metadata':
      return '仅元数据';
    case 'blocked':
      return '对 AI 隐藏';
    default:
      return mode;
  }
}

export function shareModeDescription(mode: SourceShareMode): string {
  switch (mode) {
    case 'full':
      return '完整：备注可返回给 AI（供其长期使用）';
    case 'metadata':
      return '仅元数据：备注不会进入 AI 检索结果';
    case 'blocked':
      return '对 AI 隐藏：AI 检索与查看视同不存在（仅本界面可管理）';
    default:
      return mode;
  }
}

export const SOURCE_ERROR_LABELS: Record<SourceErrorCode, string> = {
  'source-invalid-change': '输入不合法',
  'source-version-conflict': '该信源已被其他操作修改，请刷新后重试',
  'source-duplicate': '该网址已存在于信源库（未重复添加）',
  'source-not-found': '信源不存在或已被删除',
  'source-forbidden': '该信源不可操作',
  'source-limit': '数量超出上限',
  'source-unavailable': '信源数据暂不可用',
  'source-conflict': '操作冲突，请重试',
  'source-undo-conflict': '该信源之后又有修改，无法撤销（不覆盖后续修改）',
  'source-undo-not-found': '该变更已撤销或不存在',
};

export function sourceErrorLabel(code: SourceErrorCode): string {
  return SOURCE_ERROR_LABELS[code] ?? code;
}

// 决议 #74：恢复态/不可用态诊断——中文原因 + 建议；normal 时无横幅。
export function describeSourcesState(state: SourcesState): string | null {
  if (state.mode === 'normal') return null;
  const prefix = state.mode === 'readonly-recovery' ? '信源系统处于只读恢复态' : '信源系统不可用';
  return state.reason === null ? `${prefix}。` : `${prefix}：${state.reason}`;
}

// 建议文案只含安全标签（无绝对路径——renderer 不得感知数据库/备份位置，决议 #74）。
export function sourcesStateAdvice(state: SourcesState): string {
  if (state.mode === 'normal') return '';
  if (state.mode === 'readonly-recovery') {
    return (
      '原因可能为数据库版本高于当前程序或数据损坏。请保留「应用数据目录」中的' +
      ' Sources 数据库与备份目录，升级或恢复前 Sources 读写均已停用（浏览器其余' +
      '功能不受影响）。'
    );
  }
  return (
    '信源数据库初始化失败，详情见日志。请保留「应用数据目录」中的 Sources ' +
    '数据库文件后重启应用；恢复前 Sources 读写均已停用（浏览器其余功能不受影响）。'
  );
}

export function quickAddResultMessage(result: QuickAddResult): string {
  switch (result.status) {
    case 'added':
      return `已添加：${result.source.name}`;
    case 'duplicate':
      return `已存在：${result.existing.name}（未重复添加）`;
    case 'no-active-page':
      return '当前没有活动标签页，无法快速添加';
    case 'unsupported-url':
      return '当前页面不是 http/https 网址，无法添加';
    case 'error':
      return `添加失败：${sourceErrorLabel(result.errorCode)}`;
  }
}

// 相关提示条目上限（决议 #72：同 origin 不同页面 ≤5 条）
export const QUICK_ADD_RELATED_TITLE = '可能相关（同站点其他收藏，未做任何修改）';
