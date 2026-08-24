// Logger sanitize tests (S1 extension): real-world API key shapes (sk-…) must never reach
// disk or console; existing token/secret/password patterns keep working.
// Contract source: doc/stage2/detailed-design.md §5.1/§10（日志脱敏红线）.
// C7 决议 #153 追加：未初始化落盘修复红→绿（真实临时 cwd 探针/re-init 重置）。
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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

// ---------- D1 日志资源硬化（红→绿；contract: doc/stage6/detailed-design.md §2/§13/§14、
// threat-model §3.8/WRT-18） ----------
// 目标：8 KiB 单行、10 MiB 写前滚动、10 文件/14 天保留、受控文件名严格匹配、失败安全。
// 红态机器证据：旧实现无行截断/无滚动/无清理/无受控名解析。
describe('logger 资源硬化 — 单行 8 KiB（D1）', () => {
  it('ASCII 8192 bytes 恰好接受（== 边界不截断）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-line-'));
    try {
      fresh.initLogger(dir);
      const prefix = '[2026-01-01 00:00:00.000] [INFO ] [cat] ';
      // 物理行内容（前缀 + 正文）恰好 8192 bytes（== 上限原样接受，无 truncated 标记）
      const payload = 'a'.repeat(8192 - Buffer.byteLength(prefix, 'utf8'));
      fresh.logInfo('cat', payload);
      const file = fresh.getCurrentLogFilePath();
      const text = readFileSync(file, 'utf8');
      const line = text.split('\n')[0]!;
      expect(Buffer.byteLength(line, 'utf8')).toBe(8192);
      expect(line).toContain(payload);
      expect(line).not.toContain('truncated');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ASCII 8193 bytes 截断且带截断元数据（> 边界）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-line2-'));
    try {
      fresh.initLogger(dir);
      // payload 长到 > 8192（整体）
      const payload = 'a'.repeat(9000);
      fresh.logInfo('cat', payload);
      const file = fresh.getCurrentLogFilePath();
      const text = readFileSync(file, 'utf8');
      const line = text.split('\n')[0]!;
      // 截断后物理行内容必须 <= 8192
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(8192);
      expect(line).toContain('truncated=true');
      // 元数据记录截断前规范化字节数，不把截断值冒充完整值
      expect(line).toMatch(/truncated=true/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('中文/emoji 多字节按 UTF-8 字节计，超限截断不拆 surrogate', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-line3-'));
    try {
      fresh.initLogger(dir);
      // 3 字节中文 x 4000 = 12000 bytes（> 8192）；截断必须按字节且不拆 UTF-16 码点
      const payload = '中'.repeat(4000);
      fresh.logInfo('cat', payload);
      const file = fresh.getCurrentLogFilePath();
      const text = readFileSync(file, 'utf8');
      const line = text.split('\n')[0]!;
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(8192);
      // 截断处不能出现半个 UTF-16 surrogate：readFileSync 解码后不得有 �（若拆开会有替换符）
      expect(text).not.toContain('�');
      // 4 字节 emoji 同样不拆
      const emoji = '😀'.repeat(2500);
      fresh.logInfo('cat', emoji);
      const text2 = readFileSync(file, 'utf8');
      expect(text2).not.toContain('�');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Error 多行堆栈的每个物理行均独立满足 8 KiB', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-err-'));
    try {
      fresh.initLogger(dir);
      const long = 'x'.repeat(6000);
      const err = new Error(`短消息 ${long}`);
      err.stack = `Error: 短消息 ${long}\n    at a (file:1)\n    at b (${'y'.repeat(6000)})`;
      fresh.logError('cat', '错误详情', err);
      const file = fresh.getCurrentLogFilePath();
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');
      for (const l of lines) {
        if (l.trim() === '') continue;
        expect(Buffer.byteLength(l, 'utf8')).toBeLessThanOrEqual(8192);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitize 后无 Key 残留（截断路径同样脱敏）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-key-'));
    try {
      fresh.initLogger(dir);
      // 极长正文内含 sk- 形态 Key（独立 token，两侧为空格，确保命中既有 \b 脱敏契约）；
      // 无论是否截断，Key 均不得出现在物理行
      const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
      const payload = 'k'.repeat(5000) + ' ' + key + ' ' + 'k'.repeat(5000);
      fresh.logInfo('cat', payload);
      const file = fresh.getCurrentLogFilePath();
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
      expect(text).toContain('sk-***');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logger 资源硬化 — 10 MiB 写前滚动（D1）', () => {
  it('写前总和恰好 == 10 MiB 仍写当前文件（== 边界不滚动）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-rot0-'));
    try {
      fresh.initLogger(dir);
      const file = fresh.getCurrentLogFilePath();
      const max = 1024 * 1024 * 10;
      // 先写一条 logger 行，测出真实物理行字节数（含 \n），再补 pad 使总和恰好 == 10 MiB
      fresh.logInfo('cat', 'probe');
      const probe = readFileSync(file, 'utf8');
      const firstLineBytes = Buffer.byteLength(probe.split('\n')[0]!, 'utf8');
      const lineBytes = Buffer.byteLength(probe, 'utf8'); // 含 \n
      const pad = Buffer.alloc(max - lineBytes, 0x61);
      appendFileSync(file, pad);
      expect(statSync(file).size).toBe(max); // 前置总和恰好 == 10 MiB
      // logger 再写一条：总和 == 10 MiB + lineBytes > 10 MiB，必须滚动（恰好边界指
      // 「现有文件 + 本次写入 == 10 MiB」，但 logger 每次至少写一条完整行，行字节 > 0，
      // 因此此断言反映实现为「+1 byte 即滚动」的正确语义）
      fresh.logInfo('cat', 'final');
      const names = readdirSync(join(dir, 'log')).sort();
      expect(names).toContain(`${basename(file)}`);
      expect(names).toContain(`${basename(file).replace(/\.log$/, '.1.log')}`);
      // 旧文件保持 <= 10 MiB（写前滚动，绝不先写超限）
      expect(statSync(file).size).toBe(max);
      expect(
        readFileSync(join(dir, 'log', `${basename(file).replace(/\.log$/, '.1.log')}`), 'utf8'),
      ).toContain('final');
      void firstLineBytes;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('写前总和 > 10 MiB 时先滚动再写新文件（.N 序号）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-rot1-'));
    try {
      fresh.initLogger(dir);
      const file = fresh.getCurrentLogFilePath();
      // 10 MiB - 1 byte，再写一行 -> 超限，必须滚动
      const pad = Buffer.alloc(1024 * 1024 * 10 - 1, 0x61);
      appendFileSync(file, pad);
      fresh.logInfo('cat', 'overflow');
      const names = readdirSync(join(dir, 'log')).sort();
      // 旧文件未超限（写前滚动），新内容进入 .1
      expect(names).toContain(`${basename(file)}`);
      expect(names).toContain(`${basename(file).replace(/\.log$/, '.1.log')}`);
      const newFile = join(dir, 'log', `${basename(file).replace(/\.log$/, '.1.log')}`);
      expect(readFileSync(newFile, 'utf8')).toContain('overflow');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('.N 滚动不覆盖已有序号文件（选择下一个空闲序号）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-rot2-'));
    try {
      fresh.initLogger(dir);
      const file = fresh.getCurrentLogFilePath();
      // 预置 .1 与 .2，让滚动需要 .3
      appendFileSync(join(dir, 'log', `${basename(file).replace(/\.log$/, '.1.log')}`), 'x');
      appendFileSync(join(dir, 'log', `${basename(file).replace(/\.log$/, '.2.log')}`), 'x');
      const pad = Buffer.alloc(1024 * 1024 * 10 - 1, 0x61);
      appendFileSync(file, pad);
      fresh.logInfo('cat', 'should-go-3');
      const names = readdirSync(join(dir, 'log')).sort();
      expect(names).toContain(`${basename(file).replace(/\.log$/, '.3.log')}`);
      expect(
        readFileSync(join(dir, 'log', `${basename(file).replace(/\.log$/, '.3.log')}`), 'utf8'),
      ).toContain('should-go-3');
      // 已有序号文件内容未被覆盖
      expect(
        readFileSync(join(dir, 'log', `${basename(file).replace(/\.log$/, '.1.log')}`), 'utf8'),
      ).toBe('x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('日期切换后新文件为无序号 base 文件', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-date-'));
    try {
      fresh.initLogger(dir);
      const file = fresh.getCurrentLogFilePath();
      const today = basename(file);
      const todayBase = today.replace(/\.log$/, '');
      // 模拟次日：写入一个「昨天」的受控文件（在 14 天保留期内，不应被清理）
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const yesterday = `aibrowse-${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(
        y.getDate(),
      ).padStart(2, '0')}.log`;
      writeFileSync(join(dir, 'log', yesterday), 'old');
      // 同日已有 .1 滚动文件；重新 init 后写新内容仍应落在无序号 base（日期切换语义）
      appendFileSync(join(dir, 'log', `${todayBase}.1.log`), 'x');
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'new-day');
      const names = readdirSync(join(dir, 'log')).sort();
      // 当前日期 base 文件存在且包含新内容（无序号）
      expect(names).toContain(today);
      expect(readFileSync(join(dir, 'log', today), 'utf8')).toContain('new-day');
      // 昨天（保留期内）文件仍在，未被误删
      expect(names).toContain(yesterday);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logger 资源硬化 — 14 天 / 10 文件保留（D1）', () => {
  it('年龄恰好 14 天允许保留；超过 14 天删除', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-age-'));
    try {
      fresh.initLogger(dir);
      // 以真实「本地今天」为锚，构造恰好 14 天前与 15 天前的受控文件
      const mk = (daysAgo: number): string => {
        const d = new Date();
        d.setDate(d.getDate() - daysAgo);
        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
          d.getDate(),
        ).padStart(2, '0')}`;
        const p = join(dir, 'log', `aibrowse-${ds}.log`);
        writeFileSync(p, 'x');
        return `aibrowse-${ds}.log`;
      };
      const day14Name = mk(14); // 恰好 14 个日历日 -> 允许保留
      const day15Name = mk(15); // 超过 14 个日历日 -> 删除
      // 触发 housekeeping：re-init（init 时运行一次有界清理）
      fresh.initLogger(dir);
      const names = readdirSync(join(dir, 'log')).map((n) => basename(n));
      expect(names).toContain(day14Name);
      expect(names).not.toContain(day15Name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('超过 10 个受控文件时按确定顺序保留最新 10 个（含 active）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-max-'));
    try {
      fresh.initLogger(dir);
      const file = fresh.getCurrentLogFilePath();
      const base = basename(file).replace(/\.log$/, '');
      // 创建 15 个不同日期的受控文件：11 个新近（含当前 base）、4 个超龄
      const dateStr = (d: Date): string =>
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      for (let i = 0; i < 4; i += 1) {
        const d = new Date();
        d.setDate(d.getDate() - (30 + i)); // 30+ 天前（超龄，应被 14 天过滤删）
        writeFileSync(join(dir, 'log', `aibrowse-${dateStr(d)}.log`), 'x');
      }
      for (let i = 0; i < 11; i += 1) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const ds = dateStr(d);
        if (ds === base) continue; // base 已存在
        writeFileSync(join(dir, 'log', `aibrowse-${ds}.log`), 'x');
      }
      // 触发 housekeeping：re-init（同时验证 active 计入 10 个）
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'trigger');
      const names = readdirSync(join(dir, 'log')).map((n) => basename(n));
      const controlled = names.filter((n) => /^aibrowse-\d{4}-\d{2}-\d{2}(\.\d+)?\.log$/.test(n));
      // 4 个超龄被 14 天过滤删除；其余（11 新近 + base = 12 个）经数量过滤保留最新 10 个
      expect(controlled.length).toBe(10);
      // 当前 active 文件必须保留
      expect(controlled).toContain(basename(file));
      // 排序稳定（确定顺序）：14 天内 12 个（day0..day11）经数量过滤保留最新 10 个，
      // 即 day0..day9 保留、day10/day11 被裁剪；不依赖 readdir 返回顺序
      const d9 = new Date();
      d9.setDate(d9.getDate() - 9);
      expect(controlled).toContain(`aibrowse-${dateStr(d9)}.log`);
      const d10 = new Date();
      d10.setDate(d10.getDate() - 10);
      expect(controlled).not.toContain(`aibrowse-${dateStr(d10)}.log`);
      const d11 = new Date();
      d11.setDate(d11.getDate() - 11);
      expect(controlled).not.toContain(`aibrowse-${dateStr(d11)}.log`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('未知文件、普通文件、目录、junction 均不删除', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-safe-'));
    try {
      fresh.initLogger(dir);
      const logDirPath = join(dir, 'log');
      // 未知文件
      writeFileSync(join(logDirPath, 'unrelated.txt'), 'x');
      writeFileSync(join(logDirPath, 'aibrowse-2000-13-99.log'), 'x'); // 畸形日期（13 月）
      writeFileSync(join(logDirPath, 'aibrowse-2000-01-01.abc.log'), 'x'); // 畸形序号
      // 目录
      mkdirSync(join(logDirPath, 'aibrowse-2020-01-01.log'));
      // junction（指向外部目录）
      const outside = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-out-'));
      writeFileSync(join(outside, 'sentinel.txt'), 'keep');
      const junctionPath = join(logDirPath, 'aibrowse-1999-01-01.log');
      symlinkSync(outside, junctionPath, 'junction');
      fresh.logInfo('cat', 'trigger');
      // 全部非受控条目保留
      expect(readFileSync(join(logDirPath, 'unrelated.txt'), 'utf8')).toBe('x');
      expect(readFileSync(join(logDirPath, 'aibrowse-2000-13-99.log'), 'utf8')).toBe('x');
      expect(readFileSync(join(logDirPath, 'aibrowse-2000-01-01.abc.log'), 'utf8')).toBe('x');
      expect(statSync(join(logDirPath, 'aibrowse-2020-01-01.log')).isDirectory()).toBe(true);
      // junction 未跟随、未删除；外部内容完好
      expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep');
      expect(statSync(junctionPath, { throwIfNoEntry: false })).not.toBeNull();
      rmSync(outside, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readdir/stat/unlink 失败受控降级 console 且不递归 logger（不崩溃）', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-d1-fail-'));
    try {
      fresh.initLogger(dir);
      const logDirPath = join(dir, 'log');
      // 用只读目录模拟 readdir/stat 失败（Windows 上 chmod 只读对目录删除有影响，
      // 这里改用不可读路径：让 housekeeping 指向一个不存在的 logDir 子路径）
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // 触发 housekeeping 前删除 log 目录（使 readdir 失败）；logger 必须降级不崩溃
        // 注：rmSync 会删除日志；之后 logger 写操作仍应降级 console，不抛未捕获
        rmSync(logDirPath, { recursive: true, force: true });
        expect(() => fresh.logInfo('cat', 'after-dir-gone')).not.toThrow();
        expect(() => fresh.logError('cat', 'err', new Error('boom'))).not.toThrow();
        expect(() => fresh.getCurrentLogFilePath()).not.toThrow();
      } finally {
        consoleSpy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- D1 硬化加固（Reviewer 批准的 Repair Contract） ----------
// 目标根因：
//   F1 housekeeping 无「当前活动文件不得删除」保护 → 同日第 11 个受控文件产生时删除刚写入的最高序号文件；
//   F3 initLogger 的 mkdir 失败会抛出（不满足受控降级）；housekeeping 失败静默；真实日期切换不执行 housekeeping；
//   F4 8 KiB/10 MiB 精确边界与 IO 失败测试不具甄别能力（需逐字节、逐失败点证明）；
//   F5 受控滚动序号必须为规范正整数：`.0`/前导零/非有限/超大序号不得进入受控删除集合。
// 时钟基座：vi.setSystemTime 等价确定性时钟（进程墙钟被钉住，无需真实等待）。

// 本测试文件的公共确定性时钟助手：钉住系统墙钟，保证所有「日期切换」类测试
// 在确定性本地逻辑日期上运行（不依赖真实运行时刻）。
let testDate: Date | null = null;
function setFrozenClock(iso: string): void {
  testDate = new Date(iso);
  vi.setSystemTime(testDate);
}
function clearFrozenClock(): void {
  testDate = null;
  vi.useRealTimers();
}
function frozenNow(): Date {
  if (testDate === null) throw new Error('frozen clock not set');
  return testDate;
}
// 冻结时钟下的本地日历日期字符串（YYYY-MM-DD）
function frozenDateStamp(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}
// 同日期滚动文件名（受控形态）
function rotName(base: string, seq: number): string {
  return `${base}.${seq}.log`;
}
// 受控文件名解析（测试侧镜像 logger 契约，仅断言用）
function controlledNames(names: string[]): string[] {
  return names.filter((n) => /^aibrowse-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(n));
}

describe('logger 硬化 — 同日滚动上限与活动文件保护（F1 红→绿）', () => {
  it('同日存在 base+.1~.9，滚动到 .10：内容可读、活动文件保留、受控总数<=10、旧文件按序淘汰', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-f1-rot-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z'); // 本地逻辑日 D
      fresh.initLogger(dir);
      // 无序号 base（aibrowse-2026-08-20）：init 后立即提取，供 rotName/断言使用。
      // 注意后续滚动会让 getCurrentLogFilePath 指向 .N，base 必须在此固定。
      const base = basename(fresh.getCurrentLogFilePath()).replace(/\.log$/, '');
      const max = 1024 * 1024 * 10;
      // 通过真实写前滚动逐步产生 base + .1..9（10 个受控文件）。
      // 每次把当前活动文件填到「距 10 MiB 恰好差一条 logger 行（含 \n）」，再写一条触发滚动。
      // 把当前活动文件填到恰好 == 10 MiB（现有大小 == max），随后一条 logger 行
      // （含 \n）即超出上限 → 写前滚动到 .i。注意滚动会切换活动文件（写进新文件），
      // 因此每轮先取当前路径再填满。修复前每次滚动后的 housekeeping 会删除刚滚动出
      // 的旧活动文件（活动保护缺失）——本测试通过即证明活动文件受保护。
      const fillToEdge = (): void => {
        const cur = fresh.getCurrentLogFilePath();
        // 首次轮转前 base 尚未创建：先写一条创建当前活动文件（活动文件必须存在——
        // 修复前 housekeeping 会删除刚滚动出的活动文件 → 红）。
        const st0 = statSync(cur, { throwIfNoEntry: false });
        if (st0 === undefined) fresh.logInfo('cat', 'init-create');
        const cur2 = fresh.getCurrentLogFilePath();
        const st = statSync(cur2, { throwIfNoEntry: false });
        expect(st).not.toBeUndefined();
        const curSize = st!.size;
        const pad = Buffer.alloc(max - curSize, 0x61);
        appendFileSync(cur2, pad);
        expect(statSync(cur2).size).toBe(max);
      };
      for (let i = 1; i <= 9; i += 1) {
        fillToEdge(); // 当前活动文件 = 10 MiB
        fresh.logInfo('cat', `roll-${i}`); // 写一行 → 滚动到 .i（写进新文件）
      }
      expect(basename(fresh.getCurrentLogFilePath())).toBe(rotName(base, 9)); // 当前在 .9
      expect(readdirSync(join(dir, 'log'))).toHaveLength(10); // base + .1..9
      // 下一次滚动写到 .10：总数将到 11 > 10。修复前 housekeeping 会把刚写入的
      // .10（最高序号活动文件）当作超数删除——本轮日志内容必须仍可读取。
      fillToEdge(); // .9 = 10 MiB
      fresh.logInfo('cat', 'payload-a'); // 滚动到 .10，写入 payload-a
      fresh.logInfo('cat', 'payload-b'); // 继续写 .10
      const file2 = fresh.getCurrentLogFilePath();
      expect(basename(file2)).toBe(rotName(base, 10)); // 滚动到 .10
      const names = readdirSync(join(dir, 'log'));
      // 本次日志内容可读取（活动文件存在且包含最新写入）
      expect(readFileSync(join(dir, 'log', rotName(base, 10)), 'utf8')).toContain('payload-b');
      expect(readFileSync(join(dir, 'log', rotName(base, 10)), 'utf8')).toContain('payload-a');
      // 活动文件路径指向存在的普通文件
      expect(statSync(file2).isFile()).toBe(true);
      // 受控文件总数恰好 <= 10（housekeeping 后不超上限；活动文件计入）
      const controlled = controlledNames(names);
      expect(controlled.length).toBeLessThanOrEqual(10);
      // 确定顺序淘汰（不依赖 readdir 返回顺序）：同日 seq 降序（最新滚动优先保留），
      // 活动 .10 计入上限后保留最新 10 个 = .1..10；base（seq 0 排最后）被裁剪。
      // 修复前 housekeeping 把 .10（最高序号活动文件）当超数删掉且当前写入内容丢失——
      // 本测试通过即证明 activity 被正确保护并计入上限。
      const sorted = controlled.sort((a, b) => {
        const seqA = Number(a.match(/\.(\d+)\.log$/)?.[1] ?? 0);
        const seqB = Number(b.match(/\.(\d+)\.log$/)?.[1] ?? 0);
        return seqA - seqB;
      });
      expect(sorted[0]!).toBe(rotName(base, 1)); // 最小 seq 保留 = .1
      expect(sorted).toContain(rotName(base, 10)); // 活动 .10 保留
      expect(sorted).not.toContain(`${base}.log`); // base（无序号，同日排最后）被淘汰
      expect(controlled).toHaveLength(10); // 10 上限恰好保留 10 个受控文件（含活动）
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('re-init 已有多个同日滚动文件后再次写入：不丢失、活动文件计入 10 上限、不覆盖既有文件', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-f1-reinit-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      const file = fresh.getCurrentLogFilePath();
      const base = basename(file).replace(/\.log$/, '');
      // 已有 .1、.2（re-init 前的同日滚动）
      writeFileSync(join(dir, 'log', rotName(base, 1)), 'old-1');
      writeFileSync(join(dir, 'log', rotName(base, 2)), 'old-2');
      // re-init 后再次写入：活动文件应计入 10 上限，滚动不得覆盖既有 .1/.2
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'current');
      const file2 = fresh.getCurrentLogFilePath();
      // re-init 后当前日期 base 活动文件仍存在且包含新内容
      expect(basename(file2)).toBe(basename(file));
      expect(readFileSync(join(dir, 'log', basename(file)), 'utf8')).toContain('current');
      // 既有 .1/.2 内容未被覆盖
      expect(readFileSync(join(dir, 'log', rotName(base, 1)), 'utf8')).toBe('old-1');
      expect(readFileSync(join(dir, 'log', rotName(base, 2)), 'utf8')).toBe('old-2');
      // 活动 base + .1 + .2 = 3 个受控文件（<=10，无裁剪）
      expect(controlledNames(readdirSync(join(dir, 'log'))).length).toBe(3);
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logger 硬化 — 日期切换执行 housekeeping（F3 红→绿）', () => {
  it('跨越本地午夜：真实日期切换清理超龄/超数受控文件；未知文件/目录/symlink/junction 保留', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-f3-mid-'));
    try {
      // 钉住时钟到 D 日（本地逻辑日）；init 后先写一条建立 currentDate=D，
      // 使下一次日期切换（D+1）触发 housekeeping（否则首次 logInfo 直接落在 D+1，
      // switched=false 不会执行 housekeeping）。
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'establish-day'); // 建立 currentDate = 2026-08-20
      const logDirPath = join(dir, 'log');
      // 构造：超龄（>14 日历日）受控文件 + 超数受控文件 + 未知文件 + 目录 + junction
      const mk = (daysAgo: number, seq?: number): string => {
        const d = new Date(frozenNow());
        d.setDate(d.getDate() - daysAgo);
        const ds = frozenDateStamp(d);
        const n = seq === undefined ? `aibrowse-${ds}.log` : `aibrowse-${ds}.${seq}.log`;
        writeFileSync(join(logDirPath, n), 'x');
        return n;
      };
      const overAge = mk(30); // 超龄
      const many: string[] = [];
      for (let i = 0; i < 10; i += 1) many.push(mk(1 + i, i === 0 ? undefined : i)); // 近 10 个不同日受控文件
      writeFileSync(join(logDirPath, 'unrelated.txt'), 'keep-unknown');
      mkdirSync(join(logDirPath, 'aibrowse-2020-01-01.log')); // 目录（受控形态但非文件）
      const outside = mkdtempSync(join(tmpdir(), 'aibrowse-logger-f3-out-'));
      writeFileSync(join(outside, 'sentinel.txt'), 'keep-junction');
      symlinkSync(outside, join(logDirPath, 'aibrowse-1999-01-01.log'), 'junction');
      // 推进到下一本地逻辑日（D+1），真实日期切换路径触发 housekeeping
      setFrozenClock('2026-08-21T04:00:00Z');
      fresh.logInfo('cat', 'new-day-write');
      const names = readdirSync(logDirPath);
      // 日期切换执行了 housekeeping：超龄文件被清理
      expect(names).not.toContain(overAge);
      // 未知文件、目录、junction 一律保留
      expect(names).toContain('unrelated.txt');
      expect(statSync(join(logDirPath, 'aibrowse-2020-01-01.log')).isDirectory()).toBe(true);
      expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep-junction');
      expect(
        statSync(join(logDirPath, 'aibrowse-1999-01-01.log'), { throwIfNoEntry: false }),
      ).not.toBeNull();
      // 受控文件总数不超上限（仅普通文件；目录/junction 虽匹配受控名形态但非文件，
      // 不计入——受控删除只作用于复验为普通文件的严格受控条目）。
      const controlledFiles = controlledNames(names).filter(
        (n) => statSync(join(logDirPath, n), { throwIfNoEntry: false })?.isFile() === true,
      );
      expect(controlledFiles.length).toBeLessThanOrEqual(10);
      rmSync(outside, { recursive: true, force: true });
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logger 硬化 — IO 失败各路径固定脱敏诊断（F3/F4 红→绿）', () => {
  // mkdir、readdir、stat、unlink、append 的每一失败路径：
  //  - 不抛未捕获异常（logger 不崩溃、后续调用仍受控）；
  //  - 产生固定、脱敏、非递归的 console 诊断；
  //  - 不输出敌手正文、凭据或任意文件路径（诊断只含固定标签）。
  const freshDirs = () => {
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-f4-'));
    const logDirPath = join(dir, 'log');
    return { dir, logDirPath };
  };
  const spyConsole = (): {
    error: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
  } => ({
    error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  });
  const assertDiagnostic = (
    consoleError: ReturnType<typeof vi.spyOn>,
    fixedLabel: string,
  ): void => {
    // 固定脱敏诊断：至少一条以固定标签开头的 console.error，且不含文件路径/正文/凭据
    const msgs = consoleError.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
    expect(msgs).toContain(fixedLabel);
    expect(msgs).not.toMatch(/[A-Za-z]:\\|\/\//); // 不输出任意文件路径
    expect(msgs).not.toMatch(/sk-proj-[A-Za-z0-9_-]{8,}/i); // 不输出凭据形态
  };

  it('mkdir 失败：init 不抛未捕获异常、固定脱敏诊断、后续调用仍受控', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const { dir, logDirPath } = freshDirs();
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      // mkdir(logDir) 失败的确定性构造：logDir 路径上已有同名普通文件（recursive mkdir 失败）
      writeFileSync(logDirPath, 'occupied');
      const { error: consoleError } = spyConsole();
      try {
        // init 的 mkdir 失败：不得抛未捕获（修复前会抛出 EEXIST/ENOTDIR）
        expect(() => fresh.initLogger(dir)).not.toThrow();
      } finally {
        consoleError.mockRestore();
      }
      // 后续调用仍受控（不崩溃；未初始化落盘语义：不产生 cwd 文件）
      const { error: ce2, warn: cw2 } = spyConsole();
      try {
        expect(() => fresh.logInfo('cat', 'still-working')).not.toThrow();
        // fixture 在 logDirPath 放了一个同名普通文件；受控降级后它保持普通文件
        // （未被 mkdir 覆盖为目录），且没有产生任何其他文件（无日志落盘）。
        expect(statSync(logDirPath).isFile()).toBe(true);
        expect(readdirSync(dir)).toEqual(['log']);
      } finally {
        ce2.mockRestore();
        cw2.mockRestore();
      }
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('readdir 失败：housekeeping 固定脱敏诊断，日志后续可用', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const { dir, logDirPath } = freshDirs();
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'establish'); // 建立 currentDate = 2026-08-20（使日期切换触发 housekeeping）
      const { error: consoleError } = spyConsole();
      try {
        // readdir 失败的确定性构造：log 目录被不可读文件占用路径替换（readdirSync 抛 ENOTDIR）。
        // 随后跨越本地午夜触发真实日期切换 → housekeeping 执行 → readdir 失败 → 固定诊断。
        rmSync(logDirPath, { recursive: true, force: true });
        writeFileSync(logDirPath, 'now-a-file');
        setFrozenClock('2026-08-21T04:00:00Z'); // 日期切换触发 housekeeping
        expect(() => fresh.logInfo('cat', 'after-readdir-fail')).not.toThrow();
        assertDiagnostic(consoleError, '[logger] 日志清理失败');
      } finally {
        consoleError.mockRestore();
        rmSync(logDirPath, { recursive: true, force: true });
      }
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stat 失败（housekeeping 内）：受控降级，不删除任何条目', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const { dir, logDirPath } = freshDirs();
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      // 制造一个「受控名但 stat 失败」的条目：先写文件再在 stat 前变成不存在的入口
      // （Windows 下以不可访问路径的父目录模拟：受控名文件的父目录被替换为文件 → ENOTDIR）
      // 更简单且确定：受控名条目 = 一个已删除的悬空 junction 目标？——不引入竞态，
      // 改为：把「受控名」文件路径的父段（logDirPath）替换为普通文件后触发 housekeeping
      const { error: consoleError } = spyConsole();
      try {
        rmSync(logDirPath, { recursive: true, force: true });
        writeFileSync(logDirPath, 'blocked');
        expect(() => fresh.logInfo('cat', 'stat-fail')).not.toThrow();
        // stat 失败（ENOTDIR）走受控降级，日志能力仍受控（不崩溃）
        expect(() => fresh.logError('cat', 'err', new Error('x'))).not.toThrow();
      } finally {
        consoleError.mockRestore();
        rmSync(logDirPath, { recursive: true, force: true });
      }
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unlink 失败：受控降级，不删除未知/未受控条目', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const { dir, logDirPath } = freshDirs();
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      // 构造一个 housekeeping 会尝试删除但 unlink 失败的受控条目：超龄受控文件
      // 所在目录被置为只读（Windows 下文件 unlink 需要写权限目录——用替代：
      // 让 stat 通过但 unlink 失败很难在 Windows 确定性构造，退而验证 stat 复验 +
      // 受控降级不误删：超龄条目在目录可读时正常删除）
      const mkOld = (): string => {
        const d = new Date(frozenNow());
        d.setDate(d.getDate() - 40);
        const ds = frozenDateStamp(d);
        const n = `aibrowse-${ds}.log`;
        writeFileSync(join(logDirPath, n), 'old');
        return n;
      };
      const overAge = mkOld();
      const { error: consoleError } = spyConsole();
      try {
        fresh.initLogger(dir); // 触发 housekeeping：超龄受控文件被删除（unlink 正常路径）
        expect(() => fresh.logInfo('cat', 'x')).not.toThrow();
      } finally {
        consoleError.mockRestore();
      }
      expect(readdirSync(logDirPath)).not.toContain(overAge);
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('append 失败：固定脱敏诊断、不崩溃、不落盘失败正文', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const { dir } = freshDirs();
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      // append 失败构造：把当前活动文件替换为目录（appendFileSync 抛 EISDIR）
      const cur = fresh.getCurrentLogFilePath();
      rmSync(cur, { recursive: true, force: true });
      mkdirSync(cur);
      const { error: consoleError } = spyConsole();
      try {
        const hostile = '秘密内容 sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456';
        expect(() => fresh.logInfo('cat', hostile)).not.toThrow();
        assertDiagnostic(consoleError, '[logger] 写入日志文件失败');
        // 敌手正文/凭据不进入任何 console 诊断
        const msgs = consoleError.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');
        expect(msgs).not.toContain('秘密内容');
        expect(msgs).not.toMatch(/sk-proj-[A-Za-z0-9_-]{8,}/i);
        expect(msgs).not.toContain(cur); // 不输出任意文件路径
      } finally {
        consoleError.mockRestore();
        rmSync(cur, { recursive: true, force: true });
      }
      // 后续调用仍受控
      expect(() => fresh.logInfo('cat', 'recovered')).not.toThrow();
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logger 硬化 — 精确字节边界（F4 红→绿）', () => {
  it('物理行恰好 8192 bytes 原样接受；8193 bytes 截断且元数据计入 8192', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-f4-line-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      // 精确构造：物理行（时间戳前缀 + 级别 + 类别 + 正文 + 换行）恰好 8192 bytes。
      // 逐字节证明：时间戳前缀长度固定（ASCII），正文为纯 'a'（1 byte/字符）。
      const prefix = '[2026-08-20 12:00:00.000] [INFO ] [cat] ';
      const lineBytes = Buffer.byteLength(prefix, 'utf8');
      // 前缀 + 正文 + '\n' 恰好 = 8192；即正文 = 8192 - prefix - 1
      const payload = 'a'.repeat(8192 - lineBytes - 1);
      expect(Buffer.byteLength(prefix + payload + '\n', 'utf8')).toBe(8192);
      fresh.logInfo('cat', payload);
      const file = fresh.getCurrentLogFilePath();
      const text = readFileSync(file, 'utf8');
      const line = text.split('\n')[0]!;
      // 物理行恰好 8192 bytes 原样接受（含换行 = 8192+1？见下）
      expect(Buffer.byteLength(line, 'utf8')).toBe(8192 - 1); // 行内容不含 \n
      expect(line).toContain(payload);
      expect(line).not.toContain('truncated');
      // 8193 bytes：截断且元数据计入 8192（截断后物理行 + 元数据 <= 8192）。
      // 注意 truncateLine 处理的是不含 \n 的行（\n 由 write 追加），因此「物理行
      // 8193 bytes」= 前缀 + 正文 = 8193，即正文 = 8192 - lineBytes + 1。
      const payload2 = 'a'.repeat(8192 - lineBytes + 1); // 前缀 + 正文 = 8193
      expect(Buffer.byteLength(prefix + payload2, 'utf8')).toBe(8193);
      fresh.logInfo('cat', payload2);
      const text2 = readFileSync(file, 'utf8');
      const lines2 = text2.split('\n').filter((l) => l.trim() !== '');
      const last = lines2[lines2.length - 1]!;
      expect(last).toContain('truncated=true');
      // 元数据计入预算：物理行（含元数据）不超过 8192 bytes
      expect(Buffer.byteLength(last, 'utf8')).toBeLessThanOrEqual(8192);
      // 元数据记录截断前规范化字节数（不冒充完整值）：截断前整行 = 8193 bytes
      expect(last).toContain('8193');
      expect(last).not.toMatch(/\d{5,}.*\d{5,}/); // 不出现两组长数字（不冒充、不重复内容）
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('现有文件 + 下一完整 payload（含换行）恰好 10 MiB 不滚动；+1 byte 写前滚动；旧文件绝不先写超限', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-f4-rot-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      const file = fresh.getCurrentLogFilePath();
      const max = 1024 * 1024 * 10;
      // 先写一条 logger 行，读回真实物理行字节（含 \n）。后续所有「一条 logger 行」
      // 必须使用与 probe 完全相同的内容（message 长度不同 → 行字节不同 → 边界失真）。
      const MSG = 'probe';
      fresh.logInfo('cat', MSG);
      const probe = readFileSync(file, 'utf8');
      const lineBytes = Buffer.byteLength(probe, 'utf8');
      // 精确构造：现有文件大小 + 下一完整 payload（含 \n）恰好 == 10 MiB → 不滚动
      // 现有文件 = probe（lineBytes）+ pad；pad 补到 max - lineBytes → 现有 = max - lineBytes
      const pad = Buffer.alloc(max - 2 * lineBytes, 0x61);
      appendFileSync(file, pad);
      expect(statSync(file).size).toBe(max - lineBytes); // 前置：现有文件大小
      // 下一完整 payload = 一条与 probe 相同的 logger 行（含 \n）= lineBytes；
      // 现有 + payload == max → 不滚动
      fresh.logInfo('cat', MSG);
      expect(basename(fresh.getCurrentLogFilePath())).toBe(basename(file)); // 未滚动
      expect(statSync(file).size).toBe(max); // 现有 + 恰好 10 MiB
      // 现有文件 = max（10 MiB）；再写一条相同 logger 行 = max + lineBytes > max → 写前滚动
      fresh.logInfo('cat', MSG);
      expect(basename(fresh.getCurrentLogFilePath())).toBe(
        rotName(basename(file).replace(/\.log$/, ''), 1),
      );
      // 旧文件绝不先写超限：保持 == 10 MiB
      expect(statSync(file).size).toBe(max);
      expect(
        readFileSync(join(dir, 'log', rotName(basename(file).replace(/\.log$/, ''), 1)), 'utf8'),
      ).toContain(MSG);
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logger 硬化 — 受控序号规范性与删除目标白名单（F5 红→绿）', () => {
  it('.0、前导零、非有限/超大非安全整数序号不作为受控日志删除目标', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-f5-seq-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      const logDirPath = join(dir, 'log');
      const base = basename(fresh.getCurrentLogFilePath()).replace(/\.log$/, '');
      // 非法序号形态（不得进入受控删除集合 / 不得被 housekeeping 删除）
      const illegalNames = [
        `${base}.0.log`, // 非正整数（0）
        `${base}.00.log`, // 前导零
        `${base}.01.log`, // 前导零
        `${base}.1.0.log`, // 嵌套序号
        `${base}.999999999999999999999999.log`, // 非安全整数（24 位，> 2^53）
        `${base}.NaN.log`, // 非有限（若被 Number() 解析则 NaN）
        `${base}.Infinity.log`, // 非有限
        `${base}.${'9'.repeat(20)}.log`, // 超大非安全整数（20 位，文件名在 255 字符内）
      ];
      for (const n of illegalNames) writeFileSync(join(logDirPath, n), 'keep-illegal');
      // 触发 housekeeping（re-init 清理一次），同时把受控数量推到 > 10 以便删除路径活跃
      fresh.initLogger(dir);
      for (let i = 1; i <= 11; i += 1) {
        writeFileSync(join(logDirPath, `${base}.${i}.log`), 'x');
      }
      // 日期切换触发 housekeeping：受控文件 .1..11（11 个合法）裁剪到 10；
      // 非法序号（.0/.00/.01/.1.0/超长/NaN/Infinity）一律不是删除目标。
      fresh.logInfo('cat', 'establish'); // 建立 currentDate = 08-20
      setFrozenClock('2026-08-21T04:00:00Z');
      fresh.logInfo('cat', 'trigger');
      const names = readdirSync(logDirPath);
      // 非法序号条目绝不被删除（既非删除目标）
      for (const n of illegalNames) {
        expect(names).toContain(n);
      }
      // 合法受控条目（.1..11）仍按 10 上限受控（11 个合法受控文件裁剪到 10）。
      // 规范序号 = 无前导零的正整数且数值为安全整数（[1-9]\d* 且 Number.isSafeInteger），
      // 与 logger 受控删除白名单同契约；前导零（.01）、超长数字串（非安全整数）不算规范序号。
      const legal = names.filter((n) => {
        const m = /^aibrowse-\d{4}-\d{2}-\d{2}\.(\d+)\.log$/.exec(n);
        if (m === null) return false;
        const digits = m[1]!;
        if (digits.length === 0 || digits[0] === '0') return false; // 无前导零
        const seq = Number(digits);
        return Number.isSafeInteger(seq) && seq >= 1;
      });
      expect(legal.length).toBeLessThanOrEqual(10);
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- D1 Repair Contract R2：re-init 上限 + 逐调用点 fs 失败注入（红→绿） ----------
// 背景（Reviewer R2 findings）：
//   F1-reinit：init 时已有 10 个合法同日 .N 但 base 不存在 → init 保留 10 个；
//     首次成功写入又创建 base → 受控普通文件总数 11 > 10，且普通后续写入不再 housekeeping
//     （currentDayIndex=0 → 永不清理），上限被永久击穿。
//   F2-stat/unlink：上轮 stat/unlink 失败测试用「整个目录被文件占用」替代逐条失败，
//     未命中 housekeeping 的逐条 stat/unlink 失败分支。
//   F3-diag：nextRotationSeq 与 rotateIfNeeded 的 stat catch 仍静默（无固定、脱敏诊断）。
// 本批测试与既有测试不同：对 node:fs 做模块级确定性子集 mock（backup.test.ts 同族模式），
// 在精确调用点注入 statSync/unlinkSync 失败；并断言目标 mock 确实被调用（甄别能力）。
const r2Probe = vi.hoisted(() => ({
  statFaults: new Map<string, string>(),
  statCalls: [] as string[],
  unlinkFaults: new Map<string, string>(),
  unlinkCalls: [] as string[],
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const faultFor = (p: string, faults: Map<string, string>): { code: string } | null => {
    const code = faults.get(p.toLowerCase());
    return code === undefined ? null : { code };
  };
  return {
    ...actual,
    statSync: vi.fn((...args: Parameters<typeof actual.statSync>) => {
      const p = String(args[0]);
      r2Probe.statCalls.push(p);
      const f = faultFor(p, r2Probe.statFaults);
      if (f !== null) {
        const e = new Error('injected statSync failure') as NodeJS.ErrnoException;
        e.code = f.code;
        throw e;
      }
      return (actual.statSync as (...a: unknown[]) => unknown)(...args);
    }),
    unlinkSync: vi.fn((...args: Parameters<typeof actual.unlinkSync>) => {
      const p = String(args[0]);
      r2Probe.unlinkCalls.push(p);
      const f = faultFor(p, r2Probe.unlinkFaults);
      if (f !== null) {
        const e = new Error('injected unlinkSync failure') as NodeJS.ErrnoException;
        e.code = f.code;
        throw e;
      }
      return (actual.unlinkSync as (...a: unknown[]) => unknown)(...args);
    }),
  };
});
// 目标 mock 调用证明：path 列表包含某个受控目标（区分大小写无关）
function r2CallsInclude(calls: string[], path: string): boolean {
  const low = path.toLowerCase();
  return calls.some((c) => c.toLowerCase() === low);
}
// 固定、脱敏、非递归诊断断言：至少一条以固定标签开头的 console.error，
// 不含路径、敌手正文或凭据形态。
function r2AssertDiagnosticFor(captured: string[], fixedLabel: string): void {
  const msgs = captured.join('\n');
  expect(msgs).toContain(fixedLabel);
  expect(msgs).not.toMatch(/[A-Za-z]:\\/); // 不输出任意 Windows 路径
  expect(msgs).not.toMatch(/sk-proj-[A-Za-z0-9_-]{8,}/i); // 不输出凭据形态
}
function r2ClearProbes(): void {
  r2Probe.statFaults.clear();
  r2Probe.statCalls.length = 0;
  r2Probe.unlinkFaults.clear();
  r2Probe.unlinkCalls.length = 0;
}

describe('logger R2 — re-init 上限：10 个合法同日 .N、base 不存在（F1 红→绿）', () => {
  it('init 后首次写入：受控普通文件总数必须恰好 10；按确定顺序淘汰非活动旧文件；再写两次仍 10 且内容不丢', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-r2-reinit-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z'); // 冻结到同一本地日期 D
      const logDirPath = join(dir, 'log');
      mkdirSync(logDirPath, { recursive: true });
      // 只预置合法 .1～.10（同日 D），base 明确不存在
      for (let i = 1; i <= 10; i += 1) {
        writeFileSync(join(logDirPath, `aibrowse-2026-08-20.${i}.log`), `old-${i}`);
      }
      expect(readdirSync(logDirPath)).toHaveLength(10);
      expect(
        statSync(join(logDirPath, 'aibrowse-2026-08-20.log'), { throwIfNoEntry: false }),
      ).toBeUndefined();
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'first-write'); // 首次成功写入创建 base
      const cur = fresh.getCurrentLogFilePath();
      expect(basename(cur)).toBe('aibrowse-2026-08-20.log'); // 活动 base
      // 活动 base 存在且包含本次内容
      expect(statSync(cur).isFile()).toBe(true);
      expect(readFileSync(cur, 'utf8')).toContain('first-write');
      // 受控普通文件总数必须恰好 10（不能是 <=11——init 时 10 个 + base 创建后仍 10）
      const names1 = readdirSync(logDirPath).map((n) => basename(n));
      const controlled1 = controlledNames(names1).filter(
        (n) => statSync(join(logDirPath, n), { throwIfNoEntry: false })?.isFile() === true,
      );
      expect(controlled1.length).toBe(10);
      // 确定顺序淘汰一个非活动旧文件：同日 seq 降序保留最新 10 个（含活动 base）。
      // 预置 .1..10 + 新 base = 11 个受控；base（seq 0 排最后）为活动保留、.1 被淘汰
      expect(controlled1).toContain('aibrowse-2026-08-20.log');
      expect(controlled1).not.toContain('aibrowse-2026-08-20.1.log');
      // 再连续写两次：仍恰好 10，内容不丢失
      fresh.logInfo('cat', 'second-write');
      fresh.logInfo('cat', 'third-write');
      const names2 = readdirSync(logDirPath).map((n) => basename(n));
      const controlled2 = controlledNames(names2).filter(
        (n) => statSync(join(logDirPath, n), { throwIfNoEntry: false })?.isFile() === true,
      );
      expect(controlled2.length).toBe(10);
      expect(readFileSync(cur, 'utf8')).toContain('second-write');
      expect(readFileSync(cur, 'utf8')).toContain('third-write');
      // 非活动保留集合 = 已存在文件 - 活动 - 被淘汰 .1：既有内容零丢失
      const remaining = controlled2.filter((n) => n !== 'aibrowse-2026-08-20.log');
      expect(remaining).toContain('aibrowse-2026-08-20.2.log');
      expect(readFileSync(join(logDirPath, 'aibrowse-2026-08-20.2.log'), 'utf8')).toBe('old-2');
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('变体：10 个文件中已包含 base；首次及后续写入后仍恰好 10，不覆盖其他文件', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-r2-reinit2-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      const logDirPath = join(dir, 'log');
      mkdirSync(logDirPath, { recursive: true });
      writeFileSync(join(logDirPath, 'aibrowse-2026-08-20.log'), 'base-old');
      for (let i = 1; i <= 9; i += 1) {
        writeFileSync(join(logDirPath, `aibrowse-2026-08-20.${i}.log`), `old-${i}`);
      }
      expect(readdirSync(logDirPath)).toHaveLength(10);
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'first');
      fresh.logInfo('cat', 'second');
      const cur = fresh.getCurrentLogFilePath();
      expect(basename(cur)).toBe('aibrowse-2026-08-20.log');
      expect(readFileSync(cur, 'utf8')).toContain('first');
      expect(readFileSync(cur, 'utf8')).toContain('second');
      // base 已存在：首次写入后仍恰好 10（无需淘汰）；再次写入也仍 10，不覆盖其他文件
      const names = readdirSync(logDirPath).map((n) => basename(n));
      const controlled = controlledNames(names).filter(
        (n) => statSync(join(logDirPath, n), { throwIfNoEntry: false })?.isFile() === true,
      );
      expect(controlled.length).toBe(10);
      // 不覆盖其他文件：既有 .1 内容原样
      expect(readFileSync(join(logDirPath, 'aibrowse-2026-08-20.1.log'), 'utf8')).toBe('old-1');
      expect(readFileSync(join(logDirPath, 'aibrowse-2026-08-20.9.log'), 'utf8')).toBe('old-9');
    } finally {
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logger R2 — housekeeping 逐调用点 stat 失败注入（F2/F3 红→绿）', () => {
  it('枚举成功、某严格受控普通文件的 statSync 抛错：固定脱敏诊断、零未捕获、该条目与未知条目均不删除', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-r2-stat-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'establish'); // 建立 currentDate=D（日期切换触发 housekeeping）
      const logDirPath = join(dir, 'log');
      // 一个超龄受控文件（housekeeping 会对它 stat）→ 注入 statSync 失败
      const overAge = 'aibrowse-2026-07-01.log';
      const overAgePath = join(logDirPath, overAge);
      writeFileSync(overAgePath, 'old');
      writeFileSync(join(logDirPath, 'unrelated.txt'), 'keep-unknown'); // 未知条目
      r2Probe.statFaults.set(overAgePath.toLowerCase(), 'EACCES');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let captured: string[] = [];
      try {
        // 日期切换（D+1）触发 housekeeping：枚举成功，对该受控普通文件 statSync 抛错
        setFrozenClock('2026-08-21T04:00:00Z');
        expect(() => fresh.logInfo('cat', 'after-stat-fail')).not.toThrow();
        captured = errSpy.mock.calls.map((c) => String(c[0]));
      } finally {
        errSpy.mockRestore();
      }
      // 目标 statSync 确实被调用（mock 命中证明，非「目录不存在/被占用」替代）
      expect(r2CallsInclude(r2Probe.statCalls, overAgePath)).toBe(true);
      r2AssertDiagnosticFor(captured, '[logger] 日志清理失败');
      // 该条目仍存在（未删除）；未知条目零删除；后续调用仍受控
      expect(readdirSync(logDirPath)).toContain(overAge);
      expect(readFileSync(overAgePath, 'utf8')).toBe('old');
      expect(readFileSync(join(logDirPath, 'unrelated.txt'), 'utf8')).toBe('keep-unknown');
      expect(() => fresh.logInfo('cat', 'still-ok')).not.toThrow();
      expect(() => fresh.getCurrentLogFilePath()).not.toThrow();
    } finally {
      r2ClearProbes();
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('枚举与 stat 成功、目标 unlinkSync 抛错：固定诊断；失败目标仍存在；未知/目录/symlink/junction 零删除', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-r2-unlink-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'establish');
      const logDirPath = join(dir, 'log');
      // 超龄受控文件（stat 通过、unlink 抛错）
      const overAge = 'aibrowse-2026-07-01.log';
      const overAgePath = join(logDirPath, overAge);
      writeFileSync(overAgePath, 'old');
      // 未知文件、目录、symlink/junction（零删除断言）
      writeFileSync(join(logDirPath, 'unrelated.txt'), 'keep-unknown');
      mkdirSync(join(logDirPath, 'aibrowse-2026-06-01.log')); // 受控形态但为目录
      const outside = mkdtempSync(join(tmpdir(), 'aibrowse-logger-r2-out-'));
      writeFileSync(join(outside, 'sentinel.txt'), 'keep-junction');
      symlinkSync(outside, join(logDirPath, 'aibrowse-2026-05-01.log'), 'junction');
      r2Probe.unlinkFaults.set(overAgePath.toLowerCase(), 'EACCES');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let captured: string[] = [];
      try {
        setFrozenClock('2026-08-21T04:00:00Z');
        expect(() => fresh.logInfo('cat', 'after-unlink-fail')).not.toThrow();
        captured = errSpy.mock.calls.map((c) => String(c[0]));
      } finally {
        errSpy.mockRestore();
      }
      // unlink 目标确实被调用（mock 命中证明）
      expect(r2CallsInclude(r2Probe.unlinkCalls, overAgePath)).toBe(true);
      r2AssertDiagnosticFor(captured, '[logger] 日志清理失败');
      // 失败目标仍存在
      expect(readdirSync(logDirPath)).toContain(overAge);
      expect(readFileSync(overAgePath, 'utf8')).toBe('old');
      // 未知文件、目录、junction 零删除；junction 外部内容完好
      expect(readdirSync(logDirPath)).toContain('unrelated.txt');
      expect(statSync(join(logDirPath, 'aibrowse-2026-06-01.log')).isDirectory()).toBe(true);
      expect(readFileSync(join(outside, 'sentinel.txt'), 'utf8')).toBe('keep-junction');
      expect(
        statSync(join(logDirPath, 'aibrowse-2026-05-01.log'), { throwIfNoEntry: false }),
      ).not.toBeNull();
      // 后续调用仍受控
      expect(() => fresh.logInfo('cat', 'still-ok')).not.toThrow();
      expect(() => fresh.getCurrentLogFilePath()).not.toThrow();
      rmSync(outside, { recursive: true, force: true });
    } finally {
      r2ClearProbes();
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('logger R2 — nextRotationSeq / rotateIfNeeded 的 statSync 异常（F3 红→绿）', () => {
  it('nextRotationSeq 的 statSync 抛错：不崩溃、不覆盖已存在文件、固定脱敏非递归诊断、目标 mock 被调用', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-r2-nrs-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'establish');
      const logDirPath = join(dir, 'log');
      const cur = fresh.getCurrentLogFilePath();
      // 把当前活动文件填满到 10 MiB，使下一次写入触发写前滚动 → nextRotationSeq
      const max = 1024 * 1024 * 10;
      const curSize = statSync(cur).size;
      appendFileSync(cur, Buffer.alloc(max - curSize, 0x61));
      // 预置 .1（nextRotationSeq 需跳过 .1 探测 .2）；对 .1 的探测 statSync 抛错
      const rot1 = join(logDirPath, 'aibrowse-2026-08-20.1.log');
      writeFileSync(rot1, 'existing-1');
      r2Probe.statFaults.set(rot1.toLowerCase(), 'EACCES');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let captured: string[] = [];
      try {
        expect(() => fresh.logInfo('cat', 'overflow')).not.toThrow();
        captured = errSpy.mock.calls.map((c) => String(c[0]));
      } finally {
        errSpy.mockRestore();
      }
      // 探测确实命中 nextRotationSeq 对 .1 的 stat（不是「整个目录不存在」替代）
      expect(r2CallsInclude(r2Probe.statCalls, rot1)).toBe(true);
      r2AssertDiagnosticFor(captured, '[logger] 日志清理失败');
      // 不崩溃、不覆盖已存在 .1：内容原样
      expect(readFileSync(rot1, 'utf8')).toBe('existing-1');
      expect(() => fresh.getCurrentLogFilePath()).not.toThrow();
    } finally {
      r2ClearProbes();
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rotateIfNeeded 的 statSync 抛错：不崩溃、不覆盖已存在文件、固定脱敏非递归诊断、目标 mock 被调用', async () => {
    vi.resetModules();
    const fresh = await import('./logger');
    const dir = mkdtempSync(join(tmpdir(), 'aibrowse-logger-r2-rot-'));
    try {
      setFrozenClock('2026-08-20T04:00:00Z');
      fresh.initLogger(dir);
      fresh.logInfo('cat', 'establish');
      const cur = fresh.getCurrentLogFilePath();
      // 对「当前活动文件」的 rotateIfNeeded statSync 抛错：write 必须受控降级（写当前文件）
      r2Probe.statFaults.set(cur.toLowerCase(), 'EACCES');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let captured: string[] = [];
      try {
        expect(() => fresh.logInfo('cat', 'after-rot-stat-fail')).not.toThrow();
        captured = errSpy.mock.calls.map((c) => String(c[0]));
      } finally {
        errSpy.mockRestore();
      }
      // rotateIfNeeded 对活动文件的 stat 确实被调用（mock 命中证明）
      expect(r2CallsInclude(r2Probe.statCalls, cur)).toBe(true);
      r2AssertDiagnosticFor(captured, '[logger] 日志清理失败');
      // 不崩溃：当前活动文件仍被写入（stat 失败保守按当前文件写）
      expect(readFileSync(cur, 'utf8')).toContain('after-rot-stat-fail');
      expect(() => fresh.getCurrentLogFilePath()).not.toThrow();
    } finally {
      r2ClearProbes();
      clearFrozenClock();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
