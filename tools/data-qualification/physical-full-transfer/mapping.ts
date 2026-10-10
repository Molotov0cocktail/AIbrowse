import type { Plugin } from 'esbuild';
import { dirname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type EntryName = 'import' | 'main' | 'counts' | 'worker';
export interface SourceMapping {
  entry: EntryName;
  importer: string;
  request: './contract' | './input';
  target: string;
}

const NEW_DIRECTORY = normalize(dirname(fileURLToPath(import.meta.url)));
const OLD_DIRECTORY = normalize(resolve(NEW_DIRECTORY, '../full-transfer'));
const ALLOWED: Readonly<Record<EntryName, readonly string[]>> = Object.freeze({
  import: Object.freeze([
    'import-entry.ts|./contract',
    'import-entry.ts|./input',
    'io.ts|./contract',
  ]),
  main: Object.freeze([
    'campaign.ts|./contract',
    'counts-electron.ts|./contract',
    'counts.ts|./contract',
    'io.ts|./contract',
    'main.ts|./contract',
    'main.ts|./input',
    'trace.ts|./contract',
  ]),
  counts: Object.freeze([
    'counts-worker-core.ts|./contract',
    'counts.ts|./contract',
    'io.ts|./contract',
  ]),
  worker: Object.freeze([]),
});

function relativeOldImporter(importer: string): string | null {
  const normalized = normalize(importer);
  return dirname(normalized) === OLD_DIRECTORY ? normalized.slice(OLD_DIRECTORY.length + 1) : null;
}

export function mapOldDependency(
  entry: EntryName,
  importer: string,
  request: string,
): SourceMapping | null {
  if (request !== './contract' && request !== './input') return null;
  const name = relativeOldImporter(importer);
  if (name === null) return null;
  const key = `${name}|${request}`;
  if (!ALLOWED[entry].includes(key)) throw new Error(`未批准的旧工具适配依赖：${entry}:${key}`);
  return {
    entry,
    importer: `tools/data-qualification/full-transfer/${name}`,
    request,
    target: normalize(resolve(NEW_DIRECTORY, request.slice(2) + '.ts')),
  };
}

export function assertExactMappings(entry: EntryName, mappings: readonly SourceMapping[]): void {
  const actual = mappings
    .map((item) => `${item.importer.slice(item.importer.lastIndexOf('/') + 1)}|${item.request}`)
    .sort();
  const expected = [...ALLOWED[entry]].sort();
  if (actual.join('|') !== expected.join('|')) throw new Error(`构建适配映射未精确命中：${entry}`);
}

export function mappingPlugin(entry: EntryName, mappings: SourceMapping[]): Plugin {
  return {
    name: `physical-full-transfer-${entry}-mapping`,
    setup(api) {
      api.onResolve({ filter: /^\.\/(?:contract|input)$/ }, (args) => {
        const mapped = mapOldDependency(entry, args.importer, args.path);
        if (!mapped) return undefined;
        mappings.push(mapped);
        return { path: mapped.target };
      });
    },
  };
}

export function rejectMixedOldInputs(inputNames: readonly string[]): void {
  const forbidden = new Set([
    'tools/data-qualification/full-transfer/contract.ts',
    'tools/data-qualification/full-transfer/input.ts',
  ]);
  if (inputNames.some((name) => forbidden.has(name.replaceAll('\\', '/')))) {
    throw new Error('构建同时包含新旧输入合同');
  }
}
