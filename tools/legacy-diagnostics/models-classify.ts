import { parseDigestExplanation } from '../../src/shared/watch/digest-validator';
import {
  MAX_DIGEST_EXPLANATION_BYTES,
  MAX_DIGEST_EXPLANATION_SECTIONS,
  MAX_DIGEST_EXPLANATION_SECTION_CHARS,
  MAX_DIGEST_EXPLANATION_SECTION_BYTES,
  MAX_DIGEST_EXPLANATION_TOTAL_CHARS,
} from '../../src/shared/types/watch';

export const diagnosticDigestSchema = `输出协议：只输出一份紧凑JSON，不加Markdown、代码围栏、前后空格、换行或说明。顶层只允许sections字段，值为1到${MAX_DIGEST_EXPLANATION_SECTIONS}项的数组。每项必须且只能按此字段顺序包含eventIds、explanation，形如{"sections":[{"eventIds":["事件ID"],"explanation":"解释"}]}。eventIds为非空字符串数组，必须逐字引用输入Evidence的event.eventId，所有section中的ID按输入事件顺序严格递增，不能重复，不能引用不存在的ID。explanation为非空字符串，只解释所引用事件，首尾不能空白，必须NFC规范化；不得含U+0000..001F、U+007F..009F、U+061C、U+200B..200D、U+2028..202E、U+2066..2069、U+FEFF。每段不超过${MAX_DIGEST_EXPLANATION_SECTION_CHARS}个UTF-16字符及${MAX_DIGEST_EXPLANATION_SECTION_BYTES}个UTF-8字节，全部解释不超过${MAX_DIGEST_EXPLANATION_TOTAL_CHARS}字符，完整JSON不超过${MAX_DIGEST_EXPLANATION_BYTES}个UTF-8字节。必须与JSON.stringify解析后对象的输出逐字一致：使用直接Unicode文字，键名及字符串用双引号，标点外不加空白，不重复任何键。`;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Only return bounded structural metadata. Never retain raw model output or reasoning.
export function classifyDigestOutput(
  raw: string,
  eventIds: readonly string[],
  inspectFence = true,
): Record<string, unknown> {
  const base = {
    utf8Bytes: Buffer.byteLength(raw),
    chars: raw.length,
    rawAccepted: parseDigestExplanation(raw, eventIds) !== null,
    containsFence: raw.includes('```'),
  };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    const fenced = inspectFence ? /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/.exec(raw) : null;
    return {
      ...base,
      jsonParsed: false,
      ...(fenced === null
        ? {}
        : { fenceOnlyCounterfactual: classifyDigestOutput(fenced[1]!, eventIds, false) }),
    };
  }
  const serialized = JSON.stringify(value);
  const canonicalEqual = raw === serialized;
  if (!record(value)) return { ...base, jsonParsed: true, rootRecord: false, canonicalEqual };
  const sections = value.sections;
  const sectionList = Array.isArray(sections) ? sections : [];
  const order = new Map(eventIds.map((id, index) => [id, index]));
  let lastIndex = -1;
  let unknownRefs = 0;
  let outOfOrderRefs = 0;
  let invalidTextShape = 0;
  let invalidIdArrays = 0;
  let emptyTexts = 0;
  let textBudgetExcess = 0;
  let totalTextChars = 0;
  let textNeedsTrim = 0;
  let textNeedsNfc = 0;
  let textHasForbiddenControls = 0;
  let wrongSectionKeys = 0;
  let maxTextChars = 0;
  for (const section of sectionList.slice(0, 100)) {
    if (!record(section)) {
      wrongSectionKeys++;
      continue;
    }
    if (JSON.stringify(Object.keys(section)) !== '["eventIds","explanation"]') wrongSectionKeys++;
    if (
      !Array.isArray(section.eventIds) ||
      section.eventIds.length === 0 ||
      !section.eventIds.every((id: unknown) => typeof id === 'string')
    )
      invalidIdArrays++;
    if (typeof section.explanation !== 'string') invalidTextShape++;
    else {
      const text = section.explanation;
      totalTextChars += text.length;
      if (text.length === 0) emptyTexts++;
      if (
        text.length > MAX_DIGEST_EXPLANATION_SECTION_CHARS ||
        Buffer.byteLength(text) > MAX_DIGEST_EXPLANATION_SECTION_BYTES
      )
        textBudgetExcess++;
      maxTextChars = Math.max(maxTextChars, text.length);
      if (text !== text.trim()) textNeedsTrim++;
      if (text !== text.normalize('NFC')) textNeedsNfc++;
      if (
        [...text].some((char) => {
          const code = char.codePointAt(0)!;
          return (
            code <= 0x1f ||
            (code >= 0x7f && code <= 0x9f) ||
            code === 0x061c ||
            (code >= 0x200b && code <= 0x200d) ||
            (code >= 0x2028 && code <= 0x202e) ||
            (code >= 0x2066 && code <= 0x2069) ||
            code === 0xfeff
          );
        })
      )
        textHasForbiddenControls++;
    }
    for (const id of Array.isArray(section.eventIds) ? section.eventIds : []) {
      const index = typeof id === 'string' ? order.get(id) : undefined;
      if (index === undefined) unknownRefs++;
      else {
        if (index <= lastIndex) outOfOrderRefs++;
        lastIndex = index;
      }
    }
  }
  const reordered = {
    sections: sectionList.map((section: unknown) =>
      record(section) ? { eventIds: section.eventIds, explanation: section.explanation } : section,
    ),
  };
  const keySetsPreserved =
    Object.keys(value).length === 1 &&
    Object.hasOwn(value, 'sections') &&
    sectionList.every(
      (section: unknown) =>
        record(section) &&
        Object.keys(section).length === 2 &&
        Object.hasOwn(section, 'eventIds') &&
        Object.hasOwn(section, 'explanation'),
    );
  return {
    ...base,
    jsonParsed: true,
    rootRecord: true,
    canonicalEqual,
    rootKeyCount: Object.keys(value).length,
    rootHasSections: Object.hasOwn(value, 'sections'),
    sectionsIsArray: Array.isArray(sections),
    sectionCount: sectionList.length,
    sectionCountWithinBudget:
      sectionList.length >= 1 && sectionList.length <= MAX_DIGEST_EXPLANATION_SECTIONS,
    outputWithinBudget: Buffer.byteLength(raw) <= MAX_DIGEST_EXPLANATION_BYTES,
    totalTextWithinBudget: totalTextChars <= MAX_DIGEST_EXPLANATION_TOTAL_CHARS,
    wrongSectionKeys,
    invalidTextShape,
    invalidIdArrays,
    emptyTexts,
    textBudgetExcess,
    textNeedsTrim,
    textNeedsNfc,
    textHasForbiddenControls,
    maxTextChars,
    unknownRefs,
    outOfOrderRefs,
    reserializedAccepted: parseDigestExplanation(serialized, eventIds) !== null,
    keyOrderOnlyAccepted:
      keySetsPreserved && parseDigestExplanation(JSON.stringify(reordered), eventIds) !== null,
  };
}
