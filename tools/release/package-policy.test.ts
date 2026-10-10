import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { verifyGuardianBytes } from './package-policy';

it('guardian 必须与 ASAR 中唯一固定清单匹配，拒绝篡改与扩展字段', () => {
  const bytes = Buffer.from('synthetic-helper');
  const manifest = {
    version: 1,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  expect(verifyGuardianBytes(manifest, bytes)).toBe(manifest.sha256);
  expect(() => verifyGuardianBytes(manifest, Buffer.from('synthetic-helpez'))).toThrow();
  expect(() => verifyGuardianBytes({ ...manifest, path: 'other.exe' }, bytes)).toThrow();
  expect(() => verifyGuardianBytes({ ...manifest, bytes: 0 }, Buffer.alloc(0))).toThrow();
});

import {
  findForbiddenArchivePaths,
  isAllowedArchivePath,
  normalizeArchivePath,
} from './package-policy';

describe('release package positive allowlist', () => {
  it('accepts only fixed release outputs and the qualified production dependency closure', () => {
    expect(isAllowedArchivePath('out/release/main/index.js')).toBe(true);
    expect(isAllowedArchivePath('out/release/main/runtime-a1b2.js')).toBe(true);
    expect(isAllowedArchivePath('out/release/preload/index.js')).toBe(true);
    expect(isAllowedArchivePath('out/release/renderer/assets/index-a1b2.js')).toBe(true);
    expect(isAllowedArchivePath('node_modules/parse5/dist/index.js')).toBe(true);

    expect(isAllowedArchivePath('out/main/index.js')).toBe(false);
    expect(isAllowedArchivePath('src/main/index.ts')).toBe(false);
    expect(isAllowedArchivePath('tools/release/verify-package.ts')).toBe(false);
    expect(isAllowedArchivePath('node_modules/react/index.js')).toBe(false);
  });

  it('rejects test, qualification, native and source-map payloads inside allowed roots', () => {
    expect(
      findForbiddenArchivePaths([
        'out/release/main/index.js',
        'out/release/main/qualification.js',
        'node_modules/parse5/dist/index.js.map',
        'node_modules/entities/src/index.ts',
        'out/release/main/release-modules.json',
      ]),
    ).toEqual([
      'node_modules/entities/src/index.ts',
      'node_modules/parse5/dist/index.js.map',
      'out/release/main/qualification.js',
      'out/release/main/release-modules.json',
    ]);
  });

  it('normalizes ASAR platform separators and leading separators', () => {
    expect(normalizeArchivePath('\\out\\release\\main\\index.js')).toBe(
      'out/release/main/index.js',
    );
  });
});
