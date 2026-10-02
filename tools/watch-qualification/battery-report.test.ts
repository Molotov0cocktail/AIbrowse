import { describe, expect, it } from 'vitest';
import { classifyBattery, reportBattery } from './battery-report.ts';
import type { RawObservation } from './read-evidence.ts';
import type { Window } from './resource-report.ts';

const window: Window = {
  mode: 'formal',
  beginQpc: '100000',
  endQpc: '3700000',
  qpcFrequency: 1000,
  processors: 4,
};
function row(slot = 0, capacity = 50000): RawObservation {
  return {
    version: 1,
    kind: 'battery',
    phase: 'measurement',
    status: 'ok',
    slot,
    beginQpc: String(100000 + slot * 10000),
    endQpc: String(100000 + slot * 10000),
    enumerationComplete: true,
    cleanupComplete: true,
    system: {
      acLineStatus: 0,
      batteryFlag: 1,
      batteryLifePercent: Math.round((capacity / 60000) * 100),
    },
    ports: [
      {
        instanceSha256: 'a'.repeat(64),
        status: 'present',
        tag: 1,
        tagSuccess: true,
        tagError: 0,
        tagReturnedBytes: 4,
        capabilities: 0x80000000,
        powerState: 2,
        capacityMWh: capacity,
        fullChargedCapacityMWh: 60000,
        rateKnown: true,
        rateSign: 'negative',
        absoluteRateMW: 10000,
        informationReturnedBytes: 36,
        statusReturnedBytes: 16,
        detailRequiredBytes: 128,
        detailStructBytes: 8,
        queryTagInputBytes: 4,
        queryInformationInputBytes: 12,
        queryStatusInputBytes: 20,
      },
    ],
  };
}
function port(value: RawObservation): Record<string, unknown> {
  return (value.ports as Record<string, unknown>[])[0]!;
}
function system(value: RawObservation): Record<string, unknown> {
  return value.system as Record<string, unknown>;
}
const series = (): RawObservation[] =>
  Array.from({ length: 361 }, (_, slot) => row(slot, 50000 - slot * 20));

describe('电池独立判定', () => {
  it('暂停/节拍缺证阻止电池PASS，合法容量越界仍保留FAIL', () => {
    expect(reportBattery(window, series(), ['窗口发生暂停']).verdict).toBe(
      'BLOCKED/evidence-insufficient',
    );
    const rows = Array.from({ length: 361 }, (_, slot) =>
      row(slot, 50000 - Math.min(slot, 180) * 50),
    );
    expect(reportBattery(window, rows, ['窗口发生暂停']).verdict).toBe('FAIL-product');
  });
  it('使用第一个连续三十分钟容量窗，两项均通过才通过', () => {
    expect(reportBattery(window, series())).toMatchObject({
      verdict: 'PASS',
      startSlot: 0,
      endSlot: 180,
      elapsedSeconds: 1800,
      averageWatts: 7.2,
      percentagePointsPerHour: 12,
    });
  });
  it('第一合法窗越界不得挑后续低耗电窗', () => {
    const rows = Array.from({ length: 361 }, (_, slot) =>
      row(slot, 50000 - Math.min(slot, 180) * 50),
    );
    expect(reportBattery(window, rows)).toMatchObject({
      verdict: 'FAIL-product',
      startSlot: 0,
      endSlot: 180,
      averageWatts: 18,
      percentagePointsPerHour: 30,
    });
  });
  it('缺失中间点、容量回升或tag改变均断开候选窗', () => {
    const missing = series();
    missing.splice(100, 1);
    expect(reportBattery(window, missing).startSlot).toBe(101);
    const regression = series();
    port(regression[100]!).capacityMWh = 50000;
    expect(reportBattery(window, regression).startSlot).toBe(101);
    const changed = series();
    for (let slot = 100; slot <= 360; ++slot) port(changed[slot]!).tag = 2;
    expect(reportBattery(window, changed).startSlot).toBe(101);
  });
  it('AC不被写成N/A，unknown Rate不补能量', () => {
    const rows = series();
    for (const value of rows) {
      system(value).acLineStatus = 1;
      port(value).powerState = 1;
      port(value).rateSign = 'unknown';
      port(value).rateKnown = false;
      port(value).absoluteRateMW = null;
    }
    expect(reportBattery(window, rows)).toMatchObject({
      verdict: 'BLOCKED/evidence-insufficient',
      classification: 'ac-or-charging—需补电池窗口',
    });
    const unknown = row();
    port(unknown).rateKnown = false;
    port(unknown).rateSign = 'unknown';
    port(unknown).absoluteRateMW = null;
    expect(classifyBattery(unknown).classification).toBe('on-battery');
  });
  it('无系统电池必须完整枚举、全部文档化absence和系统标志一致', () => {
    const rows = series();
    for (const value of rows) {
      value.ports = [];
      value.system = { acLineStatus: 1, batteryFlag: 128, batteryLifePercent: 255 };
    }
    expect(reportBattery(window, rows)).toMatchObject({
      verdict: 'PASS',
      classification: 'N/A—无系统电池',
    });
    rows[0]!.cleanupComplete = false;
    expect(reportBattery(window, rows).verdict).toBe('BLOCKED/evidence-insufficient');
    const absent = rows[1]!;
    absent.ports = [
      {
        instanceSha256: 'b'.repeat(64),
        status: 'documented-absence',
        tag: 0,
        tagSuccess: false,
        tagError: 2,
        tagReturnedBytes: 99,
      },
    ];
    expect(classifyBattery(absent).classification).toBe('no-system-battery');
    port(absent).tagSuccess = true;
    expect(classifyBattery(absent).classification).toBe('invalid');
  });
  it('relative/短期电池与未知capacity属于条件不可用', () => {
    for (const change of [
      (value: RawObservation) => {
        port(value).capabilities = 0xc0000000;
      },
      (value: RawObservation) => {
        port(value).capabilities = 0xa0000000;
      },
      (value: RawObservation) => {
        port(value).capacityMWh = 0xffffffff;
      },
      (value: RawObservation) => {
        port(value).fullChargedCapacityMWh = 0;
      },
    ]) {
      const value = row();
      change(value);
      expect(classifyBattery(value).classification).toBe('condition-unavailable');
    }
  });
  it('API字段、集合与电源状态矛盾均无效', () => {
    for (const change of [
      (value: RawObservation) => {
        port(value).tag = 0;
      },
      (value: RawObservation) => {
        port(value).informationReturnedBytes = 35;
      },
      (value: RawObservation) => {
        port(value).powerState = 6;
      },
      (value: RawObservation) => {
        port(value).rateSign = 'positive';
      },
      (value: RawObservation) => {
        system(value).batteryLifePercent = 1;
      },
      (value: RawObservation) => {
        system(value).acLineStatus = 255;
      },
      (value: RawObservation) => {
        system(value).batteryFlag = 129;
      },
      (value: RawObservation) => {
        value.enumerationComplete = false;
      },
      (value: RawObservation) => {
        (value.ports as unknown[]).push(port(value));
      },
    ]) {
      const value = row();
      change(value);
      expect(classifyBattery(value).classification).toBe('invalid');
    }
  });
});
