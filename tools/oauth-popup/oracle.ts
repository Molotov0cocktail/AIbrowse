export interface OAuthPopupFacts {
  readonly sourceClickTrusted: boolean;
  readonly popupReturnKind: 'null' | 'object' | 'unknown';
  readonly targetLoaded: boolean;
  readonly targetOpenerPresent: boolean | null;
  readonly sourceReceivedReady: boolean;
  readonly targetReceivedAck: boolean;
  readonly sourceReceivedComplete: boolean;
  readonly childClosed: boolean;
  readonly childRequireKind: string | null;
  readonly childProcessKind: string | null;
  readonly childElectronKind: string | null;
}

export interface OAuthPopupBoundary {
  readonly protocolRequests: number;
  readonly requestBudget: number;
  readonly unexpectedExternalRequests: readonly string[];
  readonly cookiesBefore: number;
  readonly cookiesAfter: number;
  readonly providerCalls: number;
}

export interface OAuthPopupAssessment {
  readonly legacyFailureObserved: boolean;
  readonly nativePopupSemanticsObserved: boolean;
  readonly boundaryPassed: boolean;
  readonly failures: readonly string[];
}

export interface NoopenerNavigationFacts {
  readonly sourceClickTrusted: boolean;
  readonly openerPresent: boolean;
  readonly navigated: boolean;
  readonly childStillAlive: boolean;
}

export function assessOAuthPopup(
  facts: OAuthPopupFacts,
  boundary: OAuthPopupBoundary,
): OAuthPopupAssessment {
  const legacyFailureObserved =
    facts.sourceClickTrusted &&
    facts.popupReturnKind === 'null' &&
    facts.targetLoaded &&
    facts.targetOpenerPresent === false &&
    !facts.sourceReceivedReady &&
    !facts.targetReceivedAck &&
    !facts.sourceReceivedComplete &&
    !facts.childClosed;
  const nativePopupSemanticsObserved =
    facts.sourceClickTrusted &&
    facts.popupReturnKind === 'object' &&
    facts.targetLoaded &&
    facts.targetOpenerPresent === true &&
    facts.sourceReceivedReady &&
    facts.targetReceivedAck &&
    facts.sourceReceivedComplete &&
    facts.childClosed;
  const boundaryPassed =
    boundary.protocolRequests > 0 &&
    boundary.protocolRequests <= boundary.requestBudget &&
    boundary.unexpectedExternalRequests.length === 0 &&
    boundary.cookiesBefore === 0 &&
    boundary.cookiesAfter === 0 &&
    boundary.providerCalls === 0 &&
    facts.childRequireKind === 'undefined' &&
    facts.childProcessKind === 'undefined' &&
    facts.childElectronKind === 'undefined';
  const failures: string[] = [];
  if (!facts.sourceClickTrusted) failures.push('合成登录点击不是受信实体输入');
  if (!facts.targetLoaded) failures.push('Google 合成目标未加载');
  if (!boundaryPassed) failures.push('隔离网络、Cookie 或远程页权限边界未满足');
  if (!legacyFailureObserved && !nativePopupSemanticsObserved)
    failures.push('结果既不符合旧缺陷，也不符合修复后的原生弹窗语义');
  return { legacyFailureObserved, nativePopupSemanticsObserved, boundaryPassed, failures };
}

export function assessGeneralPopupCases(
  primary: OAuthPopupAssessment,
  secondary: OAuthPopupAssessment,
  noopener: NoopenerNavigationFacts,
): boolean {
  return (
    primary.boundaryPassed &&
    primary.nativePopupSemanticsObserved &&
    secondary.boundaryPassed &&
    secondary.nativePopupSemanticsObserved &&
    noopener.sourceClickTrusted &&
    !noopener.openerPresent &&
    noopener.navigated &&
    noopener.childStillAlive
  );
}
