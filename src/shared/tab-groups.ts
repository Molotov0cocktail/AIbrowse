import type {
  CreateTabGroupPayload,
  SetTabGroupPayload,
  TabGroupColor,
  UpdateTabGroupPayload,
} from './types/browser';

export const TAB_GROUP_LIMIT = 32;
export const TAB_GROUP_COLORS: readonly TabGroupColor[] = Object.freeze([
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'purple',
]);

export function isTabGroupId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value);
}

function closed(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isTabGroupName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 80 &&
    value.trim().length >= 1 &&
    value.trim().length <= 40 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || (code >= 127 && code <= 159);
    })
  );
}

function isColor(value: unknown): value is TabGroupColor {
  return typeof value === 'string' && TAB_GROUP_COLORS.some((color) => color === value);
}

export function isCreateTabGroupPayload(value: unknown): value is CreateTabGroupPayload {
  return (
    closed(value, ['tabId', 'name', 'color']) &&
    isTabGroupId(value.tabId) &&
    isTabGroupName(value.name) &&
    isColor(value.color)
  );
}

export function isUpdateTabGroupPayload(value: unknown): value is UpdateTabGroupPayload {
  return (
    closed(value, ['groupId', 'name', 'color', 'collapsed']) &&
    isTabGroupId(value.groupId) &&
    isTabGroupName(value.name) &&
    isColor(value.color) &&
    typeof value.collapsed === 'boolean'
  );
}

export function isSetTabGroupPayload(value: unknown): value is SetTabGroupPayload {
  return (
    closed(value, ['tabId', 'groupId']) &&
    isTabGroupId(value.tabId) &&
    (value.groupId === null || isTabGroupId(value.groupId))
  );
}
