// C8 决议 #158(4)：受控 UI send 通道 ui:browser-content-visible 的 payload 严格
// 白名单 fail-closed 边界（零 Electron import 纯逻辑——分层纪律与 view-visibility
// 同模式；index.ts 只做事件解包与依赖委托，语义恒等）。只接受当前 realm 普通对象
// 中精确存在一个自有 data property { visible: boolean }；未知字段/原型链键/非枚举
// 键/Symbol 键/accessor/array/null/primitive/非普通对象（Date/Map/class 实例/
// Object.create(null)/自定义原型）一律拒绝（fail-closed）。任何反射或属性检查异常
// 均转换为 { ok:false }，绝不对敌手载荷抛穿、绝不读取 accessor 值、绝不把载荷
// 原文/键名/属性值写入 warn（固定脱敏中文诊断）。

// 非法载荷固定脱敏诊断（不含 payload 原文、键名或属性值）。
export const INVALID_PAYLOAD_WARN = '忽略非法 content-visible 载荷';

// 拒绝非主窗口 IPC 消息的固定诊断（保留 sender/主帧校验语义）。
export const UNTRUSTED_SENDER_WARN = '拒绝非主窗口的 IPC 消息：ui:browser-content-visible';

// 校验边界：对任意 unknown 输入都不抛穿。反射/属性检查的所有异常一律 fail-closed
// 返回 { ok:false }。唯一合法载荷必须满足：
//   1. 对象原型恰为当前 realm 的 Object.prototype；
//   2. 完整自有键（Reflect.ownKeys——含非枚举字符串键与 Symbol 键）精确为一个
//      字符串键 'visible'；
//   3. 'visible' 是自有 data property（经属性描述符判断，不触发 getter/setter）；
//   4. 'visible' 的值严格为 boolean（true/false 均合法）。
export function validateUiBrowserContentVisiblePayload(
  raw: unknown,
): { ok: true; visible: boolean } | { ok: false } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false };

  // 原型必须恰为当前 realm 的 Object.prototype——拒绝自定义原型、Object.create(null)、
  // Date/Map/class 实例等非普通对象。任何反射异常（如 Proxy getPrototypeOf trap
  // 抛错）均 fail-closed。
  let proto: object | null;
  try {
    proto = Object.getPrototypeOf(raw);
  } catch {
    return { ok: false };
  }
  if (proto !== Object.prototype) return { ok: false };

  // 完整自有键集合（不信任 Object.keys——漏掉非枚举键与 Symbol 键；不信任对象
  // 字面量之外的原型链/继承属性）。任何反射异常（如 Proxy ownKeys trap 抛错）均
  // fail-closed。
  let ownKeys: (string | symbol)[];
  try {
    ownKeys = Reflect.ownKeys(raw);
  } catch {
    return { ok: false };
  }
  if (ownKeys.length !== 1 || ownKeys[0] !== 'visible') return { ok: false };

  // 经属性描述符区分 data property 与 accessor：accessor（getter/setter）拒绝，
  // 且不读取取值（getter 不会被执行、不会抛穿）。任何反射异常均 fail-closed。
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(raw, 'visible');
  } catch {
    return { ok: false };
  }
  if (descriptor === undefined || !('value' in descriptor)) return { ok: false };
  if (typeof descriptor.value !== 'boolean') return { ok: false };
  return { ok: true, visible: descriptor.value };
}

export interface UiBrowserContentVisibleHandlerDeps {
  isTrusted: boolean; // sender+主帧校验结果（index.ts 的 isTrustedSender）
  warn: (message: string) => void;
  setContentVisible: (visible: boolean) => void;
}

// 真实 IPC handler 边界的可单测等价实现：sender/主帧门 + payload 严格白名单门 +
// setContentVisible 恰好一次/零次。index.ts 的事件监听器只做事件解包后委托本函数
// （warn 注入 logWarn；isTrusted 注入 isTrustedSender(event, mainWindow) 结果；
// setContentVisible 注入 browserController?.setContentVisible），语义恒等。非法
// 载荷只产生固定脱敏 warn（零 payload stringify/raw interpolation/toString 调用），
// 不抛穿、零副作用。
export function handleUiBrowserContentVisible(
  payload: unknown,
  deps: UiBrowserContentVisibleHandlerDeps,
): void {
  if (!deps.isTrusted) {
    deps.warn(UNTRUSTED_SENDER_WARN);
    return;
  }
  const parsed = validateUiBrowserContentVisiblePayload(payload);
  if (!parsed.ok) {
    deps.warn(INVALID_PAYLOAD_WARN);
    return;
  }
  deps.setContentVisible(parsed.visible);
}
