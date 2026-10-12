import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeProvider } from '../../src/main/ai/provider/fake-provider';
import { DigestService } from '../../src/main/watch/digest-service';
import { digestFixture } from './models-fixtures';

const root = mkdtempSync(join(tmpdir(), 'aibrowse-digest-diagnosis-'));
let OldDigest: typeof DigestService;
const canary = 'SYNTHETIC_REASONING_MUST_NOT_PERSIST';
beforeAll(async () => {
  const source = execFileSync('git', ['show', 'cd6c9ae^:src/main/watch/digest-service.ts'], {
    encoding: 'utf8',
  });
  const outfile = join(root, 'old-digest.cjs');
  await build({
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'silent',
    stdin: { contents: source, loader: 'ts', resolveDir: resolve('src/main/watch') },
    outfile,
  });
  OldDigest = (createRequire(outfile)(outfile) as { DigestService: typeof DigestService })
    .DigestService;
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe('Digest历史与当前消费器的甄别对照', () => {
  it.each([
    ['旧实现', false, 'succeeded', 'success'],
    ['旧实现', true, 'failed', 'invalid-output'],
    ['当前实现', false, 'succeeded', 'success'],
    ['当前实现', true, 'succeeded', 'success'],
  ] as const)('%s / reasoning=%s', async (version, reasoning, state, code) => {
    const text = '{"sections":[{"eventIds":["event-001"],"explanation":"新增合成产品价格49元"}]}';
    const provider = new FakeProvider({
      chunks: [...(reasoning ? [{ kind: 'reasoning' as const, text: canary }] : []), { text }],
    });
    const fixture = digestFixture(
      root,
      provider,
      'synthetic',
      version === '旧实现' ? OldDigest : DigestService,
    );
    try {
      expect(await fixture.run()).toMatchObject({ ok: true });
      expect(fixture.result()).toMatchObject({
        provider_state: state,
        provider_result_code: code,
        explanation_json: state === 'succeeded' ? text : null,
      });
      expect(provider.getRequests()).toHaveLength(1);
      expect(provider.getRequests()[0]).not.toHaveProperty('tools');
      for (const file of readdirSync(root).filter((name) => /\.db(?:-wal|-shm)?$/.test(name))) {
        expect(readFileSync(join(root, file)).includes(Buffer.from(canary))).toBe(false);
      }
    } finally {
      fixture.close();
    }
  });
});
