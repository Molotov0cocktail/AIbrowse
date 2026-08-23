// Sixth Stage Watch shared types — D1 scope only (logger hardening + Clock base).
// Contract source: doc/stage6/detailed-design.md §2 (budget constants), §4.1 (Clock/TimeZone).
// D1 only owns: D1 日志预算常量 + Clock/TimerHandle/TimeZoneResolver 所需共享类型。
// D2 负责其余 Watch DTO、判别联合与预算常量；D1 不得提前落地 D2 域类型。
// 纯类型/常量声明：main/preload/renderer 可复用（verbatimModuleSyntax 下类型导入用 import type）。

/** D1 日志预算常量（detailed-design §2 单一事实源；字符串预算用 Buffer.byteLength('utf8')）。 */
export const MAX_LOG_LINE_BYTES = 8192;
export const MAX_LOG_FILE_BYTES = 10485760;
export const MAX_LOG_FILES = 10;
export const MAX_LOG_AGE_DAYS = 14;

/** 不透明 timer handle：只允许传回 clearTimeout，禁止对内部结构做任何操作。 */
export interface TimerHandle {
  readonly kind: 'timer';
  readonly id: number;
}

/** 可注入 Clock（detailed-design §4.1）：确定性时间与 timer 控制的唯一入口。 */
export interface Clock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** daily 计划时区解析（detailed-design §4.1）：计算 after 之后第一个有效本地时刻 instant。 */
export interface TimeZoneResolver {
  nextDailyInstant(input: {
    after: Date;
    localTime: string;
    timeZone: string;
    lastLocalDate: string | null;
  }): { instant: Date; localDate: string } | null;
}
