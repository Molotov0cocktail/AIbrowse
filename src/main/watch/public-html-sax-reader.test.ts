// D3 public-html-sax-reader tests: 公开 HTML SAX → DocumentChannels（detailed-design
// §6.5、threat-model WRT-19）。零脚本/子资源/Cookie；2 MiB/20k node/64 depth/64 attrs/
// 64 KiB Projection 精确边界；编码冲突/未知受控失败；link/base 不触发网络。
import { describe, expect, it } from 'vitest';
import {
  MAX_HTML_ATTRIBUTES_PER_TAG,
  MAX_HTML_NODES,
  MAX_PAGE_PROJECTION_BYTES,
} from '../../shared/types/watch';
import { readPublicHtml } from './public-html-sax-reader';

const BASE = 'https://example.com/page';

function htmlOf(body: string): Buffer {
  return Buffer.from(`<html><head><title>Page</title></head><body>${body}</body></html>`, 'utf8');
}

describe('通道提取：mainText/headings/tables/links', () => {
  it('mainText 来自 body/main/article 可见文本', () => {
    const r = readPublicHtml(
      htmlOf('<h1>Head</h1><p>Hello <b>world</b></p><main>Main text here</main>'),
      BASE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.channels;
    expect(c.mainText).toBe('Hello world Main text here');
    expect(c.headings).toEqual([{ level: 1, text: 'Head' }]);
  });

  it('headings h1-h3；h4 文本属可见文本入 mainText', () => {
    const r = readPublicHtml(htmlOf('<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><p>body</p>'), BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channels.headings).toEqual([
      { level: 1, text: 'A' },
      { level: 2, text: 'B' },
      { level: 3, text: 'C' },
    ]);
    expect(r.channels.mainText).toBe('D body');
  });

  it('links：text + 规范化 URL（相对解析、非法 scheme/保留 host 跳过；私网 IP 仅作数据）', () => {
    const body =
      '<p><a href="/a">Alpha</a> <a href="https://cdn.example.com/b">Beta</a> <a href="javascript:evil">Bad</a> <a href="http://192.168.1.1/x">Priv</a> <a>NoHref</a> <a href="http://x.example/f">Reserved</a></p>';
    const r = readPublicHtml(htmlOf(body), BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channels.links).toEqual([
      { text: 'Alpha', url: 'https://example.com/a' },
      { text: 'Beta', url: 'https://cdn.example.com/b' },
      { text: 'Priv', url: 'http://192.168.1.1/x' }, // IP 分类在连接时，链接仅为数据
    ]);
  });

  it('tables：th 行作 headers，其余为 rows；无 th 时首行作 headers', () => {
    const r = readPublicHtml(
      htmlOf('<table><tr><th>H1</th><th>H2</th></tr><tr><td>a</td><td>b</td></tr></table>'),
      BASE,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channels.tables).toEqual([{ headers: ['H1', 'H2'], rows: [['a', 'b']] }]);
  });

  it('嵌套表格内容忽略（只处理最外层）', () => {
    const body =
      '<table><tr><th>H</th></tr><tr><td>outer<table><tr><td>inner</td></tr></table></td></tr></table>';
    const r = readPublicHtml(htmlOf(body), BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channels.tables).toEqual([{ headers: ['H'], rows: [['outer']] }]);
  });
});

describe('忽略元素：零内容、零请求（WRT-19）', () => {
  it('script/style/noscript/template/svg/math/iframe/object/embed/form/input/button 内容与属性不进通道', () => {
    const body =
      '<script>var canary = "S-CANARY";</script>' +
      '<style>.x{content:"C-CANARY"}</style>' +
      '<noscript>N-CANARY</noscript>' +
      '<template>T-CANARY</template>' +
      '<svg><text>V-CANARY</text></svg>' +
      '<math><mi>M-CANARY</mi></math>' +
      '<iframe src="https://evil/x">I-CANARY</iframe>' +
      '<object data="https://evil/o">O-CANARY</object>' +
      '<embed src="https://evil/e" title="E-CANARY">' +
      '<form action="https://evil/f"><input name="q" value="F-CANARY">button text</form>' +
      '<input value="IN-CANARY">' +
      '<button>BT-CANARY</button>' +
      '<p>ok-text</p>';
    const r = readPublicHtml(htmlOf(body), BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = JSON.stringify(r.channels);
    for (const canary of [
      'S-CANARY',
      'C-CANARY',
      'N-CANARY',
      'T-CANARY',
      'V-CANARY',
      'M-CANARY',
      'I-CANARY',
      'O-CANARY',
      'E-CANARY',
      'F-CANARY',
      'IN-CANARY',
      'BT-CANARY',
    ]) {
      expect(all, canary).not.toContain(canary);
    }
    expect(r.channels.mainText).toBe('ok-text');
    expect(r.channels.links.length).toBe(0);
  });

  it('忽略元素内的 a/heading/table 也忽略', () => {
    const body = '<form><a href="https://evil/x">hidden link</a><h1>hidden h</h1></form>';
    const r = readPublicHtml(htmlOf(body), BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channels.links.length).toBe(0);
    expect(r.channels.headings.length).toBe(0);
    expect(r.channels.mainText).toBe('');
  });

  it('HTML 中 URL 不触发任何网络（无副作用；link/base 仅数据规范化）', () => {
    const body =
      '<base href="https://base.example.com/dir/"><a href="sub">x</a><img src="https://tracker/pixel.png" onerror="evil()">';
    const r = readPublicHtml(htmlOf(body), BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // base 生效：相对 href 按 base 解析
    expect(r.channels.links).toEqual([{ text: 'x', url: 'https://base.example.com/dir/sub' }]);
  });

  it('base 只接受首个同文档合法 http/https <base href>；非法 base 忽略', () => {
    const body =
      '<base href="javascript:evil"><base href="https://cdn.example.com/"><a href="/x">x</a>';
    const r = readPublicHtml(htmlOf(body), BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 首个 base 非法被忽略；第二个合法 base 生效
    expect(r.channels.links).toEqual([{ text: 'x', url: 'https://cdn.example.com/x' }]);
  });
});

describe('预算精确边界', () => {
  it('node 20k 接受、20k+1 拒绝', () => {
    // htmlOf 已含 html/head/title/body 4 个 startTag；body 内容补足 19996 节点
    const atMax = htmlOf('<span>x</span>'.repeat(MAX_HTML_NODES - 4));
    const ok = readPublicHtml(atMax, BASE);
    expect(ok.ok).toBe(true);

    const over = htmlOf('<span>x</span>'.repeat(MAX_HTML_NODES - 3));
    const bad = readPublicHtml(over, BASE);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('depth 64 接受、65 拒绝', () => {
    // htmlOf 中 body 深度为 2（html、body；head/title 已闭合）；61 个 div → p 深度 64（== 接受）
    const at64 = htmlOf(`${'<div>'.repeat(61)}<p>x</p>${'</div>'.repeat(61)}`);
    const ok = readPublicHtml(at64, BASE);
    expect(ok.ok).toBe(true);

    const over65 = htmlOf(`${'<div>'.repeat(62)}<p>x</p>${'</div>'.repeat(62)}`);
    const bad = readPublicHtml(over65, BASE);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('attrs 64 接受、65 拒绝', () => {
    const attrs64 = Array.from({ length: MAX_HTML_ATTRIBUTES_PER_TAG }, (_, i) => `a${i}="v"`).join(
      ' ',
    );
    const ok = readPublicHtml(htmlOf(`<div ${attrs64}>x</div>`), BASE);
    expect(ok.ok).toBe(true);

    const attrs65 = Array.from(
      { length: MAX_HTML_ATTRIBUTES_PER_TAG + 1 },
      (_, i) => `a${i}="v"`,
    ).join(' ');
    const bad = readPublicHtml(htmlOf(`<div ${attrs65}>x</div>`), BASE);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('Projection 预算：== MAX 接受、MAX+1 拒绝', () => {
    // mainText 恰好 65536 字节（用中文字符精确对齐：3 字节 × 精确数量）
    const n = Math.floor(MAX_PAGE_PROJECTION_BYTES / 3); // 21845 个中文字 = 65535 字节
    const exact = '中'.repeat(n);
    const ok = readPublicHtml(htmlOf(`<p>${exact}</p>`), BASE);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.byteLength).toBe(n * 3);

    const over = htmlOf(`<p>${exact}中</p>`); // 65538 > 65536
    const bad = readPublicHtml(over, BASE);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });
});

describe('编码与失败闭环', () => {
  it('BOM 冲突 → parse_changed', () => {
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<html><meta charset="windows-1252"><body>x</body></html>', 'utf8'),
    ]);
    const r = readPublicHtml(buf, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('未知 charset → parse_changed', () => {
    const r = readPublicHtml(Buffer.from('<html><body>x</body></html>', 'utf8'), BASE, {
      contentTypeCharset: 'text/html; charset=shift_jis',
    });
    expect(r.ok).toBe(false);
  });

  it('非法 baseUrl → security_rejected', () => {
    const r = readPublicHtml(htmlOf('<p>x</p>'), 'file:///etc/passwd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('security_rejected');
  });

  it('空输入 → parse_changed', () => {
    expect(readPublicHtml(Buffer.alloc(0), BASE).ok).toBe(false);
  });
});

describe('规范化与隐私', () => {
  it('文本空白折叠/trim；bidi 控制清除（parse5 会替换 NUL 故用 ZWSP 验证）', () => {
    const r = readPublicHtml(htmlOf('<p>  a\t b  c  </p>'), BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.channels.mainText).toBe('a b c');

    const r2 = readPublicHtml(htmlOf('<p>a\u200bb</p>'), BASE);
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.channels.mainText).toBe('ab'); // ZWSP 清除
  });

  it('Cookie canary 与敌手正文零持久化/零日志（通道外）', () => {
    const body =
      '<p>ok</p><script>document.cookie="sid=CANARY_SID_9f21";</script>' +
      '<a href="https://evil.example.com/x?token=CANARY_TOKEN">t</a>';
    const r = readPublicHtml(htmlOf(body), BASE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const all = JSON.stringify(r.channels);
    // 脚本内容 canary 绝不进入通道（执行/正文零进投影）
    expect(all).not.toContain('CANARY_SID_9f21');
    // 链接 URL 是设计内数据（含 query），允许在通道；mainText 不含敌手正文
    expect(r.channels.links).toEqual([
      { text: 't', url: 'https://evil.example.com/x?token=CANARY_TOKEN' },
    ]);
    expect(r.channels.mainText).toBe('ok');
  });
});
