import { readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ProfileIsolationJournal {
  version: 1 | 2;
  runId: string;
  syntheticFileId: string;
  nodeView?: {
    declared: { dev: string; ino: string };
    resolved: { dev: string; ino: string };
  };
}

interface FileIdentity {
  FileId: string;
  Sddl: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readJsonObject = (path: string, description: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error(`${description} 形状无效`);
  return parsed;
};

const readFileIdentity = (value: unknown, description: string): FileIdentity => {
  if (!isRecord(value) || typeof value.FileId !== 'string' || typeof value.Sddl !== 'string') {
    throw new Error(`${description} 身份形状无效`);
  }
  if (!/^[0-9a-f]{8}:[0-9a-f]{16}$/iu.test(value.FileId) || value.Sddl.length === 0) {
    throw new Error(`${description} 身份值无效`);
  }
  return { FileId: value.FileId, Sddl: value.Sddl };
};

export const verifyProfileIsolationJournal = (
  expectedAppDataRoot: string,
  profileJournalRoot: string,
): ProfileIsolationJournal => {
  const manifest = readJsonObject(join(profileJournalRoot, 'manifest.json'), '隔离 manifest');
  const declaredProfile = resolve(expectedAppDataRoot, 'aibrowse');
  const owner = readJsonObject(
    join(declaredProfile, '.aibrowse-e1-synthetic-owner.json'),
    '合成 profile owner marker',
  );
  if (manifest.Version === 2) {
    const identity = manifest.RootIdentity;
    if (
      typeof manifest.RunId !== 'string' ||
      !/^[0-9a-f]{32}$/iu.test(manifest.RunId) ||
      typeof manifest.DeclaredProfile !== 'string' ||
      resolve(manifest.DeclaredProfile).toLowerCase() !== declaredProfile.toLowerCase() ||
      typeof manifest.ResolvedProfile !== 'string' ||
      !isRecord(identity) ||
      typeof identity.FileId128 !== 'string' ||
      !/^[0-9a-f]{32}$/iu.test(identity.FileId128) ||
      typeof identity.VolumeSerial64 !== 'string' ||
      !/^[0-9a-f]{16}$/iu.test(identity.VolumeSerial64) ||
      typeof identity.Sddl !== 'string' ||
      identity.Sddl.length === 0 ||
      owner.version !== 1 ||
      owner.runId !== manifest.RunId ||
      owner.fileId128 !== identity.FileId128 ||
      owner.volumeSerial64 !== identity.VolumeSerial64
    ) {
      throw new Error('disposable profile manifest、owner marker 与KnownFolder不一致');
    }
    const resolvedProfile = resolve(manifest.ResolvedProfile);
    const declaredIdentity = statSync(declaredProfile, { bigint: true, throwIfNoEntry: false });
    const resolvedIdentity = statSync(resolvedProfile, { bigint: true, throwIfNoEntry: false });
    if (
      declaredIdentity === undefined ||
      resolvedIdentity === undefined ||
      !declaredIdentity.isDirectory() ||
      !resolvedIdentity.isDirectory() ||
      declaredIdentity.dev !== resolvedIdentity.dev ||
      declaredIdentity.ino !== resolvedIdentity.ino
    ) {
      throw new Error('Node视图中的KnownFolder别名与解析实体不是同一目录对象');
    }
    return {
      version: 2,
      runId: manifest.RunId,
      syntheticFileId: identity.FileId128,
      nodeView: {
        declared: { dev: declaredIdentity.dev.toString(), ino: declaredIdentity.ino.toString() },
        resolved: { dev: resolvedIdentity.dev.toString(), ino: resolvedIdentity.ino.toString() },
      },
    };
  }
  const synthetic = readFileIdentity(
    readJsonObject(join(profileJournalRoot, 'synthetic.json'), '隔离 synthetic'),
    '合成 AppData',
  );
  if (
    manifest.Version !== 1 ||
    typeof manifest.RunId !== 'string' ||
    !/^[0-9a-f]{32}$/iu.test(manifest.RunId) ||
    typeof manifest.Parent !== 'string' ||
    resolve(manifest.Parent).toLowerCase() !== resolve(expectedAppDataRoot).toLowerCase() ||
    manifest.Fixture !== false
  ) {
    throw new Error('隔离 manifest 与本次合成 AppData 不一致');
  }
  readFileIdentity(manifest.ParentIdentity, 'AppData 父目录');
  readFileIdentity(manifest.OriginalIdentity, '原 aibrowse 目录');
  if (
    owner.runId !== manifest.RunId ||
    owner.fileId !== synthetic.FileId ||
    typeof owner.runId !== 'string' ||
    typeof owner.fileId !== 'string'
  ) {
    throw new Error('合成 profile owner marker 与隔离 journal 不一致');
  }
  return { version: 1, runId: manifest.RunId, syntheticFileId: synthetic.FileId };
};
