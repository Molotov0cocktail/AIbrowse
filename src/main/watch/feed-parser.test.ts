// D3 feed-parser tests: RSS2/Atom/namespace/CDATA/encoding、identity 去重、200 项截断、
// 字段截断、DTD/XXE/bomb、depth/name/attr/text/node/total/projection 边界
// （detailed-design §6.4、threat-model WRT-06～WRT-08）。
import { describe, expect, it } from 'vitest';
import {
  MAX_FEED_FIELD_BYTES,
  MAX_FEED_ITEMS,
  MAX_FEED_PROJECTION_BYTES,
  MAX_FEED_RESPONSE_BYTES,
  MAX_XML_ATTRIBUTE_BYTES,
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

type FeedBomEncoding = 'utf-8' | 'utf-16le' | 'utf-16be';

function feedBomBytes(text: string, encoding: FeedBomEncoding, bomCount: number): Buffer {
  const bom = Buffer.from(
    encoding === 'utf-8'
      ? [0xef, 0xbb, 0xbf]
      : encoding === 'utf-16le'
        ? [0xff, 0xfe]
        : [0xfe, 0xff],
  );
  const encoded = Buffer.from(text, encoding === 'utf-8' ? 'utf8' : 'utf16le');
  if (encoding === 'utf-16be') encoded.swap16();
  return Buffer.concat([...Array.from({ length: bomCount }, () => bom), encoded]);
}

describe('RSS 2.0 / Atom 基本解析与格式识别', () => {
  it('RSS2 基本投影', async () => {
    const r = await parseRss(RSS_ITEM('g1', 'T1', 'https://example.com/a'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value;
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
    expect(r.byteLength).toBeGreaterThan(0);
  });

  it('Atom 基本投影与 format=atom', async () => {
    const r = await parseFeedXml(
      Buffer.from(ATOM(ATOM_ENTRY('urn:uuid:1', 'A', 'https://example.com/1')), 'utf8'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value;
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

describe('XML BOM 精确移除一次', () => {
  it.each([
    ['utf-8', 'UTF-8'],
    ['utf-16le', 'UTF-16LE'],
    ['utf-16be', 'UTF-16BE'],
  ] as const)(
    '%s single BOM + 完整一致声明成功，double/triple BOM 零投影拒绝',
    async (encoding, label) => {
      const xml = `<?xml version="1.0" encoding="${label}"?><rss><channel><title>Feed</title><item><guid>g</guid><title>ok</title></item></channel></rss>`;
      const single = await parseFeedXml(feedBomBytes(xml, encoding, 1));
      expect(single.ok).toBe(true);
      if (single.ok) expect(single.value.items[0]!.title.text).toBe('ok');

      for (const count of [2, 3]) {
        const rejected = await parseFeedXml(feedBomBytes(xml, encoding, count));
        expect(rejected).toMatchObject({ ok: false, health: 'parse_changed' });
        expect('value' in rejected).toBe(false);
        expect('byteLength' in rejected).toBe(false);
      }
    },
  );
});

describe('namespace：URI+localName 不信任前缀', () => {
  it('Atom 前缀绑定不同不影响识别', async () => {
    const xml =
      '<?xml version="1.0"?><a:feed xmlns:a="http://www.w3.org/2005/Atom" xmlns:x="http://evil.test/x"><a:title>T</a:title><a:entry><a:id>i1</a:id><a:title>E</a:title><a:link rel="alternate" href="https://example.com/e"/></a:entry><x:entry><x:id>bad</x:id></x:entry></a:feed>';
    const r = await parseFeedXml(Buffer.from(xml, 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBe(1); // 只认 ATOM_NS 的 entry
  });

  it('带 dc/content 模块命名空间的 RSS 正常解析', async () => {
    const xml =
      '<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>T</title><item><guid>g</guid><title>X</title><link>https://example.com/x</link><dc:creator>me</dc:creator><content:encoded>&lt;p&gt;html&lt;/p&gt;</content:encoded></item></channel></rss>';
    const r = await parseFeedXml(Buffer.from(xml, 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items[0]!.title.text).toBe('X');
  });
});

describe('CDATA / 编码', () => {
  it('CDATA 内容保留', async () => {
    const r = await parseRss(RSS_ITEM('g', '<![CDATA[<b>& raw]]>', 'https://example.com/x'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items[0]!.title.text).toBe('<b>& raw');
  });

  it('UTF-16LE BOM 解码', async () => {
    const xml = RSS(RSS_ITEM('g', '中文', 'https://example.com/x')).replace(
      'encoding="UTF-8"',
      'encoding="UTF-16LE"',
    );
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    const r = await parseFeedXml(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items[0]!.title.text).toBe('中文');
  });

  it('UTF-16LE BOM 与 UTF-8 声明冲突时拒绝', async () => {
    const xml = RSS(RSS_ITEM('g', '中文', 'https://example.com/x'));
    const result = await parseFeedXml(
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.health).toBe('parse_changed');
  });

  it('无 BOM UTF-16 且无可识别一致声明时拒绝', async () => {
    for (const body of [
      Buffer.from('<rss><channel/></rss>', 'utf16le'),
      Buffer.from('<rss><channel/></rss>', 'utf16le').swap16(),
    ]) {
      const result = await parseFeedXml(body);
      expect(result).toMatchObject({ ok: false, health: 'parse_changed' });
    }
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
    expect(r.value.title.text).toBe('café');
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
    expect(r.value.items[0]!.identity).toBe('https://example.com/a');
    expect(r.value.items[0]!.identityKind).toBe('link');
  });

  it('无 id/guid/link 但 title+published 齐全 → 受控复合键（SHA-256）', async () => {
    const r = await parseRss(
      `<item><title>T1</title><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>`,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.value.items[0]!;
    expect(item.identityKind).toBe('composite');
    expect(item.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(item.identity).toBe(item.identity);
  });

  it('无 id/guid/link 且复合键字段全缺 → 丢弃该 item', async () => {
    const r = await parseRss('<item></item>');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBe(0);
  });

  it('重复 identity 去重稳定（first-wins，文档序）', async () => {
    const r = await parseRss(
      RSS_ITEM('dup', 'FIRST', 'https://example.com/1') +
        RSS_ITEM('dup', 'SECOND', 'https://example.com/2'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBe(1);
    expect(r.value.items[0]!.title.text).toBe('FIRST');
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
    expect(r.value.items.length).toBe(MAX_FEED_ITEMS);
    expect(r.value.itemsTruncated).toBe(true);
    expect(r.value.items[0]!.identity).toBe('g0');
    expect(r.value.items[MAX_FEED_ITEMS - 1]!.identity).toBe(`g${MAX_FEED_ITEMS - 1}`);
  });

  it('恰好 200 项 → 不标记', async () => {
    const items = Array.from({ length: 200 }, (_, i) =>
      RSS_ITEM(`g${i}`, `t`, `https://example.com/`),
    ).join('');
    const r = await parseRss(items);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.length).toBe(200);
    expect(r.value.itemsTruncated).toBe(false);
  });
});

describe('字段 UTF-8 安全截断（4096）', () => {
  it('title 超 4096 字节 → truncated=true 且 originalBytes 记录', async () => {
    const long = '中'.repeat(2000); // 6000 字节
    const r = await parseRss(RSS_ITEM('g', long, 'https://example.com/x'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.value.items[0]!;
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
    expect(r.value.items[0]!.title.truncated).toBe(false);
    expect(r.value.items[0]!.title.text).toBe(exact);
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

  it('XInclude namespace 声明值经 character reference 解码后仍拒绝', async () => {
    const doc =
      '<rss xmlns:xi="&#104;ttp://www.w3.org/2001/XInclude"><channel><title>x</title></channel></rss>';
    const result = await parseFeedXml(Buffer.from(doc));
    expect(result).toMatchObject({ ok: false, health: 'security_rejected' });
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
  it.each(['rss', 'channel', 'item', 'title', 'guid', 'link', 'description'])(
    'RSS：%s 显式清空默认 namespace 与未声明语义相同',
    async (element) => {
      const original = RSS(
        RSS_ITEM('g1', 'First', 'https://example.com/1') +
          RSS_ITEM('g2', 'Second', 'https://example.com/2'),
      );
      const explicit = original.replace(
        new RegExp(`<${element}(?=[\\s>])`, 'g'),
        `<${element} xmlns=""`,
      );
      const expected = await parseFeedXml(Buffer.from(original));
      expect(expected.ok).toBe(true);
      expect(await parseFeedXml(Buffer.from(explicit))).toEqual(expected);
    },
  );

  it('RSS：非空默认 namespace 的同名 item 不得成为条目，离开作用域后恢复', async () => {
    const r = await parseRss(
      '<item xmlns="urn:foreign"><guid>fake</guid><title>Fake</title></item>' +
        RSS_ITEM('real', 'Real', 'https://example.com/real').replace('<item>', '<item xmlns="">') +
        RSS_ITEM('next', 'Next', 'https://example.com/next'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.map((item) => item.identity)).toEqual(['real', 'next']);
  });

  it('Atom：清空 namespace 的 entry 仍不属于 Atom，兄弟节点恢复 Atom namespace', async () => {
    const r = await parseFeedXml(
      Buffer.from(
        ATOM(
          '<entry xmlns=""><id>fake</id><title>Fake</title></entry>' +
            ATOM_ENTRY('real', 'Real', 'https://example.com/real'),
        ),
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items.map((item) => item.identity)).toEqual(['real']);
  });

  it('Atom：foreign namespace 的 title/link/id 不覆盖核心字段', async () => {
    const xml =
      '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:x="http://evil.test/x"><title>F</title><x:title>FAKE TITLE</x:title><entry><id>real-id</id><x:id>fake-id</x:id><title>Real T</title><x:title>FAKE</x:title><link rel="alternate" href="https://real.example.com/1"/><x:link rel="alternate" href="https://evil.example.com/"/></entry></feed>';
    const r = await parseFeedXml(Buffer.from(xml, 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.title.text).toBe('F');
    const item = r.value.items[0]!;
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
    expect(r.value.title.text).toBe('F');
    const item = r.value.items[0]!;
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
    expect(r.value.items[0]!.summary.text).toBe('Hello world & more');
  });

  it('RSS description 转义 HTML → 纯文本', async () => {
    const r = await parseRss(itemWith('&lt;p&gt;a &lt;b&gt;b&lt;/b&gt;&lt;/p&gt;'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items[0]!.summary.text).toBe('a b');
  });

  it('Atom content type=html → 纯文本', async () => {
    const entry =
      '<entry><id>id1</id><title>T</title><link rel="alternate" href="https://example.com/1"/><content type="html">&lt;p&gt;a &lt;b&gt;b&lt;/b&gt;&lt;/p&gt;</content></entry>';
    const r = await parseFeedXml(Buffer.from(ATOM(entry), 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items[0]!.summary.text).toBe('a b');
  });

  it('script/style 块从 description 整体移除', async () => {
    const r = await parseRss(
      itemWith('<![CDATA[<script>alert("x")</script>keep <b>bold</b><style>.c{}</style>]]>'),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.items[0]!.summary.text).toBe('keep bold');
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
    const atMax = wrap(`<title x="${'b'.repeat(MAX_XML_ATTRIBUTE_BYTES - 1)}">x</title>`);
    const ok = await parseFeedXml(Buffer.from(atMax, 'utf8'));
    expect(ok.ok).toBe(true);

    const over = wrap(`<title x="${'b'.repeat(MAX_XML_ATTRIBUTE_BYTES)}">x</title>`);
    const bad = await parseFeedXml(Buffer.from(over, 'utf8'));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.health).toBe('budget_exceeded');
  });

  it('每个属性独立计量：两个各 2049 字节的合法属性都接受', async () => {
    const perAttributeBytes = 2_049;
    const attrs = ['x', 'y']
      .map((name) => `${name}="${'b'.repeat(perAttributeBytes - utf8ByteLength(name))}"`)
      .join(' ');
    const result = await parseFeedXml(Buffer.from(wrap(`<title ${attrs}>x</title>`), 'utf8'));

    expect(result.ok).toBe(true);
  });

  it('每个属性独立计量：三个各 4096 字节的合法属性都接受', async () => {
    const attrs = ['x', 'y', 'z']
      .map((name) => `${name}="${'b'.repeat(MAX_XML_ATTRIBUTE_BYTES - utf8ByteLength(name))}"`)
      .join(' ');
    const result = await parseFeedXml(Buffer.from(wrap(`<title ${attrs}>x</title>`), 'utf8'));

    expect(result.ok).toBe(true);
  });

  it('64 个各自合法且聚合超过依赖默认上限的属性接受', async () => {
    const attrs = Array.from({ length: MAX_XML_ATTRIBUTES_PER_TAG }, (_, index) => {
      const name = `a${index}`;
      return `${name}="${'b'.repeat(MAX_XML_ATTRIBUTE_BYTES - utf8ByteLength(name))}"`;
    }).join(' ');
    const result = await parseFeedXml(Buffer.from(wrap(`<title ${attrs}>x</title>`), 'utf8'));

    expect(result.ok).toBe(true);
  });

  it('多字节属性按 UTF-8 名值字节精确接受 4096、拒绝 4097', async () => {
    const exactValue = '界'.repeat(1_365);
    expect(utf8ByteLength('x') + utf8ByteLength(exactValue)).toBe(MAX_XML_ATTRIBUTE_BYTES);
    const exact = await parseFeedXml(
      Buffer.from(wrap(`<title x="${exactValue}">x</title>`), 'utf8'),
    );
    expect(exact.ok).toBe(true);

    const overValue = `${exactValue}a`;
    expect(utf8ByteLength('x') + utf8ByteLength(overValue)).toBe(MAX_XML_ATTRIBUTE_BYTES + 1);
    const over = await parseFeedXml(Buffer.from(wrap(`<title x="${overValue}">x</title>`), 'utf8'));
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.health).toBe('budget_exceeded');
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
    // JSON escaping makes the canonical projection limit reachable while XML
    // text remains below its independent 131072-byte limit.
    const items = Array.from(
      { length: MAX_FEED_ITEMS },
      (_, i) =>
        `<item><guid>g${i}</guid><title>${'\\'.repeat(300)}</title><description>${'\\'.repeat(300)}</description></item>`,
    ).join('');
    const r = await parseRss(items);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.health).toBe('budget_exceeded');
      expect(r.reason).toBe('projection');
    }
  });

  it('FeedProjection canonical 编码字节精确（byteLength == 完整 JSON 编码，不含自身字段）', async () => {
    const itemXml = (i: number, title: string): string =>
      `<item><guid>g${i}</guid><title>${title}</title><link>https://e.com/${i}</link></item>`;
    const items = Array.from({ length: 10 }, (_, i) => itemXml(i, `t${i}`)).join('');
    const r = await parseRss(items);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.value;
    const canonicalPayload = {
      type: 'feed',
      format: p.format,
      title: p.title,
      description: p.description,
      siteUrl: p.siteUrl,
      feedUrl: p.feedUrl,
      items: p.items,
      itemsTruncated: p.itemsTruncated,
    };
    expect(r.byteLength).toBe(Buffer.byteLength(JSON.stringify(canonicalPayload), 'utf8'));
    expect(r.byteLength).toBeLessThanOrEqual(MAX_FEED_PROJECTION_BYTES);
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
    expect(r.byteLength).toBeLessThanOrEqual(MAX_FEED_PROJECTION_BYTES);
    expect(r.byteLength).toBeGreaterThan(MAX_XML_TOTAL_TEXT_BYTES);
  });

  it('canonical 编码器边界：== MAX 接受、MAX+1 拒绝依据（helper 级）', () => {
    // The real parser branch above proves reachability through JSON escaping;
    // this helper isolates the canonical encoder's exact byte boundary.
    const payload = (titleText: string): FeedProjectionCanonicalPayload => ({
      type: 'feed',
      format: 'rss2',
      title: { text: 'F', truncated: false, originalBytes: 1, valueHash: 'h1' },
      description: { text: '', truncated: false, originalBytes: 0, valueHash: 'h2' },
      siteUrl: { text: '', truncated: false, originalBytes: 0, valueHash: 'h3' },
      feedUrl: { text: '', truncated: false, originalBytes: 0, valueHash: 'h4' },
      items: [
        {
          identity: 'i',
          identityKind: 'id',
          title: {
            text: titleText,
            truncated: false,
            originalBytes: Buffer.byteLength(titleText, 'utf8'),
            valueHash: 'h5',
          },
          link: { text: '', truncated: false, originalBytes: 0, valueHash: 'h6' },
          summary: { text: '', truncated: false, originalBytes: 0, valueHash: 'h7' },
          publishedAt: null,
          updatedAt: null,
          author: { text: '', truncated: false, originalBytes: 0, valueHash: 'h8' },
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

describe('XML 精确名称、namespace 与属性预算（detailed-design §6.4.1）', () => {
  const wrap = (inner: string): string => `<rss><channel>${inner}</channel></rss>`;
  const resultIsBudget = async (xml: string): Promise<void> => {
    const result = await parseFeedXml(Buffer.from(xml));
    expect(result).toMatchObject({ ok: false, health: 'budget_exceeded' });
  };

  it('元素与属性完整 QName 各自按 UTF-8 计量 256/257（含冒号）', async () => {
    const local256 = `${'界'.repeat(84)}aa`; // p: + 254-byte localName = 256-byte QName
    const local257 = `${'界'.repeat(84)}aaa`;
    expect(utf8ByteLength(`p:${local256}`)).toBe(MAX_XML_NAME_BYTES);
    expect(utf8ByteLength(`p:${local257}`)).toBe(MAX_XML_NAME_BYTES + 1);

    expect(
      (await parseFeedXml(Buffer.from(wrap(`<p:${local256} xmlns:p="u"></p:${local256}>`)))).ok,
    ).toBe(true);
    await resultIsBudget(wrap(`<p:${local257} xmlns:p="u"></p:${local257}>`));

    expect(
      (await parseFeedXml(Buffer.from(wrap(`<n xmlns:p="u" p:${local256}=""><x/></n>`)))).ok,
    ).toBe(true);
    await resultIsBudget(wrap(`<n xmlns:p="u" p:${local257}=""><x/></n>`));
  });

  it('短 QName 与 namespace URI 各自独立 256 接受、257 拒绝（used/unused/default/prefixed）', async () => {
    const uri256 = 'u'.repeat(MAX_XML_NAME_BYTES);
    const uri257 = `${uri256}u`;
    const documents = (uri: string): string[] => [
      wrap(`<p:n xmlns:p="${uri}"/>`),
      wrap(`<n xmlns:p="${uri}"/>`),
      wrap(`<n xmlns="${uri}"/>`),
      wrap(`<n xmlns:p="${uri}" p:a="v"/>`),
    ];
    for (const xml of documents(uri256))
      expect((await parseFeedXml(Buffer.from(xml))).ok).toBe(true);
    for (const xml of documents(uri257)) await resultIsBudget(xml);

    const decoded256 = `u${'&#117;'.repeat(MAX_XML_NAME_BYTES - 1)}`;
    const decoded257 = `${decoded256}&#117;`;
    expect((await parseFeedXml(Buffer.from(wrap(`<n xmlns:p="${decoded256}"/>`)))).ok).toBe(true);
    await resultIsBudget(wrap(`<n xmlns:p="${decoded257}"/>`));
  });

  it('活动 namespace 以 binding record 计量：201 与 64 层各 64 个重绑定均通过', async () => {
    const attrsFor = (depth: number): string =>
      Array.from(
        { length: MAX_XML_ATTRIBUTES_PER_TAG },
        (_, index) => `xmlns:p${index}="urn:${depth}:${index}"`,
      ).join(' ');
    const twoHundredOne =
      `<rss ${attrsFor(0)}><n ${attrsFor(1)}><n ${attrsFor(2)}>` +
      `<n ${Array.from({ length: 9 }, (_, index) => `xmlns:q${index}="u${index}"`).join(' ')}/>` +
      '</n></n></rss>';
    expect((await parseFeedXml(Buffer.from(twoHundredOne))).ok).toBe(true);

    let nested = '';
    for (let depth = 0; depth < MAX_XML_DEPTH; depth += 1) {
      nested += `<${depth === 0 ? 'rss' : 'n'} ${attrsFor(depth)}>`;
    }
    nested += '</n>'.repeat(MAX_XML_DEPTH - 1) + '</rss>';
    expect((await parseFeedXml(Buffer.from(nested))).ok).toBe(true);
  });

  it('namespace 声明计入 attrs.size：64 接受、65 拒绝', async () => {
    const declarations = (count: number): string =>
      Array.from({ length: count }, (_, index) => `xmlns:p${index}="urn:${index}"`).join(' ');
    expect(
      (await parseFeedXml(Buffer.from(wrap(`<n ${declarations(MAX_XML_ATTRIBUTES_PER_TAG)}/>`))))
        .ok,
    ).toBe(true);
    await resultIsBudget(wrap(`<n ${declarations(MAX_XML_ATTRIBUTES_PER_TAG + 1)}/>`));
  });

  it('64 个属性各自允许 4096 解码字节，numeric reference 不绕过单属性预算', async () => {
    const attrs = Array.from({ length: MAX_XML_ATTRIBUTES_PER_TAG }, (_, index) => {
      const name = `a${index}`;
      return `${name}="${'x'.repeat(MAX_XML_ATTRIBUTE_BYTES - utf8ByteLength(name))}"`;
    }).join(' ');
    expect((await parseFeedXml(Buffer.from(wrap(`<n ${attrs}/>`)))).ok).toBe(true);

    const decodedAtMax = `a="${'&#120;'.repeat(MAX_XML_ATTRIBUTE_BYTES - 1)}"`;
    const decodedOver = `a="${'&#120;'.repeat(MAX_XML_ATTRIBUTE_BYTES)}"`;
    expect((await parseFeedXml(Buffer.from(wrap(`<n ${decodedAtMax}/>`)))).ok).toBe(true);
    await resultIsBudget(wrap(`<n ${decodedOver}/>`));
  });
});

describe('XML 逻辑文本、lexical 边界与原始 SAX 事件（detailed-design §6.4.2）', () => {
  const wrap = (inner: string): string => `<rss><channel>${inner}</channel></rss>`;
  const title = (inner: string): string => wrap(`<title>${inner}</title>`);
  const expectBudget = async (xml: string): Promise<void> => {
    const result = await parseFeedXml(Buffer.from(xml));
    expect(result).toMatchObject({ ok: false, health: 'budget_exceeded', reason: 'budget' });
  };

  it('ordinary/CDATA 的 ASCII 与多字节逻辑节点各自执行 8192/8193 UTF-8 边界', async () => {
    const exactMultibyte = `${'界'.repeat(2_730)}aa`;
    const overMultibyte = `${exactMultibyte}a`;
    expect(utf8ByteLength(exactMultibyte)).toBe(MAX_XML_TEXT_NODE_BYTES);
    for (const content of ['a'.repeat(MAX_XML_TEXT_NODE_BYTES), exactMultibyte]) {
      expect((await parseFeedXml(Buffer.from(title(content)))).ok).toBe(true);
      expect((await parseFeedXml(Buffer.from(title(`<![CDATA[${content}]]>`)))).ok).toBe(true);
    }
    for (const content of ['a'.repeat(MAX_XML_TEXT_NODE_BYTES + 1), overMultibyte]) {
      await expectBudget(title(content));
      await expectBudget(title(`<![CDATA[${content}]]>`));
    }
  });

  it('XML 行尾解码后 8192 接受；numeric/predefined refs 仍属于同一逻辑节点', async () => {
    const raw8193Decoded8192 = `${'a'.repeat(MAX_XML_TEXT_NODE_BYTES - 1)}\r\n`;
    expect(utf8ByteLength(raw8193Decoded8192)).toBe(MAX_XML_TEXT_NODE_BYTES + 1);
    expect((await parseFeedXml(Buffer.from(title(raw8193Decoded8192)))).ok).toBe(true);

    const numericExact = `${'a'.repeat(4_095)}&#65;${'b'.repeat(4_096)}`;
    const numericOver = `${numericExact}b`;
    expect((await parseFeedXml(Buffer.from(title(numericExact)))).ok).toBe(true);
    await expectBudget(title(numericOver));

    expect(
      (await parseFeedXml(Buffer.from(title('&amp;'.repeat(MAX_XML_TEXT_NODE_BYTES))))).ok,
    ).toBe(true);
    await expectBudget(title('&amp;'.repeat(MAX_XML_TEXT_NODE_BYTES + 1)));
  });

  it('CDATA、元素、comment 与 PI 都在栈变化前结算独立逻辑节点', async () => {
    const a = 'a'.repeat(MAX_XML_TEXT_NODE_BYTES);
    const b = 'b'.repeat(MAX_XML_TEXT_NODE_BYTES);
    for (const inner of [
      `${a}<![CDATA[${b}]]>`,
      `<![CDATA[${a}]]><![CDATA[${b}]]>`,
      `${a}<n>${b}</n>`,
      `${a}<!--ignored-->${b}`,
      `${a}<?p ignored?>${b}`,
    ]) {
      expect((await parseFeedXml(Buffer.from(title(inner)))).ok).toBe(true);
    }
  });

  it('完整逻辑节点统一 normalize 后累计 131072/131073，不逐 reference trim', async () => {
    const node = `<n>${'a'.repeat(4_095)} &#65;${'b'.repeat(4_095)}</n>`;
    const exact = wrap(node.repeat(16));
    expect((await parseFeedXml(Buffer.from(exact))).ok).toBe(true);
    await expectBudget(wrap(`${node.repeat(16)}<n>x</n>`));
  });

  it('等价字符/reference 产生相同规范化字段、identity 与 valueHash', async () => {
    const plain = await parseRss(RSS_ITEM('same', 'A &amp; e&#x301;', 'https://example.com/same'));
    const references = await parseRss(
      RSS_ITEM('&#115;ame', '&#65; &#38; &#xE9;', 'https://example.com/same'),
    );
    expect(plain.ok).toBe(true);
    expect(references.ok).toBe(true);
    if (!plain.ok || !references.ok) return;
    expect(references.value).toEqual(plain.value);
    expect(references.canonicalJson).toBe(plain.canonicalJson);
    expect(references.value.items[0]!.title.valueHash).toBe(plain.value.items[0]!.title.valueHash);
  });

  it('累计预算包含不投影字段及第 200 项之后的文本', async () => {
    const ignored = `<unknown>${'a'.repeat(MAX_XML_TEXT_NODE_BYTES)}</unknown>`.repeat(16);
    expect((await parseFeedXml(Buffer.from(wrap(ignored)))).ok).toBe(true);
    await expectBudget(wrap(`${ignored}<unknown>x</unknown>`));

    const first200 = Array.from(
      { length: MAX_FEED_ITEMS },
      (_, index) => `<item><guid>g${index}</guid></item>`,
    ).join('');
    await expectBudget(wrap(`${first200}<item><title>${'x'.repeat(8_193)}</title></item>`));
  });

  it('原始 startTag/text 回调恰计 20000，reference 与空 CDATA 回调不漏计', async () => {
    const refs = (count: number): string => `<n>${'&amp;'.repeat(count)}</n>`;
    const exact = wrap(refs(6_665).repeat(3));
    expect((await parseFeedXml(Buffer.from(exact))).ok).toBe(true);
    await expectBudget(wrap(`${refs(6_665).repeat(2)}${refs(6_666)}`));

    expect(
      (await parseFeedXml(Buffer.from(wrap('<![CDATA[]]>'.repeat(MAX_XML_NODES - 2))))).ok,
    ).toBe(true);
    await expectBudget(wrap('<![CDATA[]]>'.repeat(MAX_XML_NODES - 1)));
  });

  it('comment/PI content 不进入文本预算；PI target 256/257 且畸形 lexical 仍由语法拒绝', async () => {
    expect((await parseFeedXml(Buffer.from(wrap(`<!--${'a'.repeat(8_193)}-->`)))).ok).toBe(true);
    expect((await parseFeedXml(Buffer.from(wrap(`<?p ${'a'.repeat(8_193)}?>`)))).ok).toBe(true);
    const target256 = `${'界'.repeat(85)}a`;
    const target257 = `${target256}a`;
    expect(utf8ByteLength(target256)).toBe(MAX_XML_NAME_BYTES);
    expect((await parseFeedXml(Buffer.from(wrap(`<?${target256} x?>`)))).ok).toBe(true);
    await expectBudget(wrap(`<?${target257} x?>`));

    for (const malformed of ['<!--a--b-->', '<?p', '<![CDATA[unterminated']) {
      const result = await parseFeedXml(Buffer.from(wrap(malformed)));
      expect(result).toMatchObject({ ok: false, health: 'parse_changed' });
    }
  });
});

describe('XML 输入、依赖兼容与恢复边界（detailed-design §6.4.3）', () => {
  const wrap = (inner: string): string => `<rss><channel>${inner}</channel></rss>`;
  const declaration = (length: number): string => `<?xml version="1.0"${' '.repeat(length - 21)}?>`;

  it('输入 B 字节接受，B+1 在 decoder/loader/parser 前拒绝', async () => {
    const base = wrap(`<title>${'a'.repeat(MAX_XML_TEXT_NODE_BYTES)}</title><!-- -->`);
    const atMax = base.replace(
      '<!-- ',
      `<!-- ${'x'.repeat(MAX_FEED_RESPONSE_BYTES - Buffer.byteLength(base))}`,
    );
    expect(Buffer.byteLength(atMax)).toBe(MAX_FEED_RESPONSE_BYTES);
    expect((await parseFeedXml(Buffer.from(atMax))).ok).toBe(true);

    let loaderCalls = 0;
    const over = await parseFeedXmlWithLoader(Buffer.from(`${atMax}x`), async () => {
      loaderCalls += 1;
      return import('@federicocarboni/saxe');
    });
    expect(over).toMatchObject({ ok: false, health: 'budget_exceeded', reason: 'budget' });
    expect(loaderCalls).toBe(0);
  });

  it('固定依赖完整 XML declaration 2000 通过、2001 受控 dependency-limit', async () => {
    expect(declaration(2_000).length).toBe(2_000);
    expect((await parseFeedXml(Buffer.from(`${declaration(2_000)}${wrap('')}`))).ok).toBe(true);

    const observations: object[] = [];
    const over = await parseFeedXml(
      Buffer.from(`${declaration(2_001)}${wrap('')}`),
      (observation) => observations.push(observation),
    );
    expect(over).toMatchObject({ ok: false, health: 'budget_exceeded', reason: 'limit' });
    expect(observations).toEqual([
      expect.objectContaining({ outcome: 'dependency-limit', reasonCode: 'limit' }),
    ]);
  });

  it('未知 entity 名称文本/属性 256/257 都安全拒绝且保留公开分类', async () => {
    for (const location of ['text', 'attribute'] as const) {
      for (const length of [MAX_XML_NAME_BYTES, MAX_XML_NAME_BYTES + 1]) {
        const ref = `&${'a'.repeat(length)};`;
        const xml = location === 'text' ? wrap(ref) : wrap(`<n a="${ref}"/>`);
        const observations: object[] = [];
        const result = await parseFeedXml(Buffer.from(xml), (value) => observations.push(value));
        expect(result.ok).toBe(false);
        expect(observations).toEqual([
          expect.objectContaining({
            outcome: length === MAX_XML_NAME_BYTES ? 'security-rejected' : 'dependency-limit',
          }),
        ]);
      }
    }
    expect((await parseFeedXml(Buffer.from(wrap('<title>after</title>')))).ok).toBe(true);
  });
});

describe('H3a 有界预算观察', () => {
  it('成功只记录 input/canonical/item 计数，observer 异常不改变结果', async () => {
    const observations: object[] = [];
    const body = Buffer.from(RSS(RSS_ITEM('g', 'T', 'https://example.com/x')), 'utf8');
    const result = await parseFeedXml(body, (observation) => observations.push(observation));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(observations).toEqual([
      {
        stage: 'feed-parser',
        outcome: 'success',
        reasonCode: 'none',
        inputBytes: body.length,
        canonicalBytes: result.byteLength,
        itemCount: 1,
      },
    ]);
    const withThrowingObserver = await parseFeedXml(body, () => {
      throw new Error('offline observer failure');
    });
    expect(withThrowingObserver).toEqual(result);
  });

  it('项目精确预算与 saxe 依赖粗 guard 使用不同受控原因', async () => {
    const product: object[] = [];
    const productResult = await parseFeedXml(
      Buffer.from(
        `<rss><channel><title x="${'a'.repeat(MAX_XML_ATTRIBUTE_BYTES)}">x</title></channel></rss>`,
      ),
      (observation) => product.push(observation),
    );
    expect(productResult).toMatchObject({ ok: false, reason: 'budget' });
    expect(product).toEqual([
      expect.objectContaining({
        stage: 'feed-parser',
        outcome: 'product-budget',
        reasonCode: 'budget',
        canonicalBytes: null,
        itemCount: null,
      }),
    ]);

    const textProduct: object[] = [];
    const textProductResult = await parseFeedXml(
      Buffer.from(
        `<rss><channel><title>${'a'.repeat(MAX_XML_TEXT_NODE_BYTES + 1)}</title></channel></rss>`,
      ),
      (observation) => textProduct.push(observation),
    );
    expect(textProductResult).toMatchObject({ ok: false, reason: 'budget' });
    expect(textProduct).toEqual([
      expect.objectContaining({ outcome: 'product-budget', reasonCode: 'budget' }),
    ]);

    const dependency: object[] = [];
    const declaration = (length: number): string =>
      `<?xml version="1.0"${' '.repeat(length - 21)}?>`;
    const dependencyResult = await parseFeedXml(
      Buffer.from(`${declaration(2_001)}<rss><channel/></rss>`),
      (observation) => dependency.push(observation),
    );
    expect(dependencyResult).toMatchObject({ ok: false, reason: 'limit' });
    expect(dependency).toEqual([
      expect.objectContaining({
        stage: 'feed-parser',
        outcome: 'dependency-limit',
        reasonCode: 'limit',
        canonicalBytes: null,
        itemCount: null,
      }),
    ]);

    const nativeDepth: object[] = [];
    const depth65 = '<rss>' + '<n>'.repeat(MAX_XML_DEPTH) + '</n>'.repeat(MAX_XML_DEPTH) + '</rss>';
    const depthResult = await parseFeedXml(Buffer.from(depth65), (observation) =>
      nativeDepth.push(observation),
    );
    expect(depthResult).toMatchObject({ ok: false, reason: 'limit' });
    expect(nativeDepth).toEqual([
      expect.objectContaining({ outcome: 'dependency-limit', reasonCode: 'limit' }),
    ]);
  });

  it('canonical projection 超限记录实际计数且不记录字段正文', async () => {
    const observations: object[] = [];
    const items = Array.from(
      { length: MAX_FEED_ITEMS },
      (_, i) =>
        `<item><guid>g${i}</guid><title>${'\\'.repeat(300)}</title><description>${'\\'.repeat(300)}</description></item>`,
    ).join('');
    const body = Buffer.from(RSS(items), 'utf8');
    const result = await parseFeedXml(body, (observation) => observations.push(observation));
    expect(result).toMatchObject({ ok: false, reason: 'projection' });
    expect(observations).toEqual([
      expect.objectContaining({
        stage: 'feed-parser',
        outcome: 'projection-budget',
        reasonCode: 'projection',
        inputBytes: body.length,
        canonicalBytes: expect.any(Number),
        itemCount: MAX_FEED_ITEMS,
      }),
    ]);
    expect(JSON.stringify(observations)).not.toContain('\\\\\\\\');
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
    expect(r.value.items.length).toBe(1);
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
