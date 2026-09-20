import type { Clock, TimerHandle } from '../../../shared/types/watch';
import type { QpcTicks, QualificationNativeBridge } from './native-contract';

const MAX_TICKS = 0x7fffffffffffffffn;

export function parseQpcTicks(value: QpcTicks): bigint {
  if (!/^[0-7][0-9a-f]{15}$/.test(value)) throw new Error('资格QPC格式无效');
  return BigInt(`0x${value}`);
}

export function formatQpcTicks(value: bigint): QpcTicks {
  if (value < 0n || value > MAX_TICKS) throw new Error('资格QPC范围无效');
  return value.toString(16).padStart(16, '0');
}

/** QPC is the only duration source; UTC is a fixed synthetic product timeline. */
export class QualificationQpcClock implements Clock {
  private lastTicks: bigint;
  private readonly anchor: bigint;
  constructor(
    private readonly native: Pick<QualificationNativeBridge, 'readQpc'>,
    readonly frequency: number,
    readonly anchorTicks: QpcTicks,
    readonly utcAnchorMs: number,
  ) {
    if (
      !Number.isSafeInteger(frequency) ||
      frequency <= 0 ||
      !Number.isSafeInteger(utcAnchorMs) ||
      utcAnchorMs < 0
    ) {
      throw new Error('资格QPC锚点无效');
    }
    this.anchor = parseQpcTicks(anchorTicks);
    this.lastTicks = this.anchor;
  }

  readTicks(): QpcTicks {
    const reading = this.native.readQpc();
    const ticks = parseQpcTicks(reading.ticks);
    if (reading.frequency !== this.frequency || ticks < this.lastTicks)
      throw new Error('资格QPC回退或频率变化');
    this.lastTicks = ticks;
    return reading.ticks;
  }

  elapsedMs(from: QpcTicks, to: QpcTicks): number {
    const delta = parseQpcTicks(to) - parseQpcTicks(from);
    if (delta < 0n || delta > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('资格QPC区间无效');
    return (Number(delta) * 1000) / this.frequency;
  }

  now(): Date {
    return new Date(this.utcAnchorMs + this.elapsedMs(this.anchorTicks, this.readTicks()));
  }

  ticksForUtc(ms: number): QpcTicks {
    if (!Number.isSafeInteger(ms)) throw new Error('资格时间无效');
    const numerator = BigInt(ms - this.utcAnchorMs) * BigInt(this.frequency);
    const offset = numerator >= 0n ? (numerator + 999n) / 1000n : numerator / 1000n;
    return formatQpcTicks(this.anchor + offset);
  }

  addMs(ticks: QpcTicks, ms: number): QpcTicks {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('资格截止时间无效');
    return formatQpcTicks(
      parseQpcTicks(ticks) + (BigInt(ms) * BigInt(this.frequency) + 999n) / 1000n,
    );
  }

  within(from: QpcTicks, to: QpcTicks, limitMs: number): boolean {
    const delta = parseQpcTicks(to) - parseQpcTicks(from);
    return delta >= 0n && (delta + 1n) * 1000n <= BigInt(limitMs) * BigInt(this.frequency);
  }

  setTimeout(callback: () => void, delayMs: number): TimerHandle {
    return { kind: 'timer', id: Number(globalThis.setTimeout(callback, Math.max(0, delayMs))) };
  }

  clearTimeout(handle: TimerHandle): void {
    globalThis.clearTimeout(handle.id);
  }
}
