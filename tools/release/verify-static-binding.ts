import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { extractFile } from '@electron/asar';
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import ts from 'typescript';
import { verifyPackagedDirectory } from './package-policy.ts';

// Read-only artifact/source binding. It never executes code from the package.
const root = resolve(process.argv[2] ?? '.');
const packageRoot = resolve(process.argv[3] ?? 'release/win-unpacked');
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const packageResult = await verifyPackagedDirectory(packageRoot);
const asar = join(packageRoot, 'resources/app.asar');
const graphPath = join(root, 'out/release/main/release-modules.json');
const graph: unknown = JSON.parse(readFileSync(graphPath, 'utf8'));
assert(typeof graph === 'object' && graph !== null && 'modules' in graph && 'forbidden' in graph);
assert(Array.isArray(graph.modules) && graph.modules.every((item) => typeof item === 'string'));
assert.deepEqual(graph.forbidden, []);
const modules = graph.modules as string[];
assert(modules.length > 0 && new Set(modules).size === modules.length);
assert(
  modules.every(
    (name) =>
      name.startsWith('src/') &&
      !/(?:^|\/)(?:smoke[^/]*|qualification|native)(?:\/|\.)|\.(?:test|spec)\.|fake-provider/i.test(
        name,
      ),
  ),
);
for (const name of [
  'src/main/index.ts',
  'src/main/storage/lifecycle-guardian.ts',
  'src/main/storage/startup-probe-worker.ts',
  'src/main/storage/transfer-worker.ts',
  'src/main/storage/partial-recovery-entry.ts',
]) {
  assert(modules.includes(name), `缺少固定模块：${name}`);
}

const files = new Set(packageResult.files);
const external = new Set(['electron', '@federicocarboni/saxe', 'parse5', 'parse5-sax-parser']);
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));
const references: { file: string; target: string }[] = [];
const artifacts: { path: string; bytes: number; sha256: string }[] = [];
for (const path of packageResult.files.filter((name) => name.startsWith('out/release/'))) {
  const bytes = extractFile(asar, path.split('/').join(sep));
  assert.deepEqual(bytes, readFileSync(join(root, path)), `ASAR与构建输出不一致：${path}`);
  artifacts.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  if (!path.endsWith('.js')) continue;
  const source = bytes.toString('utf8');
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const tokens: string[] = [];
  const collectTokens = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) tokens.push(node.text);
    ts.forEachChild(node, collectTokens);
  };
  collectTokens(ast);
  for (const forbidden of [
    'AIBROWSE_SMOKE',
    'AIBROWSE_SOURCES_SMOKE',
    'AIBROWSE_SESSION_SMOKE',
    'AIBROWSE_E2_RUNTIME_QUALIFICATION',
    'installRuntimeQualification',
    'runSmokeTests',
    'FakeProvider',
  ]) {
    assert(
      !tokens.some((token) => token.includes(forbidden)),
      `发行JS出现验收入口：${path}/${forbidden}`,
    );
  }
  if (!path.startsWith('out/release/main/') && !path.startsWith('out/release/preload/')) continue;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      assert(
        node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!),
        '非固定require',
      );
      const target = node.arguments[0].text;
      references.push({ file: path, target });
      if (target.startsWith('.')) {
        assert(files.has(posix.normalize(posix.join(dirname(path).replaceAll('\\', '/'), target))));
      } else {
        assert(
          builtins.has(target.replace(/^node:/u, '')) || external.has(target),
          `未知依赖：${target}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
}
const helper = readFileSync(join(packageRoot, 'resources/lifecycle-guardian/guardian.exe'));
assert.deepEqual(helper, readFileSync(join(root, 'out/lifecycle-guardian/guardian.exe')));
const helperManifest = extractFile(
  asar,
  ['out', 'release', 'main', 'lifecycle-guardian-integrity.json'].join(sep),
);
assert.deepEqual(helperManifest, readFileSync(join(root, 'out/lifecycle-guardian/manifest.json')));
for (const path of [
  join(packageRoot, 'AIbrowse.exe'),
  join(packageRoot, 'resources/lifecycle-guardian/guardian.exe'),
]) {
  const pe = readFileSync(path);
  assert.equal(pe.toString('ascii', 0, 2), 'MZ');
  const header = pe.readUInt32LE(0x3c);
  assert.equal(pe.toString('ascii', header, header + 4), 'PE\0\0');
  assert.equal(pe.readUInt16LE(header + 4), 0x8664, '候选必须为Windows x64');
}
const wire = await getCurrentFuseWire(join(packageRoot, 'AIbrowse.exe'));
const fuses = Object.fromEntries(
  Object.values(FuseV1Options)
    .filter((value): value is FuseV1Options => typeof value === 'number')
    .map((key) => [
      FuseV1Options[key],
      wire[key] === FuseState.ENABLE
        ? 'enabled'
        : wire[key] === FuseState.DISABLE
          ? 'disabled'
          : String(wire[key]),
    ]),
);
process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      executableSha256: packageResult.executableSha256,
      asarSha256: packageResult.asarSha256,
      asarHeaderSha256: packageResult.asarHeaderSha256,
      guardianSha256: packageResult.guardianSha256,
      fuses,
      artifacts,
      modules: modules.map((path) => ({ path, sha256: digest(readFileSync(join(root, path))) })),
      sourceGraphSha256: digest(readFileSync(graphPath)),
      references,
      productExecuted: false,
    },
    null,
    2,
  )}\n`,
);
