import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { verifyProfileIsolationJournal } from './profile-isolation-policy';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const createFixture = (): { appData: string; journal: string; marker: string } => {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-profile-policy-'));
  roots.push(root);
  const appData = join(root, 'active');
  const profile = join(appData, 'aibrowse');
  const journal = join(root, 'journal');
  mkdirSync(profile, { recursive: true });
  mkdirSync(journal);
  const fileId = '00000001:0000000000000002';
  const identity = { FileId: fileId, Sddl: 'O:S-1-5-21G:S-1-5-21D:(A;;FA;;;SY)' };
  const runId = '00112233445566778899aabbccddeeff';
  writeFileSync(
    join(journal, 'manifest.json'),
    JSON.stringify({
      Version: 1,
      RunId: runId,
      Parent: appData,
      ParentIdentity: identity,
      OriginalIdentity: identity,
      SyntheticIdentity: identity,
      Fixture: false,
    }),
  );
  writeFileSync(join(journal, 'synthetic.json'), JSON.stringify(identity));
  const marker = join(profile, '.aibrowse-e1-synthetic-owner.json');
  writeFileSync(marker, JSON.stringify({ runId, fileId }));
  return { appData, journal, marker };
};

const createDisposableFixture = (): {
  appData: string;
  journal: string;
  marker: string;
  fileId128: string;
} => {
  const root = mkdtempSync(join(tmpdir(), 'aibrowse-disposable-policy-'));
  roots.push(root);
  const appData = join(root, 'active');
  const profile = join(appData, 'aibrowse');
  const journal = join(root, 'journal');
  mkdirSync(profile, { recursive: true });
  mkdirSync(journal);
  const runId = '102132435465768798a9bacbdcedfe0f';
  const fileId128 = '00112233445566778899aabbccddeeff';
  const volumeSerial64 = '0011223344556677';
  writeFileSync(
    join(journal, 'manifest.json'),
    JSON.stringify({
      Version: 2,
      RunId: runId,
      DeclaredProfile: profile,
      ResolvedProfile: profile,
      PackageExecutable: join(root, 'release', 'AIbrowse.exe'),
      RootIdentity: {
        FileId128: fileId128,
        VolumeSerial64: volumeSerial64,
        Sddl: 'O:S-1-5-21G:S-1-5-21D:(A;;FA;;;SY)',
      },
    }),
  );
  const marker = join(profile, '.aibrowse-e1-synthetic-owner.json');
  writeFileSync(marker, JSON.stringify({ version: 1, runId, fileId128, volumeSerial64 }));
  return { appData, journal, marker, fileId128 };
};

describe('release profile isolation binding', () => {
  it('accepts a matching synthetic profile owner and durable journal', () => {
    const fixture = createFixture();
    expect(verifyProfileIsolationJournal(fixture.appData, fixture.journal)).toEqual({
      version: 1,
      runId: '00112233445566778899aabbccddeeff',
      syntheticFileId: '00000001:0000000000000002',
    });
  });

  it('rejects a stale or foreign synthetic owner marker', () => {
    const fixture = createFixture();
    writeFileSync(
      fixture.marker,
      JSON.stringify({
        runId: 'ffeeddccbbaa99887766554433221100',
        fileId: '00000001:0000000000000002',
      }),
    );
    expect(() => verifyProfileIsolationJournal(fixture.appData, fixture.journal)).toThrow(
      'owner marker',
    );
  });

  it('accepts a matching disposable KnownFolder journal and records the Node view', () => {
    const fixture = createDisposableFixture();
    const result = verifyProfileIsolationJournal(fixture.appData, fixture.journal);
    expect(result.version).toBe(2);
    expect(result.runId).toBe('102132435465768798a9bacbdcedfe0f');
    expect(result.syntheticFileId).toBe(fixture.fileId128);
    expect(result.nodeView).toEqual({
      declared: {
        dev: expect.stringMatching(/^[0-9]+$/u),
        ino: expect.stringMatching(/^[0-9]+$/u),
      },
      resolved: {
        dev: expect.stringMatching(/^[0-9]+$/u),
        ino: expect.stringMatching(/^[0-9]+$/u),
      },
    });
  });

  it('rejects a disposable marker with a mismatched 128-bit root identity', () => {
    const fixture = createDisposableFixture();
    writeFileSync(
      fixture.marker,
      JSON.stringify({
        version: 1,
        runId: '102132435465768798a9bacbdcedfe0f',
        fileId128: 'ffeeddccbbaa99887766554433221100',
        volumeSerial64: '0011223344556677',
      }),
    );
    expect(() => verifyProfileIsolationJournal(fixture.appData, fixture.journal)).toThrow(
      'disposable profile',
    );
  });

  it('rejects a disposable journal whose resolved Node view is a different directory', () => {
    const fixture = createDisposableFixture();
    const manifestPath = join(fixture.journal, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    const foreignResolved = join(fixture.appData, 'foreign-profile');
    mkdirSync(foreignResolved);
    manifest.ResolvedProfile = foreignResolved;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifyProfileIsolationJournal(fixture.appData, fixture.journal)).toThrow(
      '不是同一目录对象',
    );
  });
});
