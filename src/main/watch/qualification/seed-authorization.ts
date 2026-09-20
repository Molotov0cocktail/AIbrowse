import { getAuthenticatedQualificationLaunch } from './launch-authority';
import { H3B_DESCRIPTOR_SHA256, H3B_EXPANDED_SHA256 } from './manifest';
import { join } from 'node:path';
import { getQualificationContext } from './context';

declare const seedAuthorizationBrand: unique symbol;
export interface QualificationSeedAuthorization {
  readonly [seedAuthorizationBrand]: true;
}
export type QualificationSeedPhase = 'sources' | 'rules' | 'schedule' | 'digests';
const PHASES: readonly QualificationSeedPhase[] = ['sources', 'rules', 'schedule', 'digests'];
interface SeedState {
  m0Ms: number;
  nextPhase: number;
  pending: QualificationSeedPhase | null;
}
const seeds = new WeakMap<QualificationSeedAuthorization, SeedState>();
let issued = false;

/** Called only after the real native writer accepted this launch's first ready frame. */
export function issueQualificationSeedAuthorization(m0Ms: number): QualificationSeedAuthorization {
  const { native, launch } = getAuthenticatedQualificationLaunch();
  if (!getQualificationContext().isSeedPhaseOpen('sources', m0Ms))
    throw new Error('资格seed入口尚未关闭');
  const qpc = native.readQpc();
  if (
    issued ||
    qpc.frequency !== launch.identity.qpcFrequency ||
    !Number.isSafeInteger(m0Ms) ||
    m0Ms % 60_000 !== 0
  )
    throw new Error('资格seed授权无效');
  const auth = Object.freeze({}) as QualificationSeedAuthorization;
  issued = true;
  seeds.set(auth, { m0Ms, nextPhase: 0, pending: null });
  return auth;
}

export function assertQualificationSeedDatabase(
  auth: QualificationSeedAuthorization,
  kind: 'sources' | 'watch',
  actualDbPath: string,
): void {
  const { prepared } = getAuthenticatedQualificationLaunch();
  if (!seeds.has(auth) || actualDbPath !== join(prepared.paths.userDataRoot, kind, `${kind}.db`)) {
    throw new Error('资格seed数据库所有权无效');
  }
}

export function assertQualificationSeedAuthorization(
  auth: QualificationSeedAuthorization,
  phase: QualificationSeedPhase,
  descriptorHash: string,
  expandedHash: string,
  m0Ms: number,
): void {
  getAuthenticatedQualificationLaunch();
  if (!getQualificationContext().isSeedPhaseOpen(phase, m0Ms))
    throw new Error('资格seed阶段入口无效');
  const state = seeds.get(auth);
  if (
    state === undefined ||
    state.m0Ms !== m0Ms ||
    PHASES[state.nextPhase] !== phase ||
    state.pending !== null ||
    descriptorHash !== H3B_DESCRIPTOR_SHA256 ||
    expandedHash !== H3B_EXPANDED_SHA256
  ) {
    throw new Error('资格seed授权或阶段无效');
  }
  state.pending = phase;
}

export function completeQualificationSeed(
  auth: QualificationSeedAuthorization,
  phase: QualificationSeedPhase,
): void {
  const state = seeds.get(auth);
  if (state === undefined || state.pending !== phase || PHASES[state.nextPhase] !== phase) {
    throw new Error('资格seed完成状态无效');
  }
  state.pending = null;
  ++state.nextPhase;
}
