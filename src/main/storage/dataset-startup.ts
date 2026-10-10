import { statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { clearActiveDataset, readActiveDataset } from './dataset-active';
import { DatasetSwitch } from './dataset-switch';
import {
  checkedStat,
  readMetadata,
  type DatasetContext,
  type DatasetScope,
} from './dataset-layout';
import { openVerifiedTransferDb, type DbHandle } from '../sources/db/sqlite-driver';
import { transferMetadataAllocation } from './transfer-space';
import { DatasetReplacement, readRecoveryGate } from './dataset-replacement';

export type DatasetStartupState = 'normal' | 'checking' | 'recovery-required';
type Domain = 'sources' | 'research' | 'watch';
type HealthHandle = ReturnType<typeof openVerifiedTransferDb>;

export interface DatasetStartupOptions {
  assertNoWriters(mode: 'before-stores' | 'read-only-health'): void;
}

/** Runs under the single-instance lock before the first Store is opened. */
export class DatasetStartup {
  constructor(private readonly options: DatasetStartupOptions) {}
  private state: DatasetStartupState = 'normal';
  private scope: DatasetScope | null = null;
  private engine: DatasetSwitch | null = null;
  private replacement: DatasetReplacement | null = null;
  private context: DatasetContext | null = null;
  private proofMode: 'before-stores' | 'read-only-health' = 'before-stores';
  private readonly handles = new Map<Domain, HealthHandle>();
  private attempted = false;
  private committed = false;
  getState(): DatasetStartupState {
    return this.state;
  }
  isChecking(): boolean {
    return this.state === 'checking';
  }
  hasOpenHealthHandles(): boolean {
    return this.handles.size > 0;
  }

  async prepare(root: string): Promise<DatasetStartupState> {
    if (this.attempted) throw new Error('启动数据维护不能重复执行');
    this.attempted = true;
    try {
      this.options.assertNoWriters(this.proofMode);
      const context: DatasetContext = {
        check: async () => {
          this.options.assertNoWriters(this.proofMode);
          const fs = await statfs(root, { bigint: true });
          this.options.assertNoWriters(this.proofMode);
          if (fs.bavail <= 0n || fs.bsize <= 0n) throw new Error('数据恢复空间不足');
        },
        requireRollbackSpace: async (bytes) => {
          this.options.assertNoWriters(this.proofMode);
          const fs = await statfs(root, { bigint: true });
          this.options.assertNoWriters(this.proofMode);
          // Metadata/temporary metadata are counted separately from the measured R.
          // R already includes each old file/directory allocation; reserve the
          // fixed metadata plus the three possibly missing live domain directories.
          const metadata = transferMetadataAllocation(fs.bsize) + 3n * fs.bsize;
          if (
            !Number.isSafeInteger(bytes) ||
            bytes < 0 ||
            fs.bavail * fs.bsize < BigInt(bytes) + metadata
          )
            throw new Error('数据回退副本所需空间不足');
        },
      };
      this.context = context;
      const gate = await readRecoveryGate(root, context);
      const scope = await readActiveDataset(root);
      this.options.assertNoWriters(this.proofMode);
      if (scope === null) {
        if (gate || (await readRecoveryGate(root, context))) this.state = 'recovery-required';
        this.options.assertNoWriters(this.proofMode);
        return this.state;
      }
      this.state = 'recovery-required';
      this.scope = scope;
      if (scope.purpose === 'backup') return this.state;
      const replacementRecord = await checkedStat(join(scope.operationRoot, 'replacement.json'));
      const replacementTemporary = await checkedStat(
        join(scope.operationRoot, 'replacement.json.tmp'),
      );
      if (gate || replacementRecord || replacementTemporary) {
        this.replacement = new DatasetReplacement(scope, {
          ...context,
          assertNoWriters: () => this.options.assertNoWriters(this.proofMode),
        });
        if (gate) await this.replacement.verifyActive();
        else {
          // A retired gate can precede active removal only after durable commit.
          // This is an admission precondition, not a journal authenticity proof;
          // DatasetSwitch and DatasetReplacement both verify the full records below.
          const journal = await readMetadata(scope, 'journal.json');
          if (
            typeof journal !== 'object' ||
            journal === null ||
            Array.isArray(journal) ||
            !('phase' in journal) ||
            journal.phase !== 'committed'
          )
            throw new Error('恢复屏障凭据不完整');
        }
      }
      this.engine = new DatasetSwitch(scope, context);
      const result = await this.engine.resumeAtStartup();
      if (result.state === 'committed') {
        this.committed = true;
        await this.replacement?.retireGateAfterCommit(() => {
          this.options.assertNoWriters(this.proofMode);
          if (!this.committed) throw new Error('恢复尚未提交');
        });
        if (await readRecoveryGate(root, context)) throw new Error('恢复屏障尚未退役');
        this.options.assertNoWriters(this.proofMode);
        await clearActiveDataset(scope);
        this.options.assertNoWriters(this.proofMode);
        this.state = 'normal';
      } else if (result.state === 'old-restored' && !this.replacement) {
        if (await readRecoveryGate(root, context)) throw new Error('旧数据仍受恢复屏障保护');
        this.options.assertNoWriters(this.proofMode);
        await clearActiveDataset(scope);
        this.options.assertNoWriters(this.proofMode);
        this.state = 'normal';
      } else if (result.state === 'new-awaiting-health') this.state = 'checking';
    } catch {
      this.state = 'recovery-required';
    }
    return this.state;
  }

  open(domain: Domain): DbHandle {
    if (this.state !== 'checking' || !this.scope || this.handles.has(domain))
      throw new Error('恢复数据健康句柄不可用');
    this.proofMode = 'read-only-health';
    this.options.assertNoWriters(this.proofMode);
    const value = openVerifiedTransferDb(join(this.scope.userDataRoot, domain, `${domain}.db`));
    this.handles.set(domain, value);
    this.options.assertNoWriters(this.proofMode);
    return value.handle;
  }

  async complete(servicesHealthy: boolean | (() => boolean)): Promise<boolean> {
    const healthy = (): boolean =>
      typeof servicesHealthy === 'function' ? servicesHealthy() === true : servicesHealthy === true;
    if (
      this.state !== 'checking' ||
      !this.engine ||
      !this.scope ||
      !this.context ||
      this.handles.size !== 3 ||
      !healthy()
    )
      return false;
    try {
      this.options.assertNoWriters(this.proofMode);
      const result = await this.engine.commitHealthy();
      if (result.state !== 'committed') throw new Error('恢复数据健康提交失败');
      this.committed = true;
      const assertCommitted = (): void => {
        this.options.assertNoWriters(this.proofMode);
        if (!this.committed || !healthy()) throw new Error('恢复数据准入已关闭');
      };
      await this.replacement?.retireGateAfterCommit(assertCommitted);
      if (await readRecoveryGate(this.scope.userDataRoot, this.context))
        throw new Error('恢复屏障尚未退役');
      assertCommitted();
      // A committed pointer is retired before any legitimate business mutation.
      // A crash before this unlink can still verify the exact committed bytes.
      await clearActiveDataset(this.scope);
      assertCommitted();
      for (const value of this.handles.values()) value.activateWrites();
      this.state = 'normal';
      return true;
    } catch {
      this.state = 'recovery-required';
      return false;
    }
  }

  /** Caller has kept all producers and renderer data admission closed. */
  async fail(): Promise<'old-restored' | 'recovery-required'> {
    this.state = 'recovery-required';
    let closed = true;
    for (const value of this.handles.values()) {
      try {
        value.handle.close();
      } catch {
        closed = false;
      }
    }
    if (!closed) return 'recovery-required';
    this.handles.clear();
    this.proofMode = 'before-stores';
    if (this.committed || !this.engine || !this.scope) return 'recovery-required';
    try {
      this.options.assertNoWriters(this.proofMode);
      const result = await this.engine.rollbackAfterFailure();
      if (result.state !== 'old-restored' && result.state !== 'old-unchanged')
        return 'recovery-required';
      // Old-unchanged without a journal proof is retained for explicit diagnosis.
      if (result.state === 'old-restored') {
        if (
          this.replacement ||
          !this.context ||
          (await readRecoveryGate(this.scope.userDataRoot, this.context))
        )
          return 'recovery-required';
        this.options.assertNoWriters(this.proofMode);
        await clearActiveDataset(this.scope);
        return 'old-restored';
      }
    } catch {
      return 'recovery-required';
    }
    return 'recovery-required';
  }
}
