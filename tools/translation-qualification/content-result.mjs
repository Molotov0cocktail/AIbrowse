export const pairs = [
  ['The red fox walks through the quiet forest.', '红狐狸穿过安静的森林。'],
  ['Our science museum opens every morning at nine.', '我们的科学博物馆每天早上九点开放。'],
  ['Please keep the blue notebook beside the window.', '请把蓝色笔记本放在窗边。'],
];

const record = (v) =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;
const exactArray = (v, expected) =>
  Array.isArray(v) &&
  v.length === expected.length &&
  expected.every((item, i) => Object.hasOwn(v, i) && v[i] === item);
const paragraphs = (v, translated) =>
  record(v) &&
  Array.isArray(v.paragraphs) &&
  v.paragraphs.length === pairs.length &&
  exactArray(v.nodes, translated ? pairs.map((p) => p[1]) : []) &&
  pairs.every((pair, i) => {
    const p = v.paragraphs[i];
    return (
      record(p) &&
      p.original === pair[0] &&
      p.text === (translated ? pair.join('') : pair[0]) &&
      exactArray(p.translations, translated ? [pair[1]] : [])
    );
  });
export function summarizeContent(r, exitCode, forced) {
  const rejected = { completed: false, translated: false, restored: false };
  try {
    if (!record(r)) return rejected;
    const translated = paragraphs(r.translated, true);
    const restored = paragraphs(r.restored, false);
    const requests =
      Array.isArray(r.requests) &&
      r.requests.length === pairs.length &&
      pairs.every((pair, i) => {
        const request = r.requests[i];
        return (
          record(request) &&
          request.source_lang === 'en' &&
          request.target_lang === 'zh-CN' &&
          exactArray(request.text_list, [pair[0]])
        );
      });
    const completed =
      exitCode === 0 &&
      forced === false &&
      r.completed === true &&
      r.willQuit === true &&
      r.error === null &&
      translated &&
      restored &&
      requests &&
      Number.isSafeInteger(r.localRequests) &&
      r.localRequests >= pairs.length + 1 &&
      r.localRequests <= 60 &&
      Number.isSafeInteger(r.deniedRequests) &&
      r.deniedRequests >= 1 &&
      r.deniedRequests <= 100 &&
      record(r.sentinel) &&
      r.sentinel.rejected === true &&
      r.sentinel.hits === 1;
    return { completed, translated, restored };
  } catch {
    return rejected;
  }
}
