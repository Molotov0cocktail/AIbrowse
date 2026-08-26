// D3 network-policy: 公开网络 URL/IP/DNS/redirect/downgrade 确定性策略（纯函数、零 IO）。
// Contract source: doc/stage6/detailed-design.md §6.1、threat-model WT-01～WT-03、
// WRT-01～WRT-03。只允许 http/https 公网 unicast；端口闭合为 HTTP 80 / HTTPS 443；
// 拒绝 userinfo/localhost/保留后缀/私网/link-local/组播/保留地址；连接时 lookup 只
// 返回已批准地址。所有 == MAX 接受、超限 fail-closed。
import { isIP } from 'node:net';

export type PublicScheme = 'http' | 'https';

export type IpCategory =
  | 'public'
  | 'private'
  | 'loopback'
  | 'link-local'
  | 'multicast'
  | 'reserved'
  | 'unspecified'
  | 'invalid';

/** 解析并通过纯 URL 校验的目标（不含 DNS/IP，IP 在连接时 lookup 复验）。 */
export interface ApprovedTarget {
  scheme: PublicScheme;
  host: string; // 规范化 hostname（小写、无尾点、IPv6 去括号）
  port: 80 | 443;
  url: string; // 规范化 URL（去 fragment、默认端口省略）
}

export type ValidateUrlResult =
  { ok: true; target: ApprovedTarget } | { ok: false; health: 'security_rejected'; reason: string };

// RFC 6761/6762/7686 特殊用途与常见私网保留后缀（host 以该后缀结尾或全等拒绝）。
const RESERVED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.test',
  '.example',
  '.invalid',
  '.onion',
  '.localdomain',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
  '.priv',
] as const;

const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;

function isReservedHost(host: string): boolean {
  if (host === 'localhost') return true;
  return RESERVED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * 纯 URL 校验 + 规范化（§6.1 第 1–2 条）：
 * - 仅 http/https；拒绝 userinfo、空 host、host 控制字符/非法字符；
 * - 端口闭合：省略或显式等于对应默认端口均接受并规范化为省略形式；其余一律拒绝；
 * - host 规范化（小写、去尾点、IPv6 去括号）后拒绝 localhost 与保留后缀；
 * - 返回规范化 URL（去 fragment；默认端口省略）。
 */
export function validatePublicUrl(raw: string): ValidateUrlResult {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, health: 'security_rejected', reason: 'empty-url' };
  }
  // 原始串控制字符（C0/C1）直接拒绝——URL 解析器会剥离 \n \t 等造成 host 走私
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return { ok: false, health: 'security_rejected', reason: 'control-char' };
    }
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, health: 'security_rejected', reason: 'invalid-url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, health: 'security_rejected', reason: 'scheme' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, health: 'security_rejected', reason: 'userinfo' };
  }
  const scheme: PublicScheme = url.protocol === 'https:' ? 'https' : 'http';

  let host = url.hostname;
  if (typeof host !== 'string' || host.length === 0) {
    return { ok: false, health: 'security_rejected', reason: 'empty-host' };
  }
  // IPv6 字面量（URL.hostname 已含方括号）去括号
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  // 去除末尾点（FQDN 尾点）后规范化
  while (host.endsWith('.')) host = host.slice(0, -1);
  host = host.toLowerCase();

  if (!HOSTNAME_PATTERN.test(host) && isIP(host) === 0) {
    return { ok: false, health: 'security_rejected', reason: 'host-chars' };
  }
  if (isReservedHost(host)) {
    return { ok: false, health: 'security_rejected', reason: 'reserved-host' };
  }
  // 单标签非 IP host（如 http:///path → host=path、intranet、router）一律拒绝：
  // 公网 URL 必须为 FQDN 或 IP 字面量；连接时 IP 校验是第二道防线。
  if (!host.includes('.') && isIP(host) === 0) {
    return { ok: false, health: 'security_rejected', reason: 'single-label-host' };
  }

  // 端口闭合：省略或显式等于对应默认端口；其余一律拒绝（含 scheme 与端口不匹配）。
  const portText = url.port;
  let port: 80 | 443;
  if (portText === '') {
    port = scheme === 'https' ? 443 : 80;
  } else {
    const p = Number(portText);
    if (!Number.isInteger(p)) {
      return { ok: false, health: 'security_rejected', reason: 'port' };
    }
    if (scheme === 'https' && p === 443) port = 443;
    else if (scheme === 'http' && p === 80) port = 80;
    else return { ok: false, health: 'security_rejected', reason: 'port' };
  }

  url.hash = '';
  const normalizedUrl = url.toString();
  return {
    ok: true,
    target: { scheme, host, port, url: normalizedUrl },
  };
}

// ---------------------------------------------------------------------------
// IP 分类（§6.1 第 3 条：连接 lookup 每个候选都必须允许的公网 unicast）
// ---------------------------------------------------------------------------

/** IPv4 八位组分类。 */
function classifyIpv4(address: string): IpCategory {
  const parts = address.split('.');
  if (parts.length !== 4) return 'invalid';
  const octets = parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) return -1;
    const n = Number(p);
    return n >= 0 && n <= 255 ? n : -1;
  });
  if (octets.some((n) => n < 0)) return 'invalid';
  const [a, b, c] = octets as [number, number, number];
  if (a === 0) return 'unspecified'; // 0.0.0.0/8
  if (a === 10) return 'private'; // 10/8
  if (a === 127) return 'loopback'; // 127/8
  if (a === 169 && b === 254) return 'link-local'; // 169.254/16
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16/12
  if (a === 192 && b === 168) return 'private'; // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return 'reserved'; // 100.64/10 shared
  if (a === 192 && b === 0 && c === 0) return 'reserved'; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return 'reserved'; // 192.0.2.0/24 TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return 'reserved'; // 192.88.99.0/24 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // 198.18/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return 'reserved'; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return 'reserved'; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224 && a <= 239) return 'multicast'; // 224/4
  if (a >= 240) return 'reserved'; // 240/4 + broadcast
  return 'public';
}

/** IPv6 解析为 8 个 16-bit 组（isIP 已验证格式，此处防御性返回 null）。 */
function parseIpv6Groups(address: string): number[] | null {
  const lower = address.toLowerCase();
  const doubleColon = lower.indexOf('::');
  let head = lower;
  let tailParts: string[] = [];
  if (doubleColon !== -1) {
    head = lower.slice(0, doubleColon);
    const tail = lower.slice(doubleColon + 2);
    tailParts = tail === '' ? [] : tail.split(':');
  }
  const headParts = head === '' ? [] : head.split(':');
  const groups: number[] = [];
  for (const part of [...headParts, ...tailParts]) {
    if (part === '') return null;
    const value = parseInt(part, 16);
    if (!Number.isFinite(value)) return null;
    groups.push(value);
  }
  const missing = 8 - groups.length;
  if (missing < 0) return null;
  for (let i = 0; i < missing; i += 1) groups.push(0);
  if (groups.length !== 8) return null;
  return groups;
}

/**
 * IPv6 分类：显式 allowlist，只放行属于公网 global-unicast（2000::/3）且不属于
 * IANA 特殊用途子块的地址；其余（含 site-local fec0::/10、文档段、benchmarking、
 * IETF 2001::/23、6to4、NAT64、ULA、链路本地、组播、discard、IPv4-compatible）一律拒绝。
 * 禁止「未在 denylist 即 public」的默认放行。
 */
function classifyIpv6(address: string): IpCategory {
  const lower = address.toLowerCase();
  if (lower.includes('%')) return 'link-local'; // 带 zone id 的地址必为链路本地形态
  if (lower === '::') return 'unspecified';
  if (lower === '::1') return 'loopback';
  // IPv4-mapped ::ffff:a.b.c.d → 按内嵌 IPv4 分类
  if (lower.startsWith('::ffff:')) {
    const embedded = lower.slice(7);
    if (isIP(embedded) === 4) return classifyIpv4(embedded);
    return 'reserved';
  }
  // IPv4-compatible ::a.b.c.d（已废弃）整体视为保留
  if (lower.includes('.')) return 'reserved';

  const groups = parseIpv6Groups(lower);
  if (groups === null) return 'invalid';
  const [g0, g1] = groups as [number, number, ...number[]];

  if (g0 === 0) return 'reserved'; // 0::/96 其余（::、::1、::ffff 已在上方处理）
  if (g0 >= 0xff00) return 'multicast'; // ff00::/8
  if ((g0 & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return 'reserved'; // fec0::/10 site-local（废弃）
  if ((g0 & 0xfe00) === 0xfc00) return 'private'; // fc00::/7 ULA
  if (g0 === 0x2002) return 'reserved'; // 6to4
  if (g0 === 0x0064 && g1 === 0xff9b) return 'reserved'; // 64:ff9b::/96 NAT64
  if (g0 === 0x0100) return 'reserved'; // 100::/64 discard-only

  // 显式 global-unicast：2000::/3（RFC 4291）
  if (g0 >= 0x2000 && g0 <= 0x3fff) {
    // 2001::/23 = IETF Protocol Assignments（RFC 2928）：Teredo/PCP/BMWG/AMT/AS112/
    // ORCHID/Drone Remote ID 均在其中；整个 /23 不视为公网普通地址
    if (g0 === 0x2001 && g1 <= 0x01ff) return 'reserved';
    // 2001:db8::/32 文档段（RFC 3849；位于 2001::/23 之外，需单独拒绝）
    if (g0 === 0x2001 && g1 === 0x0db8) return 'reserved';
    return 'public';
  }
  return 'reserved';
}

/** 地址分类（§6.1 第 3 条；非合法 IP 返回 invalid）。 */
export function classifyIpAddress(address: string): IpCategory {
  if (typeof address !== 'string' || address.length === 0) return 'invalid';
  const kind = isIP(address);
  if (kind === 4) return classifyIpv4(address);
  if (kind === 6) return classifyIpv6(address);
  return 'invalid';
}

/** 是否允许的公网 unicast（连接时 lookup 唯一放行条件）。 */
export function isAllowedPublicAddress(address: string): boolean {
  return classifyIpAddress(address) === 'public';
}
