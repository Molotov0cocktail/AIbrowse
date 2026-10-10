import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  BACKUP_LIMITS,
  BackupContainerError,
  TransferInput,
  TransferOutput,
  transferBoundary,
} from '../../src/main/storage/backup-container';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
afterEach(() => vi.restoreAllMocks());
const root = join(process.cwd(), 'log/stage7-e2/transfer-buffer-independent-review-001');
fs.mkdirSync(root, { recursive: true });
const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function fixture(size = BACKUP_LIMITS.chunk * 2 + 19) {
  const folder = fs.mkdtempSync(join(root, 'case-'));
  const path = join(folder, 'input.bin');
  const payload = Buffer.alloc(size);
  for (let index = 0; index < size; index++) payload[index] = (index * 31) % 251;
  fs.writeFileSync(path, payload);
  const abort = new AbortController();
  const control = { signal: abort.signal, deadline: performance.now() + 5000 };
  const input = new TransferInput(path, size, control);
  return { folder, path, payload, abort, control, input };
}

function requireRead(
  value: unknown,
  offset: unknown,
  length: unknown,
  position: unknown,
): asserts value is Buffer {
  if (
    !Buffer.isBuffer(value) ||
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    !Number.isInteger(position)
  )
    throw new Error('独立读取夹具参数无效');
}

it('实际短读与短写跨多块仍保持借用视图、独立read、位置及三个摘要一致', () => {
  const test = fixture(BACKUP_LIMITS.chunk * 3 + 23);
  const nativeRead = fs.readSync;
  const nativeWrite = fs.writeSync;
  vi.spyOn(fs, 'readSync').mockImplementation(
    (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
      requireRead(value, offset, length, position);
      return nativeRead(fd, value, Number(offset), Math.min(Number(length), 271), Number(position));
    },
  );
  vi.spyOn(fs, 'writeSync').mockImplementation(
    (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
      if (!Buffer.isBuffer(value) || position !== null) throw new Error('独立写入夹具参数无效');
      return nativeWrite(fd, value, Number(offset), Math.min(Number(length), 113), null);
    },
  );
  const outputPath = join(test.folder, 'output.bin');
  const output = new TransferOutput(outputPath, test.payload.length, test.control);
  try {
    const prefix = test.input.read(11);
    output.write(prefix);
    const prefixSaved = Buffer.from(prefix);
    const observed = createHash('sha256');
    let position = prefix.length;
    let backing: ArrayBufferLike | undefined;
    const copied = test.input.copy(test.payload.length - prefix.length, (chunk) => {
      backing ??= chunk.buffer;
      expect(chunk.buffer).toBe(backing);
      expect(chunk).toEqual(test.payload.subarray(position, position + chunk.length));
      observed.update(chunk);
      output.write(chunk);
      position += chunk.length;
    });
    expect(position).toBe(test.payload.length);
    expect(prefix).toEqual(prefixSaved);
    expect(copied).toEqual({ bytes: test.payload.length - 11, sha256: observed.digest('hex') });
    expect(copied.sha256).toBe(digest(test.payload.subarray(11)));
    const expected = { bytes: test.payload.length, sha256: digest(test.payload) };
    expect(test.input.finish()).toEqual(expected);
    expect(output.finish()).toEqual(expected);
    output.verify(test.control);
    expect(fs.readFileSync(outputPath)).toEqual(test.payload);
  } finally {
    test.input.close();
    output.close();
  }
});

it.each(['cancelled', 'deadline'] as const)('native短读后%s在下一次读取及消费之前拒绝', (code) => {
  const test = fixture();
  const nativeRead = fs.readSync;
  const calls = vi
    .spyOn(fs, 'readSync')
    .mockImplementation(
      (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
        requireRead(value, offset, length, position);
        const count = nativeRead(fd, value, Number(offset), 7, Number(position));
        if (code === 'cancelled') test.abort.abort();
        else test.control.deadline = -1;
        return count;
      },
    );
  const consume = vi.fn();
  try {
    expect(() => test.input.copy(test.payload.length, consume)).toThrow(
      new BackupContainerError(code),
    );
    expect(calls).toHaveBeenCalledTimes(1);
    expect(consume).not.toHaveBeenCalled();
  } finally {
    test.input.close();
  }
});

it.each(['cancelled', 'deadline'] as const)(
  '同步消费首块后%s阻止后继读取，最后一块取消也不能finish',
  (code) => {
    for (const size of [BACKUP_LIMITS.chunk, BACKUP_LIMITS.chunk + 1]) {
      const test = fixture(size);
      const read = vi.spyOn(fs, 'readSync');
      const consume = vi.fn(() => {
        if (code === 'cancelled') test.abort.abort();
        else test.control.deadline = -1;
      });
      try {
        const work = () => {
          test.input.copy(size, consume);
          test.input.finish();
        };
        expect(work).toThrow(new BackupContainerError(code));
        expect(read).toHaveBeenCalledTimes(1);
        expect(consume).toHaveBeenCalledTimes(1);
      } finally {
        test.input.close();
        vi.restoreAllMocks();
      }
    }
  },
);

it.each([0, -1, 0.5, BACKUP_LIMITS.chunk + 1])(
  '第二块发生无效native读长%d时不交付旧缓冲内容',
  (invalidCount) => {
    const test = fixture();
    const nativeRead = fs.readSync;
    let calls = 0;
    vi.spyOn(fs, 'readSync').mockImplementation(
      (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
        requireRead(value, offset, length, position);
        if (++calls === 2) return invalidCount;
        return nativeRead(fd, value, Number(offset), Number(length), Number(position));
      },
    );
    const consume = vi.fn();
    try {
      expect(() => test.input.copy(test.payload.length, consume)).toThrow(
        new BackupContainerError('integrity-failed'),
      );
      expect(calls).toBe(2);
      expect(consume).toHaveBeenCalledTimes(1);
    } finally {
      test.input.close();
    }
  },
);

it.each(['native', 'consumer'] as const)('%s中段异常停止后继IO且幂等关闭原句柄', (kind) => {
  const test = fixture();
  const nativeRead = fs.readSync;
  let reads = 0;
  const close = vi.spyOn(fs, 'closeSync');
  vi.spyOn(fs, 'readSync').mockImplementation(
    (fd: number, value: unknown, offset?: unknown, length?: unknown, position?: unknown) => {
      requireRead(value, offset, length, position);
      if (++reads === 2 && kind === 'native') throw new Error('合成错误正文');
      return nativeRead(fd, value, Number(offset), Number(length), Number(position));
    },
  );
  const consume = vi.fn(() => {
    if (kind === 'consumer') throw new Error('合成错误正文');
  });
  try {
    expect(() => transferBoundary(() => test.input.copy(test.payload.length, consume))).toThrow(
      new BackupContainerError('io-failed'),
    );
    expect(reads).toBe(kind === 'native' ? 2 : 1);
    expect(consume).toHaveBeenCalledTimes(1);
  } finally {
    test.input.close();
    test.input.close();
  }
  expect(close).toHaveBeenCalledTimes(1);
});

it('越界参数不读取或改变位置，空copy不污染累计摘要', () => {
  const test = fixture(41);
  try {
    expect(test.input.read(3)).toEqual(test.payload.subarray(0, 3));
    const read = vi.spyOn(fs, 'readSync');
    for (const size of [-1, 0.5, NaN, Infinity, test.payload.length]) {
      expect(() => test.input.copy(size, () => {})).toThrow(
        new BackupContainerError('integrity-failed'),
      );
    }
    const consume = vi.fn();
    expect(test.input.copy(0, consume)).toEqual({ bytes: 0, sha256: digest(Buffer.alloc(0)) });
    expect(read).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(test.input.read(4)).toEqual(test.payload.subarray(3, 7));
    const result = test.input.copy(34, () => {});
    expect(result).toEqual({ bytes: 34, sha256: digest(test.payload.subarray(7)) });
    expect(test.input.finish()).toEqual({ bytes: 41, sha256: digest(test.payload) });
  } finally {
    test.input.close();
  }
});

it.each(['append', 'metadata'] as const)('复制结束后%s变化仍由EOF或输入身份复核拒绝', (change) => {
  const test = fixture();
  try {
    const copied = test.input.copy(test.payload.length, () => {});
    expect(copied.sha256).toBe(digest(test.payload));
    if (change === 'append') fs.appendFileSync(test.path, Buffer.from([13]));
    else fs.utimesSync(test.path, new Date(0), new Date(1000));
    expect(() => test.input.finish()).toThrow(
      new BackupContainerError(change === 'append' ? 'integrity-failed' : 'input-changed'),
    );
    expect(fs.existsSync(test.path)).toBe(true);
  } finally {
    test.input.close();
  }
});

it('真实采样器峰值身份跨轮、同值、64位创建时刻及部分失败均闭合，零原生调用', () => {
  const folder = fs.mkdtempSync(join(root, 'peak-'));
  let source = fs
    .readFileSync('tools/data-qualification/full-transfer/FixedTransferJob.cs', 'utf8')
    .replaceAll('\r\n', '\n');
  const replace = (name: string, replacement: string): void => {
    const pattern = new RegExp(
      String.raw`\[DllImport\([^\]]+\)\]\s*private static extern [^;\n]+\b${name}\([^;]+;`,
      'g',
    );
    if ([...source.matchAll(pattern)].length !== 1) throw new Error(`独立替身边界不唯一：${name}`);
    source = source.replace(pattern, replacement);
  };
  replace(
    'ReadPids',
    `private static bool ReadPids(SafeFileHandle job,int kind,IntPtr buffer,uint size,out uint returned) {
      Marshal.WriteInt32(buffer,0,2);Marshal.WriteInt32(buffer,4,2);
      Marshal.WriteInt64(buffer,8,100);Marshal.WriteInt64(buffer,16,101);returned=24;return true;
    }`,
  );
  replace(
    'OpenProcess',
    'private static SafeFileHandle OpenProcess(uint access,bool inherit,uint pid) { return new SafeFileHandle(new IntPtr(pid),false); }',
  );
  replace(
    'GetProcessTimes',
    `private static bool GetProcessTimes(SafeFileHandle process,out long created,out long exited,out long kernel,out long user) {
      created=ProbeCreated+process.DangerousGetHandle().ToInt64()-100;
      if(ProbeCase=="identity-fail"&&ProbeRound==1)created++;
      exited=kernel=user=0;return true;
    }`,
  );
  replace(
    'IsProcessInJob',
    'private static bool IsProcessInJob(SafeFileHandle process,SafeFileHandle job,out bool result) { result=true;return true; }',
  );
  replace(
    'WaitForSingleObject',
    'private static uint WaitForSingleObject(SafeFileHandle process,uint timeout) { return 258; }',
  );
  replace(
    'GetProcessMemoryInfo',
    `private static bool GetProcessMemoryInfo(SafeFileHandle process,ref MemoryCounters counters,uint size) {
      long pid=process.DangerousGetHandle().ToInt64();
      if(ProbeCase=="memory-fail"||(ProbeCase=="partial"&&ProbeRound==1&&pid==101))return false;
      ulong mib=pid==100?2UL:1UL;
      if(ProbeCase=="zero")mib=0;
      else if(ProbeRound==1) {
        if(ProbeCase=="tie")mib=2;
        else if(ProbeCase=="partial")mib=4;
        else if(ProbeCase=="higher")mib=pid==100?1UL:3UL;
      }
      counters.WorkingSet=new UIntPtr(mib*1048576);return true;
    }`,
  );
  // Make an unexpected native path fail without calling Windows process APIs.
  source = source.replace(
    /\[DllImport\([^\]]+\)\]\s*private static extern ([^;]+);/g,
    'private static $1 { throw new InvalidOperationException("独立夹具禁止原生调用"); }',
  );
  if (source.includes('[DllImport')) throw new Error('独立夹具存在未隔离原生入口');
  source = source.replace(
    'public static class FixedTransferJob\n    {',
    `public static class FixedTransferJob
    {
      private const long ProbeCreated=134360864718221479L;
      private static string ProbeCase;private static int ProbeRound;
      public static string ProbePeak(string name) {
        ProbeCase=name;
        var result=new Result {ProcessLimit=24,ProcessId=100,CreatedFileTime=ProbeCreated+(name=="different-root"?1:0)};
        var diagnostic=new NativeDiagnostic();var held=new System.Collections.Generic.Dictionary<uint,Sampled>();
        var clock=Stopwatch.StartNew();bool accepted=true;
        try {for(ProbeRound=0;ProbeRound<2;ProbeRound++)SampleJob(null,held,result,diagnostic,clock,12000);}
        catch(Exception error) {accepted=false;RecordNativeFailure(result,diagnostic,error);}
        finally {foreach(var sample in held.Values)sample.Handle.Dispose();}
        return String.Join("|",name,accepted,result.Samples,result.RssPeakBytes,result.RssPeakProcessId,
          result.RssPeakCreatedFileTime??"none",result.RssPeakRole??"none",result.RssPeakSampleAttempt,result.FailureStage??"none");
      }
`,
  );
  if (!source.includes('public static string ProbePeak')) throw new Error('独立峰值入口未接线');
  fs.writeFileSync(join(folder, 'mock.cs'), source);
  const script = `$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'mock.cs')
[Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::GetCultureInfo('ar-SA')
foreach($name in @('higher','tie','different-root','partial','identity-fail','memory-fail','zero')) {
 [AIbrowse.FullTransfer.FixedTransferJob]::ProbePeak($name)
}
`;
  const scriptPath = join(folder, 'test.ps1');
  fs.writeFileSync(scriptPath, script);
  const output = execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
    cwd: process.cwd(),
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 32768,
  });
  fs.writeFileSync(join(folder, 'result.txt'), output);
  expect(output.trim().split(/\r?\n/)).toEqual([
    'higher|True|2|3145728|101|134360864718221480|other|2|none',
    'tie|True|2|2097152|100|134360864718221479|root|1|none',
    'different-root|True|2|2097152|100|134360864718221479|other|1|none',
    'partial|False|1|4194304|100|134360864718221479|root|2|SampleMemory',
    'identity-fail|False|1|2097152|100|134360864718221479|root|1|SampleCurrentTimes',
    'memory-fail|False|0|0|0|none|none|0|SampleMemory',
    'zero|True|2|0|0|none|none|0|none',
  ]);
}, 20000);
