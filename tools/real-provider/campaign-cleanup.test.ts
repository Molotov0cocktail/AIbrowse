import { afterEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupCampaignCredentials,
  finalizeCampaignSecrets,
  watchCampaignPassed,
} from './campaign-cleanup';
import { scanSecretFootprint } from './secret-scan';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'provider-cleanup-'));
  roots.push(root);
  mkdirSync(join(root, 'profile'));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('真实Provider隔离场凭据清理与不泄露oracle', () => {
  it('正常扫描仅返回分类和计数', () => {
    const root = fixture();
    writeFileSync(join(root, 'result.json'), '{"passed":true}');
    const result = scanSecretFootprint(root, Buffer.from('synthetic-secret'));
    expect(result).toMatchObject({ passed: true, files: 1, matches: 0, failure: null });
    expect(JSON.stringify(result)).not.toContain(root);
  });
  it('扫描先于删除，检测凭据文件中的明文且finally清零Buffer', () => {
    const root = fixture();
    const secret = Buffer.from('synthetic-secret');
    writeFileSync(join(root, 'profile', 'credentials.json'), secret);
    writeFileSync(join(root, 'trace.txt'), secret);
    const result = finalizeCampaignSecrets(root, secret);
    expect(result).toMatchObject({
      credentialFilesAbsent: true,
      credentialFilesRemoved: 1,
      secretScan: { passed: false, matches: 2, failure: 'plaintext-match' },
    });
    expect(secret.every((value) => value === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  });
  it.each(['credentials.json.tmp', 'both'])(
    '异常退出或rename失败后的密文残留全部清除：%s',
    (mode) => {
      const root = fixture();
      writeFileSync(
        join(root, 'profile', 'credentials.json.tmp'),
        '{"providers":{"openai-compatible":"ciphertext"}}',
      );
      if (mode === 'both') writeFileSync(join(root, 'profile', 'credentials.json'), '{}');
      const result = cleanupCampaignCredentials(root);
      expect(result).toEqual({
        credentialFilesAbsent: true,
        credentialFilesRemoved: mode === 'both' ? 2 : 1,
        credentialCleanup: 'cleanup-complete',
      });
      expect(existsSync(join(root, 'profile', 'credentials.json.tmp'))).toBe(false);
    },
  );
  it('非普通凭据目标导致清理失败，不得只凭进程退出判定通过', () => {
    const root = fixture();
    mkdirSync(join(root, 'profile', 'credentials.json.tmp'));
    writeFileSync(join(root, 'profile', 'credentials.json'), '{}');
    expect(cleanupCampaignCredentials(root)).toMatchObject({
      credentialFilesAbsent: false,
      credentialFilesRemoved: 0,
      credentialCleanup: 'cleanup-failed',
    });
    expect(existsSync(join(root, 'profile', 'credentials.json'))).toBe(true);
  });
  it('目录重解析拒绝扫描和删除外部文件，同时清零Buffer', () => {
    const root = fixture();
    const external = fixture();
    rmSync(join(root, 'profile'), { recursive: true });
    symlinkSync(join(external, 'profile'), join(root, 'profile'), 'junction');
    writeFileSync(join(external, 'profile', 'credentials.json'), '{}');
    const secret = Buffer.from('synthetic-secret');
    const result = finalizeCampaignSecrets(root, secret);
    expect(result).toMatchObject({
      credentialFilesAbsent: false,
      secretScan: { passed: false, failure: 'scan-path-boundary' },
    });
    expect(existsSync(join(external, 'profile', 'credentials.json'))).toBe(true);
    expect(secret.every((value) => value === 0)).toBe(true);
  });
  it.each(['files', 'bytes'])('扫描超过%s预算必须失败', (budget) => {
    const root = fixture();
    writeFileSync(join(root, 'a'), '1234');
    writeFileSync(join(root, 'b'), '5678');
    const result = scanSecretFootprint(
      root,
      Buffer.from('synthetic-secret'),
      budget === 'files' ? 1 : 512,
      budget === 'bytes' ? 4 : 1024,
    );
    expect(result).toMatchObject({ passed: false, failure: 'scan-budget' });
  });
  it('断链与硬链接凭据目标不可伪报已清除', () => {
    const root = fixture();
    const external = fixture();
    symlinkSync(
      join(external, 'profile'),
      join(root, 'profile', 'credentials.json.tmp'),
      'junction',
    );
    rmSync(join(external, 'profile'), { recursive: true });
    expect(cleanupCampaignCredentials(root).credentialFilesAbsent).toBe(false);
    const other = fixture();
    writeFileSync(join(external, 'copy'), 'ciphertext');
    linkSync(join(external, 'copy'), join(other, 'profile', 'credentials.json'));
    expect(cleanupCampaignCredentials(other).credentialFilesAbsent).toBe(false);
    expect(existsSync(join(external, 'copy'))).toBe(true);
  });
  it('父进程闭合判定同时要求运行、清理及扫描通过', () => {
    const good = {
      exitCode: 0,
      exited: true,
      childPassed: true,
      credentialFilesAbsent: true,
      secretScan: { passed: true },
    };
    expect(watchCampaignPassed(good)).toBe(true);
    for (const patch of [
      { exitCode: 2 },
      { exited: false },
      { childPassed: false },
      { credentialFilesAbsent: false },
      { secretScan: { passed: false } },
      { secretScan: null },
      { launchFailed: true },
      { deadlineExceeded: true },
    ])
      expect(watchCampaignPassed({ ...good, ...patch })).toBe(false);
  });
});
