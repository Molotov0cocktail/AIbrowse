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

function write(level: LogLevel, category: string, message: string, error?: unknown): void {
  ensureLogFile();
  let text = `[${timeStamp(new Date())}] [${level.padEnd(5)}] [${category}] ${message}`;
  if (error !== undefined) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error);
    text += `\n  ${detail.replace(/\n/g, '\n  ')}`;
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
