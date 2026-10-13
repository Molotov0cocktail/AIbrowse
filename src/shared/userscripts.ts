import type { UserScriptIdentifier, UserScriptToggle } from './types/userscripts';

export const USER_SCRIPT_LIMITS = Object.freeze({
  count: 50,
  sourceBytes: 256 * 1024,
  totalSourceBytes: 8 * 1024 * 1024,
  patterns: 64,
  patternLength: 2048,
  metadataLines: 256,
  worldFirst: 2000,
  worldLast: 2049,
});

export function isUserScriptId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
  );
}

function closed(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype: unknown = Object.getPrototypeOf(value);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
      })
    );
  } catch {
    return false;
  }
}

export function isUserScriptToggle(value: unknown): value is UserScriptToggle {
  return (
    closed(value, ['id', 'enabled']) &&
    isUserScriptId(value.id) &&
    typeof value.enabled === 'boolean'
  );
}

export function isUserScriptIdentifier(value: unknown): value is UserScriptIdentifier {
  return closed(value, ['id']) && isUserScriptId(value.id);
}
