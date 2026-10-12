/* global __dirname, require, process, setTimeout, clearTimeout */
// This Electron-only probe never loads the product entry or a user profile.
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const physicalFs = require('original-fs');
const { createHash, randomUUID } = require('node:crypto');
const { join, resolve, dirname } = require('node:path');

const repository = physicalFs.realpathSync(resolve(__dirname, '../..'));
const evidenceRoot = join(repository, 'log/tray-runtime-20261012');
function ordinaryPath(path) {
  assert.equal(physicalFs.realpathSync(path), path, '路径不应重定向');
  for (let part = path; part !== dirname(part); part = dirname(part)) {
    assert(!physicalFs.lstatSync(part).isSymbolicLink(), '路径不应包含链接');
  }
}
ordinaryPath(evidenceRoot);
assert.equal(process.argv.length, 2, '此工具不接受外部路径或其它参数');
const root = join(evidenceRoot, `review-packaged-icon-${randomUUID()}`);
physicalFs.mkdirSync(root);
const profile = join(root, 'profile');
const session = join(root, 'session');
physicalFs.mkdirSync(profile);
physicalFs.mkdirSync(session);
app.setPath('userData', profile);
app.setPath('sessionData', session);

const report = {
  passed: false,
  error: null,
  electron: process.versions.electron,
  profile,
  session,
  packageLaunchStatus: 'NOTRUN',
  boundary: '仅开发Electron加载最终ASAR图标；不启动产品、不创建窗口或托盘、不访问真实profile',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const persist = () =>
  physicalFs.writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2), {
    flag: 'wx',
  });
const timer = setTimeout(() => {
  report.error = '图标验证超过30秒';
  persist();
  app.exit(1);
}, 30000);

void app.whenReady().then(() => {
  try {
    assert.equal(process.platform, 'win32');
    assert.equal(app.isPackaged, false);
    assert.equal(app.getPath('userData'), profile);
    assert.equal(app.getPath('sessionData'), session);
    ordinaryPath(profile);
    ordinaryPath(session);
    const metadata = JSON.parse(physicalFs.readFileSync(join(repository, 'package.json'), 'utf8'));
    assert.equal(process.versions.electron, metadata.devDependencies.electron);
    assert.equal(
      physicalFs.realpathSync(process.execPath),
      join(repository, 'node_modules/electron/dist/electron.exe'),
    );
    const asarPath = join(repository, 'release/win-unpacked/resources/app.asar');
    const sourcePath = join(repository, 'resources/aibrowse.ico');
    ordinaryPath(asarPath);
    ordinaryPath(sourcePath);
    const asarHash = hash(physicalFs.readFileSync(asarPath));
    const source = physicalFs.readFileSync(sourcePath);
    const iconPath = join(asarPath, 'resources/aibrowse.ico');
    // Electron's patched fs and nativeImage independently consume the real ASAR path.
    const packaged = fs.readFileSync(iconPath);
    assert(source.length > 0);
    assert.deepEqual(packaged, source, 'ASAR图标字节必须与受控源码一致');
    const image = nativeImage.createFromPath(iconPath);
    const reference = nativeImage.createFromPath(sourcePath);
    assert(!image.isEmpty(), 'ASAR图标必须能被Electron实际加载');
    assert(!reference.isEmpty(), '源码图标必须能被Electron实际加载');
    const size = image.getSize();
    assert(size.width > 0 && size.height > 0);
    assert.deepEqual(size, reference.getSize());
    assert.equal(hash(image.toPNG()), hash(reference.toPNG()), '内嵌与源码图标必须同样渲染');
    assert.equal(hash(physicalFs.readFileSync(asarPath)), asarHash, '验证期间ASAR不可变化');
    assert.equal(hash(physicalFs.readFileSync(sourcePath)), hash(source));
    report.artifacts = {
      asarPath,
      asarSha256: asarHash,
      iconSha256: hash(source),
      iconBytes: source.length,
      size,
      renderedSha256: hash(image.toPNG()),
    };
    report.passed = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
  } finally {
    clearTimeout(timer);
    persist();
    process.stdout.write(`${root}\npassed=${report.passed}\n`);
    process.exitCode = report.passed ? 0 : 1;
    app.quit();
  }
});
