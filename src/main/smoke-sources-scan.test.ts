// smoke-sources-scan unit tests (B6/B8 supplement, 2026-08-15): pure test-infra
// logic for the real Provider Sources verification — secret-scan target collection
// (Sources DB/WAL/SHM/backups/journal + AI dir session files), the real-scenario
// manifest (task text + purpose ledger) and the call-ledger summary formatter.
// Zero Electron imports (runs under system Node in Vitest). Fixtures live in a
// per-test temp dir under the system TEMP; never touch real userData.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LIVE_SOURCES_SCENARIO_MANIFEST,
  collectSecretScanTargets,
  describeLiveSourcesLedger,
  validateLiveSourcesScenarioManifest,
} from './smoke-sources-scan';

const tempDirs: string[] = [];
function makeTempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `aibrowse-scan-test-${label}-`));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('validateLiveSourcesScenarioManifest', () => {
  it('合法清单零错误（id 唯一/文案与用途非空/kind 合法）', () => {
    const errors = validateLiveSourcesScenarioManifest([
      { id: 's1', task: '任务', purpose: '用途', kind: 'approve' },
      { id: 's2', task: '任务', purpose: '用途', kind: 'deny' },
      { id: 's3', task: '任务', purpose: '用途', kind: 'observe' },
    ]);
    expect(errors).toEqual([]);
  });

  it('重复 id / 空文案 / 空用途 / 非法 kind 分别报错', () => {
    const errors = validateLiveSourcesScenarioManifest([
      { id: 'dup', task: '任务', purpose: '用途', kind: 'approve' },
      { id: 'dup', task: '任务', purpose: '用途', kind: 'approve' },
      { id: 'e2', task: '', purpose: '用途', kind: 'approve' },
      { id: 'e3', task: '任务', purpose: '', kind: 'approve' },
      { id: 'e4', task: '任务', purpose: '用途', kind: 'unknown' as never },
    ]);
    expect(errors).toHaveLength(4);
    expect(errors.join('|')).toContain('dup');
    expect(errors.join('|')).toContain('e2');
    expect(errors.join('|')).toContain('e3');
    expect(errors.join('|')).toContain('e4');
  });

  it('内置清单自校验通过', () => {
    expect(validateLiveSourcesScenarioManifest(LIVE_SOURCES_SCENARIO_MANIFEST)).toEqual([]);
  });
});

describe('LIVE_SOURCES_SCENARIO_MANIFEST（真实场景清单契约）', () => {
  it('覆盖 L2 deny / durable Undo / SRT-01 / SRT-02 真实观察场景（区分旧结构）', () => {
    const kinds = LIVE_SOURCES_SCENARIO_MANIFEST.map((s) => s.kind);
    expect(kinds).toContain('deny');
    expect(kinds).toContain('observe');
    const ids = LIVE_SOURCES_SCENARIO_MANIFEST.map((s) => s.id);
    expect(ids.join('|')).toContain('undo');
    expect(ids.join('|')).toContain('srt-01');
    expect(ids.join('|')).toContain('srt-02');
  });

  it('每场景任务文案与用途非空（台账只记录场景/轮次/用途）', () => {
    for (const s of LIVE_SOURCES_SCENARIO_MANIFEST) {
      expect(s.task.trim().length).toBeGreaterThan(0);
      expect(s.purpose.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('collectSecretScanTargets', () => {
  it('Sources 目录：sources.db/-wal/-shm/backups 备份全部收录（journal 在库内字节）', () => {
    const sourcesDir = makeTempDir('src');
    const aiDir = makeTempDir('ai');
    mkdirSync(join(sourcesDir, 'backups'), { recursive: true });
    writeFileSync(join(sourcesDir, 'sources.db'), 'db-bytes');
    writeFileSync(join(sourcesDir, 'sources.db-wal'), 'wal-bytes');
    writeFileSync(join(sourcesDir, 'sources.db-shm'), 'shm-bytes');
    writeFileSync(join(sourcesDir, 'backups', 'aibrowse-sources-20260815-000001.db'), 'backup');
    writeFileSync(join(sourcesDir, 'backups', 'notes.txt'), 'backup-note');
    const targets = collectSecretScanTargets(sourcesDir, aiDir);
    const paths = targets.map((t) => t.path).sort();
    expect(paths).toContain(join(sourcesDir, 'sources.db'));
    expect(paths).toContain(join(sourcesDir, 'sources.db-wal'));
    expect(paths).toContain(join(sourcesDir, 'sources.db-shm'));
    expect(paths).toContain(join(sourcesDir, 'backups', 'aibrowse-sources-20260815-000001.db'));
    expect(paths).toContain(join(sourcesDir, 'backups', 'notes.txt'));
  });

  it('AI 目录：会话文件/ToolStep（conversations/*.json）与任意形态临时文件全部收录', () => {
    const sourcesDir = makeTempDir('src');
    const aiDir = makeTempDir('ai');
    mkdirSync(join(aiDir, 'conversations'), { recursive: true });
    writeFileSync(join(aiDir, 'conversations', 'index.json'), '[]');
    writeFileSync(join(aiDir, 'conversations', 'sess-1.json'), '{"messages":[]}');
    writeFileSync(join(aiDir, 'credentials.json'), 'cipher');
    writeFileSync(join(aiDir, 'provider-config.json'), '{}');
    writeFileSync(join(aiDir, 'leftover.tmp'), 'tmp');
    const targets = collectSecretScanTargets(sourcesDir, aiDir);
    const paths = targets.map((t) => t.path).sort();
    expect(paths).toContain(join(aiDir, 'conversations', 'index.json'));
    expect(paths).toContain(join(aiDir, 'conversations', 'sess-1.json'));
    expect(paths).toContain(join(aiDir, 'credentials.json'));
    expect(paths).toContain(join(aiDir, 'provider-config.json'));
    expect(paths).toContain(join(aiDir, 'leftover.tmp'));
  });

  it('目录不存在/不可枚举 → 安全空清单（越界安全返回，不抛异常）', () => {
    const root = makeTempDir('miss');
    const missing = join(root, 'no-such-dir');
    expect(collectSecretScanTargets(missing, join(root, 'also-missing'))).toEqual([]);
  });

  it('子目录本身不收录；符号链接不跟随（越界/链接防御）', () => {
    const root = makeTempDir('link');
    const sourcesDir = join(root, 'sources');
    const aiDir = join(root, 'ai');
    mkdirSync(sourcesDir, { recursive: true });
    mkdirSync(join(sourcesDir, 'sub'), { recursive: true });
    mkdirSync(aiDir, { recursive: true });
    writeFileSync(join(sourcesDir, 'sources.db'), 'db');
    writeFileSync(join(sourcesDir, 'sub', 'nested.db'), 'nested');
    // junction 指向目录外——lstat isSymbolicLink → 不收录、不跟随（越界防御；
    // Windows 普通用户创建文件符号链接需特权（EPERM），junction 为 B7 测试同先例）
    mkdirSync(join(root, 'outside-dir'), { recursive: true });
    writeFileSync(join(root, 'outside-dir', 'outside-secret.txt'), 'secret');
    symlinkSync(join(root, 'outside-dir'), join(sourcesDir, 'evil-link.db'), 'junction');
    const targets = collectSecretScanTargets(sourcesDir, aiDir);
    const paths = targets.map((t) => t.path).sort();
    expect(paths).not.toContain(join(sourcesDir, 'sub'));
    expect(paths).not.toContain(join(sourcesDir, 'evil-link.db'));
    expect(paths).not.toContain(join(root, 'outside-dir', 'outside-secret.txt'));
    expect(paths).toContain(join(sourcesDir, 'sub', 'nested.db'));
  });

  it('每个目标带 surface 分类（报告/日志用）', () => {
    const sourcesDir = makeTempDir('src');
    const aiDir = makeTempDir('ai');
    writeFileSync(join(sourcesDir, 'sources.db'), 'x');
    writeFileSync(join(aiDir, 'a.json'), 'y');
    const byPath = new Map(
      collectSecretScanTargets(sourcesDir, aiDir).map((t) => [t.path, t.surface]),
    );
    expect(byPath.get(join(sourcesDir, 'sources.db'))).toBe('sources');
    expect(byPath.get(join(aiDir, 'a.json'))).toBe('ai');
  });
});

describe('describeLiveSourcesLedger', () => {
  it('只输出任务数/轮次数/用途（无凭据字段）', () => {
    const text = describeLiveSourcesLedger([
      { task: '场景 1：收藏（deny）', modelRounds: 1 },
      { task: '场景 2：收藏（approve）', modelRounds: 3 },
    ]);
    expect(text).toContain('2 项');
    expect(text).toContain('共 4 次');
    expect(text).toContain('场景 1：收藏（deny）');
    expect(text).not.toContain('key');
  });

  it('空台账安全返回（零项文案，不抛异常）', () => {
    expect(describeLiveSourcesLedger([])).toContain('0 项');
  });
});

describe('collectSecretScanTargets 磁盘形态直测（existsSync/lstatSync 真实调用面）', () => {
  it('空目录（无任何文件）→ 空清单且不抛异常', () => {
    const sourcesDir = makeTempDir('empty-src');
    const aiDir = makeTempDir('empty-ai');
    expect(collectSecretScanTargets(sourcesDir, aiDir)).toEqual([]);
    expect(existsSync(sourcesDir)).toBe(true);
    expect(lstatSync(sourcesDir).isDirectory()).toBe(true);
  });

  it('Sources 目录含深层备份文件时 readdirSync 递归可达', () => {
    const sourcesDir = makeTempDir('deep');
    const aiDir = makeTempDir('deep-ai');
    mkdirSync(join(sourcesDir, 'backups', 'nested'), { recursive: true });
    writeFileSync(join(sourcesDir, 'backups', 'nested', 'deep.db'), 'deep');
    const targets = collectSecretScanTargets(sourcesDir, aiDir);
    expect(targets.map((t) => t.path)).toContain(join(sourcesDir, 'backups', 'nested', 'deep.db'));
    expect(readdirSync(sourcesDir).length).toBeGreaterThan(0);
  });
});
