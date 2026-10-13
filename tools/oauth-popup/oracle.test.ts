import { describe, expect, it } from 'vitest';
import {
  assessGeneralPopupCases,
  assessOAuthPopup,
  type OAuthPopupBoundary,
  type OAuthPopupFacts,
} from './oracle';

const boundary: OAuthPopupBoundary = {
  protocolRequests: 2,
  requestBudget: 30,
  unexpectedExternalRequests: [],
  cookiesBefore: 0,
  cookiesAfter: 0,
  providerCalls: 0,
};

const secureChild = {
  childRequireKind: 'undefined',
  childProcessKind: 'undefined',
  childElectronKind: 'undefined',
} as const;

describe('OAuth 弹窗真实探针 oracle', () => {
  it('甄别 deny 后重开普通标签导致的旧缺陷', () => {
    const facts: OAuthPopupFacts = {
      sourceClickTrusted: true,
      popupReturnKind: 'null',
      targetLoaded: true,
      targetOpenerPresent: false,
      sourceReceivedReady: false,
      targetReceivedAck: false,
      sourceReceivedComplete: false,
      childClosed: false,
      ...secureChild,
    };
    expect(assessOAuthPopup(facts, boundary)).toEqual({
      legacyFailureObserved: true,
      nativePopupSemanticsObserved: false,
      boundaryPassed: true,
      failures: [],
    });
  });

  it('要求同步 WindowProxy、opener、双向 postMessage 与 window.close 同时闭合', () => {
    const facts: OAuthPopupFacts = {
      sourceClickTrusted: true,
      popupReturnKind: 'object',
      targetLoaded: true,
      targetOpenerPresent: true,
      sourceReceivedReady: true,
      targetReceivedAck: true,
      sourceReceivedComplete: true,
      childClosed: true,
      ...secureChild,
    };
    expect(assessOAuthPopup(facts, boundary)).toEqual({
      legacyFailureObserved: false,
      nativePopupSemanticsObserved: true,
      boundaryPassed: true,
      failures: [],
    });
  });

  it('拒绝把越预算、外部请求、Cookie 或远程 Node 权限冒充通过', () => {
    const facts: OAuthPopupFacts = {
      sourceClickTrusted: true,
      popupReturnKind: 'object',
      targetLoaded: true,
      targetOpenerPresent: true,
      sourceReceivedReady: true,
      targetReceivedAck: true,
      sourceReceivedComplete: true,
      childClosed: true,
      childRequireKind: 'function',
      childProcessKind: 'object',
      childElectronKind: 'object',
    };
    const result = assessOAuthPopup(facts, {
      ...boundary,
      protocolRequests: 31,
      unexpectedExternalRequests: ['https://unexpected.invalid/'],
      cookiesAfter: 1,
    });
    expect(result.nativePopupSemanticsObserved).toBe(true);
    expect(result.boundaryPassed).toBe(false);
    expect(result.failures).toContain('隔离网络、Cookie 或远程页权限边界未满足');
  });

  it('通用门要求两个不同来源闭合，并保留 noopener 普通标签跨源页导航存活', () => {
    const fixed = assessOAuthPopup(
      {
        sourceClickTrusted: true,
        popupReturnKind: 'object',
        targetLoaded: true,
        targetOpenerPresent: true,
        sourceReceivedReady: true,
        targetReceivedAck: true,
        sourceReceivedComplete: true,
        childClosed: true,
        ...secureChild,
      },
      boundary,
    );
    expect(
      assessGeneralPopupCases(fixed, fixed, {
        sourceClickTrusted: true,
        openerPresent: false,
        navigated: true,
        childStillAlive: true,
      }),
    ).toBe(true);
    expect(
      assessGeneralPopupCases(fixed, fixed, {
        sourceClickTrusted: true,
        openerPresent: false,
        navigated: true,
        childStillAlive: false,
      }),
    ).toBe(false);
  });
});
