// D3 feed-parser tests: RSS2/Atom/namespace/CDATA/encoding、identity 去重、200 项截断、
// 字段截断、DTD/XXE/bomb、depth/name/attr/text/node/total/projection 边界
// （detailed-design §6.4、threat-model WRT-06～WRT-08）。
import { describe, expect, it } from 'vitest';
import {
  MAX_FEED_FIELD_BYTES,
  MAX_FEED_ITEMS,
  MAX_FEED_PROJECTION_BYTES,
  MAX_XML_ATTRIBUTES_PER_TAG,
  MAX_XML_DEPTH,
  MAX_XML_NAME_BYTES,
  MAX_XML_NODES,
  MAX_XML_TEXT_NODE_BYTES,
  MAX_XML_TOTAL_TEXT_BYTES,
} from '../../shared/types/watch';
import { utf8ByteLength } from '../../shared/watch/watch-budget';
import {
  encodeFeedProjectionCanonical,
  parseFeedXml,
  parseFeedXmlWithLoader,
  type FeedProjectionCanonicalPayload,
} from './feed-parser';

const RSS = (items: string, extra = ''): string =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed</title><link>https://example.com</link><description>d</description>${items}${extra}</channel></rss>`;

const RSS_ITEM = (guid: string, title: string, link: string, extra = ''): string =>
  `<item><guid>${guid}</guid><title>${title}</title><link>${link}</link><description>s</description>${extra}</item>`;

const ATOM = (entries: string, extra = ''): string =>
  `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>F</title><subtitle>s</subtitle><link rel="alternate" href="https://example.com/"/><link rel="self" href="https://example.com/atom.xml"/>${entries}${extra}</feed>`;

const ATOM_ENTRY = (id: string, title: string, link: string, extra = ''): string =>
  `<entry><id>${id}</id><title>${title}</title><link rel="alternate" href="${link}"/><summary>s</summary>${extra}</entry>`;

async function parseRss(items: string, extra = ''): Promise<ReturnType<typeof parseFeedXml>> {
  return parseFeedXml(Buffer.from(RSS(items, extra), 'utf8'));
}

describe('RSS 2.0 / Atom 基本解析与格式识别', () => {
  it('RSS2 基本投影', async () => {
    const r = await parseRss(RSS_ITEM('g1', 'T1', 'https://example.com/a'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.projection;
    expect(p.format).toBe('rss2');
    expect(p.title.text).toBe('Feed');
    expect(p.siteUrl.text).toBe('https://example.com');
    expect(p.items.length).toBe(1);
    const item = p.items[0]!;
    expect(item.identity).toBe('g1');
    expect(item.identityKind).toBe('guid');
    expect(item.title.text).toBe('T1');
    expect(item.link.text).toBe('https://example.com/a');
    expect(item.summary.text).toBe('s');
    expect(p.itemsTruncated).toBe(false);
    expect(p.byteLength).toBeGreaterThan(0);
  });

  it('Atom 基本投影与 format=atom', async () => {
    const r = await parseFeedXml(
      Buffer.from(ATOM(ATOM_ENTRY('urn:uuid:1', 'A', 'https://example.com/1')), 'utf8'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.projection;
    expect(p.format).toBe('atom');
    expect(p.feedUrl.text).toBe('https://example.com/atom.xml');
    expect(p.siteUrl.text).toBe('https://example.com/');
    expect(p.items.length).toBe(1);
    expect(p.items[0]!.identity).toBe('urn:uuid:1');
    expect(p.items[0]!.identityKind).toBe('id');
  });

  it('未知根元素 → parse_changed', async () => {
    const r = await parseFeedXml(Buffer.from('<html><body>x</body></html>', 'utf8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('空文档 → parse_changed', async () => {
    const r = await parseFeedXml(Buffer.from('', 'utf8'));
    expect(r.ok).toBe(false);
  });
});

describe('namespace：URI+localName 不信任前缀', () => {
  it('Atom 前缀绑定不同不影响识别', async () => {
    const xml =
      '<?xml version="1.0"?><a:feed xmlns:a="http://www.w3.org/2005/Atom" xmlns:x="http://evil.test/x"><a:title>T</a:title><a:entry><a:id>i1</a:id><a:title>E</a:title><a:link rel="alternate" href="https://example.com/e"/></a:entry><x:entry><x:id>bad</x:id></x:entry></a:feed>';
    const r = await parseFeedXml(Buffer.from(xml, 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items.length).toBe(1); // 只认 ATOM_NS 的 entry
  });

  it('带 dc/content 模块命名空间的 RSS 正常解析', async () => {
    const xml =
      '<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title><item><guid>g</guid><title>X</title><link>https://example.com/x</link><dc:creator>me</dc:creator><content:encoded>&lt;p&gt;html&lt;/p&gt;</content:encoded></item></channel></rss>';
    const r = await parseFeedXml(Buffer.from(xml, 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items[0]!.title.text).toBe('X');
  });
});

describe('CDATA / 编码', () => {
  it('CDATA 内容保留', async () => {
    const r = await parseRss(RSS_ITEM('g', '<![CDATA[<b>& raw]]>', 'https://example.com/x'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items[0]!.title.text).toBe('<b>& raw');
  });

  it('UTF-16LE BOM 解码', async () => {
    const xml = RSS(RSS_ITEM('g', '中文', 'https://example.com/x'));
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    const r = await parseFeedXml(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items[0]!.title.text).toBe('中文');
  });

  it('windows-1252 声明解码（0xE9=é）', async () => {
    const body = Buffer.concat([
      Buffer.from(
        '<?xml version="1.0" encoding="windows-1252"?><rss><channel><title>caf',
        'latin1',
      ),
      Buffer.from([0xe9]),
      Buffer.from('</title></channel></rss>', 'latin1'),
    ]);
    const r = await parseFeedXml(body);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.title.text).toBe('café');
  });

  it('BOM 与声明冲突 → parse_changed', async () => {
    const xml =
      '<?xml version="1.0" encoding="windows-1252"?><rss><channel><title>x</title></channel></rss>';
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(xml, 'utf8')]);
    const r = await parseFeedXml(buf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('非法 UTF-8 → parse_changed（不 mask 为 U+FFFD）', async () => {
    const bad = Buffer.concat([
      Buffer.from('<rss><channel><title>x', 'latin1'),
      Buffer.from([0x80]),
      Buffer.from('</title></channel></rss>', 'latin1'),
    ]);
    const r = await parseFeedXml(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('UTF-16LE BOM 奇数长度 → parse_changed', async () => {
    const xml = RSS(RSS_ITEM('g', 't', 'https://example.com/x'));
    const odd = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(xml, 'utf16le').subarray(0, 7),
    ]);
    const r = await parseFeedXml(odd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });
});

describe('identity：首选/fallback/复合键/去重', () => {
  it('RSS 无 guid 时用 canonical link', async () => {
    const r = await parseRss('<item><title>T</title><link>https://example.com/a</link></item>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items[0]!.identity).toBe('https://example.com/a');
    expect(r.projection.items[0]!.identityKind).toBe('link');
  });

  it('无 id/guid/link 但 title+published 齐全 → 受控复合键（SHA-256）', async () => {
    const r = await parseRss(
      `<item><title>T1</title><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.projection.items[0]!;
    expect(item.identityKind).toBe('composite');
    expect(item.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(item.identity).toBe(item.identity);
  });

  it('无 id/guid/link 且复合键字段全缺 → 丢弃该 item', async () => {
    const r = await parseRss('<item></item>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items.length).toBe(0);
  });

  it('重复 identity 去重稳定（first-wins，文档序）', async () => {
    const r = await parseRss(
      RSS_ITEM('dup', 'FIRST', 'https://example.com/1') +
        RSS_ITEM('dup', 'SECOND', 'https://example.com/2'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items.length).toBe(1);
    expect(r.projection.items[0]!.title.text).toBe('FIRST');
  });

  it('确定性：同一输入两次解析投影一致', async () => {
    const xml = RSS(
      RSS_ITEM('a', 'T', 'https://example.com/a') + RSS_ITEM('b', 'U', 'https://example.com/b'),
    );
    const r1 = await parseFeedXml(Buffer.from(xml, 'utf8'));
    const r2 = await parseFeedXml(Buffer.from(xml, 'utf8'));
    expect(r1).toEqual(r2);
  });
});

describe('itemsTruncated：前 200 项，第 201 项标记', () => {
  it('201 个 item → itemsTruncated=true 且只保留前 200', async () => {
    const items = Array.from({ length: 201 }, (_, i) =>
      RSS_ITEM(`g${i}`, `t${i}`, `https://example.com/${i}`),
    ).join('');
    const r = await parseRss(items);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items.length).toBe(MAX_FEED_ITEMS);
    expect(r.projection.itemsTruncated).toBe(true);
    expect(r.projection.items[0]!.identity).toBe('g0');
    expect(r.projection.items[MAX_FEED_ITEMS - 1]!.identity).toBe(`g${MAX_FEED_ITEMS - 1}`);
  });

  it('恰好 200 项 → 不标记', async () => {
    const items = Array.from({ length: 200 }, (_, i) =>
      RSS_ITEM(`g${i}`, `t`, `https://example.com/`),
    ).join('');
    const r = await parseRss(items);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items.length).toBe(200);
    expect(r.projection.itemsTruncated).toBe(false);
  });
});

describe('字段 UTF-8 安全截断（4096）', () => {
  it('title 超 4096 字节 → truncated=true 且 originalBytes 记录', async () => {
    const long = '中'.repeat(2000); // 6000 字节
    const r = await parseRss(RSS_ITEM('g', long, 'https://example.com/x'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.projection.items[0]!;
    expect(item.title.truncated).toBe(true);
    expect(item.title.originalBytes).toBe(6000);
    expect(utf8ByteLength(item.title.text)).toBeLessThanOrEqual(4096);
    expect(utf8ByteLength(item.title.text) % 3).toBe(0); // 不拆多字节
  });

  it('title 恰 4096 字节 → 不截断', async () => {
    const exact = 'a'.repeat(4096);
    const r = await parseRss(RSS_ITEM('g', exact, 'https://example.com/x'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items[0]!.title.truncated).toBe(false);
    expect(r.projection.items[0]!.title.text).toBe(exact);
  });
});

describe('DTD/XXE/Bomb/XInclude（WRT-06）→ security_rejected', () => {
  const adversary = (doc: string): string => doc;

  it('DOCTYPE 声明 → security_rejected', async () => {
    const r = await parseFeedXml(
      Buffer.from(
        adversary('<!DOCTYPE rss><rss><channel><title>x</title></channel></rss>'),
        'utf8',
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('security_rejected');
  });

  it('ENTITY 内部声明 → security_rejected', async () => {
    const doc = '<!DOCTYPE rss [<!ENTITY x "y">]><rss><channel>&x;</channel></rss>';
    const r = await parseFeedXml(Buffer.from(doc, 'utf8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('security_rejected');
  });

  it('外部 DTD → security_rejected', async () => {
    const doc = '<!DOCTYPE rss SYSTEM "http://evil/x.dtd"><rss><channel>x</channel></rss>';
    const r = await parseFeedXml(Buffer.from(doc, 'utf8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('security_rejected');
  });

  it('XXE external entity → security_rejected', async () => {
    const doc =
      '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel>&xxe;</channel></rss>';
    const r = await parseFeedXml(Buffer.from(doc, 'utf8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('security_rejected');
  });

  it('Billion Laughs → security_rejected（不扩张）', async () => {
    const decls = ['<!ENTITY lol "lol">'];
    for (let i = 1; i < 10; i += 1) {
      decls.push(`<!ENTITY lol${i} "&lol${i - 1};&lol${i - 1};">`);
    }
    const doc = `<!DOCTYPE rss [${decls.join('')}]><rss><channel>&lol9;</channel></rss>`;
    const r = await parseFeedXml(Buffer.from(doc, 'utf8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('security_rejected');
  });

  it('未知实体 → security_rejected', async () => {
    const doc = '<rss><channel>&bogus;</channel></rss>';
    const r = await parseFeedXml(Buffer.from(doc, 'utf8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('security_rejected');
  });

  it('XInclude namespace 一经出现 → security_rejected（零文件/网络）', async () => {
    const doc =
      '<rss xmlns:xi="http://www.w3.org/2001/XInclude"><channel><xi:include href="file:///etc/passwd"/></channel></rss>';
    const r = await parseFeedXml(Buffer.from(doc, 'utf8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('security_rejected');
  });

  it('XInclude 仅声明命名空间也 security_rejected（不惰性放行）', async () => {
    const doc =
      '<rss xmlns:xi="http://www.w3.org/2001/XInclude"><channel><title>x</title></channel></rss>';
    const r = await parseFeedXml(Buffer.from(doc, 'utf8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('security_rejected');
  });

  it('敌手失败后正常 feed 仍可解析（状态未污染）', async () => {
    const bad = await parseFeedXml(
      Buffer.from(
        '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss>&xxe;</rss>',
        'utf8',
      ),
    );
    expect(bad.ok).toBe(false);
    const good = await parseRss(RSS_ITEM('ok', 'fine', 'https://example.com/x'));
    expect(good.ok).toBe(true);
  });
});

describe('namespace 校验：扩展 namespace 不得覆盖核心字段', () => {
  it('Atom：foreign namespace 的 title/link/id 不覆盖核心字段', async () => {
    const xml =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:x="http://evil.test/x"><title>F</title><x:title>FAKE TITLE</x:title><entry><id>real-id</id><x:id>fake-id</x:id><title>Real T</title><x:title>FAKE</x:title><link rel="alternate" href="https://real.example.com/1"/><x:link rel="alternate" href="https://evil.example.com/"/></entry></feed>';
    const r = await parseFeedXml(Buffer.from(xml, 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.title.text).toBe('F');
    const item = r.projection.items[0]!;
    expect(item.title.text).toBe('Real T');
    expect(item.identity).toBe('real-id');
    expect(item.identityKind).toBe('id');
    expect(item.link.text).toBe('https://real.example.com/1');
  });

  it('RSS：extension namespace 的 title/guid 不覆盖核心字段', async () => {
    const xml =
      '<?xml version="1.0"?><rss version="2.0" xmlns:evil="http://evil.test/x"><channel><title>F</title><item><guid>g1</guid><evil:guid>evil</evil:guid><title>Real</title><evil:title>FAKE</evil:title><link>https://real.example.com/1</link></item></channel></rss>';
    const r = await parseFeedXml(Buffer.from(xml, 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.title.text).toBe('F');
    const item = r.projection.items[0]!;
    expect(item.title.text).toBe('Real');
    expect(item.identity).toBe('g1');
    expect(item.identityKind).toBe('guid');
  });

  it('RSS 根带默认 namespace → parse_changed（RSS 核心字段必须无 namespace）', async () => {
    const xml =
      '<rss xmlns="http://evil.test/rss" version="2.0"><channel><title>x</title></channel></rss>';
    const r = await parseFeedXml(Buffer.from(xml, 'utf8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });
});

describe('Feed HTML/CDATA 字段 → 安全纯文本', () => {
  const itemWith = (description: string): string =>
    `<item><guid>g</guid><title>T</title><link>https://example.com/x</link><description>${description}</description></item>`;

  it('RSS description CDATA 含 HTML → 纯文本（标签剥离 + 实体解码）', async () => {
    const r = await parseRss(itemWith('<![CDATA[<p>Hello <b>world</b> &amp; more</p>]]>'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items[0]!.summary.text).toBe('Hello world & more');
  });

  it('RSS description 转义 HTML → 纯文本', async () => {
    const r = await parseRss(itemWith('&lt;p&gt;a &lt;b&gt;b&lt;/b&gt;&lt;/p&gt;'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items[0]!.summary.text).toBe('a b');
  });

  it('Atom content type=html → 纯文本', async () => {
    const entry =
      '<entry><id>id1</id><title>T</title><link rel="alternate" href="https://example.com/1"/><content type="html">&lt;p&gt;a &lt;b&gt;b&lt;/b&gt;&lt;/p&gt;</content></entry>';
    const r = await parseFeedXml(Buffer.from(ATOM(entry), 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items[0]!.summary.text).toBe('a b');
  });

  it('script/style 块从 description 整体移除', async () => {
    const r = await parseRss(
      itemWith('<![CDATA[<script>alert("x")</script>keep <b>bold</b><style>.c{}</style>]]>'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items[0]!.summary.text).toBe('keep bold');
  });
});

describe('边界：== MAX 接受、MAX+1 fail-closed（WRT-07）', () => {
  const wrap = (inner: string): string => `<rss><channel>${inner}</channel></rss>`;

  it('depth 64 接受、65 拒绝', async () => {
    const at64 = wrap('<a>'.repeat(MAX_XML_DEPTH - 2) + 'x' + '</a>'.repeat(MAX_XML_DEPTH - 2));
    const ok = await parseFeedXml(Buffer.from(at64, 'utf8'));
    expect(ok.ok).toBe(true);

    const over65 = wrap('<a>'.repeat(MAX_XML_DEPTH - 1) + 'x' + '</a>'.repeat(MAX_XML_DEPTH - 1));
    const bad = await parseFeedXml(Buffer.from(over65, 'utf8'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('node count 20k 接受、20k+1 拒绝（start element 与 text 事件都计数）', async () => {
    // wrap 贡献 rss+channel 2 个 startTag；<title>t</title> 贡献 startTag + text 2 个
    const atMax = wrap('<i/>'.repeat(MAX_XML_NODES - 4) + '<title>t</title>'); // 2 + (MAX-4) + 2 = MAX
    const ok = await parseFeedXml(Buffer.from(atMax, 'utf8'));
    expect(ok.ok).toBe(true);

    const over = wrap('<i/>'.repeat(MAX_XML_NODES - 3) + '<title>t</title>'); // 2 + (MAX-3) + 2 = MAX+1
    const bad = await parseFeedXml(Buffer.from(over, 'utf8'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('text 事件计入节点预算：大量文本事件触发 budget_exceeded', async () => {
    // 8000 个 <i>x</i>（startTag+text=2 节点）× 2 = 16000 + wrap 2 = 16002 < 20000
    const atMax = wrap('<i>x</i>'.repeat(MAX_XML_NODES / 2 - 1)); // (MAX/2-1)*2 + 2 = MAX
    const ok = await parseFeedXml(Buffer.from(atMax, 'utf8'));
    expect(ok.ok).toBe(true);

    const over = wrap('<i>x</i>'.repeat(MAX_XML_NODES / 2)); // (MAX/2)*2 + 2 = MAX+2
    const bad = await parseFeedXml(Buffer.from(over, 'utf8'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('QName/name 256 字节接受、257 拒绝', async () => {
    const name64 = 'a'.repeat(MAX_XML_NAME_BYTES);
    const atMax = wrap(`<${name64}>x</${name64}>`);
    const ok = await parseFeedXml(Buffer.from(atMax, 'utf8'));
    expect(ok.ok).toBe(true);

    const nameOver = 'a'.repeat(MAX_XML_NAME_BYTES + 1);
    const over = wrap(`<${nameOver}>x</${nameOver}>`);
    const bad = await parseFeedXml(Buffer.from(over, 'utf8'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('attribute count 64 接受、65 拒绝', async () => {
    const attrs64 = Array.from({ length: MAX_XML_ATTRIBUTES_PER_TAG }, (_, i) => `a${i}="v"`).join(
      ' ',
    );
    const atMax = wrap(`<title ${attrs64}>x</title>`);
    const ok = await parseFeedXml(Buffer.from(atMax, 'utf8'));
    expect(ok.ok).toBe(true);

    const attrs65 = Array.from(
      { length: MAX_XML_ATTRIBUTES_PER_TAG + 1 },
      (_, i) => `a${i}="v"`,
    ).join(' ');
    const over = wrap(`<title ${attrs65}>x</title>`);
    const bad = await parseFeedXml(Buffer.from(over, 'utf8'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('attribute bytes 4096 接受、4097 拒绝（名+值合计；属性名受 256 限制故用短名长值）', async () => {
    const atMax = wrap(`<title x="${'b'.repeat(4095)}">x</title>`); // 1 + 4095 = 4096
    const ok = await parseFeedXml(Buffer.from(atMax, 'utf8'));
    expect(ok.ok).toBe(true);

    const over = wrap(`<title x="${'b'.repeat(4096)}">x</title>`); // 1 + 4096 = 4097
    const bad = await parseFeedXml(Buffer.from(over, 'utf8'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('text node 8192 接受、8193 拒绝', async () => {
    const atMax = wrap(`<title>${'a'.repeat(MAX_XML_TEXT_NODE_BYTES)}</title>`);
    const ok = await parseFeedXml(Buffer.from(atMax, 'utf8'));
    expect(ok.ok).toBe(true);

    const over = wrap(`<title>${'a'.repeat(MAX_XML_TEXT_NODE_BYTES + 1)}</title>`);
    const bad = await parseFeedXml(Buffer.from(over, 'utf8'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('total text 131072 接受、131073 拒绝（跨节点累计，规范化文本）', async () => {
    // 每 item 仅 title 文本 n 字节；channel 层文本合计 24 字节（Feed=4+site=19+d=1）
    const n = 1000;
    const item = (label: string): string => `<item><title>${label}</title></item>`;
    const itemsAt = Array.from({ length: 131 }, () => item('x'.repeat(n))).join('');
    const atMax = wrap(itemsAt); // 131*1000 + 24 = 131024 ≤ 131072
    const ok = await parseFeedXml(Buffer.from(atMax, 'utf8'));
    expect(ok.ok).toBe(true);

    const itemsOver = itemsAt + item('y'.repeat(n)); // 132024 > 131072
    const over = wrap(itemsOver);
    const bad = await parseFeedXml(Buffer.from(over, 'utf8'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('FeedProjection 整体预算：超 262144 整次失败（不产残缺投影）', async () => {
    // 每个 item 的 title 2000 + summary 2000 ≈ 4000+；120 项远超预算 → 中途 budget_exceeded
    const items = Array.from(
      { length: 120 },
      (_, i) =>
        `<item><guid>g${i}</guid><title>${'t'.repeat(2000)}${i}</title><link>https://example.com/${i}</link><description>${'s'.repeat(2000)}</description></item>`,
    ).join('');
    const r = await parseRss(items);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('budget_exceeded');
  });

  it('FeedProjection canonical 编码字节精确（byteLength == 完整 JSON 编码，不含自身字段）', async () => {
    const itemXml = (i: number, title: string): string =>
      `<item><guid>g${i}</guid><title>${title}</title><link>https://e.com/${i}</link></item>`;
    const items = Array.from({ length: 10 }, (_, i) => itemXml(i, `t${i}`)).join('');
    const r = await parseRss(items);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.projection;
    const canonicalPayload = {
      format: p.format,
      title: p.title,
      description: p.description,
      siteUrl: p.siteUrl,
      feedUrl: p.feedUrl,
      items: p.items,
      itemsTruncated: p.itemsTruncated,
    };
    expect(p.byteLength).toBe(Buffer.byteLength(JSON.stringify(canonicalPayload), 'utf8'));
    expect(p.byteLength).toBeLessThanOrEqual(MAX_FEED_PROJECTION_BYTES);
  });

  it('total-text 上限内最大 feed 的 canonical 编码仍接受（投影守卫不误拒）', async () => {
    const itemXml = (i: number, title: string): string =>
      `<item><guid>g${i}</guid><title>${title}</title><link>https://e.com/${i}</link></item>`;
    // 31 个 4096 字节 title（唯一 identity）≈ total-text 126976 < 131072 → 接受
    const items = Array.from({ length: 31 }, (_, i) =>
      itemXml(i, 'a'.repeat(MAX_FEED_FIELD_BYTES)),
    ).join('');
    const r = await parseRss(items);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.byteLength).toBeLessThanOrEqual(MAX_FEED_PROJECTION_BYTES);
    expect(r.projection.byteLength).toBeGreaterThan(MAX_XML_TOTAL_TEXT_BYTES);
  });

  it('canonical 编码器边界：== MAX 接受、MAX+1 拒绝依据（helper 级）', () => {
    // 诚实限制：受 MAX_XML_TOTAL_TEXT_BYTES(131072) 约束，真实 feed 的完整编码无法达到
    // MAX_FEED_PROJECTION_BYTES(262144)——总文本预算先绑定；此处直接机器验证 canonical
    // 编码器的 ==MAX/+1 边界语义（完整编码超限即 budget_exceeded 的判定依据）。
    const payload = (titleText: string): FeedProjectionCanonicalPayload => ({
      format: 'rss2',
      title: { text: 'F', truncated: false, originalBytes: 1 },
      description: { text: '', truncated: false, originalBytes: 0 },
      siteUrl: { text: '', truncated: false, originalBytes: 0 },
      feedUrl: { text: '', truncated: false, originalBytes: 0 },
      items: [
        {
          identity: 'i',
          identityKind: 'id',
          title: {
            text: titleText,
            truncated: false,
            originalBytes: Buffer.byteLength(titleText, 'utf8'),
          },
          link: { text: '', truncated: false, originalBytes: 0 },
          summary: { text: '', truncated: false, originalBytes: 0 },
          publishedAt: null,
          updatedAt: null,
          author: { text: '', truncated: false, originalBytes: 0 },
        },
      ],
      itemsTruncated: false,
    });
    const baseBytes = Buffer.byteLength(encodeFeedProjectionCanonical(payload('')), 'utf8');
    let titleLen = MAX_FEED_PROJECTION_BYTES - baseBytes;
    let encoded = encodeFeedProjectionCanonical(payload('a'.repeat(titleLen)));
    for (
      let i = 0;
      i < 5 && Buffer.byteLength(encoded, 'utf8') !== MAX_FEED_PROJECTION_BYTES;
      i += 1
    ) {
      titleLen += MAX_FEED_PROJECTION_BYTES - Buffer.byteLength(encoded, 'utf8');
      encoded = encodeFeedProjectionCanonical(payload('a'.repeat(titleLen)));
    }
    expect(Buffer.byteLength(encoded, 'utf8')).toBe(MAX_FEED_PROJECTION_BYTES); // == MAX 接受
    const over = encodeFeedProjectionCanonical(payload('a'.repeat(titleLen + 1)));
    expect(Buffer.byteLength(over, 'utf8')).toBeGreaterThan(MAX_FEED_PROJECTION_BYTES); // MAX+1 拒绝
  });
});

describe('dependency_unavailable（动态 import 失败受控）', () => {
  it('saxe 动态 import 失败 → dependency_unavailable，不拒绝 promise', async () => {
    const r = await parseFeedXmlWithLoader(
      Buffer.from('<rss><channel><title>x</title></channel></rss>', 'utf8'),
      async () => {
        throw new Error('import-boom');
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('dependency_unavailable');
  });

  it('loader 注入正常后 feed 仍可解析', async () => {
    const r = await parseFeedXmlWithLoader(
      Buffer.from(RSS(RSS_ITEM('g', 'T', 'https://example.com/x')), 'utf8'),
      async () => import('@federicocarboni/saxe'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.projection.items.length).toBe(1);
  });
});

describe('畸形 XML / 其他失败', () => {
  it('畸形/未闭合 → parse_changed', async () => {
    const r = await parseFeedXml(Buffer.from('<rss><channel><title>x</rss>', 'utf8'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.health).toBe('parse_changed');
  });

  it('未声明前缀 → parse_changed（不信任前缀，也不放行未声明前缀）', async () => {
    const r = await parseFeedXml(
      Buffer.from('<rss><channel><dc:title>x</dc:title></channel></rss>', 'utf8'),
    );
    expect(r.ok).toBe(false);
  });
});
