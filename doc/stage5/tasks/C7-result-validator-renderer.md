# C7 — ResultValidator + 安全 Markdown/Table/Cards/Ranking Renderer

> 第五阶段任务文档。契约 `doc/stage5/detailed-design.md` §8；安全契约
> `doc/stage5/threat-model.md` §3.5（FT-11/FT-12）；决策 D9（proposal §10）。

## 目标

落地 ResultValidator 纯函数（闭合判别联合 + 字段白名单逐块校验）与安全
Renderer（自实现受控 Markdown 子集 + Table/Cards/Ranking 组件）——
**零新依赖**；Renderer 只消费已验证 Result Schema，不接触
BrowserController/SQLite/Electron/Provider。

## 范围与非目标

- **做**：result-validator（§8.1 全部校验：kind 白名单/形状/长度边界/
  表格行列界/rank 连续/sourceRefs ∈ 候选集/evidenceMap 主进程元数据
  覆盖/URL 白名单/失败语义回注）；markdown 解析纯函数（§8.2 子集：标题
  1-3/段落/斜粗体/行内代码/列表/引用/代码块/链接（http/https）——
  Markdown 表格不实现（决议 #99））；Table/Cards/Ranking 渲染纯组件 +
  Evidence 下钻数据映射；渲染层纯文本纪律（零 dangerouslySetInnerHTML
  拼模型文本/控制字符 bidi 剔除/raw HTML 关闭）。
- **不做**：Research 侧栏/结果画布布局接线（C8）；CSV（C8）；Timeline/
  Chart；安装任何渲染库（决策 D9 红线；如需变更走 §15 决议流程）。

## 涉及模块和输入文档

- 新增 `src/main/research/result-validator.ts` + 测试；
  `src/renderer/src/research/markdown/`（解析纯函数）+ ResultView 基础
  组件 + 测试。
- 输入：detailed-design §8/§15（决议 #99）；threat-model §3.5；proposal
  §5（官方资料核查结论）。

## 预计修改文件

- 新增：`src/main/research/result-validator.ts`、
  `result-validator.test.ts`、`src/renderer/src/research/markdown/
parse-markdown.ts` + `parse-markdown.test.ts`、
  `src/renderer/src/research/ResultView.tsx`（组件，C8 接线）。
- 既有文件零改动（renderer 目录为新增子目录）。

## 依赖

C1（Result Schema 类型）。

## 红→绿步骤

1. **红**：先写测试（模块缺失红）——validator 敌手矩阵（未知 kind/超长
   块/表格行列越界/rank 不连续/伪造 evidenceId/sourceRefs 不在候选集/
   javascript: URL/HTML 形态字段/失败语义回注）；markdown 解析矩阵
   （子集各语法/raw HTML 关闭：`<script>`/`<img onerror>` 形态纯文本/
   URL 白名单拒绝/转义与 bidi 剔除/超预算安全降级纯文本/敌手闭合）。
2. **绿**：实现两模块 + 组件；逐用例转绿。
3. 全量回归 + 红线扫描（renderer 零 dangerouslySetInnerHTML 实际使用
   断言；零新依赖——package.json/lockfile 零 diff）。

## 验收标准

- §8 全部规则单测覆盖；渲染输出纯 React 元素（无 HTML 字符串拼接）；
- Validator 与 Renderer 同源常量（表格行列界等）；失败语义（整体拒绝 +
  回注）单测固化。

## 具体验证命令和期望结果

- `npm test -- --maxWorkers=1` → 全量绿；
- `npm run typecheck` / `npm run lint` / `npm run format:check` /
  `npm run build` / `git diff --check` → 全部退出码 0；
- `git diff package.json package-lock.json` → 零改动（零新依赖断言）。

## 完成定义

红→绿证据回填 + 全量验证全绿 + diff 终检 + progress.md 更新 + 逻辑提交
（feat: C7 …）+ 双远程推送。

## 风险与停止条件

- 自实现 Markdown 子集解析器在合法输入上出现歧义/安全漏洞 → 停止并
  报告（不得静默放宽到安装库；重新评估走 §15 决议流程，备选
  react-markdown 记录在案）；
- Validator 校验异常 fail-closed 不抛穿（任何敌手输入安全返回拒绝）。

## 提交边界

逻辑提交；不夹带 C8 UI 布局/交互。
