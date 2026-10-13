import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type {
  QualifiedScriptId,
  QualifiedScriptResult,
  QualifiedScriptStatus,
  ScriptValue,
} from '../../shared/types/qualified-userscripts';
import { QUALIFIED_SCRIPT_CATALOG, type CatalogAsset, type CatalogEntry } from './catalog';
import { decodeUserScript, readBoundedRegularFile } from '../userscripts/store';

const IDS: readonly QualifiedScriptId[] = ['ac-baidu', 'github-zh'];
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_ASSET_BYTES = 4 * 1024 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_VALUES_BYTES = 256 * 1024;
const MAX_VALUE_STRING_BYTES = 64 * 1024;
const MAX_VALUE_DEPTH = 12;
const MAX_VALUE_NODES = 10_000;
const MAX_KEY_LENGTH = 128;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

interface QualifiedScriptStoreOptions {
  directory: string;
  fetchText(url: string, signal?: AbortSignal): Promise<string>;
  /** Tests may replace bytes and hashes without widening the production catalog. */
  testCatalog?: Readonly<Record<QualifiedScriptId, CatalogEntry>>;
}

interface StateRecord {
  revision: string;
  enabled: boolean;
  values: Record<string, ScriptValue>;
}

interface DecodedBundle {
  revision: string;
  texts: ReadonlyMap<string, string>;
}

interface BundleSnapshot {
  exists: boolean;
  digest: string | null;
  valid: DecodedBundle | null;
  issue: string | null;
}

export interface EnabledQualifiedScript {
  entry: CatalogEntry;
  source: string;
  requires: string[];
  resources: Record<string, string>;
  values: Record<string, ScriptValue>;
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function digest(bytes: Buffer | null): string | null {
  return bytes === null ? null : sha256(bytes);
}

function validRevision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
  );
}

function validKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= MAX_KEY_LENGTH &&
    !Array.from(key).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    }) &&
    !FORBIDDEN_KEYS.has(key)
  );
}

function normalizeValues(input: unknown): Record<string, ScriptValue> {
  let nodes = 0;
  const active = new WeakSet<object>();
  const visit = (value: unknown, depth: number): ScriptValue => {
    nodes += 1;
    if (nodes > MAX_VALUE_NODES || depth > MAX_VALUE_DEPTH) throw new Error('值超过复杂度限制。');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('数值必须有限。');
      return value;
    }
    if (typeof value === 'string') {
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_STRING_BYTES)
        throw new Error('字符串超过长度限制。');
      return value;
    }
    if (typeof value !== 'object') throw new Error('值类型不受支持。');
    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype || active.has(value)) throw new Error('数组结构无效。');
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (
        lengthDescriptor === undefined ||
        !('value' in lengthDescriptor) ||
        !Number.isSafeInteger(lengthDescriptor.value) ||
        lengthDescriptor.value < 0 ||
        lengthDescriptor.value > MAX_VALUE_NODES ||
        lengthDescriptor.enumerable ||
        lengthDescriptor.configurable ||
        !lengthDescriptor.writable
      )
        throw new Error('数组结构无效。');
      const length = lengthDescriptor.value as number;
      const properties = Reflect.ownKeys(value);
      if (properties.length !== length + 1) throw new Error('数组结构无效。');
      active.add(value);
      const result: ScriptValue[] = [];
      for (const property of properties) {
        if (property === 'length') continue;
        if (typeof property !== 'string' || !/^(0|[1-9][0-9]*)$/u.test(property))
          throw new Error('数组结构无效。');
        const index = Number(property);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          index >= length ||
          String(index) !== property
        )
          throw new Error('数组结构无效。');
        const descriptor = Object.getOwnPropertyDescriptor(value, property);
        if (
          descriptor === undefined ||
          !('value' in descriptor) ||
          !descriptor.enumerable ||
          !descriptor.configurable ||
          !descriptor.writable
        )
          throw new Error('数组不能包含访问器或异常属性。');
        result[index] = visit(descriptor.value, depth + 1);
      }
      active.delete(value);
      return result;
    }
    if ((prototype !== Object.prototype && prototype !== null) || active.has(value))
      throw new Error('对象结构无效。');
    active.add(value);
    const result: Record<string, ScriptValue> = {};
    for (const property of Reflect.ownKeys(value)) {
      if (typeof property !== 'string' || !validKey(property)) throw new Error('键名无效。');
      const descriptor = Object.getOwnPropertyDescriptor(value, property);
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor))
        throw new Error('对象不能包含访问器或隐藏属性。');
      Object.defineProperty(result, property, {
        value: visit(descriptor.value, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    active.delete(value);
    return result;
  };
  const normalized = visit(input, 0);
  if (normalized === null || typeof normalized !== 'object' || Array.isArray(normalized))
    throw new Error('值集合必须是对象。');
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_VALUES_BYTES)
    throw new Error('脚本存储超过 256 KiB。');
  return normalized;
}

function cloneValues(values: Record<string, ScriptValue>): Record<string, ScriptValue> {
  return normalizeValues(values);
}

function validateAssetText(asset: CatalogAsset, text: string): void {
  if (asset.bytes > MAX_ASSET_BYTES) throw new Error('目录中的单项资源超过 4 MiB。');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256)
    throw new Error(`下载内容与固定版本不一致：${asset.key}`);
}

function validateCatalog(catalog: Readonly<Record<QualifiedScriptId, CatalogEntry>>): void {
  for (const id of IDS) {
    const entry = catalog[id];
    if (entry.id !== id || entry.assets.length === 0 || entry.assets[0]?.kind !== 'source')
      throw new Error('资格脚本目录无效。');
    let total = 0;
    const keys = new Set<string>();
    let resourcesStarted = false;
    for (const [index, asset] of entry.assets.entries()) {
      if (
        !validKey(asset.key) ||
        keys.has(asset.key) ||
        !['source', 'require', 'resource'].includes(asset.kind) ||
        !Number.isSafeInteger(asset.bytes) ||
        asset.bytes < 0 ||
        asset.bytes > MAX_ASSET_BYTES ||
        !/^[A-F0-9]{64}$/u.test(asset.sha256) ||
        !asset.url.startsWith('https://')
      )
        throw new Error('资格脚本目录无效。');
      if (
        (index === 0 && asset.kind !== 'source') ||
        (index > 0 && asset.kind === 'source') ||
        (resourcesStarted && asset.kind === 'require')
      )
        throw new Error('资格脚本目录顺序无效。');
      if (asset.kind === 'resource') resourcesStarted = true;
      keys.add(asset.key);
      total += asset.bytes;
    }
    if (total > MAX_BUNDLE_BYTES) throw new Error('资格脚本目录超过总预算。');
  }
}

function validateProvidedTexts(
  entry: CatalogEntry,
  providedTexts: ReadonlyMap<string, string>,
): void {
  const expectedKeys = new Set(entry.assets.map((asset) => asset.key));
  if (
    providedTexts.size !== expectedKeys.size ||
    Array.from(providedTexts.keys()).some((key) => !expectedKeys.has(key))
  )
    throw new Error('离线安装包资产集合与固定版本不一致。');
  for (const asset of entry.assets) {
    const text = providedTexts.get(asset.key);
    if (text === undefined) throw new Error('离线安装包缺少固定资源。');
    validateAssetText(asset, text);
  }
}

function safeCurrent(isCurrent: () => boolean): boolean {
  try {
    return isCurrent();
  } catch {
    return false;
  }
}

export class QualifiedScriptStore {
  private readonly directory: string;
  private readonly bundlesDirectory: string;
  private readonly statePath: string;
  private readonly fetchText: QualifiedScriptStoreOptions['fetchText'];
  private readonly catalog: Readonly<Record<QualifiedScriptId, CatalogEntry>>;
  private readonly state = new Map<QualifiedScriptId, StateRecord>();
  private readonly bundles = new Map<QualifiedScriptId, BundleSnapshot>();
  private readonly builtInIssues = new Map<QualifiedScriptId, string>();
  private readonly epochs = new Map<QualifiedScriptId, number>();
  private readonly installing = new Map<QualifiedScriptId, AbortController>();
  private stateDigest: string | null = null;
  private stateIssue: string | null = null;
  private disposed = false;

  constructor(options: QualifiedScriptStoreOptions) {
    this.directory = options.directory;
    this.bundlesDirectory = join(options.directory, 'bundles');
    this.statePath = join(options.directory, 'state.json');
    this.fetchText = options.fetchText;
    this.catalog = options.testCatalog ?? QUALIFIED_SCRIPT_CATALOG;
    validateCatalog(this.catalog);
    for (const id of IDS) this.epochs.set(id, 0);
    this.initialize();
  }

  list(): QualifiedScriptStatus[] {
    return IDS.map((id) => this.status(id));
  }

  setBuiltInIssue(id: QualifiedScriptId, issue: string | null): void {
    if (issue === null) this.builtInIssues.delete(id);
    else this.builtInIssues.set(id, issue);
  }

  canRestoreMissingBuiltIn(id: QualifiedScriptId): boolean {
    const bundle = this.bundles.get(id);
    return this.stateIssue === null && this.state.has(id) && bundle?.exists === false;
  }

  getEnabled(): EnabledQualifiedScript[] {
    const result: EnabledQualifiedScript[] = [];
    for (const id of IDS) {
      if (!this.status(id).enabled) continue;
      const entry = this.catalog[id];
      const bundle = this.bundles.get(id)?.valid;
      const state = this.state.get(id);
      if (bundle === null || bundle === undefined || state === undefined) continue;
      const sourceAsset = entry.assets[0];
      const source = bundle.texts.get(sourceAsset.key);
      if (source === undefined) continue;
      const requires: string[] = [];
      const resources: Record<string, string> = {};
      for (const asset of entry.assets.slice(1)) {
        const text = bundle.texts.get(asset.key);
        if (text === undefined) continue;
        if (asset.kind === 'require') requires.push(text);
        else if (asset.kind === 'resource') resources[asset.key] = text;
      }
      result.push({
        entry,
        source,
        requires,
        resources,
        values: cloneValues(state.values),
      });
    }
    return result;
  }

  async install(
    id: QualifiedScriptId,
    isCurrent: () => boolean,
    providedTexts?: ReadonlyMap<string, string>,
    preserveExistingEnabled = false,
  ): Promise<QualifiedScriptResult> {
    if (this.disposed) return { ok: false, message: '资格脚本管理已关闭。' };
    if (this.stateIssue !== null) return { ok: false, message: this.stateIssue };
    if (this.installing.has(id)) return { ok: false, message: '该脚本正在安装，请稍后重试。' };
    if (!safeCurrent(isCurrent)) return { ok: true, cancelled: true };
    const controller = new AbortController();
    const expectedEpoch = this.epochs.get(id) ?? 0;
    this.installing.set(id, controller);
    try {
      const entry = this.catalog[id];
      if (providedTexts !== undefined) validateProvidedTexts(entry, providedTexts);
      const existing = this.bundles.get(id);
      if (existing?.valid !== null && existing?.valid !== undefined) {
        const verified = this.revalidateBundle(id, existing);
        if (verified === null)
          return { ok: false, message: '脚本安装包已变化，当前已停用；请重新安装恢复。' };
        return this.commitExisting(id, verified, expectedEpoch, isCurrent);
      }
      const texts = new Map<string, string>();
      let total = 0;
      for (const asset of entry.assets) {
        if (!this.installActive(id, expectedEpoch, isCurrent)) return { ok: true, cancelled: true };
        const text =
          providedTexts === undefined
            ? await this.fetchText(asset.url, controller.signal)
            : providedTexts.get(asset.key);
        if (text === undefined) throw new Error('离线安装包缺少固定资源。');
        validateAssetText(asset, text);
        total += Buffer.byteLength(text, 'utf8');
        if (total > MAX_BUNDLE_BYTES) throw new Error('下载内容超过 16 MiB 总预算。');
        texts.set(asset.key, text);
      }
      if (!this.installActive(id, expectedEpoch, isCurrent)) return { ok: true, cancelled: true };
      const revision = randomUUID();
      const raw = this.encodeBundle(id, revision, texts);
      const previous = this.bundles.get(id) ?? {
        exists: false,
        digest: null,
        valid: null,
        issue: null,
      };
      this.assertBundleUnchanged(id, previous);
      if (previous.exists) this.preserveBrokenBundle(id);
      this.atomicWrite(this.bundlePath(id), raw);
      const nextBundle: BundleSnapshot = {
        exists: true,
        digest: digest(raw),
        valid: { revision, texts },
        issue: null,
      };
      this.bundles.set(id, nextBundle);
      if (!this.installActive(id, expectedEpoch, isCurrent)) return { ok: true, cancelled: true };
      const previousState = this.state.get(id);
      const nextState = new Map(this.state);
      nextState.set(id, {
        revision,
        enabled:
          preserveExistingEnabled && previousState !== undefined ? previousState.enabled : true,
        values: previousState === undefined ? {} : cloneValues(previousState.values),
      });
      this.saveStateForBundle(id, nextState, nextBundle);
      return { ok: true };
    } catch (error) {
      if (controller.signal.aborted || !this.installActive(id, expectedEpoch, isCurrent))
        return { ok: true, cancelled: true };
      return {
        ok: false,
        message: error instanceof Error ? error.message : '资格脚本安装失败，原状态保持不变。',
      };
    } finally {
      if (this.installing.get(id) === controller) this.installing.delete(id);
    }
  }

  setEnabled(id: QualifiedScriptId, enabled: boolean): QualifiedScriptResult {
    if (this.disposed) return { ok: false, message: '资格脚本管理已关闭。' };
    if (this.stateIssue !== null) return { ok: false, message: this.stateIssue };
    this.bump(id);
    const current = this.state.get(id);
    if (current === undefined) return { ok: false, message: '脚本尚未安装。' };
    let verified: BundleSnapshot | null = null;
    if (enabled) {
      const expected = this.bundles.get(id);
      if (expected?.valid === null || expected?.valid === undefined)
        return { ok: false, message: this.status(id).issue ?? '脚本安装包不可用。' };
      verified = this.revalidateBundle(id, expected);
      if (verified === null)
        return { ok: false, message: '脚本安装包已变化，当前已停用；请重新安装恢复。' };
      const status = this.status(id);
      if (!status.installed || status.issue !== null)
        return { ok: false, message: status.issue ?? '脚本安装包不可用。' };
    }
    const next = new Map(this.state);
    next.set(id, { ...current, enabled, values: cloneValues(current.values) });
    try {
      if (verified === null) this.saveState(next);
      else this.saveStateForBundle(id, next, verified);
      return { ok: true };
    } catch {
      return { ok: false, message: '脚本启用状态无法保存，原状态保持不变。' };
    }
  }

  remove(id: QualifiedScriptId): QualifiedScriptResult {
    if (this.disposed) return { ok: false, message: '资格脚本管理已关闭。' };
    if (this.stateIssue !== null) return { ok: false, message: this.stateIssue };
    this.bump(id);
    const current = this.state.get(id);
    if (current !== undefined) {
      const disabled = new Map(this.state);
      disabled.set(id, { ...current, enabled: false, values: cloneValues(current.values) });
      try {
        this.saveState(disabled);
      } catch {
        return { ok: false, message: '脚本无法先安全停用，未删除安装包。' };
      }
    }
    const bundle = this.bundles.get(id) ?? {
      exists: false,
      digest: null,
      valid: null,
      issue: null,
    };
    try {
      this.assertBundleUnchanged(id, bundle);
      if (bundle.exists) fs.unlinkSync(this.bundlePath(id));
      this.bundles.set(id, { exists: false, digest: null, valid: null, issue: null });
    } catch {
      return { ok: false, message: '脚本安装包无法删除；已保持停用。' };
    }
    if (this.state.has(id)) {
      const next = new Map(this.state);
      next.delete(id);
      try {
        this.saveState(next);
      } catch {
        return { ok: false, message: '安装包已删除；停用记录暂时保留。' };
      }
    }
    return { ok: true };
  }

  getValues(id: QualifiedScriptId): Record<string, ScriptValue> {
    const state = this.state.get(id);
    return this.status(id).enabled && state !== undefined ? cloneValues(state.values) : {};
  }

  setValue(id: QualifiedScriptId, key: unknown, value: unknown): QualifiedScriptResult {
    if (this.disposed) return { ok: false, message: '资格脚本管理已关闭。' };
    if (this.stateIssue !== null) return { ok: false, message: this.stateIssue };
    const status = this.status(id);
    const current = this.state.get(id);
    if (!status.enabled || current === undefined)
      return { ok: false, message: status.issue ?? '脚本未启用。' };
    if (typeof key !== 'string' || !validKey(key))
      return { ok: false, message: '脚本存储键名无效。' };
    let nextValues: Record<string, ScriptValue>;
    try {
      nextValues = cloneValues(current.values);
      Object.defineProperty(nextValues, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      nextValues = normalizeValues(nextValues);
    } catch {
      return { ok: false, message: '脚本存储值不符合安全限制。' };
    }
    const next = new Map(this.state);
    next.set(id, { ...current, values: nextValues });
    try {
      this.saveState(next);
      return { ok: true };
    } catch {
      return { ok: false, message: '脚本存储值无法保存，原值保持不变。' };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of IDS) this.bump(id);
    for (const controller of this.installing.values()) controller.abort();
    this.installing.clear();
  }

  private initialize(): void {
    try {
      this.checkDirectory(this.directory);
      this.checkDirectory(this.bundlesDirectory);
      const raw = this.readStateRaw();
      this.stateDigest = digest(raw);
      if (raw !== null) {
        for (const [id, record] of this.decodeState(raw)) this.state.set(id, record);
      }
    } catch {
      this.stateIssue =
        '资格脚本状态损坏或被外部修改，原文件已保留；本次运行已停用脚本并拒绝覆盖。';
    }
    for (const id of IDS) this.bundles.set(id, this.loadBundle(id));
  }

  private status(id: QualifiedScriptId): QualifiedScriptStatus {
    const entry = this.catalog[id];
    const state = this.state.get(id);
    const bundle = this.bundles.get(id) ?? {
      exists: false,
      digest: null,
      valid: null,
      issue: null,
    };
    let issue = this.builtInIssues.get(id) ?? this.stateIssue ?? bundle.issue;
    if (issue === null && state === undefined && bundle.exists)
      issue = '检测到未完成的安装包，当前未启用；可重新安装恢复。';
    if (issue === null && state !== undefined && !bundle.exists)
      issue = '脚本安装包缺失，当前已停用；可重新安装恢复。';
    if (
      issue === null &&
      state !== undefined &&
      bundle.valid !== null &&
      state.revision !== bundle.valid.revision
    )
      issue = '脚本安装事务未完成，当前已停用；可重新安装恢复。';
    const installed =
      state !== undefined &&
      bundle.exists &&
      bundle.valid !== null &&
      state.revision === bundle.valid.revision;
    return {
      id,
      name: entry.name,
      version: entry.version,
      installed,
      enabled: installed && issue === null && state.enabled,
      issue,
    };
  }

  private async commitExisting(
    id: QualifiedScriptId,
    bundle: BundleSnapshot,
    expectedEpoch: number,
    isCurrent: () => boolean,
  ): Promise<QualifiedScriptResult> {
    if (!this.installActive(id, expectedEpoch, isCurrent)) return { ok: true, cancelled: true };
    if (bundle.valid === null) return { ok: false, message: '完整安装包无法启用。' };
    const current = this.state.get(id);
    const next = new Map(this.state);
    next.set(id, {
      revision: bundle.valid.revision,
      enabled: true,
      values: current === undefined ? {} : cloneValues(current.values),
    });
    try {
      this.saveStateForBundle(id, next, bundle);
      return { ok: true };
    } catch {
      return { ok: false, message: '完整安装包无法启用，原状态保持不变。' };
    }
  }

  private installActive(
    id: QualifiedScriptId,
    expectedEpoch: number,
    isCurrent: () => boolean,
  ): boolean {
    return (
      !this.disposed &&
      this.epochs.get(id) === expectedEpoch &&
      !this.installing.get(id)?.signal.aborted &&
      safeCurrent(isCurrent)
    );
  }

  private bump(id: QualifiedScriptId): void {
    this.epochs.set(id, (this.epochs.get(id) ?? 0) + 1);
    this.installing.get(id)?.abort();
  }

  private bundlePath(id: QualifiedScriptId): string {
    return join(this.bundlesDirectory, `${id}.json`);
  }

  private loadBundle(id: QualifiedScriptId): BundleSnapshot {
    const path = this.bundlePath(id);
    let exists = false;
    let raw: Buffer | null = null;
    try {
      const stat = fs.lstatSync(path);
      exists = true;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
      raw = readBoundedRegularFile(path, MAX_BUNDLE_BYTES);
      return { exists: true, digest: digest(raw), valid: this.decodeBundle(id, raw), issue: null };
    } catch (error) {
      if (missing(error) && !exists)
        return { exists: false, digest: null, valid: null, issue: null };
      return {
        exists: true,
        digest: digest(raw),
        valid: null,
        issue: '脚本安装包损坏或被外部修改，原文件已保留且脚本已停用。',
      };
    }
  }

  private decodeBundle(id: QualifiedScriptId, raw: Buffer): DecodedBundle {
    const parsed: unknown = JSON.parse(decodeUserScript(raw));
    if (
      !closed(parsed, ['version', 'id', 'revision', 'assets']) ||
      parsed.version !== 1 ||
      parsed.id !== id ||
      !validRevision(parsed.revision) ||
      !Array.isArray(parsed.assets)
    )
      throw new Error();
    const expected = this.catalog[id].assets;
    if (parsed.assets.length !== expected.length) throw new Error();
    const texts = new Map<string, string>();
    for (const [index, value] of parsed.assets.entries()) {
      const asset = expected[index];
      if (
        asset === undefined ||
        !closed(value, ['key', 'kind', 'text']) ||
        value.key !== asset.key ||
        value.kind !== asset.kind ||
        typeof value.text !== 'string'
      )
        throw new Error();
      validateAssetText(asset, value.text);
      texts.set(asset.key, value.text);
    }
    return { revision: parsed.revision, texts };
  }

  private encodeBundle(
    id: QualifiedScriptId,
    revision: string,
    texts: ReadonlyMap<string, string>,
  ): Buffer {
    const assets = this.catalog[id].assets.map((asset) => {
      const text = texts.get(asset.key);
      if (text === undefined) throw new Error(`安装包缺少固定资源：${asset.key}`);
      validateAssetText(asset, text);
      return { key: asset.key, kind: asset.kind, text };
    });
    const raw = Buffer.from(`${JSON.stringify({ version: 1, id, revision, assets })}\n`, 'utf8');
    if (raw.length > MAX_BUNDLE_BYTES) throw new Error('安装包超过 16 MiB。');
    this.decodeBundle(id, raw);
    return raw;
  }

  private decodeState(raw: Buffer): Map<QualifiedScriptId, StateRecord> {
    const parsed: unknown = JSON.parse(decodeUserScript(raw));
    if (!closed(parsed, ['version', 'scripts']) || parsed.version !== 1)
      throw new Error('状态格式无效。');
    if (
      parsed.scripts === null ||
      typeof parsed.scripts !== 'object' ||
      Array.isArray(parsed.scripts) ||
      Object.getPrototypeOf(parsed.scripts) !== Object.prototype
    )
      throw new Error('状态格式无效。');
    const keys = Object.keys(parsed.scripts);
    if (keys.some((key) => !IDS.includes(key as QualifiedScriptId)))
      throw new Error('状态包含未知脚本。');
    const result = new Map<QualifiedScriptId, StateRecord>();
    for (const id of IDS) {
      if (!Object.hasOwn(parsed.scripts, id)) continue;
      const value: unknown = (parsed.scripts as Record<string, unknown>)[id];
      if (
        !closed(value, ['revision', 'enabled', 'values']) ||
        !validRevision(value.revision) ||
        typeof value.enabled !== 'boolean'
      )
        throw new Error('状态条目无效。');
      result.set(id, {
        revision: value.revision,
        enabled: value.enabled,
        values: normalizeValues(value.values),
      });
    }
    return result;
  }

  private encodeState(next: ReadonlyMap<QualifiedScriptId, StateRecord>): Buffer {
    const scripts: Partial<Record<QualifiedScriptId, StateRecord>> = {};
    for (const id of IDS) {
      const value = next.get(id);
      if (value === undefined) continue;
      scripts[id] = {
        revision: value.revision,
        enabled: value.enabled,
        values: cloneValues(value.values),
      };
    }
    const raw = Buffer.from(`${JSON.stringify({ version: 1, scripts })}\n`, 'utf8');
    if (raw.length > MAX_STATE_BYTES) throw new Error('脚本状态超过预算。');
    this.decodeState(raw);
    return raw;
  }

  private saveState(
    next: ReadonlyMap<QualifiedScriptId, StateRecord>,
    beforeCommit?: () => void,
  ): void {
    if (this.stateIssue !== null) throw new Error(this.stateIssue);
    const raw = this.encodeState(next);
    try {
      this.checkDirectory(this.directory);
      if (digest(this.readStateRaw()) !== this.stateDigest) throw new Error();
      this.atomicWrite(this.statePath, raw, () => {
        if (digest(this.readStateRaw()) !== this.stateDigest) throw new Error();
        beforeCommit?.();
      });
      this.state.clear();
      for (const [id, record] of this.decodeState(raw)) this.state.set(id, record);
      this.stateDigest = digest(raw);
    } catch {
      try {
        if (digest(this.readStateRaw()) !== this.stateDigest) {
          this.stateIssue = '资格脚本状态被外部修改，原文件已保留；本次运行已停用脚本并拒绝覆盖。';
        }
      } catch {
        this.stateIssue = '资格脚本状态无法确认，原文件已保留；本次运行已停用脚本并拒绝覆盖。';
      }
      throw new Error('脚本状态保存失败。');
    }
  }

  private saveStateForBundle(
    id: QualifiedScriptId,
    next: ReadonlyMap<QualifiedScriptId, StateRecord>,
    expected: BundleSnapshot,
  ): void {
    try {
      this.saveState(next, () => this.assertBundleUnchanged(id, expected));
    } catch (error) {
      this.revalidateBundle(id, expected);
      throw error;
    }
  }

  private revalidateBundle(id: QualifiedScriptId, expected: BundleSnapshot): BundleSnapshot | null {
    const current = this.loadBundle(id);
    if (
      expected.valid !== null &&
      expected.digest !== null &&
      current.valid !== null &&
      current.digest === expected.digest &&
      current.valid.revision === expected.valid.revision
    ) {
      this.bundles.set(id, current);
      return current;
    }
    const invalid: BundleSnapshot = current.exists
      ? {
          ...current,
          valid: null,
          issue: '脚本安装包损坏或被外部修改，原文件已保留且脚本已停用；请重新安装恢复。',
        }
      : {
          exists: false,
          digest: null,
          valid: null,
          issue: '脚本安装包缺失，当前已停用；请重新安装恢复。',
        };
    this.bundles.set(id, invalid);
    const state = this.state.get(id);
    if (state !== undefined) {
      const disabled = new Map(this.state);
      disabled.set(id, {
        ...state,
        revision: randomUUID(),
        enabled: false,
        values: cloneValues(state.values),
      });
      try {
        this.saveState(disabled);
      } catch {
        /* Keep the bundle invalid in memory; saveState records unsafe state-file changes. */
      }
    }
    return null;
  }

  private assertBundleUnchanged(id: QualifiedScriptId, expected: BundleSnapshot): void {
    const path = this.bundlePath(id);
    if (!expected.exists) {
      try {
        fs.lstatSync(path);
        throw new Error('安装包被外部创建。');
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
    }
    if (expected.digest === null) throw new Error('损坏安装包无法安全替换。');
    const current = readBoundedRegularFile(path, MAX_BUNDLE_BYTES);
    if (digest(current) !== expected.digest) throw new Error('安装包已被外部修改。');
  }

  private preserveBrokenBundle(id: QualifiedScriptId): void {
    const original = this.bundlePath(id);
    const backup = join(this.bundlesDirectory, `${id}.corrupt-${randomUUID()}.json`);
    fs.renameSync(original, backup);
  }

  private readStateRaw(): Buffer | null {
    try {
      return readBoundedRegularFile(this.statePath, MAX_STATE_BYTES);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  private checkDirectory(path: string): void {
    try {
      const stat = fs.lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('存储目录无效。');
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }

  private atomicWrite(path: string, raw: Buffer, beforeRename?: () => void): void {
    fs.mkdirSync(this.directory, { recursive: true });
    this.checkDirectory(this.directory);
    fs.mkdirSync(this.bundlesDirectory, { recursive: true });
    this.checkDirectory(this.bundlesDirectory);
    const temporary = `${path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      created = true;
      fs.writeFileSync(descriptor, raw);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      beforeRename?.();
      fs.renameSync(temporary, path);
      created = false;
    } finally {
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {
          /* Preserve the original write error. */
        }
      }
      if (created) {
        try {
          fs.unlinkSync(temporary);
        } catch {
          /* Preserve the original write error. */
        }
      }
    }
  }
}
