// Rendering observations are not a functional translation verdict.
export function summarizeLocalUI(result, exitCode, forced) {
  const completed =
    exitCode === 0 &&
    forced === false &&
    result?.completed === true &&
    result?.willQuit === true &&
    result?.error === null &&
    result?.versions?.electron === '43.8.4';
  const rendered = Object.fromEntries(
    ['popup', 'options', 'side-panel'].map((name) => {
      const page = result?.pages?.[name];
      return [
        name,
        completed &&
          typeof page?.text === 'string' &&
          Array.isArray(page?.buttons) &&
          Array.isArray(page?.inputs) &&
          (name === 'popup'
            ? page.text.includes('翻译服务') &&
              page.text.includes('设置') &&
              page.buttons.some((b) => typeof b === 'string' && b.startsWith('翻译'))
            : name === 'options'
              ? page.text.includes('基本设置') &&
                page.inputs.length > 1 &&
                !page.text.includes('加载中...')
              : page.text.includes('翻译文本') && page.buttons.includes('翻译')) &&
          page.require === 'undefined' &&
          page.appBridge === 'undefined',
      ];
    }),
  );
  return { completed, rendered, functionalIntegration: 'NOT RUN' };
}
