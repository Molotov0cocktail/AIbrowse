# T0 项目基线（最小可测闭环）

- **目标**：建立第一阶段开发所需的一切地基：git 前置、文档链骨架、Electron+TS+React+Vite 脚手架、
  测试/lint/typecheck/format 基础设施、可实际启动的最小 Electron 应用。
- **输入文档**：First_stage.md、AGENTS.md §2/§8、PROJECT_RULES §4.1。
- **范围纪律**：不实现 BrowserController/TabManager/PageReader/PageSnapshot 等浏览器核心功能；
  shared/url 纯函数作为「最小可测闭环」的种子模块（后续任务消费，非提前开发功能）。
- **涉及文件**：`.gitignore`、`.agents/skills/vibe-coding-workflow/references/prompt-templates.md`、
  `doc/**`、`package.json` 及全部构建/lint/格式配置、`src/main/`、`src/preload/`、`src/renderer/`、
  `src/shared/`、`README.md`、`AGENTS.md`。
- **依赖**：无（首个任务）。

## 实施步骤

- [x] git init（main 分支）+ 双远程（gitee/github）+ .gitignore（log/、密钥、构建产物、IDE 配置）
- [x] 补齐 SKILL.md 缺失的 `references/prompt-templates.md`
- [x] 文档链骨架：proposal / high-level-design / detailed-design（草案）/ tasks/progress
- [x] 脚手架：electron-vite 5 + vite 7.3.6 + react 19.2.8 + typescript 6.0.3（typescript-eslint 支持上限）
- [x] 基础设施：Vitest / ESLint(flat) / Prettier / typecheck 脚本
- [x] 红→绿种子模块：`src/shared/url.ts` 地址栏输入判断（先测试红，再实现绿）
- [x] 最小应用：main（生命周期/安全默认值/日志）+ preload（最小 bridge）+ React renderer
- [x] 冒烟自检模式：`AIBROWSE_SMOKE=1` 下窗口创建 → 渲染进程就绪 → 日志记录 → 自动退出

## 测试与检查（实际结果，2026-08-13）

- [x] `npm test` — Vitest 全量通过
- [x] `npm run typecheck` — 通过
- [x] `npm run lint` — 通过
- [x] `npm run format:check` — 通过
- [x] `npm run build` — 产物 out/ 生成成功
- [x] Electron 冒烟 — 应用实际启动，窗口创建 + React 渲染 + preload bridge 全链路日志确认

## 完成定义

- [x] 以上检查全部通过且冒烟退出码为 0
- [x] git diff 终检无垃圾文件/敏感信息/构建产物
- [x] 提交并推送双远程
- [x] AGENTS.md / progress.md / README 与项目实际状态同步
