// Main-process logger: console + daily-rotated files under <baseDir>/log/.
// Rule source: PROJECT_RULES §3.11 (详尽日志) — log/ is gitignored, never committed.
// D1 hardening: 单行 8 KiB、写前 10 MiB 滚动、10 文件/14 天保留、受控文件名严格匹配、
// 清理/写失败受控降级 console（绝不递归 logger）。Contract: doc/stage6/detailed-design.md
// §2/§13/§14、threat-model §3.8/WRT-18。
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAX_LOG_AGE_DAYS,
  MAX_LOG_FILE_BYTES,
  MAX_LOG_FILES,
  MAX_LOG_LINE_BYTES,
} from '../shared/types/watch';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

let logDir = '';
let currentDate = '';
let currentLogFile = '';
let currentDayIndex = 0;

// 受控日志文件名（detailed-design §13：只允许 aibrowse-YYYY-MM-DD.log 与
// aibrowse-YYYY-MM-DD.N.log，日期必须真实合法、N 必须正整数）。
// 未知文件、畸形日期、目录、junction/symlink 或任何其他条目绝不删除（fail-closed 默认不删）。
const CONTROLLED_LOG_NAME = /^aibrowse-(\d{4})-(\d{2})-(\d{2})(?:\.(\d+))?\.log$/;

export function initLogger(baseDir: string): void {
  // 决议 #153(4)：重入重置——currentDate/currentLogFile 清空后按新 baseDir
  // 重新轮转（不得继续写旧目录）
  const nextDir = join(baseDir, 'log');
  try {
    mkdirSync(nextDir, { recursive: true });
  } catch {
    // mkdir 失败（EEXIST 路径被文件占用/ENOTDIR/权限等）：受控降级——不落盘，
    // 后续仅脱敏 console（finding 3）；固定、脱敏、非递归诊断（不输出任意文件路径）。
    console.error('[logger] 日志目录不可用');
    logDir = '';
    currentDate = '';
    currentLogFile = '';
    currentDayIndex = 0;
    return;
  }
  logDir = nextDir;
  currentDate = '';
  currentLogFile = '';
  currentDayIndex = 0;
  // D1：init 时执行一次有界 housekeeping（清理超龄/超数受控文件；失败受控降级）
  housekeeping();
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

// D1：受控文件基础名（无序号）与同日滚动序号解析。只接受真实合法日历日期。
// 受控滚动序号必须是规范正整数：无前导零（0、00、01 等一律拒绝）、数值为安全整数
// （超大/超长数字串拒绝）、非有限（NaN/Infinity 形态）拒绝。`.0`/前导零/非规范序号
// 不得进入受控删除集合（finding 5：fail-closed 默认不删）。
// 用 String.match 而非 RegExp.exec：与既有 snapshot-script/parse-markdown 同族（正则非 SQL），
// 且避免被 SRT-12 静态 SQL 扫描器误判为 SQL 执行点。
function parseControlledLogName(name: string): { date: string; day: number; seq: number } | null {
  const m = name.match(CONTROLLED_LOG_NAME);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // 真实合法日历日期校验（Date.UTC 自纠错：非法日期会滚动到次月）
  const date = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  if (m[4] !== undefined) {
    // 规范正整数序号：无前导零、数值为安全整数
    if (m[4].length === 0 || m[4][0] === '0') return null;
    const seq = Number(m[4]);
    if (!Number.isSafeInteger(seq) || seq < 1) return null;
    return {
      date: `${m[1]}-${m[2]}-${m[3]}`,
      day: Date.UTC(y, mo - 1, d),
      seq,
    };
  }
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    day: Date.UTC(y, mo - 1, d),
    seq: 0,
  };
}

// D1：有界 housekeeping。只删除「严格匹配受控名、真实合法日期、文件类型（非常规文件/目录/
// junction/symlink 一律跳过）」且满足 14 天/10 文件超限的条目。当前活动日志文件（本次
// 会话正在写入的文件）永不被 housekeeping 删除（finding 1：同日滚动到 .10 时不得把刚写入
// 的最高序号活动文件当超数裁剪）。任何 readdir/stat/unlink 失败都只走固定、脱敏、非递归的
// console 降级（finding 3/4），绝不递归调用 logger，绝不删除未证明属于本 logger 的条目。
function housekeeping(): void {
  if (logDir === '') return;
  const now = new Date();
  // 活动文件 basename（currentLogFile 是 join 出的绝对/相对路径，取最后一段）。
  const active = currentLogFile === '' ? null : currentLogFile.split(/[\\/]/).pop()!;
  let entries;
  try {
    entries = readdirSync(logDir, { withFileTypes: true });
  } catch {
    // readdir 失败（如 logDir 被不可读入口占用）：固定、脱敏、非递归诊断
    console.error('[logger] 日志清理失败: 目录不可读');
    return;
  }
  const controlled: Array<{ name: string; seq: number; day: number }> = [];
  for (const e of entries) {
    if (!e.isFile()) continue; // 目录/junction/symlink/其他一律跳过
    const p = parseControlledLogName(e.name);
    if (p === null) continue;
    controlled.push({ name: e.name, seq: p.seq, day: p.day });
  }
  // 年龄过滤：按「本地日历日差」计算，age == 14 个日历日恰好允许保留、> 14 删除。
  // （detailed-design §2：最多保留 14 个本地日历日；非原始毫秒差。）
  const byAge = controlled.filter((c) => {
    // c.day 为该受控文件日期 UTC 午夜；先转换回本地日历日（同一时区同一日期基准），
    // 再与「本地今天」做整日差，避免 UTC 午夜与本地午夜混算引入 ±1 天误差。
    const logLocal = new Date(c.day + now.getTimezoneOffset() * 60_000);
    const d0 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const msPerDay = 86_400_000;
    const dayDiff = Math.round((d0.getTime() - logLocal.getTime()) / msPerDay);
    return dayDiff <= MAX_LOG_AGE_DAYS;
  });
  // 数量过滤：按（day 降序、同日 seq 降序）确定排序——最新日优先、同日最新滚动优先
  // （base seq=0 排最后），保留最新 10 个。活动文件（本次会话正在写入的 currentLogFile）
  // 无条件保留且**计入 10 文件上限**：先剔除 active，非活动只保留 MAX_LOG_FILES - activeCount
  // 个名额，再把 active 加回，保证总数 <= MAX_LOG_FILES 且刚滚动出的活动文件不被删除。
  const activeSet = active === null ? new Set<string>() : new Set([active]);
  byAge.sort((a, b) => (a.day === b.day ? b.seq - a.seq : b.day - a.day));
  const budget = MAX_LOG_FILES - activeSet.size;
  const keep = new Set(
    byAge
      .filter((c) => !activeSet.has(c.name))
      .slice(0, budget)
      .map((c) => c.name),
  );
  for (const c of byAge) {
    if (activeSet.has(c.name)) keep.add(c.name);
  }
  // 删除：受控名 + 超龄或超数 + 普通文件。unlink 前用 stat 复验非常规（防 TOCTOU）。
  for (const c of controlled) {
    if (keep.has(c.name)) continue;
    try {
      const st = statSync(join(logDir, c.name), { throwIfNoEntry: false });
      if (st === undefined || !st.isFile()) continue;
      unlinkSync(join(logDir, c.name));
    } catch {
      // stat/unlink 失败：受控降级，固定脱敏诊断（不输出路径）
      console.error('[logger] 日志清理失败: 删除受限条目');
    }
  }
}

// 选择下一个同日滚动序号：不覆盖已有序号文件（跳过已存在 .N）。
function nextRotationSeq(baseDate: string): number {
  const base = `aibrowse-${baseDate}`;
  let seq = 1;
  for (;;) {
    const candidate = join(logDir, `${base}.${seq}.log`);
    try {
      const st = statSync(candidate, { throwIfNoEntry: false });
      if (st === undefined || !st.isFile()) return seq;
    } catch {
      return seq;
    }
    seq += 1;
  }
}

// Rotate：日期切换 → 无序号 base 文件；同日滚动 → 单调递增 .N（不覆盖）。
// 真实日期切换（today !== currentDate 且 currentDate 非空，即已有上一日活动文件）后
// 执行一次有界 housekeeping（finding 3：超龄/超数受控文件在日期切换时被清理）。
function ensureLogFile(): void {
  const today = dateStamp(new Date());
  if (today !== currentDate) {
    const switched = currentDate !== ''; // 非首次：存在上一日的活动文件
    currentDate = today;
    currentDayIndex = 0;
    currentLogFile = join(logDir, `aibrowse-${today}.log`);
    if (switched) housekeeping();
  }
}

// 写前滚动：现有文件大小 + 本次完整 UTF-8 写入（含换行）> 10 MiB 时滚动到 .N。
// 总和 <= 10 MiB 仍写当前文件。绝不先写超限再滚动。
function rotateIfNeeded(writeBytes: number): void {
  if (currentLogFile === '') return;
  try {
    const st = statSync(currentLogFile, { throwIfNoEntry: false });
    const currentSize = st === undefined ? 0 : st.size;
    if (currentSize + writeBytes > MAX_LOG_FILE_BYTES) {
      currentLogFile = join(logDir, `aibrowse-${currentDate}.${nextRotationSeq(currentDate)}.log`);
      currentDayIndex += 1;
    }
  } catch {
    // stat 失败：保守按当前文件写（受控降级，不崩溃）
  }
}

// D1：UTF-8 字节安全截断。物理行整体不超过 MAX_LOG_LINE_BYTES；绝不拆 UTF-16 surrogate；
// 截断时附加截断元数据（truncated=true 与截断前规范化字节数），元数据计入行预算。
// 只记录长度，不回显被截断的正文/凭据。
const TRUNC_META_ASCII = ' [truncated=true,bytes=]';
function truncateLine(line: string): { text: string; truncated: boolean } {
  const lineBytes = Buffer.byteLength(line, 'utf8');
  if (lineBytes <= MAX_LOG_LINE_BYTES) return { text: line, truncated: false };
  const meta = `${TRUNC_META_ASCII}${lineBytes}`;
  const budget = MAX_LOG_LINE_BYTES - Buffer.byteLength(meta, 'utf8');
  let end = 0;
  let acc = 0;
  let i = 0;
  while (i < line.length) {
    const cp = line.codePointAt(i);
    const b = Buffer.byteLength(String.fromCodePoint(cp!), 'utf8');
    if (acc + b > budget) break;
    acc += b;
    i += cp! > 0xffff ? 2 : 1; // 绝不拆 surrogate：4 字节字符整体跳过 2 个 UTF-16 单元
    end = i;
  }
  // 若单个字符超预算（极端 4 字节字符 + 窄预算），退化到空截断（仍带元数据）
  return { text: `${line.slice(0, end)}${meta}`, truncated: true };
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
  let text = `[${timeStamp(new Date())}] [${level.padEnd(5)}] [${category}] ${normalizeLogMessage(message)}`;
  if (error !== undefined) {
    const detail =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
        : String(error);
    text += `\n  ${scrubControlChars(detail).replace(/\n/g, '\n  ')}`;
  }

  const safe = sanitize(text);
  // D1 行预算在 sanitize/控制字符处理后执行（安全文本）；Error 多行结构的每个物理行
  // 独立截断到 8 KiB，并附加截断元数据。
  const bounded = safe
    .split('\n')
    .map((l) => {
      const r = truncateLine(l);
      return r.truncated ? r.text : l;
    })
    .join('\n');

  // 决议 #153(2)：initLogger 未调用时（logDir 空）绝不落盘——旧实现以相对
  // 路径把日志写进进程 cwd（红态机器证据：npm test 在根目录生成
  // aibrowse-2026-08-16.log）；修复后仅脱敏 console 输出。
  if (logDir !== '') {
    ensureLogFile();
    try {
      const payload = `${bounded}\n`;
      // 写前滚动：现有文件 + 本次写入 > 10 MiB 先滚动
      rotateIfNeeded(Buffer.byteLength(payload, 'utf8'));
      appendFileSync(currentLogFile, payload);
      // D1：新滚动文件产生后执行有界 housekeeping（活动文件受保护，不会被误删）
      if (currentDayIndex > 0) housekeeping();
    } catch (e) {
      // Logging must never crash the app; fall back to console only.
      // 固定、脱敏、非递归诊断：不输出 e 的完整路径/正文（敌手信息、凭据不得回显）。
      const maybeCode = (e as { code?: unknown } | null)?.code;
      const code = typeof maybeCode === 'string' ? maybeCode : '';
      console.error(`[logger] 写入日志文件失败${code === '' ? '' : `: ${code}`}`);
    }
  }
  if (level === 'ERROR') console.error(bounded);
  else if (level === 'WARN') console.warn(bounded);
  else console.log(bounded);
}

// 冒烟断言用：当前日志文件路径（appendFileSync 同步写盘，读取即最新；仅测试/验证场景使用）。
// 冒烟以「文件偏移切片」限定本次运行的日志区间，避免读到同日更早运行的内容。
// 决议 #153(3)：未初始化返回 ''（无日志文件语义冻结）。
export function getCurrentLogFilePath(): string {
  if (logDir === '') return '';
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
