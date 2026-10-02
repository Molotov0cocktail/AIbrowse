import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface SafetyDirectories {
  workParent: string;
  artifactRoot: string;
  repository: string;
  userProfile: string;
  appData: string;
  localAppData: string;
}

export type DirectoryMetadata = 'directory' | 'link' | 'other' | 'missing' | 'unavailable';

export interface SafetyPreflightResult {
  schema: 'watch-safety-preflight-v1';
  scope: 'authorized-current-account-synthetic-input';
  status: 'ready-for-native-checks' | 'blocked';
  problems: string[];
  privateRootPresence: DirectoryMetadata[];
  sameAccountFileSandbox: false;
  earlyNativeCredentialAccess: 'not-proven';
  nativePinsRequired: true;
  observation: 'point-in-time-directory-metadata-only';
}

function strictPath(value: string): string {
  if (
    value.length < 4 ||
    value.length >= 240 ||
    !/^[a-z]:\\/i.test(value) ||
    value !== value.normalize('NFC') ||
    /[/:*?"<>|~]/.test(value.slice(2)) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    ) ||
    value
      .slice(3)
      .split('\\')
      .some(
        (part) =>
          part.length === 0 ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error('path-invalid');
  return value.toLowerCase();
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(right + '\\') || right.startsWith(left + '\\');
}

export function readDirectoryMetadata(path: string): DirectoryMetadata {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return 'link';
    return stat.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'missing'
      : 'unavailable';
  }
}

/** This is a read-only preflight, not an ACL sandbox or a replacement for native pins. */
export function inspectSafetyDirectories(
  input: SafetyDirectories,
  metadata: (path: string) => DirectoryMetadata = readDirectoryMetadata,
): SafetyPreflightResult {
  const problems: string[] = [];
  const result: SafetyPreflightResult = {
    schema: 'watch-safety-preflight-v1',
    scope: 'authorized-current-account-synthetic-input',
    status: 'blocked',
    problems,
    privateRootPresence: [],
    sameAccountFileSandbox: false,
    earlyNativeCredentialAccess: 'not-proven',
    nativePinsRequired: true,
    observation: 'point-in-time-directory-metadata-only',
  };
  try {
    const paths = Object.fromEntries(
      Object.entries(input).map(([key, value]) => [key, strictPath(value)]),
    );
    const privateRoots = [
      input.userProfile,
      win32.join(input.appData, 'AIbrowse'),
      win32.join(input.localAppData, 'AIbrowse'),
    ];
    for (const [key, candidate] of [
      ['work', paths.workParent],
      ['artifacts', paths.artifactRoot],
    ] as const) {
      if (privateRoots.some((root) => overlaps(candidate, strictPath(root))))
        problems.push(key + '-private-overlap');
    }
    if (overlaps(paths.workParent, paths.repository)) problems.push('work-repository-overlap');
    if (overlaps(paths.workParent, paths.artifactRoot)) problems.push('work-artifacts-overlap');
    // Reject private paths before touching any of their descendants.
    if (problems.length !== 0) return result;
    for (const [key, candidate] of [
      ['work', input.workParent],
      ['artifacts', input.artifactRoot],
    ] as const) {
      let ancestor = candidate.slice(0, 3);
      for (const part of ['', ...candidate.slice(3).split('\\')]) {
        if (part !== '') ancestor = win32.join(ancestor, part);
        const state = metadata(ancestor);
        if (state !== 'directory') {
          problems.push(key + '-' + state);
          break;
        }
      }
    }
    // Only fixed directory metadata is queried; no names or file contents are enumerated.
    result.privateRootPresence = privateRoots.map(metadata);
    if (problems.length === 0) result.status = 'ready-for-native-checks';
  } catch {
    problems.push('preflight-invalid');
  }
  return result;
}

function run(): void {
  try {
    if (process.platform !== 'win32' || process.argv.length !== 4)
      throw new Error('arguments-invalid');
    const systemRoot = process.env.SystemRoot;
    if (systemRoot === undefined) throw new Error('system-root-missing');
    const script = String.raw`
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
@{
  elevated = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
  appData = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
  localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
} | ConvertTo-Json -Compress
`;
    const raw: unknown = JSON.parse(
      execFileSync(
        win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-Command', script],
        {
          encoding: 'utf8',
          timeout: 10_000,
          maxBuffer: 8192,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
    if (
      raw === null ||
      typeof raw !== 'object' ||
      !('elevated' in raw) ||
      raw.elevated !== false ||
      !('userProfile' in raw) ||
      typeof raw.userProfile !== 'string' ||
      !('appData' in raw) ||
      typeof raw.appData !== 'string' ||
      !('localAppData' in raw) ||
      typeof raw.localAppData !== 'string'
    )
      throw new Error('identity-invalid');
    const result = inspectSafetyDirectories({
      workParent: process.argv[2],
      artifactRoot: process.argv[3],
      repository: win32.resolve(fileURLToPath(new URL('../..', import.meta.url))),
      userProfile: raw.userProfile,
      appData: raw.appData,
      localAppData: raw.localAppData,
    });
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.status === 'ready-for-native-checks' ? 0 : 1;
  } catch {
    process.stdout.write(
      JSON.stringify({
        schema: 'watch-safety-preflight-v1',
        status: 'blocked',
        problems: ['metadata-preflight-unavailable'],
      }) + '\n',
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) run();
