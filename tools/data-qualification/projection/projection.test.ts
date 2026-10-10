import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseMessagesFile, parseIndexFile } from '../../../src/main/ai/conversation-store';
import { fixtureId } from '../fixtures';
import {
  LIMITS,
  checkBytes,
  inspectShape,
  projectIndex,
  projectSession,
  sessionChunks,
} from './projection';
import { fullFields, fiftyIndex } from './samples';
import { FixedFrameWriter, capacityArithmetic, conversationPlan, maximumMetadata } from './layout';

describe('闭合 Conversation 投影资格（小型纯样本）', () => {
  it('保留全部允许嵌套字段和转义文本，真实旧读器接受', () => {
    const raw = fullFields();
    expect(parseMessagesFile(JSON.stringify(raw))?.dropped).toBe(0);
    const result = projectSession(raw);
    expect(result.value).toEqual(raw);
    expect(Buffer.concat([...sessionChunks(result.value)]).toString()).toBe(JSON.stringify(raw));
    expect(result.outputShape.depth).toBe(6);
    expect(result.compactBytes).toBe(Buffer.byteLength(JSON.stringify(raw)));
    expect(projectSession({ ...raw, version: 1 }).value).toEqual(raw);
  });

  it('所有层未知字段不带出，非法已知扩展整会话拒绝', () => {
    const original = fullFields();
    const raw = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    const inject = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        value.forEach(inject);
        return;
      }
      const object = value as Record<string, unknown>;
      Object.values(object).forEach(inject);
      object.internalReasoning = '禁止投影的合成标记';
    };
    inject(raw);
    expect(parseMessagesFile(JSON.stringify(raw))?.messages[0]).not.toHaveProperty(
      'internalReasoning',
    );
    const result = projectSession(raw);
    expect(result.value).toEqual(original);
    expect(result.excludedFields).toBeGreaterThan(6);
    const invalid = {
      version: 2,
      messages: [
        {
          id: 'm',
          role: 'assistant',
          content: '保留正文',
          status: 'complete',
          createdAt: 0,
          agentRun: { status: 'wrong' },
        },
      ],
    };
    expect(parseMessagesFile(JSON.stringify(invalid))).toBeNull();
    expect(() => projectSession(invalid)).toThrow('shape');
  });

  it('索引50条全部保留，UUID、重复、ephemeral、超额条目不得丢弃后通过', () => {
    const input = fiftyIndex();
    expect(parseIndexFile(JSON.stringify(input))?.dropped).toBe(0);
    expect(projectIndex(input).value).toEqual(input);
    const upper = { ...input.sessions[0]!, id: 'ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF' };
    expect(projectIndex({ version: 1, sessions: [upper] }).value.sessions).toEqual([upper]);
    expect(() =>
      projectIndex({ version: 1, sessions: [upper, { ...upper, id: upper.id.toLowerCase() }] }),
    ).toThrow('id');
    for (const id of ['../真实目录', 'index', 'A'.repeat(36)]) {
      expect(() => projectIndex({ version: 1, sessions: [{ ...input.sessions[0], id }] })).toThrow(
        'id',
      );
    }
    expect(() =>
      projectIndex({ version: 1, sessions: [input.sessions[0], input.sessions[0]] }),
    ).toThrow('id');
    expect(() =>
      projectIndex({ version: 1, sessions: [{ ...input.sessions[0], ephemeral: true }] }),
    ).toThrow('shape');
    expect(() =>
      projectIndex({ ...input, sessions: [...input.sessions, input.sessions[0]] }),
    ).toThrow('count');
  });

  it('产品读器和投影均整会话拒绝孤立tool', () => {
    const raw = { version: 2, messages: [fullFields().messages[2]] };
    expect(parseMessagesFile(JSON.stringify(raw))).toBeNull();
    expect(() => projectSession(raw)).toThrow('link');
  });

  it('按实际JSON值节点与深度计费，字节边界无截断', () => {
    expect(inspectShape({ a: [{ b: '界' }] })).toEqual({ depth: 4, nodes: 4 });
    let deep: unknown = 0;
    for (let i = 0; i < 16; i++) deep = { child: deep };
    expect(() => inspectShape(deep)).toThrow('depth');
    expect(() => checkBytes(LIMITS.messageBytes, LIMITS.messageBytes)).not.toThrow();
    expect(() => checkBytes(LIMITS.messageBytes + 1, LIMITS.messageBytes)).toThrow('bytes');
  });

  it('四成员最大元数据和Conversation最大框架算术闭合', () => {
    const envelope = maximumMetadata();
    expect(envelope.manifest.members).toHaveLength(4);
    expect(Buffer.byteLength(JSON.stringify(envelope.manifest))).toBeLessThanOrEqual(4096);
    expect(Buffer.byteLength(JSON.stringify(envelope.result))).toBeGreaterThan(256);
    expect(capacityArithmetic().containerHeadroom).toBeGreaterThan(800 * 1024 ** 2);
    const hash = 'a'.repeat(64);
    const ids = fiftyIndex().sessions.map((entry) => entry.id);
    const members = [
      { id: 'index', length: LIMITS.indexBytes, sha256: hash },
      ...ids.map((id) => ({ id, length: LIMITS.sessionBytes, sha256: hash })),
    ];
    expect(conversationPlan(ids, members).length).toBe(capacityArithmetic().conversationMaximum);
    expect(() => conversationPlan(ids, [...members, members[0]!])).toThrow('count');
    expect(() =>
      conversationPlan(
        [fixtureId(1)],
        [
          { id: 'index', length: 0, sha256: hash },
          { id: fixtureId(0), length: 0, sha256: hash },
        ],
      ),
    ).toThrow('id');
  });

  it('固定帧写入器拒绝重入、长度不符、尾随和缺失成员', () => {
    const body = Buffer.from('合成');
    const member = {
      id: 'index',
      length: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    };
    const writer = new FixedFrameWriter([member], () => {});
    expect(() => writer.chunk(body)).toThrow('count');
    writer.begin(member);
    expect(() => writer.begin(member)).toThrow('id');
    expect(() => writer.chunk(Buffer.alloc(body.length + 1))).toThrow('bytes');
    expect(() => writer.finish()).toThrow('count');
    writer.chunk(body);
    writer.end();
    writer.finish();
    expect(() => writer.chunk(body)).toThrow('count');
  });
});
