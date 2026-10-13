import { describe, expect, it } from 'vitest';
import { isUserScriptIdentifier, isUserScriptToggle } from '../../shared/userscripts';
import { matchesUserScript, matchesUserScriptPattern, parseUserScript } from './metadata';

export function fixtureSource(directives = '', body = 'document.title = "已执行";'): string {
  return `// ==UserScript==\n// @name 测试脚本\n// @namespace 测试\n// @match https://*.example.com/*\n${directives}\n// ==/UserScript==\n${body}`;
}

describe('用户脚本元数据与匹配边界', () => {
  it('解析受限脚本且只编译不在主进程执行代码', () => {
    const result = parseUserScript(
      fixtureSource(
        '// @grant GM_addStyle\n// @run-at document-idle',
        'throw new Error("不会在主进程执行");',
      ),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { name: '测试脚本', runAt: 'document-idle', grants: ['GM_addStyle'] },
    });
  });
  it.each([
    'require https://example.com/x.js',
    'resource x https://example.com/x',
    'grant GM_xmlhttpRequest',
    'grant unsafeWindow',
    'grant GM_setValue',
    'sandbox raw',
    'unwrap',
    'downloadURL https://example.com/x',
    'updateURL https://example.com/x',
    'run-at document-start',
    'run-at document-end',
    'run-at context-menu',
    'run-in normal-tabs',
  ])('拒绝未提供的能力与执行语义：%s', (directive) => {
    expect(parseUserScript(fixtureSource(`// @${directive}`))).toMatchObject({
      ok: false,
      code: 'unsupported',
    });
  });
  it.each([
    '// @grant none\n// @grant GM_addStyle',
    '// @name 重复',
    '// @run-at document-idle\n// @run-at document-idle',
  ])('拒绝冲突和重复单值：%s', (directives) => {
    expect(parseUserScript(fixtureSource(directives))).toMatchObject({
      ok: false,
      code: 'invalid-input',
    });
  });
  it.each([
    '',
    'document.title="x";',
    '// ==UserScript==\n// @name x',
    null,
    '{}',
    fixtureSource('', '});process.exit();(() => {'),
    fixtureSource('', 'return 1;'),
  ])('拒绝无效头部或可逃逸的源码（%#）', (source) => {
    expect(parseUserScript(source).ok).toBe(false);
  });
  it('限制源码字节和匹配规则数量', () => {
    expect(parseUserScript(fixtureSource('', `/*${'汉'.repeat(90000)}*/`))).toMatchObject({
      ok: false,
      code: 'limit-exceeded',
    });
    expect(
      parseUserScript(
        fixtureSource(
          Array.from({ length: 65 }, (_, i) => `// @match https://example.com/${i}`).join('\n'),
        ),
      ),
    ).toMatchObject({ ok: false, code: 'limit-exceeded' });
  });
  it.each(['const GM = {};', 'let GM_info = {};', 'const GM_addStyle = () => {};'])(
    '实际内层包装允许脚本局部声明覆盖GM名称：%s',
    (body) => {
      expect(parseUserScript(fixtureSource('', body)).ok).toBe(true);
    },
  );
  it.each([
    ['*://*.example.com/*', 'https://example.com/x?q=1#z', true],
    ['*://*.example.com/*', 'http://a.example.com/x', true],
    ['https://*.example.com/*', 'https://example.com.evil.test/x', false],
    ['https://example.com/*', 'https://evil.test/?https://example.com/x', false],
    ['https://example.com/*', 'https://example.com@evil.test/x', false],
    ['https://example.com/*', 'https://user@example.com/x', false],
    ['http://127.0.0.1/*', 'http://127.0.0.1:49152/x', true],
    ['https://example.com/a*b?x=*', 'https://example.com/acb?x=1#fragment', true],
    ['https://example.com/a*b', 'https://example.com/a', false],
    ['https://example.com/a*b*c', 'https://example.com/acb', false],
    ['https://*/*', 'file:///secret', false],
    ['https://*/*', 'about:blank', false],
    ['https://*/*', 'chrome-extension://id/page', false],
    ['http://example.com:80/*', 'http://example.com/x', false],
    ['https://example.com?attack/*', 'https://example.com/x', false],
  ])('%s 对 %s 的匹配为 %s', (pattern, url, expected) => {
    expect(matchesUserScriptPattern(pattern, url)).toBe(expected);
  });
  it('排除规则优先、include仅支持相同HTTP匹配子集', () => {
    const parsed = parseUserScript(
      fixtureSource(
        '// @exclude https://*.example.com/private/*\n// @include http://other.test/*\n// @exclude-match http://other.test/private*',
      ),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(matchesUserScript(parsed.value, 'https://example.com/private/a')).toBe(false);
    expect(matchesUserScript(parsed.value, 'http://other.test/public')).toBe(true);
    expect(matchesUserScript(parsed.value, 'http://other.test/private?q=1')).toBe(false);
    expect(parseUserScript(fixtureSource('// @include /^https:.*/')).ok).toBe(false);
  });
});

describe('用户脚本IPC闭合参数', () => {
  const id = '85bce7be-d554-4a3c-bc19-994c39f8e9bf';
  it('仅允许UUID v4与实际布尔值', () => {
    expect(isUserScriptToggle({ id, enabled: true })).toBe(true);
    expect(isUserScriptIdentifier({ id })).toBe(true);
    expect(isUserScriptToggle({ id, enabled: 'true' })).toBe(false);
    expect(isUserScriptIdentifier({ id: '../../script.user.js' })).toBe(false);
  });
  it('拒绝原型字段、符号字段、访问器且不调用getter', () => {
    expect(isUserScriptIdentifier(Object.create({ id }))).toBe(false);
    expect(isUserScriptIdentifier({ id, [Symbol('extra')]: true })).toBe(false);
    expect(isUserScriptToggle({ id, enabled: true, source: 'extra' })).toBe(false);
    let read = false;
    expect(
      isUserScriptIdentifier({
        get id() {
          read = true;
          return id;
        },
      }),
    ).toBe(false);
    expect(read).toBe(false);
  });
});
