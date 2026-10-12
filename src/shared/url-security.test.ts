import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ALLOWED_SCHEME_PATTERN } from './url';
it('远程导航只允许HTTP(S)与精确空白页', () => {
  expect(ALLOWED_SCHEME_PATTERN.test('about:blank')).toBe(true);
  for (const url of [
    'about:srcdoc',
    'about:crash',
    'about:blank?evil',
    'about:blank/evil',
    'file:///secret',
  ])
    expect(ALLOWED_SCHEME_PATTERN.test(url)).toBe(false);
});

it('地址栏 no-op 日志省略原始输入，凭据不进入日志', () => {
  const mainSource = readFileSync(
    fileURLToPath(new URL('../main/index.ts', import.meta.url)),
    'utf8',
  );
  expect(mainSource).not.toContain('输入无法解析，创建空白标签页：${input}');
  expect(mainSource).not.toContain('输入无法解析（tabId=${tabId}）：${input}');
  expect(mainSource).toContain('tabs:create 输入无法解析，创建空白标签页（原始输入已省略）');
  expect(mainSource).toContain('nav:navigate 输入无法解析（原始输入与 tabId 已省略）');
});
