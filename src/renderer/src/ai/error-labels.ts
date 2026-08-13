// 归一化错误码 → 中文展示文案（§5.1 展示要点；与 main 侧 error-normalize 文案一致）。
// UI 仅按错误码映射展示，不解析供应商响应体（防供应商文本注入 UI 层，§5）。
import type { NormalizedErrorCode } from '../../../shared/types/conversation';

export const ERROR_CODE_LABELS: Record<NormalizedErrorCode, string> = {
  'not-configured': '尚未配置 AI Provider 或 API Key，请先在设置中配置',
  'invalid-key': 'API Key 无效或无权限，请检查设置',
  'rate-limit': '请求过于频繁，请稍后重试',
  timeout: '请求超时，请稍后重试',
  network: '网络连接失败，请检查网络与代理设置',
  'context-too-long': '内容超出模型限制，请新开会话或缩短问题',
  'provider-error': '服务请求失败，请稍后重试',
  aborted: '已中止',
  busy: '上一条回答还在生成中',
  'not-found': '会话不存在或已删除',
  internal: '内部错误，详情见日志',
};
