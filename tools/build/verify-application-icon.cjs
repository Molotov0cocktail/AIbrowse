/* global __dirname, require, process, setTimeout, clearTimeout, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const { join, resolve, dirname } = require('node:path');
const fs = require('node:fs');
const physicalFs = require('original-fs');
const { app, nativeImage } = require('electron');
const { extractFile } = require('@electron/asar');
const { NtExecutable, NtExecutableResource, Resource } = require('resedit');

const repository = physicalFs.realpathSync(resolve(__dirname, '../..'));
const evidenceRoot = join(repository, 'log/icon-design-20261013');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ordinaryPath = (path) => {
  assert.equal(physicalFs.realpathSync(path), path, '路径不应重定向');
  for (let part = path; part !== dirname(part); part = dirname(part)) {
    assert(!physicalFs.lstatSync(part).isSymbolicLink(), '路径不应包含链接');
  }
};

assert.equal(process.argv.length, 2, '此工具不接受外部路径或其它参数');
ordinaryPath(evidenceRoot);
const root = join(evidenceRoot, `verify-application-icon-${randomUUID()}`);
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
  boundary:
    '仅开发Electron解析受控ICO、真实ASAR及PE图标资源；不加载产品入口、不创建窗口或托盘、不网络、不访问真实profile',
};
const persist = () =>
  physicalFs.writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2), {
    flag: 'wx',
  });
const timer = setTimeout(() => {
  report.error = '图标呈现验证超过30秒';
  persist();
  app.exit(1);
}, 30000);

const parseIco = (bytes) => {
  assert.equal(bytes.readUInt16LE(0), 0);
  assert.equal(bytes.readUInt16LE(2), 1);
  const count = bytes.readUInt16LE(4);
  const result = new Map();
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const size = bytes[entry] || 256;
    assert.equal(bytes[entry + 1] || 256, size);
    const length = bytes.readUInt32LE(entry + 8);
    const offset = bytes.readUInt32LE(entry + 12);
    assert(!result.has(size));
    result.set(size, bytes.subarray(offset, offset + length));
  }
  return result;
};

const readPeFrames = (path) => {
  const resources = NtExecutableResource.from(
    NtExecutable.from(physicalFs.readFileSync(path), { ignoreCert: true }),
  );
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  assert.equal(groups.length, 1, `${path} 必须恰好有一个图标组`);
  const group = groups[0];
  return group.icons.map((item) => {
    const size = item.width || 256;
    assert.equal(item.height || 256, size);
    const matches = resources.entries.filter(
      (entry) => entry.type === 3 && entry.id === item.iconID && entry.lang === group.lang,
    );
    assert.equal(matches.length, 1, `${size}px RT_ICON 引用必须唯一`);
    return { size, bytes: Buffer.from(matches[0].bin) };
  });
};

const render = (bytes, size, label) => {
  let image = nativeImage.createFromBuffer(bytes);
  let temporary = null;
  if (image.isEmpty()) {
    const header = Buffer.alloc(22);
    header.writeUInt16LE(0, 0);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(1, 4);
    header[6] = size === 256 ? 0 : size;
    header[7] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, 10);
    header.writeUInt16LE(32, 12);
    header.writeUInt32LE(bytes.length, 14);
    header.writeUInt32LE(22, 18);
    temporary = join(root, `${label}-${size}.ico`);
    physicalFs.writeFileSync(temporary, Buffer.concat([header, bytes]), { flag: 'wx' });
    image = nativeImage.createFromPath(temporary);
  }
  assert(!image.isEmpty(), `${label} ${size}px 无法由Electron解码`);
  assert.deepEqual(image.getSize(), { width: size, height: size });
  if (temporary !== null) physicalFs.unlinkSync(temporary);
  return image.toBitmap();
};

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
      physicalFs.realpathSync(join(repository, 'node_modules/electron/dist/electron.exe')),
    );
    const sourcePath = join(repository, 'resources/aibrowse.ico');
    const asarPath = join(repository, 'release/win-unpacked/resources/app.asar');
    const appPath = join(repository, 'release/win-unpacked/AIbrowse.exe');
    const installerPath = join(
      repository,
      'release',
      `AIbrowse-${metadata.version}-win-x64-internal.exe`,
    );
    for (const path of [sourcePath, asarPath, appPath, installerPath]) ordinaryPath(path);
    const sourceBytes = physicalFs.readFileSync(sourcePath);
    const source = parseIco(sourceBytes);
    const packaged = fs.readFileSync(join(asarPath, 'resources/aibrowse.ico'));
    assert.deepEqual(packaged, sourceBytes, 'ASAR图标字节必须与受控来源一致');
    const sourceImage = nativeImage.createFromPath(sourcePath);
    const asarImage = nativeImage.createFromPath(join(asarPath, 'resources/aibrowse.ico'));
    assert(!sourceImage.isEmpty() && !asarImage.isEmpty());
    assert.deepEqual(asarImage.getSize(), sourceImage.getSize());
    assert.deepEqual(asarImage.toBitmap(), sourceImage.toBitmap());

    const validatePe = (path, strictExact) =>
      readPeFrames(path).map((frame) => {
        const expected = source.get(frame.size);
        assert(expected, `${frame.size}px 没有来源帧`);
        const exact = expected.equals(frame.bytes);
        if (strictExact) assert(exact, `主程序 ${frame.size}px 图标资源未原样绑定`);
        assert.deepEqual(
          render(frame.bytes, frame.size, 'candidate'),
          render(expected, frame.size, 'source'),
          `${frame.size}px 图标呈现像素与来源不同`,
        );
        return {
          size: frame.size,
          exact,
          sourceSha256: hash(expected),
          candidateSha256: hash(frame.bytes),
          renderedEqual: true,
        };
      });
    const appFrames = validatePe(appPath, true);
    assert.deepEqual(
      appFrames.map((frame) => frame.size).sort((left, right) => left - right),
      [...source.keys()].sort((left, right) => left - right),
      '主程序没有完整保留八档来源图标',
    );
    const installerFrames = validatePe(installerPath, false);
    assert(installerFrames.length >= 4);
    assert(installerFrames.some((frame) => frame.size === 16));
    assert(installerFrames.some((frame) => frame.size === 256));
    assert.deepEqual(extractFile(asarPath, 'resources/aibrowse.ico'), sourceBytes);
    report.artifacts = {
      source: { path: sourcePath, sha256: hash(sourceBytes), sizes: [...source.keys()] },
      asar: { path: asarPath, sha256: hash(physicalFs.readFileSync(asarPath)) },
      app: { path: appPath, sha256: hash(physicalFs.readFileSync(appPath)), frames: appFrames },
      installer: {
        path: installerPath,
        sha256: hash(physicalFs.readFileSync(installerPath)),
        frames: installerFrames,
      },
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
