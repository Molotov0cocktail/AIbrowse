// 决议 #152(5)：Markdown 链接 URL 判定纯函数——Validator（main）与
// Renderer（renderer）共用同一实现（单一事实源）。仅绝对 http/https 且
// 禁止 userinfo；任何畸形/危险形态安全返回 false（不抛异常）。
export function isSafeMarkdownUrl(url: string): boolean {
  if (typeof url !== 'string' || url === '') return false;
  // 空白/控制字符拒绝（WHATWG 会静默 trim 或百分号编码——畸形形态必须
  // 显式拒绝；简单字符类单遍扫描，零回溯；显式 uXXXX 转义避免字面控制字符）
  for (let i = 0; i < url.length; i += 1) {
    const code = url.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  // userinfo 禁止（user:pass@host / user@host）
  if (parsed.username !== '' || parsed.password !== '') return false;
  return true;
}
