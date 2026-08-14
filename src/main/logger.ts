// Main-process logger: console + daily-rotated files under <baseDir>/log/.
// Rule source: PROJECT_RULES §3.11 (详尽日志) — log/ is gitignored, never committed.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

let logDir = '';
let currentDate = '';
let currentLogFile = '';

export function initLogger(baseDir: string): void {
  logDir = join(baseDir, 'log');
  mkdirSync(logDir, { recursive: true });
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

function dateStamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function timeStamp(d: Date): string {
  return `${dateStamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// Rotate to a new file whenever the day changes.
function ensureLogFile(): void {
  const today = dateStamp(new Date());
  if (today !== currentDate) {
    currentDate = today;
    currentLogFile = join(logDir, `aibrowse-${today}.log`);
  }
}

// Basic redaction of credential-like tokens before anything reaches disk or console.
// S1 extension (design §5.1 redaction line): sk- shaped API keys (OpenAI/Anthropic forms)
// are replaced wholesale, and apiKey/api-key/api_key key-value pairs are covered.
export function sanitize(text: string): string {
  return text
    .replace(
      /(token|secret|password|authorization|cookie|api[-_]?key)(["']?\s*[:=]\s*)\S+/gi,
      '$1$2***',
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gi, 'sk-***');
}

// ANSI 转义序列（CSI 着色/光标 + OSC 标题/超链接形态）整体剔除。
// 除 \t 外的 C0 控制字符、DEL、NEL、双向文本控制符、零宽字符、BOM 与行/段分隔符
// 一律剔除；CR/LF 由 normalizeLogMessage 折叠为空格（日志条目恒为单行）。
function isControlChar(code: number): boolean {
  return (
    (code >= 0x00 && code <= 0x08) ||
    code === 0x0b ||
    code === 0x0c ||
    (code >= 0x0e && code <= 0x1f) ||
    code === 0x7f ||
    code === 0x85 ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200d) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

// 扫描剔除：ANSI 转义序列（CSI：ESC [ … 最终字节 0x40–0x7E；OSC：ESC ] … BEL 或 ESC \）
// 与全部控制字符；保留 \t、CR/LF（CR/LF 由 normalizeLogMessage 折叠）。
function scrubControlChars(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === 0x1b) {
      const next = text.charCodeAt(i + 1);
      if (next === 0x5b) {
        i += 2;
        while (i < text.length) {
          const b = text.charCodeAt(i);
          i += 1;
          if (b >= 0x40 && b <= 0x7e) break;
        }
      } else if (next === 0x5d) {
        i += 2;
        while (i < text.length) {
          const b = text.charCodeAt(i);
          i += 1;
          if (b === 0x07 || (b === 0x1b && text.charCodeAt(i) === 0x5c)) break;
        }
      } else if (next === 0x5c) {
        // ST（ESC \）单独出现（无 OSC 起始）：双字节整体剔除
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (isControlChar(code)) {
      i += 1;
      continue;
    }
    out += text[i]!;
    i += 1;
  }
  return out;
}

// A7 红队（RT-02/RT-07 日志伪造审计，红→绿）：模型可控字符串（open/navigate 的 URL
// 全量入审计——上限 2048、search_web 查询串全量——上限 500、确认摘要等）可携带
// CR/LF/ANSI 转义/双向文本控制符。日志条目必须恒为单行纯文本：CR/LF 折叠为空格
// （条目一行一条，敌手内容不能伪造新的 [INFO] [audit] 条目行）、ANSI 转义整体剔除、
// 其余控制字符剔除（终端走私/bidi 伪装）。仅作用于 message 段；错误详情块保留其
// 多行结构（程序文本），但同样经 scrubControlChars 剔除控制字符。
export function normalizeLogMessage(text: string): string {
  return scrubControlChars(text.replace(/\r\n|\r|\n/g, ' '));
}

// 错误详情块：剔除 ANSI/控制字符，但保留换行（堆栈多行结构；每行已由 write 缩进，
// 敌手换行只会产生带缩进的子行，无法成为条目前缀）。
function write(level: LogLevel, category: string, message: string, error?: unknown): void {
  ensureLogFile();
  let text = `[${timeStamp(new Date())}] [${level.padEnd(5)}] [${category}] ${normalizeLogMessage(message)}`;
  if (error !== undefined) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error);
    text += `\n  ${scrubControlChars(detail).replace(/\n/g, '\n  ')}`;
  }

  const safe = sanitize(text);
  try {
    appendFileSync(currentLogFile, `${safe}\n`);
  } catch (e) {
    // Logging must never crash the app; fall back to console only.
    console.error('[logger] 写入日志文件失败:', e);
  }
  if (level === 'ERROR') console.error(safe);
  else if (level === 'WARN') console.warn(safe);
  else console.log(safe);
}

// 冒烟断言用：当前日志文件路径（appendFileSync 同步写盘，读取即最新；仅测试/验证场景使用）。
// 冒烟以「文件偏移切片」限定本次运行的日志区间，避免读到同日更早运行的内容。
export function getCurrentLogFilePath(): string {
  ensureLogFile();
  return currentLogFile;
}

export const logDebug = (category: string, message: string): void =>
  write('DEBUG', category, message);
export const logInfo = (category: string, message: string): void =>
  write('INFO', category, message);
export const logWarn = (category: string, message: string, error?: unknown): void =>
  write('WARN', category, message, error);
export const logError = (category: string, message: string, error?: unknown): void =>
  write('ERROR', category, message, error);

export function logEnvironment(): void {
  const v = process.versions;
  logInfo(
    'env',
    `Electron ${v.electron ?? '?'} / Chromium ${v.chrome ?? '?'} / Node ${v.node ?? '?'} ` +
      `/ ${process.platform}-${process.arch} / 工作目录 ${process.cwd()}`,
  );
}
