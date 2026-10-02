'use strict';

// This is a deliberately injected, bounded CJS observer, not an OS I/O monitor.
// It never reads existing profiles, calls DPAPI, or replaces native authentication.
const fs = require('node:fs');
const process = require('node:process');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');
const { URL, fileURLToPath } = require('node:url');
const root = path.dirname(process.env.TEMP || '');
const expected = path.join(root, 'user-data');
const mode = process.env.STARTUP_CHECK_CASE;
if (!/run-[A-Z2-7]{26}$/.test(root) || !mode) {
  throw new Error('启动观察器缺少合成环境');
}
let authenticated = false;
let sequence = 0;
let credentialReads = 0;
let addonLoads = 0;
let electronBound = false;
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}
const emit = (kind, fields = {}) => {
  if (++sequence > 1024) throw new Error('启动观察器记录超出预算');
  process.stdout.write(
    `STARTUP_CHECK ${canonical({ kind, sequence, authenticated, ...fields })}\n`,
  );
};
const originalLoad = Module._load;
const originalResolve = Module._resolveFilename;
const originalReadFile = fs.readFileSync;
const seen = new Set();
const classification = (error) =>
  /^qualification-[a-z-]{1,80}$/.test(error?.message) ? error.message : 'unclassified';
function credentialPath(value) {
  const text = value instanceof URL ? fileURLToPath(value) : value;
  if (typeof text !== 'string') return;
  const resolved = path.resolve(text);
  if (!/credentials(?:\.json|\.synthetic)$/i.test(path.basename(resolved))) return;
  const relative = path.relative(root, resolved);
  const synthetic =
    relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  credentialReads += 1;
  emit('credential-read', { synthetic });
  // A read outside this fresh run is evidence of a defect, and is blocked before IO.
  if (!synthetic) throw new Error('启动观察器阻止合成根外凭据读取');
}
for (const name of ['readFileSync', 'readFile', 'openSync', 'open', 'createReadStream']) {
  const original = fs[name];
  fs[name] = function (...args) {
    const flags = args[1];
    const writeOnly =
      (name === 'open' || name === 'openSync') &&
      (typeof flags === 'string'
        ? /^[wa]/.test(flags) && !flags.includes('+')
        : typeof flags === 'number' && (flags & fs.constants.O_WRONLY) !== 0);
    if (!writeOnly) credentialPath(args[0]);
    return Reflect.apply(original, this, args);
  };
}
for (const name of ['readFile', 'open']) {
  const original = fs.promises[name];
  fs.promises[name] = function (...args) {
    const flags = args[1];
    const writeOnly =
      name === 'open' &&
      (typeof flags === 'string'
        ? /^[wa]/.test(flags) && !flags.includes('+')
        : typeof flags === 'number' && (flags & fs.constants.O_WRONLY) !== 0);
    if (!writeOnly) credentialPath(args[0]);
    return Reflect.apply(original, this, args);
  };
}
Module._load = function (request, parent, isMain) {
  const resolved = Reflect.apply(originalResolve, this, [request, parent, isMain]);
  if (typeof resolved === 'string' && path.isAbsolute(resolved) && !seen.has(resolved)) {
    seen.add(resolved);
    const relative = path.relative(process.cwd(), resolved).replaceAll('\\', '/');
    const artifact = /^out\/(?:qualification-diagnostic\/)?main\/[^/]+\.(?:js|node)$/.test(
      relative,
    );
    const positive = relative === 'tools/watch-qualification/startup-check-positive.cjs';
    if (artifact || positive) {
      const bytes = Reflect.apply(originalReadFile, fs, [resolved]);
      if (bytes.length > 16 * 1024 * 1024) throw new Error('启动观察器产物预算超限');
      emit('module-load', {
        category: positive
          ? 'synthetic-positive'
          : relative.endsWith('/watch-qualification.node')
            ? 'qualification-addon'
            : relative.endsWith('/main/index.js')
              ? 'entry'
              : 'chunk',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  const exported = Reflect.apply(originalLoad, this, [request, parent, isMain]);
  // NODE_OPTIONS runs before Electron exposes app. Inspect paths at the real
  // entry's first electron import; installing the observer itself needs no app API.
  if (request === 'electron' && exported?.app && !electronBound) {
    electronBound = true;
    const { app } = exported;
    emit('electron-bound', {
      userDataMatches: app.getPath('userData') === expected,
      sessionDataMatches: app.getPath('sessionData') === expected,
    });
    app.on('will-quit', () => emit('will-quit', { credentialReads, addonLoads }));
  }
  if (typeof resolved !== 'string' || path.basename(resolved) !== 'watch-qualification.node') {
    return exported;
  }
  addonLoads += 1;
  const wrapped = { ...exported };
  wrapped.prepareLaunchIsolation = function (...args) {
    try {
      const result = Reflect.apply(exported.prepareLaunchIsolation, exported, args);
      emit('prepared');
      return result;
    } catch (error) {
      emit('prepare-rejected', { classification: classification(error) });
      throw error;
    }
  };
  wrapped.authenticateLaunchAndConnectTelemetry = function (...args) {
    emit('authenticate-start');
    return Reflect.apply(exported.authenticateLaunchAndConnectTelemetry, exported, args).then(
      (result) => {
        authenticated = true;
        emit('authenticated');
        return result;
      },
      (error) => {
        emit('authenticate-rejected', { classification: classification(error) });
        throw error;
      },
    );
  };
  return wrapped;
};
emit('observer-start', {
  electron: process.versions.electron,
});
process.on('exit', (code) => emit('observer-exit', { code, credentialReads, addonLoads }));
