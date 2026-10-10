// Closed Conversation projection shared by local persistence and transfer qualification.
import type {
  ContextSource,
  ConversationMessage,
  ConversationSession,
  ProviderToolCall,
} from '../../shared/types/conversation';
import type { AgentRunSummary, ToolStep } from '../../shared/types/agent';
export const LIMITS = Object.freeze({
  messageBytes: 4 * 1024 ** 2,
  sessionBytes: 64 * 1024 ** 2,
  sessions: 50,
  messages: 200,
  indexBytes: 64 * 1024,
  inputDepth: 16,
  projectedDepth: 6,
  nodes: 262_144,
  manifestBytes: 4096,
  resultBytes: 4096,
  sourcesBytes: 512 * 1024 ** 2,
  researchBytes: 64 * 1024 ** 2,
  watchBytes: 512 * 1024 ** 2,
  conversationsBytes: 3201 * 1024 ** 2,
  containerBytes: 5 * 1024 ** 3,
});

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
type Schema =
  | { kind: 'string'; nonempty?: true; uuid?: true }
  | { kind: 'number' | 'boolean' }
  | { kind: 'enum'; values: readonly (string | number | null)[] }
  | { kind: 'nullable'; value: Schema }
  | { kind: 'array'; item: Schema }
  | { kind: 'object'; fields: Record<string, Field> };
type Field = { schema: Schema; optional?: true };
export type ProjectionErrorCode = 'shape' | 'id' | 'count' | 'link' | 'depth' | 'nodes' | 'bytes';
export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;
  constructor(code: ProjectionErrorCode) {
    super(`会话投影拒绝：${code}；整成员保留，零截断`);
    this.code = code;
  }
}
export function requireFact(value: unknown, code: ProjectionErrorCode): asserts value {
  if (!value) throw new ProjectionError(code);
}
export function checkBytes(actual: number, limit: number): void {
  requireFact(Number.isSafeInteger(actual) && actual >= 0 && actual <= limit, 'bytes');
}
export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const string: Schema = { kind: 'string' };
const nonempty: Schema = { kind: 'string', nonempty: true };
const number: Schema = { kind: 'number' };
const boolean: Schema = { kind: 'boolean' };
const oneOf = (...values: (string | number | null)[]): Schema => ({ kind: 'enum', values });
const nullable = (value: Schema): Schema => ({ kind: 'nullable', value });
const array = (item: Schema): Schema => ({ kind: 'array', item });
const field = (schema: Schema): Field => ({ schema });
const optional = (schema: Schema): Field => ({ schema, optional: true });
const object = (fields: Record<string, Field>): Schema => ({ kind: 'object', fields });

const context = object({
  mode: field(oneOf('selection', 'snapshot', 'none')),
  tabId: field(nullable(string)),
  url: field(nullable(string)),
  title: field(nullable(string)),
  capturedAt: field(nullable(number)),
  degraded: field(boolean),
  thin: field(boolean),
  selectionExcerpt: field(nullable(string)),
  warnings: field(array(string)),
} satisfies Record<keyof ContextSource, Field>);
const toolErrors = oneOf(
  'invalid-args',
  'tool-not-found',
  'element-not-found',
  'stale-element',
  'not-interactable',
  'forbidden',
  'denied-by-user',
  'execution-failed',
  'search-failed',
  'source-invalid-change',
  'source-version-conflict',
  'source-duplicate',
  'source-not-found',
  'source-forbidden',
  'source-limit',
  'source-unavailable',
  'source-conflict',
);
const toolStep = object({
  id: field(nonempty),
  toolCallId: field(nonempty),
  name: field(nonempty),
  ok: field(boolean),
  contentPreview: field(string),
  errorCode: optional(toolErrors),
  decision: field(oneOf('auto', 'auto-visible', 'confirmed', 'denied', 'forbidden', 'invalid')),
  createdAt: field(number),
} satisfies Record<keyof ToolStep, Field>);
const toolCall = object({
  id: field(nonempty),
  name: field(nonempty),
  arguments: field(string),
} satisfies Record<keyof ProviderToolCall, Field>);
const agentRun = object({
  requestId: field(string),
  sessionId: field(string),
  status: field(
    oneOf(
      'running',
      'waiting-confirm',
      'done',
      'cancelled',
      'step-limit',
      'timeout',
      'loop-detected',
      'no-progress',
      'error',
    ),
  ),
  stepsUsed: field(number),
  maxSteps: field(number),
  finalText: field(string),
  toolStepCount: field(number),
} satisfies Record<keyof AgentRunSummary, Field>);
const message = object({
  id: field(string),
  role: field(oneOf('user', 'assistant', 'tool')),
  content: field(string),
  createdAt: field(number),
  status: field(oneOf('complete', 'aborted', 'error')),
  errorCode: optional(
    oneOf(
      'not-configured',
      'invalid-key',
      'rate-limit',
      'timeout',
      'network',
      'context-too-long',
      'provider-error',
      'aborted',
      'busy',
      'not-found',
      'internal',
    ),
  ),
  contextSource: optional(context),
  toolCallId: optional(string),
  toolStep: optional(toolStep),
  toolCalls: optional(array(toolCall)),
  agentRun: optional(agentRun),
} satisfies Record<keyof ConversationMessage, Field>);
const session = object({
  id: field({ kind: 'string', uuid: true }),
  title: field(string),
  createdAt: field(number),
  updatedAt: field(number),
  ephemeral: field(boolean),
} satisfies Record<keyof ConversationSession, Field>);

export function projectMessage(raw: unknown): ConversationMessage {
  inspectShape(raw);
  const projected = project(raw, message, { excludedFields: 0 }) as JsonObject;
  if (projected.role === 'tool') {
    requireFact(
      typeof projected.toolCallId === 'string' &&
        projected.toolCallId !== '' &&
        projected.toolStep !== undefined,
      'shape',
    );
  }
  checkBytes(Buffer.byteLength(JSON.stringify(projected)), LIMITS.messageBytes);
  return projected as unknown as ConversationMessage;
}

export function projectSessionMetadata(raw: unknown): ConversationSession {
  inspectShape(raw);
  return project(raw, session, { excludedFields: 0 }) as unknown as ConversationSession;
}

function record(raw: unknown): Record<string, unknown> {
  requireFact(typeof raw === 'object' && raw !== null && !Array.isArray(raw), 'shape');
  const prototype: unknown = Object.getPrototypeOf(raw);
  requireFact(prototype === Object.prototype || prototype === null, 'shape');
  return raw as Record<string, unknown>;
}

function project(raw: unknown, schema: Schema, stats: { excludedFields: number }): Json {
  switch (schema.kind) {
    case 'string':
      requireFact(typeof raw === 'string' && (!schema.nonempty || raw !== ''), 'shape');
      if (schema.uuid) requireFact(UUID.test(raw), 'id');
      return raw;
    case 'number':
      requireFact(typeof raw === 'number' && Number.isFinite(raw), 'shape');
      return raw;
    case 'boolean':
      requireFact(typeof raw === 'boolean', 'shape');
      return raw;
    case 'enum':
      requireFact(
        (typeof raw === 'string' || typeof raw === 'number' || raw === null) &&
          schema.values.includes(raw),
        'shape',
      );
      return raw;
    case 'nullable':
      return raw === null ? null : project(raw, schema.value, stats);
    case 'array':
      requireFact(Array.isArray(raw), 'shape');
      return raw.map((item: unknown) => project(item, schema.item, stats));
    case 'object': {
      const input = record(raw);
      const output: JsonObject = {};
      for (const key of Object.keys(input))
        if (!Object.hasOwn(schema.fields, key)) stats.excludedFields++;
      for (const [key, entry] of Object.entries(schema.fields)) {
        // Optional undefined fields disappear in the existing JSON writer.
        if (entry.optional && input[key] === undefined) continue;
        if (!Object.hasOwn(input, key)) {
          requireFact(entry.optional, 'shape');
          continue;
        }
        output[key] = project(input[key], entry.schema, stats);
      }
      return output;
    }
  }
}

export function inspectShape(root: unknown): { depth: number; nodes: number } {
  const stack = [{ value: root, depth: 1 }];
  let nodes = 0;
  let depth = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    requireFact(++nodes <= LIMITS.nodes, 'nodes');
    requireFact(item.depth <= LIMITS.inputDepth, 'depth');
    depth = Math.max(depth, item.depth);
    if (item.value !== null && typeof item.value === 'object') {
      for (const value of Object.values(item.value)) stack.push({ value, depth: item.depth + 1 });
    }
  }
  return { depth, nodes };
}

export interface Projection {
  value: JsonObject;
  compactBytes: number;
  maximumMessageBytes: number;
  excludedFields: number;
  inputShape: { depth: number; nodes: number };
  outputShape: { depth: number; nodes: number };
}

export function projectSession(raw: unknown, sample: () => void = () => {}): Projection {
  const input = record(raw);
  requireFact(
    (input.version === 1 || input.version === 2) && Array.isArray(input.messages),
    'shape',
  );
  requireFact(input.messages.length <= LIMITS.messages, 'count');
  const inputShape = inspectShape(raw);
  const stats = {
    excludedFields: Object.keys(input).filter((key) => key !== 'version' && key !== 'messages')
      .length,
  };
  const messages: JsonObject[] = [];
  const usedCalls = new Set<string>();
  let currentRound: JsonObject | undefined;
  let bytes = Buffer.byteLength('{"version":2,"messages":[]}');
  let maximumMessageBytes = 0;
  for (const item of input.messages) {
    const projected = project(item, message, stats) as JsonObject;
    if (projected.role === 'tool') {
      requireFact(
        typeof projected.toolCallId === 'string' &&
          projected.toolCallId !== '' &&
          projected.toolStep !== undefined,
        'shape',
      );
      requireFact(
        Array.isArray(currentRound?.toolCalls) &&
          currentRound.toolCalls.some((call) => record(call).id === projected.toolCallId) &&
          !usedCalls.has(projected.toolCallId),
        'link',
      );
      usedCalls.add(projected.toolCallId);
    } else {
      // Each assistant round owns its contiguous tool results, including partial batches.
      currentRound = projected.role === 'assistant' ? projected : undefined;
    }
    const messageBytes = Buffer.byteLength(JSON.stringify(projected));
    checkBytes(messageBytes, LIMITS.messageBytes);
    maximumMessageBytes = Math.max(maximumMessageBytes, messageBytes);
    bytes += messageBytes + (messages.length > 0 ? 1 : 0);
    checkBytes(bytes, LIMITS.sessionBytes);
    messages.push(projected);
    sample();
  }
  const value: JsonObject = { version: 2, messages };
  const outputShape = inspectShape(value);
  requireFact(outputShape.depth <= LIMITS.projectedDepth, 'depth');
  return {
    value,
    compactBytes: bytes,
    maximumMessageBytes,
    excludedFields: stats.excludedFields,
    inputShape,
    outputShape,
  };
}

export function projectIndex(raw: unknown): Projection {
  const input = record(raw);
  requireFact(input.version === 1 && Array.isArray(input.sessions), 'shape');
  requireFact(input.sessions.length <= LIMITS.sessions, 'count');
  const inputShape = inspectShape(raw);
  const stats = {
    excludedFields: Object.keys(input).filter((key) => key !== 'version' && key !== 'sessions')
      .length,
  };
  const sessions: JsonObject[] = [];
  const ids = new Set<string>();
  for (const item of input.sessions) {
    const entry = project(item, session, stats) as JsonObject;
    requireFact(entry.ephemeral === false, 'shape');
    requireFact(typeof entry.id === 'string' && !ids.has(entry.id.toLowerCase()), 'id');
    ids.add(entry.id.toLowerCase());
    sessions.push(entry);
  }
  const value: JsonObject = { version: 1, sessions };
  const compactBytes = Buffer.byteLength(JSON.stringify(value));
  checkBytes(compactBytes, LIMITS.indexBytes);
  return {
    value,
    compactBytes,
    maximumMessageBytes: 0,
    excludedFields: stats.excludedFields,
    inputShape,
    outputShape: inspectShape(value),
  };
}

export function* sessionChunks(value: JsonObject): Generator<Buffer> {
  requireFact(Array.isArray(value.messages), 'shape');
  yield Buffer.from('{"version":2,"messages":[');
  for (let i = 0; i < value.messages.length; i++) {
    if (i > 0) yield Buffer.from(',');
    yield Buffer.from(JSON.stringify(value.messages[i]));
  }
  yield Buffer.from(']}');
}
