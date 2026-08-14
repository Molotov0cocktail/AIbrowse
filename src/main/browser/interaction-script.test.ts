// A3 交互脚本模板校验测试（红→绿先写）：固定模板 + 参数只进 JSON 字面量 + 敌手参数
// 不可逃逸模板。脚本源为自安装函数字符串，本文件经 node:vm（内置模块，零新依赖）在
// 最小假 DOM 沙箱中真实执行模板，验证 click（allowedKind 实时复核各分支）/fill（原生
// value setter + input/change 事件）/scroll 的行为契约与拒绝路径。
// 契约源：doc/stage3/detailed-design.md §5.1/§5.2 + threat-model §3.3（执行器层不可达）。
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { buildInteractionSource, INTERACTION_SCRIPT_SOURCE } from './interaction-script';

// ---------- 最小假 DOM 沙箱 ----------

interface FakeEvent {
  type: string;
  bubbles: boolean;
}

class FakeEventImpl implements FakeEvent {
  readonly bubbles: boolean;

  constructor(
    readonly type: string,
    opts?: { bubbles?: boolean },
  ) {
    this.bubbles = opts?.bubbles === true;
  }
}

class FakeEl {
  readonly attrs = new Map<string, string>();
  parent: FakeEl | null = null;
  textContent = '';
  value = ''; // 脚本成功路径对 INPUT 读取 value（原生语义）
  disabled = false;
  readOnly = false;
  offsetParent: object | null = {}; // 默认可见（有 offsetParent）
  clicked = 0;
  events: FakeEvent[] = [];

  constructor(readonly tagName: string) {}

  get type(): string {
    if (this.tagName === 'INPUT') return this.attrs.get('type') ?? 'text';
    return this.tagName.toLowerCase();
  }

  getClientRects(): Array<object> {
    return this.offsetParent === null ? [] : [{}];
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  closest(selector: string): FakeEl | null {
    if (selector !== 'form') return null;
    let p = this.parent;
    while (p !== null) {
      if (p.tagName === 'FORM') return p;
      p = p.parent;
    }
    return null;
  }

  click(): void {
    this.clicked++;
  }

  dispatchEvent(event: FakeEvent): void {
    this.events.push({ type: event.type, bubbles: event.bubbles });
  }
}

interface FakeDoc {
  els: Map<string, FakeEl>;
  querySelector(selector: string): FakeEl | null;
}

interface SandboxGlobals {
  document: FakeDoc;
  window: {
    scrollBy: ReturnType<typeof vi.fn>;
    scrollX: number;
    scrollY: number;
    innerWidth: number;
    innerHeight: number;
  };
  location: { href: string };
  URL: typeof URL;
  Event: typeof FakeEventImpl;
  HTMLInputElement: unknown;
  HTMLTextAreaElement: unknown;
  alert: ReturnType<typeof vi.fn>;
}

// 原生 value setter 假原型：set 需用 Function 原型方法验证（vi.fn 包装后仍可 .call）
function installValueSetter(proto: object, setSpy: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(proto, 'value', {
    configurable: true,
    get(this: { __value?: string }) {
      return this.__value ?? '';
    },
    set: setSpy as unknown as (v: string) => void,
  });
}

function makeSandbox(): {
  globals: SandboxGlobals;
  doc: FakeDoc;
  inputSetter: ReturnType<typeof vi.fn>;
  textareaSetter: ReturnType<typeof vi.fn>;
} {
  const els = new Map<string, FakeEl>();
  const doc: FakeDoc = {
    els,
    // 真实契约：data-aibrowse-el 烙印值为纯数字（el-N ↔ 属性 N）
    querySelector(selector: string): FakeEl | null {
      const match = /^\[data-aibrowse-el="(\d{1,10})"\]$/.exec(selector);
      return match === null ? null : (els.get(`el-${match[1] ?? ''}`) ?? null);
    },
  };
  const inputSetSpy = vi.fn(function (this: { __value?: string }, v: string) {
    this.__value = v;
  });
  const textareaSetSpy = vi.fn(function (this: { __value?: string }, v: string) {
    this.__value = v;
  });
  const inputProto: Record<string, unknown> = {};
  const textareaProto: Record<string, unknown> = {};
  installValueSetter(inputProto, inputSetSpy);
  installValueSetter(textareaProto, textareaSetSpy);
  const HTMLInputElement = function HTMLInputElementFake(): void {};
  const HTMLTextAreaElement = function HTMLTextAreaElementFake(): void {};
  (HTMLInputElement as unknown as { prototype: unknown }).prototype = inputProto;
  (HTMLTextAreaElement as unknown as { prototype: unknown }).prototype = textareaProto;
  const alertSpy = vi.fn(() => {
    throw new Error('沙箱逃逸：alert 被调用');
  });
  const globals: SandboxGlobals = {
    document: doc,
    window: {
      scrollBy: vi.fn(),
      scrollX: 12,
      scrollY: 34,
      innerWidth: 800,
      innerHeight: 600,
    },
    location: { href: 'https://page.example/current' },
    URL,
    Event: FakeEventImpl,
    HTMLInputElement,
    HTMLTextAreaElement,
    alert: alertSpy,
  };
  return { globals, doc, inputSetter: inputSetSpy, textareaSetter: textareaSetSpy };
}

interface RunResult {
  ok: boolean;
  code?: string;
  reason?: string;
  tag?: string;
  text?: string;
  type?: string;
  viewport?: { scrollX: number; scrollY: number; width: number; height: number };
}

function runScript(
  params: Record<string, unknown>,
  sandbox: { globals: SandboxGlobals; doc: FakeDoc },
): RunResult {
  const source = buildInteractionSource(params as never);
  const result = runInNewContext(source, {
    ...sandbox.globals,
    document: sandbox.doc,
  }) as RunResult;
  return result;
}

function registerEl(doc: FakeDoc, id: string, el: FakeEl): FakeEl {
  doc.els.set(id, el);
  return el;
}

// ---------- 模板编译期固定与参数字面量 ----------

describe('A3 交互脚本模板（固定模板 + 参数只进 JSON 字面量）', () => {
  it('脚本源为编译期固定的自安装函数：不同参数的组装只改变 JSON 字面量尾部，模板体不变', () => {
    expect(INTERACTION_SCRIPT_SOURCE.startsWith('(')).toBe(true);
    expect(INTERACTION_SCRIPT_SOURCE.endsWith(')')).toBe(true);
    const a = buildInteractionSource({ action: 'scroll', dy: 1 });
    const b = buildInteractionSource({ action: 'fill', elementId: 'el-1', text: '探针词' });
    expect(a.startsWith(INTERACTION_SCRIPT_SOURCE)).toBe(true);
    expect(b.startsWith(INTERACTION_SCRIPT_SOURCE)).toBe(true);
    // 参数值不得出现在模板体本身（无编译期插值路径——参数只进 JSON 字面量）
    expect(INTERACTION_SCRIPT_SOURCE).not.toContain('探针词');
    expect(INTERACTION_SCRIPT_SOURCE).not.toContain('el-1');
  });

  it('参数经 JSON 字面量进入：组装源去掉函数前缀后必须能整体 JSON.parse 还原参数（往返恒等）', () => {
    const params = { action: 'fill', elementId: 'el-7', text: '普通文本' };
    const source = buildInteractionSource(params as never);
    const tail = source.slice(INTERACTION_SCRIPT_SOURCE.length);
    expect(tail.startsWith('(')).toBe(true);
    expect(tail.endsWith(')')).toBe(true);
    expect(JSON.parse(tail.slice(1, -1))).toEqual(params);
  });

  it('敌手参数（引号/反斜杠/闭合片段/脚本字符串）不能逃逸模板：执行后 alert 不被调用、参数原样到达', () => {
    const hostile = '";alert(1);//\\\'`</script><script>alert(2)</script>  \\\\n\\\\t"\'';
    const { globals, doc, textareaSetter } = makeSandbox();
    const el = registerEl(doc, 'el-1', new FakeEl('TEXTAREA'));
    el.textContent = '框';
    const result = runScript(
      { action: 'fill', elementId: 'el-1', text: hostile },
      {
        globals,
        doc,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.tag).toBe('textarea');
    // 参数原样到达（未被执行、未截断）：经假 setter 写入
    expect(textareaSetter).toHaveBeenCalledTimes(1);
    expect((el as unknown as { __value?: string }).__value).toBe(hostile);
    expect(globals.alert).not.toHaveBeenCalled();
  });
});

// ---------- click：allowedKind 实时复核各分支 ----------

describe('A3 click 模板（定位 + allowedKind 复核 + 原生 click）', () => {
  it('not-found：无对应烙印元素 → ok:false not-found，无任何 DOM 动作', () => {
    const { globals, doc } = makeSandbox();
    const result = runScript(
      { action: 'click', elementId: 'el-9', allowedKind: 'nav' },
      {
        globals,
        doc,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'not-found' });
  });

  it('nav 接受：A 标签 + 实时 href 为 http/https（相对地址解析后）', () => {
    const { globals, doc } = makeSandbox();
    const el = registerEl(doc, 'el-0', new FakeEl('A'));
    el.attrs.set('href', '/target');
    el.textContent = '  导航 \n链接  ';
    const result = runScript(
      { action: 'click', elementId: 'el-0', allowedKind: 'nav' },
      {
        globals,
        doc,
      },
    );
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ tag: 'a', text: '导航 链接' });
    expect(el.clicked).toBe(1);
  });

  it('nav 拒绝：href 为 javascript: → kind-mismatch，不点击', () => {
    const { globals, doc } = makeSandbox();
    const el = registerEl(doc, 'el-0', new FakeEl('A'));
    el.attrs.set('href', 'javascript:alert(1)');
    const result = runScript(
      { action: 'click', elementId: 'el-0', allowedKind: 'nav' },
      {
        globals,
        doc,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'kind-mismatch' });
    expect(el.clicked).toBe(0);
  });

  it('nav 拒绝：非 A 标签（即使 href 合法）→ kind-mismatch', () => {
    const { globals, doc } = makeSandbox();
    const el = registerEl(doc, 'el-0', new FakeEl('BUTTON'));
    el.attrs.set('href', 'https://example.com/');
    const result = runScript(
      { action: 'click', elementId: 'el-0', allowedKind: 'nav' },
      {
        globals,
        doc,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'kind-mismatch' });
    expect(el.clicked).toBe(0);
  });

  it('expand 接受：aria-expanded=true 与 false 均为展开/折叠控件（属性存在）', () => {
    for (const value of ['true', 'false']) {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-1', new FakeEl('BUTTON'));
      el.attrs.set('aria-expanded', value);
      const result = runScript(
        { action: 'click', elementId: 'el-1', allowedKind: 'expand' },
        {
          globals,
          doc,
        },
      );
      expect(result.ok).toBe(true);
      expect(el.clicked).toBe(1);
    }
  });

  it('expand 拒绝：属性已消失 → kind-mismatch（权限判定后页面动态变化场景）', () => {
    const { globals, doc } = makeSandbox();
    const el = registerEl(doc, 'el-1', new FakeEl('BUTTON'));
    const result = runScript(
      { action: 'click', elementId: 'el-1', allowedKind: 'expand' },
      {
        globals,
        doc,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'kind-mismatch' });
    expect(el.clicked).toBe(0);
  });

  it('toggle 接受：checkbox 与 radio', () => {
    for (const type of ['checkbox', 'radio']) {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-2', new FakeEl('INPUT'));
      el.attrs.set('type', type);
      const result = runScript(
        { action: 'click', elementId: 'el-2', allowedKind: 'toggle' },
        {
          globals,
          doc,
        },
      );
      expect(result.ok).toBe(true);
      expect(el.clicked).toBe(1);
    }
  });

  it('toggle 拒绝：类型已变为 text / 非 INPUT 元素 → kind-mismatch', () => {
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-2', new FakeEl('INPUT'));
      el.attrs.set('type', 'text');
      const result = runScript(
        { action: 'click', elementId: 'el-2', allowedKind: 'toggle' },
        {
          globals,
          doc,
        },
      );
      expect(result).toMatchObject({ ok: false, code: 'kind-mismatch' });
      expect(el.clicked).toBe(0);
    }
    {
      const { globals, doc } = makeSandbox();
      registerEl(doc, 'el-2', new FakeEl('DIV'));
      const result = runScript(
        { action: 'click', elementId: 'el-2', allowedKind: 'toggle' },
        {
          globals,
          doc,
        },
      );
      expect(result).toMatchObject({ ok: false, code: 'kind-mismatch' });
    }
  });

  it('submit 接受：BUTTON type=submit / form 内无显式 type 的 button / INPUT type=submit', () => {
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-3', new FakeEl('BUTTON'));
      el.attrs.set('type', 'submit');
      const result = runScript(
        { action: 'click', elementId: 'el-3', allowedKind: 'submit' },
        {
          globals,
          doc,
        },
      );
      expect(result.ok).toBe(true);
    }
    {
      const { globals, doc } = makeSandbox();
      const form = registerEl(doc, 'el-3', new FakeEl('FORM'));
      const el = new FakeEl('BUTTON');
      el.parent = form;
      doc.els.set('el-4', el);
      const result = runScript(
        { action: 'click', elementId: 'el-4', allowedKind: 'submit' },
        {
          globals,
          doc,
        },
      );
      expect(result.ok).toBe(true);
    }
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-5', new FakeEl('INPUT'));
      el.attrs.set('type', 'submit');
      const result = runScript(
        { action: 'click', elementId: 'el-5', allowedKind: 'submit' },
        {
          globals,
          doc,
        },
      );
      expect(result.ok).toBe(true);
    }
  });

  it('submit 拒绝：form 外无显式 type 的 button / type=button / INPUT type=reset → kind-mismatch', () => {
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-3', new FakeEl('BUTTON')); // 无 type 且不在 form
      const result = runScript(
        { action: 'click', elementId: 'el-3', allowedKind: 'submit' },
        {
          globals,
          doc,
        },
      );
      expect(result).toMatchObject({ ok: false, code: 'kind-mismatch' });
      expect(el.clicked).toBe(0);
    }
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-3', new FakeEl('BUTTON'));
      el.attrs.set('type', 'button');
      const result = runScript(
        { action: 'click', elementId: 'el-3', allowedKind: 'submit' },
        {
          globals,
          doc,
        },
      );
      expect(result).toMatchObject({ ok: false, code: 'kind-mismatch' });
    }
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-3', new FakeEl('INPUT'));
      el.attrs.set('type', 'reset');
      const result = runScript(
        { action: 'click', elementId: 'el-3', allowedKind: 'submit' },
        {
          globals,
          doc,
        },
      );
      expect(result).toMatchObject({ ok: false, code: 'kind-mismatch' });
    }
  });

  it('未知 allowedKind → bad-args（执行器内部参数防御校验，安全拒绝）', () => {
    const { globals, doc } = makeSandbox();
    const el = registerEl(doc, 'el-0', new FakeEl('A'));
    el.attrs.set('href', 'https://example.com/');
    const result = runScript(
      { action: 'click', elementId: 'el-0', allowedKind: 'arbitrary' },
      {
        globals,
        doc,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'bad-args' });
    expect(el.clicked).toBe(0);
  });

  it('不可见 / 禁用元素 → not-interactable，不点击', () => {
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-0', new FakeEl('A'));
      el.attrs.set('href', 'https://example.com/');
      el.offsetParent = null; // 隐藏
      const result = runScript(
        { action: 'click', elementId: 'el-0', allowedKind: 'nav' },
        {
          globals,
          doc,
        },
      );
      expect(result).toMatchObject({ ok: false, code: 'not-interactable' });
      expect(el.clicked).toBe(0);
    }
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-1', new FakeEl('BUTTON'));
      el.attrs.set('aria-expanded', 'false');
      el.disabled = true;
      const result = runScript(
        { action: 'click', elementId: 'el-1', allowedKind: 'expand' },
        {
          globals,
          doc,
        },
      );
      expect(result).toMatchObject({ ok: false, code: 'not-interactable' });
      expect(el.clicked).toBe(0);
    }
  });

  it('click 成功返回 {ok:true, tag, text}，text 为可见文本摘要（≤100 字符、空白折叠）', () => {
    const { globals, doc } = makeSandbox();
    const el = registerEl(doc, 'el-0', new FakeEl('A'));
    el.attrs.set('href', 'https://example.com/');
    el.textContent = `  摘要${'长'.repeat(200)}  `;
    const result = runScript(
      { action: 'click', elementId: 'el-0', allowedKind: 'nav' },
      {
        globals,
        doc,
      },
    );
    expect(result.ok).toBe(true);
    expect(typeof result.text).toBe('string');
    expect((result.text ?? '').length).toBeLessThanOrEqual(100);
    expect((result.text ?? '').startsWith('摘要')).toBe(true);
  });

  it('elementId 参数格式非法 → bad-args（主进程校验的纵深防御）', () => {
    const { globals, doc } = makeSandbox();
    const result = runScript(
      { action: 'click', elementId: 'el-0"][onclick="x', allowedKind: 'nav' },
      {
        globals,
        doc,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'bad-args' });
  });
});

// ---------- fill ----------

describe('A3 fill 模板（原生 value setter + input/change 事件）', () => {
  it('input[type=text] 成功：原生 setter 赋值 + 冒泡 input/change 事件，返回不含输入值', () => {
    const { globals, doc } = makeSandbox();
    const el = registerEl(doc, 'el-1', new FakeEl('INPUT'));
    el.attrs.set('type', 'text');
    const result = runScript(
      { action: 'fill', elementId: 'el-1', text: '关键词' },
      {
        globals,
        doc,
      },
    );
    expect(result).toMatchObject({ ok: true, tag: 'input', type: 'text' });
    expect(result).not.toHaveProperty('value');
    expect(JSON.stringify(result)).not.toContain('关键词');
    expect((el as unknown as { __value?: string }).__value).toBe('关键词');
    expect(el.events).toEqual([
      { type: 'input', bubbles: true },
      { type: 'change', bubbles: true },
    ]);
  });

  it('textarea 成功（无显式 type 的 input 缺省为 text 同样允许）', () => {
    const { globals, doc } = makeSandbox();
    const area = registerEl(doc, 'el-2', new FakeEl('TEXTAREA'));
    const plain = registerEl(doc, 'el-3', new FakeEl('INPUT')); // 无 type 属性 → text
    expect(
      runScript({ action: 'fill', elementId: 'el-2', text: '多行' }, { globals, doc }).ok,
    ).toBe(true);
    expect(runScript({ action: 'fill', elementId: 'el-3', text: 'x' }, { globals, doc }).ok).toBe(
      true,
    );
    expect((area as unknown as { __value?: string }).__value).toBe('多行');
    expect((plain as unknown as { __value?: string }).__value).toBe('x');
  });

  it('password / file 在执行层再次拒绝 → forbidden-type，无写入', () => {
    for (const type of ['password', 'file']) {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-1', new FakeEl('INPUT'));
      el.attrs.set('type', type);
      const result = runScript(
        { action: 'fill', elementId: 'el-1', text: '机密' },
        {
          globals,
          doc,
        },
      );
      expect(result).toMatchObject({ ok: false, code: 'forbidden-type' });
      expect((el as unknown as { __value?: string }).__value).toBeUndefined();
      expect(el.events).toHaveLength(0);
    }
  });

  it('disabled / readonly / 不可见 → not-interactable，无写入', () => {
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-1', new FakeEl('INPUT'));
      el.disabled = true;
      const result = runScript({ action: 'fill', elementId: 'el-1', text: 'x' }, { globals, doc });
      expect(result).toMatchObject({ ok: false, code: 'not-interactable' });
      expect(el.events).toHaveLength(0);
    }
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-1', new FakeEl('INPUT'));
      el.readOnly = true;
      expect(runScript({ action: 'fill', elementId: 'el-1', text: 'x' }, { globals, doc }).ok).toBe(
        false,
      );
    }
    {
      const { globals, doc } = makeSandbox();
      const el = registerEl(doc, 'el-1', new FakeEl('INPUT'));
      el.offsetParent = null;
      const result = runScript({ action: 'fill', elementId: 'el-1', text: 'x' }, { globals, doc });
      expect(result).toMatchObject({ ok: false, code: 'not-interactable' });
    }
  });

  it('非 input/textarea（select/div）→ not-fillable', () => {
    for (const tag of ['SELECT', 'DIV', 'BUTTON']) {
      const { globals, doc } = makeSandbox();
      registerEl(doc, 'el-1', new FakeEl(tag));
      const result = runScript({ action: 'fill', elementId: 'el-1', text: 'x' }, { globals, doc });
      expect(result).toMatchObject({ ok: false, code: 'not-fillable' });
    }
  });

  it('原生 setter 不可用（页面篡改原型）→ error，不抛异常', () => {
    const { globals, doc } = makeSandbox();
    registerEl(doc, 'el-1', new FakeEl('INPUT'));
    delete (globals.HTMLInputElement as { prototype: Record<string, unknown> }).prototype.value;
    const result = runScript({ action: 'fill', elementId: 'el-1', text: 'x' }, { globals, doc });
    expect(result).toMatchObject({ ok: false, code: 'error' });
  });
});

// ---------- scroll ----------

describe('A3 scroll 模板（window.scrollBy + viewport 摘要）', () => {
  it('dy 为整数且 |dy| ≤ 50000 → 执行 window.scrollBy(0, dy) 并返回 viewport 摘要', () => {
    const { globals, doc } = makeSandbox();
    const result = runScript({ action: 'scroll', dy: 250 }, { globals, doc });
    expect(result.ok).toBe(true);
    expect(globals.window.scrollBy).toHaveBeenCalledWith(0, 250);
    expect(result.viewport).toEqual({ scrollX: 12, scrollY: 34, width: 800, height: 600 });
  });

  it('dy 非整数 / 超限 / 非数字 → bad-args，不执行滚动', () => {
    for (const dy of [0.5, 50001, -50001, '100', null, NaN, Infinity]) {
      const { globals, doc } = makeSandbox();
      const result = runScript({ action: 'scroll', dy }, { globals, doc });
      expect(result).toMatchObject({ ok: false, code: 'bad-args' });
      expect(globals.window.scrollBy).not.toHaveBeenCalled();
    }
  });

  it('window.scrollBy 抛异常（页面篡改）→ error 结构化失败，不抛异常', () => {
    const { globals, doc } = makeSandbox();
    globals.window.scrollBy = vi.fn(() => {
      throw new Error('tampered');
    });
    const result = runScript({ action: 'scroll', dy: 1 }, { globals, doc });
    expect(result).toMatchObject({ ok: false, code: 'error' });
  });
});

// ---------- 敌手环境（页面原型篡改） ----------

describe('A3 交互脚本敌手环境', () => {
  it('document.querySelector 抛异常 → error 结构化失败（异常不外泄）', () => {
    const { globals } = makeSandbox();
    const doc = {
      els: new Map<string, FakeEl>(),
      querySelector: () => {
        throw new Error('hostile getter');
      },
    };
    const result = runScript(
      { action: 'click', elementId: 'el-0', allowedKind: 'nav' },
      {
        globals,
        doc,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'error' });
  });

  it('getAttribute 抛异常 → error，不抛异常', () => {
    const { globals, doc } = makeSandbox();
    registerEl(doc, 'el-0', new FakeEl('A')).getAttribute = () => {
      throw new Error('hostile attr');
    };
    const result = runScript(
      { action: 'click', elementId: 'el-0', allowedKind: 'nav' },
      {
        globals,
        doc,
      },
    );
    expect(result).toMatchObject({ ok: false, code: 'error' });
  });

  it('参数非对象 / action 非法 → bad-args', () => {
    const { globals, doc } = makeSandbox();
    for (const params of [
      null,
      'x',
      {},
      { action: 'exec', code: 'alert(1)' },
      { action: 'click', elementId: 'el-0' }, // 缺 allowedKind
      { action: 'fill', elementId: 'el-0' }, // 缺 text
      { action: 'fill', elementId: 'el-0', text: 42 },
      { action: 'scroll' }, // 缺 dy
    ]) {
      const result = runScript(params as Record<string, unknown>, { globals, doc });
      expect(result).toMatchObject({ ok: false, code: 'bad-args' });
    }
  });
});
