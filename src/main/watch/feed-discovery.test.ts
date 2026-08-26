// D3 feed-discovery tests: 公开 HTML 的 feed 候选发现（detailed-design §6.3）。
// 只识别合法 rel/type/href；最多 10 候选；文档序；canonical URL 去重；候选重走
// NetworkPolicy；预算 fail-closed；零脚本/子资源/Cookie/请求。
import { describe, expect, it } from 'vitest';
import { MAX_DISCOVERY_CANDIDATES, MAX_DISCOVERY_HTML_BYTES } from '../../shared/types/watch';
import { parseDiscoveryCandidates } from './feed-discovery';

const BASE = 'https://example.com/';

describe('候选识别与规范化', () => {
  it('识别 rel=alternate + rss/atom type，按文档序', () => {
    const html =
      '<html><head>' +
      '<link rel="alternate" type="application/rss+xml" href="/feed.xml">' +
      '<link rel="alternate" type="application/atom+xml" href="https://cdn.example.com/atom">' +
      '<link rel="alternate" type="application/json" href="/not-feed">' +
      '</head></html>';
    const r = parseDiscoveryCandidates(html, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.length).toBe(2);
    expect(r.candidates[0]!.url).toBe('https://example.com/feed.xml');
    expect(r.candidates[1]!.url).toBe('https://cdn.example.com/atom');
    expect(r.candidates[0]!.type).toBe('application/rss+xml');
    expect(r.candidates[1]!.type).toBe('application/atom+xml');
  });

  it('rel 为多 token（alternate + 其它）仍识别；rel 缺 alternate 忽略', () => {
    const html =
      '<link rel="alternate stylesheet" type="application/rss+xml" href="/a">' +
      '<link rel="stylesheet" type="application/rss+xml" href="/b">';
    const r = parseDiscoveryCandidates(html, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]!.url).toBe('https://example.com/a');
  });

  it('相对 href 按 baseUrl 解析；相对路径规范化', () => {
    const r = parseDiscoveryCandidates(
      '<link rel="alternate" type="application/atom+xml" href="atom.xml">',
      'https://example.com/dir/page.html',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates[0]!.url).toBe('https://example.com/dir/atom.xml');
  });

  it('canonical URL 去重（first-wins，文档序）', () => {
    const html =
      '<link rel="alternate" type="application/rss+xml" href="/feed.xml">' +
      '<link rel="alternate" type="application/rss+xml" href="https://example.com/feed.xml">' +
      '<link rel="alternate" type="application/atom+xml" href="/feed.xml">';
    const r = parseDiscoveryCandidates(html, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.length).toBe(1);
  });

  it('非法 href（javascript/file/localhost/ftp）跳过；私网 IP 字面量是合法候选数据（连接时再拒绝）', () => {
    const html =
      '<link rel="alternate" type="application/rss+xml" href="javascript:alert(1)">' +
      '<link rel="alternate" type="application/rss+xml" href="file:///etc/passwd">' +
      '<link rel="alternate" type="application/rss+xml" href="http://localhost/feed">' +
      '<link rel="alternate" type="application/rss+xml" href="ftp://x/feed">' +
      '<link rel="alternate" type="application/rss+xml" href="http://192.168.1.1/feed">';
    const r = parseDiscoveryCandidates(html, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // NetworkPolicy 纯 URL 校验不判 IP（IP 在连接时 lookup 复验），私网字面量仍为候选数据
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]!.url).toBe('http://192.168.1.1/feed');
  });

  it('缺 rel/type/href 的 link 忽略', () => {
    const html =
      '<link rel="alternate" href="/no-type">' +
      '<link type="application/rss+xml" href="/no-rel">' +
      '<link rel="alternate" type="application/rss+xml">';
    const r = parseDiscoveryCandidates(html, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.length).toBe(0);
  });

  it('最多 10 候选并标 truncated', () => {
    const links = Array.from(
      { length: 12 },
      (_, i) => `<link rel="alternate" type="application/rss+xml" href="/f${i}">`,
    ).join('');
    const r = parseDiscoveryCandidates(`<html><head>${links}</head></html>`, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.length).toBe(MAX_DISCOVERY_CANDIDATES);
    expect(r.truncated).toBe(true);
  });

  it('恰好 10 候选不标 truncated', () => {
    const links = Array.from(
      { length: 10 },
      (_, i) => `<link rel="alternate" type="application/rss+xml" href="/f${i}">`,
    ).join('');
    const r = parseDiscoveryCandidates(`<html><head>${links}</head></html>`, BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.candidates.length).toBe(10);
    expect(r.truncated).toBe(false);
  });
});

describe('预算与 fail-closed', () => {
  it('输入超过 256 KiB → budget_exceeded', () => {
    const big = `<html><head>${'x'.repeat(MAX_DISCOVERY_HTML_BYTES)}</head></html>`;
    const r = parseDiscoveryCandidates(big, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('budget_exceeded');
  });

  it('深度 65 → budget_exceeded；64 接受', () => {
    // html(1) + 62 div → 打开 link 时栈长 63 → 深度 64（== 接受）
    const at64 = `<html>${'<div>'.repeat(62)}<link rel="alternate" type="application/rss+xml" href="/f">${'</div>'.repeat(62)}</html>`;
    const ok = parseDiscoveryCandidates(at64, BASE);
    expect(ok.ok).toBe(true);

    // 打开第 64 个 div 时栈长 64 → 65 > 64 → budget_exceeded
    const over65 = `<html>${'<div>'.repeat(64)}x${'</div>'.repeat(64)}</html>`;
    const bad = parseDiscoveryCandidates(over65, BASE);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('非法 baseUrl → security_rejected', () => {
    const r = parseDiscoveryCandidates('<html></html>', 'file:///etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('security_rejected');
  });
});
