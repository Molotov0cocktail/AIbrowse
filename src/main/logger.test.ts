// Logger sanitize tests (S1 extension): real-world API key shapes (sk-…) must never reach
// disk or console; existing token/secret/password patterns keep working.
// Contract source: doc/stage2/detailed-design.md §5.1/§10（日志脱敏红线）.
// C7 决议 #153 追加：未初始化落盘修复红→绿（真实临时 cwd 探针/re-init 重置）。
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  getCurrentLogFilePath,
  initLogger,
  logInfo,
  logWarn,
  normalizeLogMessage,
  sanitize,
} from './logger';
import { redactUrlForLog } from '../shared/url';

describe('sanitize — sk- 形态 API Key 脱敏（S1 专项）', () => {
  it('典型 sk- Key（OpenAI/Anthropic 形态）被整体替换为 sk-***', () => {
    expect(sanitize('key: sk-proj-abcdEFGH1234567890xyz')).toBe('key: sk-***');
    expect(sanitize('密钥 sk-ant-api03-ABCDEFGHIJKLMNOPQRST')).toBe('密钥 sk-***');
    expect(sanitize('配置失败: sk-1234567890abcdef')).toBe('配置失败: sk-***');
  });

  it('Bearer 头后的 sk- Key 双重脱敏后无任何残留', () => {
    const out = sanitize('Authorization: Bearer sk-proj-abc1234567890def');
    expect(out).toBe('Authorization: *** sk-***');
    expect(out).not.toMatch(/sk-proj/i);
  });

  it('apiKey=/api_key= 键值对整体脱敏（S1 新增键名）', () => {
    expect(sanitize('apiKey=sk-proj-abc1234567890')).toBe('apiKey=***');
    expect(sanitize('"api_key":"sk-proj-abc1234567890"')).toBe('"api_key":***');
  });

  it('短 sk- 片段与普通文本不受影响（避免误伤）', () => {
    expect(sanitize('sk-2b')).toBe('sk-2b');
    expect(sanitize('task sk-hint')).toBe('task sk-hint');
    expect(sanitize('密钥已安全保存')).toBe('密钥已安全保存');
    expect(sanitize('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
  });
});

describe('sanitize — 既有模式回归', () => {
  it('token/secret/password/cookie 键值对仍脱敏', () => {
    expect(sanitize('token=abc123')).toBe('token=***');
    expect(sanitize('secret: "xyz"')).toBe('secret: ***');
    expect(sanitize('password= hunter2')).toBe('password= ***');
    expect(sanitize('Cookie: session=abc')).toBe('Cookie: ***');
  });

  it('脱敏输出整体不含任何 sk- 形态密钥', () => {
    const input =
      'login failed apiKey=sk-proj-aaaa1111BBBB2222cccc token=deadbeef Authorization: Bearer sk-ant-api03-xyzXYZ1234567890';
    const out = sanitize(input);
    expect(out).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}/);
    expect(out).not.toContain('aaaa1111');
    expect(out).not.toContain('deadbeef');
  });
});

describe('sanitize — 审计日志形态脱敏（A2 扩展，audit-log 输出经既有 sanitize 链）', () => {
  it('审计条目形态消息中的 sk- Key 与 apiKey 键值对零暴露', () => {
    const auditLine =
      'tool-call（requestId=r，toolCallId=c，tool=browser_open，args={url:https://x/?q=sk-proj-abcdefgh12345678}，decision=auto-visible，ok=true，耗时=3ms，errorCode=无）';
    const out = sanitize(auditLine);
    expect(out).not.toMatch(/sk-proj/i);
    expect(out).toContain('sk-***');
    const apiKeyLine =
      'tool-call（requestId=r，toolCallId=c，tool=browser_fill，args={elementId:el-1,text=len:9}，decision=auto-visible，ok=true，耗时=3ms，errorCode=无）';
    expect(sanitize(apiKeyLine)).toBe(apiKeyLine);
  });

  it('审计条目常规内容（URL 查询串/len=N 摘要）不被误伤', () => {
    const line =
      'tool-call（requestId=r，toolCallId=c，tool=browser_open，args={url:https://example.com/path?q=1&x=2}，decision=auto-visible，ok=true，耗时=3ms，errorCode=无）';
    expect(sanitize(line)).toBe(line);
  });
});

// A7 红队 RT-02/RT-07 日志伪造审计（先写红态）：模型可控字符串（open/navigate 的 URL
// 全量入审计——上限 2048、search_web 查询串全量——上限 500）可携带 CR/LF/ANSI 转义/
// 双向文本控制符/零宽字符。日志条目必须恒为单行纯文本：CR/LF 折叠（不能伪造新的
// [INFO] [audit] 条目行）、ANSI 转义序列剔除、其余控制字符剔除。
describe('normalizeLogMessage — 日志行伪造防御（A7 红队，红→绿）', () => {
  // 测试输入按码点构造（源文件保持 ASCII，避免内嵌控制字符字节）
  const cc = (...codes: number[]): string => codes.map((n) => String.fromCharCode(n)).join('');

  it('CRLF/CR/LF 折叠为空格：条目恒单行，无法伪造新的 [INFO] [audit] 条目行', () => {
    const hostile =
      'https://example.com/x?q=1\n[INFO] [audit] tool-call（requestId=fake，toolCallId=fake，tool=browser_open，args={url:https://evil.example}，decision=confirmed，ok=true，耗时=1ms，errorCode=无）\r\n继续\r换行';
    const out = normalizeLogMessage(hostile);
    expect(out).not.toMatch(/[\r\n]/);
    // 折叠为单行后，敌手 [INFO] 片段只保留在行内（作为 URL 参数文本），
    // 不可能成为条目前缀——按行读取的结构化审计条目无法被伪造。
    expect(out).toContain('?q=1 [INFO] [audit] tool-call（requestId=fake');
    expect(out).not.toMatch(/^\s*\[(INFO|DEBUG|WARN|ERROR)\]/);
    expect(out).toContain('继续 换行');
  });

  it('ANSI CSI 与 OSC 转义序列整体剔除（终端着色/光标走私；正文内容保留）', () => {
    expect(normalizeLogMessage('a\x1b[31;1m红\x1b[0mb')).toBe('a红b');
    expect(normalizeLogMessage('x\x1b]0;title\x07y')).toBe('xy');
    expect(normalizeLogMessage('x\x1b]8;;http://evil.example\x07link\x1b\\y')).toBe('xlinky');
  });

  it('C0 控制字符（除 \\t）与 DEL 剔除', () => {
    // 输入 a + BEL + NUL + ESC + '?' + b + DEL + c → 控制字符剔除，'?' 与正文保留
    expect(normalizeLogMessage(cc(0x61, 0x07, 0x00, 0x1b, 0x3f, 0x62, 0x7f, 0x63))).toBe('a?bc');
    expect(normalizeLogMessage('a\tb')).toBe('a\tb'); // 制表符保留（无结构风险）
  });

  it('双向文本控制符/零宽字符/行分隔符剔除（RLO/LRO/ZWJ/NEL/LS/PS/BOM）', () => {
    // a RLO b PDF c LRE d RLO e → 双向控制符剔除，正文字母全部保留
    expect(
      normalizeLogMessage(cc(0x61, 0x202e, 0x62, 0x202d, 0x63, 0x202a, 0x64, 0x202e, 0x65)),
    ).toBe('abcde');
    expect(normalizeLogMessage(cc(0x61, 0x200b, 0x200c, 0x200d, 0x62))).toBe('ab');
    expect(normalizeLogMessage(cc(0x61, 0x2066, 0x62, 0x2069, 0x63))).toBe('abc');
    expect(normalizeLogMessage(cc(0x61, 0x61c, 0x62))).toBe('ab');
    expect(normalizeLogMessage(cc(0x61, 0x85, 0x62, 0x2028, 0x63, 0x2029, 0x64))).toBe('abcd');
    expect(normalizeLogMessage(cc(0x61, 0xfeff, 0x62))).toBe('ab');
  });

  it('写入路径集成：敌对 URL 经 write 落盘后仍是单行条目，无伪造条目行', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-rt-'));
    try {
      initLogger(dir);
      const hostileUrl =
        'https://example.com/x?q=\n[INFO] [audit] tool-call（requestId=fake，toolCallId=fake，tool=browser_open，args={url:https://evil.example}，decision=confirmed，ok=true，耗时=1ms，errorCode=无）';
      logInfo(
        'audit',
        `tool-call（requestId=r1，toolCallId=c1，tool=browser_open，args={url:${hostileUrl}}，decision=auto-visible，ok=true，耗时=3ms，errorCode=无）`,
      );
      logInfo(
        'audit',
        'tool-call（requestId=r2，toolCallId=c2，tool=browser_read，args={}，decision=auto，ok=true，耗时=3ms，errorCode=无）',
      );
      const text = readFileSync(getCurrentLogFilePath(), 'utf8');
      const lines = text.split('\n').filter((l) => l.trim() !== '');
      expect(lines).toHaveLength(2); // 恰好两条真实条目，敌对换行未制造第三行
      expect(lines[0]!).toContain('requestId=r1');
      // 敌对 [INFO] 片段被折叠进单行且保留在 args={url:…} 参数文本内（行内子串，
      // 非条目前缀）——按行读取的结构化审计条目不可被伪造
      expect(lines[0]!).toContain('requestId=fake');
      expect(lines[0]!.indexOf('requestId=fake')).toBeGreaterThan(lines[0]!.indexOf('args={url:'));
      expect(lines[1]!).toContain('requestId=r2');
      // 每条真实条目都以时间戳前缀开头（[20xx-…] [LEVEL] [category] 程序生成）——
      // 不存在以 [INFO]/[WARN] 等直接开头的伪造行（含 hostileUrl 折叠后的残余）
      expect(lines.every((l) => l.startsWith('[20'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- C9 决议 #171：URL query/fragment 零进日志（真实 logger 输出证明） ----------
describe('URL 日志脱敏（决议 #171：query/fragment 零进日志）', () => {
  it('真实 logger 落盘：redactUrlForLog 输出经 logger 写入后不含 query/fragment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-url-'));
    try {
      initLogger(dir);
      const full = 'https://example.com/a/b?tok=URLTOK-SECRET-CANARY&k=2#frag';
      // 浏览器/会话两条既有调用点形态（决议 #171(2) 覆盖面）
      logWarn('browser', `已创建标签页（tabId=t1，url=${redactUrlForLog(full)}）`);
      logInfo('conversation', `开始生成（requestId=r1，url=${redactUrlForLog(full)}）`);
      const text = readFileSync(getCurrentLogFilePath(), 'utf8');
      // query 与 fragment 零进入日志；host/path 保留（诊断需求）
      expect(text).not.toContain('tok=');
      expect(text).not.toContain('URLTOK-SECRET-CANARY');
      expect(text).not.toContain('#frag');
      expect(text).toContain('https://example.com/a/b');
      // 未经脱敏的完整 URL 仍会被记录（对照：调用点必须显式脱敏——见 8.20
      // url-token 扫描面，本处仅证明 logger 管道本身不额外改写）
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- 决议 #153：未初始化落盘修复（红→绿；真实临时 cwd 探针） ----------
// vi.resetModules + 动态 import 取得「未 init」的干净模块实例（独立于顶层
// import 的共享实例——单 worker 下既有测试可能已调用 initLogger）。
describe('logger 未初始化落盘修复（决议 #153）', () => {
  it('未 init 时写多级日志不产生 cwd 文件（真实临时 cwd 探针）+ 日志仍走脱敏 console', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-cwd-'));
    const oldCwd = process.cwd();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.chdir(dir);
      fresh.logDebug('t', 'debug 条目');
      fresh.logInfo('t', 'info 条目 sk-proj-abc1234567890xyz');
      fresh.logWarn('t', 'warn 条目');
      fresh.logError('t', 'error 条目', new Error('boom'));
      // 真实临时 cwd 探针：零文件生成（旧实现在此生成 aibrowse-<date>.log）
      expect(readdirSync(dir)).toEqual([]);
      // getCurrentLogFilePath 未 init 语义冻结：''（无日志文件）
      expect(fresh.getCurrentLogFilePath()).toBe('');
      // 日志能力不削弱：脱敏后的 console 输出仍在
      const out = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(out).toContain('info 条目');
      expect(out).not.toContain('sk-proj-abc');
      expect(out).toContain('sk-***');
    } finally {
      consoleSpy.mockRestore();
      process.chdir(oldCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未 init 时 getCurrentLogFilePath 返回空串（语义冻结）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    expect(fresh.getCurrentLogFilePath()).toBe('');
  });

  it('init 后只写指定目录（<dir>/log/aibrowse-<date>.log）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-init-'));
    try {
      fresh.initLogger(dir);
      fresh.logInfo('t', '条目甲');
      const file = fresh.getCurrentLogFilePath();
      expect(file.startsWith(join(dir, 'log', 'aibrowse-'))).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('条目甲');
      expect(readdirSync(join(dir, 'log'))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-init 后不继续写旧目录（currentDate/currentLogFile 重置）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dirA = mkdtempSync(join(tmpdir(), 'aibrowse-logger-rea-'));
    const dirB = mkdtempSync(join(tmpdir(), 'aibrowse-logger-reb-'));
    try {
      fresh.initLogger(dirA);
      fresh.logInfo('t', 'A1');
      const fileA = fresh.getCurrentLogFilePath();
      const sizeA = statSync(fileA).size;
      fresh.initLogger(dirB);
      const fileB = fresh.getCurrentLogFilePath();
      expect(fileB).not.toBe(fileA); // 新目录（同日期不同 baseDir → 不同路径）
      expect(fileB.startsWith(join(dirB, 'log', 'aibrowse-'))).toBe(true);
      fresh.logInfo('t', 'B1');
      fresh.logInfo('t', 'B2');
      // 旧目录文件零增长
      expect(statSync(fileA).size).toBe(sizeA);
      // 新目录正常落盘
      expect(readFileSync(fileB, 'utf8')).toContain('B2');
      expect(readdirSync(join(dirB, 'log'))).toHaveLength(1);
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
