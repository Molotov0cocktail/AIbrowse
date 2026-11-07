import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { prepareLocalClient } from './prepare-local-client.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aibrowse-client-copy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const files = {
    'manifest.json': JSON.stringify({
      manifest_version: 3,
      version: '1.34.4',
      options_page: 'options.html',
      action: { default_popup: 'popup.html' },
    }),
    'content.js': 'export const fixture = true;',
  };
  const inventory = {
    packageVersion: '1.34.4',
    entries: Object.entries(files).map(([name, text]) => {
      fs.writeFileSync(path.join(source, name), text);
      return {
        path: name,
        kind: 'text',
        bytes: Buffer.byteLength(text),
        sha256: createHash('sha256').update(text).digest('hex'),
      };
    }),
  };
  return { source, destination: path.join(root, 'copy'), inventory };
}
test('只复制清单程序文件，未列用户存储不进入副本', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'unlisted-user-storage'), 'SENTINEL_NOT_A_REAL_KEY');
  const report = prepareLocalClient(f.source, f.destination, f.inventory);
  assert.equal(report.fileCount, 2);
  assert.equal(fs.existsSync(path.join(f.destination, 'unlisted-user-storage')), false);
  assert.equal(
    fs.readFileSync(path.join(f.destination, 'content.js'), 'utf8'),
    'export const fixture = true;',
  );
});
test('变更程序摘要与版本均在写入副本前拒绝', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'content.js'), 'changed');
  assert.throws(() => prepareLocalClient(f.source, f.destination, f.inventory), /不一致/);
  assert.equal(fs.existsSync(f.destination), false);
  fs.writeFileSync(path.join(f.source, 'manifest.json'), '{}');
  assert.throws(() => prepareLocalClient(f.source, f.destination, f.inventory), /manifest/);
});
test('路径穿越、绝对路径、Windows流和重复路径拒绝', (t) => {
  const f = fixture(t);
  for (const name of [
    '../secret',
    '/secret',
    'C:/secret',
    'file:secret',
    'folder\\secret',
    'content.js',
  ]) {
    const inventory = {
      ...f.inventory,
      entries: [...f.inventory.entries, { path: name, kind: 'text' }],
    };
    assert.throws(() => prepareLocalClient(f.source, f.destination, inventory));
    assert.equal(fs.existsSync(f.destination), false);
  }
});
test('拒绝重用副本目录，不覆盖既有文件', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.destination);
  fs.writeFileSync(path.join(f.destination, 'keep'), 'keep');
  assert.throws(() => prepareLocalClient(f.source, f.destination, f.inventory), /全新/);
  assert.equal(fs.readFileSync(path.join(f.destination, 'keep'), 'utf8'), 'keep');
});

test('已绑定候选的manifest变化必须拒绝，不能只看版本和入口', (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.source, 'manifest.json'), 'utf8'));
  manifest.permissions = ['nativeMessaging'];
  fs.writeFileSync(path.join(f.source, 'manifest.json'), JSON.stringify(manifest));
  assert.throws(() => prepareLocalClient(f.source, f.destination, f.inventory), /不一致/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('来源祖先junction拒绝', (t) => {
  const f = fixture(t);
  const root = path.dirname(f.source),
    actual = path.join(root, 'actual');
  fs.mkdirSync(actual);
  fs.renameSync(f.source, path.join(actual, 'source'));
  fs.symlinkSync(actual, path.join(root, 'alias'), 'junction');
  assert.throws(
    () => prepareLocalClient(path.join(root, 'alias', 'source'), f.destination, f.inventory),
    /链接/,
  );
});
test('目标祖先junction拒绝', (t) => {
  const f = fixture(t);
  const root = path.dirname(f.source),
    actual = path.join(root, 'actual');
  fs.mkdirSync(actual);
  fs.symlinkSync(actual, path.join(root, 'alias'), 'junction');
  assert.throws(
    () => prepareLocalClient(f.source, path.join(root, 'alias', 'copy'), f.inventory),
    /链接/,
  );
});
test('资产子目录junction拒绝', (t) => {
  const f = fixture(t);
  const root = path.dirname(f.source),
    actual = path.join(root, 'actual');
  fs.mkdirSync(actual);
  fs.writeFileSync(path.join(actual, 'content.js'), 'export const fixture = true;');
  fs.symlinkSync(actual, path.join(f.source, 'alias'), 'junction');
  const inventory = {
    ...f.inventory,
    entries: f.inventory.entries.map((entry) =>
      entry.path === 'content.js' ? { ...entry, path: 'alias/content.js' } : entry,
    ),
  };
  assert.throws(() => prepareLocalClient(f.source, f.destination, inventory), /链接/);
});
