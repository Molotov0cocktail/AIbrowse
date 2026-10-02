import { object, number, string, boolean, type RawObservation } from './read-evidence.ts';
import { inWindow, ticks, validateWindow, type Verdict, type Window } from './resource-report.ts';

interface Cell {
  identity: string;
  capacity: number;
  full: number;
}
export interface BatterySlot {
  classification:
    'on-battery' | 'ac-or-charging' | 'no-system-battery' | 'condition-unavailable' | 'invalid';
  cells: Cell[];
  reason: string | null;
}
export interface BatteryReport {
  verdict: Verdict;
  classification: string;
  validSlots: number;
  missingSlots: number[];
  startSlot: number | null;
  endSlot: number | null;
  elapsedSeconds: number | null;
  averageWatts: number | null;
  percentagePointsPerHour: number | null;
  reasons: string[];
}

const has = (value: number, bit: number): boolean => (value & bit) !== 0;
function uint32(value: unknown): number {
  const result = number(value);
  if (result > 0xffffffff) throw new Error('设备计数超出uint32');
  return result;
}

/** Only device capacity is the energy counter; rate is a consistency check. */
export function classifyBattery(row: RawObservation): BatterySlot {
  const invalid = (reason: string): BatterySlot => ({
    classification: 'invalid',
    cells: [],
    reason,
  });
  const unavailable = (reason: string): BatterySlot => ({
    classification: 'condition-unavailable',
    cells: [],
    reason,
  });
  try {
    if (row.status !== 'ok' || row.enumerationComplete !== true || row.cleanupComplete !== true)
      return invalid('设备枚举、采集或清理未完整成功');
    const system = object(row.system);
    const ac = uint32(system.acLineStatus),
      flag = uint32(system.batteryFlag),
      percent = uint32(system.batteryLifePercent);
    if (
      ![0, 1].includes(ac) ||
      flag === 255 ||
      (flag & ~143) !== 0 ||
      (has(flag, 1) && (has(flag, 2) || has(flag, 4)))
    )
      return invalid('系统电源字段矛盾');
    if (percent > 100 && percent !== 255) return invalid('系统百分比越界');
    if (!Array.isArray(row.ports) || row.ports.length > 64) return invalid('电池端口集合无效');
    const identities = new Set<string>();
    const present: { cell: Cell; state: number; rateSign: string }[] = [];
    let unsupported = false;
    for (const raw of row.ports) {
      const port = object(raw);
      const instance = string(port.instanceSha256);
      if (!/^[0-9a-f]{64}$/.test(instance) || identities.has(instance))
        return invalid('重复或无效电池身份');
      identities.add(instance);
      const tag = uint32(port.tag);
      const success = boolean(port.tagSuccess);
      const error = uint32(port.tagError);
      uint32(port.tagReturnedBytes);
      if (port.status === 'documented-absence') {
        if (success || error !== 2 || tag !== 0) return invalid('未满足文档化空端口条件');
        continue;
      }
      if (
        port.status !== 'present' ||
        !success ||
        error !== 0 ||
        tag === 0 ||
        port.tagReturnedBytes !== 4
      )
        return invalid('tag取得失败或协议错误');
      if (
        port.informationReturnedBytes !== 36 ||
        port.statusReturnedBytes !== 16 ||
        port.queryTagInputBytes !== 4 ||
        port.queryInformationInputBytes !== 12 ||
        port.queryStatusInputBytes !== 20 ||
        port.detailStructBytes !== 8 ||
        number(port.detailRequiredBytes) < 8
      )
        return invalid('设备API结构尺寸错误');
      const capabilities = uint32(port.capabilities);
      const state = uint32(port.powerState);
      const capacity = uint32(port.capacityMWh),
        full = uint32(port.fullChargedCapacityMWh);
      if (
        !has(capabilities, 0x80000000) ||
        has(capabilities, 0x20000000) ||
        has(capabilities, 0x40000000) ||
        full === 0 ||
        full === 0xffffffff ||
        capacity === 0xffffffff ||
        capacity > full
      )
        unsupported = true;
      if ((state & ~15) !== 0 || (has(state, 2) && has(state, 4)))
        return invalid('电池电源状态矛盾');
      const rateKnown = boolean(port.rateKnown);
      const rateSign = string(port.rateSign);
      if (
        !['negative', 'zero', 'positive', 'unknown'].includes(rateSign) ||
        (!rateKnown && (rateSign !== 'unknown' || port.absoluteRateMW !== null)) ||
        (rateKnown &&
          (rateSign === 'unknown' ||
            number(port.absoluteRateMW) > 0x7fffffff ||
            (port.absoluteRateMW === 0) !== (rateSign === 'zero')))
      )
        return invalid('Rate形状无效');
      if ((has(state, 4) && rateSign === 'negative') || (has(state, 2) && rateSign === 'positive'))
        return invalid('Rate与充放电方向矛盾');
      present.push({ cell: { identity: `${instance}:${tag}`, capacity, full }, state, rateSign });
    }
    if (has(flag, 128)) {
      if (flag !== 128 || present.length || ac !== 1) return invalid('系统无电池与设备集合矛盾');
      return { classification: 'no-system-battery', cells: [], reason: null };
    }
    if (!present.length) return invalid('设备为空但系统声称有电池');
    if (unsupported) return unavailable('电池不是支持的绝对容量系统电池');
    if (percent > 100) return invalid('系统百分比不可用');
    const cells = present
      .map((row) => row.cell)
      .sort((a, b) => Buffer.compare(Buffer.from(a.identity), Buffer.from(b.identity)));
    const remaining = cells.reduce((sum, cell) => sum + BigInt(cell.capacity), 0n);
    const full = cells.reduce((sum, cell) => sum + BigInt(cell.full), 0n);
    if (
      remaining > 0xffffffffffffffffn ||
      full > 0xffffffffffffffffn ||
      Math.abs(Math.round((100 * Number(remaining)) / Number(full)) - percent) > 2
    )
      return invalid('聚合容量与系统百分比矛盾');
    if (has(flag, 8) !== present.some((cell) => has(cell.state, 4)))
      return invalid('系统charging标志与设备不一致');
    if (ac === 0) {
      if (
        has(flag, 8) ||
        present.some(
          (cell) => has(cell.state, 1) || has(cell.state, 4) || cell.rateSign === 'positive',
        ) ||
        !present.some((cell) => has(cell.state, 2))
      )
        return invalid('离线电源状态矛盾');
      return { classification: 'on-battery', cells, reason: null };
    }
    if (
      present.some(
        (cell) => !has(cell.state, 1) || has(cell.state, 2) || cell.rateSign === 'negative',
      )
    )
      return invalid('接电状态矛盾');
    return { classification: 'ac-or-charging', cells, reason: null };
  } catch {
    return invalid('电池原始字段无效');
  }
}

export function reportBattery(
  window: Window,
  records: readonly RawObservation[],
  windowIssues: readonly string[] = [],
): BatteryReport {
  const last = validateWindow(window);
  const selected = new Map<number, { row: RawObservation; slot: BatterySlot }>();
  const reasons: string[] = [];
  for (const row of records) {
    if (row.kind !== 'battery' || row.phase !== 'measurement') continue;
    try {
      if (!inWindow(window, { ...row, value: null }, last)) continue;
      const slot = classifyBattery(row);
      // Condition-unavailable is a complete observation; never replace it with a favorable duplicate.
      if (slot.classification === 'invalid') {
        reasons.push(slot.reason!);
        continue;
      }
      if (!selected.has(row.slot)) selected.set(row.slot, { row, slot });
    } catch {
      reasons.push('电池观察窗无效');
    }
  }
  const missingSlots = Array.from({ length: last + 1 }, (_, slot) => slot).filter(
    (slot) => !selected.has(slot),
  );
  const base: BatteryReport = {
    verdict: 'BLOCKED/evidence-insufficient',
    classification: 'condition-unavailable',
    validSlots: selected.size,
    missingSlots,
    startSlot: null,
    endSlot: null,
    elapsedSeconds: null,
    averageWatts: null,
    percentagePointsPerHour: null,
    reasons: [...new Set([...reasons, ...windowIssues])],
  };
  if (window.mode !== 'formal') {
    base.reasons.push('短验不授正式电池通过');
    return base;
  }
  if (
    !missingSlots.length &&
    [...selected.values()].every((entry) => entry.slot.classification === 'no-system-battery')
  )
    return {
      ...base,
      verdict: windowIssues.length ? 'BLOCKED/evidence-insufficient' : 'PASS',
      classification: 'N/A—无系统电池',
    };
  let start: { index: number; row: RawObservation; cells: Cell[] } | null = null;
  let previous: Cell[] | null = null;
  for (let index = 0; index <= last; ++index) {
    const entry = selected.get(index);
    if (!entry || entry.slot.classification !== 'on-battery') {
      start = null;
      previous = null;
      continue;
    }
    const cells = entry.slot.cells;
    if (
      previous &&
      (JSON.stringify(previous.map((cell) => [cell.identity, cell.full])) !==
        JSON.stringify(cells.map((cell) => [cell.identity, cell.full])) ||
        cells.some((cell, i) => cell.capacity > previous![i]!.capacity))
    ) {
      start = null;
      previous = null;
      base.reasons.push('电池身份、满容量改变或剩余容量回升');
      continue;
    }
    start ??= { index, row: entry.row, cells };
    previous = cells;
    const elapsed = Number(ticks(entry.row.endQpc) - ticks(start.row.endQpc)) / window.qpcFrequency;
    if (elapsed < 1800) continue;
    const used = cells.reduce((sum, cell, i) => sum + start!.cells[i]!.capacity - cell.capacity, 0);
    const full = cells.reduce((sum, cell) => sum + cell.full, 0);
    const watts = used / (elapsed / 3600) / 1000;
    const rate = ((used / full) * 100) / (elapsed / 3600);
    return {
      ...base,
      verdict:
        watts > 15 || rate > 20
          ? 'FAIL-product'
          : windowIssues.length
            ? 'BLOCKED/evidence-insufficient'
            : 'PASS',
      classification: 'on-battery',
      startSlot: start.index,
      endSlot: index,
      elapsedSeconds: elapsed,
      averageWatts: watts,
      percentagePointsPerHour: rate,
    };
  }
  if (
    !missingSlots.length &&
    [...selected.values()].every((entry) => entry.slot.classification === 'ac-or-charging')
  )
    base.classification = 'ac-or-charging—需补电池窗口';
  return base;
}
