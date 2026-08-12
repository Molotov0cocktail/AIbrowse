# progress.md — 唯一进度源（主 agent 维护）

> 任务状态：⏳ 待开始 / 🔨 进行中 / ✅ 已完成 / ⛔ 阻塞
> 规则：每任务 ≤1 个模块；实现 → 补测试 → 跑检查 → 审阅 diff → 更新本文件 → 提交推送。

| 任务 | 内容                                                                                             | 状态 | 备注                            |
| ---- | ------------------------------------------------------------------------------------------------ | ---- | ------------------------------- |
| T0   | 项目基线（git/文档链/脚手架/测试基建/最小应用）                                                  | ✅   | 2026-08-13 完成，见 baseline.md |
| T1   | 详细设计定稿：接口契约/错误处理/preload 清单/Tab 状态机/采集算法 + proposal Q1–Q4 拍板           | ⏳   | 下一次会话建议执行              |
| T2   | 浏览器核心：BrowserController + TabManager + WebContentsView + SessionManager（多 Tab 可开网页） | ⏳   | 依赖 T1                         |
| T3   | 浏览器 UI：顶部工具栏/标签栏/地址栏（URL 判断逻辑接入）/主区域                                   | ⏳   | 依赖 T2                         |
| T4   | PageSnapshot：PageReader + elementId + 调试面板显示 JSON                                         | ⏳   | 依赖 T2                         |
| T5   | 收尾：安全审计 + 第一阶段验收清单逐项核对 + 文档/README 同步                                     | ⏳   | 依赖 T2–T4                      |

## 最近会话记录

### 2026-08-13 会话 1：T0 项目基线

- **完成**：git init + 双远程 + .gitignore；补齐 prompt-templates.md；文档链（proposal / 高层设计 /
  详细设计草案 / tasks）；脚手架（electron-vite 5 / vite 7.3.6 / react 19.2.8 / TS 6.0.3 / Vitest 4 /
  ESLint 10 / Prettier 3.9）；红→绿种子模块 src/shared/url.ts（15 用例）；最小 Electron 应用
  （安全默认值 + log/ 日志 + 冒烟自检模式）；README；AGENTS.md 全量同步。
- **验证**：test 15/15 ✅ · typecheck ✅ · lint ✅ · format:check ✅ · build ✅（out/ 三目标）·
  冒烟 ✅（真实启动：窗口 → React 挂载 → bridge 链路 → 自动退出，退出码 0）·
  推送 ✅ gitee + ✅ github（提交 346231a / 0bde230 / 文档同步提交）。
- **环境实测**：本机代理 127.0.0.1:7890 可用（github.com 经其可达）；⚠️ 本机 git 全局配置的
  `https.proxy` 是**无效键**（git 只认 `http.proxy`，被静默忽略），GitHub 推送须显式
  `-c http.proxy=http://127.0.0.1:7890`（GIT_CURL_VERBOSE 抓包确认直连后定位）；
  本机全局 `ELECTRON_RUN_AS_NODE=1` 必须 `env -u` 排除（未动全局变量）；
  Electron 二进制下载需 `NODE_USE_ENV_PROXY=1` + 代理。
- **红→绿记录**：url.test.ts 先写后红（实现缺失）；实现后测试抓住两个真实缺陷
  （host:port 被误判为 scheme、搜索 URL 参数重复），修正后 15/15 绿。
- **遗留**：proposal Q1–Q4 待 T1 拍板；无 CI/打包配置（阶段验收不要求）；shared/url 不支持 IDN；
  双远程用户名拼写差异已实测无碍。
- **下一步**：T1 详细设计定稿。
