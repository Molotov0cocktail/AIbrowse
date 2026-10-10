import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { assertExactMappings, mapOldDependency, rejectMixedOldInputs } from './mapping';

const old = (name: string) => resolve('tools/data-qualification/full-transfer', name);

it('只映射固定旧工具importer并拒绝漏命中、混旧输入和越权importer', () => {
  const importMappings = [
    mapOldDependency('import', old('import-entry.ts'), './contract'),
    mapOldDependency('import', old('import-entry.ts'), './input'),
    mapOldDependency('import', old('io.ts'), './contract'),
  ].filter((item) => item !== null);
  expect(() => assertExactMappings('import', importMappings)).not.toThrow();
  expect(() => assertExactMappings('import', importMappings.slice(1))).toThrow();
  expect(() => mapOldDependency('import', old('main.ts'), './contract')).toThrow();
  expect(mapOldDependency('main', resolve('src/main/storage/example.ts'), './contract')).toBeNull();
  expect(mapOldDependency('main', old('main.ts'), './campaign')).toBeNull();
  expect(() =>
    rejectMixedOldInputs(['tools/data-qualification/full-transfer/contract.ts']),
  ).toThrow();
});
