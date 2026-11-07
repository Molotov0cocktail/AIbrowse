import { URL } from 'node:url';

// A completed experiment may disprove a route; never label that route PASS.
export function evaluate(result) {
  if (
    !result ||
    result.completed !== true ||
    result.willQuit !== true ||
    result.timedOut !== false ||
    result.error !== null ||
    result.versions?.electron !== '43.8.4' ||
    !Number.isInteger(result.requests) ||
    result.requests < 1 ||
    result.requests > 60
  )
    return { experiment: 'INCOMPLETE', nativeRoute: 'NOT PROVEN', controlledLoading: 'NOT PROVEN' };
  const roles = ['user', 'research', 'watch'];
  let origin;
  try {
    const url = new URL(result.native?.pages?.user?.url);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.port ||
      url.pathname !== '/same' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error('无效夹具地址');
    origin = url.origin;
  } catch {
    return { experiment: 'INCOMPLETE', nativeRoute: 'NOT PROVEN', controlledLoading: 'NOT PROVEN' };
  }
  const validPages = (pages) =>
    roles.every(
      (role) =>
        pages?.[role]?.sameSession === true &&
        Number.isInteger(pages[role].id) &&
        pages[role].observed &&
        pages[role].url === `${origin}/same`,
    ) && new Set(roles.map((role) => pages[role].id)).size === 3;
  const native = result.native?.pages;
  const controlled = result.controlled?.pages;
  if (!validPages(native) || !validPages(controlled))
    return { experiment: 'INCOMPLETE', nativeRoute: 'NOT PROVEN', controlledLoading: 'NOT PROVEN' };
  const leaked = ['research', 'watch'].some((role) => native[role].observed.marker === 'native');
  const controlledOK =
    controlled.user.observed.marker === 'controlled' &&
    ['research', 'watch'].every((role) => controlled[role].observed.marker === null) &&
    roles.every(
      (role) =>
        controlled[role].observed.bridge === 'undefined' &&
        controlled[role].observed.require === 'undefined' &&
        typeof controlled[role].observed.cookie === 'string' &&
        controlled[role].observed.cookie
          .split(';')
          .some((cookie) => cookie.trim() === 'translation_fixture=shared') &&
        Array.isArray(controlled[role].observed.frames) &&
        controlled[role].observed.frames?.length === 2 &&
        controlled[role].observed.frames[0]?.url === `${origin}/frame` &&
        controlled[role].observed.frames[1]?.url === 'about:blank' &&
        controlled[role].observed.frames.every(
          (f) => f && f.marker === null && f.bridge === 'undefined',
        ),
    ) &&
    result.controlled.nativeExtensions === 0 &&
    result.controlled.networkSentinel?.fetchRejected === true &&
    result.controlled.networkSentinel?.deniedOriginHits === 0 &&
    result.controlled.networkSentinel?.deniedByGate === 1 &&
    Array.isArray(result.controlled.audit) &&
    result.controlled.audit.some(
      (item) => item?.id === controlled.user.id && item.allowed === true,
    ) &&
    result.controlled.audit.every(
      (item) => item && (item.allowed === false || item.id === controlled.user.id),
    ) &&
    result.controlled.revokedOnNavigation === true &&
    result.controlled.admittedBeforeClose === true &&
    result.controlled.revokedOnClose === true;
  return {
    experiment: 'COMPLETE',
    nativeRoute: leaked ? 'REJECTED_TASK_INJECTION' : 'NOT PROVEN',
    controlledLoading: controlledOK ? 'PASS_SYNTHETIC_LOADING_ONLY' : 'NOT PROVEN',
    integration: 'NOT RUN',
  };
}
