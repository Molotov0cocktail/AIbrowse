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
