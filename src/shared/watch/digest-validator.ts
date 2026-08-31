import {
  MAX_DIGEST_EXPLANATION_BYTES,
  MAX_DIGEST_EXPLANATION_SECTIONS,
  MAX_DIGEST_EXPLANATION_SECTION_BYTES,
  MAX_DIGEST_EXPLANATION_SECTION_CHARS,
  MAX_DIGEST_EXPLANATION_TOTAL_CHARS,
  type DigestExplanation,
} from '../types/watch';
import { utf8ByteLength } from './watch-budget';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key, index) => Object.keys(value)[index] === key)
  );
}

function safeExplanation(value: string): boolean {
  if (value.length < 1 || value.length > MAX_DIGEST_EXPLANATION_SECTION_CHARS) return false;
  if (value !== value.trim() || value !== value.normalize('NFC')) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      (code >= 0x200b && code <= 0x200d) ||
      (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return false;
    }
  }
  return utf8ByteLength(value) <= MAX_DIGEST_EXPLANATION_SECTION_BYTES;
}

export function parseDigestExplanation(
  raw: string,
  visibleEventIds: readonly string[],
): DigestExplanation | null {
  if (utf8ByteLength(raw) > MAX_DIGEST_EXPLANATION_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || !exactKeys(value, ['sections']) || JSON.stringify(value) !== raw)
    return null;
  if (
    !Array.isArray(value['sections']) ||
    value['sections'].length < 1 ||
    value['sections'].length > MAX_DIGEST_EXPLANATION_SECTIONS
  )
    return null;
  const order = new Map(visibleEventIds.map((id, index) => [id, index]));
  let lastIndex = -1;
  let totalChars = 0;
  const sections: DigestExplanation['sections'] = [];
  for (const candidate of value['sections']) {
    if (!isRecord(candidate) || !exactKeys(candidate, ['eventIds', 'explanation'])) return null;
    const ids = candidate['eventIds'];
    const explanation = candidate['explanation'];
    if (!Array.isArray(ids) || ids.length < 1 || !ids.every((id) => typeof id === 'string'))
      return null;
    if (typeof explanation !== 'string' || !safeExplanation(explanation)) return null;
    for (const id of ids) {
      const index = order.get(id as string);
      if (index === undefined || index <= lastIndex) return null;
      lastIndex = index;
    }
    totalChars += explanation.length;
    if (totalChars > MAX_DIGEST_EXPLANATION_TOTAL_CHARS) return null;
    sections.push({ eventIds: [...ids] as string[], explanation });
  }
  return { sections };
}
