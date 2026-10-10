import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const parse = (path: string) =>
  ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
const smoke = parse('src/main/smoke.ts');
const main = parse('src/main/index.ts');
function declaration(file: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = file.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  if (!found?.body) throw new Error('缺少被测真实函数');
  return found;
}
function outerTry(name: string): ts.TryStatement {
  const found = declaration(smoke, name).body!.statements.find(ts.isTryStatement);
  if (!found?.catchClause) throw new Error('缺少真实失败路径');
  return found;
}
function evaluate(source: string, context: vm.Context): unknown {
  return vm.runInContext(
    ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText,
    context,
  );
}

it.each(['runAiConversationScenarios', 'runAiUiScenarios', 'runSmokeScenario'])(
  '%s 原始失败保持同一异常，零删除合成证据',
  async (name) => {
    const original = new Error('合成失败');
    const cleanup = vi.fn(async () => {});
    const context = vm.createContext({
      err: original,
      cleanup,
      aiSmoke: { cleanup },
      aiUiSmoke: { cleanup },
      logError: vi.fn(),
      logWarn: vi.fn(),
    });
    const pending = evaluate(
      `(async () => ${outerTry(name).catchClause!.block.getText(smoke)})()`,
      context,
    ) as Promise<void>;
    await expect(pending).rejects.toBe(original);
    expect(cleanup).not.toHaveBeenCalled();
  },
);

it.each(['local', 'ui'] as const)('末尾L3 %s 失败不触发目录删除', async (failure) => {
  const block = outerTry('runSmokeScenario').tryBlock.statements.find(
    (node) => ts.isIfStatement(node) && node.getText(smoke).includes('aiSmoke.runL3()'),
  );
  if (!block) throw new Error('缺少真实L3收口块');
  const original = new Error('L3合成失败');
  const cleanup = vi.fn(async () => {});
  const fail = async () => {
    throw original;
  };
  const context = vm.createContext({
    aiSmoke: { runL3: failure === 'local' ? fail : async () => {}, cleanup },
    aiUiSmoke: { runL3Ui: failure === 'ui' ? fail : async () => {}, cleanup },
  });
  const pending = evaluate(`(async () => { ${block.getText(smoke)} })()`, context) as Promise<void>;
  await expect(pending).rejects.toBe(original);
  expect(cleanup).not.toHaveBeenCalled();
});

it('L3成功只清理已结束的局部服务，主UI会话目录交由main排水后处理', async () => {
  const block = outerTry('runSmokeScenario').tryBlock.statements.find(
    (node) => ts.isIfStatement(node) && node.getText(smoke).includes('aiSmoke.runL3()'),
  );
  if (!block) throw new Error('缺少真实L3收口块');
  const localCleanup = vi.fn(async () => {});
  const uiCleanup = vi.fn(async () => {});
  const context = vm.createContext({
    aiSmoke: { runL3: async () => {}, cleanup: localCleanup },
    aiUiSmoke: { runL3Ui: async () => {}, cleanup: uiCleanup },
  });
  await (evaluate(`(async () => { ${block.getText(smoke)} })()`, context) as Promise<void>);
  expect(localCleanup).toHaveBeenCalledOnce();
  expect(uiCleanup).not.toHaveBeenCalled();
});

function mainContext() {
  const remove = vi.fn<(path: string) => Promise<void>>(async () => {});
  const context = vm.createContext({
    smokeScenarioFailed: false,
    smokeResearchDir: 'research',
    smokeSourcesDir: 'sources',
    smokeWatchDir: 'watch',
    SMOKE_AI_DATA_DIR: 'conversation',
    __RELEASE__: false,
    SMOKE_MODE: true,
    removeSmokeDirWithRetry: remove,
    logWarn: vi.fn(),
    logError: vi.fn(),
  });
  evaluate(declaration(main, 'cleanupSmokeDirectories').getText(main), context);
  return { context, remove };
}
it('main 调度失败后，退出回调与随后正常退出事件均保留四域证据', async () => {
  let handler: ts.ArrowFunction | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isArrowFunction(node) && node.getText(main).includes('冒烟场景失败（调度层）'))
      handler = node;
    ts.forEachChild(node, visit);
  };
  visit(main);
  if (!handler) throw new Error('缺少main实际调度失败回调');
  const { context, remove } = mainContext();
  const pending: Promise<void>[] = [];
  context.exitAfterRendererAdmissionDrain = (_code: number, cleanup: () => Promise<void>) => {
    pending.push(cleanup());
  };
  evaluate(`(${handler.getText(main)})(new Error('合成失败'))`, context);
  await Promise.all(pending);
  await (evaluate('cleanupSmokeDirectories()', context) as Promise<void>);
  expect(remove).not.toHaveBeenCalled();
  expect(context.smokeResearchDir).toBe('research');
  expect(context.smokeSourcesDir).toBe('sources');
  expect(context.smokeWatchDir).toBe('watch');
});
it('main 成功关闭后仍按原范围清理四域合成目录', async () => {
  const { context, remove } = mainContext();
  await (evaluate('cleanupSmokeDirectories()', context) as Promise<void>);
  expect(remove.mock.calls.map((call) => call[0])).toEqual([
    'research',
    'sources',
    'watch',
    'conversation',
  ]);
});
