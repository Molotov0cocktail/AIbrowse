import { join, resolve } from 'node:path';
import { identity, type Approval } from '../product-restore-process/protocol';
import type { Ports, UiRequest, UiReceipt } from './contract';
import { need } from './contract';
import { hash, object, read, save } from './files';

export type External = (executable: string, args: string[], deadline: number) => Promise<void>;
export function verifyQuiescentJob(bytes: Buffer): void {
  const job = object(bytes, [
    'version',
    'hardTotalLimit',
    'limitFlags',
    'sampledCounts',
    'total',
    'identities',
  ]);
  need(
    job.version === 1 &&
      job.hardTotalLimit === 24 &&
      job.limitFlags === 0x2008 &&
      typeof job.total === 'number' &&
      Number.isSafeInteger(job.total) &&
      job.total >= 2 &&
      job.total <= 4,
  );
  const counts = object(Buffer.from(JSON.stringify(job.sampledCounts)), [
    'main',
    'guardian',
    'chromium',
    'utility',
    'tools',
  ]);
  need(
    counts.main === 0 &&
      counts.guardian === 0 &&
      counts.chromium === 0 &&
      counts.utility === 0 &&
      counts.tools === job.total,
  );
  need(Array.isArray(job.identities) && job.identities.length === job.total);
}
const same = (a: ReturnType<typeof identity>, b: ReturnType<typeof identity>): boolean =>
  a.pid === b.pid && a.created === b.created && a.image.toLowerCase() === b.image.toLowerCase();
export function verifyUi(bytes: Buffer, request: UiRequest): UiReceipt {
  const value = object(bytes, [
    'version',
    'scene',
    'actionSequence',
    'action',
    'ok',
    'identity',
    'mainWindowHandle',
    'elapsedMs',
    'failure',
  ]);
  need(
    value.version === 1 &&
      value.scene === request.scene &&
      value.actionSequence === request.sequence &&
      value.action === request.action &&
      value.ok === true &&
      value.failure === 'none' &&
      same(identity(value.identity), request.identity) &&
      typeof value.mainWindowHandle === 'string' &&
      /^[1-9][0-9]{0,18}$/u.test(value.mainWindowHandle) &&
      BigInt(value.mainWindowHandle) <= 9223372036854775807n &&
      typeof value.elapsedMs === 'number' &&
      Number.isFinite(value.elapsedMs) &&
      value.elapsedMs >= 0 &&
      value.elapsedMs < 30_000,
  );
  return { mainWindowHandle: value.mainWindowHandle };
}
type Confirmation = Parameters<Ports['confirm']>[0];
export function verifyConfirmation(bytes: Buffer, request: Confirmation): void {
  const value = object(bytes, [
    'version',
    'scene',
    'transition',
    'actionSequence',
    'purpose',
    'result',
    'ok',
    'actionCount',
    'elapsedMs',
    'failure',
  ]);
  need(
    value.version === 1 &&
      value.scene === request.scene &&
      value.transition === request.transition &&
      value.actionSequence === request.sequence &&
      value.purpose === request.purpose &&
      value.ok === true &&
      value.result === (request.approved ? 'approved' : 'cancelled') &&
      value.actionCount === 1 &&
      value.failure === 'none' &&
      typeof value.elapsedMs === 'number' &&
      Number.isFinite(value.elapsedMs) &&
      value.elapsedMs >= 0 &&
      value.elapsedMs < 30_000,
  );
}
export function uiPort(
  journal: string,
  runId: string,
  external: External,
): Pick<Ports, 'ui' | 'confirm'> {
  const common = (request: UiRequest | Confirmation): string[] => [
    '-Scene',
    request.scene,
    '-ActionSequence',
    String(request.sequence),
    '-ProcessId',
    String(request.identity.pid),
    '-CreatedFileTime',
    request.identity.created,
    '-Executable',
    request.identity.image,
    '-Journal',
    journal,
    '-BudgetMs',
    String(Math.min(30_000, Math.floor(request.deadline - performance.now()))),
  ];
  return {
    async ui(request) {
      need(performance.now() < request.deadline);
      await external(
        'pwsh.exe',
        [
          '-NoProfile',
          '-STA',
          '-File',
          resolve('tools/data-qualification/product-restore-ui/ui.ps1'),
          ...common(request),
          '-Action',
          request.action,
          ...(request.target ? ['-Target', request.target] : []),
          ...(request.variant ? ['-Variant', request.variant] : []),
        ],
        request.deadline + 5000,
      );
      const bytes = await read(
        join(journal, 'runner-output/restore-ui', `${request.scene}-a${request.sequence}.json`),
      );
      const receipt = verifyUi(bytes, request);
      need(performance.now() < request.deadline);
      return receipt;
    },
    async confirm(request) {
      need(performance.now() < request.deadline);
      await external(
        'pwsh.exe',
        [
          '-NoProfile',
          '-STA',
          '-File',
          resolve('tools/data-qualification/product-restore-ui/confirm.ps1'),
          ...common(request),
          '-Transition',
          String(request.transition),
          '-Purpose',
          request.purpose,
          '-Action',
          request.approved ? 'Approve' : 'Cancel',
          '-MainWindowHandle',
          request.mainWindowHandle,
        ],
        request.deadline + 5000,
      );
      const prefix = join(
        journal,
        'runner-output/restore-native',
        `${request.scene}-t${request.transition}-a${request.sequence}`,
      );
      const raw = await read(prefix + '-native.json');
      verifyConfirmation(raw, request);
      need(performance.now() < request.deadline);
      const projection: Approval = {
        version: 1,
        runId,
        scene: request.scene,
        transition: request.transition,
        actionSequence: request.sequence,
        purpose: request.purpose,
        result: request.approved ? 'approved' : 'cancelled',
        nativeReceiptSha256: hash(raw),
      };
      await save(prefix + '.json', projection);
      need(performance.now() < request.deadline);
    },
  };
}
