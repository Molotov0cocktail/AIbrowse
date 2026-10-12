// Launcher-only cleanup of a fresh synthetic campaign; never accepts a user profile.
import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanSecretFootprint } from './secret-scan.ts';

function fileStat(file: string) {
  try {
    return lstatSync(file);
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

export function cleanupCampaignCredentials(root: string) {
  const result = {
    credentialFilesAbsent: false,
    credentialFilesRemoved: 0,
    credentialCleanup: 'cleanup-failed',
  };
  try {
    root = resolve(root);
    const profile = join(root, 'profile');
    for (const directory of [root, profile]) {
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(directory) !== directory)
        throw new Error('cleanup-path-boundary');
    }
    const files = ['credentials.json', 'credentials.json.tmp'].map((name) => join(profile, name));
    // Validate every target before making any mutation.
    for (const file of files) {
      const stat = fileStat(file);
      if (stat === null) continue;
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        realpathSync(file) !== file
      )
        throw new Error('cleanup-path-boundary');
    }
    for (const file of files) {
      if (fileStat(file) === null) continue;
      unlinkSync(file);
      result.credentialFilesRemoved++;
    }
    result.credentialFilesAbsent = files.every((file) => fileStat(file) === null);
    result.credentialCleanup = result.credentialFilesAbsent ? 'cleanup-complete' : 'cleanup-failed';
  } catch {
    // Never persist a filesystem path or exception message from an external error.
    result.credentialCleanup = 'cleanup-failed';
  }
  return result;
}

export function finalizeCampaignSecrets(root: string, secret: Uint8Array) {
  try {
    // Scan before removal: cleanup must not erase evidence of a plaintext leak.
    const secretScan = scanSecretFootprint(root, secret);
    return { ...cleanupCampaignCredentials(root), secretScan };
  } finally {
    secret.fill(0);
  }
}

export function watchCampaignPassed(result: {
  exitCode: number | null;
  exited: boolean;
  launchFailed?: boolean;
  deadlineExceeded?: boolean;
  childPassed: boolean;
  credentialFilesAbsent: boolean;
  secretScan: { passed: boolean } | null;
}): boolean {
  return (
    result.exitCode === 0 &&
    result.exited &&
    !result.launchFailed &&
    !result.deadlineExceeded &&
    result.childPassed &&
    result.credentialFilesAbsent &&
    result.secretScan?.passed === true
  );
}
