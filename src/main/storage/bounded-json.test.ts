import { describe, expect, it, vi } from 'vitest';
import { parseBoundedJson, validateBoundedJsonSyntax } from './bounded-json';

const limits = { bytes: 1024, depth: 4, nodes: 8 };

describe('JSON语义投影前的资源检查', () => {
  it('对象键不计节点，转义引号和嵌套符号不改变深度；支持标量根', () => {
    const text = JSON.stringify({ key: { items: ['"[]{},:', null] } });
    expect(parseBoundedJson(text, limits)).toEqual(JSON.parse(text));
    expect(parseBoundedJson('false', { ...limits, nodes: 1, depth: 1 })).toBe(false);
    expect(parseBoundedJson('{"x":1}', { ...limits, nodes: 2, depth: 2 })).toEqual({ x: 1 });
  });

  it('在原生JSON.parse之前拒绝字节、深度和节点超限', () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      for (const text of ['"' + '界'.repeat(400) + '"', '[[[[[0]]]]]', '[0,0,0,0,0,0,0,0]']) {
        parse.mockClear();
        expect(() => parseBoundedJson(text, limits)).toThrow();
        expect(parse).not.toHaveBeenCalled();
      }
    } finally {
      parse.mockRestore();
    }
  });

  it('畸形结构、字符串和尾随内容整值拒绝，无正文回显', () => {
    for (const text of ['{"secret":', '[[}', '"secret', '{"a":true false}', '[] null']) {
      expect(() => parseBoundedJson(text, limits)).toThrow('本地数据JSON无效');
      try {
        parseBoundedJson(text, limits);
      } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    }
  });

  it('大而浅的数组在展开对象前以节点限额拒绝，边界值不被缩小', () => {
    expect(parseBoundedJson('[1,2,3,4,5,6,7]', limits)).toHaveLength(7);
    expect(() => parseBoundedJson('[1,2,3,4,5,6,7,8]', limits)).toThrow('资源界限');
    for (const invalid of [0, -1, NaN, Infinity, 1.5]) {
      expect(() => parseBoundedJson('[]', { ...limits, nodes: invalid })).toThrow();
    }
  });

  it('拒绝同对象重复键含转义等价，不让后值掩盖前值；不同对象可用同名键', () => {
    expect(() => parseBoundedJson('{"x":false,"x":true}', limits)).toThrow('JSON无效');
    expect(() => parseBoundedJson('{"x":false,"\\u0078":true}', limits)).toThrow('JSON无效');
    expect(parseBoundedJson('[{"x":false},{"x":true}]', limits)).toEqual([
      { x: false },
      { x: true },
    ]);
  });

  it('历史opaque只检查完整语法，不调用原生解析器或改变重复键字节', () => {
    const parse = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      throw new Error('不得实体化历史opaque');
    });
    try {
      validateBoundedJsonSyntax('{"x":false,"x":true}', limits);
      const text = '['.repeat(20_000) + '0' + ']'.repeat(20_000);
      validateBoundedJsonSyntax(text, {
        bytes: text.length,
        depth: text.length,
        nodes: text.length,
      });
      expect(parse).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it('语法模式仍拒绝预算越界、缺失值、尾逗号、非法数字与转义', () => {
    for (const text of ['[1,]', '{"x":}', '{"x":1,}', '[01]', '[1e]', '[+1]', '"\\x"']) {
      expect(() => validateBoundedJsonSyntax(text, limits)).toThrow('JSON无效');
    }
    for (const text of ['[[[[0]]]]', '[1,2,3,4,5,6,7,8]', '"' + '界'.repeat(400) + '"']) {
      expect(() => validateBoundedJsonSyntax(text, limits)).toThrow('资源界限');
    }
  });
});
