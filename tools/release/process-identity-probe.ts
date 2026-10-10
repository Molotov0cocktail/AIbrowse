import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export type ControlledProcessLabel =
  'ProductOriginal' | 'ProductSecond' | 'ProductRestart' | 'TamperOriginal';

export class ControlledProcessProbeError extends Error {
  readonly diagnostic: {
    label: ControlledProcessLabel;
    pid: number;
    exitCode: number | null;
    stderr: string;
    capturedBytes: number;
    truncated: boolean;
  };

  constructor(diagnostic: ControlledProcessProbeError['diagnostic']) {
    super(`受控进程身份探针失败：${diagnostic.label}`);
    this.diagnostic = diagnostic;
  }
}

export interface ControlledProcessIdentity {
  label: ControlledProcessLabel;
  pid: number;
  processCreatedFileTime: string;
  imagePath: string;
  packageStatus: 0 | 15700;
  packageFullName: string;
  probeRootFileId128: string;
  probeRootVolumeSerial64: string;
}

export const probeControlledProcessIdentity = async (
  journalRoot: string,
  processId: number,
  label: ControlledProcessLabel,
): Promise<ControlledProcessIdentity> => {
  const script = resolve('tools', 'release-profile', 'disposable-profile.ps1');
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let truncated = false;
  const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
    const child = spawn(
      'pwsh.exe',
      [
        '-NoProfile',
        '-File',
        script,
        '-Action',
        'ProbeProcess',
        '-Journal',
        resolve(journalRoot),
        '-ProcessId',
        String(processId),
        '-Label',
        label,
      ],
      { cwd: resolve('.'), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    child.stderr?.on('data', (chunk: Buffer) => {
      const take = Math.min(chunk.length, 8192 - capturedBytes);
      if (take > 0) chunks.push(Buffer.from(chunk.subarray(0, take)));
      capturedBytes += take;
      if (take < chunk.length) truncated = true;
    });
    child.stderr?.on('error', rejectExit);
    child.once('error', rejectExit);
    // Preserve diagnostics emitted between native exit and pipe closure.
    child.once('close', resolveExit);
  });
  if (exitCode !== 0)
    throw new ControlledProcessProbeError({
      label,
      pid: processId,
      exitCode,
      stderr: Buffer.concat(chunks).toString('utf8'),
      capturedBytes,
      truncated,
    });
  const path = join(
    resolve(journalRoot),
    'runner-output',
    `process-${label}-${String(processId)}.json`,
  );
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`受控进程身份报告无效：${label}`);
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.version !== 1 ||
    value.pid !== processId ||
    value.label !== label ||
    typeof value.processCreatedFileTime !== 'string' ||
    !/^[0-9]+$/u.test(value.processCreatedFileTime) ||
    typeof value.imagePath !== 'string' ||
    basename(value.imagePath).toLowerCase() !== 'aibrowse.exe' ||
    (value.packageStatus !== 0 && value.packageStatus !== 15700) ||
    typeof value.packageFullName !== 'string' ||
    typeof value.probeRootFileId128 !== 'string' ||
    !/^[0-9a-f]{32}$/iu.test(value.probeRootFileId128) ||
    typeof value.probeRootVolumeSerial64 !== 'string' ||
    !/^[0-9a-f]{16}$/iu.test(value.probeRootVolumeSerial64)
  ) {
    throw new Error(`受控进程身份报告字段无效：${label}`);
  }
  return {
    label,
    pid: processId,
    processCreatedFileTime: value.processCreatedFileTime,
    imagePath: value.imagePath,
    packageStatus: value.packageStatus,
    packageFullName: value.packageFullName,
    probeRootFileId128: value.probeRootFileId128,
    probeRootVolumeSerial64: value.probeRootVolumeSerial64,
  };
};
