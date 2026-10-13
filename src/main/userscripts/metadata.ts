import { Script } from 'node:vm';
import { USER_SCRIPT_LIMITS } from '../../shared/userscripts';
import type { UserScriptMetadata, UserScriptResult } from '../../shared/types/userscripts';

interface MatchPattern {
  scheme: string;
  host: string;
  path: string;
}

const GRANTS = new Set(['none', 'GM_addStyle', 'GM.addStyle', 'GM_info', 'GM.info']);
const INFORMATIONAL = new Set([
  'author',
  'copyright',
  'license',
  'homepage',
  'homepageURL',
  'website',
  'source',
  'supportURL',
  'icon',
  'iconURL',
  'defaulticon',
  'icon64',
  'icon64URL',
  'antifeature',
  'tag',
]);

function failure(
  code: 'invalid-input' | 'unsupported' | 'limit-exceeded',
  message: string,
): UserScriptResult<never> {
  return { ok: false, code, message };
}

function parsePattern(pattern: string): MatchPattern | null {
  if (pattern.length > USER_SCRIPT_LIMITS.patternLength || /[\s\\#]/u.test(pattern)) return null;
  const match = pattern.match(/^(https?|\*):\/\/([^/]+)(\/.*)$/u);
  if (match === null) return null;
  const [, scheme, host, path] = match;
  if (host === '*') return { scheme, host, path };
  const suffix = host.startsWith('*.') ? host.slice(2) : host;
  if (suffix.includes('*') || suffix.includes('@') || suffix.includes('%') || suffix.includes(':'))
    return null;
  try {
    const parsed = new URL(`https://${suffix}/`);
    if (
      parsed.hostname === '' ||
      parsed.pathname !== '/' ||
      parsed.port !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    )
      return null;
    return { scheme, host: `${host.startsWith('*.') ? '*.' : ''}${parsed.hostname}`, path };
  } catch {
    return null;
  }
}

// Only '*' is special. Ordered literal searches avoid attacker-controlled regular expressions.
function wildcardMatches(pattern: string, value: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return value === pattern;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!value.startsWith(first) || !value.endsWith(last)) return false;
  let offset = first.length;
  const end = value.length - last.length;
  if (offset > end) return false;
  for (const part of parts.slice(1, -1)) {
    const index = value.indexOf(part, offset);
    if (index < 0 || index + part.length > end) return false;
    offset = index + part.length;
  }
  return offset <= end;
}

export function matchesUserScriptPattern(pattern: string, input: string): boolean {
  const rule = parsePattern(pattern);
  if (rule === null || input.length > 8192) return false;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '')
    return false;
  if (rule.scheme !== '*' && `${rule.scheme}:` !== url.protocol) return false;
  if (rule.host !== '*') {
    const suffix = rule.host.startsWith('*.') ? rule.host.slice(2) : rule.host;
    if (
      url.hostname !== suffix &&
      !(rule.host.startsWith('*.') && url.hostname.endsWith(`.${suffix}`))
    )
      return false;
  }
  return wildcardMatches(rule.path, `${url.pathname}${url.search}`);
}

export function matchesUserScript(metadata: UserScriptMetadata, url: string): boolean {
  return (
    [...metadata.matches, ...metadata.includes].some((pattern) =>
      matchesUserScriptPattern(pattern, url),
    ) &&
    ![...metadata.excludes, ...metadata.excludeGlobs].some((pattern) =>
      matchesUserScriptPattern(pattern, url),
    )
  );
}

export function buildUserScriptBody(source: string): string {
  // Keep user lexical declarations and directives in their own function scope.
  // The surrounding closure supplies APIs without reserving source-local names.
  return `function(GM_info, GM, GM_addStyle) { (function() {\n${source}\n}).call(globalThis); }`;
}

export function parseUserScript(source: unknown): UserScriptResult<UserScriptMetadata> {
  if (typeof source !== 'string' || source.trim() === '' || source.includes('\0'))
    return failure('invalid-input', '请选择有效的 UTF-8 用户脚本。');
  if (Buffer.byteLength(source, 'utf8') > USER_SCRIPT_LIMITS.sourceBytes)
    return failure('limit-exceeded', '单个脚本不能超过 256 KiB。');
  const lines = source
    .replace(/^\uFEFF/u, '')
    .trimStart()
    .split(/\r?\n/u);
  if (lines[0].trim() !== '// ==UserScript==')
    return failure('invalid-input', '文件开头缺少用户脚本元数据块。');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '// ==/UserScript==');
  if (end < 0 || end > USER_SCRIPT_LIMITS.metadataLines)
    return failure('invalid-input', '用户脚本元数据块不完整或超过 256 行。');
  const metadata: UserScriptMetadata = {
    name: '',
    namespace: '',
    version: '',
    description: '',
    matches: [],
    excludes: [],
    includes: [],
    excludeGlobs: [],
    grants: [],
    runAt: 'document-idle',
  };
  const seen = new Set<string>();
  for (const line of lines.slice(1, end)) {
    if (line.trim() === '') continue;
    if (!/^\s*\/\//u.test(line)) return failure('invalid-input', '元数据块必须由行注释组成。');
    const item = line.match(/^\s*\/\/\s*@([^\s]+)(?:\s+(.*))?$/u);
    if (item === null) continue;
    const key = item[1];
    const value = (item[2] ?? '').trim();
    if (
      Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return (
          code < 32 ||
          (code >= 127 && code <= 159) ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
        );
      })
    )
      return failure('invalid-input', '元数据含有不支持的控制字符。');
    if (['name', 'namespace', 'version', 'description'].includes(key)) {
      if (seen.has(key)) return failure('invalid-input', '脚本名称、版本和描述不能重复声明。');
      seen.add(key);
      const limit = key === 'description' ? 1000 : 200;
      if (value.length > limit) return failure('limit-exceeded', '脚本名称、版本或描述过长。');
      metadata[key as 'name' | 'namespace' | 'version' | 'description'] = value;
    } else if (['match', 'exclude-match', 'include', 'exclude'].includes(key)) {
      if (parsePattern(value) === null)
        return failure(
          'unsupported',
          `不支持的 @${key} 规则：仅接受 HTTP/HTTPS、完整域名或 *.域名，以及路径 * 通配符。`,
        );
      const target =
        key === 'match'
          ? metadata.matches
          : key === 'exclude-match'
            ? metadata.excludes
            : key === 'include'
              ? metadata.includes
              : metadata.excludeGlobs;
      if (!target.includes(value)) target.push(value);
    } else if (key === 'grant') {
      if (!GRANTS.has(value))
        return failure(
          'unsupported',
          `暂不支持脚本权限 ${value.slice(0, 100) || '（空）'}；目前仅支持 GM_addStyle、GM.addStyle、GM_info、GM.info 和 none。`,
        );
      if (!metadata.grants.includes(value)) metadata.grants.push(value);
    } else if (key === 'run-at') {
      if (seen.has(key)) return failure('invalid-input', '执行时机不能重复声明。');
      seen.add(key);
      if (value !== 'document-idle')
        return failure('unsupported', '暂仅支持 @run-at document-idle，或省略执行时机。');
    } else if (key === 'noframes' && value === '') {
      // Every script already runs only in the main frame.
    } else if (INFORMATIONAL.has(key) || /^(name|description):[a-zA-Z-]{2,20}$/u.test(key)) {
      if (value.length > 2048) return failure('limit-exceeded', '脚本说明字段过长。');
      // Informational URLs are never opened, fetched, or used as execution directives.
    } else {
      const label = /^[a-zA-Z][a-zA-Z0-9:._-]{0,60}$/u.test(key) ? `@${key}` : '未知元数据';
      return failure('unsupported', `暂不支持 ${label}；不会下载依赖、更新脚本或授予额外能力。`);
    }
  }
  if (metadata.name === '') return failure('invalid-input', '脚本必须声明非空 @name。');
  if (metadata.matches.length + metadata.includes.length === 0)
    return failure('invalid-input', '脚本必须声明至少一条受支持的 @match 或 @include。');
  if (
    metadata.matches.length +
      metadata.excludes.length +
      metadata.includes.length +
      metadata.excludeGlobs.length >
    USER_SCRIPT_LIMITS.patterns
  )
    return failure('limit-exceeded', '脚本匹配规则总数不能超过 64 条。');
  if (metadata.grants.includes('none') && metadata.grants.length !== 1)
    return failure('invalid-input', '@grant none 不能与其它权限同时使用。');
  try {
    // Compilation checks syntax only. User code is never evaluated in the main process.
    new Script(source);
    new Script(`(${buildUserScriptBody(source)})`);
  } catch {
    return failure('invalid-input', '脚本语法或运行包装不兼容；当前不支持顶层 return 或模块语法。');
  }
  return { ok: true, value: metadata };
}
