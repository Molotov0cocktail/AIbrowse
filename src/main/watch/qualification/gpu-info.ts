export interface QualificationGpuInfo {
  devices: { active: boolean; deviceId: number; vendorId: number }[];
  softwareRendering: boolean | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only documented identifiers leave the main process; absent information stays unknown. */
export function projectQualificationGpuInfo(value: unknown): QualificationGpuInfo {
  const unknown: QualificationGpuInfo = { devices: [], softwareRendering: null };
  if (
    !record(value) ||
    !Array.isArray(value.gpuDevice) ||
    value.gpuDevice.length < 1 ||
    value.gpuDevice.length > 8
  )
    return unknown;
  const devices: QualificationGpuInfo['devices'] = [];
  for (const device of value.gpuDevice) {
    if (
      !record(device) ||
      typeof device.active !== 'boolean' ||
      typeof device.vendorId !== 'number' ||
      !Number.isInteger(device.vendorId) ||
      device.vendorId < 0 ||
      device.vendorId > 0xffffffff ||
      typeof device.deviceId !== 'number' ||
      !Number.isInteger(device.deviceId) ||
      device.deviceId < 0 ||
      device.deviceId > 0xffffffff
    )
      return unknown;
    devices.push({ active: device.active, deviceId: device.deviceId, vendorId: device.vendorId });
  }
  return {
    devices,
    softwareRendering:
      record(value.auxAttributes) && typeof value.auxAttributes.softwareRendering === 'boolean'
        ? value.auxAttributes.softwareRendering
        : null,
  };
}

export async function readQualificationGpuInfo(
  read: () => Promise<unknown>,
): Promise<QualificationGpuInfo> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(read),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), 5000);
      }),
    ]);
    return projectQualificationGpuInfo(result);
  } catch {
    return projectQualificationGpuInfo(null);
  } finally {
    clearTimeout(timer);
  }
}
