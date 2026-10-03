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
