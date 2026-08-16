// 决议 #148/#152：shared Markdown 安全子集解析器矩阵——
// 全部允许语法 / Markdown 表格不解析（决议 #99）/ raw HTML 纯文本 /
// 危险链接降级 / 未闭合标记字面化 / 有界性 / 确定性 / 输入不变。
import { describe, expect, it } from 'vitest';
import { MARKDOWN_MAX_AST_NODES, MAX_MARKDOWN_BLOCK_CHARS } from '../types/research';
import { collectMarkdownLinks, parseMarkdown, type MarkdownDocument } from './parse-markdown';

// 辅助：块节点列表（降级时单段落原文）
function blocks(doc: MarkdownDocument): unknown[] {
  return doc.children;
}

describe('parseMarkdown（决议 #148/#152 子集矩阵）', () => {
  // ---------- 块级语法 ----------

  it('heading 1–3（# 后须空格或行尾）', () => {
    const doc = parseMarkdown('# 标题一\n## 标题二\n### 标题三\n');
    expect(doc.degraded).toBe(false);
    expect(blocks(doc)).toEqual([
      { kind: 'heading', level: 1, children: [{ kind: 'text', value: '标题一' }] },
      { kind: 'heading', level: 2, children: [{ kind: 'text', value: '标题二' }] },
      { kind: 'heading', level: 3, children: [{ kind: 'text', value: '标题三' }] },
    ]);
    // 行尾形态（# 后无内容）
    expect(blocks(parseMarkdown('#\n')).map((b) => (b as { kind: string }).kind)).toEqual([
      'heading',
    ]);
    // 无空格 '#标题' 按决议 #152(1) 为普通段落（须空格或行尾）
    const noSpace = parseMarkdown('#标题\n');
    expect((blocks(noSpace)[0] as { kind: string }).kind).toBe('paragraph');
    // #### 4 级不解析为 heading（段落文本）
    const four = parseMarkdown('#### 四级\n');
    expect((blocks(four)[0] as { kind: string }).kind).toBe('paragraph');
  });

  it('paragraph 与换行保留（软换行不折叠）', () => {
    const doc = parseMarkdown('第一行\n第二行\n\n第三段');
    expect(doc.degraded).toBe(false);
    expect((blocks(doc)[0] as { kind: 'paragraph'; children: unknown[] }).children).toEqual([
      { kind: 'text', value: '第一行\n第二行' },
    ]);
    expect((blocks(doc)[1] as { kind: 'paragraph'; children: unknown[] }).children).toEqual([
      { kind: 'text', value: '第三段' },
    ]);
  });

  it('无序列表（-/*/+ 空格）与有序列表（N. 空格）；无嵌套', () => {
    const doc = parseMarkdown('- 甲\n- 乙\n\n1. 一\n2. 二\n');
    expect(doc.degraded).toBe(false);
    const list = blocks(doc)[0] as { kind: 'list'; ordered: boolean; items: unknown[] };
    expect(list.kind).toBe('list');
    expect(list.ordered).toBe(false);
    expect(list.items).toEqual([[{ kind: 'text', value: '甲' }], [{ kind: 'text', value: '乙' }]]);
    const ol = blocks(doc)[1] as { kind: 'list'; ordered: boolean; items: unknown[] };
    expect(ol.ordered).toBe(true);
    expect(ol.items).toEqual([[{ kind: 'text', value: '一' }], [{ kind: 'text', value: '二' }]]);
    // 嵌套列表（缩进子项）v1 不支持：内层按字面文本
    const nested = parseMarkdown('- 父\n  - 子\n');
    const first = blocks(nested)[0] as { kind: 'list'; items: unknown[] };
    expect(first.items[0]).toEqual([{ kind: 'text', value: '父\n  - 子' }]);
  });

  it('blockquote（> 空格；无嵌套引用）', () => {
    const doc = parseMarkdown('> 引文内容\n');
    expect(doc.degraded).toBe(false);
    expect(blocks(doc)[0]).toEqual({
      kind: 'quote',
      children: [{ kind: 'text', value: '引文内容' }],
    });
  });

  it('fenced code（``` 围栏；内部不解析为 Markdown）', () => {
    const doc = parseMarkdown('```ts\nconst x = 1;\n```\n');
    expect(doc.degraded).toBe(false);
    expect(blocks(doc)[0]).toEqual({ kind: 'code', lang: 'ts', text: 'const x = 1;' });
    // 内部 Markdown 形态不解析
    const inner = parseMarkdown('```\n# 不是标题\n*不是列表*\n```\n');
    expect((blocks(inner)[0] as { kind: 'code'; lang: string; text: string }).text).toBe(
      '# 不是标题\n*不是列表*',
    );
  });

  it('未闭合围栏 → 字面文本（决议 #152(2)：不加代码块特权）', () => {
    const doc = parseMarkdown('```\n孤立代码\n');
    expect(doc.degraded).toBe(false);
    expect(blocks(doc)[0]).toEqual({
      kind: 'paragraph',
      children: [{ kind: 'text', value: '```\n孤立代码' }],
    });
  });

  // ---------- 行内语法 ----------

  it('emphasis/strong/inline-code', () => {
    const doc = parseMarkdown('有 *斜体*、**粗体** 与 `code` 文本\n');
    expect(blocks(doc)[0]).toEqual({
      kind: 'paragraph',
      children: [
        { kind: 'text', value: '有 ' },
        { kind: 'emphasis', children: [{ kind: 'text', value: '斜体' }] },
        { kind: 'text', value: '、' },
        { kind: 'strong', children: [{ kind: 'text', value: '粗体' }] },
        { kind: 'text', value: ' 与 ' },
        { kind: 'code', value: 'code' },
        { kind: 'text', value: ' 文本' },
      ],
    });
  });

  it('safe-link 解析（绝对 http/https 无 userinfo）', () => {
    const doc = parseMarkdown('看 [官方文档](https://example.com/docs) 吧\n');
    expect(blocks(doc)[0]).toEqual({
      kind: 'paragraph',
      children: [
        { kind: 'text', value: '看 ' },
        { kind: 'link', text: '官方文档', url: 'https://example.com/docs' },
        { kind: 'text', value: ' 吧' },
      ],
    });
  });

  it('危险链接降级纯文本（javascript:/data:/file:/about:/userinfo/相对）', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd',
      'about:blank',
      'https://user@example.com/',
      '/relative',
      '',
    ]) {
      const doc = parseMarkdown(`看 [坏链接](${bad}) 吧\n`);
      const para = blocks(doc)[0] as { kind: 'paragraph'; children: unknown[] };
      expect(para.children).toEqual([{ kind: 'text', value: `看 [坏链接](${bad}) 吧` }]);
      expect(collectMarkdownLinks(doc)).toEqual([]);
    }
  });

  it('collectMarkdownLinks 只收集安全链接（Validator 同源判定）', () => {
    const doc = parseMarkdown('[a](https://ok.com) [b](javascript:x) [c](https://good.org/y)\n');
    expect(collectMarkdownLinks(doc)).toEqual(['https://ok.com', 'https://good.org/y']);
  });

  it('未闭合行内标记 → 自未闭合处起字面文本', () => {
    const doc = parseMarkdown('前 **未闭合 与 `code 与 [链接](https://x.com\n');
    const para = blocks(doc)[0] as { kind: 'paragraph'; children: unknown[] };
    expect(para.children).toEqual([
      { kind: 'text', value: '前 **未闭合 与 `code 与 [链接](https://x.com' },
    ]);
  });

  // ---------- 决议 #99：Markdown 表格不解析 ----------

  it('pipe/table-looking Markdown 按普通段落文本处理（决议 #99/#148）', () => {
    const doc = parseMarkdown('| 列A | 列B |\n|---|---|\n| 1 | 2 |\n');
    expect(doc.degraded).toBe(false);
    const para = blocks(doc)[0] as { kind: 'paragraph'; children: unknown[] };
    expect(para.kind).toBe('paragraph');
    expect(para.children).toEqual([{ kind: 'text', value: '| 列A | 列B |\n|---|---|\n| 1 | 2 |' }]);
  });

  // ---------- raw HTML 关闭 ----------

  it('raw HTML/script/img/onerror 形态只作为文本（不解析不执行）', () => {
    for (const hostile of [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '<style>*{display:none}</style>',
      '<a href="javascript:x">点</a>',
      '正常 <b>加粗</b> 文本',
    ]) {
      const doc = parseMarkdown(`${hostile}\n`);
      const para = blocks(doc)[0] as { kind: 'paragraph'; children: unknown[] };
      expect(para.kind).toBe('paragraph');
      expect(para.children).toEqual([{ kind: 'text', value: hostile }]);
    }
  });

  // ---------- 有界性/降级 ----------

  it('输入超长 → 整块降级纯文本（不丢内容、不加特权）', () => {
    const text = 'a'.repeat(MAX_MARKDOWN_BLOCK_CHARS + 1);
    const doc = parseMarkdown(text);
    expect(doc.degraded).toBe(true);
    expect(blocks(doc)).toEqual([{ kind: 'paragraph', children: [{ kind: 'text', value: text }] }]);
  });

  it('AST 节点超限 → 整块降级纯文本（MARKDOWN_MAX_AST_NODES）', () => {
    // 每行一个 `*x*` 强调 ≈ 3 节点/行；节点数超 2000 触发降级
    const lines: string[] = [];
    for (let i = 0; i < Math.ceil(MARKDOWN_MAX_AST_NODES / 2) + 5; i += 1) {
      lines.push(`*x${i}*`);
    }
    const text = lines.join('\n');
    const doc = parseMarkdown(text);
    expect(doc.degraded).toBe(true);
    expect(doc.children.length).toBe(1);
    expect((doc.children[0] as { kind: string }).kind).toBe('paragraph');
  });

  it('敌手海量 [ 括号不挂起、输出有界（防 ReDoS 探针）', () => {
    const hostile = '[[]()'.repeat(700); // 4200 字符边界内的大量未闭合形态
    const start = performance.now();
    const doc = parseMarkdown(hostile);
    const elapsed = performance.now() - start;
    expect(doc.degraded).toBe(false);
    expect(elapsed).toBeLessThan(500); // 线性扫描——宽松上界探针
  });

  // ---------- 确定性/输入不变 ----------

  it('输出确定性 + 输入零修改', () => {
    const text = '# 标题\n\n- 甲\n- 乙\n\n[链接](https://ok.com) 与 *斜体*\n';
    const a = parseMarkdown(text);
    const b = parseMarkdown(text);
    expect(a).toEqual(b);
    expect(text).toBe('# 标题\n\n- 甲\n- 乙\n\n[链接](https://ok.com) 与 *斜体*\n');
  });

  it('空输入 → 空文档（degraded=false）', () => {
    const doc = parseMarkdown('');
    expect(doc.degraded).toBe(false);
    expect(doc.children).toEqual([]);
  });

  it('CRLF 归一为 LF（决议 #150(3) Markdown 规范化）', () => {
    const doc = parseMarkdown('# 标题\r\n\r\n正文\r\n');
    expect(blocks(doc)).toEqual([
      { kind: 'heading', level: 1, children: [{ kind: 'text', value: '标题' }] },
      { kind: 'paragraph', children: [{ kind: 'text', value: '正文' }] },
    ]);
  });
});
