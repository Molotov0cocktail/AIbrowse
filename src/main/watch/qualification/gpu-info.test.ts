import { describe, expect, it, vi } from 'vitest';
import { projectQualificationGpuInfo, readQualificationGpuInfo } from './gpu-info';

describe('资格GPU信息最小投影', () => {
  it('只保留设备标识与软件渲染事实，不输出主机或驱动原始文本', () => {
    expect(
      projectQualificationGpuInfo({
        gpuDevice: [{ active: true, vendorId: 4318, deviceId: 10464, deviceString: '不应记录' }],
        auxAttributes: { softwareRendering: false },
        machineModelName: '不应记录',
      }),
    ).toEqual({
      devices: [{ active: true, vendorId: 4318, deviceId: 10464 }],
      softwareRendering: false,
    });
  });
  it('缺失或畸形信息不能推断硬件加速', () => {
    for (const value of [
      null,
      {},
      { gpuDevice: [] },
      { gpuDevice: [{ active: true, vendorId: -1, deviceId: 1 }] },
      { gpuDevice: [{ active: 1, vendorId: 1, deviceId: 1 }] },
      { gpuDevice: Array.from({ length: 9 }, () => ({ active: true, vendorId: 1, deviceId: 1 })) },
    ]) {
      expect(projectQualificationGpuInfo(value)).toEqual({ devices: [], softwareRendering: null });
    }
    expect(
      projectQualificationGpuInfo({ gpuDevice: [{ active: false, vendorId: 1, deviceId: 1 }] }),
    ).toEqual({ devices: [{ active: false, vendorId: 1, deviceId: 1 }], softwareRendering: null });
  });
  it('保留软件渲染事实供外部资格判断，不改写成成功', () => {
    expect(
      projectQualificationGpuInfo({
        gpuDevice: [{ active: true, vendorId: 0, deviceId: 0 }],
        auxAttributes: { softwareRendering: true },
      }).softwareRendering,
    ).toBe(true);
  });
  it('拒绝与超时均留下unknown并清理等待，不重试查询', async () => {
    vi.useFakeTimers();
    try {
      const read = vi.fn(() => new Promise<unknown>(() => {}));
      const pending = readQualificationGpuInfo(read);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toEqual({ devices: [], softwareRendering: null });
      expect(read).toHaveBeenCalledTimes(1);
      expect(
        await readQualificationGpuInfo(() => Promise.reject(new Error('不可记录原文'))),
      ).toEqual({ devices: [], softwareRendering: null });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
