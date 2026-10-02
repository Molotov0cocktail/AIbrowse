import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  BOUND_SNAPSHOT_SCRIPT_SOURCE,
  buildBoundInteractionSource,
} from './document-binding-script';

describe('文档绑定固定模板完整源码', () => {
  it('真实完整快照 IIFE 含结束分号时仍能嵌入并编译', () => {
    expect(() => new Script(BOUND_SNAPSHOT_SCRIPT_SOURCE)).not.toThrow();
  });

  it('click/fill/scroll 完整模板及敌手 JSON 参数均不能破坏编译边界', () => {
    const sources = [
      buildBoundInteractionSource(
        { action: 'click', elementId: 'el-1', allowedKind: 'nav' },
        'token',
      ),
      buildBoundInteractionSource(
        { action: 'fill', elementId: 'el-1', text: '"}); throw new Error("注入"); //' },
        'token',
      ),
      buildBoundInteractionSource({ action: 'scroll', dy: 25 }, 'token'),
    ];
    for (const source of sources) expect(() => new Script(source)).not.toThrow();
  });
});
