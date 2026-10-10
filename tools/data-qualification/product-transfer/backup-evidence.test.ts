import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { inspectProductBackup } from './backup-evidence';

it('原生身份与limit纯判定拒绝PID复用、映像变化、未生效限额；回执CreateNew不覆盖', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-job-pure-'));
  const script = `$ErrorActionPreference='Stop'
Add-Type -Path $env:PRODUCT_JOB_CS
[ProductTransferJobBudget]::ValidateIdentity(42,100001,'C:\\app.exe',42,100000,'c:\\APP.exe')
$rejected=0
foreach($case in @(@(43,100000,'C:\\app.exe'),@(42,100010,'C:\\app.exe'),@(42,100000,'C:\\other.exe'))) {
 try { [ProductTransferJobBudget]::ValidateIdentity(42,100001,'C:\\app.exe',[uint32]$case[0],[long]$case[1],[string]$case[2]) } catch { $rejected++ }
}
if($rejected -ne 3){throw '身份负对照未拒绝'}
[ProductTransferJobBudget]::ValidateLimits(0x2008,24)
$rejected=0
foreach($case in @(@(0x2000,24),@(0x2008,25),@(8,24))) {
 try { [ProductTransferJobBudget]::ValidateLimits([uint32]$case[0],[uint32]$case[1]) } catch { $rejected++ }
}
if($rejected -ne 3){throw '限额负对照未拒绝'}
$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:PRODUCT_JOB_PS,[ref]$tokens,[ref]$errors)
$node=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Write-ExclusiveReceipt'},$true)
. ([scriptblock]::Create($node.Extent.Text))
$path=Join-Path $env:PRODUCT_JOB_OUTPUT 'sample.json'
Write-ExclusiveReceipt $path @{hardTotalLimit=24;total=1}
$before=[IO.File]::ReadAllText($path)
$rejected=$false
try { Write-ExclusiveReceipt $path @{hardTotalLimit=99;total=99} } catch {$rejected=$true}
if(-not $rejected -or [IO.File]::ReadAllText($path) -cne $before){throw '排他回执覆盖原件'}
'8个身份/限额正负对照与排他回执通过'
`;
  const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: {
      ...process.env,
      PRODUCT_JOB_CS: resolve('tools/data-qualification/product-transfer/JobBudget.cs'),
      PRODUCT_JOB_PS: resolve('tools/data-qualification/product-transfer/job-budget.ps1'),
      PRODUCT_JOB_OUTPUT: root,
    },
    timeout: 10000,
    windowsHide: true,
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(JSON.parse(await readFile(join(root, 'sample.json'), 'utf8'))).toEqual({
    hardTotalLimit: 24,
    total: 1,
  });
});

function wire() {
  const snapshotId = '12345678-1234-4234-8234-123456789abc';
  const chunks = [
    Buffer.from('sources'),
    Buffer.from('research'),
    Buffer.from('watch'),
    Buffer.from('conversations'),
  ];
  const members = chunks.map((chunk, i) => ({
    id: ['sources', 'research', 'watch', 'conversations'][i],
    present: true,
    schemaVersion: [1, 1, 5, 1][i],
    bytes: chunk.length,
    sha256: createHash('sha256').update(chunk).digest('hex'),
  }));
  const json = Buffer.from(
    JSON.stringify({ formatVersion: 1, productVersion: '0.1.0', snapshotId, members }),
  );
  const header = Buffer.alloc(16);
  header.write('AIBAK001');
  header.writeUInt32BE(1, 8);
  header.writeUInt32BE(json.length, 12);
  const frames = chunks.flatMap((chunk, i) => {
    const frame = Buffer.alloc(58);
    frame[0] = i + 1;
    frame[1] = 1;
    Buffer.from(snapshotId.replaceAll('-', ''), 'hex').copy(frame, 2);
    frame.writeBigUInt64BE(BigInt(chunk.length), 18);
    Buffer.from(members[i]!.sha256, 'hex').copy(frame, 26);
    return [frame, chunk];
  });
  return Buffer.concat([header, json, ...frames]);
}
it('实际小容器逐成员校验且只读，不把语义未校验内容冒充完整恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'product-wire-'));
  const path = join(root, 'backup.aibak');
  const bytes = wire();
  await writeFile(path, bytes);
  const result = await inspectProductBackup(path, performance.now() + 3000);
  expect(result.bytes).toBe(bytes.length);
  expect(result.members).toHaveLength(4);
  expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect(await readFile(path)).toEqual(bytes);
});
it('非有限deadline不会禁用流读监督', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'product-deadline-')), 'backup.aibak');
  await writeFile(path, wire());
  await expect(inspectProductBackup(path, Number.NaN)).rejects.toThrow();
  await expect(inspectProductBackup(path, Infinity)).rejects.toThrow();
});
it.each([
  'tail',
  'truncated',
  'hash',
  'snapshot',
  'version',
  'manifest-limit',
  'deadline',
] as const)('拒绝%s且保存原件', async (fault) => {
  let bytes = wire();
  if (fault === 'tail') bytes = Buffer.concat([bytes, Buffer.from([1])]);
  if (fault === 'truncated') bytes = bytes.subarray(0, bytes.length - 1);
  if (fault === 'hash') bytes[bytes.length - 1] ^= 1;
  if (fault === 'snapshot') bytes[16 + bytes.readUInt32BE(12) + 2] ^= 1;
  if (fault === 'version') bytes.writeUInt32BE(2, 8);
  if (fault === 'manifest-limit') bytes.writeUInt32BE(4097, 12);
  const path = join(await mkdtemp(join(tmpdir(), 'product-bad-wire-')), 'backup.aibak');
  await writeFile(path, bytes);
  await expect(
    inspectProductBackup(
      path,
      fault === 'deadline' ? performance.now() - 1 : performance.now() + 3000,
    ),
  ).rejects.toThrow();
  expect(await readFile(path)).toEqual(bytes);
});
