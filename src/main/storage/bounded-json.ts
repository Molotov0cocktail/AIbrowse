export interface JsonReadLimits {
  readonly bytes: number;
  readonly depth: number;
  readonly nodes: number;
}

export class JsonReadError extends Error {
  constructor(readonly code: 'invalid-json' | 'budget-exceeded') {
    super(
      code === 'invalid-json'
        ? '本地数据JSON无效，原件保持不变'
        : '本地数据JSON超出资源界限，原件保持不变',
    );
  }
}
const invalid = (): never => {
  throw new JsonReadError('invalid-json');
};
const exceeded = (): never => {
  throw new JsonReadError('budget-exceeded');
};
type KeyRange = { start: number; end: number };

// A byte per open container avoids recursive JS calls and per-node objects in
// opaque mode. Chunks grow only with actual nesting, never with the limit.
function preflight(text: string, limits: JsonReadLimits, collectKeys: boolean): KeyRange[][] {
  for (const bound of [limits.bytes, limits.depth, limits.nodes]) {
    if (!Number.isSafeInteger(bound) || bound < 1) exceeded();
  }
  if (Buffer.byteLength(text, 'utf8') > limits.bytes) exceeded();
  let cursor = 0;
  let nodes = 0;
  let depth = 0;
  const chunks: Uint8Array[] = [];
  const objectKeys: KeyRange[][] = [];
  const openKeys: Array<KeyRange[] | undefined> = [];
  const state = (): number => chunks[(depth - 1) >>> 12]![(depth - 1) & 4095]!;
  const setState = (value: number): void => {
    chunks[(depth - 1) >>> 12]![(depth - 1) & 4095] = value;
  };
  const push = (value: number): void => {
    const chunk = depth >>> 12;
    chunks[chunk] ??= new Uint8Array(4096);
    chunks[chunk]![depth & 4095] = value;
    depth++;
  };
  const pop = (): void => {
    if (collectKeys) openKeys.length = depth - 1;
    depth--;
  };
  const digit = (code: number): boolean => code >= 48 && code <= 57;
  const whitespace = (): void => {
    while ([32, 9, 10, 13].includes(text.charCodeAt(cursor))) cursor++;
  };
  const string = (): void => {
    if (text[cursor++] !== '"') invalid();
    while (cursor < text.length) {
      const code = text.charCodeAt(cursor++);
      if (code === 34) return;
      if (code < 32) invalid();
      if (code !== 92) continue;
      const escape = text[cursor++];
      if (escape === 'u') {
        for (let i = 0; i < 4; i++) {
          const hex = text.charCodeAt(cursor++);
          if (!digit(hex) && !(hex >= 65 && hex <= 70) && !(hex >= 97 && hex <= 102)) invalid();
        }
      } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) invalid();
    }
    invalid();
  };
  const number = (): void => {
    if (text[cursor] === '-') cursor++;
    if (text[cursor] === '0') cursor++;
    else {
      const first = text.charCodeAt(cursor);
      if (first < 49 || first > 57 || !Number.isFinite(first)) invalid();
      while (digit(text.charCodeAt(cursor))) cursor++;
    }
    if (text[cursor] === '.') {
      cursor++;
      if (!digit(text.charCodeAt(cursor))) invalid();
      while (digit(text.charCodeAt(cursor))) cursor++;
    }
    if (text[cursor] === 'e' || text[cursor] === 'E') {
      cursor++;
      if (text[cursor] === '+' || text[cursor] === '-') cursor++;
      if (!digit(text.charCodeAt(cursor))) invalid();
      while (digit(text.charCodeAt(cursor))) cursor++;
    }
  };
  const value = (): void => {
    if (depth + 1 > limits.depth || ++nodes > limits.nodes) exceeded();
    whitespace();
    const start = text[cursor];
    if (start === '{' || start === '[') {
      push(start === '{' ? 1 : 6);
      if (collectKeys && start === '{') {
        const keys: KeyRange[] = [];
        objectKeys.push(keys);
        openKeys[depth - 1] = keys;
      }
      cursor++;
    } else if (start === '"') string();
    else if (text.startsWith('true', cursor)) cursor += 4;
    else if (text.startsWith('false', cursor)) cursor += 5;
    else if (text.startsWith('null', cursor)) cursor += 4;
    else number();
  };
  value();
  while (depth > 0) {
    whitespace();
    switch (state()) {
      case 1: // Object: first key or empty end.
        if (text[cursor] === '}') {
          cursor++;
          pop();
          break;
        }
        setState(2);
        break;
      case 2: {
        // Object: required key.
        const start = cursor;
        string();
        if (collectKeys) openKeys[depth - 1]!.push({ start, end: cursor });
        setState(3);
        break;
      }
      case 3:
        if (text[cursor++] !== ':') invalid();
        setState(4);
        break;
      case 4:
        setState(5);
        value();
        break;
      case 5:
        if (text[cursor] === '}') {
          cursor++;
          pop();
          break;
        }
        if (text[cursor++] !== ',') invalid();
        setState(2);
        break;
      case 6: // Array: first value or empty end.
        if (text[cursor] === ']') {
          cursor++;
          pop();
          break;
        }
        setState(7);
        break;
      case 7:
        setState(8);
        value();
        break;
      case 8:
        if (text[cursor] === ']') {
          cursor++;
          pop();
          break;
        }
        if (text[cursor++] !== ',') invalid();
        setState(7);
        break;
      default:
        invalid();
    }
  }
  whitespace();
  if (cursor !== text.length) invalid();
  return objectKeys;
}

/** Check opaque legacy JSON without native parsing, key decoding or object expansion. */
export function validateBoundedJsonSyntax(text: string, limits: JsonReadLimits): void {
  try {
    preflight(text, limits, false);
  } catch (error) {
    if (error instanceof JsonReadError) throw error;
    invalid();
  }
}

/** Reject ambiguous keys and resource violations before building typed input objects. */
export function parseBoundedJson(text: string, limits: JsonReadLimits): unknown {
  try {
    const objectKeys = preflight(text, limits, true);
    for (const keys of objectKeys) {
      const seen = new Set<string>();
      for (const key of keys) {
        const decoded: unknown = JSON.parse(text.slice(key.start, key.end));
        if (typeof decoded !== 'string' || seen.has(decoded)) return invalid();
        seen.add(decoded);
      }
    }
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof JsonReadError) throw error;
    return invalid();
  }
}
