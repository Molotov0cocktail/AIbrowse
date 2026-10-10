import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('wrapper只暴露单campaign并以内存导入结果启动transfer', () => {
  const text = readFileSync(
    resolve('tools/data-qualification/physical-full-transfer/run.ps1'),
    'utf8',
  );
  expect(text).not.toContain('$args');
  expect(text).toContain("[ValidateSet('campaign')][string]$Mode");
  expect(text).not.toContain("[ValidateSet('import','transfer')][string]$Mode");
  expect(text).not.toContain("Join-Path $scope 'import-result.json'");
  expect(text).not.toContain('[IO.File]::Move');
  const campaign = text.indexOf('$campaignResult=');
  const claim = text.indexOf('$claim=Write-Receipt', campaign);
  const importCall = text.indexOf('$importResult=Invoke-Phase', campaign);
  const admission = text.indexOf('Assert-ImportAdmission $importResult', campaign);
  const transferCall = text.indexOf('$transferResult=Invoke-Phase', campaign);
  expect(claim).toBeGreaterThan(campaign);
  expect(claim).toBeLessThan(importCall);
  expect(importCall).toBeLessThan(admission);
  expect(admission).toBeLessThan(transferCall);
  expect(text).toContain("Join-Path $scope 'campaign-intent.json'");
  expect(text).toContain('"$Mode-result.pending-wrapper-exit.json"');
  expect(text).toContain("'wrapper-result.pending-wrapper-exit.json'");
  expect(text).toContain("authorization='pending-wrapper-exit'");
  expect(text).toContain("$pendingWrapperResult['requiresWrapperExit']=$true");
  expect(text).toContain('$campaignResult.electronQualified=$true');
  expect(text).toContain('$successStdout=$campaignResult|ConvertTo-Json -Depth 16');
  expect(text).toContain('[Console]::Out.WriteLine($successStdout)');
  expect(text).toContain('$inputProofSha256=Read-ClosedSmallHash');
  expect(text).toContain('Assert-Deadline $importClock 120000');
  expect(text).toContain('Assert-Deadline $transferClock 3060000');
  const phaseFinally = text.indexOf('} finally {', text.indexOf('function Invoke-Phase'));
  const phaseDeadline = text.indexOf('try {Check-Time}', phaseFinally);
  const phaseReturn = text.indexOf('return [pscustomobject]$result', phaseDeadline);
  expect(phaseFinally).toBeGreaterThan(0);
  expect(phaseDeadline).toBeGreaterThan(phaseFinally);
  expect(phaseReturn).toBeGreaterThan(phaseDeadline);
  expect(text.indexOf('$locks.Clear()', phaseFinally)).toBeLessThan(phaseDeadline);
  expect(text).toContain('$result.job.ActualZero');
  expect(text).toContain('$result.job.OwnershipRetained');
  expect(text).toContain('$result.job.Samples -lt 1');
  expect(text).toContain('$physicalOutputs.Count -ne 6');
  expect(text).toContain('[AIbrowse.PhysicalFullTransfer.Allocation]::Read');
  expect(text).toContain('$publication.fact.Size -gt 5368709120');
  expect(text).toContain("throw '构建来源闭包无效'");
  expect(text).toContain("throw '固定bundle闭包无效'");
});

it('晚返回、伪造摘要与未闭合前序均不满足campaign准入', () => {
  const admitted = (value: {
    elapsedMs: number;
    completed: boolean;
    authorization: string;
    succeeded: boolean;
    actualZero: boolean;
    ownershipRetained: boolean;
    electronQualified: boolean;
    productE2Pass: boolean;
    returnedHash: string;
    observedHash: string;
  }) =>
    value.elapsedMs < 120_000 &&
    value.completed &&
    value.authorization === 'pending-wrapper-exit' &&
    value.succeeded &&
    value.actualZero &&
    !value.ownershipRetained &&
    !value.electronQualified &&
    !value.productE2Pass &&
    /^[a-f0-9]{64}$/u.test(value.observedHash) &&
    value.returnedHash === value.observedHash;
  const valid = {
    elapsedMs: 119_999,
    completed: true,
    authorization: 'pending-wrapper-exit',
    succeeded: true,
    actualZero: true,
    ownershipRetained: false,
    electronQualified: false,
    productE2Pass: false,
    returnedHash: 'a'.repeat(64),
    observedHash: 'a'.repeat(64),
  };
  expect(admitted(valid)).toBe(true);
  expect(admitted({ ...valid, elapsedMs: 120_001 })).toBe(false);
  expect(admitted({ ...valid, completed: false })).toBe(false);
  expect(admitted({ ...valid, authorization: 'forged-disk-success' })).toBe(false);
  expect(admitted({ ...valid, observedHash: 'b'.repeat(64) })).toBe(false);
});

it('构建只以build-only启动并显式绑定旧模块映射', () => {
  const text = readFileSync(
    resolve('tools/data-qualification/physical-full-transfer/build.ts'),
    'utf8',
  );
  expect(text).toContain("process.argv[2] === '--build-only'");
  expect(text).toContain(
    "await bundle('import', 'tools/data-qualification/full-transfer/import-entry.ts'",
  );
  expect(text).toContain("await bundle('main', 'tools/data-qualification/full-transfer/main.ts'");
  expect(text).toContain('rejectMixedOldInputs(inputNames)');
  expect(text).not.toContain('importInput(');
});
