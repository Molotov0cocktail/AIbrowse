import { describe, expect, it } from 'vitest';
import { classifyDigestOutput } from './models-classify';

const canonical = '{"sections":[{"eventIds":["event-001"],"explanation":"合成变化"}]}';
describe('Digest诊断分类器只输出结构并使用生产验证器', () => {
  it('区分合法输出与仅格式空白差异', () => {
    expect(classifyDigestOutput(canonical, ['event-001'])).toMatchObject({
      rawAccepted: true,
      canonicalEqual: true,
    });
    expect(classifyDigestOutput(` ${canonical}`, ['event-001'])).toMatchObject({
      rawAccepted: false,
      canonicalEqual: false,
      reserializedAccepted: true,
    });
  });
  it('区分字段顺序与不存在引用；不将投影接受视为原始输出接受', () => {
    const reordered = '{"sections":[{"explanation":"合成变化","eventIds":["event-001"]}]}';
    expect(classifyDigestOutput(reordered, ['event-001'])).toMatchObject({
      rawAccepted: false,
      canonicalEqual: true,
      wrongSectionKeys: 1,
      keyOrderOnlyAccepted: true,
    });
    expect(classifyDigestOutput(canonical, [])).toMatchObject({
      rawAccepted: false,
      unknownRefs: 1,
      keyOrderOnlyAccepted: false,
    });
    expect(
      classifyDigestOutput(canonical.replace('"explanation":', '"extra":true,"explanation":'), [
        'event-001',
      ]),
    ).toMatchObject({ rawAccepted: false, keyOrderOnlyAccepted: false });
  });
  it('区分非法JSON、缺失schema及正文规范化；不输出正文', () => {
    expect(classifyDigestOutput('```json\n{}\n```', [])).toMatchObject({
      jsonParsed: false,
      containsFence: true,
    });
    expect(classifyDigestOutput('```json\n' + canonical + '\n```', ['event-001'])).toMatchObject({
      rawAccepted: false,
      fenceOnlyCounterfactual: { rawAccepted: true },
    });
    expect(classifyDigestOutput('{"summary":"私密合成标记"}', [])).toMatchObject({
      jsonParsed: true,
      rootHasSections: false,
    });
    const raw = canonical.replace('合成变化', ' 私密合成标记');
    const result = classifyDigestOutput(raw, ['event-001']);
    expect(result).toMatchObject({ rawAccepted: false, textNeedsTrim: 1 });
    expect(JSON.stringify(result)).not.toContain('私密合成标记');
  });
});
