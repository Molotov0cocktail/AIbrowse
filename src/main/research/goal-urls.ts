import { MAX_GOAL_CHARS, MAX_SOURCE_CANDIDATES } from '../../shared/types/research';
import { normalizeSourceUrl } from '../sources/domain/source-canonical';

/** Extract literal, bounded URLs only; never decode nested/encoded schemes. */
export function extractGoalUrls(goal: string): string[] {
  if (typeof goal !== 'string' || goal.length > MAX_GOAL_CHARS) return [];
  const urls = new Map<string, string>();
  let consumedUntil = 0;
  const pattern = /https?:\/\/[^\s<>"'`，。；！？、（）【】《》]+/giu;
  for (const match of goal.matchAll(pattern)) {
    const start = match.index;
    if (start < consumedUntil) continue;
    const previous = goal[start - 1] ?? '';
    const tokenPrefix = goal.slice(0, start).match(/[\x21-\x7e]+$/u)?.[0] ?? '';
    if (/[a-z][a-z0-9+.-]*:/iu.test(tokenPrefix)) continue;
    // An ASCII URI/token prefix means this is an embedded URL, not an explicit target.
    if (
      previous !== '' &&
      !/[\s<([{'"`，。；！？、（【《：]/u.test(previous) &&
      /[\x21-\x7e]/u.test(previous)
    )
      continue;
    let raw = match[0];
    if (previous === '<') {
      const end = goal.indexOf('>', start);
      if (end < 0) continue;
      raw = goal.slice(start, end);
      consumedUntil = end + 1;
    } else {
      let prior: string;
      do {
        prior = raw;
        raw = raw.replace(/[.,;:!?]+$/u, '');
        for (const [left, right] of [
          ['(', ')'],
          ['[', ']'],
          ['{', '}'],
        ] as const) {
          if (raw.endsWith(right) && raw.split(right).length > raw.split(left).length) {
            raw = raw.slice(0, -1);
          }
        }
      } while (raw !== prior);
    }
    const normalized = normalizeSourceUrl(raw, 'page');
    if (!normalized.ok) continue;
    if (!urls.has(normalized.canonicalKey))
      urls.set(normalized.canonicalKey, normalized.displayUrl);
    if (urls.size === MAX_SOURCE_CANDIDATES) break;
  }
  return [...urls.values()];
}
