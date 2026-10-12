import { describe, expect, it } from 'vitest';
import { extractGoalUrls } from './goal-urls';

describe('目标网址确定性提取', () => {
  it('多个网址、中文句读、括号与末尾英文句读', () => {
    expect(
      extractGoalUrls('比较https://a.test/x，与（https://b.test/a_(b)）。以及 https://c.test/a?!'),
    ).toEqual(['https://a.test/x', 'https://b.test/a_(b)', 'https://c.test/a']);
  });
  it('尖括号明确保留尾标点与 Unicode 路径', () => {
    expect(extractGoalUrls('读取 <https://例子.测试/路径?q=值!>')).toEqual([
      'https://xn--fsqu00a.xn--0zwm56d/%E8%B7%AF%E5%BE%84?q=%E5%80%BC!',
    ]);
  });
  it('fragment 去重、默认端口规范化，query 值与顺序不合并', () => {
    expect(
      extractGoalUrls('HTTPS://A.test:443/x?q=1#one https://a.test/x?q=1#two https://a.test/x?q=2'),
    ).toEqual(['https://a.test/x?q=1#one', 'https://a.test/x?q=2']);
  });
  it('沿用浏览器现有私网、loopback、IPv6、非默认端口能力', () => {
    expect(
      extractGoalUrls('http://127.0.0.1:8080/x http://192.168.1.2/ http://[::1]:3000/'),
    ).toHaveLength(3);
  });
  it.each([
    'file:///secret',
    'javascript:https://bad.test/',
    'data:text/plain,https://bad.test/',
    'https%3A%2F%2Fbad.test',
    'https://user:secret@bad.test/',
    'https://bad\u200b.test/',
    'ftp://bad.test/',
    'bad.test/path',
    'https://',
    'javascript:fetch("https://bad.test/")',
  ])('非法、嵌套、隐藏或带凭据地址不采纳：%s', (text) => {
    expect(extractGoalUrls(text)).toEqual([]);
  });
  it('24 项上限且超长目标不截断成另一个合法网址', () => {
    expect(
      extractGoalUrls(Array.from({ length: 30 }, (_, i) => `https://a.test/${i}`).join(' ')),
    ).toHaveLength(24);
    expect(extractGoalUrls('https://a.test/' + 'a'.repeat(2000))).toEqual([]);
  });
});
