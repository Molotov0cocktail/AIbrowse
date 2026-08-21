// C8 决议 #158(4)：受控 UI send 通道 ui:browser-content-visible 的 payload 严格
// 白名单 fail-closed 边界（零 Electron import 纯逻辑——分层纪律与 view-visibility
// 同模式；index.ts 只做事件解包与依赖委托，语义恒等）。只接受普通对象中精确存在
// 一个自有字段 { visible: boolean }：未知字段/原型链键/array/null/primitive/错误
// 类型一律拒绝（fail-closed）——杜绝 extra fields 与原型链继承属性进入
// setContentVisible。

// 普通对象：typeof 'object' 且非 null 且非 array（拒绝 [true] 及带 visible 属性
// 的 array）。
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// 精确自有字段集合（不信任对象字面量之外的原型链/继承属性）。
function ownKeys(v: Record<string, unknown>): string[] {
  return Object.keys(v);
}

export function validateUiBrowserContentVisiblePayload(
  raw: unknown,
): { ok: true; visible: boolean } | { ok: false } {
  if (!isPlainRecord(raw)) return { ok: false };
  const keys = ownKeys(raw);
  // 精确一个自有字段且为 visible（未知字段 → 拒绝；extra field → 拒绝）
  if (keys.length !== 1 || keys[0] !== 'visible') return { ok: false };
  const visible = raw['visible'];
  if (typeof visible !== 'boolean') return { ok: false };
  return { ok: true, visible };
}

export interface UiBrowserContentVisibleHandlerDeps {
  isTrusted: boolean; // sender+主帧校验结果（index.ts 的 isTrustedSender）
  warn: (message: string) => void;
  setContentVisible: (visible: boolean) => void;
}

// 真实 IPC handler 边界的可单测等价实现：sender/主帧门 + payload 严格白名单门 +
// setContentVisible 恰好一次/零次。index.ts 的事件监听器只做事件解包后委托本函数
// （warn 注入 logWarn；isTrusted 注入 isTrustedSender(event, mainWindow) 结果；
// setContentVisible 注入 browserController?.setContentVisible），语义恒等。
export function handleUiBrowserContentVisible(
  payload: unknown,
  deps: UiBrowserContentVisibleHandlerDeps,
): void {
  if (!deps.isTrusted) {
    deps.warn('拒绝非主窗口的 IPC 消息：ui:browser-content-visible');
    return;
  }
  const parsed = validateUiBrowserContentVisiblePayload(payload);
  if (!parsed.ok) {
    deps.warn(`忽略非法 content-visible 载荷：${String(payload)}`);
    return;
  }
  deps.setContentVisible(parsed.visible);
}
